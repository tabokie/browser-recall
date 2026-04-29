import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const bgSource = readFileSync(
  resolve(process.cwd(), 'apps', 'extension', 'background.js'),
  'utf8',
);

describe('log timestamp watermark invariants', () => {
  it('allocates timestamps above the persisted desktop drain watermark', () => {
    const nextTimestamp = bgSource.match(
      /async function nextLogTimestamp\(\) \{[\s\S]*?\n\}/,
    );
    expect(nextTimestamp).not.toBeNull();
    expect(nextTimestamp[0]).toContain('await ensureLogBuffer()');
    expect(nextTimestamp[0]).toContain('logBufferWatermark');
  });

  it('keeps separately mirrored payloads out of the pruneable log buffer', () => {
    expect(bgSource).not.toContain('skipDesktopMirror');

    const captureAndLog = bgSource.match(
      /async function captureAndLog[\s\S]*?^}/m,
    );
    expect(captureAndLog).not.toBeNull();
    expect(captureAndLog[0]).toContain('await mirrorSnapshotToDesktop');
    expect(captureAndLog[0]).not.toContain('addLog');

    const createNote = bgSource.match(
      /async function handleCreateNote[\s\S]*?^}/m,
    );
    expect(createNote).not.toBeNull();
    expect(createNote[0]).toContain('await mirrorNoteToDesktop');
    expect(createNote[0]).not.toContain('addLog');
  });
});
