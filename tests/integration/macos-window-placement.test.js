import { expect, test } from 'vitest';
import { lifecycleWindowFrame } from '../smoke/macos-window-placement.mjs';

const minimumSize = { width: 880, height: 620 };

test.each([
  { x: 0, y: 31, width: 1024, height: 680 },
  { x: 0, y: 31, width: 1440, height: 680 },
  { x: 0, y: 31, width: 1440, height: 820 },
  { x: 80, y: 31, width: 944, height: 680 },
])('lifecycle baseline fits the usable display area %j', (workArea) => {
  const frame = lifecycleWindowFrame(workArea, minimumSize);
  expect(frame.width).toBeGreaterThanOrEqual(minimumSize.width);
  expect(frame.height).toBeGreaterThanOrEqual(minimumSize.height);
  expect(frame.x).toBeGreaterThanOrEqual(workArea.x);
  expect(frame.y).toBeGreaterThanOrEqual(workArea.y);
  expect(frame.x + frame.width).toBeLessThanOrEqual(
    workArea.x + workArea.width,
  );
  expect(frame.y + frame.height).toBeLessThanOrEqual(
    workArea.y + workArea.height,
  );
});

test('lifecycle baseline rejects displays smaller than the configured minimum', () => {
  expect(() =>
    lifecycleWindowFrame({ x: 0, y: 31, width: 800, height: 600 }, minimumSize),
  ).toThrow('usable display area');
});
