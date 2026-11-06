const EXTENSION_PAPER_COLOR = '#f7f4ea';
const EXTENSION_ERROR_COLOR = '#ff2d20';

// Build serializable options before crossing into a tab. Labels and version
// remain available even when a stale content script has lost its extension API.
export function errorBubbleOptions(message, translate, version) {
  return {
    message,
    version,
    paperColor: EXTENSION_PAPER_COLOR,
    errorColor: EXTENSION_ERROR_COLOR,
    labels: {
      copy: translate('extensionCopyErrorDetails', 'Copy details'),
      close: translate('commonClose', 'Close'),
      copied: translate('extensionErrorCopied', 'Copied'),
      copyFailed: translate(
        'extensionErrorCopyFailed',
        'Copy failed. The message is selected for manual copying.',
      ),
    },
  };
}

// Keep this renderer self-contained: background.js also passes the function
// directly to scripting.executeScript when the content receiver is missing.
export function renderErrorBubble(options) {
  const {
    message,
    detail = message,
    version,
    labels,
    paperColor,
    errorColor,
    id = 'browser-recall-user-action-error',
    inline = false,
    pageUrl = location.href,
    onDismiss,
  } = options;
  document.getElementById(id)?.remove();
  const host = document.createElement(inline ? 'section' : 'div');
  host.id = id;
  host.setAttribute('aria-label', message);
  let root = host;
  let bubble = host;
  if (!inline) {
    // Save Page WE must skip a notification even when no content receiver has
    // initialized the tab's transient UI registry yet.
    if (!(globalThis.__browserRecallTransientUiHosts instanceof WeakSet)) {
      Object.defineProperty(globalThis, '__browserRecallTransientUiHosts', {
        value: new WeakSet(),
        writable: false,
        configurable: false,
      });
    }
    globalThis.__browserRecallTransientUiHosts.add(host);
    host.style.cssText =
      'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    root = host.attachShadow({ mode: 'closed' });
    bubble = document.createElement('section');
    root.appendChild(bubble);
  }
  bubble.className = 'error-bubble';
  const style = document.createElement('style');
  const css = `
    .error-bubble {
      box-sizing: border-box; position: ${inline ? 'sticky' : 'absolute'};
      top: ${inline ? '8px' : '12px'}; z-index: 2147483647;
      ${inline ? 'margin:8px;' : 'left:50%;transform:translateX(-50%);width:min(420px,calc(100vw - 24px));'}
      max-height:calc(100vh - 24px); overflow:auto; padding:10px;
      border:2px solid ${errorColor}; border-radius:6px;
      background:${paperColor}; color:${errorColor}; pointer-events:auto;
      font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      text-align:start; text-transform:none; letter-spacing:normal;
    }
    .error-bubble-message {
      margin:0; max-height:160px; overflow:auto; overflow-wrap:anywhere;
      white-space:pre-wrap; user-select:text; cursor:text; font:inherit;
    }
    .error-bubble-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .error-bubble-actions button {
      padding:4px 8px; border:1px solid currentColor; border-radius:3px;
      color:inherit; background:transparent; font:inherit; cursor:pointer;
    }
    #errorCopyStatus:not(:empty) { margin-top:8px; }
  `;
  style.textContent = css;
  root.appendChild(style);
  const text = document.createElement('pre');
  text.id = 'errorBubbleMessage';
  text.className = 'error-bubble-message';
  text.tabIndex = 0;
  text.setAttribute('role', 'alert');
  text.textContent = detail === message ? message : `${message}\n\n${detail}`;
  const actions = document.createElement('div');
  actions.className = 'error-bubble-actions';
  const copy = document.createElement('button');
  copy.id = 'copyErrorDetailsBtn';
  copy.type = 'button';
  copy.textContent = labels.copy;
  const close = document.createElement('button');
  close.id = 'dismissErrorBtn';
  close.type = 'button';
  close.textContent = labels.close;
  actions.append(copy, close);
  const status = document.createElement('div');
  status.id = 'errorCopyStatus';
  status.setAttribute('role', 'status');
  bubble.append(text, actions, status);
  const details = [
    `Browser Recall ${version}`,
    `Page: ${pageUrl}`,
    `Browser: ${navigator.userAgent}`,
    detail,
  ].join('\n');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(details);
      status.textContent = labels.copied;
    } catch {
      text.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = root.getSelection?.() || window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = labels.copyFailed;
    }
  });
  const previousFocus = document.activeElement;
  const dismiss = () => {
    host.remove();
    if (onDismiss) onDismiss();
    else if (previousFocus?.isConnected)
      previousFocus.focus({ preventScroll: true });
  };
  close.addEventListener('click', dismiss);
  bubble.addEventListener('keydown', (event) => {
    // Page shortcuts must not consume typing or Escape inside the notification.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
  });
  if (inline) document.body.prepend(host);
  else document.documentElement.appendChild(host);
  if (inline) text.focus({ preventScroll: true });
  return host.id;
}

export function createErrorBubbleGlobalScript() {
  return `// Generated from apps/extension/extension-ui-tokens.js.\n(function () {\nconst EXTENSION_PAPER_COLOR = ${JSON.stringify(EXTENSION_PAPER_COLOR)};\nconst EXTENSION_ERROR_COLOR = ${JSON.stringify(EXTENSION_ERROR_COLOR)};\nglobalThis.browserRecallErrorBubble = { options: ${errorBubbleOptions.toString()}, render: ${renderErrorBubble.toString()} };\n})();\n`;
}
