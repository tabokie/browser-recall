import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  createBoundedResponseGlobalScript,
  readBoundedResponse,
} from '../../packages/core/bounded-response.js';
import {
  createSnapshotCaptureBudget,
  estimateEmbeddedResourceBytes,
  snapshotHtmlBudgetBytes,
} from '../../packages/core/snapshot-capture-budget.js';

function chunkedResponse(chunks, headers = {}) {
  const cancel = vi.fn();
  let index = 0;
  return {
    cancel,
    response: {
      headers: new Headers(headers),
      body: {
        getReader() {
          return {
            async read() {
              const value = chunks[index++];
              return value
                ? { done: false, value: Uint8Array.from(value) }
                : { done: true, value: undefined };
            },
            cancel,
            releaseLock() {},
          };
        },
      },
    },
  };
}

describe('bounded snapshot resource reads', () => {
  it('derives the HTML budget from the exact daemon message envelope', () => {
    const payload = {
      type: 'snapshot',
      source: 'extension',
      slug: 'page',
      ts: 123,
      url: 'https://example.test/',
      title: 'Example',
      markdown: 'Markdown',
      html: '',
      bufferDepth: 0,
      bufferBytes: 0,
    };
    const maxMessageBytes = 1024;
    const budget = snapshotHtmlBudgetBytes({ maxMessageBytes, payload });
    const encoded = new TextEncoder().encode(
      JSON.stringify({ ...payload, html: 'x'.repeat(budget) }),
    ).length;

    expect(encoded).toBe(maxMessageBytes);
  });

  it('accounts for base64 expansion and rejects aggregate over-budget resources', () => {
    const budget = createSnapshotCaptureBudget({
      maxEncodedBytes: 12,
      baseEncodedBytes: 2,
    });
    const first = estimateEmbeddedResourceBytes({
      bytesRead: 3,
      charset: '',
      referenceCount: 2,
    });

    expect(first).toBe(8);
    expect(budget.reserve(first)).toBe(true);
    expect(budget.reserve(1)).toBe(true);
    expect(budget.reserve(2)).toBe(false);
    expect(budget.remainingBytes()).toBe(1);
  });

  it('stops a chunked response when its body exceeds the declared resource limit', async () => {
    const { response, cancel } = chunkedResponse([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);

    await expect(readBoundedResponse(response, 5)).resolves.toEqual({
      status: 'maxsize',
      content: null,
      bytesRead: 6,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    const { response, cancel } = chunkedResponse([[1]], {
      'Content-Length': '6',
    });

    await expect(readBoundedResponse(response, 5)).resolves.toEqual({
      status: 'maxsize',
      content: null,
      bytesRead: 0,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns an exact-limit body through both module and classic-script interfaces', async () => {
    const moduleResponse = chunkedResponse([
      [65, 66],
      [67, 68, 69],
    ]).response;
    await expect(readBoundedResponse(moduleResponse, 5)).resolves.toEqual({
      status: 'success',
      content: 'ABCDE',
      bytesRead: 5,
    });

    const context = { Headers, Uint8Array };
    vm.runInNewContext(createBoundedResponseGlobalScript(), context);
    const classicResponse = chunkedResponse([[65, 66, 67]]).response;
    await expect(
      context.browserRecallBoundedResponse.readBoundedResponse(
        classicResponse,
        3,
      ),
    ).resolves.toEqual({
      status: 'success',
      content: 'ABC',
      bytesRead: 3,
    });
  });
});
