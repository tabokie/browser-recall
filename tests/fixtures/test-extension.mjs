import {
  cleanupStagedAssets,
  createStagedExtensionDir,
} from '../../scripts/stage-app-assets.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DAEMON_PORTS } from '../../scripts/lib/desktop-test-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const extensionSourceDir = path.join(repoRoot, 'apps/extension');
const TEST_CONTROL_FILES = [
  'background-test-actions.js',
  'background-test-control.js',
];

function pinTestConnectorPorts(extensionDir) {
  const clientPath = path.join(extensionDir, 'connector', 'ws-client.js');
  const source = fs.readFileSync(clientPath, 'utf8');
  fs.writeFileSync(
    clientPath,
    `globalThis.__BROWSER_RECALL_CONNECTOR_PORTS = ${JSON.stringify(DAEMON_PORTS)};\n${source}`,
  );
}

function copyBackgroundTestControl(extensionDir) {
  for (const file of TEST_CONTROL_FILES) {
    fs.copyFileSync(
      path.join(extensionSourceDir, file),
      path.join(extensionDir, file),
    );
  }
}

function enableBackgroundTestControl(extensionDir) {
  copyBackgroundTestControl(extensionDir);
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.background?.service_worker === 'background.js') {
    const shimPath = path.join(extensionDir, 'background-test.js');
    fs.writeFileSync(
      shimPath,
      "import './background-test-actions.js';\nimport './background.js';\nimport './background-test-control.js';\n",
    );
    manifest.background.service_worker = 'background-test.js';
  } else if (Array.isArray(manifest.background?.scripts)) {
    manifest.background.scripts = [
      'background-test-actions.js',
      ...manifest.background.scripts,
      'background-test-control.js',
    ];
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function createTestExtensionDir(
  prefix = 'browser-recall-test-extension-',
) {
  const extensionDir = createStagedExtensionDir(prefix);
  pinTestConnectorPorts(extensionDir);
  enableBackgroundTestControl(extensionDir);
  return extensionDir;
}

export function cleanupTestExtensionDir(extensionDir) {
  cleanupStagedAssets(extensionDir);
}
