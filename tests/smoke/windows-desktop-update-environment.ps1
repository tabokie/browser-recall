param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('set', 'restore')]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$StatePath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-update-environment-snapshot.ps1')
if ($env:BROWSER_RECALL_ISOLATED_WINDOWS_SESSION -ne '1') {
  throw 'User environment changes require a disposable Windows session with BROWSER_RECALL_ISOLATED_WINDOWS_SESSION=1'
}
if (![System.IO.Path]::IsPathRooted($StatePath)) {
  throw 'Windows update environment backup path must be absolute'
}

# NSIS RunAsUser uses CreateProcessWithTokenW with a null environment on an
# elevated runner. Windows rebuilds that environment from the user's registry,
# dropping process-only overrides. Publish only the test's isolation variables.
$names = @(
  'BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR',
  'BROWSER_RECALL_SKIP_DEEP_LINK_REGISTRATION',
  'BROWSER_RECALL_SKIP_LOGIN_ITEM_REGISTRATION',
  'BROWSER_RECALL_PORTS',
  'WEBVIEW2_USER_DATA_FOLDER',
  'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'
)
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if (!$key) { throw 'Windows user environment registry key is unavailable' }
try {
  if ($Action -eq 'set') {
    $values = @{}
    $snapshot = @()
    foreach ($name in $names) {
      $value = [System.Environment]::GetEnvironmentVariable($name, 'Process')
      if ([string]::IsNullOrEmpty($value)) { throw "Missing Windows update environment variable: $name" }
      $values[$name] = $value
      $present = $key.GetValueNames() -contains $name
      $snapshot += [pscustomobject]@{
        name = $name
        present = $present
        value = if ($present) { $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
        kind = if ($present) { $key.GetValueKind($name).ToString() } else { $null }
      }
    }
    # Persist the complete rollback before changing any registry value. Refuse
    # to replace an earlier rollback, including after a partially failed setup.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $snapshot -Depth 4))
    $file = [System.IO.File]::Open($StatePath, [System.IO.FileMode]::CreateNew)
    try { $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
    foreach ($name in $names) {
      $key.SetValue($name, $values[$name], [Microsoft.Win32.RegistryValueKind]::String)
    }
  } else {
    $snapshot = Read-WindowsUpdateEnvironmentSnapshot $StatePath
    $failures = @()
    foreach ($entry in $snapshot) {
      try {
        if ($entry.present) {
          $kind = [Microsoft.Win32.RegistryValueKind][System.Enum]::Parse([Microsoft.Win32.RegistryValueKind], $entry.kind)
          $key.SetValue($entry.name, $entry.value, $kind)
        } else {
          $key.DeleteValue($entry.name, $false)
        }
      } catch {
        $failures += "$($entry.name): $($_.Exception.Message)"
      }
    }
    if ($failures.Count) { throw "Windows user environment restoration failed: $($failures -join '; ')" }
    Remove-Item -LiteralPath $StatePath
  }
} finally { $key.Dispose() }
