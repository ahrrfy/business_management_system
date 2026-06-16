param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$DataFile
)
# طباعة RAW لطابعة Windows بالاسم عبر winspool.drv (P/Invoke) — يمرّر البايتات حرفياً (datatype "RAW")
# ⇒ يتجاوز تصيير التعريف ويصون البايتات كما هي (جودة بايت-مطابقة لأي طابعة ESC/POS).
$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr def);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);

  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("OpenPrinter failed (printer not found?) err=" + Marshal.GetLastWin32Error());
    try {
      var di = new DOCINFO { pDocName = "ERP RAW", pDataType = "RAW" };
      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter err=" + Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter err=" + Marshal.GetLastWin32Error());
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written) || written != bytes.Length)
          throw new Exception("WritePrinter wrote " + written + "/" + bytes.Length + " err=" + Marshal.GetLastWin32Error());
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@

$bytes = [System.IO.File]::ReadAllBytes($DataFile)
[RawPrint]::Send($PrinterName, $bytes)
Write-Output "OK"
