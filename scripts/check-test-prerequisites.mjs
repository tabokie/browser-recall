import { runPowerShell } from '../tests/smoke/powershell-process.mjs';

try {
  const version = await runPowerShell([
    '-Command',
    '$ErrorActionPreference = "Stop"; $PSVersionTable.PSVersion.ToString()',
  ]);
  console.log(`PowerShell ${version.trim()} is available for the test suite.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
