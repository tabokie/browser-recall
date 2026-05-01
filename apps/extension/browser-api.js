(function installBrowserRecallWebExtensionApi(globalScope) {
  const nativeChrome = globalScope.chrome;
  const nativeBrowser = globalScope.browser;
  const rawApi = nativeBrowser || nativeChrome;

  if (!rawApi) {
    throw new Error('Browser Recall requires the WebExtension API');
  }

  if (nativeChrome && !nativeBrowser) {
    globalScope.browser = nativeBrowser || nativeChrome;
    globalScope.browserRecallWebExtension = {
      api: nativeChrome,
      engine: 'chromium',
    };
    return;
  }

  function callbackify(target, methodName) {
    const method = target?.[methodName];
    if (typeof method !== 'function') return method;
    return function callbackCompatibleMethod(...args) {
      const callback =
        typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const handleError = (error, reject) => {
        console.error(
          `[browser-api] ${methodName} failed:`,
          error?.message || error,
        );
        if (callback) callback(undefined);
        if (reject) reject(error);
      };

      if (method.length <= args.length) {
        try {
          const result = method.apply(target, args);
          if (callback && result?.then) {
            result.then(
              (value) => callback(value),
              (error) => handleError(error),
            );
          } else if (callback) {
            callback(result);
          }
          return result?.then ? result : Promise.resolve(result);
        } catch (error) {
          handleError(error);
          return Promise.reject(error);
        }
      }

      return new Promise((resolve, reject) => {
        const finish = (value) => {
          if (callback) callback(value);
          resolve(value);
        };
        try {
          const result = method.apply(target, [...args, finish]);
          if (result?.then) {
            result.then(finish, (error) => handleError(error, reject));
          } else if (result !== undefined) {
            finish(result);
          }
        } catch (error) {
          handleError(error, reject);
        }
      });
    };
  }

  function wrapStorageArea(target) {
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

  function detectEngine() {
    const userAgent = globalScope.navigator?.userAgent || '';
    if (/\bFirefox\//.test(userAgent)) return 'firefox';
    return 'chromium';
  }

  function wrapObject(target, methodNames) {
    if (!target) return target;
    const wrapped = { ...target };
    if ('id' in target) wrapped.id = target.id;
    for (const methodName of methodNames) {
      wrapped[methodName] = callbackify(target, methodName);
    }
    return wrapped;
  }

  function extensionResourceUrl(resourcePath = '') {
    const normalized = String(resourcePath).replace(/^\/+/, '');
    const locationHref =
      globalScope.location?.href || globalScope.window?.location?.href || '';
    try {
      const locationUrl = new URL(locationHref);
      if (
        locationUrl.protocol === 'moz-extension:' ||
        locationUrl.protocol === 'chrome-extension:' ||
        locationUrl.protocol === 'safari-web-extension:'
      ) {
        const origin =
          locationUrl.origin && locationUrl.origin !== 'null'
            ? locationUrl.origin
            : `${locationUrl.protocol}//${locationUrl.host}`;
        return `${origin}/${normalized}`;
      }
    } catch {}
    if (rawApi.runtime?.id) {
      return `chrome-extension://${rawApi.runtime.id}/${normalized}`;
    }
    return normalized;
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
  if (runtime && typeof runtime.getURL !== 'function') {
    runtime.getURL = extensionResourceUrl;
  }

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
  globalScope.browser = nativeBrowser || api;
  globalScope.browserRecallWebExtension = {
    api,
    engine: detectEngine(),
  };
})(globalThis);
