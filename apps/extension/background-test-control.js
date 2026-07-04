import {
  requestDesktopEntity,
  requestDesktopHistoryBatch,
  requestDesktopHistoryFiles,
  requestDesktopSetDeviceId,
  requestDesktopTestReset,
  requestDesktopTestSeed,
  restartConnectorRuntimeForTest,
} from './connector/ws-client.js';
import { BACKGROUND_TEST_ACTIONS } from './background-test-actions.js';
import { getBrowserCapabilities } from './browser-capabilities.js';
import { logDebug } from './logger.js';

function testControl() {
  const control = globalThis.browserRecallBackgroundTestControl;
  if (!control) {
    throw new Error('Background test control is unavailable');
  }
  return control;
}

async function handleResetForTest() {
  const resetResp = await requestDesktopTestReset();
  if (!resetResp?.success) return resetResp;
  const control = testControl();
  await control.clearDesktopBuffer();
  await control.resetEphemeralConnectorState();
  await globalThis.browserRecallPreparedPopupForTest?.reset?.();
  return { success: true };
}

async function handleFlushDesktopQueueForTest(request) {
  const control = testControl();
  if (!request.keepDesktopQueue) {
    await control.clearDesktopBuffer();
  }
  await control.resetEphemeralConnectorState();
  await control.flushDesktopBuffer().catch((error) => {
    logDebug('[connector] test queue flush failed:', error.message);
    return null;
  });
  await control.ensureDefaultLists();
  return { success: true };
}

function seedDeviceId(files) {
  for (const file of files || []) {
    const match = file?.path?.match(/^(?:data\/)?logs\/([^/]+)\//);
    if (match?.[1]) return match[1];
  }
  return null;
}

function serializeTestSeedFile(file) {
  if (!file?.path) return null;
  if (typeof file.content === 'string') {
    return { path: file.path, content: file.content };
  }
  if (Object.prototype.hasOwnProperty.call(file, 'data')) {
    return {
      path: file.path,
      content: `${JSON.stringify(file.data, null, 2)}\n`,
    };
  }
  if (Array.isArray(file.lines)) {
    return {
      path: file.path,
      content: `${file.lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    };
  }
  throw new Error(`Unsupported test seed payload for ${file.path}`);
}

async function handleSeedTestData(request) {
  const deviceId = request.deviceId || seedDeviceId(request.files);
  if (deviceId) {
    const setDeviceResp = await requestDesktopSetDeviceId(deviceId);
    if (!setDeviceResp?.success) return setDeviceResp;
    testControl().setLocalDeviceIdForTest(deviceId);
  }
  const files = (request.files || [])
    .map(serializeTestSeedFile)
    .filter(Boolean);
  if (files.length === 0) {
    return { success: true };
  }
  return requestDesktopTestSeed(files);
}

async function handleGetDesktopQueueForTest() {
  const connector = await testControl().getConnectorBridgeState();
  return {
    success: true,
    length: connector.pendingCommands || 0,
    watermark: connector.lastDrainedAt || 0,
  };
}

async function handleReadDesktopValueForTest(request) {
  let value;
  if (request.key.startsWith('log:')) {
    const date = request.key.slice('log:'.length);
    const listing = await requestDesktopHistoryFiles(false);
    if (!listing?.success) {
      throw new Error(listing?.error || 'Desktop history file list failed');
    }
    const files = (listing.files || []).filter(
      (file) => file.replace('.jsonl', '') === date,
    );
    if (files.length === 0) {
      value = [];
    } else {
      const batch = await requestDesktopHistoryBatch(files);
      if (!batch?.success) {
        throw new Error(batch?.error || 'Desktop history batch failed');
      }
      value = [...(batch.entries || [])].sort(
        (left, right) => (left.timestamp || 0) - (right.timestamp || 0),
      );
    }
  } else {
    const response = await requestDesktopEntity(request.key);
    if (!response?.success) {
      throw new Error(
        response?.error || `Desktop read failed for ${request.key}`,
      );
    }
    value = response.entity ?? null;
  }
  if (!request.includeDeleted && value?.deleted) value = null;
  return { success: true, value };
}

async function handleGetActionIconForTest(request) {
  const state = globalThis.browserRecallActionIconStateForTest;
  if (!state) return { success: false, error: 'Action icon state unavailable' };
  const tabId = Number(request.tabId);
  const path =
    Number.isFinite(tabId) && tabId > 0 ? state.tabs.get(tabId) : state.global;
  return { success: true, path: path || null };
}

async function handlePreparePopupBootstrapForTest(request) {
  const control = globalThis.browserRecallPreparedPopupForTest;
  if (!control) {
    return { success: false, error: 'Prepared popup test hook unavailable' };
  }
  return control.prepare(request);
}

async function handleFailNextTabMessageForTest(request) {
  const failures = globalThis.browserRecallTabMessageFailuresForTest;
  if (!failures)
    return { success: false, error: 'Tab message hook unavailable' };
  failures.push({
    action:
      typeof request.messageAction === 'string' ? request.messageAction : null,
    tabId: Number.isFinite(request.tabId) ? request.tabId : null,
    error: request.error || 'Injected tab message failure',
  });
  return { success: true };
}

async function handleTriggerCommandForTest(request) {
  const command = request.command;
  if (typeof command !== 'string' || !command) {
    return { success: false, error: 'triggerCommandForTest missing command' };
  }
  const listeners = globalThis.browserRecallCommandListenersForTest || [];
  if (!listeners.length) {
    return { success: false, error: 'No command listeners registered' };
  }
  for (const listener of listeners) {
    await listener(command);
  }
  return { success: true };
}

const testMessageHandlers = new Map([
  ['resetForTest', handleResetForTest],
  ['flushDesktopQueueForTest', handleFlushDesktopQueueForTest],
  ['seedTestData', handleSeedTestData],
  ['getDesktopQueueForTest', handleGetDesktopQueueForTest],
  ['getActionIconForTest', handleGetActionIconForTest],
  ['preparePopupBootstrapForTest', handlePreparePopupBootstrapForTest],
  ['failNextTabMessageForTest', handleFailNextTabMessageForTest],
  ['triggerCommandForTest', handleTriggerCommandForTest],
  ['readDesktopValue', handleReadDesktopValueForTest],
  [
    'restartConnectorRuntimeForTest',
    async () => {
      await restartConnectorRuntimeForTest();
      return { success: true };
    },
  ],
]);

chrome.runtime.onMessage.addListener((request, sender, rawSendResponse) => {
  if (request.type && !request.action) return false;
  if (!BACKGROUND_TEST_ACTIONS.includes(request.action)) {
    return false;
  }

  const usePromiseResponse = getBrowserCapabilities().supportsPromiseOnMessage;
  let resolveResponse;
  const responsePromise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const sendResponse = (response) => {
    resolveResponse(response);
    if (!usePromiseResponse) rawSendResponse(response);
  };

  (async () => {
    try {
      const handler = testMessageHandlers.get(request.action);
      sendResponse(await handler(request, sender));
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();

  if (usePromiseResponse) return responsePromise;
  return true;
});
