export const EXTENSION_PAPER_COLOR = '#f7f4ea';
export const EXTENSION_ERROR_COLOR = '#ff2d20';

export function applyPaperErrorPopoutStyle(element) {
  element.style.backgroundColor = EXTENSION_PAPER_COLOR;
  element.style.color = EXTENSION_ERROR_COLOR;
  element.style.borderColor = EXTENSION_ERROR_COLOR;
}

export function paperErrorPopoutCss({
  top = '12px',
  zIndex = 999999,
  fontSize = '12px',
  padding = '6px 14px',
  maxWidth = '360px',
  includeFade = false,
} = {}) {
  return [
    'position:fixed',
    `top:${top}`,
    'left:50%',
    'transform:translateX(-50%)',
    `z-index:${zIndex}`,
    `background:${EXTENSION_PAPER_COLOR}`,
    `color:${EXTENSION_ERROR_COLOR}`,
    `border:1px solid ${EXTENSION_ERROR_COLOR}`,
    `font:${fontSize}/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`,
    `padding:${padding}`,
    'border-radius:6px',
    ...(includeFade
      ? ['opacity:0', 'transition:opacity 0.25s', 'pointer-events:none']
      : []),
    `max-width:${maxWidth}`,
    'text-align:center',
  ].join(';');
}
