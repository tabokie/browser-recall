export async function detectBrowserName() {
  const agent = globalThis.navigator?.userAgent || '';
  if (typeof globalThis.KAGI !== 'undefined' || agent.includes('Orion/')) {
    return 'Orion';
  }
  if (globalThis.navigator?.brave?.isBrave) {
    try {
      if (await globalThis.navigator.brave.isBrave()) return 'Brave';
    } catch (error) {
      throw new Error(`Could not identify Brave: ${error.message}`);
    }
  }
  if (agent.includes('Brave')) return 'Brave';
  if (agent.includes('Firefox/')) return 'Firefox';
  if (agent.includes('Edg/')) return 'Edge';
  if (agent.includes('Arc/')) return 'Arc';
  if (agent.includes('Chrome/')) return 'Chrome';
  if (agent.includes('Chromium/')) return 'Chromium';
  throw new Error(`Unsupported browser user agent: ${agent || '<empty>'}`);
}
