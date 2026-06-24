// الراسم الحراري المُعلَّم لإيصالَي الوردية (فتح + إغلاق/Z) — يرسم التصميم المعتمد
// (شعار + شارات معكوسة + كتل بارزة + تسوية صندوق + توقيعات) على Canvas 576px ثم يحوّله
// نقطية ESC/POS. هذا هو نظير receiptRaster.ts/workOrderRaster.ts لإيصالات الوردية، كي
// يُطبع التصميم المُعلَّم نفسه على المسار الصامت (جسر الخادم / WebUSB) لا التخطيط المبسّط.
//
// قيد: كل العناصر بأسود صافٍ (#000) والكتل المعكوسة خلفية سوداء + نصّ أبيض، بعتبة لمعان
// مرفوعة (THRESHOLD) لتسمين الخطوط فيظهر الإيصال غامقاً واضحاً لا باهتاً.
import { imageDataToRaster, type Raster } from "./escpos";
import { CO, RECEIPT_PHONES, fmt, logoUrl } from "./brand";
import type { ShiftOpenData, ShiftCloseData } from "./printTemplates";

const W = 576; // 80مم @ 203dpi
const PAD = 16;
const THRESHOLD = 160;

const METHOD_AR: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة",
};

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function ensureFonts(): Promise<void> {
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    const sample = "مكتبة العربية الوردية الرصيد الافتتاحي 0123 IQD";
    await Promise.all(
      ["600 24px Cairo", "700 26px Cairo", "800 28px Cairo", "900 30px Cairo", "900 38px Cairo", "900 48px Cairo"].map(
        (f) => fonts.load(f, sample).catch(() => undefined),
      ),
    );
  } catch { /* تدهور سلس */ }
}

function calcDuration(openedAt: Date | string | null, closedAt: Date): string {
  if (!openedAt) return "—";
  const ms = closedAt.getTime() - new Date(openedAt).getTime();
  if (ms < 0) return "—";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h === 0) return `${m} دقيقة`;
  return m > 0 ? `${h} ساعة ${m} دقيقة` : `${h} ساعة`;
}

function solidLine(ctx: CanvasRenderingContext2D, y: number, lw = 3): void {
  ctx.save(); ctx.fillStyle = "#000"; ctx.fillRect(PAD, y, W - PAD * 2, lw); ctx.restore();
}

