import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const BINARY_PATH = path.join(ROOT, 'target', 'debug', 'browser-recall-daemon');
const BUILD_PROMISE = Symbol.for('browser-recall.integration-daemon-build');
const TEST_CONTROL_MESSAGE_TYPES = new Set([
  'clear_all_data',
  'replay_remote_entries',
  'set_device_id',
  'get_all_pages',
  'get_entity',
  'permanent_delete',
  'event',
  'run_rule_batch',
  'preview_rule',
  'search_notes',
  'search_snapshots',
  'test_reset_data',
  'test_seed_data',
  'note',
  'list_history_files',
  'load_history_batch',
]);

export function installTestControlWireAdapter(socket) {
  const send = socket.send.bind(socket);
  socket.send = (data, ...args) => {
    if (typeof data !== 'string') return send(data, ...args);
    const request = JSON.parse(data);
    if (!TEST_CONTROL_MESSAGE_TYPES.has(request.type)) {
      return send(data, ...args);
    }
    const type =
      request.type === 'test_reset_data'
        ? 'reset_data'
        : request.type === 'test_seed_data'
          ? 'seed_data'
          : request.type;
    return send(
      JSON.stringify({
        type: 'test_control',
        request: { ...request, type },
      }),
      ...args,
    );
  };
  return socket;
}

export function ensureTestDaemonBuilt() {
  // Deduplicate only an in-flight build; retaining a successful build marker
  // would let watch-mode reruns execute a stale daemon binary.
  if (process[BUILD_PROMISE]) return process[BUILD_PROMISE];
  const build = new Promise((resolve, reject) => {
    const cargoCommand = process.env.BROWSER_RECALL_TEST_CARGO || 'cargo';
    const cargoArgs = [
      'build',
      '-p',
      'browser-recall-daemon',
      '--bin',
      'browser-recall-daemon',
    ];
    if (process.env.BROWSER_RECALL_TEST_CARGO_SCRIPT) {
      cargoArgs.unshift(process.env.BROWSER_RECALL_TEST_CARGO_SCRIPT);
    }
    const child = spawn(cargoCommand, cargoArgs, {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `daemon build failed with ${signal ? `signal ${signal}` : `code ${code}`}`,
        ),
      );
    });
  });
  process[BUILD_PROMISE] = build.finally(() => {
    delete process[BUILD_PROMISE];
  });
  return process[BUILD_PROMISE];
}

export function launchTestDaemon(
  configDir,
  { ports, approveMode = 'allow', testControl = false },
) {
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error('launchTestDaemon requires at least one port');
  }
  const args = [
    '--config-dir',
    configDir,
    '--data-dir',
    path.join(configDir, 'browser-data'),
    '--approve-mode',
    approveMode,
  ];
  if (testControl) args.push('--test-control');
  return spawn(BINARY_PATH, args, {
    cwd: ROOT,
    env: { ...process.env, BROWSER_RECALL_PORTS: ports.join(',') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function waitForDaemonListening(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    let errorOutput = '';
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onErrorData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (\d+)/);
      if (!match) return;
      cleanup();
      resolve(Number(match[1]));
    };
    const onError = (error) => fail(error);
    const onErrorData = (chunk) => {
      errorOutput += chunk.toString();
    };
    const onExit = (code, signal) =>
      fail(
        new Error(
          `daemon exited early with ${signal ? `signal ${signal}` : `code ${code}`}: ${errorOutput.trim() || 'no stderr output'}`,
        ),
      );
    const timer = setTimeout(
      () => fail(new Error('daemon did not start')),
      timeoutMs,
    );
    child.stdout.on('data', onData);
    child.stderr.on('data', onErrorData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

export async function stopTestDaemon(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Keep cleanup bounded: allow graceful shutdown, then force termination so
  // later tests cannot inherit occupied ports or live config-directory users.
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(forceTimer);
      clearTimeout(failureTimer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    const failureTimer = setTimeout(() => {
      cleanup();
      reject(new Error('daemon did not exit after SIGKILL'));
    }, timeoutMs + 2_000);
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      child.kill('SIGINT');
    } catch (error) {
      onError(error);
    }
  });
}

export function collectDaemonMessages(
  socket,
  count,
  { ignoreTypes = ['change'], timeoutMs = 15_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (ignoreTypes.includes(message.type)) return;
      messages.push(message);
      if (messages.length !== count) return;
      cleanup();
      resolve(messages);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`expected ${count} daemon message(s)`));
    }, timeoutMs);
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

export async function nextDaemonMessage(socket, options) {
  const [message] = await collectDaemonMessages(socket, 1, options);
  return message;
}
