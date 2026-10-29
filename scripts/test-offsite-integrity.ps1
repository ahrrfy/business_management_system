# Runs real pull/health scripts with in-process transport doubles. No network or deletion.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/offsite-integrity.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('erp-offsite-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$shell = (Get-Process -Id $PID).Path
$stamp = [datetime]::UtcNow.ToString("yyyy-MM-dd'T'HH-mm-ss")
$name = "erp_test-$stamp.sql.gpg"
$runner = Join-Path $root 'runner.ps1'
@'
param($Scripts, $Fixture, $Mode, $Scenario)
$ErrorActionPreference = 'Stop'
$global:manifestReads = 0
function global:ssh {
  $command = $args[-1]
  $global:LASTEXITCODE = 0
  if ($command -like 'ls *') {
    Get-ChildItem (Join-Path $Fixture 'remote') -Filter *.sql.gpg | ForEach-Object { '/fake/' + $_.Name }
    return
  }
  $global:manifestReads++
  $n = ($command -split '/')[-1].Trim("'")
  $path = Join-Path (Join-Path $Fixture 'remote') $n
  if (-not (Test-Path $path)) { $global:LASTEXITCODE = 1; return }
  $s = Get-Content $path -Raw
  if ($Scenario -eq 'changing' -and $global:manifestReads -gt 1) {
    $m = $s | ConvertFrom-Json; $m.size++; $s = $m | ConvertTo-Json
  }
  return $s
}
function global:scp {
  $global:LASTEXITCODE = 0
  $destination = $args[-1]
  $name = ($args[-2] -split '/')[-1]
  Add-Content (Join-Path $Fixture 'transfers.txt') $name
  if ($Scenario -eq 'partial') {
    [IO.File]::WriteAllText($destination, 'part'); $global:LASTEXITCODE = 1; return
  }
  if ($Scenario -eq 'mismatch') {
    [IO.File]::WriteAllText($destination, 'incorrect'); return
  }
  Copy-Item -LiteralPath (Join-Path (Join-Path $Fixture 'remote') $name) -Destination $destination
}
function global:Invoke-WebRequest { return [pscustomobject]@{StatusCode=200} }
if ($Mode -eq 'pull') {
  & (Join-Path $Scripts 'pull-vps-backup.ps1') -SshHost fake -RemoteDir /fake -LocalDir (Join-Path $Fixture 'local')
} else {
  & (Join-Path $Scripts 'health-check-local.ps1') -SiteUrl http://never-contact.invalid -BackupDir (Join-Path $Fixture 'local') -NoToast
}
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $runner -Encoding ASCII

function Assert($Condition, [string]$Message) { if (-not $Condition) { throw "ASSERT: $Message" } }
function Fixture([string]$Scenario) {
  $dir = Join-Path $root $Scenario
  New-Item -ItemType Directory -Path (Join-Path $dir 'remote'),(Join-Path $dir 'local') | Out-Null
  $file = Join-Path (Join-Path $dir 'remote') $name
  [IO.File]::WriteAllText($file, ('synthetic encrypted bytes ' * 30))
  $manifest = @{version=1;file=$name;size=(Get-Item $file).Length;sha256=(Get-FileHash $file).Hash.ToLowerInvariant()}
  $manifest | ConvertTo-Json | Set-Content "$file.manifest.json" -Encoding ASCII
  return $dir
}
function Run([string]$Dir, [string]$Mode, [string]$Scenario, [bool]$Success) {
  $log = Join-Path $Dir ("$Mode-$Scenario-$([guid]::NewGuid().ToString('N')).log")
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue' # PS5.1 maps expected native stderr to ErrorRecords.
    & $shell -NoProfile -ExecutionPolicy Bypass -File $runner $PSScriptRoot $Dir $Mode $Scenario *> $log
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  Assert (($code -eq 0) -eq $Success) "$Mode/$Scenario exit=$code expectedSuccess=$Success log=$log"
}

$dir = Fixture 'interrupted'
Run $dir pull partial $false
Assert (-not (Test-Path (Join-Path "$dir/local" $name))) 'partial transfer became final'
Run $dir pull valid $true
Run $dir health valid $true
Run $dir pull valid $true
Assert (@(Get-Content "$dir/transfers.txt").Count -eq 2) 'valid existing file should not retransfer'

$dir = Fixture 'corrupt-existing'
$local = Join-Path "$dir/local" $name
[IO.File]::WriteAllText($local, 'bad')
Run $dir health valid $false
Run $dir pull valid $true
Assert (@(Get-ChildItem "$local.unverified-*").Count -eq 1) 'suspect original not preserved'
Run $dir health valid $true
[IO.File]::WriteAllText($local, ('x' * (Get-Item $local).Length))
Run $dir health valid $false

foreach ($scenario in @('mismatch','changing')) {
  $dir = Fixture $scenario
  Run $dir pull $scenario $false
  Run $dir health valid $false
}
$dir = Fixture 'missing-manifest'
$manifestPath = Join-Path "$dir/remote" "$name.manifest.json"
Move-Item -LiteralPath $manifestPath -Destination "$manifestPath.held"
Run $dir pull valid $false

$dir = Fixture 'malformed-manifest'
$manifestPath = Join-Path "$dir/remote" "$name.manifest.json"
'{"version":1,"file":"../escape","size":1,"sha256":"bad"}' | Set-Content $manifestPath -Encoding ASCII
Run $dir pull valid $false

$dir = Fixture 'backfill-failure'
[IO.File]::WriteAllText((Join-Path "$dir/remote" 'erp_test-2020-01-01T00-00-00.sql.gpg'), 'old unverified')
Run $dir pull valid $true
Run $dir health valid $true

$dir = Fixture 'stale'
$oldName = 'erp_test-2020-01-01T00-00-00.sql.gpg'
$oldFile = Join-Path "$dir/remote" $oldName
Move-Item -LiteralPath (Join-Path "$dir/remote" $name) -Destination $oldFile
$m = Get-Content (Join-Path "$dir/remote" "$name.manifest.json") -Raw | ConvertFrom-Json
$m.file = $oldName
$m | ConvertTo-Json | Set-Content "$oldFile.manifest.json" -Encoding ASCII
Run $dir pull valid $false
Copy-Item -LiteralPath $oldFile -Destination "$dir/local"
Copy-Item -LiteralPath "$oldFile.manifest.json" -Destination "$dir/local"
Run $dir health valid $false

$dir = Fixture 'lock'
$lock = Open-BackupLock "$dir/local"
try { Run $dir pull valid $false } finally { $lock.Dispose() }

foreach ($bad in @('../escape.sql.gpg','invalid.sql.gpg','erp-2026-99-99T12-00-00.sql.gpg')) {
  $rejected = $false
  try { Get-BackupAgeHours $bad | Out-Null } catch { $rejected = $true }
  Assert $rejected "invalid name/date accepted: $bad"
}
$future = 'erp-' + [datetime]::UtcNow.AddDays(1).ToString("yyyy-MM-dd'T'HH-mm-ss") + '.sql.gpg'
$rejected = $false
try { Get-BackupAgeHours $future | Out-Null } catch { $rejected = $true }
Assert $rejected 'future backup accepted'
Assert ((Get-BackupAgeHours 'erp-2020-01-01T00-00-00.sql.gpg') -gt 26) 'old backup must be stale'
Write-Host "PASS: offsite transfer, retry, receipt, corruption, lock and freshness; evidence retained in $root"
