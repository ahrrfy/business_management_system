/**
 * server/services/barcodePdfService.ts — خدمة توليد PDF الباركود المتجهي عالي الدقة (Vector / 300+ DPI).
 *
 * مخصصة للمصانع والمنتجات المصنَّعة ومصممي التغليف:
 * 1. رسم القضبان بنواقل متجهة رياضية حقيقية (PDF vector paths) بدقة لا متناهية (تتجاوز 300 و600 و1200 DPI).
 * 2. احترام مناطق الهدوء القياسية (Quiet Zones) وفق معايير GS1 وISO/IEC.
 * 3. دعم المقاسات الصناعية الأكثر انتشاراً:
 *    - 50×30 مم: القياس العالمي المعتمد لملصقات المنتجات وعلب التصنيع.
 *    - 50×25 مم: ملصق مدمج (2×1 إنش).
 *    - 60×40 مم: ملصق الصناديق والكراتين.
 *    - artwork: باركود صافٍ متّجه مع أرقامه (للمطابع وبرامج التصميم كـ Illustrator / CorelDraw).
 *    - a4: ورقة A4 تضم شبكة من 24 ملصقاً جاهزة للطباعة على ورق الملصقات المكتبي.
 * 4. تسمية الملف تلقائياً باسم المنتج المكتوب لتسهيل الحفظ والتنظيم.
 */

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { calculateBarcodeBars, buildBarcodePdfFilename } from "@shared/barcodeEncoding";
import { COMPANY_IDENTITY as CO } from "@shared/companyIdentity";

export type BarcodePdfPreset = "50x30" | "50x25" | "60x40" | "artwork" | "a4";

export interface GenerateBarcodePdfInput {
  barcode: string;
  productName?: string | null;
  unitName?: string | null;
  retailPrice?: string | number | null;
  brand?: string | null;
  modelName?: string | null;
  sku?: string | null;
  preset?: BarcodePdfPreset;
}

export interface GenerateBarcodePdfResult {
  pdfBytes: Uint8Array;
  base64: string;
  filename: string;
}

// ── تحويل المليمتر لنقاط PDF (1 mm = 72 / 25.4 pt) ──
const MM_TO_PT = 72 / 25.4;

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const GRAY_DARK = rgb(0.2, 0.2, 0.2);
const GRAY_MUTED = rgb(0.45, 0.45, 0.45);
const BORDER_LIGHT = rgb(0.85, 0.85, 0.85);

const LTR_RUN = /[0-9A-Za-z][0-9A-Za-z+\-.,/%]*[0-9A-Za-z%]|[0-9A-Za-z]/g;

let cachedCairoBytes: Uint8Array | null = null;

async function getCairoBytes(): Promise<Uint8Array> {
  if (cachedCairoBytes) return cachedCairoBytes;
  const filename = "Cairo-Variable.ttf";
  const candidates = [
    path.resolve(process.cwd(), "dist", "public", "fonts", filename),
    path.resolve(process.cwd(), "client", "public", "fonts", filename),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const bytes = new Uint8Array(await readFile(candidate));
      cachedCairoBytes = bytes;
      return bytes;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`تعذّر تحميل خط Cairo: ${filename}`);
}

export { buildBarcodePdfFilename };

interface DrawContext {
  cairo: PDFFont;
  helv: PDFFont;
  helvBold: PDFFont;
}

/**
 * رسم نص عربي RTL في موضع محدد مع صون تسلسل المقاطع اللاتينية والأرقام LTR.
 */
