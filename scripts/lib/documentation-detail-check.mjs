import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertCaptureInputs } from './documentation-freshness.mjs';
import { detailMediaNames } from './documentation-detail-media.mjs';

function gifInfo(bytes) {
  if (!['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)))
    throw new Error('Invalid GIF header');
  const width = bytes.readUInt16LE(6),
    height = bytes.readUInt16LE(8);
  let cursor = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
  let frames = 0,
    loop = null,
    duration = 0;
  function blocks() {
    const result = [];
    while (cursor < bytes.length) {
      const size = bytes[cursor++];
      if (!size) return result;
      if (cursor + size > bytes.length) throw new Error('Truncated GIF block');
      result.push(bytes.subarray(cursor, cursor + size));
      cursor += size;
    }
    throw new Error('Unterminated GIF block');
  }
  while (cursor < bytes.length) {
    const type = bytes[cursor++];
    if (type === 0x3b) {
      if (cursor !== bytes.length)
        throw new Error('Unexpected data after GIF trailer');
      return { width, height, frames, loop, duration };
    }
    if (type === 0x21) {
      const extension = bytes[cursor++];
      const data = blocks();
      if (extension === 0xf9) {
        if (data.length !== 1 || data[0].length !== 4)
          throw new Error('Invalid GIF timing');
        duration += data[0].readUInt16LE(1) / 100;
      }
      if (extension === 0xff && data[0]?.toString('ascii') === 'NETSCAPE2.0') {
        if (data[1]?.length !== 3 || data[1][0] !== 1)
          throw new Error('Invalid GIF loop block');
        loop = data[1].readUInt16LE(1);
      }
    } else if (type === 0x2c) {
      if (cursor + 9 > bytes.length) throw new Error('Truncated GIF frame');
      const packed = bytes[cursor + 8];
      cursor += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      cursor++; // LZW minimum code size.
      blocks();
      frames++;
    } else throw new Error('Invalid GIF block');
  }
  throw new Error('Missing GIF trailer');
}

export function checkDetailMedia(root, imagesOnly) {
  const available = [];
  for (const [kind, names] of Object.entries(detailMediaNames)) {
    const folder = path.join(root, 'docs/images/details');
    const manifest = JSON.parse(
      readFileSync(path.join(folder, `${kind}-capture.json`)),
    );
    if (!imagesOnly) assertCaptureInputs(root, kind, manifest.inputs);
    const expected = names
      .flatMap((name) => [`${name}.gif`, `${name}.png`])
      .sort();
    if (
      JSON.stringify(Object.keys(manifest.media).sort()) !==
      JSON.stringify(expected)
    )
      throw new Error(`${kind} detail media inventory changed`);
    for (const name of expected) {
      const bytes = readFileSync(path.join(folder, name));
      const recorded = manifest.media[name];
      if (createHash('sha256').update(bytes).digest('hex') !== recorded.sha256)
        throw new Error(
          `Detail media does not match capture manifest: ${name}`,
        );
      const info = name.endsWith('.gif')
        ? gifInfo(bytes)
        : {
            width: bytes.readUInt32BE(16),
            height: bytes.readUInt32BE(20),
          };
      if (
        !name.endsWith('.gif') &&
        !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      )
        throw new Error(`Invalid PNG: ${name}`);
      if (
        info.width !== 720 ||
        info.height !== 440 ||
        recorded.width !== 720 ||
        recorded.height !== 440
      )
        throw new Error(`Detail media must be 720 × 440 pixels: ${name}`);
      if (name.endsWith('.gif')) {
        const interaction = recorded.interaction;
        if (
          interaction?.cursorFrames !== info.frames ||
          !Number.isInteger(interaction.clicks) ||
          interaction.clicks < 2 ||
          !Number.isFinite(interaction.detailWidth) ||
          !Number.isFinite(interaction.endingWidth) ||
          !(interaction.endingWidth > interaction.detailWidth * 1.5)
        )
          throw new Error(
            `Detail GIF must show clicks, a cursor, and an ending zoom out: ${name}`,
          );
        if (info.loop !== 0 || recorded.loop !== 0)
          throw new Error(`Detail GIF must loop forever: ${name}`);
        if (
          info.frames < 2 ||
          info.frames !== recorded.frames ||
          !Number.isFinite(recorded.duration) ||
          Math.abs(info.duration - recorded.duration) > 0.011
        )
          throw new Error(`Detail GIF frames or timing changed: ${name}`);
        available.push(`docs/images/details/${name}`);
      }
    }
  }
  return available;
}
