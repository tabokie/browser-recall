export function getBrowserCapabilities() {
  const engine = globalThis.browserRecallWebExtension?.engine || 'chromium';
  const isFirefox = engine === 'firefox';
  return {
    engine,
    supportsPromiseOnMessage: isFirefox,
  };
}
