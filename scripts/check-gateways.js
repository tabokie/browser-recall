#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const dataPath = path.join(process.env.HOME, 'portal-data/lists/gateways.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

const valid = Object.entries(data.domains).filter(([k,v]) => v.rootUrl && v.childCount >= 2);
console.log('Valid gateway URLs:', valid.length);
console.log('\nSample gateways:');
for (const [origin, info] of valid.slice(0, 5)) {
  console.log(`  ${origin}`);
  console.log(`    Root: ${info.rootUrl}`);
  console.log(`    Children: ${info.childCount}`);
}

// Check if any of these URLs exist in recent history
const historyDir = path.join(process.env.HOME, 'portal-data/history');
const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort().reverse();
const recentFile = files[0];
const lines = fs.readFileSync(path.join(historyDir, recentFile), 'utf-8').split('\n').filter(l => l.trim());

let gatewayMatches = 0;
for (const line of lines) {
  try {
    const entry = JSON.parse(line);
    if (entry.url && entry.action === 'page') {
      for (const [origin, info] of valid) {
        if (entry.url === info.rootUrl) {
          gatewayMatches++;
          console.log(`\nFound gateway URL in ${recentFile}: ${entry.url}`);
          break;
        }
      }
    }
  } catch {}
}

console.log(`\nTotal gateway URL matches in ${recentFile}: ${gatewayMatches}`);
