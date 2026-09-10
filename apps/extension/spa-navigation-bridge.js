(function installBrowserRecallSpaNavigationBridge() {
  if (globalThis.__browserRecallSpaNavigationBridge) return;

  const EVENT_NAME = 'browser-recall:spa-navigation';
  const pending = [];
  const listeners = new Set();
  let navigating = false;

  function notify(url) {
    if (typeof url !== 'string' || !url) return;
    if (listeners.size === 0) {
      pending.push(url);
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(url);
      } catch (error) {
        console.error(
          '[Browser Recall] SPA navigation listener failed:',
          error,
        );
      }
    }
  }

  globalThis.__browserRecallSpaNavigationBridge = {
    isNavigating: () => navigating,
    addListener(listener) {
      listeners.add(listener);
      while (pending.length > 0) listener(pending.shift());
      return () => listeners.delete(listener);
    },
  };

  // YouTube changes history before replacing the destination DOM. Capture the
  // old page at start and expose the destination only when rendering finishes.
  window.addEventListener(
    'yt-navigate-start',
    () => {
      navigating = true;
      notify(window.location.href);
    },
    true,
  );
  window.addEventListener(
    'yt-navigate-finish',
    () => {
      navigating = false;
      notify(window.location.href);
    },
    true,
  );

  window.addEventListener(EVENT_NAME, (event) => {
    if (typeof event.detail?.url !== 'string' || !event.detail.url) {
      console.error('[Browser Recall] SPA navigation event has no URL');
      return;
    }
    notify(event.detail.url);
  });

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-spa-navigation.js');
  script.onload = () => script.remove();
  (document.documentElement || document.head).appendChild(script);
})();
