(function installBrowserRecallSpaNavigationObserver() {
  if (window.__browserRecallSpaNavigationObserverInstalled) return;
  window.__browserRecallSpaNavigationObserverInstalled = true;

  const EVENT_NAME = 'browser-recall:spa-navigation';
  let lastHref = window.location.href;

  function emitIfChanged(reason) {
    const url = window.location.href;
    if (url === lastHref) return;
    lastHref = url;
    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, {
        detail: { url, reason },
      }),
    );
  }

  for (const methodName of ['pushState', 'replaceState']) {
    const original = window.history?.[methodName];
    if (typeof original !== 'function') continue;
    window.history[methodName] = function browserRecallHistoryMethod(...args) {
      const result = original.apply(this, args);
      queueMicrotask(() => emitIfChanged(methodName));
      return result;
    };
  }

  window.addEventListener('popstate', () =>
    queueMicrotask(() => emitIfChanged('popstate')),
  );
  window.addEventListener('hashchange', () =>
    queueMicrotask(() => emitIfChanged('hashchange')),
  );
})();
