import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '../..');
export const DAEMON_PORTS = [39471, 39472, 39473];

export async function startDaemon() {
  const configDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-recall-daemon-test-'),
  );
  const command = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const child = spawn(
    command,
    [
      'run',
      '--quiet',
      '-p',
      'browser-recall-daemon',
      '--',
      '--config-dir',
      configDir,
      '--test-control',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        BROWSER_RECALL_PORTS: DAEMON_PORTS.join(','),
        RUST_LOG: process.env.RUST_LOG || 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for daemon startup.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, 30000);

    const handleStdout = (chunk) => {
      const match = chunk.match(/listening on (\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off('data', handleStdout);
      resolve(Number(match[1]));
    };

    child.stdout.on('data', handleStdout);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      child.stdout.off('data', handleStdout);
      reject(
        new Error(
          `Daemon exited before startup (code=${code}, signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });

  async function stop() {
    if (child.exitCode != null) {
      fs.rmSync(configDir, { recursive: true, force: true });
      return;
    }
    child.kill('SIGINT');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  return {
    child,
    configDir,
    dataDir: path.join(configDir, 'portal-data'),
    port,
    stop,
  };
}

export async function waitForExtensionId(context) {
  const page = await context.newPage();
  const startedAt = Date.now();
  try {
    const session = await context.newCDPSession(page);
    while (Date.now() - startedAt < 10000) {
      const { targetInfos } = await session.send('Target.getTargets');
      for (const target of targetInfos) {
        const match = target.url?.match(/^chrome-extension:\/\/([a-z]{32})\//);
        if (match) return match[1];
      }
      await page
        .goto('https://example.com', {
          waitUntil: 'domcontentloaded',
          timeout: 5000,
        })
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await page.close().catch(() => {});
  }
  throw new Error(
    'Timed out waiting for extension ID via CDP target discovery',
  );
}

export async function waitForDesktopConnector(
  extContext,
  extensionId,
  expectedPort = null,
) {
  const page = await extContext.newPage();
  try {
    const helperUrl = `chrome-extension://${extensionId}/test-helper.html`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await page.goto(helperUrl);
        break;
      } catch (error) {
        const message = String(error?.message || error);
        const retryableNavigation =
          message.includes('options-stub.html') ||
          (message.includes('is interrupted by another navigation') &&
            message.includes(helperUrl));
        if (attempt === 2 || !retryableNavigation) {
          throw error;
        }
        await page
          .waitForLoadState('domcontentloaded', { timeout: 1000 })
          .catch(() => {});
        if (page.url() === helperUrl) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await page.waitForFunction(
      () => typeof chrome !== 'undefined' && chrome.runtime,
      { timeout: 5000 },
    );
    let connectTriggered = false;
    if (expectedPort) {
      await page.evaluate(async (port) => {
        await chrome.storage.local.remove([
          'connectorDeviceId',
          'connectorAuthToken',
        ]);
        await chrome.storage.local.set({ connectorDaemonPort: port });
        await chrome.runtime.sendMessage({ action: 'connectDesktopBridge' });
      }, expectedPort);
      connectTriggered = true;
    }
    const startedAt = Date.now();
    let lastState = null;
    while (Date.now() - startedAt < 15000) {
      const state = await page.evaluate(async () => {
        const request = chrome.runtime
          .sendMessage({ action: 'getDesktopConnectorState' })
          .catch((error) => ({
            success: false,
            state: 'error',
            error: error?.message || String(error),
          }));
        const timeout = new Promise((resolve) =>
          setTimeout(() => resolve({ success: false, state: 'timeout' }), 1000),
        );
        return Promise.race([request, timeout]);
      });
      lastState = state;
      const onExpectedPort = !expectedPort || state?.port === expectedPort;
      if (state?.state === 'connected' && state?.deviceId && onExpectedPort) {
        return;
      }
      if (!connectTriggered && state?.state !== 'pair_pending') {
        connectTriggered = true;
        await page.evaluate(async (port) => {
          if (port) {
            await chrome.storage.local.remove([
              'connectorDeviceId',
              'connectorAuthToken',
            ]);
            await chrome.storage.local.set({ connectorDaemonPort: port });
          }
          const request = chrome.runtime
            .sendMessage({ action: 'connectDesktopBridge' })
            .catch((error) => ({
              success: false,
              error: error?.message || String(error),
            }));
          const timeout = new Promise((resolve) =>
            setTimeout(
              () => resolve({ success: false, state: 'timeout' }),
              1000,
            ),
          );
          return Promise.race([request, timeout]);
        }, expectedPort);
      }
      await page.waitForTimeout(200);
    }
    throw new Error(
      `Timed out waiting for desktop connector: ${JSON.stringify(lastState)}`,
    );
  } finally {
    await page.close().catch(() => {});
  }
}