function dashedLine(ctx: CanvasRenderingContext2D, y: number): void {
  ctx.save(); ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5; ctx.setLineDash([7, 5]);
  ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke(); ctx.restore();
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** كتلة معكوسة (خلفية سوداء) بزوايا خفيفة — تُرسم من y بارتفاع h. */
function invertedBlock(ctx: CanvasRenderingContext2D, y: number, h: number): void {
  ctx.save(); ctx.fillStyle = "#000"; roundRectPath(ctx, PAD, y, W - PAD * 2, h, 5); ctx.fill(); ctx.restore();
}

/** إطار (بلا تعبئة) — لصناديق التحقق/النقد البارزة. */
function strokeBox(ctx: CanvasRenderingContext2D, y: number, h: number, lw = 2): void {
  ctx.save(); ctx.strokeStyle = "#000"; ctx.lineWidth = lw;
  roundRectPath(ctx, PAD + lw / 2, y, W - PAD * 2 - lw, h, 4); ctx.stroke(); ctx.restore();
}

/** رأس الشركة المشترك. يعيد y بعد الرسم. */
async function drawHeader(ctx: CanvasRenderingContext2D, y: number): Promise<number> {
  const logo = await loadImage(logoUrl());
  if (logo) { ctx.drawImage(logo, (W - 140) / 2, y, 140, 140); y += 140; }
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.font = "900 38px Cairo, sans-serif"; y += 44; ctx.fillText("مكتبة العربية", W / 2, y);
  ctx.font = "800 26px Cairo, sans-serif"; y += 34; ctx.fillText("للطباعة والقرطاسية", W / 2, y);
  ctx.font = "600 17px Cairo, sans-serif"; y += 24; ctx.fillText(CO.name, W / 2, y);
  y += 22; ctx.fillText(CO.address, W / 2, y);
  y += 14; solidLine(ctx, y, 4); y += 8;
  return y;
}

/** شارة عنوان معكوسة: سطر كبير + سطر فرعي. يعيد y بعد الرسم. */
function drawBadge(ctx: CanvasRenderingContext2D, y: number, title: string, subtitle: string): number {
  const h = 84;
  invertedBlock(ctx, y, h);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.font = "900 30px Cairo, sans-serif";
  ctx.fillText(title, W / 2, y + 38);
  ctx.font = "600 20px Cairo, sans-serif";
  ctx.fillText(subtitle, W / 2, y + 68);
  ctx.fillStyle = "#000";
  return y + h + 14;
}

/** صف بيانات (تسمية يمين/قيمة يسار) + خط dashed أسفله. يعيد y بعد الرسم. */
function metaRow(ctx: CanvasRenderingContext2D, y: number, label: string, value: string): number {
  ctx.fillStyle = "#000";
  ctx.font = "600 25px Cairo, sans-serif"; ctx.textAlign = "right"; ctx.fillText(label, W - PAD, y);
  ctx.font = "800 26px Cairo, sans-serif"; ctx.textAlign = "left"; ctx.fillText(value, PAD, y);
  dashedLine(ctx, y + 12);
  return y + 44;
}

/** رأس قسم معكوس (شريط أسود صغير). يعيد y بعد الرسم. */
function sectionHdr(ctx: CanvasRenderingContext2D, y: number, title: string): number {
  const h = 46;
  invertedBlock(ctx, y, h);
  ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.font = "900 26px Cairo, sans-serif";
  ctx.fillText(title, W / 2, y + 31);
  ctx.fillStyle = "#000";
  return y + h + 12;
}

/** شبكة توقيعين (كاشير/مشرف). يعيد y بعد الرسم. */
function drawSignatures(ctx: CanvasRenderingContext2D, y: number, leftLabel: string, rightLabel: string): number {
  y += 34;
  ctx.fillStyle = "#000";
  // خطّا التوقيع
  ctx.fillRect(PAD + 10, y, W / 2 - PAD - 30, 2);
  ctx.fillRect(W / 2 + 20, y, W / 2 - PAD - 30, 2);
  y += 28;
  ctx.font = "700 20px Cairo, sans-serif"; ctx.textAlign = "center";
  ctx.fillText(rightLabel, W * 0.27, y);
  ctx.fillText(leftLabel, W * 0.73, y);
  return y + 16;
}

/** تذييل: سطر بارز + أول رقمي تواصل. يعيد y بعد الرسم. */
function drawFooter(ctx: CanvasRenderingContext2D, y: number, headline: string): number {
  solidLine(ctx, y, 3); y += 36;
  ctx.fillStyle = "#000"; ctx.textAlign = "center";
  ctx.font = "900 24px Cairo, sans-serif"; ctx.fillText(headline, W / 2, y); y += 32;
  ctx.font = "600 20px Cairo, sans-serif";
  for (const p of RECEIPT_PHONES.slice(0, 2)) {
    ctx.textAlign = "right"; ctx.font = "600 20px Cairo, sans-serif"; ctx.fillText(p.l, W - PAD, y);
    ctx.textAlign = "left"; ctx.font = "700 21px Cairo, sans-serif"; ctx.fillText(p.n, PAD, y);
    y += 28;
  }
  return y + 6;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ١) فتح الوردية
// ═══════════════════════════════════════════════════════════════════════════════

export async function shiftOpenToCanvas(
  d: ShiftOpenData,
): Promise<{ canvas: HTMLCanvasElement; height: number } | null> {
  if (typeof document === "undefined") return null;
  await ensureFonts();

  const estH = 1500;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = estH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, estH);
  ctx.fillStyle = "#000";
  (ctx as unknown as { direction: string }).direction = "rtl";
  ctx.textBaseline = "alphabetic";

  const date    = d.openedAt.toLocaleDateString("en-GB");
  const time    = d.openedAt.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" });
  const printed = d.openedAt.toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" });

  let y = PAD;
  y = await drawHeader(ctx, y);
  y = drawBadge(ctx, y, "فتح الوردية", "بيان الرصيد الافتتاحي");

  y += 16;
  y = metaRow(ctx, y, "رقم الوردية", `#${d.shiftId}`);
  y = metaRow(ctx, y, "التاريخ", date);
  y = metaRow(ctx, y, "وقت الفتح", time);
  y = metaRow(ctx, y, "الكاشير", d.cashierName);
  y = metaRow(ctx, y, "الفرع", d.branchName);
  y = metaRow(ctx, y, "طُبعت في", printed);

  // كتلة الرصيد الافتتاحي المعكوسة الكبيرة
  y += 10;
  const balH = 130;
  invertedBlock(ctx, y, balH);
  ctx.fillStyle = "#fff"; ctx.textAlign = "center";
  ctx.font = "700 22px Cairo, sans-serif"; ctx.fillText("الرصيد الافتتاحي للصندوق", W / 2, y + 34);
  ctx.font = "900 48px Cairo, sans-serif"; ctx.fillText(fmt(d.openingBalance), W / 2, y + 90);
  ctx.font = "800 24px Cairo, sans-serif"; ctx.fillText("دينار عراقي", W / 2, y + 120);
  ctx.fillStyle = "#000";
  y += balH + 16;

  // صندوق تحقق الكاشير
  const vbH = 92;
  strokeBox(ctx, y, vbH, 2);
  ctx.fillStyle = "#000"; ctx.textAlign = "center";
  ctx.font = "800 22px Cairo, sans-serif"; ctx.fillText("تحقق الكاشير من الرصيد المستلم", W / 2, y + 32);
  ctx.font = "700 24px Cairo, sans-serif"; ctx.textAlign = "right";
  ctx.fillText("مستلم نقداً:", W - PAD - 14, y + 70);
  ctx.font = "900 26px Cairo, sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`${fmt(d.openingBalance)} د.ع`, PAD + 14, y + 70);
  y += vbH + 16;

  dashedLine(ctx, y); y += 18;
  y = drawSignatures(ctx, y, "توقيع المشرف", "توقيع الكاشير");
  y += 16;
  y = drawFooter(ctx, y, CO.footer);

  return { canvas, height: Math.min(Math.ceil(y) + 10, estH) };
}

