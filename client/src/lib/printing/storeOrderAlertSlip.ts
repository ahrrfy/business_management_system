import { docBarcode } from "@shared/documentNumber";
import { fmtInt } from "@/lib/money";
import { isPublicHost, isPublicPath } from "@/lib/siteHosts";
import { code128Svg } from "./barcode";
import { CAIRO_FONT, esc, openPrintWindow } from "./brand";
import { EscPos, imageDataToRaster, type Raster } from "./escpos";
import { isServerBridgeEnabled, sendRawToServer } from "./serverBridge";
import {
  isPaired,
  isWebUsbSupported,
  sendBytes,
  tryReconnectPrinter,
} from "./thermal";

export interface StoreOrderAlertData {
  orderNumber: string;
  createdAt?: Date | string | null;
  itemsCount?: number | null;
  totalAmount: string | number;
}

const SLIP_WIDTH_PX = 576; // 80mm thermal printable dots (~203 DPI)

function formatAlertDate(raw: Date | string | null | undefined): string {
  const date = raw instanceof Date ? raw : raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) return "—";
  const d = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(date);
  const t = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${d} ${t}`;
}

function formatAlertItemsCount(count: number | null | undefined): string {
  const n = Math.max(0, Math.trunc(Number(count ?? 0)));
  if (n <= 0) return "—";
  return n === 1 ? "صنف واحد" : n === 2 ? "صنفان" : `${n} أصناف`;
}

export function buildStoreOrderAlertHtml(
  d: StoreOrderAlertData,
  opts?: { autoScript?: boolean },
): string {
  const autoScript = opts?.autoScript !== false;
  const dateStr = formatAlertDate(d.createdAt);
  const countStr = formatAlertItemsCount(d.itemsCount);
  const totalStr = `${fmtInt(Number(d.totalAmount || 0))} د.ع`;
  const barcodeCode = docBarcode("ORD", d.orderNumber);
  let barcodeSvg = "";
  try {
    barcodeSvg = code128Svg(barcodeCode, {
      moduleWidth: 1.6,
      height: 54,
      quietZone: 6,
      showText: false,
    }).svg;
  } catch {
    barcodeSvg = "";
  }

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<title>طلب متجر جديد ${esc(d.orderNumber)}</title>
${CAIRO_FONT}
<style>
  @page { size: 80mm 100mm; margin: 3mm 4mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 72mm;
    font-family: 'Cairo', system-ui, sans-serif;
    color: #000;
    background: #fff;
    padding: 2mm 0;
  }
  .banner {
    background: #000;
    color: #fff;
    text-align: center;
    padding: 3.5mm 2mm;
    border-radius: 2mm;
    font-size: 26px;
    font-weight: 900;
    line-height: 1.15;
    letter-spacing: -0.3px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 3mm;
    border: 2px solid #000;
  }
  th, td {
    border: 1.5px solid #000;
    text-align: center;
    padding: 1.8mm 1mm;
  }
  th {
    font-size: 11px;
    font-weight: 900;
    background: #f0f0f0;
  }
  td {
    font-size: 12.5px;
    font-weight: 900;
    font-variant-numeric: tabular-nums;
  }
  .barcode-wrap {
    margin-top: 3mm;
    text-align: center;
    padding: 1.5mm 0;
  }
  .barcode-wrap svg { max-width: 100%; height: 15mm; }
  .barcode-label {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    font-weight: 900;
    margin-top: 0.8mm;
  }
  .total-box {
    margin-top: 2.5mm;
    border-top: 2.5px solid #000;
    border-bottom: 2.5px solid #000;
    padding: 2.5mm 1mm;
    text-align: center;
  }
  .total-caption {
    font-size: 12px;
    font-weight: 800;
  }
  .total-val {
    font-size: 27px;
    font-weight: 900;
    line-height: 1.15;
    margin-top: 0.5mm;
  }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style>
</head>
<body>
  <div class="banner">طلب متجر جديد</div>
  <table>
    <thead>
      <tr>
        <th>رقم الطلب</th>
        <th>التاريخ</th>
        <th>عدد الأصناف</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td dir="ltr">${esc(d.orderNumber)}</td>
        <td dir="ltr">${esc(dateStr)}</td>
        <td>${esc(countStr)}</td>
      </tr>
    </tbody>
  </table>
  ${
    barcodeSvg
      ? `<div class="barcode-wrap">${barcodeSvg}<div class="barcode-label" dir="ltr">${esc(d.orderNumber)}</div></div>`
      : ""
  }
  <div class="total-box">
    <div class="total-caption">قيمة الطلب</div>
    <div class="total-val" dir="ltr">${esc(totalStr)}</div>
  </div>
  ${
    autoScript
      ? "<script>window.addEventListener('load',()=>{(document.fonts?.ready||Promise.resolve()).then(()=>setTimeout(()=>window.print(),60))});window.addEventListener('afterprint',()=>window.close())</script>"
      : ""
  }
</body>
</html>`;
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * يرسم قصاصة ~10 سم (576px عرض × ~760px ارتفاع ≈ 9.5 سم عند 203 DPI) لطابعة 80mm الحرارية.
 */
