#!/usr/bin/env node
// Purge attention-only log entries from specified JSONL history files.
// For each URL, keeps only the LAST attention-only entry (highest timestamp,
// final scrollDepth/timeOnPage). All visit and non-attention entries are kept.
//
// An "attention-only" entry: action=page, has timeOnPage, no title field.

const fs = require('fs');
const path = require('path');

const PORTAL = path.join(require('os').homedir(), 'portal-data', 'history');
const FILES = ['2026-02-20.jsonl', '2026-02-21.jsonl'];

for (const file of FILES) {
  const fp = path.join(PORTAL, file);
  const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');

  // First pass: find last attention-only entry index per URL
  const lastAttentionIdx = new Map();
  for (let i = 0; i < lines.length; i++) {
    const e = JSON.parse(lines[i]);
    if (e.action === 'page' && e.timeOnPage !== undefined && !e.title) {
      lastAttentionIdx.set(e.url, i);
    }
  }

  // Second pass: keep non-attention entries + only the last attention per URL
  const kept = [];
  let dropped = 0;
  for (let i = 0; i < lines.length; i++) {
    const e = JSON.parse(lines[i]);
    const isAttention = e.action === 'page' && e.timeOnPage !== undefined && !e.title;
    if (isAttention && lastAttentionIdx.get(e.url) !== i) {
      dropped++;
      continue;
    }
    kept.push(lines[i]);
  }

  console.log(`${file}: ${lines.length} → ${kept.length} (dropped ${dropped} attention-only entries)`);
  fs.writeFileSync(fp, kept.join('\n') + '\n');
}
