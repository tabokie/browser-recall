import schema from './schema.json' with { type: 'json' };

const CONNECTOR_TO_DAEMON = schema.messages.connector_to_daemon;
const DAEMON_TO_CONNECTOR = schema.messages.daemon_to_connector;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesExpectedType(value, expectedType) {
  if (Array.isArray(expectedType)) {
    return expectedType.some((candidate) =>
      matchesExpectedType(value, candidate),
    );
  }
  if (expectedType === 'array') {
    return Array.isArray(value);
  }
  if (expectedType === 'null') {
    return value === null;
  }
  if (expectedType === 'object') {
    return isPlainObject(value);
  }
  return typeof value === expectedType;
}

function validateShape(payload, shape) {
  if (!isPlainObject(payload)) {
    return {
      ok: false,
      error: 'Message payload must be an object',
    };
  }

  for (const key of shape.required) {
    if (!(key in payload)) {
      return {
        ok: false,
        error: `Missing required field: ${key}`,
      };
    }
  }

  for (const [key, expectedType] of Object.entries(shape.properties)) {
    if (!(key in payload)) continue;
    if (!matchesExpectedType(payload[key], expectedType)) {
      return {
        ok: false,
        error: `Field ${key} must be ${Array.isArray(expectedType) ? expectedType.join(' or ') : expectedType}`,
      };
    }
  }

  return { ok: true, value: payload };
}

function parseByDirection(payload, directionSchema) {
  if (!isPlainObject(payload) || typeof payload.type !== 'string') {
    return {
      ok: false,
      error: 'Message type must be a string',
    };
  }

  const shape = directionSchema[payload.type];
  if (!shape) {
    return {
      ok: false,
      error: `Unknown message type: ${payload.type}`,
    };
  }
  return validateShape(payload, shape);
}

export const protocolSchema = schema;

export function parseConnectorMessage(payload) {
  return parseByDirection(payload, CONNECTOR_TO_DAEMON);
}

export function parseDaemonMessage(payload) {
  return parseByDirection(payload, DAEMON_TO_CONNECTOR);
}

export function pairRequest(browserId, browserName, extensionId) {
  return {
    type: 'pair_request',
    browserId,
    browserName,
    extensionId,
  };
}

export function auth(token) {
  return {
    type: 'auth',
    token,
  };
}

export function ping() {
  return { type: 'ping' };
}

export function getStatus() {
  return { type: 'get_status' };
}

export function getPageInfo(slug) {
  return {
    type: 'get_page_info',
    slug,
  };
}

export function getSnapshotHtml(slug, ts) {
  return {
    type: 'get_snapshot_html',
    slug,
    ts,
  };
}

export function getEntity(key) {
  return {
    type: 'get_entity',
    key,
  };
}

export function getPopupLists() {
  return { type: 'get_popup_lists' };
}

export function event(entry, meta = {}) {
  const payload = {
    type: 'event',
    entry,
    source: meta.source ?? 'extension',
  };
  if (meta.bufferDepth !== undefined) payload.bufferDepth = meta.bufferDepth;
  if (meta.bufferBytes !== undefined) payload.bufferBytes = meta.bufferBytes;
  return payload;
}

export function runRuleBatch(listIds, entries) {
  return {
    type: 'run_rule_batch',
    listIds,
    entries,
  };
}

export function previewRule(rule, entries) {
  return {
    type: 'preview_rule',
    rule,
    entries,
  };
}

export function searchHistory(query, limit) {
  const payload = {
    type: 'search_history',
    query,
  };
  if (limit !== undefined) payload.limit = limit;
  return payload;
}

export function searchHistoryStream(searchId, query, limit) {
  const payload = {
    type: 'search_history_stream',
    searchId,
    query,
  };
  if (limit !== undefined) payload.limit = limit;
  return payload;
}

export function cancelHistorySearch(searchId) {
  return {
    type: 'cancel_history_search',
    searchId,
  };
}

export function searchNotes(query, limit) {
  const payload = {
    type: 'search_notes',
    query,
  };
  if (limit !== undefined) payload.limit = limit;
  return payload;
}

export function searchSnapshots(query, limit) {
  const payload = {
    type: 'search_snapshots',
    query,
  };
  if (limit !== undefined) payload.limit = limit;
  return payload;
}

export function note(
  slug,
  excerpt,
  noteBody,
  url,
  ts,
  title,
  cssPath,
  oldSlug,
  meta = {},
) {
  const payload = {
    type: 'note',
    slug,
    excerpt,
    note: noteBody,
    url,
    ts,
    source: meta.source ?? 'extension',
  };
  if (title !== undefined) payload.title = title;
  if (cssPath !== undefined) payload.cssPath = cssPath;
  if (oldSlug !== undefined) payload.oldSlug = oldSlug;
  if (meta.bufferDepth !== undefined) payload.bufferDepth = meta.bufferDepth;
  if (meta.bufferBytes !== undefined) payload.bufferBytes = meta.bufferBytes;
  return payload;
}

