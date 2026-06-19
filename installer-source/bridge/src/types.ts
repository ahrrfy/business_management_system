// Shared types for Al-Ru'ya local print bridge.

export type PrinterMode = "spooler" | "network" | "webusb-fallback";

export interface SpoolerPrinterConfig {
  mode: "spooler";
  spoolerName: string; // exact Windows printer name (matches `Get-Printer | Select Name`)
}

export interface NetworkPrinterConfig {
  mode: "network";
  host: string; // IPv4 or hostname
  port: number; // typically 9100
  brand?: string; // for documentation only
}

export type PrinterConfig = SpoolerPrinterConfig | NetworkPrinterConfig;

export interface CashDrawerConfig {
  method: "kickout-on-print" | "manual" | "none";
  pulseHex?: string; // raw bytes hex, e.g. "1B70001930" (ESC p 0 25 48)
}

export interface BridgeConfig {
  cloudUrl: string; // sole allowed CORS origin
  hmacSecret: string; // 32+ bytes base64
  port: number; // bridge listen port (default 9101)
  deviceRole: "cashier" | "admin" | "branch";
  receiptPrinter?: PrinterConfig;
  labelPrinter?: PrinterConfig;
  cashDrawer?: CashDrawerConfig;
  version?: string; // bridge version, set at build time
}

export type PrintKind = "receipt" | "label" | "raw";

export interface PrintRequest {
  kind: PrintKind;
  // base64-encoded raw bytes ready to send to the printer (PWA does the rasterization)
  bytesB64: string;
  // optional metadata for logging
  jobName?: string;
}

export interface PrintResponse {
  ok: boolean;
  jobId: string;
  mode: PrinterMode;
  error?: string;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  receiptConfigured: boolean;
  labelConfigured: boolean;
  receiptOnline?: boolean;
  labelOnline?: boolean;
}
