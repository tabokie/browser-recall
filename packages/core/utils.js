// Shared utility functions
import {
  canonicalizePageUrl,
  generateSlug,
  generateSlugFromUrl,
} from './page-identity.js';
import { logDebug } from './logger.js';

export {
  canonicalizePageUrl,
  generateSlugFromUrl,
  isSameDocumentPageUrl,
} from './page-identity.js';

/** Max words of page body text captured for rule matching. Duplicated in content.js (non-module). */
export const BODY_WORD_LIMIT = 200;

export const INTERNAL_URL_PREFIXES = ['chrome://', 'edge://', 'about:'];
export const DEFAULT_URL_BLACKLIST = [...INTERNAL_URL_PREFIXES];

export function isInternalBrowserUrl(url) {
  return INTERNAL_URL_PREFIXES.some((prefix) =>
    String(url || '').startsWith(prefix),
  );
}

// Send a message to background and throw on error response.
// Use for all data-reading messages where silent defaults are unacceptable.
export async function sendAction(msg) {
  const resp = await chrome.runtime.sendMessage(msg);
  if (resp?.success === false)
    throw new Error(resp.error || `${msg.action} failed`);
  return resp ?? {};
}

// Save a single settings key through background; Desktop applies the write.
export async function saveSettingsValue(key, value) {
  try {
    await chrome.runtime.sendMessage({ action: 'saveSettingsKey', key, value });
  } catch (error) {
    logDebug('saveSettingsValue file write failed:', error.message);
  }
}

function canonicalizePageUrlIfValid(url) {
  try {
    return canonicalizePageUrl(url);
  } catch {
    return url;
  }
}

export function canonicalizePageRequest(request = {}) {
  const output = { ...request };
  for (const key of ['url', 'referrer', 'referrerUrl']) {
    if (typeof output[key] === 'string') {
      output[key] = canonicalizePageUrlIfValid(output[key]);
    }
  }
  for (const key of ['urls', 'items']) {
    if (Array.isArray(output[key])) {
      output[key] = output[key].map((url) =>
        typeof url === 'string' ? canonicalizePageUrlIfValid(url) : url,
      );
    }
  }
  return output;
}

// Generate slug from list title for list file naming
export function generateSlugFromTitle(title) {
  // Hash title + timestamp for uniqueness
  const hashInput = title + Date.now();
  return generateSlug(title, hashInput);
}

// Format timestamp to YYYY-MM-DD date key
export function dateKeyFromTimestamp(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dateKeyFromVisitDate(visitDate) {
  if (typeof visitDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(visitDate)) {
    const [year, month, day] = visitDate.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    if (
      d.getFullYear() !== year ||
      d.getMonth() !== month - 1 ||
      d.getDate() !== day
    ) {
      return null;
    }
    return visitDate;
  }
  const value =
    typeof visitDate === 'number'
      ? visitDate
      : typeof visitDate === 'string'
        ? Number(visitDate)
        : NaN;
  if (!Number.isInteger(value)) return null;
  const year = Math.floor(value / 10000);
  const month = Math.floor((value % 10000) / 100);
  const day = value % 100;
  const d = new Date(year, month - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function collectVisitDateKeys(item = {}) {
  const keys = new Set();
  const visitDates = Array.isArray(item.visitDates) ? item.visitDates : [];
  for (const visitDate of visitDates) {
    const key = dateKeyFromVisitDate(visitDate);
    if (key) keys.add(key);
  }
  if (visitDates.length > 0) return [...keys].sort();

  const timestamps =
    Array.isArray(item.timestamps) && item.timestamps.length > 0
      ? item.timestamps
      : [item.timestamp];
  for (const timestamp of timestamps) {
    const numeric = Number(timestamp);
    if (!Number.isFinite(numeric)) continue;
    keys.add(dateKeyFromTimestamp(numeric));
  }
  return [...keys].sort();
}

// Escape HTML entities for safe insertion into innerHTML
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Generate deterministic slug for a note entity
export function generateNoteSlug(timestamp, excerpt) {
  const d = new Date(timestamp);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const text = Array.isArray(excerpt) ? excerpt.join(' ') || 'note' : 'note';
  const hashInput = text + String(timestamp);
  return `${yy}${mm}${dd}-${generateSlug(text, hashInput)}`;
}
