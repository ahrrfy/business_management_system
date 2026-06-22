// الراسم الحراري لطلب الخدمة — يرسم تذكرة 80مم على Canvas ثم يحوّلها نقطية ESC/POS.
// البنية مماثلة لـreceiptRaster.ts (نفس W=576، نفس الخطوط، نفس أسلوب الرسم).
// التصميم: رأس شركة → باركود رقم الأمر → معلومات العمل → الإجمالي → ملاحظة → تذييل.
import { imageDataToRaster, type Raster } from "./escpos";
import { code128Svg } from "./barcode";
import { CO, RECEIPT_PHONES, fmt, logoUrl } from "./brand";

const W = 576;
const PAD = 12;

export interface WorkOrderReceiptData {
  orderNumber: string;
  orderDate?: string | null;
  dueDate?: string | null;
  status?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  jobTitle?: string | null;
  quantity?: string | number | null;
  specs?: string | null;
  total: string | number;
  notes?: string | null;
}

const STATUS_AR: Record<string, string> = {
  RECEIVED: "مُستلَم",
  IN_PROGRESS: "قيد التنفيذ",
  READY: "جاهز للتسليم",
  DELIVERED: "مُسلَّم",
  CANCELLED: "ملغى",
};

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function svgToDataUrl(svg: string): string {
  try {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  } catch {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

async function ensureFonts(): Promise<void> {
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    const sample = "مكتبة العربية للطباعة 0123 IQD طلب خدمة";
    await Promise.all(
      ["400 21px Cairo", "600 19px Cairo", "700 21px Cairo", "800 25px Cairo", "900 29px Cairo", "900 38px Cairo"].map(
        (f) => fonts.load(f, sample).catch(() => undefined),
      ),
    );
  } catch { /* تدهور سلس */ }
}

/** لفّ نص على أسطر بعرض أقصى */
function wrapLines(
  ctx: { measureText(s: string): { width: number } },
  s: string,
  maxW: number,
  maxLines = 3,
): string[] {
  const words = String(s).split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  let lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (!cur || ctx.measureText(cand).width <= maxW) cur = cand;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  const over = lines.length > maxLines;
  lines = lines.slice(0, maxLines);
  if (over) {
    let last = lines[lines.length - 1] + "…";
    while (last.length > 2 && ctx.measureText(last).width > maxW) last = last.slice(0, -2) + "…";
    lines[lines.length - 1] = last;
  }
  return lines;
}

function solidLine(ctx: CanvasRenderingContext2D, y: number, lw = 2): void {
  ctx.save(); ctx.fillStyle = "#000"; ctx.fillRect(PAD, y, W - PAD * 2, lw); ctx.restore();
}

function dashedLine(ctx: CanvasRenderingContext2D, y: number): void {
  ctx.save(); ctx.strokeStyle = "#000"; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
  ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke(); ctx.restore();
}

/** رسم طلب الخدمة على Canvas. يعيد {canvas, height} أو null خارج المتصفح. */
export async function workOrderToCanvas(
  d: WorkOrderReceiptData,
): Promise<{ canvas: HTMLCanvasElement; height: number } | null> {
  if (typeof document === "undefined") return null;
  await ensureFonts();

  const estH = 1600;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = estH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, estH);
  ctx.fillStyle = "#000";
  (ctx as unknown as { direction: string }).direction = "rtl";
  ctx.textBaseline = "alphabetic";

  let y = PAD;

  // ──── ١) رأس الشركة ────
  const logo = await loadImage(logoUrl());
  if (logo) { ctx.drawImage(logo, (W - 140) / 2, y, 140, 140); y += 140; }
  ctx.textAlign = "center";
  ctx.font = "900 38px Cairo, sans-serif"; y += 44; ctx.fillText("مكتبة العربية", W / 2, y);
  ctx.font = "800 25px Cairo, sans-serif"; y += 34; ctx.fillText("للطباعة والقرطاسية", W / 2, y);
  ctx.font = "400 16px Cairo, sans-serif"; y += 24; ctx.fillText(CO.name, W / 2, y);
  y += 14; solidLine(ctx, y, 4); y += 4;

  // ──── ٢) باركود رقم الأمر ────
  try {
    const bc = code128Svg(d.orderNumber, { moduleWidth: 2, height: 70, showText: false });
    const img = await loadImage(svgToDataUrl(bc.svg));
    if (img) {
      y += 14;
      const bw = Math.min(bc.widthPx, W - PAD * 2);
      ctx.drawImage(img, (W - bw) / 2, y, bw, bc.heightPx);
      y += bc.heightPx + 24;
      ctx.font = "600 17px Cairo, monospace"; ctx.textAlign = "center";
      ctx.fillText(d.orderNumber, W / 2, y);
    }
  } catch { /* بلا باركود */ }

  // ──── ٣) عنوان «طلب خدمة» ────
  y += 20; solidLine(ctx, y, 2); y += 4;
  ctx.font = "900 32px Cairo, sans-serif"; ctx.textAlign = "center"; y += 40;
  ctx.fillText("طلب خدمة / المطبعة", W / 2, y);
  y += 4; solidLine(ctx, y, 2); y += 28;

  // ──── ٤) صفوف المعلومات ────
  const infoRow = (label: string, value: string) => {
    ctx.font = "700 20px Cairo, sans-serif"; ctx.textAlign = "right";
    ctx.fillText(label, W - PAD, y);
    ctx.font = "400 20px Cairo, sans-serif"; ctx.textAlign = "left";
    ctx.fillText(value, PAD, y);
    y += 30;
  };

  infoRow("رقم الأمر:", d.orderNumber);
  if (d.orderDate) infoRow("تاريخ الاستلام:", d.orderDate);
  if (d.dueDate)   infoRow("موعد التسليم:", d.dueDate);
  if (d.customerName) infoRow("العميل:", d.customerName);
  if (d.customerPhone) infoRow("الهاتف:", d.customerPhone);
  if (d.status) infoRow("الحالة:", STATUS_AR[d.status] ?? d.status);

  y += 4; dashedLine(ctx, y); y += 28;

  // ──── ٥) تفاصيل العمل ────
  if (d.jobTitle) {
    ctx.font = "700 22px Cairo, sans-serif"; ctx.textAlign = "right";
    ctx.fillText("نوع العمل:", W - PAD, y);
    y += 30;
    ctx.font = "600 20px Cairo, sans-serif";
    const titleLines = wrapLines(ctx, d.jobTitle, W - PAD * 2, 2);
    for (const l of titleLines) { ctx.fillText(l, W - PAD, y); y += 28; }
  }

  if (d.quantity != null && String(d.quantity).trim()) {
    ctx.font = "700 20px Cairo, sans-serif"; ctx.textAlign = "right";
    ctx.fillText("الكمية:", W - PAD, y);
    ctx.font = "400 20px Cairo, sans-serif"; ctx.textAlign = "left";
    ctx.fillText(String(d.quantity), PAD, y);
    y += 30;
  }

  if (d.specs) {
    y += 4;
    ctx.font = "700 20px Cairo, sans-serif"; ctx.textAlign = "right";
    ctx.fillText("المواصفات:", W - PAD, y); y += 28;
    ctx.font = "400 19px Cairo, sans-serif";
    const specLines = wrapLines(ctx, d.specs, W - PAD * 2, 4);
    for (const l of specLines) { ctx.fillText(l, W - PAD, y); y += 26; }
  }

  // ──── ٦) الإجمالي ────
  y += 8; solidLine(ctx, y, 2); y += 42;
  ctx.font = "900 30px Cairo, sans-serif"; ctx.textAlign = "right";
  ctx.fillText("الإجمالي:", W - PAD, y);
  ctx.textAlign = "left";
  ctx.fillText(`${fmt(d.total)} د.ع`, PAD, y);
  y += 14; solidLine(ctx, y, 2); y += 28;

  // ──── ٧) ملاحظات ────
  if (d.notes) {
    ctx.font = "700 19px Cairo, sans-serif"; ctx.textAlign = "right";
    ctx.fillText("ملاحظات:", W - PAD, y); y += 26;
    ctx.font = "400 18px Cairo, sans-serif";
    const noteLines = wrapLines(ctx, d.notes, W - PAD * 2, 5);
    for (const l of noteLines) { ctx.fillText(l, W - PAD, y); y += 24; }
    y += 8;
  }

  // ──── ٨) توقيعات مختصرة ────
  y += 10; dashedLine(ctx, y); y += 38;
  ctx.font = "600 19px Cairo, sans-serif"; ctx.textAlign = "center";
  ctx.fillText("توقيع المسؤول", W * 0.25, y);
  ctx.fillText("توقيع العميل", W * 0.75, y);
  y += 18;
  // خطّان للتوقيع
  ctx.fillRect(PAD + 6, y, W / 2 - PAD - 30, 2);
  ctx.fillRect(W / 2 + 30, y, W / 2 - PAD - 30, 2);
  y += 26;

  // ──── ٩) تذييل ────
  dashedLine(ctx, y); y += 34;
  ctx.font = "700 20px Cairo, sans-serif"; ctx.textAlign = "center";
  ctx.fillText("شكراً لتعاملكم مع مكتبة العربية", W / 2, y); y += 28;
  ctx.font = "400 18px Cairo, sans-serif";
  for (const p of RECEIPT_PHONES.slice(0, 2)) {
    ctx.textAlign = "right"; ctx.font = "600 18px Cairo, sans-serif";
    ctx.fillText(p.l, W - PAD, y);
    ctx.textAlign = "left"; ctx.font = "700 19px Cairo, sans-serif";
    ctx.fillText(p.n, PAD, y);
    y += 26;
  }
  ctx.font = "400 17px Cairo, sans-serif"; ctx.textAlign = "center";
  ctx.fillText(CO.address, W / 2, y + 20); y += 42;

  return { canvas, height: Math.min(Math.ceil(y) + 8, estH) };
}

/** طلب الخدمة نقطيةً ESC/POS (مقصوصاً للارتفاع المستعمل). null خارج المتصفح. */
export async function workOrderToRaster(d: WorkOrderReceiptData): Promise<Raster | null> {
  const drawn = await workOrderToCanvas(d);
  if (!drawn) return null;
  const ctx = drawn.canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, W, drawn.height);
  return imageDataToRaster({ width: W, height: drawn.height, data: img.data });
}
