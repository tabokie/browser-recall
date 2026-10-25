import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

const selector = path.resolve(
  import.meta.dirname,
  '../../scripts/select-platform-checks.mjs',
);

function repository() {
  const work = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-platform-checks-'),
  );
  const root = path.join(work, 'repo');
  mkdirSync(root);
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Platform check fixture');
  git('config', 'user.email', 'platform-check@example.invalid');
  const write = (file, text = 'fixture\n') => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const commit = () => {
    git('add', '-A');
    git('commit', '--quiet', '-m', 'Change fixture inputs');
    return git('rev-parse', 'HEAD');
  };
  write('README.md');
  const base = commit();
  const run = (eventName, event, production = 'false') => {
    const eventFile = path.join(work, 'event.json');
    const output = path.join(work, 'output');
    writeFileSync(eventFile, JSON.stringify(event));
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [selector], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_OUTPUT: output,
        BROWSER_RECALL_CI_PRODUCTION: production,
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    return { ...result, output: readFileSync(output, 'utf8') };
  };
  return { work, root, git, write, commit, base, run };
}

test('platform selection reads real push ranges, dependency changes, deletions and renamed source paths', () => {
  const repo = repository();
  try {
    let before = repo.base;
    for (const [file, windows, macos] of [
      ['website/index.html', false, false],
      ['crates/daemon/src/runtime.rs', false, false],
      ['apps/extension/popup.html', true, false],
      ['scripts/documentation-tauri.conf.json', false, true],
      ['tests/fixtures/extension-rendering.mjs', true, false],
      ['apps/desktop/src-tauri/src/main.rs', false, true],
      ['package-lock.json', true, true],
      ['.github/workflows/desktop-release-validation.yml', true, true],
    ]) {
      repo.write(file);
      const after = repo.commit();
      const result = repo.run('push', { before, after });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout), file).toMatchObject({
        windows_extension: windows,
        macos_documentation: macos,
      });
      expect(result.output).toBe(
        `windows_extension=${windows}\nmacos_documentation=${macos}\n`,
      );
      before = after;
    }
    rmSync(path.join(repo.root, 'apps/extension/popup.html'));
    let after = repo.commit();
    expect(
      JSON.parse(repo.run('push', { before, after }).stdout),
    ).toMatchObject({ windows_extension: true, macos_documentation: false });
    before = after;
    renameSync(
      path.join(repo.root, 'scripts/documentation-tauri.conf.json'),
      path.join(repo.root, 'archived-config.json'),
    );
    after = repo.commit();
    expect(
      JSON.parse(repo.run('push', { before, after }).stdout),
    ).toMatchObject({ windows_extension: false, macos_documentation: true });
    expect(
      JSON.parse(repo.run('push', { before: repo.base, after }).stdout),
    ).toMatchObject({ windows_extension: true, macos_documentation: true });
  } finally {
    rmSync(repo.work, { recursive: true, force: true });
  }
});

test('pull request selection includes every branch commit and excludes changes made only on the base branch', () => {
  const repo = repository();
  try {
    repo.git('checkout', '--quiet', '-b', 'feature');
    repo.write('apps/extension/popup.html');
    repo.commit();
    repo.write('README.md', 'Unrelated follow-up\n');
    const head = repo.commit();
    repo.git('checkout', '--quiet', '-b', 'base-update', repo.base);
    repo.write('apps/desktop/src-tauri/tauri.conf.json');
    const base = repo.commit();
    repo.git('checkout', '--quiet', 'feature');
    const result = repo.run('pull_request', {
      pull_request: { base: { sha: base }, head: { sha: head } },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      windows_extension: true,
      macos_documentation: false,
    });
  } finally {
    rmSync(repo.work, { recursive: true, force: true });
  }
});

test('manual and release validation always run both checks; malformed events fail instead of skipping', () => {
  const repo = repository();
  try {
    for (const [eventName, event, production] of [
      ['workflow_dispatch', {}, 'false'],
      ['push', { before: repo.base, after: repo.base }, 'true'],
      ['push', { before: '0'.repeat(40), after: repo.base }, 'false'],
      ['push', { before: '1'.repeat(40), after: repo.base }, 'false'],
    ]) {
      const result = repo.run(eventName, event, production);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        windows_extension: true,
        macos_documentation: true,
      });
    }
    for (const [eventName, event, production] of [
      ['push', { after: repo.base }, 'false'],
      ['pull_request', { pull_request: { base: { sha: repo.base } } }, 'false'],
      ['push', { before: repo.base, after: repo.base }, 'unknown'],
      ['schedule', {}, 'false'],
    ]) {
      const result = repo.run(eventName, event, production);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /Missing or invalid|must be true or false|Unsupported GitHub event/,
      );
      expect(result.output).toBe('');
    }
  } finally {
    rmSync(repo.work, { recursive: true, force: true });
  }
});
