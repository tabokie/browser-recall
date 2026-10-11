// Capture document policy when navigation starts, before asynchronous loading.
// Keep command admission and elapsed-time accounting in the background so pause
// changes cannot race page initialization. Navigation, attention, and command
// admission share one operation queue; network responses never hold it open.
export function createRecordingController() {
  let operationTail = Promise.resolve();

  function run(operation) {
    const result = operationTail.then(async () => {
      const { recordingRuntime, workspace } = await chrome.storage.session.get([
        'recordingRuntime',
        'workspace',
      ]);
      if (
        workspace !== undefined &&
        (!workspace || !['default', 'private'].includes(workspace.mode))
      ) {
        throw new Error(
          'Stored recording state must have mode default or private',
        );
      }
      const mode = workspace === undefined ? 'default' : workspace.mode;
      const state =
        recordingRuntime === undefined
          ? {
              mode,
              updatedAt: Date.now(),
              activeTime: 0,
              hasPaused: mode === 'private',
              documents: {},
              current: {},
              pending: {},
            }
          : recordingRuntime;
      validateState(state);
      if (state.mode !== mode) {
        throw new Error('Stored recording clock and recording state disagree');
      }
      const now = Date.now();
      if (state.mode === 'default') {
        state.activeTime += Math.max(0, now - state.updatedAt);
      }
      state.updatedAt = now;
      return operation(state);
    });
    operationTail = result.catch(() => {});
    return result;
  }

  async function save(state) {
    await chrome.storage.session.set({
      recordingRuntime: state,
      workspace: { mode: state.mode },
    });
  }

  function documentForSender(state, sender, token) {
    const document = state.documents[token];
    if (
      !document ||
      sender.tab?.id !== document.tabId ||
      sender.frameId !== 0 ||
      (document.nativeId && sender.documentId !== document.nativeId)
    ) {
      throw new Error('Page activity does not belong to a registered document');
    }
    return document;
  }

  return {
    beforeNavigate(details) {
      return run(async (state) => {
        state.pending[details.tabId] = {
          recordingEligible: state.mode === 'default',
          startedAt: details.timeStamp,
          url: details.url,
        };
        await save(state);
      });
    },

    committed(details) {
      return run(async (state) => {
        const pending = state.pending[details.tabId];
        const restored = details.documentId
          ? Object.entries(state.documents).find(
              ([, document]) =>
                document.tabId === details.tabId &&
                document.nativeId === details.documentId,
            )
          : null;
        // A restored document retains its original eligibility. New documents
        // require a start observation, never a guess from commit-time state.
        if (!pending && !restored) {
          throw new Error('Document navigation start was not observed');
        }
        const token = restored?.[0] ?? crypto.randomUUID();
        if (!restored) {
          state.documents[token] = {
            tabId: details.tabId,
            nativeId: details.documentId ?? null,
            recordingEligible: pending.recordingEligible,
            attentionStartedAt: null,
          };
        }
        state.current[details.tabId] = token;
        delete state.pending[details.tabId];
        await save(state);
      });
    },

    navigationFailed(details) {
      return run(async (state) => {
        const pending = state.pending[details.tabId];
        if (
          pending &&
          pending.url === details.url &&
          details.error !== 'net::ERR_ABORTED' &&
          details.timeStamp >= pending.startedAt
        ) {
          delete state.pending[details.tabId];
          await save(state);
        }
      });
    },

    removeTab(tabId) {
      return run(async (state) => {
        for (const [token, document] of Object.entries(state.documents)) {
          if (document.tabId === tabId) delete state.documents[token];
        }
        delete state.current[tabId];
        delete state.pending[tabId];
        await save(state);
      });
    },

    initialize(sender) {
      return run(async (state) => {
        let token = state.current[sender.tab?.id];
        // Installing the extension can inject into a document whose navigation
        // predates listener registration (Firefox's initial start tab). Before
        // the first pause every document is known to be eligible. After a pause,
        // missing navigation history is an error rather than a commit-time guess.
        if (!token && !state.hasPaused && sender.tab && sender.frameId === 0) {
          token = crypto.randomUUID();
          state.documents[token] = {
            tabId: sender.tab.id,
            nativeId: sender.documentId ?? null,
            recordingEligible: true,
            attentionStartedAt: null,
          };
          state.current[sender.tab.id] = token;
        }
        const document = documentForSender(state, sender, token);
        if (
          document.nativeId === null &&
          typeof sender.documentId === 'string'
        ) {
          document.nativeId = sender.documentId;
        }
        await save(state);
        return {
          success: true,
          recordingDocumentToken: token,
          recordingEligible: document.recordingEligible,
        };
      });
    },

    startAttention(request, sender) {
      return run(async (state) => {
        const document = documentForSender(
          state,
          sender,
          request.recordingDocumentToken,
        );
        if (document.recordingEligible) {
          document.attentionStartedAt = state.activeTime;
          await save(state);
        }
        return { success: true };
      });
    },

    // The callback only admits a command to the connector's durable queue.
    // Flushing the connector happens outside this critical section.
    admit(request, sender, enqueue) {
      return run(async (state) => {
        let timeOnPage = request.timeOnPage;
        if (request.recordingDocumentToken !== undefined) {
          const document = documentForSender(
            state,
            sender,
            request.recordingDocumentToken,
          );
          if (!document.recordingEligible) return { success: true };
          if (request.isInitialLoad && request.attentionActive === true) {
            document.attentionStartedAt = state.activeTime;
          }
          if (request.isLeaving) {
            timeOnPage =
              document.attentionStartedAt === null
                ? 0
                : Math.min(
                    state.activeTime - document.attentionStartedAt,
                    3600000,
                  );
            document.attentionStartedAt = null;
          }
        } else if (sender.tab && (request.isInitialLoad || request.isLeaving)) {
          throw new Error('Automatic page activity requires a document token');
        }
        await save(state);
        if (state.mode === 'private') return { success: true };
        return enqueue(timeOnPage);
      });
    },

    setPaused(paused) {
      return run(async (state) => {
        if (paused) state.hasPaused = true;
        state.mode = paused ? 'private' : 'default';
        await save(state);
        return { success: true };
      });
    },

    getState() {
      return run((state) => ({ success: true, mode: state.mode }));
    },

    resetForTest() {
      const reset = operationTail.then(() =>
        chrome.storage.session.remove(['recordingRuntime', 'workspace']),
      );
      operationTail = reset.catch(() => {});
      return reset;
    },
  };
}

