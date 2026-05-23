(function () {
  const SHADOW_CSS = `
    :host {
      all: initial;
      color-scheme: dark;
      --br-bg-base: #0f0f0d;
      --br-bg-surface-active: rgba(238, 238, 223, 0.1);
      --br-border-section: rgba(238, 238, 223, 0.18);
      --br-text-primary: #eeeedf;
      --br-text-muted: #8b8b7e;
      --br-accent-primary: #eeeedf;
      --br-accent-soft: rgba(238, 238, 223, 0.09);
      --br-accent-red: #e33b32;
      --br-accent-red-soft: rgba(227, 59, 50, 0.16);
      --br-font-body: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
      --br-ease-smooth: cubic-bezier(0.25, 0.1, 0.25, 1);
    }

    * {
      box-sizing: border-box;
    }

    button,
    textarea {
      font: inherit;
    }

    button {
      cursor: pointer;
    }
  `;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function positionNearRect(host, rect, win = window, options = {}) {
    const gap = options.gap ?? 4;
    const margin = options.margin ?? 8;
    const viewportWidth =
      win.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      win.innerHeight || document.documentElement.clientHeight;
    const scrollX = win.scrollX || win.pageXOffset || 0;
    const scrollY = win.scrollY || win.pageYOffset || 0;
    const hostRect = host.getBoundingClientRect();
    const width = hostRect.width || options.width || 300;
    const height = hostRect.height || options.height || 120;
    const minLeft = scrollX + margin;
    const maxLeft = scrollX + Math.max(margin, viewportWidth - width - margin);
    const desiredLeft = scrollX + rect.left;
    const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);
    const belowTop = scrollY + rect.bottom + gap;
    const aboveTop = scrollY + rect.top - height - gap;
    const maxBottom = scrollY + viewportHeight - margin;
    const top =
      belowTop + height <= maxBottom
        ? belowTop
        : Math.max(scrollY + margin, aboveTop);

    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.visibility = 'visible';
  }

  function trashButtonHtml(title = 'Delete note') {
    return `<button class="delete-btn" title="${escapeHtml(title)}"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>`;
  }

  function noteOverlayHtml({
    title,
    excerpt,
    placeholder,
    includeDelete = false,
  } = {}) {
    const label = title
      ? `<div class="br-note-label">${escapeHtml(title)}</div>`
      : '';
    const quote =
      excerpt === undefined || excerpt === null
        ? ''
        : `<div class="br-note-excerpt">${escapeHtml(excerpt)}</div>`;
    return `
      ${label}
      ${quote}
      <div class="br-note-editor">
        ${includeDelete ? trashButtonHtml() : ''}
        <div class="br-note-body">
          <textarea placeholder="${escapeHtml(placeholder || '')}"></textarea>
        </div>
      </div>
    `;
  }

  globalThis.browserRecallExtensionSurface = {
    escapeHtml,
    noteOverlayHtml,
    positionNearRect,
    shadowCss: SHADOW_CSS,
    trashButtonHtml,
  };
})();
