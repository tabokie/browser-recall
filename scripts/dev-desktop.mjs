import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { requireIsolatedMacosSession } from './lib/macos-native-session.mjs';

requireIsolatedMacosSession();
const require = createRequire(import.meta.url);
const child = spawn(
  process.execPath,
  [
    require.resolve('@tauri-apps/cli/tauri.js'),
    'dev',
    ...process.argv.slice(2),
  ],
  {
    cwd: fileURLToPath(new URL('../apps/desktop/', import.meta.url)),
    stdio: 'inherit',
  },
);
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
