# تعداد **كل** طابعات Windows بأسمائها (لا فلترة بماركة) + علم الافتراضية. مخرَج JSON.
$ErrorActionPreference = 'Stop'
try {
  $def = (Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Default } | Select-Object -First 1).Name
} catch {
  $def = $null
}
$list = @(Get-Printer | ForEach-Object {
  [pscustomobject]@{
    name    = $_.Name
    driver  = $_.DriverName
    port    = $_.PortName
    shared  = [bool]$_.Shared
    share   = $_.ShareName
    default = ($_.Name -eq $def)
  }
})
# نخرج دائماً مصفوفة (حتى لعنصر واحد) — التطبيع النهائي في الجسر أيضاً احتياطاً.
ConvertTo-Json -InputObject $list -Depth 4 -Compress
