import { detectBrowserName } from '../browser-identity.js';

export { detectBrowserName } from '../browser-identity.js';

const STORAGE_KEYS = {
  browserId: 'connectorBrowserId',
};

export const CONNECTOR_PROTOCOL_VERSION = 3;

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
