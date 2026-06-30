export const DEFAULT_LOCALE = 'en';

export const SUPPORTED_LOCALES = Object.freeze([
  Object.freeze({ code: 'en', nativeName: 'English' }),
  Object.freeze({ code: 'ar', nativeName: 'العربية' }),
  Object.freeze({ code: 'de', nativeName: 'Deutsch' }),
  Object.freeze({ code: 'es', nativeName: 'Español' }),
  Object.freeze({ code: 'fr', nativeName: 'Français' }),
  Object.freeze({ code: 'hi', nativeName: 'हिन्दी' }),
  Object.freeze({
    code: 'id',
    nativeName: 'Bahasa Indonesia',
    aliases: Object.freeze(['in']),
  }),
  Object.freeze({ code: 'it', nativeName: 'Italiano' }),
  Object.freeze({ code: 'ja', nativeName: '日本語' }),
  Object.freeze({ code: 'ko', nativeName: '한국어' }),
  Object.freeze({
    code: 'pt-BR',
    nativeName: 'Português (Brasil)',
    aliases: Object.freeze(['pt']),
  }),
  Object.freeze({ code: 'pt-PT', nativeName: 'Português (Portugal)' }),
  Object.freeze({ code: 'ru', nativeName: 'Русский' }),
  Object.freeze({
    code: 'zh-CN',
    nativeName: '简体中文',
    aliases: Object.freeze(['zh', 'zh-Hans', 'zh-SG', 'zh-MY']),
  }),
  Object.freeze({
    code: 'zh-TW',
    nativeName: '繁體中文',
    aliases: Object.freeze(['zh-Hant', 'zh-HK', 'zh-MO']),
  }),
]);

let activeI18n = {
  locale: DEFAULT_LOCALE,
  translate(key, fallback, substitutions) {
    return fallback || key;
  },
};

function normalizeLocale(locale) {
  return String(locale || DEFAULT_LOCALE)
    .replace(/_/g, '-')
    .split('-')
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (part.length === 4) {
        return `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`;
      }
      if (part.length === 2 || /^\d{3}$/.test(part)) return part.toUpperCase();
      return part.toLowerCase();
    })
    .join('-');
}

function localeCandidates(locale, defaultLocale = DEFAULT_LOCALE) {
  const normalized = normalizeLocale(locale);
  const parts = normalized.split('-').filter(Boolean);
  const candidates = [];
  const pushCandidate = (candidate) => {
    if (candidate && !candidates.includes(candidate))
      candidates.push(candidate);
  };
  while (parts.length > 0) {
    pushCandidate(parts.join('-'));
    parts.pop();
  }
  const normalizedDefault = normalizeLocale(defaultLocale);
  pushCandidate(normalizedDefault);
  return candidates;
}

function supportedLocaleFor(locale, supportedLocales = SUPPORTED_LOCALES) {
  for (const candidate of localeCandidates(locale)) {
    const match = supportedLocales.find((entry) => {
      if (normalizeLocale(entry.code) === candidate) return true;
      return (entry.aliases || []).some(
        (alias) => normalizeLocale(alias) === candidate,
      );
    });
    if (match) return match.code;
  }
  return DEFAULT_LOCALE;
}

export function canonicalRegisteredLocale(locale) {
  if (typeof locale !== 'string' || !locale.trim()) return null;
  const normalized = normalizeLocale(locale);
  return (
    SUPPORTED_LOCALES.find(
      (entry) => normalizeLocale(entry.code) === normalized,
    )?.code || null
  );
}

export function toWebExtensionLocale(locale) {
  return normalizeLocale(locale).replaceAll('-', '_');
}

function normalizeSubstitutions(substitutions) {
  if (substitutions === undefined || substitutions === null) return undefined;
  return Array.isArray(substitutions) ? substitutions : [substitutions];
}

function substitute(message, substitutions) {
  const values = normalizeSubstitutions(substitutions);
  if (!values?.length) return message;
  return String(message).replace(/\$(\d+)/g, (match, indexText) => {
    const index = Number(indexText) - 1;
    return values[index] !== undefined ? String(values[index]) : match;
  });
}

