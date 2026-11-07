import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const detailMediaNames = {
  desktop: ['bookmark-import', 'page-copy-paste'],
  browser: ['recording-pause'],
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function nativeDetailCrop(rect, padding = 40) {
  return Object.fromEntries(
    Object.entries(rect).map(([key, value]) => [
      key,
      Math.round((value + (['x', 'y'].includes(key) ? padding : 0)) * 2),
    ]),
  );
}

// Camera rectangles and pointer positions use the captured native pixel space.
// Only the camera and pointer are interpolated; application states are real captures.
export function detailTimeline(initial) {
  const frames = [];
  let current = initial;
  function hold(frame = current, delay = 0.7) {
    current = { ...frame };
    frames.push({ ...current, delay });
  }
  function transition(target, steps = 8) {
    const from = current;
    for (let index = 1; index <= steps; index++) {
      const progress = index / steps;
      const eased = progress * progress * (3 - 2 * progress);
      const next = { ...from, ...target };
      for (const key of ['crop', 'cursor']) {
        if (!target[key] || !from[key]) continue;
        next[key] = Object.fromEntries(
          Object.keys(target[key]).map((axis) => [
            axis,
            from[key][axis] + (target[key][axis] - from[key][axis]) * eased,
          ]),
        );
      }
      hold(next, 0.08);
    }
  }
  function click(frame) {
    for (const phase of [0, 0.45, 0.9]) hold({ ...frame, click: phase }, 0.1);
    hold({ ...frame, click: undefined }, 0.7);
  }
  return { frames, hold, transition, click, current: () => current };
}

export async function encodeDetailMedia({ kind, work, inputs, clips }) {
  const output = path.join(work, 'details');
  mkdirSync(output, { recursive: true });
  const encoder = path.join(work, 'documentation-detail-media');
  execFileSync(
    '/usr/bin/swiftc',
    [
      '-module-cache-path',
      path.join(work, 'swift-module-cache'),
      path.join(root, 'scripts/lib/documentation-detail-media.swift'),
      '-o',
      encoder,
    ],
    { timeout: 60000 },
  );
  const media = {};
  for (const name of detailMediaNames[kind]) {
    const frames = clips[name];
    if (!frames) throw new Error(`Missing detail clip: ${name}`);
    const job = {
      output: path.join(output, `${name}.gif`),
      poster: path.join(output, `${name}.png`),
      posterFrame:
        frames.findIndex((frame) => frame.poster) >= 0
          ? frames.findIndex((frame) => frame.poster)
          : frames.length - 1,
      frames,
    };
    const jobPath = path.join(work, `${name}.json`);
    writeFileSync(jobPath, JSON.stringify(job));
    execFileSync(encoder, [jobPath], { timeout: 30000 });
    for (const extension of ['gif', 'png']) {
      const filename = `${name}.${extension}`;
      media[filename] = {
        sha256: hash(readFileSync(path.join(output, filename))),
        width: 720,
        height: 440,
        ...(extension === 'gif'
          ? {
              frames: frames.length,
              loop: 0,
              duration: frames.reduce((sum, frame) => sum + frame.delay, 0),
              interaction: {
                cursorFrames: frames.filter((frame) => frame.cursor).length,
                clicks: frames.filter((frame) => frame.click === 0).length,
                detailWidth: Math.min(
                  ...frames.map((frame) => frame.crop.width),
                ),
                endingWidth: frames.at(-1).crop.width,
              },
            }
          : {}),
      };
    }
  }
  const manifest = `${kind}-capture.json`;
  writeFileSync(
    path.join(output, manifest),
    await format(
      JSON.stringify({
        command:
          kind === 'desktop'
            ? 'npm run docs:screenshots'
            : 'npm run docs:screenshots:browser',
        inputs,
        media,
      }),
      { parser: 'json' },
    ),
  );
  return { directory: output, files: [...Object.keys(media), manifest] };
}
