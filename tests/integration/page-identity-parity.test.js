import { spawn } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  canonicalizePageUrl,
  generateSlugFromUrl,
} from '../../packages/core/page-identity.js';

const PROPERTY_SEED = 0x48789428;
const HELPER_PATH = path.resolve('target/debug/examples/page-identity');

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          Buffer.concat(stderr).toString() || `${command} exited ${code}`,
        ),
      );
    });
  });
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

function propertyUrls(count) {
  const random = seededRandom(PROPERTY_SEED);
  const hosts = [
    'example.com',
    'www.example.com',
    'NEWS.YCOMBINATOR.COM',
    '例え.jp',
    'sub-domain.example.co.uk',
  ];
  const segments = [
    '',
    'item',
    'a-b_c',
    '%E9%A1%B5%E9%9D%A2',
    'with%20space',
    '1234567890',
  ];
  const urls = [
    'https://news.ycombinator.com/item?id=48789428',
    'https://example.com/page?article=1&_trace=old#section',
    'https://例え.jp/ページ?q=値',
    'https://user:pass@example.com:8443/a?x=1&x=2',
    'http://[2001:db8::1]:8080/a/../b?encoded=%2F&space=+',
    'https://example.com/%7Euser?q=%25value#fragment',
    'https://example.com/item?id=1&id=2&_ignored=3',
  ];
  while (urls.length < count) {
    const path = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
      pick(random, segments),
    ).join('/');
    const ordinaryQuery = `id=${Math.floor(random() * 1_000_000)}&q=${pick(random, ['alpha', 'two%20words', '%E5%80%A4'])}`;
    const trackingQuery =
      random() < 0.5
        ? `&_trace=${Math.floor(random() * 1000)}&_i=${Math.floor(random() * 1000)}`
        : '';
    const fragment =
      random() < 0.5 ? `#comment-${Math.floor(random() * 1_000_000)}` : '';
    urls.push(
      `${pick(random, ['http', 'https'])}://${pick(random, hosts)}/${path}?${ordinaryQuery}${trackingQuery}${fragment}`,
    );
  }
  return urls;
}

function rustSlugs(urls) {
  return new Promise((resolve, reject) => {
    const child = spawn(HELPER_PATH, [], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(Buffer.concat(stderr).toString() || `cargo exited ${code}`),
        );
        return;
      }
      resolve(JSON.parse(Buffer.concat(stdout).toString()));
    });
    child.stdin.end(JSON.stringify(urls));
  });
}

describe('page identity parity', () => {
  beforeAll(
    () =>
      runProcess('cargo', [
        'build',
        '-q',
        '-p',
        'browser-recall-replay',
        '--example',
        'page-identity',
      ]),
    300_000,
  );

  it('keeps JavaScript canonical identity equal to Rust replay identity', async () => {
    const rawUrls = propertyUrls(1000);
    const canonicalUrls = rawUrls.map(canonicalizePageUrl);
    const expected = rawUrls.map(generateSlugFromUrl);
    const actual = await rustSlugs(canonicalUrls);
    const mismatchIndex = expected.findIndex(
      (slug, index) => actual[index] !== slug,
    );
    expect(
      mismatchIndex,
      mismatchIndex < 0
        ? undefined
        : `seed=${PROPERTY_SEED} index=${mismatchIndex} raw=${rawUrls[mismatchIndex]} canonical=${canonicalUrls[mismatchIndex]} js=${expected[mismatchIndex]} rust=${actual[mismatchIndex]}`,
    ).toBe(-1);
  });
});
