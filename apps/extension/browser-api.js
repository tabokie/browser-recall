(function installBrowserRecallWebExtensionApi(globalScope) {
  const nativeChrome = globalScope.chrome;
  const nativeBrowser = globalScope.browser;
  const rawApi = nativeBrowser || nativeChrome;

  if (!rawApi) {
    throw new Error('Browser Recall requires the WebExtension API');
  }

  if (nativeChrome) {
    globalScope.browser = nativeBrowser || nativeChrome;
    globalScope.browserRecallWebExtension = {
      api: nativeChrome,
      engine: nativeBrowser ? 'chromium-browser-alias' : 'chromium',
    };
    return;
  }

  function callbackify(target, methodName) {
    const method = target?.[methodName];
    if (typeof method !== 'function') return method;
    return function callbackCompatibleMethod(...args) {
      const callback =
        typeof args[args.length - 1] === 'function' ? args.pop() : null;
      try {
        const result = method.apply(target, args);
        if (callback && result?.then) {
          result.then(
            (value) => callback(value),
            (error) => {
              console.error(
                `[browser-api] ${methodName} failed:`,
                error?.message || error,
              );
              callback(undefined);
            },
          );
        }
        return result;
      } catch (error) {
        if (callback) callback(undefined);
        throw error;
      }
    };
  }

  function wrapStorageArea(area, fallbackArea) {
    const target = area || fallbackArea;
    if (!target) return target;
    return {
      ...target,
      get: callbackify(target, 'get'),
      set: callbackify(target, 'set'),
      remove: callbackify(target, 'remove'),
      clear: callbackify(target, 'clear'),
      setAccessLevel:
        typeof target.setAccessLevel === 'function'
          ? callbackify(target, 'setAccessLevel')
          : () => Promise.resolve(),
    };
  }

  function wrapObject(target, methodNames) {
    if (!target) return target;
    const wrapped = { ...target };
    for (const methodName of methodNames) {
      wrapped[methodName] = callbackify(target, methodName);
    }
    return wrapped;
  }

  const storage = rawApi.storage
    ? {
        ...rawApi.storage,
        local: wrapStorageArea(rawApi.storage.local),
        sync: wrapStorageArea(rawApi.storage.sync),
        session: wrapStorageArea(rawApi.storage.session, rawApi.storage.local),
      }
    : rawApi.storage;

  const api = {
    ...rawApi,
    action: wrapObject(rawApi.action || rawApi.browserAction, [
      'setBadgeBackgroundColor',
      'setBadgeText',
      'setIcon',
      'setTitle',
      'getBadgeBackgroundColor',
      'getBadgeText',
    ]),
    commands: wrapObject(rawApi.commands, ['getAll']),
    contextMenus: rawApi.contextMenus || rawApi.menus,
    runtime: wrapObject(rawApi.runtime, [
      'getManifest',
      'getPlatformInfo',
      'openOptionsPage',
      'reload',
      'sendMessage',
    ]),
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
  globalScope.browser = nativeBrowser || api;
  globalScope.browserRecallWebExtension = {
    api,
    engine: nativeBrowser && !nativeChrome ? 'firefox' : 'chromium',
  };
})(globalThis);
