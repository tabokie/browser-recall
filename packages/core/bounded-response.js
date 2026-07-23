export async function readBoundedResponse(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('Response byte limit must be a positive safe integer');
  }
  if (
    !response?.headers ||
    typeof response.headers.get !== 'function' ||
    !response.body ||
    typeof response.body.getReader !== 'function'
  ) {
    throw new TypeError('Response body is not a readable byte stream');
  }

  const declaredLength = response.headers.get('Content-Length');
  let declaredBytes = null;
  if (declaredLength !== null && declaredLength !== '') {
    declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new TypeError(
        'Response Content-Length must be a non-negative integer',
      );
    }
  }

  const reader = response.body.getReader();
  try {
    if (declaredBytes !== null && declaredBytes > maxBytes) {
      await reader.cancel();
      return { status: 'maxsize', content: null, bytesRead: 0 };
    }

    const contentParts = [];
    const codeUnitBatchSize = 0x8000;
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('Response stream produced a non-byte chunk');
      }
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return { status: 'maxsize', content: null, bytesRead };
      }
      for (
        let offset = 0;
        offset < value.byteLength;
        offset += codeUnitBatchSize
      ) {
        contentParts.push(
          String.fromCharCode(
            ...value.subarray(offset, offset + codeUnitBatchSize),
          ),
        );
      }
    }
    return {
      status: 'success',
      content: contentParts.join(''),
      bytesRead,
    };
  } finally {
    reader.releaseLock();
  }
}

export function createBoundedResponseGlobalScript() {
  return `(() => {
  "use strict";
  const readBoundedResponse = ${readBoundedResponse.toString()};
  globalThis.browserRecallBoundedResponse = Object.freeze({
    readBoundedResponse,
  });
})();
`;
}
