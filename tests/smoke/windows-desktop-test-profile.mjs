import path from 'node:path';

function requireAbsoluteProfileDir(profileDir) {
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) {
    throw new Error('Windows desktop smoke profile must be an absolute path');
  }
  return profileDir;
}

export function isolatedDesktopEnvironment(baseEnvironment, profileDir) {
  const isolatedProfileDir = requireAbsoluteProfileDir(profileDir);

  return {
    ...baseEnvironment,
    BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR: isolatedProfileDir,
    BROWSER_RECALL_SKIP_DEEP_LINK_REGISTRATION: '1',
    BROWSER_RECALL_SKIP_LOGIN_ITEM_REGISTRATION: '1',
    WEBVIEW2_USER_DATA_FOLDER: path.join(isolatedProfileDir, 'webview2'),
  };
}

export function isolatedDesktopLogDir(profileDir) {
  return path.join(requireAbsoluteProfileDir(profileDir), 'logs');
}
