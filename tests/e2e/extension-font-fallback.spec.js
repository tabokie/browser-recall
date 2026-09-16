import { expect, test } from './fixtures.js';
import { openHelperPage } from './helpers.js';

const CJK_SAMPLE = '浏览记录';

async function platformFontsForProbe(context, page, probeId) {
  const session = await context.newCDPSession(page);
  let objectId;
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    await session.send('DOM.getDocument', {
      depth: -1,
      pierce: true,
    });
    const { result } = await session.send('Runtime.evaluate', {
      expression: `((probeId) => {
        const pending = [document];
        while (pending.length > 0) {
          const root = pending.shift();
          const match = root.querySelector?.('[data-font-probe="' + probeId + '"]');
          if (match) return match;
          for (const element of root.querySelectorAll?.('*') || []) {
            if (element.shadowRoot) pending.push(element.shadowRoot);
          }
        }
        return null;
      })(${JSON.stringify(probeId)})`,
    });
    objectId = result.objectId;
    expect(objectId, `runtime node for font probe ${probeId}`).toBeTruthy();
    const { nodeId } = await session.send('DOM.requestNode', { objectId });
    expect(nodeId, `CDP node for font probe ${probeId}`).toBeGreaterThan(0);
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', {
      nodeId,
    });
    return fonts.filter((font) => font.glyphCount > 0);
  } finally {
    if (objectId) {
      await session.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
    await session.detach();
  }
}

function renderedGlyphCount(fonts) {
  return fonts.reduce((count, font) => count + font.glyphCount, 0);
}

function renderedFamilies(fonts) {
  return fonts.map((font) => font.familyName);
}

test('extension CJK text uses the host system UI font fallback', async ({
  extContext,
  extensionId,
  setupDir,
}) => {
  void setupDir;
  const popup = await extContext.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: 'domcontentloaded',
  });
  await popup.evaluate(async (sample) => {
    for (const [probe, fontFamily] of [
      ['popup-configured', 'var(--font-body)'],
      ['popup-system', 'system-ui'],
    ]) {
      const node = document.createElement('span');
      node.dataset.fontProbe = probe;
      node.style.fontFamily = fontFamily;
      node.textContent = sample;
      document.body.append(node);
    }
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    for (const node of document.querySelectorAll('[data-font-probe]')) {
      node.getBoundingClientRect();
    }
  }, CJK_SAMPLE);
  // Glyph counts include missing-glyph boxes. Require actual distinct CJK
  // glyphs before comparing which platform font supplied them.
  const distinctSystemGlyphs = await popup.evaluate((sample) => {
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    context.font = '24px system-ui';
    return new Set(
      [...sample].map((glyph) => {
        context.clearRect(0, 0, 48, 48);
        context.fillText(glyph, 0, 32);
        return canvas.toDataURL();
      }),
    ).size;
  }, CJK_SAMPLE);
  expect(
    distinctSystemGlyphs,
    'CJK system glyphs are missing; run npm run ci:install-playwright to install browser system dependencies',
  ).toBe(CJK_SAMPLE.length);
  const popupConfigured = await platformFontsForProbe(
    extContext,
    popup,
    'popup-configured',
  );
  const popupSystem = await platformFontsForProbe(
    extContext,
    popup,
    'popup-system',
  );
  await popup.close();

  expect(renderedGlyphCount(popupSystem)).toBe(CJK_SAMPLE.length);
  expect(renderedGlyphCount(popupConfigured)).toBe(CJK_SAMPLE.length);
  expect(renderedFamilies(popupConfigured)).toEqual(
    renderedFamilies(popupSystem),
  );
  expect(popupConfigured.every((font) => font.isCustomFont === false)).toBe(
    true,
  );

  const helper = await openHelperPage(extContext, extensionId);
  await helper.evaluate(async (sample) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('extension-surface.js');
    await new Promise((resolve, reject) => {
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', reject, { once: true });
      document.head.append(script);
    });

    const shadowHost = document.createElement('div');
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${globalThis.browserRecallExtensionSurface.shadowCss}</style>
      <span data-font-probe="shadow-configured" style="font-family: var(--br-font-body)">${sample}</span>
      <span data-font-probe="shadow-system" style="font-family: system-ui">${sample}</span>
    `;
    document.body.append(shadowHost);
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    for (const node of shadow.querySelectorAll('[data-font-probe]')) {
      node.getBoundingClientRect();
    }
  }, CJK_SAMPLE);
  const shadowConfigured = await platformFontsForProbe(
    extContext,
    helper,
    'shadow-configured',
  );
  const shadowSystem = await platformFontsForProbe(
    extContext,
    helper,
    'shadow-system',
  );
  await helper.close();

  expect(renderedGlyphCount(shadowConfigured)).toBe(CJK_SAMPLE.length);
  expect(renderedFamilies(shadowConfigured)).toEqual(
    renderedFamilies(shadowSystem),
  );
  expect(shadowConfigured.every((font) => font.isCustomFont === false)).toBe(
    true,
  );
});
