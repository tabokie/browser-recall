import { sendAction } from './desktop-bridge.js';

export function createDesktopReviewRequests({
  isBusy,
  isEditing,
  reportError,
}) {
  let started = false;
  let enabled = false;
  let session = null;
  let generation = 0;
  let timer = null;
  let inFlight = false;
  let busyOperations = 0;
  const busyElements = new Set();

  function visible(element) {
    if (!element.isConnected || !element.getClientRects().length) return false;
    for (
      let node = element;
      node instanceof Element;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0)
        return false;
    }
    return true;
  }

  function busy() {
    for (const element of busyElements) {
      if (!element.isConnected) busyElements.delete(element);
      else if (visible(element)) return true;
    }
    return (
      busyOperations > 0 ||
      isBusy() ||
      [
        ...document.querySelectorAll(
          '[role="dialog"], [aria-busy="true"], [contenteditable]:not([contenteditable="false"]), .spinner',
        ),
      ].some(visible)
    );
  }

  function cancel() {
    clearTimeout(timer);
    timer = null;
    generation++;
    if (inFlight) {
      void sendAction({ action: 'cancelAppReview', session, generation }).catch(
        reportError,
      );
    }
  }

  function completed() {
    cancel();
    if (!enabled || inFlight) return;
    const requestGeneration = generation;
    timer = setTimeout(async () => {
      timer = null;
      if (
        document.visibilityState !== 'visible' ||
        !document.hasFocus() ||
        busy() ||
        isEditing()
      )
        return;
      inFlight = true;
      try {
        const response = await sendAction({
          action: 'requestAppReview',
          session,
          generation: requestGeneration,
        });
        if (typeof response.requested !== 'boolean')
          throw new Error('Review request response is missing requested');
      } catch (error) {
        reportError(error);
      } finally {
        inFlight = false;
      }
    }, 3000);
  }

  return {
    completed,
    trackBusy(element) {
      if (started && !enabled) return;
      if (!element) throw new Error('Review busy element is unavailable');
      busyElements.add(element);
      if (enabled && visible(element)) cancel();
    },
    beginBusy() {
      busyOperations++;
      cancel();
      let ended = false;
      return () => {
        if (!ended) {
          ended = true;
          busyOperations--;
        }
      };
    },
    async start() {
      if (started) return;
      started = true;
      const response = await sendAction({ action: 'getAppReviewState' });
      if (
        typeof response.enabled !== 'boolean' ||
        !Number.isSafeInteger(response.session) ||
        response.session <= 0
      ) {
        throw new Error('Review request state is missing enabled or session');
      }
      session = response.session;
      enabled = response.enabled;
      if (!enabled) return;
      window.addEventListener('desktop-review-opportunity', completed);
      for (const event of [
        'pointerdown',
        'pointermove',
        'keydown',
        'input',
        'wheel',
        'scroll',
        'focusin',
      ]) {
        document.addEventListener(event, cancel, {
          capture: true,
          passive: true,
        });
      }
      window.addEventListener('blur', cancel);
      document.addEventListener('visibilitychange', cancel);
      new MutationObserver(() => {
        if ((timer !== null || inFlight) && busy()) cancel();
      }).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          'style',
          'class',
          'hidden',
          'aria-busy',
          'contenteditable',
        ],
      });
      window.addEventListener('pagehide', cancel);
    },
  };
}
