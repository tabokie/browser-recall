import {
  cleanupStagedAssets,
  createStagedExtensionDir,
} from '../../scripts/stage-app-assets.mjs';

export function createTestExtensionDir(
  prefix = 'browser-recall-test-extension-',
) {
  return createStagedExtensionDir(prefix);
}

export function cleanupTestExtensionDir(extensionDir) {
  cleanupStagedAssets(extensionDir);
}
