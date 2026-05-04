// rule-engine.js — Pure rule matching module.
// No Chrome APIs. Importable by background.js and testable with vitest.

export const RULE_TYPES = {
  KEYWORD: 'keyword',
  FUNCTION: 'function',
};

const BANNED_GLOBALS = [
  'fetch',
  'chrome',
  'window',
  'document',
  'navigator',
  'globalThis',
  'eval',
  'Function',
  'setTimeout',
  'setInterval',
  'WebSocket',
  'Worker',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'importScripts',
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
    for (const key of Object.keys(config)) {
      if (key !== 'pattern') {
        errors.push(`Unsupported keyword rule field: ${key}`);
      }
    }
  }

  if (type === RULE_TYPES.FUNCTION) {
    if (!config.description) {
      errors.push('Function rule requires a description');
    }
    if (!config.fnSource) {
      errors.push('Function rule requires fnSource');
    } else {
      const fnValidation = validateFnRuleSource(config.fnSource);
      errors.push(...fnValidation.errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a function rule source for banned globals.
 * Uses word-boundary regex to avoid false positives on substrings.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateFnRuleSource(fnSource) {
  const errors = [];

  if (fnSource.length > MAX_FN_SOURCE_BYTES) {
    errors.push(
      `Function source exceeds 10KB limit (${fnSource.length} bytes)`,
    );
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
 * Checks the page title only.
 */
export function matchKeywordRule(rule, pageData) {
  const { pattern } = rule.config;
  const value = pageData.title;
  if (!pattern || !value) return 0;

  let isRegex = false;
  let regex = null;

  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    isRegex = true;
    try {
      regex = new RegExp(pattern.slice(1, -1), 'i');
    } catch {
      return 0;
    }
  }

  if (isRegex) {
    if (regex.test(value)) return 1;
  } else {
    const haystack = value.toLowerCase();
    const needle = pattern.toLowerCase();
    if (haystack.includes(needle)) return 1;
  }

  return 0;
}

/**
 * Match multiple rules against page data.
 *
 * @param {Array} rules - Array of rule objects { id, type, config }
 * @param {Object} pageData - { title, url, body? }
 * @param {Object} options - { sandbox?, allResults? }
 *   sandbox: async (fnSource, pageData) => boolean — executes sandboxed predicate
 *   allResults: if true, return results for ALL rules (not just matches)
 * @returns {Promise<Array<{ruleId, match: boolean}>>}
 */
export async function matchRules(
  rules,
  pageData,
  { sandbox, allResults } = {},
) {
  const results = [];

  for (const rule of rules) {
    if (rule.type === RULE_TYPES.KEYWORD) {
      const match = matchKeywordRule(rule, pageData) === 1;
      if (allResults || match) {
        results.push({ ruleId: rule.id, match });
      }
    } else if (rule.type === RULE_TYPES.FUNCTION) {
      if (!sandbox) continue;
      const match = await sandbox(rule.config.fnSource, pageData);
      if (allResults || match) {
        results.push({ ruleId: rule.id, match });
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
  if (entry.bodyPreview || entry.body)
    data.body = entry.bodyPreview || entry.body;
  return data;
}
