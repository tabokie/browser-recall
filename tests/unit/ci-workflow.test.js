import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const ciWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/ci.yml'),
  'utf8',
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);

function jobBody(jobName, nextJobName) {
  const start = ciWorkflow.indexOf(`  ${jobName}:`);
  const end = nextJobName
    ? ciWorkflow.indexOf(`  ${nextJobName}:`, start + 1)
    : ciWorkflow.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return ciWorkflow.slice(start, end);
}

describe('GitHub CI prerequisites', () => {
  test.each([
    ['test', 'test-rust', 'ci:test'],
    ['test-rust', 'test-desktop-visual', 'ci:test-rust'],
    [
      'test-desktop-visual',
      'lint-js',
      'ci:install-playwright ci:test-desktop-visual',
    ],
    ['lint-js', 'lint-rust', 'ci:lint-js'],
    ['lint-rust', null, 'ci:lint-rust'],
  ])('%s delegates to local CI scripts', (job, nextJob, scripts) => {
    const body = jobBody(job, nextJob);
    for (const script of scripts.split(' ')) {
      expect(body).toContain(`npm run ${script}`);
    }
  });

  test('local CI composes every GitHub CI job', () => {
    expect(packageJson.scripts.ci).toBe(
      'npm run ci:test && npm run ci:test-rust && npm run ci:install-playwright && npm run ci:test-desktop-visual && npm run ci:lint-js && npm run ci:lint-rust',
    );
    expect(packageJson.scripts['ci:install-playwright']).toBe(
      'playwright install --no-shell chromium',
    );
  });
});
