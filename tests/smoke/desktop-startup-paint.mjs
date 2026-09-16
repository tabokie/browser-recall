import { setTimeout } from 'node:timers/promises';

class BlankWebviewError extends Error {}

function assertWebviewPainted(bitmap) {
  if (bitmap.length < 54 || bitmap.toString('ascii', 0, 2) !== 'BM') {
    throw new Error('Desktop screenshot is not a BMP image');
  }
  const pixelOffset = bitmap.readUInt32LE(10);
  const width = bitmap.readInt32LE(18);
  const signedHeight = bitmap.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const bits = bitmap.readUInt16LE(28);
  if (![24, 32].includes(bits) || width <= 0 || height <= 0) {
    throw new Error('Desktop screenshot is not a 24-bit or 32-bit bitmap');
  }
  const bytesPerPixel = bits / 8;
  const stride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  if (
    width <= 40 ||
    height <= 140 ||
    bitmap.length < pixelOffset + stride * height
  ) {
    throw new Error('Desktop screenshot has no complete webview sample region');
  }
  let paintedPixels = 0;
  let sampledPixels = 0;
  for (let y = 120; y < height - 20; y += 4) {
    const sourceY = signedHeight < 0 ? y : height - 1 - y;
    for (let x = 20; x < width - 20; x += 4) {
      const offset = pixelOffset + sourceY * stride + x * bytesPerPixel;
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const red = bitmap[offset + 2];
      sampledPixels += 1;
      if (red < 245 || green < 245 || blue < 245) paintedPixels += 1;
    }
  }
  if (paintedPixels / sampledPixels < 0.01) {
    throw new BlankWebviewError(
      `Desktop webview remained blank after startup (${paintedPixels}/${sampledPixels} sampled pixels painted)`,
    );
  }
}

export async function waitForWebviewPainted(
  capture,
  { timeoutMs = 15_000, pollIntervalMs = 100 } = {},
) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    // Capture/encoding errors are not evidence of a webview still loading.
    const bitmap = await capture();
    try {
      assertWebviewPainted(bitmap);
      return;
    } catch (error) {
      if (
        !(error instanceof BlankWebviewError) ||
        performance.now() >= deadline
      )
        throw error;
    }
    await setTimeout(
      Math.min(pollIntervalMs, Math.max(0, deadline - performance.now())),
    );
  }
}
