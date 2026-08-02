async function invokeBridgeAction(request) {
  if (window.__TAURI__?.core?.invoke) {
    return window.__TAURI__.core.invoke('bridge_action', { request });
  }
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke('bridge_action', { request });
  }
  throw new Error('Tauri invoke bridge unavailable');
}

export async function sendAction(msg) {
  let resp;
  try {
    resp = await invokeBridgeAction(msg);
  } catch (rejection) {
    if (rejection instanceof Error) throw rejection;
    if (typeof rejection === 'string' && rejection.trim()) {
      throw new Error(rejection);
    }
    let detail;
    try {
      detail = JSON.stringify(rejection);
    } catch {
      detail = String(rejection);
    }
    throw new Error(`${msg.action} bridge rejected with ${detail}`);
  }
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) {
    throw new Error(`${msg.action} returned an invalid response`);
  }
  if (resp.success !== true) {
    if (typeof resp.error !== 'string' || !resp.error.trim()) {
      throw new Error(`${msg.action} failure response is missing an error`);
    }
    throw new Error(resp.error);
  }
  return resp;
}

function requireBooleanField(response, field, action) {
  if (typeof response[field] !== 'boolean') {
    throw new Error(`${action} response ${field} must be a boolean`);
  }
  return response[field];
}

function requireNullableStringField(response, field, action) {
  const value = response[field];
  if (value !== null && (typeof value !== 'string' || !value.trim())) {
    throw new Error(
      `${action} response ${field} must be a non-empty string or null`,
    );
  }
  return value;
}

function requireNonNegativeIntegerField(response, field, action) {
  const value = response[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${action} response ${field} must be a non-negative integer`,
    );
  }
  return value;
}

export async function loadDesktopShellState() {
  const action = 'getDesktopShellState';
  const response = await sendAction({ action });
  for (const field of [
    'loginItemSupported',
    'launchAtLogin',
    'debugLogging',
    'setupComplete',
  ]) {
    requireBooleanField(response, field, action);
  }
  requireNullableStringField(response, 'dataDir', action);
  requireNullableStringField(response, 'systemLocale', action);
  const browsers = requireArrayField(response, 'pairedBrowsers', action);
  for (const [index, browser] of browsers.entries()) {
    if (!browser || typeof browser !== 'object' || Array.isArray(browser)) {
      throw new Error(
        `${action} response pairedBrowsers[${index}] must be an object`,
      );
    }
    for (const field of [
      'browserId',
      'browserName',
      'browserProfile',
      'extensionId',
    ]) {
      if (typeof browser[field] !== 'string' || !browser[field].trim()) {
        throw new Error(
          `${action} response pairedBrowsers[${index}].${field} must be a non-empty string`,
        );
      }
    }
    for (const field of ['approvedAt', 'lastSeen']) {
      if (!Number.isSafeInteger(browser[field]) || browser[field] <= 0) {
        throw new Error(
          `${action} response pairedBrowsers[${index}].${field} must be a positive integer`,
        );
      }
    }
    requireBooleanField(
      browser,
      'connected',
      `${action} pairedBrowsers[${index}]`,
    );
  }
  if (response.setupComplete && response.dataDir === null) {
    throw new Error(`${action} configured response is missing dataDir`);
  }
  return response;
}

export async function loadDeviceIdentity() {
  const action = 'getDeviceId';
  const response = await sendAction({ action });
  requireBooleanField(response, 'setupComplete', action);
  requireNullableStringField(response, 'deviceId', action);
  if (response.setupComplete !== (response.deviceId !== null)) {
    throw new Error(
      `${action} response setupComplete does not match deviceId availability`,
    );
  }
  return response;
}

export async function loadDirectoryInfo() {
  const action = 'getDirectoryInfo';
  const response = await sendAction({ action });
  if (response.info === null) return null;
  const info = requireObjectField(response, 'info', action);
  if (typeof info.name !== 'string' || !info.name.trim()) {
    throw new Error(`${action} response info.name must be a non-empty string`);
  }
  requireBooleanField(info, 'hasPermission', `${action} info`);
  return info;
}

export async function loadDesktopConnectorState() {
  const action = 'getDesktopConnectorState';
  const response = await sendAction({ action });
  if (!['setup_required', 'connected', 'paused'].includes(response.state)) {
    throw new Error(`${action} response state is invalid`);
  }
  for (const field of [
    'deviceId',
    'lastError',
    'lastErrorCode',
    'dataFolder',
  ]) {
    requireNullableStringField(response, field, action);
  }
  requireBooleanField(response, 'hasToken', action);
  const port = response.port;
  if (port !== null && (!Number.isSafeInteger(port) || port < 0)) {
    throw new Error(
      `${action} response port must be a non-negative integer or null`,
    );
  }
  if (response.state === 'setup_required') {
    if (
      response.deviceId !== null ||
      response.dataFolder !== null ||
      response.hasToken
    ) {
      throw new Error(
        `${action} setup_required response contains configured identity data`,
      );
    }
  } else if (
    response.deviceId === null ||
    response.dataFolder === null ||
    response.hasToken !== true ||
    response.port === null
  ) {
    throw new Error(
      `${action} configured response is missing connector identity data`,
    );
  }
  return response;
}

function requireObjectField(response, field, action) {
  const value = response[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${action} response ${field} must be an object`);
  }
  return value;
}

