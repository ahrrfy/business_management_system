param([ValidateSet('Start', 'Stop')][string]$Action = 'Start')
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$recordPath = Join-Path $repoRoot '.superpowers/sdd/mysql-runtime.json'
$identityHelper = Join-Path $PSScriptRoot 'mysql-reference.mjs'

if ($Action -eq 'Stop') {
  if (-not (Test-Path -LiteralPath $recordPath)) { throw 'No laboratory runtime record' }
  $runtime = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  $expectedExe = [IO.Path]::GetFullPath((Join-Path $runtime.binaryRoot 'bin/mysqld.exe'))
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($runtime.pid)"
  if (-not $process) { 'Recorded laboratory process already stopped; no SQL issued'; exit 0 }
  if ($process.ExecutablePath -ne $expectedExe -or $runtime.port -ne 13317) { throw 'Runtime identity mismatch; refusing shutdown' }
  & node.exe $identityHelper --shutdown
  if ($LASTEXITCODE -ne 0) { throw 'Verified laboratory shutdown failed' }
  'Stopped only the recorded laboratory MySQL server'
  exit 0
}

if (Get-NetTCPConnection -LocalPort 13317 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 13317 in use; refusing to share a database' }
$runtimeRoot = Join-Path $env:TEMP ('erp-d1-poc-mysql-20261017-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
New-Item -ItemType Directory -Path (Split-Path $recordPath) -Force | Out-Null
$runtime = [ordered]@{
  root = $runtimeRoot; port = 13317; database = 'erp_d1_poc_20261017_test'; version = '8.4.9'
  source = 'https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.9-winx64.zip'
}
$archive = Join-Path $runtimeRoot 'mysql.zip'
curl.exe -sS --fail --connect-timeout 15 --max-time 300 -o $archive $runtime.source
if ($LASTEXITCODE -ne 0) { throw 'Official MySQL download failed' }
Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot
$binaryRoot = Join-Path $runtimeRoot 'mysql-8.4.9-winx64'
$dataRoot = Join-Path $runtimeRoot 'data'
& (Join-Path $binaryRoot 'bin/mysqld.exe') --no-defaults --initialize-insecure "--basedir=$binaryRoot" "--datadir=$dataRoot" --console
if ($LASTEXITCODE -ne 0) { throw 'Fresh laboratory initialization failed' }
# Repeat after the slow download/init. The same-connection helper is still the
# final authority if another process takes the port in the launch window.
if (Get-NetTCPConnection -LocalPort 13317 -State Listen -ErrorAction SilentlyContinue) { throw 'Port taken during setup; refusing to start or send SQL' }
$serverArgs = @('--no-defaults', "--basedir=$binaryRoot", "--datadir=$dataRoot", '--bind-address=127.0.0.1', '--port=13317', '--mysqlx=OFF', '--skip-log-bin', '--innodb-buffer-pool-size=64M', "--log-error=$runtimeRoot/server-error.log")
$expectedExe = Join-Path $binaryRoot 'bin/mysqld.exe'
$process = Start-Process -FilePath $expectedExe -ArgumentList $serverArgs -WindowStyle Hidden -PassThru
$runtime['pid'] = $process.Id
$runtime['binaryRoot'] = $binaryRoot
$runtime | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding utf8
$ownedListenerReady = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  $process.Refresh()
  if ($process.HasExited) { throw 'Recorded child exited before verified readiness; no SQL issued' }
  $listeners = @(Get-NetTCPConnection -LocalPort 13317 -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    foreach ($listener in $listeners) {
      $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
      # Windows MySQL uses a monitor parent and a direct mysqld child listener.
      if (-not $owner -or $owner.ExecutablePath -ne $expectedExe -or
          ($owner.ProcessId -ne $process.Id -and $owner.ParentProcessId -ne $process.Id) -or
          $listener.LocalAddress -ne '127.0.0.1') {
        throw 'Listener is not the recorded fresh laboratory child; no SQL issued'
      }
    }
    $ownedListenerReady = $true
    break
  }
  Start-Sleep -Milliseconds 500
}
if (-not $ownedListenerReady) { throw 'Verified local listener readiness timed out; no SQL issued' }
# Connect without a database; verify PID/listener and actual datadir/port before
# CREATE DATABASE on that same connection. No unauthenticated ping is trusted.
& node.exe $identityHelper --provision
if ($LASTEXITCODE -ne 0) { throw 'Laboratory identity/provisioning failed; runtime record retained for inspection' }
'MySQL 8.4.9 laboratory ready at loopback 13317 after same-connection identity verification'
