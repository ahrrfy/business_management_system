/**
 * مولّد وقالب طباعة شارة اعتماد المدير (Manager Authorization Badge)
 * يدعم نمطين:
 *  1. card: بطاقة هوية قياسية (ID Card / CR80) مناسبة للطباعة والتغليف.
 *  2. thermal: شريط طابعة إيصالات حرارية 80مم لسرعة الإصدار الفوري من نقطة البيع.
 */

import { code128Svg } from "./barcode";
import { qrCodeSvgSync } from "./qr";
import { openPrintWindow, esc } from "./brand";

export interface ManagerBadgeData {
  userName: string;
  userRole: string;
  userIdentifier?: string | null;
  branchName?: string | null;
  badgeBarcode: string;
}

export function buildManagerBadgeCardHtml(data: ManagerBadgeData): string {
  const barcodeRes = code128Svg(data.badgeBarcode, { moduleWidth: 1.4, height: 42, showText: true });
  const qrSvg = qrCodeSvgSync(data.badgeBarcode, { size: 90 });

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="utf-8">
  <title>شارة اعتماد المدير — ${esc(data.userName)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap');
    @page {
      size: 85.6mm 54mm;
      margin: 0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Cairo', system-ui, sans-serif;
      background: #f1f5f9;
      color: #0f172a;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
    }
    .toolbar {
      margin-bottom: 16px;
      display: flex;
      gap: 10px;
    }
    .btn {
      padding: 8px 18px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 700;
      border-radius: 6px;
      border: 1px solid #cbd5e1;
      background: #ffffff;
      color: #1e293b;
      cursor: pointer;
    }
    .btn-primary {
      background: #0d6b52;
      color: #ffffff;
      border-color: #0d6b52;
    }
    .badge-card {
      width: 85.6mm;
      height: 54mm;
      background: #ffffff;
      border: 1.5px solid #0d6b52;
      border-radius: 8px;
      position: relative;
      overflow: hidden;
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-shadow: 0 8px 24px rgba(0,0,0,0.08);
      page-break-inside: avoid;
    }
    .card-header {
      border-bottom: 2px solid #0d6b52;
      padding-bottom: 4px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .org-title {
      font-size: 11px;
      font-weight: 800;
      color: #0d6b52;
      line-height: 1.2;
    }
    .badge-tag {
      font-size: 8px;
      font-weight: 800;
      background: #0d6b52;
      color: #ffffff;
      padding: 2px 6px;
      border-radius: 4px;
      letter-spacing: 0.5px;
    }
    .card-body {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 4px 0;
    }
    .info-col {
      flex: 1;
    }
    .user-name {
      font-size: 14px;
      font-weight: 900;
      color: #0f172a;
      line-height: 1.2;
    }
    .user-role {
      font-size: 10px;
      font-weight: 700;
      color: #0d6b52;
      margin-top: 1px;
    }
    .branch-name {
      font-size: 9px;
      font-weight: 600;
      color: #64748b;
      margin-top: 2px;
    }
    .qr-col {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card-footer {
      border-top: 1px dashed #cbd5e1;
      padding-top: 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .barcode-wrap svg {
      max-width: 100%;
      height: 38px;
      display: block;
    }
    @media print {
      body {
        background: transparent;
        padding: 0;
        margin: 0;
        min-height: auto;
      }
      .toolbar { display: none !important; }
      .badge-card {
        box-shadow: none;
        border: 1px solid #0d6b52;
      }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="doc-btn-print" class="btn btn-primary" onclick="window.print()">طباعة الشارة</button>
    <button id="doc-btn-close" class="btn" onclick="window.close()">إغلاق</button>
  </div>
  <div class="badge-card">
    <div class="card-header">
      <div class="org-title">نظام إدارة أعمال الرؤية العربية</div>
      <div class="badge-tag">شارة اعتماد المدير</div>
    </div>
    <div class="card-body">
      <div class="info-col">
        <div class="user-name">${esc(data.userName)}</div>
        <div class="user-role">${esc(data.userRole)}</div>
        <div class="branch-name">${esc(data.branchName ?? "الفرع الرئيسي")} ${data.userIdentifier ? `(${esc(data.userIdentifier)})` : ""}</div>
      </div>
      <div class="qr-col">
        ${qrSvg}
      </div>
    </div>
    <div class="card-footer">
      <div class="barcode-wrap">
        ${barcodeRes.svg}
      </div>
    </div>
  </div>
</body>
</html>`;
}

export interface ManagerBadgeThermalOptions {
  paperWidth?: "80mm" | "58mm";
}

export function buildManagerBadgeThermalHtml(
  data: ManagerBadgeData,
  options?: ManagerBadgeThermalOptions,
): string {
  const is58 = options?.paperWidth === "58mm";
  const paperWidth = is58 ? "58mm" : "80mm";
  const slipWidth = is58 ? "48mm" : "72mm";
  const barcodeModule = is58 ? 1.05 : 1.5;
  const barcodeHeight = is58 ? 38 : 48;
  const qrSize = is58 ? 85 : 120;
  const mgrNameSize = is58 ? "14px" : "16px";
  const orgNameSize = is58 ? "11px" : "13px";
  const docTypeSize = is58 ? "10px" : "11px";

  const barcodeRes = code128Svg(data.badgeBarcode, { moduleWidth: barcodeModule, height: barcodeHeight, showText: true });
  const qrSvg = qrCodeSvgSync(data.badgeBarcode, { size: qrSize });

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="utf-8">
  <title>شارة مدير — ${esc(data.userName)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap');
    @page {
      size: ${paperWidth} auto;
      margin: 0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Cairo', system-ui, sans-serif;
      background: #f8fafc;
      color: #000000;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: ${is58 ? "8px 0" : "12px 0"};
    }
    .toolbar {
      margin-bottom: 12px;
      display: flex;
      gap: 8px;
    }
    .btn {
      padding: 6px 14px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 700;
      border-radius: 4px;
      border: 1px solid #cbd5e1;
      background: #ffffff;
      cursor: pointer;
    }
    .btn-primary { background: #000; color: #fff; border-color: #000; }
    .thermal-slip {
      width: ${slipWidth};
      max-width: ${slipWidth};
      background: #ffffff;
      padding: ${is58 ? "8px 2px" : "10px 4px"};
      text-align: center;
      border: 1px dashed #94a3b8;
      margin: 0 auto;
    }
    .org-name {
      font-size: ${orgNameSize};
      font-weight: 900;
      margin-bottom: 2px;
    }
    .doc-type {
      font-size: ${docTypeSize};
      font-weight: 800;
      border-top: 1.5px solid #000;
      border-bottom: 1.5px solid #000;
      padding: 3px 0;
      margin: 4px 0 8px 0;
    }
    .mgr-name {
      font-size: ${mgrNameSize};
      font-weight: 900;
      line-height: 1.3;
    }
    .mgr-role {
      font-size: ${is58 ? "11px" : "12px"};
      font-weight: 700;
      margin-top: 2px;
    }
    .mgr-meta {
      font-size: ${is58 ? "9px" : "10px"};
      color: #334155;
      margin-top: 2px;
      margin-bottom: 8px;
    }
    .qr-wrap {
      margin: 6px auto;
      display: flex;
      justify-content: center;
    }
    .barcode-wrap {
      margin-top: 6px;
      display: flex;
      justify-content: center;
    }
    .barcode-wrap svg {
      max-width: 100%;
      height: ${barcodeHeight}px;
    }
    .footer-note {
      font-size: ${is58 ? "8px" : "9px"};
      color: #475569;
      margin-top: 8px;
      border-top: 1px dashed #cbd5e1;
      padding-top: 4px;
    }
    @media print {
      body { background: transparent; padding: 0; margin: 0; }
      .toolbar { display: none !important; }
      .thermal-slip { border: none !important; box-shadow: none !important; margin: 0 auto; width: ${slipWidth}; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="doc-btn-print" class="btn btn-primary" onclick="window.print()">طباعة الإيصال</button>
    <button id="doc-btn-close" class="btn" onclick="window.close()">إغلاق</button>
  </div>
  <div class="thermal-slip">
    <div class="org-name">نظام إدارة أعمال الرؤية العربية</div>
    <div class="doc-type">شارة اعتماد المدير (POS / الاستقبال)</div>
    <div class="mgr-name">${esc(data.userName)}</div>
    <div class="mgr-role">${esc(data.userRole)}</div>
    <div class="mgr-meta">${esc(data.branchName ?? "الفرع الرئيسي")} ${data.userIdentifier ? `• ${esc(data.userIdentifier)}` : ""}</div>
    <div class="qr-wrap">
      ${qrSvg}
    </div>
    <div class="barcode-wrap">
      ${barcodeRes.svg}
    </div>
    <div class="footer-note">امسح الباركود مباشرة في نقاط البيع لتجاوز سقف الائتمان والعمليات الخاصة</div>
  </div>
</body>
</html>`;
}

export type ManagerBadgePrintFormat = "card" | "thermal" | "thermal-58" | "thermal-80";

export function printManagerBadge(
  data: ManagerBadgeData,
  format: ManagerBadgePrintFormat = "card",
): boolean {
  let html: string;
  if (format === "thermal-58") {
    html = buildManagerBadgeThermalHtml(data, { paperWidth: "58mm" });
  } else if (format === "thermal" || format === "thermal-80") {
    html = buildManagerBadgeThermalHtml(data, { paperWidth: "80mm" });
  } else {
    html = buildManagerBadgeCardHtml(data);
  }
  return openPrintWindow(html, "width=420,height=560");
}
