#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.resolve(__dirname, '../extension/utils.js');
const { generateSlugFromUrl } = await import('file://' + utilsPath);

const dataDir = path.join(process.env.HOME, 'portal-data');

const gateways = JSON.parse(fs.readFileSync(path.join(dataDir, 'lists/gateways.json'), 'utf-8'));
const recycleBin = JSON.parse(fs.readFileSync(path.join(dataDir, 'lists/system/recycle-bin.json'), 'utf-8'));
const permDeletes = JSON.parse(fs.readFileSync(path.join(dataDir, 'lists/system/permanent-deletes.json'), 'utf-8'));

const validGateways = Object.entries(gateways.domains).filter(([k,v]) => v.rootUrl && v.childCount >= 2);
console.log('Valid gateway URLs:', validGateways.length);

let recycled = 0, deleted = 0;
const samples = [];

for (const [origin, info] of validGateways.slice(0, 10)) {
  const slug = generateSlugFromUrl(info.rootUrl);
  const key = 'page:' + slug;

  const isRecycled = recycleBin.items.some(item => item.key === key);
  const isDeleted = permDeletes.keys.includes(key);

  if (isRecycled) recycled++;
  if (isDeleted) deleted++;

  samples.push({
    url: info.rootUrl,
    slug,
    key,
    isRecycled,
    isDeleted
  });
}

console.log('\nSample gateway URLs:');
for (const s of samples) {
  console.log(`  ${s.url}`);
  console.log(`    Key: ${s.key}`);
  console.log(`    Recycled: ${s.isRecycled}, Deleted: ${s.isDeleted}`);
}

console.log('\nTotal:');
console.log('  Valid gateways:', validGateways.length);
console.log('  Recycled:', recycled);
console.log('  Permanently deleted:', deleted);
console.log('  Should display:', validGateways.length - recycled - deleted);
