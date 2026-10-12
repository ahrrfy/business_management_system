/**
 * server/services/couponPdfService.ts
 *
 * خدمة تصدير كوبونات الخصم كملف PDF متعدد الصفحات عالي الدقة:
 * - كل كوبون يقع في صفحته المستقلة الخاصة به بأبعاد 54×84 مم دقيقة (54mm × 84mm).
 * - رسم متّجه حقيقي (Vector) مع تضمين خط Cairo العربي الأصيل ورمز QR عالي الوضوح.
 * - جاهز للطباعة المباشرة على طابعات البطاقات أو مقصّات الورق المنفصلة.
 */

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { COMPANY_IDENTITY as CO } from "../../shared/companyIdentity";
import { formatActiveDays, type PromotionDesignMeta } from "../../shared/promotionScheduling";

const MM_TO_PT = 72 / 25.4;
const CARD_WIDTH_PT = 54 * MM_TO_PT; // ~153.07 pt
const CARD_HEIGHT_PT = 84 * MM_TO_PT; // ~238.11 pt

const BLACK = rgb(0.07, 0.07, 0.07);
const WHITE = rgb(1, 1, 1);
const GRAY_DARK = rgb(0.2, 0.2, 0.2);
const GRAY_MUTED = rgb(0.4, 0.4, 0.4);
const LIGHT_BG = rgb(0.97, 0.98, 0.98);

const LTR_RUN = /[0-9A-Za-z][0-9A-Za-z+\-.,/%]*[0-9A-Za-z%]|[0-9A-Za-z]/g;

let cachedCairoBytes: Uint8Array | null = null;

async function getCairoBytes(): Promise<Uint8Array> {
  if (cachedCairoBytes) return cachedCairoBytes;
  const filename = "Cairo-Variable.ttf";
  const candidates = [
    path.resolve(process.cwd(), "client", "public", "fonts", filename),
    path.resolve(process.cwd(), "dist", "public", "fonts", filename),
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

function hexToRgb(hex?: string | null) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return rgb(0.05, 0.42, 0.32); // #0D6B52
  }
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  return rgb(r, g, b);
}

