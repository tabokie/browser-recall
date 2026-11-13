import './highlight.js';

const button = document.querySelector('#extensionToggle');
const popup = document.querySelector('#extensionPopup');
const frame = popup.querySelector('iframe');
const icon = button.querySelector('img');
const status = document.querySelector('#browser-status');
let popupHeight = 300;

function sizePopup() {
  const scale = popup.clientWidth / 296;
  const toolbarIcon = button.getBoundingClientRect();
  popup.style.top = `${toolbarIcon.bottom + 4}px`;
  popup.style.right = `${Math.max(12, innerWidth - toolbarIcon.right)}px`;
  frame.style.height = `${popupHeight}px`;
  frame.style.transform = `scale(${scale})`;
  popup.style.height = `${popupHeight * scale}px`;
  document.body.style.setProperty(
    '--popup-height',
    `${popup.hidden ? 0 : popupHeight * scale}px`,
  );
  document.body.style.setProperty(
    '--popup-left',
    `${popup.hidden ? innerWidth : popup.getBoundingClientRect().left}px`,
  );
  parent.postMessage(
    {
      type: 'browser-height',
      height: Math.max(
        540,
        Math.ceil(document.body.getBoundingClientRect().height),
        Math.ceil(popup.getBoundingClientRect().bottom + 24),
      ),
    },
    location.origin,
  );
}
function setOpen(open, focus = false) {
  popup.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  sizePopup();
  if (focus) button.focus();
}

function recordingStatus(paused, count) {
  if (paused)
    return 'Recording paused. The Browser Recall icon has closed its eyes.';
  if (!count)
    return 'Recording on. No lists selected. The page remains in your history.';
  return `Recording on. One page, at home in ${count} ${count === 1 ? 'list' : 'lists'}.`;
}

button.addEventListener('click', () => setOpen(true));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setOpen(false, true);
});
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow)
    return;
  if (event.data?.type === 'popup-close') setOpen(false, true);
  if (event.data?.type !== 'popup-state') return;
  const { height, paused, count } = event.data;
  popupHeight = height;
  icon.src = `../assets/extension-${paused ? 'paused' : 'recording'}.svg`;
  icon.alt = paused ? 'Recording paused' : 'Recording on';
  status.textContent = recordingStatus(paused, count);
  if (!popup.hidden) sizePopup();
});
window.addEventListener('resize', sizePopup);
function measurePopup() {
  frame.contentWindow.postMessage({ type: 'measure' }, location.origin);
}
frame.addEventListener('load', measurePopup);
measurePopup();
sizePopup();
