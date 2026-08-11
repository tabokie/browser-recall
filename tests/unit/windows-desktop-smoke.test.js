import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isolatedDesktopEnvironment,
  isolatedDesktopLogDir,
} from '../smoke/windows-desktop-test-profile.mjs';

describe('Windows desktop native smoke profile', () => {
  it('routes app state into a disposable profile and disables OS registration', () => {
    const profileDir = path.resolve('temporary-browser-recall-profile');
    const environment = isolatedDesktopEnvironment(
      {
        APPDATA: 'C:\\Users\\real\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local',
      },
      profileDir,
    );

    expect(environment.BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR).toBe(
      profileDir,
    );
    expect(environment.BROWSER_RECALL_SKIP_DEEP_LINK_REGISTRATION).toBe('1');
    expect(environment.BROWSER_RECALL_SKIP_LOGIN_ITEM_REGISTRATION).toBe('1');
    expect(environment.WEBVIEW2_USER_DATA_FOLDER).toBe(
      path.join(profileDir, 'webview2'),
    );
    expect(isolatedDesktopLogDir(profileDir)).toBe(
      path.join(profileDir, 'logs'),
    );
  });

  it('rejects a relative profile that could escape into the checkout', () => {
    expect(() => isolatedDesktopEnvironment({}, 'relative-profile')).toThrow(
      /absolute/,
    );
  });
});