function drawAr(
  pg: PDFPage,
  font: PDFFont,
  text: string,
  xRight: number,
  yy: number,
  size: number,
  color = BLACK,
  bold = false,
) {
  const put = (t: string, x: number) => {
    pg.drawText(t, { x, y: yy, font, size, color });
    if (bold) pg.drawText(t, { x: x + 0.25, y: yy, font, size, color });
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
  bold = false,
) {
  const width = font.widthOfTextAtSize(text, size);
  drawAr(pg, font, text, centerX + width / 2, yy, size, color, bold);
}

export interface CouponPdfItem {
  code: string;
  title?: string | null;
  subtitle?: string | null;
  heroDiscount?: string | null;
  discountCap?: string | null;
  minSpend?: string | null;
  terms?: string | null;
  validTo?: string | Date | null;
  activeDaysText?: string | null;
  color?: string | null;
  storeUrl?: string | null;
}

export interface GenerateCouponsPdfInput {
  programName: string;
  coupons: CouponPdfItem[];
}

export interface GenerateCouponsPdfResult {
  pdfBytes: Uint8Array;
  base64: string;
  filename: string;
  pageCount: number;
}

/**
 * توليد ملف PDF حيث كل بطاقة كوبون تقع في صفحة مستقلة بقياس 54×84 مم تماماً.
 */
export async function generateCouponsStandalonePdf(
  input: GenerateCouponsPdfInput,
): Promise<GenerateCouponsPdfResult> {
  if (!input?.coupons || input.coupons.length === 0) {
    throw new Error("لا توجد كوبونات للتصدير");
  }

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const cairoBytes = await getCairoBytes();
  const cairoFont = await pdfDoc.embedFont(cairoBytes);
  const monoFont = await pdfDoc.embedFont(StandardFonts.CourierBold);

  const totalCoupons = input.coupons.length;

  for (let idx = 0; idx < totalCoupons; idx++) {
    const item = input.coupons[idx];
    const page = pdfDoc.addPage([CARD_WIDTH_PT, CARD_HEIGHT_PT]);
    const accentRgb = hexToRgb(item.color);

    // 1. خلفية البطاقة
    page.drawRectangle({
      x: 0,
      y: 0,
      width: CARD_WIDTH_PT,
      height: CARD_HEIGHT_PT,
      color: WHITE,
    });

    // 2. إطار البطاقة الزخرفي (مع هامش 2 مم)
    const marginPt = 2.5 * MM_TO_PT;
    const frameW = CARD_WIDTH_PT - marginPt * 2;
    const frameH = CARD_HEIGHT_PT - marginPt * 2;
    page.drawRectangle({
      x: marginPt,
      y: marginPt,
      width: frameW,
      height: frameH,
      borderColor: accentRgb,
      borderWidth: 1.2,
      color: WHITE,
    });

    // إطار داخلي رقيق
    page.drawRectangle({
      x: marginPt + 2,
      y: marginPt + 2,
      width: frameW - 4,
      height: frameH - 4,
      borderColor: rgb(0.88, 0.88, 0.88),
      borderWidth: 0.5,
    });

    const centerX = CARD_WIDTH_PT / 2;
    let curY = CARD_HEIGHT_PT - marginPt - 12;

    // 3. الترويسة: اسم الشركة
    drawArCentered(page, cairoFont, CO.name || "شركة الرؤية العربية", centerX, curY, 8.5, accentRgb, true);
    curY -= 10;
    drawArCentered(page, cairoFont, "قسيمة خصم رسمية", centerX, curY, 6.5, GRAY_MUTED);

    // خط فاصل زخرفي
    curY -= 6;
    page.drawLine({
      start: { x: centerX - 40, y: curY },
      end: { x: centerX + 40, y: curY },
      color: accentRgb,
      thickness: 0.75,
    });

    // 4. عنوان العرض
    curY -= 12;
    const cardTitle = item.title?.trim() || input.programName || "عرض ترويجي حصري";
    drawArCentered(page, cairoFont, cardTitle, centerX, curY, 9.5, BLACK, true);

    // 5. شارة الخصم البارزة (Hero Discount Badge)
    if (item.heroDiscount?.trim()) {
      curY -= 18;
      const badgeW = 100;
      const badgeH = 16;
      page.drawRectangle({
        x: centerX - badgeW / 2,
        y: curY - 3,
        width: badgeW,
        height: badgeH,
        color: accentRgb,
      });
      drawArCentered(page, cairoFont, item.heroDiscount.trim(), centerX, curY + 1, 10, WHITE, true);
    }

    // 6. القيود والشروط الفرعية (سقف الخصم، الحد الأدنى، الأيام)
    if (item.discountCap?.trim()) {
      curY -= 10;
      drawArCentered(page, cairoFont, item.discountCap.trim(), centerX, curY, 6.5, GRAY_DARK);
    }
    if (item.minSpend?.trim()) {
      curY -= 9;
      drawArCentered(page, cairoFont, item.minSpend.trim(), centerX, curY, 6.5, GRAY_DARK);
    }
    if (item.activeDaysText?.trim()) {
      curY -= 9;
      drawArCentered(page, cairoFont, item.activeDaysText.trim(), centerX, curY, 6.5, accentRgb, true);
    }

    // 7. توليد ورسم رمز QR
    const qrTarget = item.storeUrl?.trim() || `https://alarabiya.online/store?coupon=${encodeURIComponent(item.code)}`;
    const qrDataUrl = await QRCode.toDataURL(qrTarget, {
      margin: 1,
      width: 180,
      errorCorrectionLevel: "H",
      color: { dark: "#000000", light: "#ffffff" },
    });
    const qrPngBytes = Buffer.from(qrDataUrl.split(",")[1], "base64");
    const qrImage = await pdfDoc.embedPng(qrPngBytes);
    const qrSize = 58; // pt (~20.5 mm)
    curY -= (qrSize + 4);
    page.drawImage(qrImage, {
      x: centerX - qrSize / 2,
      y: curY,
      width: qrSize,
      height: qrSize,
    });

    // 8. مربع الرمز المقروء بشرياً (Monospace Code)
    curY -= 14;
    const codeBoxW = 110;
    const codeBoxH = 14;
    page.drawRectangle({
      x: centerX - codeBoxW / 2,
      y: curY - 2,
      width: codeBoxW,
      height: codeBoxH,
      borderColor: accentRgb,
      borderWidth: 0.8,
      color: LIGHT_BG,
    });
    const codeText = item.code.trim();
    const codeW = monoFont.widthOfTextAtSize(codeText, 9.5);
    page.drawText(codeText, {
      x: centerX - codeW / 2,
      y: curY + 1.5,
      font: monoFont,
      size: 9.5,
      color: BLACK,
    });

    // 9. الصلاحية والشروط السفلية
    curY -= 11;
    let validText = "صالح حتى انتهاء الحملة";
    if (item.validTo) {
      const vDate = item.validTo instanceof Date ? item.validTo : new Date(item.validTo);
      validText = Number.isNaN(vDate.getTime()) ? `صالح لغاية ${item.validTo}` : `صالح لغاية ${vDate.toISOString().slice(0, 10)}`;
    }
    drawArCentered(page, cairoFont, validText, centerX, curY, 6.5, GRAY_MUTED);

    // تذييل الشروط
    const terms = item.terms?.trim() || "تطبق الشروط والأحكام · يُستخدم لمرة واحدة فقط";
    curY -= 9;
    drawArCentered(page, cairoFont, terms.slice(0, 50), centerX, curY, 5.5, GRAY_MUTED);
  }

  const pdfBytes = await pdfDoc.save();
  const base64 = Buffer.from(pdfBytes).toString("base64");
  const rawName = input.programName ? input.programName.trim() : "coupons";
  const safeName = rawName.replace(/[^\w\u0600-\u06FF-]+/g, "_") || "coupons";
  const filename = `${safeName}-54x84mm-${totalCoupons}-cards.pdf`;

  return {
    pdfBytes,
    base64,
    filename,
    pageCount: totalCoupons,
  };
}
