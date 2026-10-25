import { chromium, test as base } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTestExtensionDir,
  cleanupTestExtensionDir,
} from './test-extension.mjs';
import { withCleanup } from '../smoke/desktop-test-cleanup.mjs';
import { extensionBrowserChannel } from './extension-browser-channel.mjs';

export const test = base.extend({
  renderingExtension: [
    async ({}, use) => {
      const channel = extensionBrowserChannel();
      const profile = mkdtempSync(
        path.join(tmpdir(), 'browser-recall-rendering-'),
      );
      // Reserve a rejecting connector endpoint so the extension cannot pair with
      // a personal daemon. Font rendering does not need daemon data or commands.
      const endpoint = net.createServer((socket) => socket.destroy());
      let extension;
      let context;
      await withCleanup(async () => {
        await new Promise((resolve, reject) => {
          endpoint.once('error', reject);
          endpoint.listen(0, '127.0.0.1', resolve);
        });
        extension = createTestExtensionDir(
          'browser-recall-rendering-extension-',
          [endpoint.address().port],
        );
        context = await chromium.launchPersistentContext(profile, {
          channel,
          headless: false,
          args: [
            '--headless=new',
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
          ],
        });
        const worker =
          context.serviceWorkers()[0] ||
          (await context.waitForEvent('serviceworker'));
        await use({ context, extensionId: new URL(worker.url()).host });
      }, [
        () => context?.close(),
        () =>
          endpoint.listening
            ? new Promise((resolve, reject) =>
                endpoint.close((error) => (error ? reject(error) : resolve())),
              )
            : undefined,
        () => cleanupTestExtensionDir(extension),
        () => rmSync(profile, { recursive: true, force: true }),
      ]);
    },
    { scope: 'worker' },
  ],
});
