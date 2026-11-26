import {
  DEFAULT_LOCALE,
  matchSupportedLocale,
  populateLocaleSelect,
  setDocumentLocale,
} from '../packages/core/i18n.js';
import { catalogs } from './locale-catalogs.js';

// Static English copy also serves visitors without JavaScript.
const bindings = [];
for (const attribute of [
  null,
  'html',
  'title',
  'alt',
  'aria-label',
  'content',
]) {
  const marker = attribute ? `data-i18n-${attribute}` : 'data-i18n';
  for (const element of document.querySelectorAll(`[${marker}]`)) {
    const key = element.getAttribute(marker);
    const target = attribute
      ? element
      : [...element.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
        );
    if (!target) throw new Error(`Missing website text: ${key}`);
    let original;
    if (attribute === 'html') original = element.innerHTML;
    else if (attribute) original = element.getAttribute(attribute);
    else original = target.textContent;
    bindings.push({ target, key, attribute, original });
  }
}

const select = document.querySelector('#website-language');
const fullLabel = document.querySelector('.language-full-label');
const compactLabel = document.querySelector('.language-compact-label');
populateLocaleSelect(select, { includeSystem: false });
const storageKey = 'browser-recall-website-language';
let chosenLocale;

function detectLocale() {
  const explicit = matchSupportedLocale(
    new URL(location.href).searchParams.get('lang'),
  );
  if (explicit) return explicit;
  if (chosenLocale) return chosenLocale;
  try {
    const saved = matchSupportedLocale(localStorage.getItem(storageKey));
    if (saved) return saved;
  } catch {
    // Browser preferences still work when local storage is unavailable.
  }
  // Automatic detection treats bare English as the fallback.
  for (const language of navigator.languages || [navigator.language]) {
    if (language?.toLowerCase() === 'en') continue;
    const supported = matchSupportedLocale(language);
    if (supported) return supported;
  }
  return DEFAULT_LOCALE;
}

let locale;
export function getLocale() {
  return locale;
}
export function t(key, values = {}) {
  const message = catalogs[locale][key];
  if (!message) throw new Error(`Missing website translation: ${key}`);
  return message.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in values))
      throw new Error(`Missing translation value: ${name}`);
    return String(values[name]);
  });
}

function applyLocale(nextLocale) {
  if (nextLocale === locale) return;
  locale = nextLocale;
  setDocumentLocale(locale);
  for (const { target, key, attribute, original } of bindings) {
    const value = locale === DEFAULT_LOCALE ? original : t(key);
    if (attribute === 'html') target.innerHTML = value;
    else if (attribute) target.setAttribute(attribute, value);
    else target.textContent = value;
  }
  select.value = locale;
  const { textContent: nativeName } = select.selectedOptions[0];
  fullLabel.textContent = nativeName;
  compactLabel.textContent =
    nativeName.length > 11 ? locale.toUpperCase() : nativeName;
  window.dispatchEvent(new Event('website-locale-change'));
}

export function onLocaleChange(callback) {
  window.addEventListener('website-locale-change', callback);
}

select.addEventListener('change', () => {
  chosenLocale = select.value;
  try {
    localStorage.setItem(storageKey, chosenLocale);
  } catch {
    // Switching remains available for this visit without persistent storage.
  }
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.set('lang', chosenLocale);
    history.replaceState(history.state, '', url);
  }
  applyLocale(chosenLocale);
});
window.addEventListener('languagechange', () => applyLocale(detectLocale()));
applyLocale(detectLocale());
select.parentElement.hidden = false;
