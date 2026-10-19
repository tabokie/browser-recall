function Read-WindowsUpdateEnvironmentSnapshot {
  param([string]$StatePath)

  # Windows PowerShell 5.1 emits the whole JSON array as one pipeline object.
  # Wrapping that output in @() nests the entries inside an extra array.
  ConvertFrom-Json ([System.IO.File]::ReadAllText($StatePath))
}
