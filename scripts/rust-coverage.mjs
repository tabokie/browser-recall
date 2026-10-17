import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function generateRustCoverage(root, run = spawnSync) {
  const outputDir = path.join(root, 'coverage/rust');
  fs.mkdirSync(outputDir, { recursive: true });
  const commands = [
    ['llvm-cov', 'clean', '--workspace'],
    ['llvm-cov', '--locked', '--workspace', '--all-targets', '--no-report'],
  ];
  for (const [format, name] of [
    [['--summary-only', '--json'], 'coverage-summary.json'],
    [['--text', '--show-missing-lines'], 'missing.txt'],
  ]) {
    commands.push([
      'llvm-cov',
      'report',
      ...format,
      '--output-path',
      path.join(outputDir, name),
    ]);
  }
  for (const args of commands) {
    const result = run('cargo', args, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Rust coverage failed with exit code ${result.status}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    generateRustCoverage(process.cwd());
    console.log('Rust coverage reports written to coverage/rust');
  } catch (error) {
    console.error(error.message);
    console.error(
      'Install cargo-llvm-cov and llvm-tools-preview, then rerun npm run coverage:rust.',
    );
    process.exitCode = 1;
  }
}
