export function getBrowserCapabilities() {
  const engine = globalThis.browserRecallWebExtension?.engine;
  if (!['chromium', 'firefox'].includes(engine)) {
    throw new Error(`Unsupported WebExtension engine: ${String(engine)}`);
  }
  return {
    engine,
    supportsPromiseOnMessage: engine !== 'chromium',
    supportsSessionAccessLevel:
      typeof chrome.storage.session.setAccessLevel === 'function',
  };
}
