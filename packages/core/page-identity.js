// Shared page identity helpers. Keep this module browser-global-free: Node
// scripts, extension modules, and generated classic content scripts all use it.

export function generateSlug(text, hashInput) {
  if (!text || text.trim() === '') {
    throw new Error('generateSlug: text must be non-empty');
  }
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 30)
    .replace(/-+$/, '');

  let hash = 0;
  for (let index = 0; index < hashInput.length; index += 1) {
    hash = ((hash << 5) - hash + hashInput.charCodeAt(index)) | 0;
  }
  return `${base}-${Math.abs(hash).toString(36)}`.substring(0, 80);
}

export function canonicalizePageUrl(url) {
  const parsed = new URL(url);
  const keptParams = [];
  let removedParam = false;
  for (const [key, value] of parsed.searchParams.entries()) {
    if (key.startsWith('_')) {
      removedParam = true;
      continue;
    }
    keptParams.push([key, value]);
  }
  if (!removedParam) return url;
  parsed.search = '';
  for (const [key, value] of keptParams) {
    parsed.searchParams.append(key, value);
  }
  return parsed.href;
}

export function pageSlugTextFromUrl(url) {
  const parsed = new URL(url);
  let domain = parsed.hostname.toLowerCase();
  if (domain.startsWith('www.')) domain = domain.slice(4);
  const lastDot = domain.lastIndexOf('.');
  if (lastDot > 0) domain = domain.slice(0, lastDot);
  return domain + parsed.pathname;
}

export function generateSlugFromUrl(url) {
  const canonicalUrl = canonicalizePageUrl(url);
  return generateSlug(pageSlugTextFromUrl(canonicalUrl), canonicalUrl);
}

export function createPageIdentityGlobalScript() {
  return `// Generated from packages/core/page-identity.js by scripts/stage-app-assets.mjs.
(function installBrowserRecallPageIdentity() {
  const generateSlug = ${generateSlug.toString()};
  const canonicalizePageUrl = ${canonicalizePageUrl.toString()};
  const pageSlugTextFromUrl = ${pageSlugTextFromUrl.toString()};
  const generateSlugFromUrl = ${generateSlugFromUrl.toString()};

  globalThis.browserRecallPageIdentity = Object.freeze({
    canonicalizePageUrl,
    generateSlugFromUrl,
  });
})();
`;
}
