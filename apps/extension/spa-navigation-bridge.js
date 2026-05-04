(function installBrowserRecallSpaNavigationBridge() {
  if (globalThis.__browserRecallSpaNavigationBridge) return;

  const EVENT_NAME = 'browser-recall:spa-navigation';
  const pending = [];
  const listeners = new Set();

  function notify(url) {
    if (typeof url !== 'string' || !url) return;
    if (listeners.size === 0) {
      pending.push(url);
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(url);
      } catch {}
    }
  }

  globalThis.__browserRecallSpaNavigationBridge = {
    addListener(listener) {
      listeners.add(listener);
      while (pending.length > 0) listener(pending.shift());
      return () => listeners.delete(listener);
    },
  };

  window.addEventListener(EVENT_NAME, (event) => {
    notify(event.detail?.url || window.location.href);
  });

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-spa-navigation.js');
  script.onload = () => script.remove();
  (document.documentElement || document.head).appendChild(script);
})();
