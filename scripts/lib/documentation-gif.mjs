import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Read ImageIO GIFs and edit frame timing without decoding or recompressing pixels.
export function readGif(bytes) {
  if (!['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)))
    throw new Error('Invalid GIF header');
  const width = bytes.readUInt16LE(6),
    height = bytes.readUInt16LE(8);
  let cursor = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
  const header = bytes.subarray(0, cursor),
    extensions = [],
    frames = [];
  let loop = null,
    control;
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
    const start = cursor,
      type = bytes[cursor++];
    if (type === 0x3b) {
      if (cursor !== bytes.length || control)
        throw new Error('Invalid GIF trailer');
      return {
        width,
        height,
        loop,
        header,
        extensions,
        frames,
        duration: frames.reduce((sum, frame) => sum + frame.delay, 0),
      };
    }
    if (type === 0x21) {
      const extension = bytes[cursor++],
        data = blocks();
      const raw = bytes.subarray(start, cursor);
      if (extension === 0xf9) {
        if (control || data.length !== 1 || data[0].length !== 4)
          throw new Error('Invalid GIF timing');
        control = raw;
      } else {
        if (extension === 0x01)
          throw new Error('GIF text frames are unsupported');
        if (
          extension === 0xff &&
          data[0]?.toString('ascii') === 'NETSCAPE2.0'
        ) {
          if (data[1]?.length !== 3 || data[1][0] !== 1)
            throw new Error('Invalid GIF loop block');
          loop = data[1].readUInt16LE(1);
        }
        extensions.push(raw);
      }
    } else if (type === 0x2c) {
      if (cursor + 9 > bytes.length || !control)
        throw new Error('Invalid GIF frame');
      const packed = bytes[cursor + 8];
      cursor += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      cursor++; // LZW minimum code size.
      blocks();
      frames.push({
        control,
        image: bytes.subarray(start, cursor),
        delay: control.readUInt16LE(4) / 100,
      });
      control = undefined;
    } else throw new Error('Invalid GIF block');
  }
  throw new Error('Missing GIF trailer');
}

export function editGif(
  bytes,
  { endFrame, lastFrameSeconds, frameSeconds = {} },
) {
  const source = readGif(bytes);
  const last = endFrame ?? source.frames.length - 1;
  if (!Number.isInteger(last) || last < 1 || last >= source.frames.length)
    throw new Error('GIF endFrame is outside the saved capture');
  const delay = Math.round(lastFrameSeconds * 100);
  if (!Number.isFinite(delay) || delay < 4 || delay > 65535)
    throw new Error('GIF lastFrameSeconds must be between 0.04 and 655.35');
  const frames = source.frames.slice(0, last + 1);
  for (const [index, seconds] of Object.entries(frameSeconds)) {
    const position = Number(index),
      delay = Math.round(seconds * 100);
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position > last ||
      !Number.isFinite(delay) ||
      delay < 4 ||
      delay > 65535
    )
      throw new Error('Invalid GIF frameSeconds');
    const control = Buffer.from(frames[position].control);
    control.writeUInt16LE(delay, 4);
    frames[position] = { ...frames[position], control };
  }
  const control = Buffer.from(frames.at(-1).control);
  control.writeUInt16LE(delay, 4);
  frames[frames.length - 1] = { ...frames.at(-1), control };
  return Buffer.concat([
    source.header,
    ...source.extensions,
    ...frames.flatMap((frame) => [frame.control, frame.image]),
    Buffer.from([0x3b]),
  ]);
}

