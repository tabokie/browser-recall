import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { unregisterMacosTestApp } from '../smoke/macos-desktop-process.mjs';
import { withCleanup } from '../smoke/desktop-test-cleanup.mjs';

test.skipIf(process.platform !== 'darwin')(
  'documentation setup failure before copying the app preserves its error and removes temporary files',
  async () => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-url-routing-'),
    );
    const app = path.join(work, 'Browser Recall URL Test.app');
    const original = new Error('Documentation build failed');
    try {
      const error = await withCleanup(async () => {
        throw original;
      }, [
        () => unregisterMacosTestApp(app),
        () => rmSync(work, { recursive: true, force: true }),
      ]).catch((error) => error);
      expect(error).toBe(original);
      expect(existsSync(work)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'documentation teardown reports an invalid app without replacing the original failure or skipping deletion',
  async () => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-url-routing-'),
    );
    const app = path.join(work, 'Browser Recall URL Test.app');
    mkdirSync(app);
    const original = new Error('Documentation app verification failed');
    try {
      const error = await withCleanup(async () => {
        throw original;
      }, [
        () => unregisterMacosTestApp(app),
        () => rmSync(work, { recursive: true, force: true }),
      ]).catch((error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.cause).toBe(original);
      expect(error.errors[0]).toBe(original);
      expect(error.errors).toHaveLength(2);
      expect(error.errors[1].stderr).toContain('failed to scan');
      expect(existsSync(work)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
