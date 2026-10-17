param(
  [Parameter(Mandatory = $true)][ValidateSet('check', 'sign', 'verify')][string]$Action,
  [string]$File
)
$ErrorActionPreference = 'Stop'
$thumbprint = $env:WINDOWS_SIGNING_CERTIFICATE
if ($thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'WINDOWS_SIGNING_CERTIFICATE must be a SHA-1 certificate thumbprint' }
$certificate = Get-Item "Cert:\CurrentUser\My\$thumbprint"
if (!$certificate.HasPrivateKey -or $certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date)) {
  throw 'The selected code-signing certificate needs a private key and must be currently valid'
}
if ('1.3.6.1.5.5.7.3.3' -notin $certificate.EnhancedKeyUsageList.ObjectId) { throw 'The selected certificate does not allow code signing' }
if ($Action -eq 'check') { return }
if (!$File) { throw 'Signing or verification requires an executable path' }
if ($Action -eq 'sign') {
  $options = @{ LiteralPath = $File; Certificate = $certificate; HashAlgorithm = 'SHA256' }
  if ($env:WINDOWS_SIGNING_TIMESTAMP_URL) { $options.TimestampServer = $env:WINDOWS_SIGNING_TIMESTAMP_URL }
  $signature = Set-AuthenticodeSignature @options
} else { $signature = Get-AuthenticodeSignature -LiteralPath $File }
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $thumbprint) {
  throw "Executable signature verification failed: $($signature.Status): $($signature.StatusMessage)"
}
