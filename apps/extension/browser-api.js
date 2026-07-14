(function installBrowserRecallWebExtensionApi(globalScope) {
  const nativeChrome = globalScope.chrome;
  const nativeBrowser = globalScope.browser;

  function detectEngine() {
    const userAgent = globalScope.navigator?.userAgent || '';
    if (/\bFirefox\//.test(userAgent)) return 'firefox';
    if (/\b(?:HeadlessChrome|Chrome|Chromium|Edg)\//.test(userAgent)) {
      return 'chromium';
    }
    throw new Error(
      `Unsupported browser user agent: ${userAgent || '<empty>'}`,
    );
  }

  function isRuntimeFailure(error) {
    const message = String(error?.message || error || '');
    return /extension context invalidated|receiving end does not exist|message port closed|could not establish connection|requeststorageaccessfor: permission denied|navigation preload request was cancelled/i.test(
      message,
    );
  }

  const engine = detectEngine();
  if (engine === 'chromium') {
    if (
      !nativeChrome?.runtime?.id ||
      typeof nativeChrome.runtime.getURL !== 'function'
    ) {
      throw new Error('Browser Recall requires the Chromium WebExtension API');
    }
    globalScope.browser = nativeChrome;
    globalScope.browserRecallWebExtension = {
      api: nativeChrome,
      engine: 'chromium',
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
  if (!rawApi.action) {
    throw new Error('Browser Recall requires the Firefox action API');
  }
  if (!rawApi.contextMenus) {
    throw new Error('Browser Recall requires the Firefox contextMenus API');
  }

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

  function wrapObject(target, methodNames) {
    if (!target) return target;
    const wrapped = { ...target };
    if ('id' in target) wrapped.id = target.id;
    for (const methodName of methodNames) {
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
  if (runtime && typeof rawApi.runtime?.getManifest === 'function') {
    runtime.getManifest = rawApi.runtime.getManifest.bind(rawApi.runtime);
  }
  if (runtime && typeof rawApi.runtime?.reload === 'function') {
    runtime.reload = rawApi.runtime.reload.bind(rawApi.runtime);
  }
  if (runtime && typeof rawApi.runtime?.getURL === 'function') {
    runtime.getURL = rawApi.runtime.getURL.bind(rawApi.runtime);
  }
  if (!runtime || typeof runtime.getURL !== 'function') {
    throw new Error('Browser Recall requires runtime.getURL');
  }

  const api = {
    ...rawApi,
    action: wrapObject(rawApi.action, [
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
      'query',
      'sendMessage',
      'update',
    ]),
  };

  globalScope.chrome = api;
  globalScope.browser = nativeBrowser;
  globalScope.browserRecallWebExtension = {
    api,
    engine,
    isRuntimeFailure,
  };
})(globalThis);
