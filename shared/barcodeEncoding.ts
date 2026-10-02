/**
 * shared/barcodeEncoding.ts — محرك ترميز الباركود المتجهي الدقيق.
 * يدعم المعايير العالمية:
 * - EAN-13 (ISO/IEC 15420)
 * - EAN-8
 * - Code 128 (ISO/IEC 15417 Auto B/C)
 * 
 * يُحسب إحداثيات وعروض القضبان (bars) بدقة رياضية متّجهية ومناطق الهدوء (quiet zones)،
 * لإنتاج مخرجات متّجهية فائقة الدقة (Vector / 300+ DPI) صالحة لمطابع المصانع ومصممي التغليف.
 */

// ── أنماط وحدات EAN-13 / EAN-8 ──
const EAN_L: string[] = [
  "0001101", "0011001", "0010011", "0111101", "0100011",
  "0110001", "0101111", "0111011", "0110111", "0001011",
];

const EAN_PARITY: string[] = [
  "LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
  "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL",
];

const eanR = (d: number): string => EAN_L[d].replace(/[01]/g, (c) => (c === "0" ? "1" : "0"));
const eanG = (d: number): string => eanR(d).split("").reverse().join("");

/** رقم التحقّق EAN لسلسلة البيانات (موديولو 10 بأوزان متناوبة 3 و 1). */
export function eanCheckDigit(dataDigits: string): number {
  let sum = 0;
  for (let i = 0; i < dataDigits.length; i++) {
    const d = dataDigits.charCodeAt(dataDigits.length - 1 - i) - 48;
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** هل السلسلة EAN-13/EAN-8 صالحة؟ */
export function isValidEan(data: string): boolean {
  if (!/^\d{8}$|^\d{13}$/.test(data)) return false;
  return eanCheckDigit(data.slice(0, -1)) === data.charCodeAt(data.length - 1) - 48;
}

/** سلسلة وحدات EAN كاملة («0/1»). */
export function eanModules(data: string): string {
  const d = data.split("").map((c) => c.charCodeAt(0) - 48);
  if (data.length === 13) {
    const parity = EAN_PARITY[d[0]];
    const left = d.slice(1, 7).map((v, i) => (parity[i] === "L" ? EAN_L[v] : eanG(v))).join("");
    const right = d.slice(7, 13).map((v) => eanR(v)).join("");
    return `101${left}01010${right}101`;
  }
  const left = d.slice(0, 4).map((v) => EAN_L[v]).join("");
  const right = d.slice(4, 8).map((v) => eanR(v)).join("");
  return `101${left}01010${right}101`;
}

// ── أنماط Code 128 ──
export const CODE128_PATTERNS: string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const START_B = 104;
const START_C = 105;
const STOP = 106;
const CODE_B = 100;
const CODE_C = 99;

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function digitRunLength(s: string, i: number): number {
  let n = 0;
  while (i + n < s.length && isDigit(s[i + n])) n++;
  return n;
}

export function encodeCode128Values(data: string): number[] {
  const out: number[] = [];
  let mode: "B" | "C" | null = null;
  let i = 0;
  const n = data.length;

  const startRun = digitRunLength(data, 0);
  if (startRun >= 2 && (startRun === n || startRun >= 4 || n === startRun)) {
    out.push(START_C);
    mode = "C";
  } else {
    out.push(START_B);
    mode = "B";
  }

  while (i < n) {
    if (mode === "C") {
      const run = digitRunLength(data, i);
      if (run >= 2) {
        out.push(parseInt(data.substring(i, i + 2), 10));
        i += 2;
        continue;
      }
      out.push(CODE_B);
      mode = "B";
      continue;
    } else {
      const run = digitRunLength(data, i);
      const toEnd = i + run === n;
      if (run >= 4 || (run >= 2 && toEnd && run % 2 === 0)) {
        out.push(CODE_C);
        mode = "C";
        continue;
      }
      const code = data.charCodeAt(i);
      if (code < 32 || code > 126) throw new Error(`حرف غير مدعوم في الباركود: ${data[i]}`);
      out.push(code - 32);
      i++;
    }
  }
  return out;
}

export function code128Checksum(values: number[]): number {
  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += values[k] * k;
  return sum % 103;
}

export interface BarcodeBar {
  x: number;
  width: number;
}

export interface BarcodeBarsResult {
  bars: BarcodeBar[];
  totalWidth: number;
  quietZoneLeft: number;
  quietZoneRight: number;
  moduleWidth: number;
  symbology: "EAN-13" | "EAN-8" | "CODE-128";
  hriFormatted: string;
  rawCode: string;
}

/**
 * يحسب مواقع وعروض كل قضيب أسود في الباركود مع مناطق الهدوء.
 * القياسات بوحدة الموديول (تُضرب في moduleWidth).
 */
export function calculateBarcodeBars(
  rawCode: string,
  opts: { moduleWidth?: number; quietZone?: number } = {}
): BarcodeBarsResult {
  const code = (rawCode || "").trim();
  if (!code) throw new Error("رمز الباركود فارغ");

  const moduleWidth = opts.moduleWidth ?? 1;

  if (isValidEan(code)) {
    const isEan13 = code.length === 13;
    const quietL = (opts.quietZone ?? (isEan13 ? 11 : 7)) * moduleWidth;
    const quietR = (opts.quietZone ?? 7) * moduleWidth;
    const modules = eanModules(code);

    const bars: BarcodeBar[] = [];
    let currentX = quietL;
    let i = 0;
    while (i < modules.length) {
      let run = 1;
      while (i + run < modules.length && modules[i + run] === modules[i]) run++;
      if (modules[i] === "1") {
        bars.push({ x: currentX, width: run * moduleWidth });
      }
      currentX += run * moduleWidth;
      i += run;
    }

    const totalWidth = currentX + quietR;
    const hri = isEan13
      ? `${code[0]}  ${code.slice(1, 7)}  ${code.slice(7, 13)}`
      : `${code.slice(0, 4)}  ${code.slice(4, 8)}`;

    return {
      bars,
      totalWidth,
      quietZoneLeft: quietL,
      quietZoneRight: quietR,
      moduleWidth,
      symbology: isEan13 ? "EAN-13" : "EAN-8",
      hriFormatted: hri,
      rawCode: code,
    };
  }

  // افتراضي: Code 128
  const quiet = (opts.quietZone ?? 10) * moduleWidth;
  const values = encodeCode128Values(code);
  const cs = code128Checksum(values);
  const full = [...values, cs, STOP];

  const bars: BarcodeBar[] = [];
  let currentX = quiet;
  for (const v of full) {
    const pat = CODE128_PATTERNS[v];
    let black = true;
    for (const chWidth of pat) {
      const w = parseInt(chWidth, 10);
      if (black) {
        bars.push({ x: currentX, width: w * moduleWidth });
      }
      currentX += w * moduleWidth;
      black = !black;
    }
  }

  const totalWidth = currentX + quiet;

  return {
    bars,
    totalWidth,
    quietZoneLeft: quiet,
    quietZoneRight: quiet,
    moduleWidth,
    symbology: "CODE-128",
    hriFormatted: code,
    rawCode: code,
  };
}

/**
 * تنظيف وتوليد اسم ملف PDF المقترح تلقائياً من اسم المنتج ووحدته والباركود.
 * متوافق مع كافة أنظمة التشغيل (Windows / Linux / macOS).
 */
export function buildBarcodePdfFilename(opts: {
  productName?: string | null;
  unitName?: string | null;
  barcode: string;
}): string {
  const name = (opts.productName || "").trim();
  const unit = (opts.unitName || "").trim();
  const code = (opts.barcode || "").trim();

  let base = name;
  if (!base) {
    base = code ? `باركود-${code}` : "باركود-منتج";
  } else {
    if (unit && unit !== "قطعة") {
      base += ` - ${unit}`;
    }
    if (code) {
      base += ` - ${code}`;
    }
  }

  // تنظيف المحارف غير المسموح بها في أنظمة الملفات
  const safe = base.replace(/[\/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
  return `${safe || "باركود"}.pdf`;
}

/**
 * توليد اسم ملف PDF المقترح لدفعة ملصقات (Batch).
 */
export function buildBatchBarcodePdfFilename(opts: {
  totalCount: number;
  itemCount?: number;
  dateStr?: string;
}): string {
  const count = opts.totalCount;
  const items = opts.itemCount;
  const date = opts.dateStr || new Date().toISOString().slice(0, 10);
  let base = `ملصقات باركود - ${count} ملصق`;
  if (items && items > 1) {
    base += ` (${items} صنف)`;
  }
  base += ` - ${date}`;
  const safe = base.replace(/[\/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
  return `${safe}.pdf`;
}


