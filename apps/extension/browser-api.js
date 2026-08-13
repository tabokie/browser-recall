(function installBrowserRecallWebExtensionApi(globalScope) {
  // Build target, browser product identity, and execution context are separate
  // facts. Do not infer one from another or from namespace availability.
  const nativeChrome = globalScope.chrome;
  const nativeBrowser = globalScope.browser;
  const buildTarget = globalScope.browserRecallBuildTarget;

  if (!['chromium', 'firefox'].includes(buildTarget)) {
    throw new Error(
      `Browser Recall build target is missing or invalid: ${String(buildTarget)}`,
    );
  }

  function isRuntimeFailure(error) {
    const message = String(error?.message || error || '');
    return /extension context invalidated|receiving end does not exist|message port closed|could not establish connection|requeststorageaccessfor: permission denied|navigation preload request was cancelled/i.test(
      message,
    );
  }

  function detectExecutionContext() {
    if (!globalScope.document) return 'background';
    const protocol =
      globalScope.document.location?.protocol || globalScope.location?.protocol;
    if (protocol === 'chrome-extension:' || protocol === 'moz-extension:') {
      return 'extension-page';
    }
    return 'content';
  }

  function getOpenOrClosedShadowRoot(element) {
    if (!element) return null;
    if (element.shadowRoot) return element.shadowRoot;
    if (
      buildTarget === 'chromium' &&
      typeof nativeChrome?.dom?.openOrClosedShadowRoot === 'function' &&
      (typeof globalScope.HTMLElement !== 'function' ||
        element instanceof globalScope.HTMLElement)
    ) {
      return nativeChrome.dom.openOrClosedShadowRoot(element);
    }
    return null;
  }

  const executionContext = detectExecutionContext();
  if (buildTarget === 'chromium') {
    if (
      !nativeChrome?.runtime?.id ||
      typeof nativeChrome.runtime.getURL !== 'function'
    ) {
      throw new Error('Browser Recall requires the Chromium WebExtension API');
    }
    globalScope.browser = nativeChrome;
    globalScope.browserRecallWebExtension = {
      api: nativeChrome,
      buildTarget,
      executionContext,
      getOpenOrClosedShadowRoot,
      isRuntimeFailure,
    };
    return;
  }

  if (
    !nativeBrowser?.runtime?.id ||
    typeof nativeBrowser.runtime.getURL !== 'function'
  ) {
    throw new Error('Browser Recall requires the Firefox WebExtension API');
  }
  const rawApi = nativeBrowser;

  function bindPromiseMethod(target, methodName) {
    const method = target?.[methodName];
    if (typeof method !== 'function') return method;
    return function browserPromiseMethod(...args) {
      const result = method.apply(target, args);
      if (!result || typeof result.then !== 'function') {
        throw new Error(
          `Firefox WebExtension method ${methodName} must return a Promise`,
        );
      }
      return result;
    };
  }

  function bindSyncMethod(target, methodName) {
    const method = target?.[methodName];
    return typeof method === 'function' ? method.bind(target) : method;
  }

  function wrapStorageArea(target) {
    if (!target) return target;
    const wrapped = {
      ...target,
      get: bindPromiseMethod(target, 'get'),
      set: bindPromiseMethod(target, 'set'),
      remove: bindPromiseMethod(target, 'remove'),
      clear: bindPromiseMethod(target, 'clear'),
    };
    if (typeof target.setAccessLevel === 'function') {
      wrapped.setAccessLevel = bindPromiseMethod(target, 'setAccessLevel');
    }
    return wrapped;
  }

  function wrapObject(target, promiseMethodNames) {
    if (!target) return target;
    const wrapped = { ...target };
    if ('id' in target) wrapped.id = target.id;
    for (const methodName of promiseMethodNames) {
      wrapped[methodName] = bindPromiseMethod(target, methodName);
    }
    return wrapped;
  }

  const storage = rawApi.storage
    ? {
        ...rawApi.storage,
        local: wrapStorageArea(rawApi.storage.local),
        sync: wrapStorageArea(rawApi.storage.sync),
        session: wrapStorageArea(rawApi.storage.session),
      }
    : rawApi.storage;

  const runtime = wrapObject(rawApi.runtime, [
    'getPlatformInfo',
    'openOptionsPage',
    'sendMessage',
  ]);
  for (const methodName of ['connect', 'getManifest', 'reload', 'getURL']) {
    if (runtime && typeof rawApi.runtime?.[methodName] === 'function') {
      runtime[methodName] = bindSyncMethod(rawApi.runtime, methodName);
    }
  }
  if (!runtime || typeof runtime.getURL !== 'function') {
    throw new Error('Browser Recall requires runtime.getURL');
  }

  const api = {
    ...rawApi,
    action: wrapObject(rawApi.action, [
      'setPopup',
      'openPopup',
      'setBadgeBackgroundColor',
      'setBadgeText',
      'setIcon',
      'setTitle',
      'getBadgeBackgroundColor',
      'getBadgeText',
    ]),
    commands: wrapObject(rawApi.commands, ['getAll']),
    contextMenus: rawApi.contextMenus,
    runtime,
    scripting: wrapObject(rawApi.scripting, ['executeScript']),
    storage,
    tabs: wrapObject(rawApi.tabs, [
      'create',
      'get',
      'getCurrent',
      'query',
      'sendMessage',
      'update',
    ]),
  };

  globalScope.chrome = api;
  globalScope.browser = nativeBrowser;
  globalScope.browserRecallWebExtension = {
    api,
    buildTarget,
    executionContext,
    getOpenOrClosedShadowRoot,
    isRuntimeFailure,
  };
})(globalThis);
