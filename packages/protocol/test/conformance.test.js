import { describe, expect, it } from 'vitest';
import {
  auth,
  ack,
  authFail,
  authOk,
  daemonError,
  entityResult,
  event,
  getEntity,
  getPageInfo,
  getSnapshotHtml,
  getPopupLists,
  getStatus,
  note,
  pageInfoResult,
  snapshotHtmlResult,
  popupListsResult,
  searchHistory,
  searchHistoryResult,
  searchNotes,
  searchNotesResult,
  searchSnapshots,
  searchSnapshotsResult,
  previewRule,
  previewRuleResult,
  pairApproved,
  pairDenied,
  pairPending,
  pairRequest,
  parseConnectorMessage,
  parseDaemonMessage,
  ping,
  pong,
  protocolSchema,
  ruleBatchResult,
  runRuleBatch,
  snapshot,
  status,
} from '../index.js';

describe('protocol schema', () => {
  it('exposes versioned schema metadata', () => {
    expect(protocolSchema.version).toBe(2);
    expect(protocolSchema.messages.connector_to_daemon).toBeTruthy();
    expect(protocolSchema.messages.daemon_to_connector).toBeTruthy();
  });
});

describe('connector → daemon conformance', () => {
  const validCases = [
    pairRequest('browser-install-1', 'Chrome', 'abcdefghijklmnop'),
    auth('top-secret-token'),
    ping(),
    getStatus(),
    getPageInfo('page-slug'),
    getSnapshotHtml('page-slug', 1),
    getEntity('page:page-slug'),
    getPopupLists(),
    event({ timestamp: 1, action: 'visit_page' }),
    runRuleBatch(
      ['reading'],
      [{ url: 'https://example.com', title: 'Example' }],
    ),
    previewRule(
      {
        type: 'function',
        config: { description: 'x', fnSource: 'return true;' },
      },
      [{ url: 'https://example.com', title: 'Example' }],
    ),
    searchHistory('banana', 25),
    searchNotes('banana', 10),
    searchSnapshots('banana', 5),
    note('n1', 'hello', 'world', 'https://example.com', 1, 'Title', null),
    note(
      'n2',
      'hello',
      'updated',
      'https://example.com',
      2,
      undefined,
      null,
      'n1',
    ),
    snapshot(
      'page-slug',
      1,
      'https://example.com',
      '<html></html>',
      'Title',
      '# Title',
    ),
  ];

  for (const sample of validCases) {
    it(`accepts ${sample.type}`, () => {
      expect(parseConnectorMessage(sample)).toEqual({
        ok: true,
        value: sample,
      });
    });
  }

  it('rejects missing required fields', () => {
    expect(
      parseConnectorMessage({ type: 'pair_request', browserId: 'a' }),
    ).toEqual({
      ok: false,
      error: 'Missing required field: browserName',
    });
  });

  it('rejects connector payloads that omit source metadata', () => {
    expect(
      parseConnectorMessage({
        type: 'event',
        entry: {
          timestamp: 1,
          action: 'visit_page',
          url: 'https://example.com',
        },
      }),
    ).toEqual({
      ok: false,
      error: 'Missing required field: source',
    });
  });

  it('rejects unknown message types', () => {
    expect(parseConnectorMessage({ type: 'missing' })).toEqual({
      ok: false,
      error: 'Unknown message type: missing',
    });
  });
});

describe('daemon → connector conformance', () => {
  const validCases = [
    pairPending('request-1'),
    pairApproved('top-secret-token', 'device-1'),
    pairDenied(),
    authOk(),
    authFail('expired'),
    pong(),
    ack(1, 0, 1),
    status(['Chrome'], 0, 0, 0, null, '/tmp/portal-data', 'device-1'),
    pageInfoResult(
      true,
      'page-slug',
      {
        slug: 'page-slug',
        url: 'https://example.com',
      },
      [{ slug: 'note-1', excerpt: 'hello' }],
      [{ timestamp: 1, hasMd: true, hasHtml: true }],
    ),
    snapshotHtmlResult(true, '<html></html>'),
    entityResult(true, 'page:page-slug', {
      slug: 'page-slug',
      url: 'https://example.com',
    }),
    popupListsResult(true, [
      {
        slug: 'reading',
        name: 'Reading',
        pins: [{ id: 'page:page-slug', pinnedAt: 1 }],
      },
    ]),
    ruleBatchResult(true, [
      { listId: 'reading', url: 'https://example.com', matches: [] },
    ]),
    previewRuleResult(true, [
      { url: 'https://example.com', title: 'Example', match: true },
    ]),
    searchHistoryResult(true, [
      {
        url: 'https://example.com',
        title: 'Example',
        timestamp: 1,
        score: 1.5,
      },
    ]),
    searchNotesResult(true, [
      { url: 'https://example.com', noteSlug: 'note-1' },
    ]),
    searchSnapshotsResult(true, [{ slug: 'example-page' }]),
    daemonError('paused', 'replay_error', 'Paused by daemon'),
  ];

  for (const sample of validCases) {
    it(`accepts ${sample.type}`, () => {
      expect(parseDaemonMessage(sample)).toEqual({
        ok: true,
        value: sample,
      });
    });
  }

  it('rejects wrong field types', () => {
    expect(parseDaemonMessage({ type: 'pair_pending', requestId: 42 })).toEqual(
      {
        ok: false,
        error: 'Field requestId must be string',
      },
    );
  });

  it('rejects non-object payloads', () => {
    expect(parseDaemonMessage('pair_pending')).toEqual({
      ok: false,
      error: 'Message type must be a string',
    });
  });

  it('accepts nullable status timestamps', () => {
    expect(
      parseDaemonMessage(
        status(['Chrome'], 0, 0, 0, null, '/tmp/portal-data', 'device-1'),
      ),
    ).toEqual({
      ok: true,
      value: status(['Chrome'], 0, 0, 0, null, '/tmp/portal-data', 'device-1'),
    });
  });
});
