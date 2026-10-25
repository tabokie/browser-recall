import { runTestProcess } from './windows-desktop-process.mjs';

export async function runPowerShell(args, { env = process.env } = {}) {
  const executable =
    env.BROWSER_RECALL_TEST_POWERSHELL ||
    (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
  try {
    return await runTestProcess(
      executable,
      ['-NoProfile', '-NonInteractive', ...args],
      { env, timeoutMs: 60_000 },
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `PowerShell is required for the portable Windows environment rollback checks. Install PowerShell (see DEVELOPMENT.md) or set BROWSER_RECALL_TEST_POWERSHELL to its executable. Could not start: ${executable}`,
        { cause: error },
      );
    }
    throw error;
  }
}
