export const BACKGROUND_TEST_ACTIONS = [
  'resetForTest',
  'flushDesktopQueueForTest',
  'seedTestData',
  'getDesktopQueueForTest',
  'getActionIconForTest',
  'preparePopupBootstrapForTest',
  'failNextTabMessageForTest',
  'triggerCommandForTest',
  'restartConnectorRuntimeForTest',
  'readDesktopValue',
];

globalThis.browserRecallBackgroundTestActions = new Set(
  BACKGROUND_TEST_ACTIONS,
);

const actionIconState = {
  global: null,
  tabs: new Map(),
};

const originalSetIcon = chrome.action?.setIcon?.bind(chrome.action);
if (originalSetIcon && !globalThis.browserRecallActionIconStateForTest) {
  chrome.action.setIcon = async (details = {}) => {
    if (details?.tabId) {
      actionIconState.tabs.set(details.tabId, details.path || null);
    } else {
      actionIconState.global = details.path || null;
    }
    return originalSetIcon(details);
  };
}

globalThis.browserRecallActionIconStateForTest = actionIconState;

globalThis.browserRecallCommandListenersForTest = [];
globalThis.browserRecallTabMessageFailuresForTest = [];

const originalTabsSendMessage = chrome.tabs?.sendMessage?.bind(chrome.tabs);
if (
  originalTabsSendMessage &&
  !globalThis.browserRecallTabsSendMessageForTest
) {
  chrome.tabs.sendMessage = async (tabId, message, ...rest) => {
    const failures = globalThis.browserRecallTabMessageFailuresForTest || [];
    const index = failures.findIndex(
      (failure) =>
        (!failure.action || failure.action === message?.action) &&
        (!failure.tabId || failure.tabId === tabId),
    );
    if (index >= 0) {
      const [failure] = failures.splice(index, 1);
      throw new Error(failure.error || 'Injected tab message failure');
    }
    return originalTabsSendMessage(tabId, message, ...rest);
  };
}
globalThis.browserRecallTabsSendMessageForTest = chrome.tabs?.sendMessage;

const originalOnCommandAddListener =
  chrome.commands?.onCommand?.addListener?.bind(chrome.commands.onCommand);
if (originalOnCommandAddListener) {
  chrome.commands.onCommand.addListener = (listener) => {
    globalThis.browserRecallCommandListenersForTest.push(listener);
    return originalOnCommandAddListener(listener);
  };
}
