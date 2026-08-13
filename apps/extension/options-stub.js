import {
  initializeExtensionI18n,
  localizeDocument,
  tr,
} from '../../packages/core/i18n.js';
import { getBrowserCapabilities } from './browser-capabilities.js';

await initializeExtensionI18n();
localizeDocument();

const openButton = document.getElementById('openApp');
const notRunningNotice = document.getElementById('notRunning');
const shortcutsList = document.getElementById('shortcutsList');
const customizeShortcuts = document.getElementById('customizeShortcuts');

const SHORTCUT_ORDER = [
  'highlight-selection',
  'capture-snapshot',
  'like-page',
  'dislike-page',
];

const SHORTCUT_LABELS = {
  'highlight-selection': () =>
    tr('commandHighlightSelection', 'Highlight selected text', undefined),
};

openButton.addEventListener('click', () => {
  notRunningNotice.hidden = true;
  window.open('browser-recall://open');
  window.setTimeout(() => {
    if (document.visibilityState === 'visible') {
      notRunningNotice.hidden = false;
    }
  }, 1200);
});

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  const byName = Object.fromEntries(
    commands.map((command) => [command.name, command]),
  );
  const ordered = SHORTCUT_ORDER.map((name) => byName[name]).filter(Boolean);
  shortcutsList.innerHTML = '';
  for (const command of ordered) {
    const row = document.createElement('div');
    row.className = 'shortcut-row';

    const desc = document.createElement('span');
    desc.className = 'shortcut-desc';
    desc.textContent =
      SHORTCUT_LABELS[command.name]?.() || command.description || command.name;

    const key = document.createElement('span');
    key.className = command.shortcut ? 'shortcut-key' : 'shortcut-key not-set';
    key.textContent =
      command.shortcut || tr('extensionNotSet', 'Not set', undefined);

    row.append(desc, key);
    shortcutsList.appendChild(row);
  }
}

customizeShortcuts.addEventListener('click', () => {
  const capabilities = getBrowserCapabilities();
  const url =
    capabilities.buildTarget === 'firefox'
      ? 'about:addons'
      : 'chrome://extensions/shortcuts';
  chrome.tabs.create({ url });
});

renderShortcuts().catch((error) => {
  shortcutsList.textContent = tr(
    'extensionCouldNotLoadShortcuts',
    'Could not load shortcuts: $1',
    error.message,
  );
});