export async function renderStoreOrderAlertRaster(
  d: StoreOrderAlertData,
): Promise<Raster | null> {
  if (typeof document === "undefined") return null;
  try {
    if (document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => globalThis.setTimeout(resolve, 2_500)),
      ]);
    }
  } catch {
    /* المتصفح يرسم بالخط الاحتياطي عند تعذّر تحميل الخطوط */
  }

  const width = SLIP_WIDTH_PX;
  const height = 740; // ~9.2 سم مطبوعة + تغذية قص ≈ 10 سم
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);

  const pad = 16;
  const innerW = width - pad * 2;
  let y = 16;

  // ١) رأس عريض بارز بحجم كبير جداً
  const bannerH = 148;
  ctx.fillStyle = "#000";
  ctx.fillRect(pad, y, innerW, bannerH);
  ctx.fillStyle = "#fff";
  ctx.font = "900 58px Cairo, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("طلب متجر جديد", width / 2, y + bannerH / 2 + 2);
  y += bannerH + 22;

  // ٢) جدول منظم: رقم الطلب | التاريخ | عدد الأصناف
  const tableH = 114;
  const headerH = 44;
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 3;
  ctx.strokeRect(pad, y, innerW, tableH);

  // تقسيم 3 أعمدة (يمين: رقم الطلب، وسط: التاريخ، يسار: عدد الأصناف)
  const col1W = Math.round(innerW * 0.36);
  const col2W = Math.round(innerW * 0.36);
  const col3W = innerW - col1W - col2W;
  const xSplit1 = pad + col3W;
  const xSplit2 = xSplit1 + col2W;

  ctx.fillStyle = "#efefef";
  ctx.fillRect(pad + 2, y + 2, innerW - 4, headerH - 2);

  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, y + headerH);
  ctx.lineTo(pad + innerW, y + headerH);
  ctx.moveTo(xSplit1, y);
  ctx.lineTo(xSplit1, y + tableH);
  ctx.moveTo(xSplit2, y);
  ctx.lineTo(xSplit2, y + tableH);
  ctx.stroke();

  ctx.fillStyle = "#000";
  ctx.font = "900 21px Cairo, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("عدد الأصناف", pad + col3W / 2, y + headerH / 2 + 1);
  ctx.fillText("التاريخ", xSplit1 + col2W / 2, y + headerH / 2 + 1);
  ctx.fillText("رقم الطلب", xSplit2 + col1W / 2, y + headerH / 2 + 1);

  const valY = y + headerH + (tableH - headerH) / 2 + 2;
  ctx.font = "900 22px Cairo, sans-serif";
  ctx.fillText(formatAlertItemsCount(d.itemsCount), pad + col3W / 2, valY);
  ctx.fillText(formatAlertDate(d.createdAt), xSplit1 + col2W / 2, valY);
  ctx.fillText(d.orderNumber, xSplit2 + col1W / 2, valY);
  y += tableH + 26;

  // ٣) باركود مباشر سريع وفوري وواضح
  try {
    const code = docBarcode("ORD", d.orderNumber);
    const bc = code128Svg(code, {
      moduleWidth: 2.6,
      height: 112,
      quietZone: 8,
      showText: false,
    });
    const img = await loadSvgImage(bc.svg);
    const drawW = Math.min(innerW - 24, Math.max(320, bc.widthPx));
    const drawH = 112;
    ctx.drawImage(img, (width - drawW) / 2, y, drawW, drawH);
    y += drawH + 10;
    ctx.fillStyle = "#000";
    ctx.font = "900 22px ui-monospace, monospace";
    ctx.fillText(d.orderNumber, width / 2, y + 14);
    y += 32;
  } catch {
    y += 28;
  }

  // ٤) قيمة الطلب بخط كبير وسميك
  y += 14;
  ctx.fillStyle = "#000";
  ctx.fillRect(pad, y, innerW, 4);
  y += 16;
  ctx.font = "800 24px Cairo, sans-serif";
  ctx.fillText("قيمة الطلب", width / 2, y + 16);
  y += 38;
  ctx.font = "900 56px Cairo, sans-serif";
  ctx.fillText(`${fmtInt(Number(d.totalAmount || 0))} د.ع`, width / 2, y + 36);
  y += 74;
  ctx.fillRect(pad, y, innerW, 4);

  const imgData = ctx.getImageData(0, 0, width, height);
  return imageDataToRaster({ width, height, data: imgData.data });
}

