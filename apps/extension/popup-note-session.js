// Transient editor handoff only; all committed note data remains daemon-owned.
const sessions = new Map();
const PORT_PREFIX = 'popup-note-editor:';

export function acceptPopupNoteSession(
  port,
  { save, remove, enqueue, onError },
) {
  if (!port.name.startsWith(PORT_PREFIX)) return false;
  const senderUrl = new URL(port.sender.url);
  const popupUrl = new URL(chrome.runtime.getURL('popup.html'));
  if (
    senderUrl.protocol !== popupUrl.protocol ||
    senderUrl.host !== popupUrl.host ||
    senderUrl.pathname !== popupUrl.pathname
  ) {
    port.disconnect();
    return true;
  }
  const id = port.name.slice(PORT_PREFIX.length);
  let draft = null;
  let pending = null;
  const commit = (text) => {
    if (text !== undefined) {
      if (!draft || typeof text !== 'string') {
        throw new Error('Popup note editor has no valid draft to save');
      }
      draft.note = text;
    }
    if (pending) return pending;
    if (!draft || draft.note === draft.savedNote) {
      return Promise.resolve({ success: true, noteSlug: draft?.noteSlug });
    }
    const submitted = { noteSlug: draft.noteSlug, note: draft.note };
    pending = (async () => {
      try {
        const response = await save(submitted);
        if (response?.success !== true || !response.noteSlug) {
          throw new Error(
            response?.error || 'updateNote response missing noteSlug',
          );
        }
        draft.noteSlug = response.noteSlug;
        draft.savedNote = submitted.note;
        return response;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  const deleteDraft = async () => {
    if (pending) await pending;
    if (!draft) throw new Error('Popup note editor has no note to delete');
    pending = (async () => {
      try {
        const response = await remove({ noteSlug: draft.noteSlug });
        if (response?.success !== true) {
          throw new Error(response?.error || 'deleteNote failed');
        }
        draft = null;
        return response;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  sessions.set(id, { commit, deleteDraft });
  port.onMessage.addListener((message) => {
    if (message.type === 'start' && !draft) {
      draft = {
        noteSlug: message.noteSlug,
        note: message.note,
        savedNote: message.note,
        tabId: message.tabId,
      };
    } else if (message.type === 'draft' && draft) {
      draft.note = message.note;
    }
  });
  port.onDisconnect.addListener(() => {
    void (async () => {
      // Join explicit confirmation/deletion before handing off the remaining
      // draft. The connector outbox owns retries after this popup is gone.
      if (pending) {
        try {
          await pending;
        } catch (error) {
          await onError(error, draft?.tabId);
        }
      }
      if (draft && draft.note !== draft.savedNote) {
        await enqueue({ noteSlug: draft.noteSlug, note: draft.note });
      }
      // Release only after the durable command buffer has accepted ownership.
      // A failed buffer write must leave the draft available for diagnosis/retry.
      sessions.delete(id);
    })().catch((error) => onError(error, draft?.tabId));
  });
  return true;
}

export function mutatePopupNoteSession(id, action, text) {
  const session = sessions.get(id);
  if (!session) throw new Error('Popup note editor session is unavailable');
  if (action === 'updateNote') return session.commit(text);
  if (action === 'deleteNote') return session.deleteDraft();
  throw new Error(`Unsupported popup note action: ${action}`);
}

export function createPopupNoteSession(note, tabId, onError) {
  const id = crypto.randomUUID();
  const port = chrome.runtime.connect({ name: `${PORT_PREFIX}${id}` });
  let closed = false;
  port.postMessage({
    type: 'start',
    noteSlug: note.slug,
    note: note.note || '',
    tabId,
  });
  // An idle port alone does not keep a Chromium service worker alive. Keep the
  // volatile draft owner available while the popup editor remains open.
  const heartbeat = setInterval(
    () => port.postMessage({ type: 'keepalive' }),
    20000,
  );
  port.onDisconnect.addListener(() => {
    clearInterval(heartbeat);
    if (!closed)
      onError(new Error('Popup note editor disconnected before saving'));
  });
  return {
    update(text) {
      port.postMessage({ type: 'draft', note: text });
    },
    save(text) {
      port.postMessage({ type: 'draft', note: text });
      return chrome.runtime.sendMessage({
        action: 'updateNote',
        noteEditSessionId: id,
        noteSlug: note.slug,
        note: text,
      });
    },
    remove() {
      return chrome.runtime.sendMessage({
        action: 'deleteNote',
        noteEditSessionId: id,
        noteSlug: note.slug,
      });
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      port.disconnect();
    },
  };
}
