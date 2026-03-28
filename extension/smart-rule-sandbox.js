// smart-rule-sandbox.js — Executes LLM-compiled JS functions in a sandboxed page.
// This page is declared in manifest.json "sandbox" key, granting unsafe-eval CSP.
// Communication via postMessage from the parent offscreen document.

window.addEventListener('message', (event) => {
  const { id, action, fnSource, pageData } = event.data;
  if (action !== 'execute') return;
  try {
    const fn = new Function('page', fnSource);
    const result = fn(pageData);
    const score = typeof result === 'boolean' ? (result ? 1 : 0)
      : typeof result === 'number' ? Math.max(0, Math.min(1, result)) : 0;
    event.source.postMessage({ id, score }, '*');
  } catch (err) {
    event.source.postMessage({ id, error: err.message }, '*');
  }
});
