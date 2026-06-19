import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// PowerShell helper that uses the Win32 Winspool API (winspool.drv) via P/Invoke
// to send raw bytes to a Windows printer. Works for any printer with a Windows
// driver installed — USB, network, virtual — including thermal receipt printers
// (Epson TM-T20III, Star TSP100, BIXOLON SRP, etc.) and label printers (HPRT LPQ58,
// Zebra ZD, Brother QL, etc.). Bypasses the OS print dialog (RAW datatype).
const HELPER_PS1 = `
param([string]$BytesFile, [string]$PrinterName, [string]$JobName = 'AlroyaERP')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public class WinSpool {
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr hPrinter, IntPtr pDefault);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="StartDocPrinterW")]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] ref DOC_INFO_1 pDocInfo);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOC_INFO_1 { public string pDocName; public string pOutputFile; public string pDataType; }
  public static int PrintBytes(string printer, byte[] bytes, string jobName) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return 1;
    try {
      DOC_INFO_1 doc = new DOC_INFO_1 { pDocName = jobName, pOutputFile = null, pDataType = "RAW" };
      if (!StartDocPrinter(h, 1, ref doc)) return 2;
      try {
        if (!StartPagePrinter(h)) return 3;
        IntPtr p = Marshal.AllocHGlobal(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, p, bytes.Length);
          int written;
          if (!WritePrinter(h, p, bytes.Length, out written)) return 4;
        } finally { Marshal.FreeHGlobal(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
    return 0;
  }
}
'@
$bytes = [System.IO.File]::ReadAllBytes($BytesFile)
$rc = [WinSpool]::PrintBytes($PrinterName, $bytes, $JobName)
exit $rc
`;

let helperPath: string | null = null;
let tmpRoot: string | null = null;

function ensureTmpRoot(): string {
  if (tmpRoot && fs.existsSync(tmpRoot)) return tmpRoot;
  tmpRoot = path.join(os.tmpdir(), "alroya-bridge");
  fs.mkdirSync(tmpRoot, { recursive: true });
  return tmpRoot;
}

function ensureHelper(): string {
  const root = ensureTmpRoot();
  if (helperPath && fs.existsSync(helperPath)) return helperPath;
  helperPath = path.join(root, "printraw.ps1");
  fs.writeFileSync(helperPath, HELPER_PS1, "utf8");
  return helperPath;
}

const ERR_CODES: Record<number, string> = {
  1: "OpenPrinter فشل (تأكّد من اسم الطابعة وأنها متصلة)",
  2: "StartDocPrinter فشل",
  3: "StartPagePrinter فشل",
  4: "WritePrinter فشل (تأكّد أن الطابعة جاهزة وفيها ورق)",
};

/** Send raw bytes to a Windows-installed printer (USB or network via Windows driver). */
export async function printSpooler(spoolerName: string, bytes: Buffer, jobName = "AlroyaERP"): Promise<void> {
  const helper = ensureHelper();
  const root = ensureTmpRoot();
  // crypto.randomBytes ⇒ ضمان عدم التصادم حتى مع طلبات متزامنة في نفس الـmillisecond.
  const bytesFile = path.join(root, `job-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.bin`);
  fs.writeFileSync(bytesFile, bytes);
  try {
    await new Promise<void>((resolve, reject) => {
      const ps = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy", "Bypass",
          "-File", helper,
          "-BytesFile", bytesFile,
          "-PrinterName", spoolerName,
          "-JobName", jobName,
        ],
        { windowsHide: true },
      );
      const errChunks: Buffer[] = [];
      ps.stderr.on("data", (c) => errChunks.push(c as Buffer));
      ps.on("error", reject);
      ps.on("close", (code) => {
        if (code === 0) return resolve();
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        const known = ERR_CODES[code ?? -1] ?? `exit code ${code}`;
        reject(new Error(`${known}${stderr ? `\n${stderr}` : ""}`));
      });
    });
  } finally {
    try { fs.unlinkSync(bytesFile); } catch { /* ignore */ }
  }
}

/**
 * Check that the named printer exists in Windows. Returns true if found (and not
 * in error state where determinable). Best-effort — does not raise.
 */
export async function pingSpoolerPrinter(spoolerName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `try { $p = Get-Printer -Name "${spoolerName.replace(/"/g, '`"')}" -ErrorAction Stop; if ($p) { exit 0 } else { exit 1 } } catch { exit 1 }`,
      ],
      { windowsHide: true },
    );
    ps.on("error", () => resolve(false));
    ps.on("close", (code) => resolve(code === 0));
  });
}
