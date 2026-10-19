import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runTestProcess } from '../smoke/windows-desktop-process.mjs';

// Certificate-store changes are restricted to disposable GitHub runners.
test.skipIf(
  process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true',
)(
  'Windows CI signs a real executable with a disposable certificate and rejects tampering',
  async () => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-authenticode-'),
    );
    try {
      const script = String.raw`
using namespace System.Security.Cryptography
using namespace System.Security.Cryptography.X509Certificates

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
try {
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  if (!$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Windows signing validation requires an elevated disposable GitHub runner'
  }
} finally { $identity.Dispose() }
$cert = $null
$generated = $null
$publicCert = $null
$rootInstalled = $false
$personalInstalled = $false
# .NET Framework's RSACryptoServiceProvider.KeySize is read-only. Select the
# size in the constructor rather than assigning KeySize after RSA.Create().
$rsa = [RSACryptoServiceProvider]::new(2048)
# CurrentUser\Root additions and removals can display a native confirmation
# dialog even under -NonInteractive. The elevated disposable runner can update
# LocalMachine\Root without that dialog; keep the private key in CurrentUser\My.
$rootStore = [X509Store]::new('Root', 'LocalMachine')
$personalStore = [X509Store]::new('My', 'CurrentUser')
try {
  # Windows system executables can remain catalog-signed after adding an
  # embedded signature. Compile a fresh executable with no catalog identity.
  Write-Output 'Compiling unsigned executable fixture'
  $file = Join-Path $env:BROWSER_RECALL_SIGNING_WORK 'fixture.exe'
  $fixtureSource = Join-Path $env:BROWSER_RECALL_SIGNING_WORK 'fixture.cs'
  [System.IO.File]::WriteAllText($fixtureSource, 'public static class SigningFixture { public static int Main() { return 0; } }')
  $compiler = Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
  & $compiler /nologo /target:exe /platform:x64 "/out:$file" $fixtureSource
  if ($LASTEXITCODE -ne 0) { throw "Signing fixture compilation failed: exit $LASTEXITCODE" }
  $initialSignature = Get-AuthenticodeSignature -LiteralPath $file
  if ($initialSignature.Status -ne 'NotSigned') {
    throw "Signing fixture must start unsigned: $($initialSignature.Status), $($initialSignature.SignatureType), signer $($initialSignature.SignerCertificate.Thumbprint)"
  }
  Write-Output 'Creating disposable code-signing certificate'
  # New-SelfSignedCertificate stalls on the Windows CI runner. Generate a fresh
  # software key and certificate directly, without loading the PKI module.
  $request = [CertificateRequest]::new('CN=Browser Recall disposable CI signing', $rsa, [HashAlgorithmName]::SHA256, [RSASignaturePadding]::Pkcs1)
  $usages = [OidCollection]::new()
  [void]$usages.Add([Oid]::new('1.3.6.1.5.5.7.3.3'))
  $request.CertificateExtensions.Add([X509EnhancedKeyUsageExtension]::new($usages, $false))
  $request.CertificateExtensions.Add([X509KeyUsageExtension]::new([X509KeyUsageFlags]::DigitalSignature, $true))
  $generated = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(1))
  # Import the private key into the user profile so the production script can
  # read the certificate from My. Disposing this import also deletes its key.
  $rootStore.Open('ReadWrite')
  $personalStore.Open('ReadWrite')
  $cert = [X509Certificate2]::new($generated.Export([X509ContentType]::Pfx), [string]::Empty, [X509KeyStorageFlags]::UserKeySet)
  $publicCert = [X509Certificate2]::new($cert.RawData)
  Write-Output 'Installing signing certificate in CurrentUser\My'
  $personalStore.Add($cert)
  $personalInstalled = $true
  Write-Output 'Installing public certificate in LocalMachine\Root'
  $rootStore.Add($publicCert)
  $rootInstalled = $true
  Write-Output 'Disposable signing certificate installed and trusted'
  $env:WINDOWS_SIGNING_CERTIFICATE = $cert.Thumbprint
  Remove-Item Env:WINDOWS_SIGNING_TIMESTAMP_URL -ErrorAction SilentlyContinue
  Write-Output 'Verifying a valid signature from another signer is rejected'
  $otherSignerRejected = $false
  try { & $env:BROWSER_RECALL_SIGNING_SCRIPT verify (Join-Path $env:WINDIR 'System32\where.exe') } catch {
    if ($_.Exception.Message -notlike 'Executable signer mismatch:*') { throw }
    $otherSignerRejected = $true
  }
  if (!$otherSignerRejected) { throw 'The verifier accepted an executable signed by another certificate' }
  foreach ($action in @('check', 'sign', 'verify')) {
    Write-Output "Code-signing action: $action"
    Remove-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue
    if (Get-PSDrive Cert -ErrorAction SilentlyContinue) { throw 'Certificate provider must be unloaded before signing' }
    & $env:BROWSER_RECALL_SIGNING_SCRIPT $action $file
  }
  $bytes = [System.IO.File]::ReadAllBytes($file)
  # Change section data, leaving the PE headers and certificate table intact.
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
  $sectionTable = $peOffset + 24 + [BitConverter]::ToUInt16($bytes, $peOffset + 20)
  $sectionData = [BitConverter]::ToUInt32($bytes, $sectionTable + 20)
  $bytes[$sectionData] = $bytes[$sectionData] -bxor 1
  [System.IO.File]::WriteAllBytes($file, $bytes)
  $rejected = $false
  Write-Output 'Verifying tampering is rejected'
  try { & $env:BROWSER_RECALL_SIGNING_SCRIPT verify $file } catch {
    if ($_.Exception.Message -notlike 'Executable signature verification failed: HashMismatch:*') { throw }
    $rejected = $true
  }
  if (!$rejected) { throw 'The verifier accepted a tampered executable' }
  Write-Output 'Signed executable verified; tampering rejected'
} finally {
  Write-Output 'Removing disposable code-signing certificate'
  try {
    if ($rootInstalled) { $rootStore.Remove($publicCert) }
  } finally {
    try {
      if ($personalInstalled) { $personalStore.Remove($cert) }
    } finally {
      $personalStore.Close()
      $rootStore.Close()
      if ($publicCert) { $publicCert.Dispose() }
      if ($cert) { $cert.Dispose() }
      if ($generated) { $generated.Dispose() }
      $rsa.Dispose()
    }
  }
}
`;
      // Pass one encoded argument rather than multiline Windows command-line
      // syntax. Keep the event loop responsive so Vitest can enforce its own
      // deadline, and terminate a stalled PowerShell process before that deadline.
      const stdout = await runTestProcess(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        {
          env: {
            ...process.env,
            BROWSER_RECALL_SIGNING_WORK: work,
            BROWSER_RECALL_SIGNING_SCRIPT: path.resolve(
              'scripts/windows-code-signing.ps1',
            ),
          },
        },
      );
      expect(stdout).toContain(
        'Signed executable verified; tampering rejected',
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
