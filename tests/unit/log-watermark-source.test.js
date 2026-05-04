import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const bgSource = readFileSync(
  resolve(process.cwd(), 'apps', 'extension', 'background.js'),
  'utf8',
);
const wsSource = readFileSync(
  resolve(process.cwd(), 'apps', 'extension', 'connector', 'ws-client.js'),
  'utf8',
);
const popupSource = readFileSync(
  resolve(process.cwd(), 'apps', 'extension', 'popup.js'),
  'utf8',
);
const daemonWsSource = readFileSync(
  resolve(process.cwd(), 'crates', 'daemon', 'src', 'ws_server.rs'),
  'utf8',
);
const desktopMainSource = readFileSync(
  resolve(process.cwd(), 'apps', 'desktop', 'src-tauri', 'src', 'main.rs'),
  'utf8',
);
const desktopUiSource = readFileSync(
  resolve(process.cwd(), 'apps', 'desktop', 'ui', 'index.js'),
  'utf8',
);
const storageSource = readFileSync(
  resolve(process.cwd(), 'crates', 'daemon', 'src', 'storage.rs'),
  'utf8',
);
const migrationSource = readFileSync(
  resolve(process.cwd(), 'scripts', 'migrate-browser-data-schema.mjs'),
  'utf8',
);
const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
);

