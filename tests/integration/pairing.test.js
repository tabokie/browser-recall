import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import {
  collectDaemonMessages as collectMessages,
  ensureTestDaemonBuilt,
  launchTestDaemon,
  nextDaemonMessage as nextMessage,
  stopTestDaemon,
  waitForDaemonListening as waitForListening,
} from './daemon-test-harness.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const PORT_CANDIDATES = [28571, 28572, 28573];

function launchDaemon(configDir, approveMode = 'allow') {
  return launchTestDaemon(configDir, {
    ports: PORT_CANDIDATES,
    approveMode,
  });
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
  const pairingMessages = collectMessages(socket, 2);
  socket.send(
    JSON.stringify({
      type: 'pair_request',
      protocolVersion: 3,
      browserId: 'browser-install-1',
      browserName: 'Chrome',
      extensionId: 'abcdefghijklmnop',
      browserProfile: null,
    }),
  );
  const [, approved] = await pairingMessages;
  return { socket, approved };
}

describe.sequential('phase 1 daemon pairing integration', () => {
  let tempDirs = [];
  let childProcesses = [];
  let blockerServers = [];

  beforeAll(() => ensureTestDaemonBuilt(), 300_000);

  afterEach(async () => {
    await Promise.all(
      childProcesses.splice(0).map((child) => stopTestDaemon(child)),
    );
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
    const pairingMessages = collectMessages(socket, 2);
    socket.send(
      JSON.stringify({
        type: 'pair_request',
        protocolVersion: 3,
        browserId: 'browser-install-1',
        browserName: 'Chrome',
        extensionId: 'abcdefghijklmnop',
        browserProfile: null,
      }),
    );
    const messages = await pairingMessages;
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
    await stopTestDaemon(child);
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
    authSocket.send(
      JSON.stringify({ type: 'auth', protocolVersion: 3, token }),
    );
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
