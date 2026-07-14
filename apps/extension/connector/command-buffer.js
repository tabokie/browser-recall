const BUFFER_STORAGE_KEYS = {
  queue: 'desktopCommandBuffer',
  pendingCommands: 'desktopPendingCommands',
  pendingBytes: 'desktopPendingBytes',
  refuseMode: 'desktopRefuseMode',
};

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

let loaded = false;
let queue = [];
let refuseMode = false;
let storageOperation = Promise.resolve();

function itemSize(item) {
  return encoder.encode(JSON.stringify(item)).length;
}

export function bufferedMessageSize(message) {
  return itemSize(message);
}

function queueSize(items = queue) {
  return items.reduce((total, item) => total + itemSize(item), 0);
}

async function ensureLoaded() {
  if (loaded) return;
  const stored = await chrome.storage.local.get(
    Object.values(BUFFER_STORAGE_KEYS),
  );
  const storedQueue = stored[BUFFER_STORAGE_KEYS.queue];
  if (storedQueue !== undefined && !Array.isArray(storedQueue)) {
    throw new Error('Persisted desktop command buffer must be an array');
  }
  const storedRefuseMode = stored[BUFFER_STORAGE_KEYS.refuseMode];
  if (storedRefuseMode !== undefined && typeof storedRefuseMode !== 'boolean') {
    throw new Error('Persisted desktop refuse mode must be a boolean');
  }
  queue = storedQueue === undefined ? [] : storedQueue;
  refuseMode = storedRefuseMode === undefined ? false : storedRefuseMode;
  await persist();
  loaded = true;
}

async function withStorageOperation(fn) {
  const run = storageOperation.then(fn, fn);
  // The tail exists only to serialize later operations. Each operation caller
  // still receives `run` and therefore observes its own persistence failure.
  storageOperation = run.catch(() => {});
  return run;
}

function currentStats() {
  return {
    pendingCommands: queue.length,
    pendingBytes: queueSize(),
    refuseMode,
  };
}

async function persist() {
  const pendingBytes = queueSize();
  if (pendingBytes < MAX_BUFFER_BYTES) {
    refuseMode = false;
  }
  await chrome.storage.local.set({
    [BUFFER_STORAGE_KEYS.queue]: [...queue],
    [BUFFER_STORAGE_KEYS.pendingCommands]: queue.length,
    [BUFFER_STORAGE_KEYS.pendingBytes]: pendingBytes,
    [BUFFER_STORAGE_KEYS.refuseMode]: refuseMode,
  });
}

export async function enqueueBufferedMessage(message) {
  return withStorageOperation(async () => {
    await ensureLoaded();
    const nextBytes = queueSize() + itemSize(message);
    if (nextBytes > MAX_BUFFER_BYTES) {
      const previousRefuseMode = refuseMode;
      refuseMode = true;
      try {
        await persist();
      } catch (error) {
        refuseMode = previousRefuseMode;
        throw error;
      }
      const error = new Error('Desktop buffer full');
      error.code = 'buffer_full';
      throw error;
    }
    queue.push(message);
    try {
      await persist();
    } catch (error) {
      queue.pop();
      throw error;
    }
    return currentStats();
  });
}

export async function peekBufferedMessage() {
  await storageOperation.catch(() => {});
  await ensureLoaded();
  return queue[0] || null;
}

export async function shiftBufferedMessage() {
  return withStorageOperation(async () => {
    await ensureLoaded();
    if (queue.length > 0) {
      const shifted = queue.shift();
      try {
        await persist();
      } catch (error) {
        queue.unshift(shifted);
        throw error;
      }
    }
    return currentStats();
  });
}

export async function clearBufferedMessages() {
  return withStorageOperation(async () => {
    await ensureLoaded();
    const previousQueue = queue;
    const previousRefuseMode = refuseMode;
    queue = [];
    refuseMode = false;
    try {
      await persist();
    } catch (error) {
      queue = previousQueue;
      refuseMode = previousRefuseMode;
      throw error;
    }
    return currentStats();
  });
}

export async function bufferStats() {
  await storageOperation.catch(() => {});
  await ensureLoaded();
  return currentStats();
}
