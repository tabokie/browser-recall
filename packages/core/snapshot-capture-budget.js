const textEncoder = new TextEncoder();

function requirePositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function jsonStringEncodedBytes(value) {
  if (typeof value !== 'string') {
    throw new TypeError('JSON string byte measurement requires a string');
  }
  return textEncoder.encode(JSON.stringify(value)).length - 2;
}

export function snapshotHtmlBudgetBytes({
  maxMessageBytes,
  payload,
  reserveBytes = 0,
}) {
  requirePositiveSafeInteger(maxMessageBytes, 'Maximum message bytes');
  requireNonNegativeSafeInteger(reserveBytes, 'Snapshot budget reserve bytes');
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof payload.html !== 'string'
  ) {
    throw new TypeError('Snapshot budget payload must contain an HTML string');
  }

  const envelopeBytes = textEncoder.encode(
    JSON.stringify({ ...payload, html: '' }),
  ).length;
  const available = maxMessageBytes - envelopeBytes - reserveBytes;
  if (available <= 0) {
    throw new RangeError(
      'Desktop message limit leaves no room for snapshot HTML',
    );
  }
  return available;
}

export function estimateEmbeddedResourceBytes({
  bytesRead,
  charset,
  referenceCount = 1,
}) {
  requireNonNegativeSafeInteger(bytesRead, 'Resource bytes read');
  requirePositiveSafeInteger(referenceCount, 'Resource reference count');
  if (typeof charset !== 'string') {
    throw new TypeError('Resource charset must be a string');
  }

  const encodedBytes =
    charset === '' ? 4 * Math.ceil(bytesRead / 3) : bytesRead * 3;
  return encodedBytes * referenceCount;
}

export function createSnapshotCaptureBudget({
  maxEncodedBytes,
  baseEncodedBytes = 0,
}) {
  requirePositiveSafeInteger(maxEncodedBytes, 'Maximum encoded snapshot bytes');
  requireNonNegativeSafeInteger(
    baseEncodedBytes,
    'Base encoded snapshot bytes',
  );

  let reservedBytes = Math.min(baseEncodedBytes, maxEncodedBytes);
  return Object.freeze({
    reserve(encodedBytes) {
      requireNonNegativeSafeInteger(
        encodedBytes,
        'Encoded resource reservation',
      );
      if (reservedBytes + encodedBytes > maxEncodedBytes) return false;
      reservedBytes += encodedBytes;
      return true;
    },
    remainingBytes() {
      return maxEncodedBytes - reservedBytes;
    },
    reservedBytes() {
      return reservedBytes;
    },
  });
}

export function createSnapshotCaptureBudgetGlobalScript() {
  return `(() => {
  "use strict";
  const textEncoder = new TextEncoder();
  const requirePositiveSafeInteger = ${requirePositiveSafeInteger.toString()};
  const requireNonNegativeSafeInteger = ${requireNonNegativeSafeInteger.toString()};
  const jsonStringEncodedBytes = ${jsonStringEncodedBytes.toString()};
  const estimateEmbeddedResourceBytes = ${estimateEmbeddedResourceBytes.toString()};
  const createSnapshotCaptureBudget = ${createSnapshotCaptureBudget.toString()};
  globalThis.browserRecallSnapshotCaptureBudget = Object.freeze({
    jsonStringEncodedBytes,
    estimateEmbeddedResourceBytes,
    createSnapshotCaptureBudget,
  });
})();
`;
}
