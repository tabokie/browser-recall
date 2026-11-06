export function getBrowserCapabilities() {
  const buildTarget = globalThis.browserRecallWebExtension?.buildTarget;
  if (!['chromium', 'firefox'].includes(buildTarget)) {
    throw new Error(
      `Unsupported WebExtension build target: ${String(buildTarget)}`,
    );
  }
  return {
    buildTarget,
    supportsPromiseOnMessage: buildTarget !== 'chromium',
  };
}

export function normalizePageScriptError(error) {
  const message = String(error?.message || error || '');
  // Browsers reject scripting with messages rather than a shared error code.
  // Only classify known denials at the scripting API boundary.
  const denied = [
    /^Blocked$/,
    /^Cannot access contents of (?:the page|url ".*")\./,
    /^Cannot access a (?:chrome|chrome-extension):\/\/ URL/,
    /^The (?:extensions gallery|New Tab Page) cannot be scripted\.$/,
    /^This page cannot be scripted due to an ExtensionsSettings policy\.$/,
    /^Missing host permission for the tab(?: or frames)?\.?$/,
  ].some((pattern) => pattern.test(message));
  return denied
    ? Object.assign(new Error(message), { code: 'page-access-denied' })
    : error;
}
