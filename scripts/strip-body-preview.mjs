#!/usr/bin/env node
// Strip bodyPreview field from all JSONL log entries in ~/portal-data/data/logs/
import fs from 'fs';
import path from 'path';

const LOGS_DIR = path.join(process.env.HOME, 'portal-data', 'data', 'logs');

const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
let totalStripped = 0;

for (const file of files) {
  const filePath = path.join(LOGS_DIR, file);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let changed = false;
  const output = [];

  for (const line of lines) {
    if (!line.trim()) { output.push(line); continue; }
    try {
      const entry = JSON.parse(line);
      if ('bodyPreview' in entry) {
        delete entry.bodyPreview;
        changed = true;
        totalStripped++;
      }
      output.push(JSON.stringify(entry));
    } catch {
      output.push(line); // preserve malformed lines
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, output.join('\n'));
    console.log(`${file}: stripped bodyPreview`);
  }
}

console.log(`Done. Stripped ${totalStripped} entries.`);
