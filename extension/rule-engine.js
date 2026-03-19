// rule-engine.js — Pure rule matching module.
// No Chrome APIs. Importable by background.js and testable with vitest.

export const RULE_TYPES = {
  KEYWORD: 'keyword',
  SMART: 'smart',
};

const VALID_KEYWORD_FIELDS = ['title', 'url'];

const BANNED_GLOBALS = [
  'fetch', 'chrome', 'window', 'document', 'navigator', 'globalThis',
  'eval', 'Function', 'setTimeout', 'setInterval', 'WebSocket',
  'Worker', 'localStorage', 'sessionStorage', 'indexedDB', 'importScripts',
];

const MAX_FN_SOURCE_BYTES = 10240; // 10KB

/**
 * Generate a unique rule ID.
 * Pattern: rule-<type[0]>-<base36_ts>-<4char_hash>
 */
export function generateRuleId(type, timestamp) {
  const prefix = type[0];
  const ts36 = timestamp.toString(36);
  const hash = Math.random().toString(36).slice(2, 6);
  return `rule-${prefix}-${ts36}-${hash}`;
}

/**
 * Validate a rule configuration by type.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateRuleConfig({ type, config }) {
  const errors = [];

  if (!Object.values(RULE_TYPES).includes(type)) {
    errors.push(`Unknown rule type: ${type}`);
    return { valid: false, errors };
  }

  if (type === RULE_TYPES.KEYWORD) {
    if (!config.pattern) {
      errors.push('Keyword rule requires a non-empty pattern');
    } else if (config.pattern.startsWith('/') && config.pattern.endsWith('/')) {
      // Validate regex
      try {
        new RegExp(config.pattern.slice(1, -1));
      } catch {
        errors.push(`Invalid regex pattern: ${config.pattern}`);
      }
    }
    if (config.fields) {
      const invalid = config.fields.filter(f => !VALID_KEYWORD_FIELDS.includes(f));
      if (invalid.length) {
        errors.push(`Invalid fields: ${invalid.join(', ')}. Allowed: ${VALID_KEYWORD_FIELDS.join(', ')}`);
      }
    }
  }

  if (type === RULE_TYPES.SMART) {
    if (!config.description) {
      errors.push('Smart rule requires a description');
    }
    if (!config.fnSource) {
      errors.push('Smart rule requires fnSource');
    } else {
      const fnValidation = validateSmartRuleFn(config.fnSource);
      errors.push(...fnValidation.errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a smart rule function source for banned globals.
 * Uses word-boundary regex to avoid false positives on substrings.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateSmartRuleFn(fnSource) {
  const errors = [];

  if (fnSource.length > MAX_FN_SOURCE_BYTES) {
    errors.push(`Function source exceeds 10KB limit (${fnSource.length} bytes)`);
  }

  for (const name of BANNED_GLOBALS) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(fnSource)) {
      errors.push(`Banned global detected: ${name}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Match a keyword rule against page data.
 * Returns 1 (match) or 0 (no match).
 * Checks title, url by default; also checks body if present in pageData.
 */
export function matchKeywordRule(rule, pageData) {
  const { pattern, fields, caseSensitive } = rule.config;
  const checkFields = [...(fields || ['title', 'url'])];
  // Always include body when available (fetched page content for richer matching)
  if (pageData.body && !checkFields.includes('body')) checkFields.push('body');

  let isRegex = false;
  let regex = null;

  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    isRegex = true;
    try {
      const flags = caseSensitive ? '' : 'i';
      regex = new RegExp(pattern.slice(1, -1), flags);
    } catch {
      return 0;
    }
  }

  for (const field of checkFields) {
    const value = pageData[field];
    if (!value) continue;

    if (isRegex) {
      if (regex.test(value)) return 1;
    } else {
      const haystack = caseSensitive ? value : value.toLowerCase();
      const needle = caseSensitive ? pattern : pattern.toLowerCase();
      if (haystack.includes(needle)) return 1;
    }
  }

  return 0;
}

/**
 * Match multiple rules against page data.
 *
 * @param {Array} rules - Array of rule objects { id, type, config }
 * @param {Object} pageData - { title, url, body? }
 * @param {Object} options - { sandbox?, allScores? }
 *   sandbox: async (fnSource, pageData) => number — executes sandboxed function
 *   allScores: if true, return scores for ALL rules (not just above threshold)
 * @returns {Promise<Array<{ruleId, score, match}>>} — matched rules (or all if allScores)
 */
export async function matchRules(rules, pageData, { sandbox, allScores } = {}) {
  const results = [];

  for (const rule of rules) {
    const threshold = rule.config.threshold ?? 0.5;

    if (rule.type === RULE_TYPES.KEYWORD) {
      const score = matchKeywordRule(rule, pageData);
      if (allScores || score >= threshold) {
        results.push({ ruleId: rule.id, score, match: score >= threshold });
      }
    } else if (rule.type === RULE_TYPES.SMART) {
      if (!sandbox) continue;
      const score = await sandbox(rule.config.fnSource, pageData);
      if (allScores || score >= threshold) {
        results.push({ ruleId: rule.id, score, match: score >= threshold });
      }
    }
  }

  return results;
}

/**
 * Build page data from a visit_page log entry.
 */
export function buildPageDataFromEntry(entry) {
  const data = {
    title: entry.title || '',
    url: entry.url || '',
  };
  if (entry.bodyPreview || entry.body) data.body = entry.bodyPreview || entry.body;
  return data;
}
