const STORAGE_KEYS = {
  browserId: 'connectorBrowserId',
};

export async function ensureBrowserInstallId() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.browserId]);
  if (stored[STORAGE_KEYS.browserId]) {
    return stored[STORAGE_KEYS.browserId];
  }

  const browserId = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_KEYS.browserId]: browserId });
  return browserId;
}

export async function detectBrowserName() {
  const agent = navigator.userAgent || '';
  if (navigator.brave?.isBrave) {
    try {
      if (await navigator.brave.isBrave()) return 'Brave';
    } catch {}
  }
  if (agent.includes('Brave')) return 'Brave';
  if (agent.includes('Edg/')) return 'Edge';
  if (agent.includes('Arc/')) return 'Arc';
  if (agent.includes('Chrome/')) return 'Chrome';
  return 'Chromium';
}

export function detectBrowserProfile() {
  return 'Default profile';
}

export async function buildPairRequest() {
  return {
    type: 'pair_request',
    browserId: await ensureBrowserInstallId(),
    browserName: await detectBrowserName(),
    browserProfile: detectBrowserProfile(),
    extensionId: chrome.runtime.id,
  };
}