export async function hasConnectedAlertThermalPrinter(): Promise<boolean> {
  if (await isServerBridgeEnabled()) return true;
  if (isPaired("receipt")) return true;
  if (isWebUsbSupported()) {
    try {
      return await tryReconnectPrinter("receipt");
    } catch {
      return false;
    }
  }
  return false;
}

export async function printStoreOrderAlertSilent(
  d: StoreOrderAlertData,
  options?: { signal?: AbortSignal },
): Promise<"printed" | "no_printer" | "hardware_error" | "lease_lost"> {
  const signal = options?.signal;
  if (signal?.aborted) return "lease_lost";
  const raster = await renderStoreOrderAlertRaster(d);
  if (!raster) return "hardware_error";
  if (signal?.aborted) return "lease_lost";
  const bytes = new EscPos().init().raster(raster).feed(2).cut().bytes();

  if (await isServerBridgeEnabled()) {
    if (signal?.aborted) return "lease_lost";
    try {
      await sendRawToServer(bytes);
      return "printed";
    } catch (err) {
      console.warn("[store-order-alert] server bridge print failed:", err);
    }
  }

  if (signal?.aborted) return "lease_lost";
  if (!isPaired("receipt") && isWebUsbSupported()) {
    try {
      await tryReconnectPrinter("receipt");
    } catch {
      // safe fallback
    }
  }

  if (signal?.aborted) return "lease_lost";
  if (!isPaired("receipt")) return "no_printer";

  try {
    await sendBytes(bytes, "receipt");
    return "printed";
  } catch (err) {
    console.warn("[store-order-alert] WebUSB print failed:", err);
    return "hardware_error";
  }
}

export const STORE_ORDER_AUTOPRINT_STATION_KEY = "erp.storeOrders.autoPrintStation";
export const STORE_ORDER_AUTOPRINT_STATION_EVENT = "erp:store-order-autoprint-station";

const NON_AUTOPRINT_INTERNAL_PATHS = [
  "/login",
  "/mobile-design-preview",
  "/price-checker",
  "/shelf-lookup",
  "/price-check",
  "/kiosk",
  "/cfd",
  "/count",
  "/apply",
  "/verify",
  "/my-deliveries",
] as const;

/**
 * يحدد ما إذا كان المسار الحالي شاشة عمل داخلية للموظفين يحق لها تشغيل منسق الطباعة التلقائية
 * لطلبات المتجر الواردة (بما فيها نقطة البيع /pos بأوضاعها الثلاثة، الاستقبال، استوديو الطباعة،
 * ولوحة التحكم وكافة الشاشات الإدارية)، مع استثناء شاشات الزبائن والكشك وشاشة العميل المقابلة CFD.
 */
export function shouldRunStoreOrderAutoPrintOnRoute(
  pathname: string,
  hostname: string,
): boolean {
  if (isPublicHost(hostname)) return false;
  const rawPath = (pathname || "/").split(/[?#]/, 1)[0] || "/";
  const cleanPath =
    rawPath.length > 1 ? rawPath.replace(/\/+$/, "") || "/" : rawPath;
  if (isPublicPath(cleanPath)) return false;
  if (
    NON_AUTOPRINT_INTERNAL_PATHS.some(
      (prefix) => cleanPath === prefix || cleanPath.startsWith(`${prefix}/`),
    )
  ) {
    return false;
  }
  return true;
}

export function readStoreOrderAutoPrintStationSetting(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORE_ORDER_AUTOPRINT_STATION_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

export function setStoreOrderAutoPrintStationSetting(enabled: boolean | null): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled === null) window.localStorage.removeItem(STORE_ORDER_AUTOPRINT_STATION_KEY);
    else window.localStorage.setItem(STORE_ORDER_AUTOPRINT_STATION_KEY, enabled ? "1" : "0");
    window.dispatchEvent(new CustomEvent(STORE_ORDER_AUTOPRINT_STATION_EVENT, { detail: { enabled } }));
  } catch {
    /* ignore storage error */
  }
}

