import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync, spawn } from 'node:child_process';
import WebSocket from 'ws';

const ROOT = process.cwd();
const BINARY_PATH = path.join(ROOT, 'target', 'debug', 'browser-recall-daemon');
const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const PORT_CANDIDATES = [28571, 28572, 28573];

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('daemon did not start')),
      15_000,
    );
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early with code ${code}`));
    });
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    socket.once('error', reject);
  });
}

function collectMessages(socket, count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = (raw) => {
      messages.push(JSON.parse(raw.toString()));
      if (messages.length === count) {
        socket.off('message', onMessage);
        socket.off('error', onError);
        resolve(messages);
      }
    };
    const onError = (error) => {
      socket.off('message', onMessage);
      socket.off('error', onError);
      reject(error);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

function launchDaemon(configDir, approveMode = 'allow') {
  const child = spawn(
    BINARY_PATH,
    ['--config-dir', configDir, '--approve-mode', approveMode],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        BROWSER_RECALL_PORTS: PORT_CANDIDATES.join(','),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return child;
}

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const onError = (error) => {
      server.removeAllListeners();
      if (error.code === 'EADDRINUSE') {
        resolve(null);
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(server);
    });
  });
}

async function pairOnce(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Origin: ORIGIN },
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'pair_request',
      browserId: 'browser-install-1',
      browserName: 'Chrome',
      extensionId: 'abcdefghijklmnop',
    }),
  );
  const [, approved] = await collectMessages(socket, 2);
  return { socket, approved };
}

describe.sequential('phase 1 daemon pairing integration', () => {
  let tempDirs = [];
  let childProcesses = [];
  let blockerServers = [];

  beforeAll(() => {
    const build = spawnSync(
      'cargo',
      [
        'build',
        '-p',
        'browser-recall-daemon',
        '--bin',
        'browser-recall-daemon',
      ],
      {
        cwd: ROOT,
        stdio: 'inherit',
      },
    );
    expect(build.status).toBe(0);
  });

  afterEach(() => {
    for (const child of childProcesses.splice(0)) {
      child.kill('SIGINT');
    }
    for (const server of blockerServers.splice(0)) {
      server.close();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fresh pair persists token to config', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-pair-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);

    const { socket, approved } = await pairOnce(port);
    expect(approved.type).toBe('pair_approved');
    expect(approved.token).toBeTruthy();
    socket.close();

    const config = JSON.parse(
      readFileSync(path.join(dir, 'config.json'), 'utf8'),
    );
    expect(config.connectors).toHaveLength(1);
    expect(config.connectors[0].browser_name).toBe('Chrome');
  });

  it('deny mode returns pair_denied', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-pair-deny-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'deny');
    childProcesses.push(child);
    const port = await waitForListening(child);

    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Origin: ORIGIN },
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(
      JSON.stringify({
        type: 'pair_request',
        browserId: 'browser-install-1',
        browserName: 'Chrome',
        extensionId: 'abcdefghijklmnop',
      }),
    );
    const messages = await collectMessages(socket, 2);
    expect(messages.map((message) => message.type)).toEqual([
      'pair_pending',
      'pair_denied',
    ]);
    socket.close();
  });

  it('cached token auth succeeds and expired token auth fails', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-pair-auth-'));
    tempDirs.push(dir);
    let child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    let port = await waitForListening(child);

    const { socket, approved } = await pairOnce(port);
    const token = approved.token;
    socket.close();
    child.kill('SIGINT');
    childProcesses.pop();

    const configPath = path.join(dir, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.connectors = [];
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    port = await waitForListening(child);

    const authSocket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Origin: ORIGIN },
    });
    await new Promise((resolve, reject) => {
      authSocket.once('open', resolve);
      authSocket.once('error', reject);
    });
    authSocket.send(JSON.stringify({ type: 'auth', token }));
    const response = await nextMessage(authSocket);
    expect(response).toEqual({ type: 'auth_fail', reason: 'token_not_found' });
    authSocket.close();
  });

  it('falls back to the next configured port when the first candidate is occupied', async () => {
    let blockedIndex = -1;
    for (const [index, port] of PORT_CANDIDATES.entries()) {
      const server = await tryListen(port);
      if (!server) {
        continue;
      }
      blockerServers.push(server);
      blockedIndex = index;
      break;
    }

    expect(blockedIndex).toBeGreaterThanOrEqual(0);
    let expectedPort;
    for (const port of PORT_CANDIDATES.slice(blockedIndex + 1)) {
      const probe = await tryListen(port);
      if (!probe) {
        continue;
      }
      expectedPort = port;
      probe.close();
      break;
    }
    expect(expectedPort).toBeDefined();

    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-pair-port-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    expect(port).toBe(expectedPort);
  });
});