describe('extension write queue invariants', () => {
  it('does not keep a second background log buffer', () => {
    const nextTimestamp = bgSource.match(
      /async function nextLogTimestamp\(\) \{[\s\S]*?\n\}/,
    );
    expect(nextTimestamp).not.toBeNull();
    expect(nextTimestamp[0]).not.toContain('ensureLogBuffer');
    expect(nextTimestamp[0]).not.toContain('logBufferWatermark');
    expect(bgSource).not.toContain('let logBuffer');
    expect(bgSource).not.toContain("chrome.storage.local.get(['logBuffer'");

    const reportCommand = bgSource.match(
      /async function enqueueReportCommand[\s\S]*?^}/m,
    );
    expect(reportCommand).not.toBeNull();
    expect(reportCommand[0]).toContain('await enqueueCommand(action, request)');
    expect(bgSource).not.toContain("action: 'visit_page'");
    expect(bgSource).not.toContain("action: 'leave_page'");
  });

  it('keeps Desktop-owned mutations out of event-log enqueueing', () => {
    expect(bgSource).not.toContain('skipDesktopMirror');

    const captureAndLog = bgSource.match(
      /async function captureAndLog[\s\S]*?^}/m,
    );
    expect(captureAndLog).not.toBeNull();
    expect(captureAndLog[0]).toContain('await mirrorSnapshotToDesktop');
    expect(captureAndLog[0]).not.toContain('enqueueReportCommand');

    const createNote = bgSource.match(
      /async function handleCreateNote[\s\S]*?^}/m,
    );
    expect(createNote).not.toBeNull();
    expect(createNote[0]).toContain("await runDesktopCommand('createNote'");
    expect(createNote[0]).not.toContain('mirrorNoteToDesktop');
    expect(createNote[0]).not.toContain('enqueueReportCommand');
  });

  it('bootstraps default lists through Desktop instead of queued list events', () => {
    const ensureDefaults = bgSource.match(
      /async function ensureDefaultLists[\s\S]*?^}/m,
    );
    expect(ensureDefaults).not.toBeNull();
    expect(ensureDefaults[0]).toContain(
      "await runDesktopCommand('ensureDefaultLists'",
    );
    expect(ensureDefaults[0]).not.toContain('enqueueReportCommand');
    expect(ensureDefaults[0]).not.toContain('create_list');
    expect(ensureDefaults[0]).not.toContain('add_rule');
  });

  it('sends snapshots over the live Desktop bridge instead of storage.local queue', () => {
    const enqueueSnapshot = wsSource.match(
      /export async function enqueueDesktopSnapshot[\s\S]*?^}/m,
    );
    expect(enqueueSnapshot).not.toBeNull();
    expect(enqueueSnapshot[0]).toContain('buildSnapshotBridgePayload');
    expect(enqueueSnapshot[0]).toContain('sendBridgeMessage');
    expect(enqueueSnapshot[0]).not.toContain('enqueueBufferedMessage');

    const bufferedPayload = wsSource.match(
      /function buildBufferedBridgePayload[\s\S]*?^}/m,
    );
    expect(bufferedPayload).not.toBeNull();
    expect(bufferedPayload[0]).not.toContain("type: 'snapshot'");
  });

  it('keeps Desktop-owned browser policy out of extension UI code', () => {
    expect(popupSource).not.toContain('DEFAULT_URL_BLACKLIST');
    expect(popupSource).not.toContain('urlBlacklist');
    expect(popupSource).not.toContain('blacklistEnabled');
  });

  it('queues semantic commands, not raw replay events, from the extension', () => {
    expect(wsSource).not.toContain('enqueueDesktopEvent');
    expect(wsSource).not.toContain("kind === 'event'");
    expect(wsSource).not.toContain("type: 'event'");
    expect(wsSource).not.toContain('desktopEventBuffer');
    expect(wsSource).not.toContain('desktopPendingEvents');
  });

  it('does not keep compatibility command names for Desktop mutations', () => {
    expect(daemonWsSource).not.toContain('"submitEvent"');
    expect(daemonWsSource).not.toContain('"reportPage"');
    expect(desktopMainSource).not.toContain('"submitEvent"');
    expect(desktopMainSource).not.toContain('"reportPage"');
    expect(desktopUiSource).not.toContain("action: 'reportPage'");
  });

  it('does not apply Desktop rule batch results locally in the extension', () => {
    const runRuleBatch = bgSource.match(
      /async function handleRunRuleBatch[\s\S]*?^}/m,
    );
    expect(runRuleBatch).not.toBeNull();
    expect(runRuleBatch[0]).toContain('requestRuleBatch');
    expect(runRuleBatch[0]).toContain("notifyMutation('pins'");
    expect(runRuleBatch[0]).not.toContain('applyDesktopRuleBatchLocally');
    expect(bgSource).not.toContain('function applyDesktopRuleBatchLocally');
  });

  it('builds keyword rules without field selectors', () => {
    const buildRuleFromForm = desktopUiSource.match(
      /function buildRuleFromEditRow[\s\S]*?^}/m,
    );
    expect(buildRuleFromForm).not.toBeNull();
    expect(buildRuleFromForm[0]).toContain("type: 'keyword'");
    expect(buildRuleFromForm[0]).toContain('config: { pattern: inputVal }');
    expect(buildRuleFromForm[0]).not.toContain('fields');
    expect(buildRuleFromForm[0]).not.toContain('caseSensitive');
  });

  it('refreshes the active rule list after deleting a Desktop rule', () => {
    const renderRulesList = desktopUiSource.match(
      /function renderRulesList[\s\S]*?\nasync function refreshRulesForActiveList/m,
    );
    expect(renderRulesList).not.toBeNull();
    const removeHandler = renderRulesList[0].match(
      /await sendAction\(\{ action: 'removeRule', listId, ruleId \}\);[\s\S]*?catch \(err\)/,
    );
    expect(removeHandler).not.toBeNull();
    expect(removeHandler[0]).toContain('await refreshRulesForActiveList()');
  });

  it('persists page checkpoints only for user-retained pages', () => {
    expect(storageSource).toContain('page_retains_checkpoint');
    expect(storageSource).not.toContain('fn page_retains_user_state');
    expect(storageSource).toContain('persist_page_checkpoint_effect');
    const jsVerifierPath = resolve(process.cwd(), 'scripts', 'replay-verify.mjs');
    if (existsSync(jsVerifierPath)) {
      const replayVerifySource = readFileSync(jsVerifierPath, 'utf8');
      expect(replayVerifySource).not.toContain('pageRetainsCheckpoint');
    }
    expect(packageJson.scripts).not.toHaveProperty('replay:verify');
    expect(migrationSource).not.toContain('replay progress from retained logs');
    expect(migrationSource).toContain(
      'remove unsafe replay progress until legacy checkpoints are rebuilt',
    );
  });
});
