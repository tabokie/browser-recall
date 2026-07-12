# Plan 02: Token Security (P0)

## Problem

GitHub PAT is stored in plain text in `manifest/settings.json` on disk. Must fix before public release.

## Design Decisions

- **Two auth methods**: OAuth device flow (default, easy UX) and manual PAT entry (advanced, allows fine-grained per-repo scoping)
- **Token storage**: `chrome.storage.session` only by default (in-memory, never on disk, cleared on restart). Opt-in "Remember on disk" checkbox saves plaintext in `settings.json` for persistence across restarts.
- **Rationale for no encryption at rest**: Chrome provides no per-installation secret or hardware key storage. If an attacker has file access, they can delete all extension data anyway (equivalent damage). The real threat is accidental exposure (backup, git commit), which the session-only default prevents.
- **OAuth App**: registered under `browser-recall` GitHub org. `client_id` hardcoded as a constant in the device flow helper module (see module boundary below). Public by design.
- **Scope**: `repo` (OAuth App tokens cannot be scoped per-repo; document that users wanting per-repo restriction should use manual PAT with fine-grained token).
- **Auth method persistence**: `syncAuthMethod` field in `settings.json` (`'oauth'` | `'pat'` | `null`). Used on reload to display correct connected state. `syncGitHubUser` stores the username for display.
- **Module boundary**: device flow helpers (`requestDeviceCode`, `pollForToken`, `revokeToken`) live in a new `extension/github-oauth.js` file, loaded by `options.html` via `<script>`. These are simple fetch calls to GitHub's OAuth endpoints, separate from the repo sync transport. `options.js` calls them directly — no background involvement during the auth flow.
- **No migration needed** — no existing users.

## Auth Flows

### OAuth Device Flow

1. User clicks "Connect with GitHub" in settings modal
2. Extension POSTs to `https://github.com/login/device/code` with `client_id` + `scope=repo`
3. GitHub returns `user_code`, `device_code`, `verification_uri`, `interval`, `expires_in`
4. Extension shows `user_code` prominently with "Copy" button, opens `github.com/login/device` in new tab
5. Extension polls `POST https://github.com/login/oauth/access_token` every `interval` seconds with `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`
6. On success: receives `access_token`, fetches username via `GET /user`, stores token in `chrome.storage.session` + username/auth method in `settings.json`, optionally token on disk too
7. On expiration (`expires_in` elapsed): stop polling, show "Code expired, try again"
8. User can cancel at any time via "Cancel" button

### Manual PAT

1. User clicks "Use personal access token" (secondary link)
2. Text input expands (current `type="password"` input)
3. User pastes token, clicks Save
4. Token stored same way (session + optionally disk)

## Token Lifecycle

- **Startup**: if `chrome.storage.session` already has a token (e.g., SW restart without browser restart), skip disk load. Otherwise, if "Remember on disk" is on and `syncToken` exists in `settings.json`, load into `chrome.storage.session`
- **Browser restart with session-only**: token lost, sync disabled until re-auth. Show "GitHub disconnected, reconnect in Settings" in sync status.
- **Disconnect**: clear from `chrome.storage.session` + `settings.json` + clear `syncAuthMethod`/`syncGitHubUser`. Show link to `https://github.com/settings/connections/applications/{client_id}` for manual token revocation on GitHub (server-side revocation via API requires `client_secret` which we don't have in the extension)
- **Auth failure mid-session** (401 from GitHub): surface "GitHub authorization expired, please reconnect" in sync status area, stop sync alarm

## UI Changes (options.html settings modal)

### Disconnected State
```
Sync
  [x] Enable sync
  Repository URL: [https://github.com/user/browser-recall-sync]
  
  Authentication:
    [Connect with GitHub]  (primary button)
    or Use personal access token  (secondary link)
  
  [ ] Remember token on disk
```

### Device Flow In-Progress
```
  Authentication:
    Enter this code on GitHub:  [ABCD-1234] [Copy]
    [Open GitHub ↗]
    Waiting for authorization... [Cancel]
```

### Connected State
```
  Authentication:
    Connected as @username via GitHub OAuth  (or "Connected via personal access token")
    [Disconnect]
  
  [x] Remember token on disk
  
  Interval (min): [5]    Retention (days): [7]
  [Save Sync Settings]   [Sync Now]
```

## Implementation Steps

### Step 1: Add device flow helper module
**New file**: `extension/github-oauth.js` (loaded by `options.html` via `<script>`)
- `GITHUB_CLIENT_ID` constant
- `requestDeviceCode(scope)` — POST to `/login/device/code`
- `pollForToken(deviceCode, interval, expiresIn)` — poll `/login/oauth/access_token`, return promise that resolves with token or rejects on expiry/cancel. Accepts an `AbortSignal` for cancellation.
- `fetchGitHubUser(token)` — GET `/user`, return `{ login }` for display
- `getGitHubRevokeUrl()` — returns `https://github.com/settings/connections/applications/{client_id}` for manual revocation

### Step 2: Update token storage path
**File**: `extension/background.js`
- On startup: check `chrome.storage.session` first; if empty and `syncRememberToken` + `syncToken` exist in `settings.json`, load token into session
- `buildSyncManager`: read token from `chrome.storage.session` instead of `settings.syncToken`
- `updateSyncAlarm`: check `chrome.storage.session` for token presence
- Handle 401 from sync: clear session token, update sync status, stop alarm

**File**: `extension/utils.js`
- Add `getSessionToken()` / `setSessionToken(token)` helpers wrapping `chrome.storage.session`

**Settings fields** (in `manifest/settings.json`):
- `syncToken` — plaintext token (only when "Remember on disk" is on; cleared otherwise)
- `syncRememberToken` — boolean
- `syncAuthMethod` — `'oauth'` | `'pat'` | `null`
- `syncGitHubUser` — GitHub username for display (persisted, not sensitive)

### Step 3: Update settings UI
**File**: `extension/options.html`
- Replace token input section with the three-state UI (disconnected / device-flow / connected)
- Add "Remember on disk" checkbox
- Add device code display area (hidden by default)

**File**: `extension/options.js`
- Add `startDeviceFlow()` — calls transport helpers, manages polling loop, updates UI states
- Add `disconnectGitHub()` — clears token, revokes, resets UI
- Update `syncSaveBtn` handler to read token from session instead of input
- Show/hide sync config fields based on auth state (not just `syncEnabled`)

### Step 4: Handle auth failures
**File**: `extension/background.js`
- In `executeSyncCycle`: if transport returns 401, clear session token, set sync status to "auth_expired", stop alarm
- Surface `auth_expired` status to UI via existing sync status mechanism

### Step 5: Tests
- Unit test: device flow polling (mock fetch, test success/expiry/cancel)
- Unit test: token storage (session vs disk, startup loading)
- Unit test: revocation on disconnect
- E2E test: sync settings UI state transitions (disconnected → device flow → connected → disconnect)
- E2E test: auth failure surfaces reconnect message