export function snapshot(slug, ts, url, html, title, markdown, meta = {}) {
  const payload = {
    type: 'snapshot',
    slug,
    ts,
    url,
    html,
    source: meta.source ?? 'extension',
  };
  if (title !== undefined) payload.title = title;
  if (markdown !== undefined) payload.markdown = markdown;
  if (meta.bufferDepth !== undefined) payload.bufferDepth = meta.bufferDepth;
  if (meta.bufferBytes !== undefined) payload.bufferBytes = meta.bufferBytes;
  return payload;
}

export function pairPending(requestId) {
  return {
    type: 'pair_pending',
    requestId,
  };
}

export function pairApproved(token, deviceId) {
  return {
    type: 'pair_approved',
    token,
    deviceId,
  };
}

export function pairDenied() {
  return { type: 'pair_denied' };
}

export function authOk() {
  return { type: 'auth_ok' };
}

export function authFail(reason) {
  return {
    type: 'auth_fail',
    reason,
  };
}

export function pong() {
  return { type: 'pong' };
}

export function ack(ackedAt, bufferDepth, lastDrainedAt) {
  return {
    type: 'ack',
    ackedAt,
    bufferDepth,
    lastDrainedAt,
  };
}

export function status(
  connectedBrowsers,
  bufferDepth,
  bufferBytes,
  daemonBufferDepth,
  lastDrainedAt,
  dataFolder,
  deviceId,
) {
  return {
    type: 'status',
    connectedBrowsers,
    bufferDepth,
    bufferBytes,
    daemonBufferDepth,
    lastDrainedAt,
    dataFolder,
    deviceId,
  };
}

export function pageInfoResult(
  success,
  slug,
  entry = null,
  notes = [],
  snapshots = [],
  error,
) {
  const payload = {
    type: 'page_info_result',
    success,
    slug,
  };
  if (entry !== undefined) payload.entry = entry;
  if (notes !== undefined) payload.notes = notes;
  if (snapshots !== undefined) payload.snapshots = snapshots;
  if (error !== undefined) payload.error = error;
  return payload;
}

export function snapshotHtmlResult(success, html, error) {
  const payload = {
    type: 'snapshot_html_result',
    success,
  };
  if (html !== undefined) payload.html = html;
  if (error !== undefined) payload.error = error;
  return payload;
}

export function entityResult(success, key, entity, error) {
  const payload = {
    type: 'entity_result',
    success,
    key,
  };
  if (entity !== undefined) payload.entity = entity;
  if (error !== undefined) payload.error = error;
  return payload;
}

export function popupListsResult(success, lists = [], error) {
  const payload = {
    type: 'popup_lists_result',
    success,
  };
  if (lists !== undefined) payload.lists = lists;
  if (error !== undefined) payload.error = error;
  return payload;
}

export function ruleBatchResult(success, results = [], error) {
  const payload = {
    type: 'rule_batch_result',
    success,
  };
  if (results !== undefined) payload.results = results;
  if (error !== undefined) payload.error = error;
  return payload;
}

export function previewRuleResult(success, results = [], error) {
  const payload = {
    type: 'preview_rule_result',
    success,
  };
  if (results !== undefined) payload.results = results;
  if (error !== undefined) payload.error = error;
  return payload;
}

export function searchHistoryResult(success, results = [], error) {
  const payload = {
    type: 'search_history_result',
    success,
  };
  if (results !== undefined) payload.results = results;
  if (error !== undefined) payload.error = error;
  return payload;
}

export function historySearchChunk(searchId, workerId, results = []) {
  return {
    type: 'history_search_chunk',
    searchId,
    workerId,
    results,
  };
}

export function historySearchDone(searchId, success, cancelled, error) {
  const payload = {
    type: 'history_search_done',
    searchId,
    success,
    cancelled,
  };
  if (error !== undefined) payload.error = error;
  return payload;
}

export function searchNotesResult(success, results = [], error) {
  const payload = {
    type: 'search_notes_result',
    success,
  };
  if (results !== undefined) payload.results = results;
  if (error !== undefined) payload.error = error;
  return payload;
}

export function searchSnapshotsResult(success, results = [], error) {
  const payload = {
    type: 'search_snapshots_result',
    success,
  };
  if (results !== undefined) payload.results = results;
  if (error !== undefined) payload.error = error;
  return payload;
}

export function daemonError(error, code, message) {
  return {
    type: 'error',
    error,
    code,
    message,
  };
}
