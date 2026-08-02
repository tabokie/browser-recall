const BUFFER_STORAGE_KEYS = {
  queue: 'desktopCommandBuffer',
  pendingCommands: 'desktopPendingCommands',
  pendingBytes: 'desktopPendingBytes',
};

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

let loaded = false;
let queue = [];
let storageOperation = Promise.resolve();

function itemSize(item) {
  return encoder.encode(JSON.stringify(item)).length;
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
  queue = storedQueue === undefined ? [] : storedQueue;
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
  };
}

async function persist() {
  const pendingBytes = queueSize();
  await chrome.storage.local.set({
    [BUFFER_STORAGE_KEYS.queue]: [...queue],
    [BUFFER_STORAGE_KEYS.pendingCommands]: queue.length,
    [BUFFER_STORAGE_KEYS.pendingBytes]: pendingBytes,
  });
}

export async function enqueueBufferedMessage(message) {
  return withStorageOperation(async () => {
    await ensureLoaded();
    const nextBytes = queueSize() + itemSize(message);
    if (nextBytes > MAX_BUFFER_BYTES) {
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
    queue = [];
    try {
      await persist();
    } catch (error) {
      queue = previousQueue;
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
