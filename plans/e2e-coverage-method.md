# E2E Coverage Method

This is the working method for increasing Browser Recall test value without growing unit-test coverage by default.

## Evidence Inputs

1. **Coverage miss lines** from `npm run coverage`.
   Use uncovered production files and line ranges as a triage map, not as a percentage target.
2. **Past uncaught bugs** from `prompts/` and commit/session history.
   Prefer escaped bugs and repeated bug families over isolated implementation details.
3. **Unit tests without E2E counterparts**.
   Convert valuable user-visible behavior into E2E when practical; keep unit tests only for narrow invariants.
4. **Feature and workflow combinations**.
   Cover realistic combinations such as visit + title change + leave, search + list filtering + mutation, note + pin + popup, offline buffer + reconnect.

## Current High-Risk Surfaces

| Surface | Evidence | Existing Coverage | Next E2E Direction |
| --- | --- | --- | --- |
| Desktop main UI (`apps/desktop/ui/index.js`) | Largest uncovered file; many past bugs around search, lists, recycle bin, scrolling, rules | Broad desktop harness coverage exists but mostly fixed scenarios | Add seeded combinations that mix search/filter/list/mutation/recycle/rules |
| Extension background/content/popup | Large uncovered areas; past bugs around title changes, badges, popup state, capture, special URLs | Popup, badge, navigation, highlight tests exist | Add lifecycle combinations: dynamic title, referrer, note, pin, popup/badge refresh |
| Connector websocket/buffer | Large uncovered `ws-client.js`; past downtime/reconnect bugs | Vitest integration covers daemon-backed connector paths | Add browser-level E2E for offline queue + popup reads + reconnect where feasible |
| Snapshot/savepage | Uncovered savepage/snapshot viewer paths; recurring capture issues | Snapshot viewer and slug-meta E2E exist | Add capture failure/success combinations against desktop settings and popup error UI |
| Browser compatibility | Past Firefox/Orion failures; unit + smoke coverage exists | Smoke tests cover boot, popup, badge, snapshot | Add compatibility scenarios when smoke misses a user-visible path |

## Prioritized Backlog

1. **Dynamic title lifecycle**
   Evidence: `content.js` title observer/leave path is uncovered; prompt history asks whether title changes still work; existing E2E focuses on SPA navigation titles, not same-URL title mutation.
   Scenario: page loads, title changes while URL stays stable, page leaves, daemon log/checkpoint sees latest title.

2. **Popup note + list + badge refresh from live desktop mutation**
   Evidence: uncovered `background.js`, `popup.js`, `badge-controller.js`; repeated badge/popup refresh bugs.
   Scenario: popup is open on a page, daemon/list/note mutation happens, popup and active tab marker converge without local entity caches.
   Added: `tests/e2e/popup-lists.spec.js` covers seeded note + pin mutation while the popup is open and verifies popup/badge convergence.

3. **List search pin regression**
   Evidence: past bug: searched page pinned from list UI produced delete/untitled state; desktop UI + list filtering coverage remains fragmented.
   Scenario: search inside a list, pin/unpin a result, verify list checkpoint and rendered row preserve URL/title.

4. **Offline connector queue combination**
   Evidence: uncovered `ws-client.js`; unit tests cover buffering internals; integration covers daemon flows but not browser UI behavior.
   Scenario: disconnect daemon, queue visit + note + popup read, reconnect, verify FIFO writes and UI recovery.

5. **Capture setting/error path**
   Evidence: unit tests inspect source for capture validation; uncovered savepage bridge; past capture and extension-context errors.
   Scenario: popup Capture It with desktop-backed settings; failure shows one user-visible error and does not enqueue large payload into extension storage.

## Added Coverage

- `tests/e2e/time-on-page.spec.js`: seeded same-URL title mutation through leave logging.
- `tests/e2e/seeded-combination-workflows.spec.js`: seeded extension visit + note + list pin + popup summary workflow.
- `tests/e2e/desktop-visual.spec.js`: seeded desktop search + list filtering + live mutation, plus seeded keyword rule preview over recent visits and active list pins.
- `tests/e2e/popup-lists.spec.js`: seeded live popup mutation refresh for note + pin + badge state.

## Selection Rule

Add the next E2E test only when it can be tied to at least three of the four evidence inputs. Prefer stable seeded data. Record the seed in the test title when randomized inputs are used.
