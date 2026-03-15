const params = new URLSearchParams(location.search);
const slug = params.get('slug');
const ts = params.get('ts');

if (!slug || !ts) {
  document.body.textContent = 'Missing snapshot parameters.';
  throw new Error('Missing slug or ts');
}

// Fetch snapshot HTML content from background → offscreen
const htmlResp = await chrome.runtime.sendMessage({
  action: 'getSnapshotHtml', slug, timestamp: parseInt(ts)
});
if (!htmlResp?.success) {
  document.body.textContent = 'Snapshot not found.';
  throw new Error(htmlResp?.error || 'getSnapshotHtml failed');
}

const html = htmlResp.html;

const frame = document.getElementById('frame');
frame.srcdoc = html;

// Set tab title from snapshot content
const parser = new DOMParser();
const parsed = parser.parseFromString(html, 'text/html');
const title = parsed.querySelector('title')?.textContent;
if (title) document.title = title;

// After iframe loads, apply highlights from the original page's notes
frame.addEventListener('load', async () => {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'loadPageNotes', slug });
    if (!resp?.success || !resp?.notes) return;

    const doc = frame.contentDocument;
    for (const note of resp.notes) {
      if (note.excerpt === null) continue;
      const quotes = Array.isArray(note.excerpt) ? note.excerpt : [note.excerpt];
      for (const text of quotes) {
        highlightInDoc(doc, text, note.slug);
      }
    }
  } catch (e) {
    console.warn('[snapshot-viewer] highlight injection failed:', e);
  }
});

// Simplified highlight: find text across nodes and wrap in <mark>
function highlightInDoc(doc, text, noteSlug) {
  if (!text) return;
  const textNodes = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  let concat = '';
  const offsets = [];
  for (const tn of textNodes) { offsets.push(concat.length); concat += tn.textContent; }

  const idx = concat.indexOf(text);
  if (idx === -1) return;
  const endIdx = idx + text.length;

  let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
  for (let i = 0; i < textNodes.length; i++) {
    const nodeStart = offsets[i];
    const nodeEnd = nodeStart + textNodes[i].textContent.length;
    if (!startNode && nodeEnd > idx) { startNode = textNodes[i]; startOffset = idx - nodeStart; }
    if (nodeEnd >= endIdx) { endNode = textNodes[i]; endOffset = endIdx - offsets[i]; break; }
  }
  if (!startNode || !endNode) return;

  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);

  const mark = doc.createElement('mark');
  mark.style.cssText = 'background: #fff3b0; border-bottom: 2px solid #f0c000;';
  mark.dataset.highlightText = text;
  if (noteSlug) mark.dataset.noteSlug = noteSlug;

  if (range.startContainer === range.endContainer) {
    try { range.surroundContents(mark); return; } catch {}
  }
  try {
    const fragment = range.extractContents();
    mark.appendChild(fragment);
    range.insertNode(mark);
  } catch {}
}