/**
 * يطبع قصاصة 80mm × 100mm عبر إطار مخفي داخل الصفحة (Same-Origin Hidden Iframe)
 * ليتجاوز حاجب النوافذ المنبثقة (Popup Blocker) عند وصول أحداث SSE الخلفية،
 * فيعمل تلقائياً مع طابعات Windows الافتراضية (ومع --kiosk-printing بصمت تام).
 */
export type StoreOrderAlertPrintOutcome =
  | "printed"
  | "dialog_opened"
  | "no_printer"
  | "hardware_error"
  | "lease_lost";

export async function printStoreOrderAlertIframe(
  d: StoreOrderAlertData,
  options?: { signal?: AbortSignal },
): Promise<"dialog_opened" | "hardware_error" | "lease_lost"> {
  if (typeof document === "undefined" || !document.body) return "hardware_error";
  const signal = options?.signal;
  if (signal?.aborted) return "lease_lost";

  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;";

    let settled = false;
    const cleanup = () => {
      try {
        iframe.remove();
      } catch {
        /* ignore */
      }
    };
    const finish = (res: "dialog_opened" | "hardware_error" | "lease_lost") => {
      if (settled) return;
      settled = true;
      resolve(res);
    };

    const failTimer = globalThis.setTimeout(() => {
      cleanup();
      finish("hardware_error");
    }, 8_000);

    iframe.onload = async () => {
      globalThis.clearTimeout(failTimer);
      if (signal?.aborted) {
        cleanup();
        finish("lease_lost");
        return;
      }
      try {
        const win = iframe.contentWindow;
        const doc = iframe.contentDocument;
        if (!win || !doc) {
          cleanup();
          finish("hardware_error");
          return;
        }
        if (doc.fonts?.ready) {
          await Promise.race([
            doc.fonts.ready,
            new Promise<void>((r) => globalThis.setTimeout(r, 1_200)),
          ]);
        }
        if (signal?.aborted) {
          cleanup();
          finish("lease_lost");
          return;
        }
        win.addEventListener("afterprint", () => {
          globalThis.setTimeout(cleanup, 400);
        });
        globalThis.setTimeout(cleanup, 60_000);
        win.focus();
        win.print();
        finish("dialog_opened");
      } catch (err) {
        console.warn("[store-order-alert] iframe print failed:", err);
        cleanup();
        finish("hardware_error");
      }
    };

    iframe.srcdoc = buildStoreOrderAlertHtml(d, { autoScript: false });
    document.body.appendChild(iframe);
  });
}

export async function printStoreOrderAlertAuto(
  d: StoreOrderAlertData,
  options?: { signal?: AbortSignal; allowBrowserFallback?: boolean },
): Promise<StoreOrderAlertPrintOutcome> {
  const silentRes = await printStoreOrderAlertSilent(d, options);
  if (silentRes === "printed" || silentRes === "lease_lost") {
    return silentRes;
  }
  if (options?.allowBrowserFallback) {
    return printStoreOrderAlertIframe(d, options);
  }
  return silentRes;
}

export function previewOrPrintStoreOrderAlertBrowser(d: StoreOrderAlertData): boolean {
  return openPrintWindow(buildStoreOrderAlertHtml(d), "width=380,height=480");
}

export interface StoreOrderAlertClaimResult {
  claimed: boolean;
  alreadyPrinted?: boolean;
  leaseToken?: string | null;
  orderNumber?: string | null;
  total?: string | null;
  itemCount?: number | null;
  createdAt?: Date | string | null;
}

export interface StoreOrderAlertIncomingPayload {
  orderId: number;
  orderNumber: string;
  totalAmount: string | number;
  itemsCount?: number;
  createdAt?: string;
  alertPrintHandoff?: boolean;
}

/**
 * منسّق طباعة قصاصة التنبيه عبر عدة محطات بنظام حجز مؤقت قابل للاسترداد + إقرار اكتمال منفصل:
 *  - يفصل سجلّ التنبيه الصوتي/البصري (مرة واحدة لكل طلب) عن سجلّ الطباعة المكتملة فعلياً.
 *  - يعيد المحاولة على مراحل (`recoveryRetryDelaysMs`: بعد 2.5s ثم بعد انتهاء إيجار الـ 20s عند 21.5s)
 *    حتى لو فُقدت استجابة `claim` بعد التزامها في قاعدة البيانات أو أُغلقت نافذة المحطة الفائزة قبل الطباعة.
 *  - لا تُسجَّل الطباعة كمكتملة نهائياً على الخادم إلا بعد نجاح الإرسال الفعلي للطابعة عبر `confirm`.
 */
