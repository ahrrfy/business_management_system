/**
 * مولّد Code128 مكتفٍ ذاتياً (بلا تبعيات) — يدعم النمطين B (ASCII) وC (أزواج أرقام)،
 * مع اختيار تلقائي للأمثل، ورقم تحقّق (checksum)، ونمطَي البداية/الإيقاف.
 * يُخرج SVG قابلاً للمسح. Code128 يرمّز أي ASCII، فيغطّي أرقام EAN والرموز الداخلية معاً.
 *
 * مرجع الجدول: 107 رمزاً (0..106). كل رمز = 6 عناصر (3 أعمدة سود + 3 بيض) بعرض إجمالي 11 وحدة،
 * عدا رمز الإيقاف (13 وحدة: 7 أعمدة). القيم أدناه هي عروض العناصر بالوحدات.
 */

import {
  CODE128_PATTERNS,
  code128Checksum as computeCode128Checksum,
  eanCheckDigit,
  eanModules,
  encodeCode128Values,
  isValidEan,
} from "@shared/barcodeEncoding";

export { eanCheckDigit, eanModules, isValidEan };

const STOP = 106;

export interface Code128Options {
  /** عرض الوحدة (module) بالبكسل. */
  moduleWidth?: number;
  /** ارتفاع القضبان بالبكسل. */
  height?: number;
  /** هامش جانبي (quiet zone) **بالوحدات** (يتضاعف مع moduleWidth — المواصفة تشترط ≥10×X). */
  quietZone?: number;
  /** عرض النص أسفل الباركود. */
  showText?: boolean;
  /**
   * يُخرج <svg> بعرض/ارتفاع 100% وpreserveAspectRatio="none" ⇒ يملأ صندوقه (CSS) تماماً.
   * يُستعمل للملصقات المتّجهة: القضبان تتمدّد لتملأ عرض الملصق وارتفاعه المتاح ⇒ أثخن قضبان
   * ممكنة (أوضح للماسح) بلا تحويلٍ إلى صورة. التمدّد الأفقي منتظم ⇒ نِسب القضبان محفوظة.
   */
  fitToBox?: boolean;
}

export interface Code128Result {
  svg: string;
  widthPx: number;
  heightPx: number;
}

/** يولّد SVG لباركود Code128 من نصّ ASCII (32..126). */
export function code128Svg(data: string, opts: Code128Options = {}): Code128Result {
  if (!data) throw new Error("الباركود فارغ");
  const moduleWidth = opts.moduleWidth ?? 2;
  const height = opts.height ?? 60;
  const quiet = opts.quietZone ?? 10;
  const showText = opts.showText ?? true;
  const textH = showText ? 16 : 0;

  const values = encodeCode128Values(data);
  const cs = computeCode128Checksum(values);
  const full = [...values, cs, STOP];

  let x = quiet * moduleWidth;
  const bars: { x: number; w: number }[] = [];
  for (const v of full) {
    const pat = CODE128_PATTERNS[v];
    let black = true;
    for (const chWidth of pat) {
      const w = parseInt(chWidth, 10);
      if (black) bars.push({ x, w: w * moduleWidth });
      x += w * moduleWidth;
      black = !black;
    }
  }
  return finishSvg(bars, x + quiet * moduleWidth, height, textH, showText ? data : "", opts.fitToBox);
}

/** يبني وثيقة SVG نهائية من قضبانٍ محسوبة — مشترك بين Code128 وEAN. */
function finishSvg(
  bars: { x: number; w: number }[],
  widthPx: number,
  height: number,
  textH: number,
  text: string,
  fitToBox?: boolean,
): Code128Result {
  const heightPx = height + textH;
  const rects = bars
    .map((b) => `<rect x="${b.x}" y="0" width="${b.w}" height="${height}" fill="#000"/>`)
    .join("");
  const textEl = text
    ? `<text x="${widthPx / 2}" y="${height + textH - 3}" font-family="monospace" font-size="13" text-anchor="middle" fill="#000">${text
        .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))}</text>`
    : "";
  const sizeAttrs = fitToBox
    ? `width="100%" height="100%" preserveAspectRatio="none"`
    : `width="${widthPx}" height="${heightPx}"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ${sizeAttrs} viewBox="0 0 ${widthPx} ${heightPx}"><rect width="${widthPx}" height="${heightPx}" fill="#fff"/>${rects}${textEl}</svg>`;
  return { svg, widthPx, heightPx };
}

/** قيمة الـchecksum لنصّ — تُكشف للاختبار. */
export function code128Checksum(data: string): number {
  return computeCode128Checksum(encodeCode128Values(data));
}

/** يولّد SVG لباركود EAN-13/EAN-8 من سلسلة أرقام صالحة (تحقّق مسبقاً بـisValidEan). */
export function eanSvg(data: string, opts: Code128Options = {}): Code128Result {
  if (!isValidEan(data)) throw new Error("ليست EAN صالحة");
  const moduleWidth = opts.moduleWidth ?? 2;
  const height = opts.height ?? 60;
  const showText = opts.showText ?? true;
  const textH = showText ? 16 : 0;
  // مناطق الهدوء وفق المواصفة: EAN-13 = ١١ وحدة يساراً و٧ يميناً؛ EAN-8 = ٧ من الجهتين.
  const quietL = (data.length === 13 ? 11 : 7) * moduleWidth;
  const quietR = 7 * moduleWidth;

  const modules = eanModules(data);
  const bars: { x: number; w: number }[] = [];
  let x = quietL;
  let i = 0;
  while (i < modules.length) {
    let run = 1;
    while (i + run < modules.length && modules[i + run] === modules[i]) run++;
    if (modules[i] === "1") bars.push({ x, w: run * moduleWidth });
    x += run * moduleWidth;
    i += run;
  }
  return finishSvg(bars, x + quietR, height, textH, showText ? data : "", opts.fitToBox);
}

/**
 * باركود ملصق الرفّ الأمثل: EAN-13/EAN-8 أصليّ للبيانات الرقمية الصالحة (أكثف ⇒ قضبان أثخن
 * على نفس العرض)، وإلا Code128 (الرموز الداخلية «ALR…» وكل ما ليس EAN). الماسح يعيد نفس
 * السلسلة في الحالتين ⇒ بحث الكاشير لا يتأثّر.
 */
export function productBarcodeSvg(data: string, opts: Code128Options = {}): Code128Result {
  return isValidEan(data) ? eanSvg(data, opts) : code128Svg(data, opts);
}

/**
 * يولّد باركوداً داخلياً فريداً نسبياً لوحدة بلا باركود مصنّعي.
 * النمط: ALR + معرّف الوحدة مبطّناً (رقمي قابل للمسح بـCode128-C بعد البادئة).
 * نستخدم بادئة حرفية قصيرة ثم أرقاماً — Code128 يرمّزهما معاً.
 */
export function internalBarcode(productUnitId: number): string {
  return `ALR${String(productUnitId).padStart(7, "0")}`;
}
