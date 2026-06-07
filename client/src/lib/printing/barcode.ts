/**
 * مولّد Code128 مكتفٍ ذاتياً (بلا تبعيات) — يدعم النمطين B (ASCII) وC (أزواج أرقام)،
 * مع اختيار تلقائي للأمثل، ورقم تحقّق (checksum)، ونمطَي البداية/الإيقاف.
 * يُخرج SVG قابلاً للمسح. Code128 يرمّز أي ASCII، فيغطّي أرقام EAN والرموز الداخلية معاً.
 *
 * مرجع الجدول: 107 رمزاً (0..106). كل رمز = 6 عناصر (3 أعمدة سود + 3 بيض) بعرض إجمالي 11 وحدة،
 * عدا رمز الإيقاف (13 وحدة: 7 أعمدة). القيم أدناه هي عروض العناصر بالوحدات.
 */

// عروض العناصر لكل رمز (نمط القضبان: أسود، أبيض، أسود، ... بدءاً بالأسود).
const PATTERNS: string[] = [
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

/** عدد الأرقام المتتالية بدءاً من i. */
function digitRunLength(s: string, i: number): number {
  let n = 0;
  while (i + n < s.length && isDigit(s[i + n])) n++;
  return n;
}

/**
 * يبني قائمة قيم الرموز (بلا checksum/stop) باختيار B/C تلقائياً.
 * قاعدة مبسّطة قياسية: استخدم C عند توفّر زوج أرقام أو أكثر (خصوصاً في البداية/النهاية).
 */
function encodeValues(data: string): number[] {
  const out: number[] = [];
  let mode: "B" | "C" | null = null;
  let i = 0;
  const n = data.length;

  // تحديد البداية.
  const startRun = digitRunLength(data, 0);
  if (startRun >= 2 && (startRun === n || startRun >= 4 || (n === startRun))) {
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
        out.push(parseInt(data.substr(i, 2), 10));
        i += 2;
        continue;
      }
      // رقم فردي متبقٍّ أو حرف — انتقل إلى B.
      out.push(CODE_B);
      mode = "B";
      continue;
    } else {
      // mode B: إن جاء صفّ أرقام طويل (>=4 أو حتى النهاية) فحوّل إلى C.
      const run = digitRunLength(data, i);
      const toEnd = i + run === n;
      if (run >= 4 || (run >= 2 && toEnd && run % 2 === 0)) {
        out.push(CODE_C);
        mode = "C";
        continue;
      }
      const code = data.charCodeAt(i);
      // Code128B يغطّي ASCII 32..126 ⇒ القيمة = code - 32.
      if (code < 32 || code > 126) throw new Error(`حرف غير مدعوم في الباركود: ${data[i]}`);
      out.push(code - 32);
      i++;
    }
  }
  return out;
}

/** يحسب checksum مرجَّحاً (القيمة الابتدائية = رمز البداية، الأوزان 1,2,3,…). */
function checksum(values: number[]): number {
  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += values[k] * k;
  return sum % 103;
}

export interface Code128Options {
  /** عرض الوحدة (module) بالبكسل. */
  moduleWidth?: number;
  /** ارتفاع القضبان بالبكسل. */
  height?: number;
  /** هامش جانبي (quiet zone) بالوحدات. */
  quietZone?: number;
  /** عرض النص أسفل الباركود. */
  showText?: boolean;
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

  const values = encodeValues(data);
  const cs = checksum(values);
  const full = [...values, cs, STOP];

  // ابنِ سلسلة العناصر (عرض كل عنصر بالوحدات)؛ كل نمط يبدأ بقضيب أسود ويتناوب.
  let x = quiet;
  const bars: { x: number; w: number }[] = [];
  for (const v of full) {
    const pat = PATTERNS[v];
    let black = true;
    for (const chWidth of pat) {
      const w = parseInt(chWidth, 10);
      if (black) bars.push({ x, w: w * moduleWidth });
      x += w * moduleWidth;
      black = !black;
    }
  }
  const widthPx = x + quiet;
  const heightPx = height + textH;

  const rects = bars
    .map((b) => `<rect x="${b.x}" y="0" width="${b.w}" height="${height}" fill="#000"/>`)
    .join("");
  const text = showText
    ? `<text x="${widthPx / 2}" y="${height + textH - 3}" font-family="monospace" font-size="13" text-anchor="middle" fill="#000">${data
        .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))}</text>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}"><rect width="${widthPx}" height="${heightPx}" fill="#fff"/>${rects}${text}</svg>`;
  return { svg, widthPx, heightPx };
}

/** قيمة الـchecksum لنصّ — تُكشف للاختبار. */
export function code128Checksum(data: string): number {
  return checksum(encodeValues(data));
}

/**
 * يولّد باركوداً داخلياً فريداً نسبياً لوحدة بلا باركود مصنّعي.
 * النمط: ALR + معرّف الوحدة مبطّناً (رقمي قابل للمسح بـCode128-C بعد البادئة).
 * نستخدم بادئة حرفية قصيرة ثم أرقاماً — Code128 يرمّزهما معاً.
 */
export function internalBarcode(productUnitId: number): string {
  return `ALR${String(productUnitId).padStart(7, "0")}`;
}
