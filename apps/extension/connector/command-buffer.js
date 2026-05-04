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
  queue = stored[BUFFER_STORAGE_KEYS.queue] || [];
  refuseMode = Boolean(stored[BUFFER_STORAGE_KEYS.refuseMode]);
  loaded = true;
}

async function withStorageOperation(fn) {
  const run = storageOperation.catch(() => {}).then(fn);
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
      refuseMode = true;
      await persist();
      const error = new Error('Desktop buffer full');
      error.code = 'buffer_full';
      throw error;
    }
    queue.push(message);
    await persist();
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
      queue.shift();
      await persist();
    }
    return currentStats();
  });
}

export async function clearBufferedMessages() {
  return withStorageOperation(async () => {
    await ensureLoaded();
    queue = [];
    refuseMode = false;
    await persist();
    return currentStats();
  });
}

export async function bufferStats() {
  await storageOperation.catch(() => {});
  await ensureLoaded();
  return currentStats();
}