async function loadMessages(locale) {
  const url = new URL(`./locales/${locale}/messages.json`, import.meta.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load locale ${locale}: ${response.status}`);
  }
  return response.json();
}

async function loadCatalog(locale, supportedLocales) {
  const selected =
    supportedLocaleFor(locale, supportedLocales) || DEFAULT_LOCALE;
  return {
    locale: selected,
    messages: await loadMessages(selected),
  };
}

export async function initializeCatalogI18n({
  locale = DEFAULT_LOCALE,
  supportedLocales = SUPPORTED_LOCALES,
} = {}) {
  const catalog = await loadCatalog(locale, supportedLocales);
  activeI18n = {
    locale: catalog.locale,
    translate(key, fallback, substitutions) {
      const message = catalog.messages?.[key]?.message;
      if (!message) return fallback || key;
      return substitute(message, substitutions);
    },
  };
  setDocumentLocale(activeI18n.locale);
  return activeI18n;
}

export async function initializeExtensionI18n(api = globalThis.chrome) {
  const extensionI18n = api?.i18n;
  if (!extensionI18n?.getMessage) {
    return initializeCatalogI18n({
      locale: globalThis.navigator?.language || DEFAULT_LOCALE,
    });
  }
  const locale =
    extensionI18n.getUILanguage?.() ||
    extensionI18n.getMessage('@@ui_locale') ||
    DEFAULT_LOCALE;
  activeI18n = {
    locale: normalizeLocale(locale),
    translate(key, fallback, substitutions) {
      const message = extensionI18n.getMessage(
        key,
        normalizeSubstitutions(substitutions),
      );
      return message || fallback || key;
    },
  };
  setDocumentLocale(activeI18n.locale);
  return activeI18n;
}

function setDocumentLocale(locale) {
  const normalized = normalizeLocale(locale);
  document.documentElement.lang = normalized;
  document.documentElement.dir = /^(ar|fa|he|ur)(-|$)/i.test(normalized)
    ? 'rtl'
    : 'ltr';
}

export function tr(key, fallback = '', substitutions) {
  return activeI18n.translate(key, fallback, substitutions);
}

export function getActiveLocale() {
  return activeI18n.locale || DEFAULT_LOCALE;
}

export function populateLocaleSelect(select, { includeSystem = true } = {}) {
  if (!select) return;
  const selectedValue = select.value;
  const options = [];
  if (includeSystem) {
    options.push({ code: 'system', nativeName: tr('commonSystem', 'System') });
  }
  options.push(...SUPPORTED_LOCALES);
  select.replaceChildren(
    ...options.map(({ code, nativeName }) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = nativeName;
      return option;
    }),
  );
  if (options.some((option) => option.code === selectedValue)) {
    select.value = selectedValue;
  }
}

function applyLocalizedAttribute(root, selector, attrName, targetAttr) {
  root.querySelectorAll(selector).forEach((element) => {
    const key = element.getAttribute(attrName);
    const fallback = targetAttr
      ? element.getAttribute(targetAttr) || ''
      : element.textContent || '';
    const value = tr(key, fallback.trim());
    if (targetAttr) {
      element.setAttribute(targetAttr, value);
    } else {
      element.textContent = value;
    }
  });
}

function applyLocalizedHtml(root) {
  root.querySelectorAll('[data-i18n-html]').forEach((element) => {
    const key = element.getAttribute('data-i18n-html');
    const fallback = element.innerHTML || '';
    element.innerHTML = tr(key, fallback.trim());
  });
}

export function localizeDocument(root = document) {
  applyLocalizedHtml(root);
  applyLocalizedAttribute(root, '[data-i18n]', 'data-i18n');
  applyLocalizedAttribute(
    root,
    '[data-i18n-title]',
    'data-i18n-title',
    'title',
  );
  applyLocalizedAttribute(
    root,
    '[data-i18n-aria-label]',
    'data-i18n-aria-label',
    'aria-label',
  );
  applyLocalizedAttribute(
    root,
    '[data-i18n-placeholder]',
    'data-i18n-placeholder',
    'placeholder',
  );
}
