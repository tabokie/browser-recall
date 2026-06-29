import { test, expect } from './fixtures.js';
import {
  getExtensionMessage,
  getSlugForUrl,
  pageCheckpointPath,
  resetAndSeed,
} from './helpers.js';
import crypto from 'crypto';

function snapshotSidecarPath(slug, timestamp, ext) {
  const stem = `${slug}-${timestamp}`;
  const shard = crypto
    .createHash('sha256')
    .update(stem)
    .digest()
    .subarray(0, 1)
    .toString('hex');
  return `objects/snapshots/${shard}/${stem}.${ext}`;
}

async function openPopupForUrl(extContext, extensionId, { url, title }) {
  const popup = await extContext.newPage();
  await popup.addInitScript(
    ({ url, title }) => {
      const patchTabsQuery = () => {
        if (!globalThis.chrome?.tabs?.query) {
          setTimeout(patchTabsQuery, 0);
          return;
        }
        const originalQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (queryInfo) => {
          if (queryInfo?.active && queryInfo?.currentWindow) {
            return [{ id: 10001, url, title }];
          }
          return originalQuery(queryInfo);
        };
      };
      patchTabsQuery();
    },
    { url, title },
  );
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#dashboard')).toBeVisible();
  return popup;
}

test.describe('extension error popouts', () => {
  test('popup fallback error bubble uses the paper surface', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    localServer.addPage('/popup-error-paper', {
      title: 'Popup Error Paper',
      body: '<main>Popup error paper page</main>',
    });
    const url = localServer.url('/popup-error-paper');
    const slug = getSlugForUrl(url);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup Error Paper',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup Error Paper',
    });
    await popup.evaluate(() => {
      const originalSendMessage = chrome.runtime.sendMessage.bind(
        chrome.runtime,
      );
      chrome.runtime.sendMessage = async (request, ...rest) => {
        if (request?.action === 'captureCurrentPageFromPopup') {
          return { success: false, error: 'Paper popout failure' };
        }
        return originalSendMessage(request, ...rest);
      };
      chrome.tabs.sendMessage = async () => {
        throw new Error('Receiving end does not exist.');
      };
    });

    await popup.locator('#captureBtn').click();
    const bubble = popup.locator('#errorBubble');
    await expect(bubble).toContainText('Paper popout failure');
    await expect(bubble).toHaveCSS('background-color', 'rgb(247, 244, 234)');
    await expect(bubble).toHaveCSS('color', 'rgb(255, 45, 32)');

    await popup.close();
  });

  test('snapshot runtime error banner uses the paper surface', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    void setupDir;
    const originalUrl = 'https://example.com/snapshot-error-paper';
    const slug = getSlugForUrl(originalUrl);
    const timestamp = Date.now();
    const noteSlug = 'snapshot-error-paper-note';
    const highlightText = 'snapshot paper error highlight';

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: originalUrl,
          title: 'Snapshot Error Paper',
          parentIds: [],
          childIds: [`note:${noteSlug}`, `snapshot:${slug}-${timestamp}`],
          timestamps: { 'test-device': timestamp },
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: [highlightText],
          note: 'snapshot note',
          cssPath: ['body > p'],
          url: originalUrl,
        },
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: `<!doctype html><html><head><title>Snapshot Error Paper</title></head><body><p>A saved page with ${highlightText} inside.</p></body></html>`,
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'md'),
        content: `A saved page with ${highlightText} inside.`,
      },
    ]);

    const viewer = await extContext.newPage();
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(slug)}&ts=${timestamp}`,
    );
    await expect(viewer.locator('iframe')).toBeVisible();
    const frame = viewer.frameLocator('iframe');
    await expect(frame.locator('mark')).toHaveText(highlightText);

    await viewer.evaluate(() => {
      chrome.runtime.sendMessage = async () => {
        throw new Error('Extension context invalidated.');
      };
    });
    await frame.locator('mark').click();

    const banner = viewer.locator('#snapshotRuntimeError');
    await expect(banner).toHaveText(
      await getExtensionMessage(viewer, 'extensionReloaded'),
    );
    await expect(banner).toHaveCSS('background-color', 'rgb(247, 244, 234)');
    await expect(banner).toHaveCSS('color', 'rgb(255, 45, 32)');

    await viewer.close();
  });
});
