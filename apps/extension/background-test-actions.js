export const BACKGROUND_TEST_ACTIONS = [
  'resetForTest',
  'flushDesktopQueueForTest',
  'seedTestData',
  'getActionIconForTest',
  'preparePopupBootstrapForTest',
  'beginPopupBootstrapForTest',
  'openPreparedPopupForTest',
  'releasePopupPreparationForTest',
  'failNextTabMessageForTest',
  'navigateTabBeforeNextImmediateScriptForTest',
  'triggerCommandForTest',
  'restartConnectorRuntimeForTest',
  'setConnectorPortsForTest',
  'setFileSchemeAccessForTest',
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
globalThis.browserRecallImmediateScriptNavigationsForTest = [];

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

const originalScriptingExecuteScript = chrome.scripting?.executeScript?.bind(
  chrome.scripting,
);
if (
  originalScriptingExecuteScript &&
  !globalThis.browserRecallScriptingExecuteScriptForTest
) {
  chrome.scripting.executeScript = async (details, ...rest) => {
    const navigations =
      globalThis.browserRecallImmediateScriptNavigationsForTest || [];
    const tabId = details?.target?.tabId;
    const index = navigations.findIndex(
      (navigation) => !navigation.tabId || navigation.tabId === tabId,
    );
    if (details?.injectImmediately && index >= 0) {
      const [navigation] = navigations.splice(index, 1);
      const committed = new Promise((resolve, reject) => {
        const listener = (event) => {
          if (
            event.tabId !== tabId ||
            event.frameId !== 0 ||
            event.url !== navigation.url
          ) {
            return;
          }
          clearTimeout(timer);
          chrome.webNavigation.onCommitted.removeListener(listener);
          resolve();
        };
        const timer = setTimeout(() => {
          chrome.webNavigation.onCommitted.removeListener(listener);
          reject(
            new Error(`Timed out navigating test tab to ${navigation.url}`),
          );
        }, 2_000);
        chrome.webNavigation.onCommitted.addListener(listener);
      });
      await chrome.tabs.update(tabId, { url: navigation.url });
      await committed;
    }
    return originalScriptingExecuteScript(details, ...rest);
  };
}
globalThis.browserRecallScriptingExecuteScriptForTest =
  chrome.scripting?.executeScript;

const originalOnCommandAddListener =
  chrome.commands?.onCommand?.addListener?.bind(chrome.commands.onCommand);
if (originalOnCommandAddListener) {
  chrome.commands.onCommand.addListener = (listener) => {
    globalThis.browserRecallCommandListenersForTest.push(listener);
    return originalOnCommandAddListener(listener);
  };
}