function drawAr(
  pg: PDFPage,
  font: PDFFont,
  text: string,
  xRight: number,
  yy: number,
  size: number,
  color = BLACK,
  bold = false
) {
  const put = (t: string, x: number) => {
    pg.drawText(t, { x, y: yy, font, size, color });
    if (bold) pg.drawText(t, { x: x + 0.28, y: yy, font, size, color });
  };
  let cursor = xRight;
  const seg = (t: string) => {
    if (!t) return;
    const w = font.widthOfTextAtSize(t, size);
    put(t, cursor - w);
    cursor -= w;
  };
  let last = 0;
  for (const m of Array.from(text.matchAll(LTR_RUN))) {
    seg(text.slice(last, m.index));
    seg(m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  seg(text.slice(last));
}

function drawArCentered(
  pg: PDFPage,
  font: PDFFont,
  text: string,
  centerX: number,
  yy: number,
  size: number,
  color = BLACK,
  bold = false
) {
  const width = font.widthOfTextAtSize(text, size);
  drawAr(pg, font, text, centerX + width / 2, yy, size, color, bold);
}

/**
 * رسم ملصق باركود صناعي كامل داخل مستطيل محدد (originX, originY, widthPt, heightPt).
 */
function renderSingleLabel(
  pg: PDFPage,
  ctx: DrawContext,
  input: GenerateBarcodePdfInput,
  ox: number,
  oy: number,
  w: number,
  h: number,
  showBorder = false
) {
  // خلفية بيضاء نقية
  pg.drawRectangle({
    x: ox,
    y: oy,
    width: w,
    height: h,
    color: WHITE,
    borderColor: showBorder ? BORDER_LIGHT : undefined,
    borderWidth: showBorder ? 0.5 : 0,
  });

  const barcodeData = calculateBarcodeBars(input.barcode);
  const centerX = ox + w / 2;

  // 1. أعلى الملصق: اسم المنتج (ديناميكي الحجم لمنع الاقتطاع)
  const name = (input.productName || "").trim();
  const maxTitleWidth = w - 12; // هوامش جانبية 6pt

  let titleFontSize = h >= 100 ? 10 : h >= 80 ? 8.5 : 7.5;
  if (name) {
    while (titleFontSize > 6 && ctx.cairo.widthOfTextAtSize(name, titleFontSize) > maxTitleWidth) {
      titleFontSize -= 0.5;
    }
    const titleY = oy + h - titleFontSize - (h >= 100 ? 7 : 5);
    drawArCentered(pg, ctx.cairo, name, centerX, titleY, titleFontSize, BLACK, true);
  }

  // سطر إضافي للمواصفة/الوحدة إن اتسعت المساحة
  const unit = (input.unitName || "").trim();
  const brand = (input.brand || "").trim();
  const extraLine = [unit && unit !== "قطعة" ? `الوحدة: ${unit}` : null, brand ? `الماركة: ${brand}` : null]
    .filter(Boolean)
    .join("  ·  ");

  let subY = oy + h - titleFontSize - (h >= 100 ? 19 : 14);
  if (extraLine && h >= 80) {
    drawArCentered(pg, ctx.cairo, extraLine, centerX, subY, 6, GRAY_MUTED, false);
  }

  // 2. وسط الملصق: الباركود المتجهي
  // حساب عرض الموديول لملء ~78-85% من عرض الملصق مع صون مناطق الهدوء
  const targetBarWidth = w * 0.82;
  const moduleWidth = targetBarWidth / barcodeData.totalWidth;
  const actualBarcodeWidth = barcodeData.totalWidth * moduleWidth;
  const barcodeStartX = ox + (w - actualBarcodeWidth) / 2;

  // ارتفاع القضبان
  const barHeight = Math.max(16, h * 0.35);
  const barY = oy + (h >= 80 ? 22 : 18);

  for (const bar of barcodeData.bars) {
    pg.drawRectangle({
      x: barcodeStartX + bar.x * moduleWidth,
      y: barY,
      width: Math.max(0.6, bar.width * moduleWidth),
      height: barHeight,
      color: BLACK,
    });
  }

  // 3. أرقام الباركود المقروءة بشرياً (HRI) أسفل القضبان
  const hriFontSize = h >= 100 ? 8 : 7.2;
  const hriY = barY - hriFontSize - 1.5;
  const hriText = barcodeData.hriFormatted;
  const hriWidth = ctx.helvBold.widthOfTextAtSize(hriText, hriFontSize);
  pg.drawText(hriText, {
    x: centerX - hriWidth / 2,
    y: hriY,
    font: ctx.helvBold,
    size: hriFontSize,
    color: BLACK,
  });

  // 4. أسفل الملصق: السعر وهوية الشركة
  const footerY = oy + 4;
  const priceVal = input.retailPrice ? String(input.retailPrice).trim() : "";
  if (priceVal && priceVal !== "0") {
    // تنسيق السعر بالأرقام اللاتينية مع د.ع
    const numPrice = Number(priceVal.replace(/[^0-9.]/g, ""));
    const formattedPrice = !isNaN(numPrice) && numPrice > 0
      ? `${numPrice.toLocaleString("en-US")} د.ع`
      : `${priceVal} د.ع`;
    const priceText = `السعر: ${formattedPrice}`;
    // يمين
    drawAr(pg, ctx.cairo, priceText, ox + w - 6, footerY, 6.5, GRAY_DARK, true);
  }

  // يسار أسفل: هوية المؤسسة
  const companyLabel = CO.sub || "الرؤية العربية";
  drawAr(pg, ctx.cairo, companyLabel, ox + ctx.cairo.widthOfTextAtSize(companyLabel, 5.8) + 6, footerY, 5.8, GRAY_MUTED, false);
}

/**
 * رسم صفحة باركود متّجه صافٍ (Artwork Mode) لمصممي العلب والمطابع.
 */
function renderArtwork(
  pg: PDFPage,
  ctx: DrawContext,
  input: GenerateBarcodePdfInput,
  pageW: number,
  pageH: number
) {
  const barcodeData = calculateBarcodeBars(input.barcode);
  const moduleWidth = 1.15; // عرض معياري ممتاز للطباعة المتجهية
  const actualBarcodeWidth = barcodeData.totalWidth * moduleWidth;
  const barcodeStartX = (pageW - actualBarcodeWidth) / 2;
  const barHeight = 40;
  const barY = 22;

  // رسم القضبان
  for (const bar of barcodeData.bars) {
    pg.drawRectangle({
      x: barcodeStartX + bar.x * moduleWidth,
      y: barY,
      width: Math.max(0.7, bar.width * moduleWidth),
      height: barHeight,
      color: BLACK,
    });
  }

  // رسم الأرقام HRI
  const hriFontSize = 9.5;
  const hriY = barY - hriFontSize - 2.5;
  const hriText = barcodeData.hriFormatted;
  const hriWidth = ctx.helvBold.widthOfTextAtSize(hriText, hriFontSize);
  pg.drawText(hriText, {
    x: (pageW - hriWidth) / 2,
    y: hriY,
    font: ctx.helvBold,
    size: hriFontSize,
    color: BLACK,
  });

  // اسم المنتج أعلى الباركود إن وُجد
  const name = (input.productName || "").trim();
  if (name) {
    drawArCentered(pg, ctx.cairo, name, pageW / 2, barY + barHeight + 8, 9, BLACK, true);
  }
}

/**
 * رسم ورقة A4 كاملة تحتوي على شبكة 24 ملصقاً (3 أعمدة × 8 صفوف) من مقاس 50×30 مم.
 */
function renderA4Sheet(
  pg: PDFPage,
  ctx: DrawContext,
  input: GenerateBarcodePdfInput
) {
  // A4: 210mm × 297mm = 595.28 pt × 841.89 pt
  const cols = 3;
  const rows = 8;
  const labelWPt = 50 * MM_TO_PT; // ~141.73 pt
  const labelHPt = 30 * MM_TO_PT; // ~85.04 pt

  // حساب الهوامش لتوسيط الشبكة
  const totalGridW = cols * labelWPt;
  const totalGridH = rows * labelHPt;
  const marginX = (595.28 - totalGridW) / 2; // ~85 pt
  const marginY = (841.89 - totalGridH) / 2; // ~80 pt

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ox = marginX + c * labelWPt;
      // ترتيب من الأعلى إلى الأسفل
      const oy = 841.89 - marginY - (r + 1) * labelHPt;
      renderSingleLabel(pg, ctx, input, ox, oy, labelWPt, labelHPt, true);
    }
  }
}

