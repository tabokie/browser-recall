import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  createBoundedResponseGlobalScript,
  readBoundedResponse,
} from '../../packages/core/bounded-response.js';

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