export async function shiftOpenToRaster(d: ShiftOpenData): Promise<Raster | null> {
  const drawn = await shiftOpenToCanvas(d);
  if (!drawn) return null;
  const ctx = drawn.canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, W, drawn.height);
  return imageDataToRaster({ width: W, height: drawn.height, data: img.data }, THRESHOLD);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ٢) إغلاق الوردية / Z-Report
// ═══════════════════════════════════════════════════════════════════════════════

// أعمدة جدول طرق الدفع (RTL): الطريقة يميناً ← عدد توسيط ← المبلغ يساراً
const PAY_AMOUNT_X = PAD;
const PAY_COUNT_X = PAD + 110;
const PAY_METHOD_R = W - PAD;

export async function shiftCloseToCanvas(
  d: ShiftCloseData,
): Promise<{ canvas: HTMLCanvasElement; height: number } | null> {
  if (typeof document === "undefined") return null;
  await ensureFonts();

  const payList = d.payments.filter((p) => Number(p.total) !== 0);
  const estH = 2200 + payList.length * 48;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = estH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, estH);
  ctx.fillStyle = "#000";
  (ctx as unknown as { direction: string }).direction = "rtl";
  ctx.textBaseline = "alphabetic";

  const openedStr = d.openedAt
    ? new Date(d.openedAt).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" })
    : "—";
  const closedStr = d.closedAt.toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" });
  const duration  = calcDuration(d.openedAt, d.closedAt);

  const discounts = Number(d.discountsTotal ?? 0);
  const returns   = Number(d.returnsTotal ?? 0);
  const netSales  = Number(d.salesTotal) - discounts - returns;

  const varNum   = Number(d.variance);
  const varLabel = varNum === 0 ? "مطابق تماماً ✓" : varNum > 0 ? "الفرق — زيادة" : "الفرق — عجز";
  const varVal   = varNum === 0 ? "صفر" : `${varNum > 0 ? "+" : "−"} ${fmt(Math.abs(varNum))} د.ع`;

  let y = PAD;
  y = await drawHeader(ctx, y);
  y = drawBadge(ctx, y, "إغلاق الوردية", "تقرير نهاية اليوم — Z");

  y += 14;
  y = metaRow(ctx, y, "رقم الوردية", `#${d.shiftId}`);
  y = metaRow(ctx, y, "فُتحت", openedStr);
  y = metaRow(ctx, y, "أُغلقت", closedStr);
  y = metaRow(ctx, y, "مدة الوردية", duration);
  y = metaRow(ctx, y, "الكاشير", d.cashierName);
  y = metaRow(ctx, y, "الفرع", d.branchName);

  // ─── ملخّص المبيعات ───
  y += 6;
  y = sectionHdr(ctx, y, "ملخّص المبيعات");
  const bigRow = (label: string, value: string) => {
    ctx.fillStyle = "#000"; ctx.font = "600 24px Cairo, sans-serif"; ctx.textAlign = "right";
    ctx.fillText(label, W - PAD, y);
    ctx.font = "900 28px Cairo, sans-serif"; ctx.textAlign = "left"; ctx.fillText(value, PAD, y);
    dashedLine(ctx, y + 12); y += 44;
  };
  bigRow("عدد الفواتير", `${d.invoiceCount} فاتورة`);
  bigRow("إجمالي المبيعات", `${fmt(d.salesTotal)} د.ع`);
  if (discounts > 0) bigRow("إجمالي الخصومات", `${fmt(discounts)} د.ع`);
  if (returns > 0) bigRow("المرتجعات", `${fmt(returns)} د.ع`);

  // صافي المبيعات — كتلة معكوسة
  const netH = 56;
  invertedBlock(ctx, y, netH);
  ctx.fillStyle = "#fff";
  ctx.font = "900 26px Cairo, sans-serif"; ctx.textAlign = "right"; ctx.fillText("صافي المبيعات", W - PAD - 12, y + 37);
  ctx.font = "900 28px Cairo, sans-serif"; ctx.textAlign = "left"; ctx.fillText(`${fmt(netSales)} د.ع`, PAD + 12, y + 37);
  ctx.fillStyle = "#000";
  y += netH + 14;

  // ─── تفصيل طرق الدفع ───
  y = sectionHdr(ctx, y, "تفصيل طرق الدفع");
  ctx.fillStyle = "#000"; ctx.font = "800 22px Cairo, sans-serif";
  ctx.textAlign = "right"; ctx.fillText("الطريقة", PAY_METHOD_R, y);
  ctx.textAlign = "center"; ctx.fillText("عدد", PAY_COUNT_X, y);
  ctx.textAlign = "left"; ctx.fillText("المبلغ", PAY_AMOUNT_X, y);
  y += 8; solidLine(ctx, y, 2); y += 32;
  if (payList.length === 0) {
    ctx.font = "600 22px Cairo, sans-serif"; ctx.textAlign = "center"; ctx.fillText("لا حركات", W / 2, y); y += 30;
  } else {
    for (const p of payList) {
      const label = `${METHOD_AR[p.method] ?? p.method} ${p.direction === "IN" ? "وارد" : "صادر"}`;
      const amt = p.direction === "OUT" ? `( ${fmt(p.total)} )` : fmt(p.total);
      ctx.font = "700 23px Cairo, sans-serif"; ctx.textAlign = "right"; ctx.fillText(label, PAY_METHOD_R, y);
      ctx.font = "600 22px Cairo, sans-serif"; ctx.textAlign = "center"; ctx.fillText(String(p.count), PAY_COUNT_X, y);
      ctx.font = "800 23px Cairo, sans-serif"; ctx.textAlign = "left"; ctx.fillText(amt, PAY_AMOUNT_X, y);
      dashedLine(ctx, y + 12); y += 44;
    }
  }

  // ─── تسوية الصندوق النقدي ───
  y += 4;
  y = sectionHdr(ctx, y, "تسوية الصندوق النقدي");
  y = metaRow(ctx, y, "الرصيد الافتتاحي", `${fmt(d.openingBalance)} د.ع`);

  // النقد المتوقع — صندوق بارز
  const ecH = 56;
  strokeBox(ctx, y, ecH, 2);
  ctx.fillStyle = "#000";
  ctx.font = "900 24px Cairo, sans-serif"; ctx.textAlign = "right"; ctx.fillText("النقد المتوقع", W - PAD - 12, y + 37);
  ctx.font = "900 26px Cairo, sans-serif"; ctx.textAlign = "left"; ctx.fillText(`${fmt(d.expectedCash)} د.ع`, PAD + 12, y + 37);
  y += ecH + 12;

  // النقد المعدود — صندوق بارز أثقل
  const ccH = 56;
  strokeBox(ctx, y, ccH, 3);
  ctx.fillStyle = "#000";
  ctx.font = "900 24px Cairo, sans-serif"; ctx.textAlign = "right"; ctx.fillText("النقد المعدود", W - PAD - 12, y + 37);
  ctx.font = "900 26px Cairo, sans-serif"; ctx.textAlign = "left"; ctx.fillText(`${fmt(d.countedCash)} د.ع`, PAD + 12, y + 37);
  y += ccH + 16;

  // الفرق — كتلة معكوسة
  const vH = varNum !== 0 ? 86 : 64;
  invertedBlock(ctx, y, vH);
  ctx.fillStyle = "#fff"; ctx.textAlign = "right";
  ctx.font = "900 26px Cairo, sans-serif"; ctx.fillText(varLabel, W - PAD - 12, y + (varNum !== 0 ? 36 : 42));
  if (varNum !== 0) { ctx.font = "600 18px Cairo, sans-serif"; ctx.fillText("يتطلّب مراجعة المشرف", W - PAD - 12, y + 64); }
  ctx.textAlign = "left"; ctx.font = "900 34px Cairo, sans-serif"; ctx.fillText(varVal, PAD + 12, y + (varNum !== 0 ? 52 : 44));
  ctx.fillStyle = "#000";
  y += vH + 16;

  // الإجمالي الكبير — كتلة معكوسة
  const totH = 130;
  invertedBlock(ctx, y, totH);
  ctx.fillStyle = "#fff"; ctx.textAlign = "center";
  ctx.font = "700 22px Cairo, sans-serif"; ctx.fillText("إجمالي مبيعات الوردية", W / 2, y + 34);
  ctx.font = "900 48px Cairo, sans-serif"; ctx.fillText(fmt(d.salesTotal), W / 2, y + 90);
  ctx.font = "800 24px Cairo, sans-serif"; ctx.fillText("دينار عراقي", W / 2, y + 120);
  ctx.fillStyle = "#000";
  y += totH + 16;

  dashedLine(ctx, y); y += 18;
  y = drawSignatures(ctx, y, "توقيع المشرف", "توقيع الكاشير");

  y += 18; dashedLine(ctx, y); y += 28;
  ctx.fillStyle = "#000"; ctx.font = "600 19px Cairo, sans-serif"; ctx.textAlign = "center";
  ctx.fillText(`طُبع: ${closedStr} · نسخة أصلية`, W / 2, y); y += 24;

  y = drawFooter(ctx, y, "نهاية الوردية — شكراً");

  return { canvas, height: Math.min(Math.ceil(y) + 10, estH) };
}

export async function shiftCloseToRaster(d: ShiftCloseData): Promise<Raster | null> {
  const drawn = await shiftCloseToCanvas(d);
  if (!drawn) return null;
  const ctx = drawn.canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, W, drawn.height);
  return imageDataToRaster({ width: W, height: drawn.height, data: img.data }, THRESHOLD);
}