function validateState(state) {
  const isMap = (value) =>
    value && typeof value === 'object' && !Array.isArray(value);
  const isTime = (value) => Number.isFinite(value) && value >= 0;
  if (
    !state ||
    !['default', 'private'].includes(state.mode) ||
    !isTime(state.updatedAt) ||
    !isTime(state.activeTime) ||
    typeof state.hasPaused !== 'boolean' ||
    !isMap(state.documents) ||
    !isMap(state.current) ||
    !isMap(state.pending)
  )
    throw new Error('Stored recording runtime is invalid');
  for (const document of Object.values(state.documents)) {
    if (
      !document ||
      !Number.isSafeInteger(document.tabId) ||
      typeof document.recordingEligible !== 'boolean' ||
      !(document.nativeId === null || typeof document.nativeId === 'string') ||
      !(
        document.attentionStartedAt === null ||
        isTime(document.attentionStartedAt)
      )
    )
      throw new Error('Stored recording document is invalid');
  }
  for (const [tabId, token] of Object.entries(state.current)) {
    if (state.documents[token]?.tabId !== Number(tabId)) {
      throw new Error('Stored current recording document is invalid');
    }
  }
  for (const pending of Object.values(state.pending)) {
    if (
      !pending ||
      typeof pending.recordingEligible !== 'boolean' ||
      typeof pending.url !== 'string' ||
      !isTime(pending.startedAt)
    ) {
      throw new Error('Stored recording navigation is invalid');
    }
  }
}
