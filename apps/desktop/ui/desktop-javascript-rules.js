import { tr } from '../../../packages/core/i18n.js';
import { escapeHtml } from './utils.js';

const JS_KEYWORDS = new Set([
  'break',
  'case',
  'catch',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'of',
  'return',
  'switch',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'await',
  'async',
  'class',
]);
const JS_LITERALS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'this',
]);
const JS_TOKEN_RE =
  /\/\/.*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/(?:[^/\\]|\\.)+\/[gimsuy]*|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[a-zA-Z_$][\w$]*|[^\s]/g;

function highlightJS(src) {
  return src.replace(JS_TOKEN_RE, (tok) => {
    if (tok.startsWith('//') || tok.startsWith('/*'))
      return `<span class="tok-comment">${escapeHtml(tok)}</span>`;
    if (tok[0] === '"' || tok[0] === "'" || tok[0] === '`')
      return `<span class="tok-string">${escapeHtml(tok)}</span>`;
    if (tok[0] === '/' && tok.length > 1 && tok[1] !== '/')
      return `<span class="tok-regex">${escapeHtml(tok)}</span>`;
    if (/^\d/.test(tok))
      return `<span class="tok-number">${escapeHtml(tok)}</span>`;
    if (JS_KEYWORDS.has(tok))
      return `<span class="tok-keyword">${escapeHtml(tok)}</span>`;
    if (JS_LITERALS.has(tok))
      return `<span class="tok-literal">${escapeHtml(tok)}</span>`;
    return escapeHtml(tok);
  });
}

function syncHighlight(textarea, pre) {
  pre.innerHTML = highlightJS(textarea.value) + '\n';
}

export const javascriptRuleEditor = {
  buildRule(editRow, inputVal) {
    const fnSource =
      editRow.querySelector('.rule-fn-input')?.value.trim() || '';
    if (!fnSource)
      return {
        error: tr('desktopFunctionBodyRequired', 'Function body is required'),
      };
    return {
      rule: {
        type: 'function',
        config: {
          description:
            inputVal || tr('desktopCustomFunction', '(custom function)'),
          fnSource,
        },
      },
    };
  },
  render(isKeyword, config) {
    const fnSource = config?.fnSource || '';
    const typeControls = `<div class="rule-type-toggle">
           <span class="rule-type-option ${isKeyword ? 'active' : ''}" data-type="keyword">${escapeHtml(tr('desktopKeyword', 'Keyword'))}</span>
           <span class="rule-type-option ${!isKeyword ? 'active' : ''}" data-type="function">${escapeHtml(tr('desktopFunction', 'Function'))}</span>
         </div>`;
    const functionEditor = `<div class="rule-fn-editor" style="${isKeyword ? 'display:none' : ''}">
         <pre class="rule-fn-highlight" aria-hidden="true"></pre>
         <textarea class="rule-fn-input scroll-boundary-contained" rows="20" placeholder="// page = { title, url, body }\nreturn page.title !== null && page.title.length > 50;" spellcheck="false">${escapeHtml(fnSource)}</textarea>
       </div>`;
    return { typeControls, functionEditor };
  },
  bind(editRow) {
    editRow.querySelectorAll('.rule-type-option').forEach((opt) => {
      opt.addEventListener('click', () => {
        editRow
          .querySelectorAll('.rule-type-option')
          .forEach((o) => o.classList.remove('active'));
        opt.classList.add('active');
        const type = opt.dataset.type;
        const input = editRow.querySelector('.rule-edit-input');
        input.placeholder =
          type === 'keyword'
            ? tr('desktopRuleKeywordPlaceholder', 'keyword or /regex/')
            : tr('desktopRuleDescriptionPlaceholder', 'description');
        editRow.querySelector('.rule-fn-editor').style.display =
          type === 'function' ? '' : 'none';
      });
    });

    const fnTextarea = editRow.querySelector('.rule-fn-input');
    const fnPre = editRow.querySelector('.rule-fn-highlight');
    syncHighlight(fnTextarea, fnPre);
    fnTextarea.addEventListener('input', () =>
      syncHighlight(fnTextarea, fnPre),
    );
    fnTextarea.addEventListener('scroll', () => {
      fnPre.scrollTop = fnTextarea.scrollTop;
      fnPre.scrollLeft = fnTextarea.scrollLeft;
    });
  },
};
