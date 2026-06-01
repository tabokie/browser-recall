export const BACKGROUND_TEST_ACTIONS = [
  'resetForTest',
  'flushDesktopQueueForTest',
  'seedTestData',
  'getDesktopQueueForTest',
  'getActionIconForTest',
  'triggerCommandForTest',
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
const originalOnCommandAddListener =
  chrome.commands?.onCommand?.addListener?.bind(chrome.commands.onCommand);
if (originalOnCommandAddListener) {
  chrome.commands.onCommand.addListener = (listener) => {
    globalThis.browserRecallCommandListenersForTest.push(listener);
    return originalOnCommandAddListener(listener);
  };
}
