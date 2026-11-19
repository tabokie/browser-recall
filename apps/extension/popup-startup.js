(() => {
  if (!navigator.serviceWorker?.controller) return;
  const params = new URLSearchParams(location.search);
  const token = params.get('bootstrap');
  if (
    !token ||
    !params.has('actionTabId') ||
    !chrome.extension?.getViews?.({ type: 'popup' })?.includes(window)
  ) {
    return;
  }

  // Start a load-blocking request before the dashboard module runs.
  const image = document.createElement('img');
  image.id = 'popupStartupImage';
  image.hidden = true;
  image.src = `icons/icon16.png?popupStartup=${encodeURIComponent(token)}`;
  document.body.append(image);
})();
