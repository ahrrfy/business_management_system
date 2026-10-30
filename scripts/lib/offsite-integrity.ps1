# Shared by pull and health; compatible with Windows PowerShell 5.1. ASCII only.
function Assert-BackupName([string]$Name) {
  if ($Name -cnotmatch '^[A-Za-z0-9_$-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3}Z-[0-9a-f]{8})?\.sql\.gpg$') {
    throw 'Invalid backup filename'
  }
}

function Read-BackupManifest([string]$Json, [string]$Name) {
  Assert-BackupName $Name
  $m = $Json | ConvertFrom-Json
  if ($m.version -ne 1 -or $m.file -isnot [string] -or $m.sha256 -isnot [string] -or $m.file -cne $Name -or
      $m.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      $m.size -is [string] -or $null -eq $m.size -or
      [decimal]$m.size -le 0 -or [decimal]$m.size -ne [math]::Truncate([decimal]$m.size)) {
    throw 'Invalid backup integrity manifest'
  }
  return $m
}

function Assert-BackupIntegrity([string]$Path, $Manifest) {
  $f = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $f.Length -ne $Manifest.size) {
    throw 'Backup size or file type mismatch'
  }
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Manifest.sha256) {
    throw 'Backup SHA256 mismatch'
  }
}

function Get-BackupAgeHours([string]$Name) {
  Assert-BackupName $Name
  $stamp = [regex]::Match($Name, '\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}').Value
  $utc = [datetime]::ParseExact($stamp, "yyyy-MM-dd'T'HH-mm-ss", [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
  $age = ([datetime]::UtcNow - $utc).TotalHours
  if ($age -lt -0.083334) { throw 'Backup timestamp is in the future' }
  return $age
}

function Open-BackupLock([string]$Directory) {
  return [IO.File]::Open((Join-Path $Directory '.offsite.lock'), [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
}
