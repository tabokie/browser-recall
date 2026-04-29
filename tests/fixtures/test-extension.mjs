import {
  cleanupStagedAssets,
  createStagedExtensionDir,
} from '../../scripts/stage-app-assets.mjs';
import fs from 'fs';
import path from 'path';
import { DAEMON_PORTS } from '../../scripts/lib/desktop-test-runtime.mjs';

function pinTestConnectorPorts(extensionDir) {
  const clientPath = path.join(extensionDir, 'connector', 'ws-client.js');
  const source = fs.readFileSync(clientPath, 'utf8');
  fs.writeFileSync(
    clientPath,
    `globalThis.__BROWSER_RECALL_CONNECTOR_PORTS = ${JSON.stringify(DAEMON_PORTS)};\n${source}`,
  );
}

export function createTestExtensionDir(
  prefix = 'browser-recall-test-extension-',
) {
  const extensionDir = createStagedExtensionDir(prefix);
  pinTestConnectorPorts(extensionDir);
  return extensionDir;
}

export function cleanupTestExtensionDir(extensionDir) {
  cleanupStagedAssets(extensionDir);
}