function requireArrayField(response, field, action) {
  const value = response[field];
  if (!Array.isArray(value)) {
    throw new Error(`${action} response ${field} must be an array`);
  }
  return value;
}

function validatePageContexts(pages, action) {
  for (const [slug, context] of Object.entries(pages)) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new Error(`${action} response page ${slug} must be an object`);
    }
    if (
      !context.page ||
      typeof context.page !== 'object' ||
      Array.isArray(context.page)
    ) {
      throw new Error(`${action} response page ${slug} is missing page data`);
    }
    if (!Array.isArray(context.notes) || !Array.isArray(context.lists)) {
      throw new Error(
        `${action} response page ${slug} notes and lists must be arrays`,
      );
    }
    if (context.page.slug !== slug) {
      throw new Error(
        `${action} response page key ${slug} does not match slug ${String(context.page.slug)}`,
      );
    }
    if (typeof context.page.url !== 'string' || !context.page.url) {
      throw new Error(`${action} response page ${slug} has no URL`);
    }
    if (
      !context.page.timestamps ||
      typeof context.page.timestamps !== 'object' ||
      Array.isArray(context.page.timestamps) ||
      !Array.isArray(context.page.visitDates)
    ) {
      throw new Error(
        `${action} response page ${slug} timestamps and visitDates have invalid shapes`,
      );
    }
    if (
      !Number.isSafeInteger(context.page.createdAt) ||
      context.page.createdAt <= 0 ||
      !context.page.visitDates.every(
        (visitDate) => Number.isSafeInteger(visitDate) && visitDate > 0,
      ) ||
      !Object.entries(context.page.timestamps).every(
        ([deviceId, timestamp]) =>
          deviceId.length > 0 &&
          Number.isSafeInteger(timestamp) &&
          timestamp > 0,
      )
    ) {
      throw new Error(
        `${action} response page ${slug} has invalid canonical timestamps`,
      );
    }
    for (const [noteIndex, note] of context.notes.entries()) {
      if (
        !note ||
        typeof note !== 'object' ||
        Array.isArray(note) ||
        typeof note.slug !== 'string' ||
        !note.slug ||
        (note.note !== null && typeof note.note !== 'string') ||
        (note.url !== null && typeof note.url !== 'string')
      ) {
        throw new Error(
          `${action} response page ${slug} note ${noteIndex} is invalid`,
        );
      }
      if (
        !Array.isArray(note.excerpt) ||
        !note.excerpt.every(
          (part) => typeof part === 'string' && part.length > 0,
        ) ||
        !Array.isArray(note.cssPath) ||
        note.cssPath.length !== note.excerpt.length ||
        !note.cssPath.every((path) => typeof path === 'string')
      ) {
        throw new Error(
          `${action} response page ${slug} highlight note ${noteIndex} has an invalid anchor`,
        );
      }
    }
    for (const [listIndex, list] of context.lists.entries()) {
      if (
        !list ||
        typeof list !== 'object' ||
        Array.isArray(list) ||
        typeof list.slug !== 'string' ||
        !list.slug ||
        typeof list.name !== 'string' ||
        !list.name
      ) {
        throw new Error(
          `${action} response page ${slug} list ${listIndex} is invalid`,
        );
      }
    }
  }
  return pages;
}

export async function loadListDisplay(listId) {
  const resp = await sendAction({ action: 'getListDisplay', listId });
  if (resp.list !== null && (!resp.list || typeof resp.list !== 'object')) {
    throw new Error('getListDisplay response list must be an object or null');
  }
  if (
    resp.list &&
    (!Array.isArray(resp.list.pins) || !Array.isArray(resp.list.rules))
  ) {
    throw new Error('getListDisplay response pins and rules must be arrays');
  }
  if (resp.list && resp.list.slug !== listId) {
    throw new Error(
      `getListDisplay response slug ${String(resp.list.slug)} does not match ${listId}`,
    );
  }
  for (const [index, pin] of (resp.list?.pins ?? []).entries()) {
    if (
      !pin ||
      typeof pin !== 'object' ||
      Array.isArray(pin) ||
      typeof pin.kind !== 'string' ||
      typeof pin.slug !== 'string' ||
      !Number.isSafeInteger(pin.pinnedAt) ||
      typeof pin.isNote !== 'boolean' ||
      typeof pin.hasSnapshots !== 'boolean' ||
      typeof pin.hasHighlightNotes !== 'boolean' ||
      !Array.isArray(pin.listSlugs) ||
      !Array.isArray(pin.visitDates) ||
      !pin.timestamps ||
      typeof pin.timestamps !== 'object' ||
      Array.isArray(pin.timestamps)
    ) {
      throw new Error(`getListDisplay response pin ${index} is invalid`);
    }
  }
  for (const [index, rule] of (resp.list?.rules ?? []).entries()) {
    if (
      !rule ||
      typeof rule !== 'object' ||
      Array.isArray(rule) ||
      typeof rule.id !== 'string' ||
      typeof rule.type !== 'string' ||
      !rule.config ||
      typeof rule.config !== 'object' ||
      Array.isArray(rule.config) ||
      !Number.isSafeInteger(rule.createdAt)
    ) {
      throw new Error(`getListDisplay response rule ${index} is invalid`);
    }
  }
  return resp.list;
}

