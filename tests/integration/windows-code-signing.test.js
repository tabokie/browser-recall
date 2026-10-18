import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

// Certificate-store changes are restricted to disposable GitHub runners.
test.skipIf(
  process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true',
)(
  'Windows CI signs a real executable with a disposable certificate and rejects tampering',
  () => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-authenticode-'),
    );
    try {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          String.raw`
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$cert = $null
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
try {
  $cert = New-SelfSignedCertificate -Subject 'CN=Browser Recall disposable CI signing' -Type CodeSigningCert -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(1)
  $store.Open('ReadWrite')
  $store.Add($cert)
  $env:WINDOWS_SIGNING_CERTIFICATE = $cert.Thumbprint
  Remove-Item Env:WINDOWS_SIGNING_TIMESTAMP_URL -ErrorAction SilentlyContinue
  $file = Join-Path $env:BROWSER_RECALL_SIGNING_WORK 'fixture.exe'
  Copy-Item (Join-Path $env:WINDIR 'System32\where.exe') $file
  foreach ($action in @('check', 'sign', 'verify')) {
    Remove-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue
    if (Get-PSDrive Cert -ErrorAction SilentlyContinue) { throw 'Certificate provider must be unloaded before signing' }
    & $env:BROWSER_RECALL_SIGNING_SCRIPT $action $file
  }
  $bytes = [System.IO.File]::ReadAllBytes($file)
  $bytes[512] = $bytes[512] -bxor 1
  [System.IO.File]::WriteAllBytes($file, $bytes)
  $rejected = $false
  try { & $env:BROWSER_RECALL_SIGNING_SCRIPT verify $file } catch { $rejected = $true }
  if (!$rejected) { throw 'The verifier accepted a tampered executable' }
  Write-Output 'Signed executable verified; tampering rejected'
} finally {
  if ($cert) {
    $store.Remove($cert)
    Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
  }
  $store.Close()
}
`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            BROWSER_RECALL_SIGNING_WORK: work,
            BROWSER_RECALL_SIGNING_SCRIPT: path.resolve(
              'scripts/windows-code-signing.ps1',
            ),
          },
        },
      );
      expect(output).toContain(
        'Signed executable verified; tampering rejected',
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
