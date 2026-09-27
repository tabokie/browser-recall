// Fetch in the extension's host-permission context while retaining the
// referrer allowed by the capture policy. Fetch drops foreign-origin referrers
// in an extension worker, so use a temporary rule for this exact request URL.
const FIRST_RULE_ID = 1_000_000;
const LAST_RULE_ID = 1_010_000;
const activeRuleIds = new Set();
const urlRequests = new Map();
let initialization;
let cleanupFailure;

function requestReferrer(location, referrer, policy) {
  if (!referrer) return '';
  const source = new URL(referrer);
  const target = new URL(location);
  if (!['http:', 'https:'].includes(source.protocol)) return '';
  source.username = '';
  source.password = '';
  source.hash = '';
  const sameOrigin = source.origin === target.origin;
  const downgrade =
    source.protocol === 'https:' && target.protocol !== 'https:';
  switch (policy) {
    case 'no-referrer':
      return '';
    case 'same-origin':
      return sameOrigin ? source.href : '';
    case 'origin':
      return `${source.origin}/`;
    case 'strict-origin':
      return downgrade ? '' : `${source.origin}/`;
    case 'origin-when-cross-origin':
      return sameOrigin ? source.href : `${source.origin}/`;
    case 'strict-origin-when-cross-origin':
      return sameOrigin ? source.href : downgrade ? '' : `${source.origin}/`;
    case 'no-referrer-when-downgrade':
      return downgrade ? '' : source.href;
    case 'unsafe-url':
      return source.href;
    default:
      throw new Error(`Unsupported snapshot referrer policy: ${policy}`);
  }
}

export async function fetchSnapshotResource(location, options) {
  // Bound the complete chain, including waiting for redirect metadata. Manual
  // redirects never send the next request before its policy has been evaluated.
  // Every hop must recompute Referer and honor a stricter response
  // Referrer-Policy; a rule for only the initial URL is insufficient.
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(10_000),
  ]);
  let referrer = options.referrer;
  let policy = options.referrerPolicy;
  for (let redirects = 0; redirects <= 20; redirects++) {
    const hop = await fetchSnapshotResourceHop(location, {
      ...options,
      signal,
      referrer,
      referrerPolicy: policy,
    });
    if (!hop.redirect) return hop.response;
    location = hop.redirect;
    referrer = hop.referrer;
    policy = hop.policy;
  }
  throw new Error('Too many snapshot resource redirects');
}

async function fetchSnapshotResourceHop(location, options) {
  const url = new URL(location);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Snapshot resource fetch requires an HTTP(S) URL');
  }
  url.hash = '';
  const referrer = requestReferrer(
    url.href,
    options.referrer,
    options.referrerPolicy,
  );
  const rules = chrome.declarativeNetRequest;
  // Session rules survive worker suspension. Remove this module's abandoned
  // rules before accepting new requests after a worker restart.
  initialization ??= rules.getSessionRules().then((existing) =>
    rules.updateSessionRules({
      removeRuleIds: existing
        .filter((rule) => rule.id >= FIRST_RULE_ID && rule.id < LAST_RULE_ID)
        .map((rule) => rule.id),
    }),
  );
  await initialization;

  // Two captures can request the same URL with different referrers. Serialize
  // only that URL so temporary rules cannot overwrite each other's headers.
  const previous = urlRequests.get(url.href);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  urlRequests.set(url.href, pending);
  await previous;
  let ruleId;
  let removeObserver = () => {};
  try {
    if (cleanupFailure) throw cleanupFailure;
    options.signal?.throwIfAborted();
    ruleId = FIRST_RULE_ID;
    while (activeRuleIds.has(ruleId) && ruleId < LAST_RULE_ID) ruleId++;
    if (ruleId === LAST_RULE_ID)
      throw new Error('Too many snapshot resource requests');
    activeRuleIds.add(ruleId);
    await rules.updateSessionRules({
      addRules: [
        {
          id: ruleId,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              referrer
                ? { header: 'Referer', operation: 'set', value: referrer }
                : { header: 'Referer', operation: 'remove' },
            ],
          },
          condition: {
            regexFilter: `^${url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            isUrlFilterCaseSensitive: true,
            initiatorDomains: [new URL(chrome.runtime.getURL('/')).hostname],
            resourceTypes: ['xmlhttprequest'],
          },
        },
      ],
    });
    // Fetch intentionally hides Location on manual redirects (opaqueredirect).
    // Observe only this extension's matching response headers; no blocking
    // webRequest permission or broad referrer rewrite is needed.
    let metadata;
    let receiveHeaders;
    let abortHeaders;
    const extension = new URL(chrome.runtime.getURL('/'));
    const observeHeaders = (details) => {
      if (details.url !== url.href) return;
      const initiator = details.initiator ?? details.originUrl;
      if (!initiator) return;
      const source = new URL(initiator);
      if (
        source.protocol !== extension.protocol ||
        source.host !== extension.host
      )
        return;
      metadata = details.responseHeaders;
      receiveHeaders?.(metadata);
    };
    chrome.webRequest.onHeadersReceived.addListener(
      observeHeaders,
      { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest'] },
      ['responseHeaders'],
    );
    removeObserver = () => {
      chrome.webRequest.onHeadersReceived.removeListener(observeHeaders);
      if (abortHeaders)
        options.signal.removeEventListener('abort', abortHeaders);
    };
    const response = await fetch(url.href, {
      ...options,
      referrer: '',
      referrerPolicy: 'no-referrer',
      redirect: 'manual',
    });
    if (response.type !== 'opaqueredirect') return { response };
    const headers =
      metadata ??
      (await new Promise((resolve, reject) => {
        receiveHeaders = resolve;
        abortHeaders = () => reject(options.signal.reason);
        if (options.signal.aborted) abortHeaders();
        else
          options.signal.addEventListener('abort', abortHeaders, {
            once: true,
          });
      }));
    const locations = headers.filter(
      (header) => header.name.toLowerCase() === 'location',
    );
    if (locations.length !== 1 || !locations[0].value) {
      throw new Error('Snapshot redirect has no unambiguous Location header');
    }
    let policy = options.referrerPolicy;
    const policies = new Set([
      'no-referrer',
      'same-origin',
      'origin',
      'strict-origin',
      'origin-when-cross-origin',
      'strict-origin-when-cross-origin',
      'no-referrer-when-downgrade',
      'unsafe-url',
    ]);
    for (const header of headers) {
      if (header.name.toLowerCase() !== 'referrer-policy') continue;
      for (const value of (header.value || '').split(',')) {
        if (policies.has(value.trim().toLowerCase()))
          policy = value.trim().toLowerCase();
      }
    }
    return {
      redirect: new URL(locations[0].value, url).href,
      referrer,
      policy,
    };
  } finally {
    removeObserver();
    try {
      if (ruleId !== undefined && activeRuleIds.has(ruleId)) {
        try {
          await rules.updateSessionRules({ removeRuleIds: [ruleId] });
        } catch (error) {
          cleanupFailure = error;
          throw error;
        }
        activeRuleIds.delete(ruleId);
      }
    } finally {
      release();
      if (urlRequests.get(url.href) === pending) urlRequests.delete(url.href);
    }
  }
}