export async function loadPageContext(slugs) {
  const resp = await sendAction({ action: 'getPageContext', slugs });
  return validatePageContexts(
    requireObjectField(resp, 'pages', 'getPageContext'),
    'getPageContext',
  );
}

export async function loadAllPageContext() {
  const resp = await sendAction({ action: 'getAllPageContext' });
  return validatePageContexts(
    requireObjectField(resp, 'pages', 'getAllPageContext'),
    'getAllPageContext',
  );
}

export async function loadHighlightHistory() {
  const resp = await sendAction({ action: 'getHighlightHistory' });
  const highlights = requireArrayField(
    resp,
    'highlights',
    'getHighlightHistory',
  );
  const seenNoteSlugs = new Set();
  let previousCreatedAt = Number.POSITIVE_INFINITY;
  for (const [index, item] of highlights.entries()) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      !Number.isSafeInteger(item.createdAt) ||
      item.createdAt <= 0 ||
      !item.page ||
      typeof item.page !== 'object' ||
      Array.isArray(item.page) ||
      typeof item.page.slug !== 'string' ||
      !item.page.slug ||
      typeof item.page.url !== 'string' ||
      !item.page.url ||
      !item.note ||
      typeof item.note !== 'object' ||
      Array.isArray(item.note) ||
      typeof item.note.slug !== 'string' ||
      !item.note.slug ||
      item.note.url !== item.page.url ||
      (item.note.note !== null && typeof item.note.note !== 'string') ||
      !Array.isArray(item.note.excerpt) ||
      !item.note.excerpt.every(
        (part) => typeof part === 'string' && part.length > 0,
      ) ||
      !Array.isArray(item.note.cssPath) ||
      item.note.cssPath.length !== item.note.excerpt.length ||
      !item.note.cssPath.every((path) => typeof path === 'string')
    ) {
      throw new Error(`getHighlightHistory response item ${index} is invalid`);
    }
    if (
      seenNoteSlugs.has(item.note.slug) ||
      item.createdAt > previousCreatedAt
    ) {
      throw new Error(
        `getHighlightHistory response item ${index} has invalid identity or ordering`,
      );
    }
    seenNoteSlugs.add(item.note.slug);
    previousCreatedAt = item.createdAt;
  }
  return highlights;
}

export async function loadListTreeProjection() {
  const resp = await sendAction({ action: 'getListTree' });
  return {
    tree: requireArrayField(resp, 'tree', 'getListTree'),
    order: requireArrayField(resp, 'order', 'getListTree'),
  };
}

export async function loadRecycleBin() {
  const resp = await sendAction({ action: 'getRecycleBin' });
  return requireArrayField(resp, 'entries', 'getRecycleBin');
}

let settingsCache = null;
let settingsCachePromise = null;

export async function loadSettings() {
  if (!settingsCachePromise) {
    settingsCachePromise = sendAction({ action: 'getSettings' })
      .then((resp) => requireObjectField(resp, 'settings', 'getSettings'))
      .then((settings) => {
        settingsCache = settings;
        return settingsCache;
      })
      .catch((error) => {
        settingsCachePromise = null;
        throw error;
      });
  }
  return settingsCachePromise;
}

export async function loadSettingsValue(key) {
  const settings = await loadSettings();
  if (!Object.prototype.hasOwnProperty.call(settings, key)) {
    throw new Error(`getSettings response is missing ${key}`);
  }
  return settings[key];
}

export function invalidateSettingsCache() {
  settingsCache = null;
  settingsCachePromise = null;
}

export async function saveSettingsValue(key, value) {
  await sendAction({ action: 'saveSettingsKey', key, value });
  if (settingsCache) {
    settingsCache = { ...settingsCache, [key]: value };
    settingsCachePromise = Promise.resolve(settingsCache);
  }
}

export function reloadApp() {
  window.location.reload();
}