export function gifFraming(root, source, recipe) {
  const { marginPixels, windowRadiusPixels, scene } = recipe;
  if (
    marginPixels === undefined &&
    windowRadiusPixels === undefined &&
    scene === undefined
  )
    return null;
  if (
    !Number.isFinite(marginPixels) ||
    marginPixels < 0 ||
    marginPixels >= 200 ||
    !Number.isFinite(windowRadiusPixels) ||
    windowRadiusPixels < 0 ||
    windowRadiusPixels > 80
  )
    throw new Error('Invalid GIF margin or corner radius');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const frames = readGif(source).frames.length;
  if (
    !scene ||
    !Number.isFinite(scene.width) ||
    scene.width <= 0 ||
    !Number.isFinite(scene.height) ||
    scene.height <= 0 ||
    !Array.isArray(scene.poses) ||
    scene.poses.length < 2 ||
    scene.poses[0].frame !== 0 ||
    scene.poses.at(-1).frame !== frames - 1 ||
    scene.poses.some(
      ({ frame, crop }, index) =>
        !Number.isInteger(frame) ||
        frame < 0 ||
        frame >= frames ||
        (index > 0 && frame <= scene.poses[index - 1].frame) ||
        !crop ||
        !['x', 'y', 'width', 'height'].every((key) =>
          Number.isFinite(crop[key]),
        ) ||
        crop.x < 0 ||
        crop.y < 0 ||
        crop.width <= 0 ||
        crop.height <= 0 ||
        crop.x + crop.width > scene.width ||
        crop.y + crop.height > scene.height,
    ) ||
    !Array.isArray(scene.states) ||
    scene.states[0]?.frame !== 0 ||
    scene.states.some(
      ({ frame, overview, context }, index) =>
        !Number.isInteger(frame) ||
        frame < 0 ||
        frame >= frames ||
        (index > 0 && frame <= scene.states[index - 1].frame) ||
        (context !== undefined &&
          (!Array.isArray(context) ||
            context.some(
              (value) =>
                !Number.isInteger(value) || value < 0 || value >= frames,
            ))) ||
        !scene.poses.some(
          (pose) =>
            pose.frame === overview &&
            pose.crop.x === 0 &&
            pose.crop.y === 0 &&
            pose.crop.width === scene.width &&
            pose.crop.height === scene.height,
        ),
    )
  )
    throw new Error('Invalid saved GIF scene or camera poses');
  return {
    sourceSha256: hash(source),
    marginPixels,
    windowRadiusPixels,
    scene,
    inputs: Object.fromEntries(
      [
        'scripts/lib/documentation-gif-frame.swift',
        'scripts/assets/documentation-sonoma-light.png',
      ].map((name) => [name, hash(readFileSync(path.join(root, name)))]),
    ),
  };
}

export function readFramedGif(root, name, recorded, expected) {
  return readDerivedGif(root, `${name}-framed`, recorded, expected);
}

export function gifClickRipples(root, source, recipe) {
  if (!recipe.clickRipples && !recipe.zoom) return null;
  const info = readGif(source);
  const ripples = recipe.clickRipples ?? [];
  const zoom = recipe.zoom ?? null;
  if (
    zoom &&
    (!Number.isFinite(zoom.scale) ||
      zoom.scale < 1 ||
      zoom.scale > 2 ||
      !Number.isFinite(zoom.x) ||
      zoom.x < 0 ||
      zoom.x >= info.width ||
      !Number.isFinite(zoom.y) ||
      zoom.y < 0 ||
      zoom.y >= info.height ||
      !Number.isInteger(zoom.startFrame) ||
      zoom.startFrame < 0 ||
      !Number.isInteger(zoom.endFrame) ||
      zoom.endFrame <= zoom.startFrame ||
      zoom.endFrame >= info.frames.length)
  )
    throw new Error('Invalid GIF zoom');
  if (
    !Array.isArray(ripples) ||
    (!zoom && ripples.length === 0) ||
    ripples.some(
      ({ frame, x, y, phase }, index, all) =>
        !Number.isInteger(frame) ||
        frame < 0 ||
        frame >= info.frames.length ||
        all.findIndex((value) => value.frame === frame) !== index ||
        !Number.isFinite(x) ||
        x < 0 ||
        x >= info.width ||
        !Number.isFinite(y) ||
        y < 0 ||
        y >= info.height ||
        !Number.isFinite(phase) ||
        phase < 0 ||
        phase > 1,
    )
  )
    throw new Error('Invalid GIF click ripples');
  const tool = 'scripts/lib/documentation-gif-clicks.swift';
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  return {
    sourceSha256: hash(source),
    clickRipples: ripples,
    zoom,
    inputs: { [tool]: hash(readFileSync(path.join(root, tool))) },
  };
}

export function readDerivedGif(root, name, recorded, expected) {
  if (
    !recorded ||
    Object.entries(expected).some(
      ([key, value]) => JSON.stringify(recorded[key]) !== JSON.stringify(value),
    )
  )
    throw new Error(`GIF framing changed: ${name}`);
  const bytes = readFileSync(
    path.join(root, 'docs/images/details/sources', `${name}.gif`),
  );
  if (createHash('sha256').update(bytes).digest('hex') !== recorded.sha256)
    throw new Error(`Saved framed GIF changed: ${name}`);
  return bytes;
}
