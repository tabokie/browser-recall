const STORAGE_KEYS = {
  browserId: 'connectorBrowserId',
};

export const CONNECTOR_PROTOCOL_VERSION = 1;

async function ensureBrowserInstallId() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.browserId]);
  if (Object.prototype.hasOwnProperty.call(stored, STORAGE_KEYS.browserId)) {
    const browserId = stored[STORAGE_KEYS.browserId];
    if (typeof browserId !== 'string' || !browserId.trim()) {
      throw new Error('Stored browser install ID must be a non-empty string');
    }
    return browserId;
  }

  const browserId = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_KEYS.browserId]: browserId });
  return browserId;
}

export async function detectBrowserName() {
  const agent = globalThis.navigator?.userAgent || '';
  if (navigator.brave?.isBrave) {
    try {
      if (await navigator.brave.isBrave()) return 'Brave';
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

export async function buildPairRequest() {
  const extensionId = chrome.runtime.id;
  if (!extensionId) {
    throw new Error('Browser extension ID is unavailable');
  }
  return {
    type: 'pair_request',
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    browserId: await ensureBrowserInstallId(),
    browserName: await detectBrowserName(),
    extensionId,
    browserProfile: null,
  };
}
