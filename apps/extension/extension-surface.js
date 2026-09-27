(function () {
  const SHADOW_CSS = `
    :host {
      all: initial;
      color-scheme: light;
      --br-bg-base: #f7f4ea;
      --br-bg-surface-active: rgba(23, 23, 19, 0.08);
      --br-border-section: rgba(23, 23, 19, 0.22);
      --br-floating-border: 2px solid var(--br-text-primary);
      --br-text-primary: #171713;
      --br-text-muted: #77746a;
      --br-accent-primary: #171713;
      --br-accent-soft: rgba(23, 23, 19, 0.055);
      --br-accent-red: #ff2d20;
      --br-accent-red-soft: rgba(255, 45, 32, 0.14);
      --br-font-body: SFMono-Regular, Menlo, Consolas, 'Liberation Mono', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
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

  const HIGHLIGHT_ENTRY_CSS = `
    .highlight-item {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 0;
      padding: 9px var(--br-highlight-side-padding, 0px);
      border: 0;
      border-top: 1px dotted var(--br-border-section, var(--border-section));
      border-radius: 0;
      background: transparent;
      overflow: visible;
    }

    .note-display-row {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      color: var(--br-text-primary, var(--text-primary));
      font-size: 12px;
      line-height: 1.45;
    }

    .highlight-quote {
      flex: 1;
      min-width: 0;
      padding-left: 10px;
      border-left: 3px solid var(--br-accent-red, var(--accent-red));
    }

    .highlight-quote-line {
      min-width: 0;
      min-height: 1.45em;
    }

    .highlight-excerpt {
      min-width: 0;
      color: var(--br-text-primary, var(--text-primary));
      font-style: normal;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .highlight-note-row {
      min-height: 1.45em;
      margin-top: 8px;
      padding-right: 22px;
    }

    .highlight-note-text {
      flex: 1;
      min-width: 0;
      color: var(--br-text-primary, var(--text-primary));
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .highlight-note-editor {
      display: block;
      width: 100%;
      min-width: 0;
      min-height: 1.45em;
      padding: 0;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--br-text-primary, var(--text-primary));
      font: inherit;
      line-height: inherit;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      caret-color: var(--br-text-primary, var(--text-primary));
    }

    .highlight-note-editor:empty::before {
      content: attr(data-placeholder);
      color: var(--br-text-muted, var(--text-muted));
      font-size: 10px;
      font-style: italic;
      pointer-events: none;
    }

    .note-action-btn {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      border-radius: 2px;
      background: none;
      color: var(--br-text-muted, var(--text-muted));
      cursor: pointer;
      font: inherit;
      line-height: 1;
    }

    .note-action-btn:hover {
      background: var(--br-bg-surface-active, var(--bg-surface-active));
      color: var(--br-text-primary, var(--text-primary));
    }

    .note-action-btn:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .note-action-btn svg {
      display: block;
      width: 12px;
      height: 12px;
    }

    .highlight-edit-action {
      position: absolute;
      right: var(--br-highlight-side-padding, 0px);
      bottom: 9px;
    }
  `;

  const HIGHLIGHT_ICON_EDIT =
    '<svg data-icon="edit" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3z"/></svg>';
  const HIGHLIGHT_ICON_DELETE =
    '<svg data-icon="delete" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';
  const HIGHLIGHT_ICON_CONFIRM =
    '<svg data-icon="checkmark" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"><path d="M2.5 8.5l3.2 3.2L13.5 4"/></svg>';

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatHighlightExcerpt(excerpt) {
    return highlightExcerptParts(excerpt).join('\n');
  }

  function highlightExcerptParts(excerpt) {
    if (
      !Array.isArray(excerpt) ||
      excerpt.length === 0 ||
      !excerpt.every((part) => typeof part === 'string' && part)
    ) {
      throw new Error('Highlight excerpt must be a non-empty string array');
    }
    return excerpt;
  }

  function highlightEntryHtml(note, labels = {}) {
    const quoteLines = formatHighlightExcerpt(note.excerpt)
      .split('\n')
      .map(
        (line) =>
          `<div class="highlight-quote-line"><span class="highlight-excerpt">${escapeHtml(line)}</span></div>`,
      )
      .join('');
    const noteDisplay = note.note
      ? `<span class="highlight-note-text">${escapeHtml(note.note)}</span>`
      : '';
    return `<div class="highlight-item" data-note-slug="${escapeHtml(note.slug)}">
      <div class="highlight-quote-row note-display-row">
        <div class="highlight-quote">${quoteLines}</div>
        <button class="note-action-btn delete" title="${escapeHtml(labels.deleteTitle || '')}">${HIGHLIGHT_ICON_DELETE}</button>
      </div>
      <div class="highlight-note-row note-display-row">${noteDisplay}</div>
      <button class="note-action-btn highlight-edit-action edit" title="${escapeHtml(labels.editTitle || '')}">${HIGHLIGHT_ICON_EDIT}</button>
    </div>`;
  }

  function installHighlightEntryStyles(doc = document) {
    if (doc.getElementById('browser-recall-highlight-entry-styles')) return;
    const style = doc.createElement('style');
    style.id = 'browser-recall-highlight-entry-styles';
    style.textContent = HIGHLIGHT_ENTRY_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  const noteEditors = new WeakMap();
  const noteOverlays = new WeakMap();

  async function saveHighlightNoteEditors(root) {
    const results = await Promise.all(
      [...root.querySelectorAll('.highlight-item')].map((item) =>
        noteEditors.get(item)?.save(),
      ),
    );
    return results.every((result) => result !== false);
  }

  function closeHighlightEditOverlay(doc = document) {
    return noteOverlays.get(doc)?.save() ?? Promise.resolve(true);
  }

  function openHighlightNoteEditor({
    item,
    note,
    placeholder,
    confirmTitle,
    editTitle,
    save,
    onSaved = () => {},
    onError = () => {},
    onChange = () => {},
    view = window,
  }) {
    const row = item?.querySelector('.highlight-note-row');
    const action = item?.querySelector('.highlight-edit-action');
    const deleteAction = item?.querySelector('.note-action-btn.delete');
    if (!row || !action || action.classList.contains('confirm')) return;

    row.innerHTML = `<span class="highlight-note-editor" contenteditable="plaintext-only" role="textbox" aria-multiline="true" data-placeholder="${escapeHtml(placeholder || '')}">${escapeHtml(note.note || '')}</span>`;
    const editor = row.querySelector('.highlight-note-editor');
    action.classList.remove('edit');
    action.classList.add('confirm');
    action.title = confirmTitle || '';
    action.innerHTML = HIGHLIGHT_ICON_CONFIRM;

    let saving = null;
    let finished = false;

    const finish = (displayNote) => {
      if (finished) return;
      finished = true;
      noteEditors.delete(item);
      action.removeEventListener('click', saveCurrent);
      row.innerHTML = displayNote
        ? `<span class="highlight-note-text">${escapeHtml(displayNote)}</span>`
        : '';
      action.classList.remove('confirm');
      action.classList.add('edit');
      action.title = editTitle || '';
      action.innerHTML = HIGHLIGHT_ICON_EDIT;
      action.disabled = false;
      if (deleteAction) deleteAction.disabled = false;
    };

    const runMutation = (task) => {
      if (saving) return saving;
      if (finished) return Promise.resolve(true);
      action.disabled = true;
      editor.contentEditable = 'false';
      // Saving replaces the note slug. Keep sibling deletion locked until the
      // caller has installed the committed identity returned by save().
      if (deleteAction) deleteAction.disabled = true;
      saving = (async () => {
        try {
          await task();
          return true;
        } catch (error) {
          onError(error);
          if (item.isConnected) {
            action.disabled = false;
            editor.contentEditable = 'plaintext-only';
            if (deleteAction) deleteAction.disabled = false;
            editor.focus();
          }
          return false;
        } finally {
          saving = null;
        }
      })();
      return saving;
    };

    const saveCurrent = () =>
      runMutation(async () => {
        const nextNote = editor.innerText.replace(/\r\n/g, '\n');
        const result =
          nextNote === (note.note || '')
            ? { noteSlug: note.slug }
            : await save(nextNote);
        note.note = nextNote;
        await onSaved(result, nextNote);
        finish(nextNote);
      });
    const controller = {
      save: saveCurrent,
      remove: (remove) =>
        runMutation(async () => {
          await remove();
          finish(note.note || '');
        }),
    };
    noteEditors.set(item, controller);
    editor.addEventListener('input', () => {
      onChange(editor.innerText.replace(/\r\n/g, '\n'));
    });
    action.addEventListener('click', saveCurrent);
    editor.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape' && !saving) {
        event.preventDefault();
        void saveCurrent();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void saveCurrent();
      }
    });
    for (const eventName of ['keypress', 'keyup']) {
      editor.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    }
    editor.focus();
    const selection = view.getSelection();
    const range = view.document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return controller;
  }

  function createHighlightEditOverlay({
    doc = document,
    view = doc.defaultView || window,
    rect,
    note,
    placeholder,
    confirmTitle,
    editTitle,
    deleteTitle,
    save,
    onSaved,
    onDelete,
    onError = () => {},
  }) {
    // Callers close the previous editor before reading replacement note identity.
    if (noteOverlays.has(doc)) return;

    const host = doc.createElement('div');
    host.id = 'browser-recall-highlight-overlay';
    host.style.cssText =
      'position: absolute; z-index: 2147483647; visibility: hidden;';

    // This tree contains private note text and mutation controls. Keep it
    // closed, and stop its input events below so an archived or live page
    // cannot inspect the editor or react to its save/delete interactions.
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        ${SHADOW_CSS}
        ${HIGHLIGHT_ENTRY_CSS}
        .overlay {
          width: 300px;
          background: var(--br-bg-base);
          border: var(--br-floating-border);
          border-radius: 2px;
          color: var(--br-text-primary);
          font-family: var(--br-font-body);
          font-size: 12px;
          line-height: 1.45;
          padding: 0 8px;
        }
        .highlight-item {
          --br-highlight-side-padding: 0px;
          border-top: 0;
        }
      </style>
      <div class="overlay">
        ${highlightEntryHtml(note, { deleteTitle, editTitle })}
      </div>
    `;
    doc.body.appendChild(host);

    for (const eventName of [
      'pointerdown',
      'pointerup',
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
      'touchstart',
      'touchend',
    ]) {
      shadow.addEventListener(eventName, (event) => event.stopPropagation());
    }

    let handleOutsideClick;
    const removeHost = () => {
      if (handleOutsideClick) {
        doc.removeEventListener('mousedown', handleOutsideClick);
      }
      host.remove();
      noteOverlays.delete(doc);
    };
    const item = shadow.querySelector('.highlight-item');
    const controller = openHighlightNoteEditor({
      item,
      note,
      placeholder,
      confirmTitle,
      editTitle,
      save,
      async onSaved(...args) {
        await onSaved(...args);
        removeHost();
      },
      onError,
      view,
    });
    noteOverlays.set(doc, controller);

    const deleteAction = shadow.querySelector('.note-action-btn.delete');
    deleteAction.addEventListener('click', () => {
      void controller.remove(async () => {
        await onDelete();
        removeHost();
      });
    });

    handleOutsideClick = (event) => {
      if (!host.contains(event.target) && !deleteAction.disabled) {
        void controller.save();
      }
    };
    doc.addEventListener('mousedown', handleOutsideClick);

    positionNearRect(host, rect, view);
    const editor = shadow.querySelector('.highlight-note-editor');
    editor?.focus();
    return { host, editor, remove: controller.save };
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

  globalThis.browserRecallExtensionSurface = {
    createHighlightEditOverlay,
    closeHighlightEditOverlay,
    saveHighlightNoteEditors,
    escapeHtml,
    formatHighlightExcerpt,
    highlightEntryCss: HIGHLIGHT_ENTRY_CSS,
    highlightEntryHtml,
    highlightExcerptParts,
    installHighlightEntryStyles,
    openHighlightNoteEditor,
    positionNearRect,
    shadowCss: SHADOW_CSS,
  };
})();
