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
    supportsSessionAccessLevel:
      typeof chrome.storage.session.setAccessLevel === 'function',
  };
}