export function createStoreOrderAlertCoordinator(deps: {
  hasPrinter: () => Promise<boolean>;
  canBrowserFallback?: () => boolean;
  claimHeadStartMs?: number | (() => number);
  browserFallbackHeadStartMs?: number | (() => number);
  claim: (orderId: number) => Promise<StoreOrderAlertClaimResult | null>;
  renew?: (
    orderId: number,
    leaseToken?: string | null,
  ) => Promise<{ renewed?: boolean; leaseToken?: string | null } | null>;
  confirm?: (orderId: number, leaseToken?: string | null) => Promise<unknown>;
  release: (orderId: number, leaseToken?: string | null) => Promise<unknown>;
  print: (
    data: StoreOrderAlertData,
    options?: { signal?: AbortSignal; allowBrowserFallback?: boolean },
  ) => Promise<StoreOrderAlertPrintOutcome>;
  onBrowserDialogOpened?: (ctx: {
    orderId: number;
    orderNumber: string;
    confirmPrinted: () => Promise<void>;
    retryOrRelease: () => Promise<void>;
  }) => void;
  unconfirmedDialogHoldMs?: number;
  onNotify?: (payload: StoreOrderAlertIncomingPayload) => void;
  now?: () => number;
  scheduleRetry?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelRetry?: (handle: ReturnType<typeof setTimeout>) => void;
  contestedRetryDelayMs?: number;
  recoveryRetryDelaysMs?: readonly number[];
  failedStationCooldownMs?: number;
  leaseDurationMs?: number;
  leaseRenewIntervalMs?: number;
}) {
  const getNow = deps.now ?? (() => Date.now());
  const schedule =
    deps.scheduleRetry ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const cancel =
    deps.cancelRetry ?? ((handle) => globalThis.clearTimeout(handle));
  const leaseDurationMs = deps.leaseDurationMs ?? 20_000;
  const leaseRenewIntervalMs =
    deps.leaseRenewIntervalMs ?? Math.max(2_000, Math.floor(leaseDurationMs * 0.4));
  const recoveryDelays =
    deps.recoveryRetryDelaysMs ??
    (deps.contestedRetryDelayMs !== undefined
      ? [deps.contestedRetryDelayMs, leaseDurationMs + 1_500, leaseDurationMs * 2 + 3_000]
      : [2_500, leaseDurationMs + 1_500, leaseDurationMs * 2 + 3_000]);
  const failedStationCooldownMs = deps.failedStationCooldownMs ?? 8_000;
  const unconfirmedDialogHoldMs = deps.unconfirmedDialogHoldMs ?? 90_000;

  const resolveDelayMs = (
    val: number | (() => number) | undefined,
    fallback: number,
  ): number => {
    const resolved = typeof val === "function" ? val() : val;
    return typeof resolved === "number" && Number.isFinite(resolved) && resolved >= 0
      ? resolved
      : fallback;
  };

  let disposed = false;
  const notifiedOrderIds = new Set<number>();
  const printedOrderIds = new Set<number>();
  const awaitingDialogConfirmIds = new Set<number>();
  const inFlightOrderIds = new Set<number>();
  const recoveryStepByOrder = new Map<number, number>();
  const failedCooldownUntil = new Map<number, number>();
  const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const auxTimers = new Set<ReturnType<typeof setTimeout>>();
  const activePrintAborts = new Set<AbortController>();
  const activeLeaseReleases = new Map<number, () => void>();

  const boundSet = (set: Set<number>, keep: number) => {
    if (set.size > 200) {
      set.clear();
      set.add(keep);
    }
  };

  const boundMap = <V>(map: Map<number, V>, keepKey: number, keepVal: V) => {
    if (map.size > 200) {
      map.clear();
      map.set(keepKey, keepVal);
    }
  };

  const clearPendingTimer = (orderId: number) => {
    const existing = pendingTimers.get(orderId);
    if (existing !== undefined) {
      cancel(existing);
      pendingTimers.delete(orderId);
    }
  };

  const scheduleNextRecovery = (payload: StoreOrderAlertIncomingPayload) => {
    const { orderId } = payload;
    if (printedOrderIds.has(orderId) || pendingTimers.has(orderId)) return;
    const step = recoveryStepByOrder.get(orderId) ?? 0;
    if (step >= recoveryDelays.length) return;
    const delayMs = recoveryDelays[step] ?? 2_500;
    recoveryStepByOrder.set(orderId, step + 1);
    boundMap(recoveryStepByOrder, orderId, step + 1);
    const timer = schedule(() => {
      pendingTimers.delete(orderId);
      void attemptPrint(payload);
    }, delayMs);
    pendingTimers.set(orderId, timer);
  };

  const attemptPrint = async (
    payload: StoreOrderAlertIncomingPayload,
  ): Promise<void> => {
    const { orderId } = payload;
    if (
      printedOrderIds.has(orderId) ||
      awaitingDialogConfirmIds.has(orderId) ||
      inFlightOrderIds.has(orderId)
    ) {
      return;
    }
    const cooldownUntil = failedCooldownUntil.get(orderId);
    if (cooldownUntil !== undefined) {
      if (getNow() < cooldownUntil) {
        scheduleNextRecovery(payload);
        return;
      }
      failedCooldownUntil.delete(orderId);
    }

    inFlightOrderIds.add(orderId);
    try {
      if (disposed) return;
      const hardwarePrinterReady = await deps.hasPrinter().catch(() => false);
      if (disposed) return;
      let useBrowserFallback = false;
      if (!hardwarePrinterReady) {
        const fallbackAllowed = deps.canBrowserFallback ? deps.canBrowserFallback() : false;
        if (!fallbackAllowed) return;
        useBrowserFallback = true;
        const headStartMs = resolveDelayMs(deps.browserFallbackHeadStartMs, 700);
        if (headStartMs > 0) {
          await new Promise<void>((resolve) => {
            const waitHandle = schedule(() => {
              auxTimers.delete(waitHandle);
              resolve();
            }, headStartMs);
            auxTimers.add(waitHandle);
          });
          if (disposed || printedOrderIds.has(orderId)) return;
        }
      } else {
        const claimHeadStartMs = resolveDelayMs(deps.claimHeadStartMs, 0);
        if (claimHeadStartMs > 0) {
          await new Promise<void>((resolve) => {
            const waitHandle = schedule(() => {
              auxTimers.delete(waitHandle);
              resolve();
            }, claimHeadStartMs);
            auxTimers.add(waitHandle);
          });
          if (disposed || printedOrderIds.has(orderId)) return;
        }
      }

      let claimRes: StoreOrderAlertClaimResult | null = null;
      try {
        claimRes = await deps.claim(orderId);
      } catch (err) {
        console.warn("[store-order-alert] claimNotificationPrint failed:", err);
        if (!disposed) scheduleNextRecovery(payload);
        return;
      }

      if (claimRes?.alreadyPrinted) {
        printedOrderIds.add(orderId);
        boundSet(printedOrderIds, orderId);
        clearPendingTimer(orderId);
        recoveryStepByOrder.delete(orderId);
        failedCooldownUntil.delete(orderId);
        return;
      }

      if (!claimRes?.claimed) {
        if (!disposed) scheduleNextRecovery(payload);
        return;
      }

      if (disposed) {
        void deps.release(orderId, claimRes.leaseToken ?? null).catch(() => {});
        return;
      }

      clearPendingTimer(orderId);
      let activeLeaseToken = claimRes.leaseToken ?? null;
      let localLeaseDeadline = getNow() + leaseDurationMs;
      let printDone = false;
      const abortController = new AbortController();
      activePrintAborts.add(abortController);
      let renewTimer: ReturnType<typeof setTimeout> | null = null;
      let expiryGuardTimer: ReturnType<typeof setTimeout> | null = null;

      const stopLeaseTimers = () => {
        if (renewTimer !== null) {
          cancel(renewTimer);
          auxTimers.delete(renewTimer);
          renewTimer = null;
        }
        if (expiryGuardTimer !== null) {
          cancel(expiryGuardTimer);
          auxTimers.delete(expiryGuardTimer);
          expiryGuardTimer = null;
        }
      };

      const armExpiryGuard = () => {
        if (expiryGuardTimer !== null) {
          cancel(expiryGuardTimer);
          auxTimers.delete(expiryGuardTimer);
        }
        const guardDelay = Math.max(250, localLeaseDeadline - getNow() - 1_000);
        expiryGuardTimer = schedule(() => {
          auxTimers.delete(expiryGuardTimer!);
          expiryGuardTimer = null;
          if (!printDone && getNow() >= localLeaseDeadline - 1_000) {
            abortController.abort();
          }
        }, guardDelay);
        auxTimers.add(expiryGuardTimer);
      };

      const scheduleLeaseRenewal = () => {
        if (printDone || !deps.renew) return;
        renewTimer = schedule(async () => {
          auxTimers.delete(renewTimer!);
          renewTimer = null;
          if (printDone || abortController.signal.aborted) return;
          try {
            const renewed = await deps.renew!(orderId, activeLeaseToken);
            if (printDone) return;
            if (renewed?.renewed) {
              activeLeaseToken = renewed.leaseToken ?? activeLeaseToken;
              localLeaseDeadline = getNow() + leaseDurationMs;
              armExpiryGuard();
              scheduleLeaseRenewal();
              return;
            }
            if (renewed && renewed.renewed === false) {
              abortController.abort();
              return;
            }
          } catch {
            // retry renewal while within local lease window
          }
          if (!printDone && !abortController.signal.aborted) {
            scheduleLeaseRenewal();
          }
        }, leaseRenewIntervalMs);
        auxTimers.add(renewTimer);
      };

      armExpiryGuard();
      scheduleLeaseRenewal();

      let outcome: StoreOrderAlertPrintOutcome = "hardware_error";
      try {
        outcome = await deps
          .print(
            {
              orderNumber: claimRes.orderNumber ?? payload.orderNumber,
              createdAt: claimRes.createdAt ?? payload.createdAt ?? new Date(),
              itemsCount: claimRes.itemCount || payload.itemsCount || 1,
              totalAmount: claimRes.total ?? payload.totalAmount,
            },
            { signal: abortController.signal, allowBrowserFallback: useBrowserFallback },
          )
          .catch(() => "hardware_error" as const);
      } finally {
        printDone = true;
        stopLeaseTimers();
        activePrintAborts.delete(abortController);
      }

      if (outcome === "printed") {
        activeLeaseReleases.delete(orderId);
        printedOrderIds.add(orderId);
        boundSet(printedOrderIds, orderId);
        recoveryStepByOrder.delete(orderId);
        failedCooldownUntil.delete(orderId);
        if (deps.confirm) {
          const tokenToConfirm = activeLeaseToken;
          try {
            await deps.confirm(orderId, tokenToConfirm);
          } catch {
            if (!disposed) {
              const retryHandle = schedule(() => {
                auxTimers.delete(retryHandle);
                void deps.confirm?.(orderId, tokenToConfirm).catch(() => {});
              }, 2_000);
              auxTimers.add(retryHandle);
            }
          }
        }
        return;
      }

      if (outcome === "dialog_opened") {
        if (disposed || !deps.onBrowserDialogOpened) {
          activeLeaseReleases.delete(orderId);
          failedCooldownUntil.set(orderId, getNow() + failedStationCooldownMs);
          try {
            await deps.release(orderId, activeLeaseToken);
          } catch {
            if (!disposed) scheduleNextRecovery(payload);
          }
          return;
        }

        awaitingDialogConfirmIds.add(orderId);
        boundSet(awaitingDialogConfirmIds, orderId);
        let dialogSettled = false;
        let holdRenewTimer: ReturnType<typeof setTimeout> | null = null;
        let holdExpireTimer: ReturnType<typeof setTimeout> | null = null;

        const clearDialogTimers = () => {
          if (holdRenewTimer !== null) {
            cancel(holdRenewTimer);
            auxTimers.delete(holdRenewTimer);
            holdRenewTimer = null;
          }
          if (holdExpireTimer !== null) {
            cancel(holdExpireTimer);
            auxTimers.delete(holdExpireTimer);
            holdExpireTimer = null;
          }
        };

        const scheduleHoldRenew = () => {
          if (dialogSettled || !deps.renew) return;
          holdRenewTimer = schedule(async () => {
            auxTimers.delete(holdRenewTimer!);
            holdRenewTimer = null;
            if (dialogSettled) return;
            try {
              const renewed = await deps.renew!(orderId, activeLeaseToken);
              if (dialogSettled) return;
              if (renewed?.renewed) {
                activeLeaseToken = renewed.leaseToken ?? activeLeaseToken;
                scheduleHoldRenew();
                return;
              }
              if (renewed && renewed.renewed === false) {
                dialogSettled = true;
                activeLeaseReleases.delete(orderId);
                clearDialogTimers();
                awaitingDialogConfirmIds.delete(orderId);
                failedCooldownUntil.set(orderId, getNow() + failedStationCooldownMs);
                if (!disposed) scheduleNextRecovery(payload);
                return;
              }
            } catch {
              /* ignore transient renew error */
            }
            if (!dialogSettled) {
              scheduleHoldRenew();
            }
          }, leaseRenewIntervalMs);
          auxTimers.add(holdRenewTimer);
        };

        const confirmPrinted = async () => {
          if (dialogSettled) return;
          dialogSettled = true;
          activeLeaseReleases.delete(orderId);
          clearDialogTimers();
          awaitingDialogConfirmIds.delete(orderId);
          printedOrderIds.add(orderId);
          boundSet(printedOrderIds, orderId);
          recoveryStepByOrder.delete(orderId);
          failedCooldownUntil.delete(orderId);
          if (deps.confirm) {
            const tokenToConfirm = activeLeaseToken;
            try {
              await deps.confirm(orderId, tokenToConfirm);
            } catch {
              const retryHandle = schedule(() => {
                auxTimers.delete(retryHandle);
                void deps.confirm?.(orderId, tokenToConfirm).catch(() => {});
              }, 2_000);
              auxTimers.add(retryHandle);
            }
          }
        };

        const retryOrRelease = async () => {
          if (dialogSettled) return;
          dialogSettled = true;
          activeLeaseReleases.delete(orderId);
          clearDialogTimers();
          awaitingDialogConfirmIds.delete(orderId);
          failedCooldownUntil.set(orderId, getNow() + failedStationCooldownMs);
          try {
            await deps.release(orderId, activeLeaseToken);
          } catch {
            if (!disposed) scheduleNextRecovery(payload);
          }
        };

        activeLeaseReleases.set(orderId, () => {
          if (dialogSettled) return;
          dialogSettled = true;
          clearDialogTimers();
          awaitingDialogConfirmIds.delete(orderId);
          void deps.release(orderId, activeLeaseToken).catch(() => {});
        });

        scheduleHoldRenew();
        holdExpireTimer = schedule(() => {
          auxTimers.delete(holdExpireTimer!);
          holdExpireTimer = null;
          void retryOrRelease();
        }, unconfirmedDialogHoldMs);
        auxTimers.add(holdExpireTimer);

        deps.onBrowserDialogOpened({
          orderId,
          orderNumber: claimRes.orderNumber ?? payload.orderNumber,
          confirmPrinted,
          retryOrRelease,
        });
        return;
      }

      activeLeaseReleases.delete(orderId);
      if (outcome === "lease_lost" || abortController.signal.aborted) {
        if (disposed) {
          void deps.release(orderId, activeLeaseToken).catch(() => {});
          return;
        }
        failedCooldownUntil.set(orderId, getNow() + failedStationCooldownMs);
        scheduleNextRecovery(payload);
        return;
      }

      failedCooldownUntil.set(orderId, getNow() + failedStationCooldownMs);
      try {
        await deps.release(orderId, activeLeaseToken);
      } catch {
        if (!disposed) scheduleNextRecovery(payload);
      }
    } finally {
      inFlightOrderIds.delete(orderId);
    }
  };

  return {
    handleEvent(payload: StoreOrderAlertIncomingPayload): Promise<void> {
      if (
        disposed ||
        !payload ||
        !Number.isSafeInteger(payload.orderId) ||
        payload.orderId <= 0
      ) {
        return Promise.resolve();
      }
      if (!payload.alertPrintHandoff && !notifiedOrderIds.has(payload.orderId)) {
        notifiedOrderIds.add(payload.orderId);
        boundSet(notifiedOrderIds, payload.orderId);
        deps.onNotify?.(payload);
      }
      return attemptPrint(payload);
    },
    dispose(): void {
      disposed = true;
      activePrintAborts.forEach((ctrl) => {
        ctrl.abort();
      });
      activePrintAborts.clear();
      activeLeaseReleases.forEach((releaseFn) => {
        releaseFn();
      });
      activeLeaseReleases.clear();
      pendingTimers.forEach((timer) => {
        cancel(timer);
      });
      pendingTimers.clear();
      auxTimers.forEach((timer) => {
        cancel(timer);
      });
      auxTimers.clear();
    },
  };
}