/**
 * التوليد الخادمي الرئيسي لوثيقة PDF عالية الدقة.
 */
export async function generateBarcodePdf(
  input: GenerateBarcodePdfInput
): Promise<GenerateBarcodePdfResult> {
  const code = (input.barcode || "").trim();
  if (!code) throw new Error("لا يوجد باركود لتوليد ملف PDF");

  const preset = input.preset ?? "50x30";
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const cairoBytes = await getCairoBytes();
  const cairo = await pdf.embedFont(cairoBytes, { subset: true });
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const ctx: DrawContext = { cairo, helv, helvBold };

  let pageW = 50 * MM_TO_PT;
  let pageH = 30 * MM_TO_PT;

  if (preset === "50x25") {
    pageW = 50 * MM_TO_PT;
    pageH = 25 * MM_TO_PT;
    const page = pdf.addPage([pageW, pageH]);
    renderSingleLabel(page, ctx, input, 0, 0, pageW, pageH, false);
  } else if (preset === "60x40") {
    pageW = 60 * MM_TO_PT;
    pageH = 40 * MM_TO_PT;
    const page = pdf.addPage([pageW, pageH]);
    renderSingleLabel(page, ctx, input, 0, 0, pageW, pageH, false);
  } else if (preset === "artwork") {
    const barcodeData = calculateBarcodeBars(code);
    pageW = Math.max(160, barcodeData.totalWidth * 1.15 + 30);
    pageH = 80;
    const page = pdf.addPage([pageW, pageH]);
    renderArtwork(page, ctx, input, pageW, pageH);
  } else if (preset === "a4") {
    pageW = 210 * MM_TO_PT;
    pageH = 297 * MM_TO_PT;
    const page = pdf.addPage([pageW, pageH]);
    renderA4Sheet(page, ctx, input);
  } else {
    // 50x30 (الافتراضي القياسي)
    pageW = 50 * MM_TO_PT;
    pageH = 30 * MM_TO_PT;
    const page = pdf.addPage([pageW, pageH]);
    renderSingleLabel(page, ctx, input, 0, 0, pageW, pageH, false);
  }

  const pdfBytes = await pdf.save();
  const base64 = Buffer.from(pdfBytes).toString("base64");
  const filename = buildBarcodePdfFilename({
    productName: input.productName,
    unitName: input.unitName,
    barcode: code,
  });

  return { pdfBytes, base64, filename };
}
