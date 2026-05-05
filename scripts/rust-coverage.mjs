import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const outputDir = path.join(ROOT, 'coverage/rust');
const outputPath = path.join(outputDir, 'coverage-summary.json');
const missingPath = path.join(outputDir, 'missing.txt');

fs.mkdirSync(outputDir, { recursive: true });

const summaryArgs = [
  'llvm-cov',
  '--workspace',
  '--all-targets',
  '--summary-only',
  '--json',
  '--output-path',
  outputPath,
];

const missingArgs = [
  'llvm-cov',
  '--workspace',
  '--all-targets',
  '--text',
  '--show-missing-lines',
  '--output-path',
  missingPath,
];

function runCoverage(args) {
  return spawnSync('cargo', args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

let result = runCoverage(summaryArgs);

if (result.status === 0) {
  result = runCoverage(missingArgs);
}

if (result.error?.code === 'ENOENT') {
  console.error('cargo was not found. Install Rust before running coverage.');
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    '\nRust coverage failed. Ensure `cargo-llvm-cov` and the `llvm-tools-preview` rustup component are installed, then rerun `npm run coverage:rust`.',
  );
  process.exit(result.status || 1);
}

console.log(
  `Rust coverage summary written to ${path.relative(ROOT, outputPath)}`,
);
console.log(
  `Rust missing line report written to ${path.relative(ROOT, missingPath)}`,
);
