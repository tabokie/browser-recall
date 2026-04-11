// fn-rule-sandbox.js — Executes user-authored JS predicate in a sandboxed page.
// This page is declared in manifest.json "sandbox" key, granting unsafe-eval CSP.
// Communication via postMessage from the parent offscreen document.

window.addEventListener('message', (event) => {
  const { id, action, fnSource, pageData } = event.data;
  if (action !== 'execute') return;
  try {
    const fn = new Function('page', fnSource);
    const result = fn(pageData);
    const match = Boolean(result);
    event.source.postMessage({ id, match }, '*');
  } catch (err) {
    event.source.postMessage({ id, error: err.message }, '*');
  }
});
