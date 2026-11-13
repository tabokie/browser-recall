import './locale.js';

for (const demo of document.querySelectorAll('.interactive-demo'))
  demo.hidden = false;
for (const image of document.querySelectorAll('.demo-still'))
  image.hidden = true;

const desktop = document.querySelector('.timeline-frame');
const styleToggle = document.querySelector('.demo-style-toggle');
function applyDesktopStyle() {
  const style = styleToggle.querySelector('input:checked').value;
  desktop.contentWindow.postMessage(
    { type: 'desktop-style', style },
    location.origin,
  );
}
styleToggle.addEventListener('change', applyDesktopStyle);
desktop.addEventListener('load', applyDesktopStyle);
applyDesktopStyle();

// Keep repeated sample captures visible without adding an inner scroll area.
window.addEventListener('message', (event) => {
  const frame = document.querySelector('.browser-frame');
  if (
    event.origin !== location.origin ||
    event.source !== frame?.contentWindow ||
    event.data?.type !== 'browser-height'
  )
    return;
  const height = event.data.height;
  if (Number.isFinite(height) && height >= 540)
    frame.style.height = `${height}px`;
});
