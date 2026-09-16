/**
 * تطبيع مدخل الباركود — نقطة حقيقة واحدة تُستعمَل عند الحفظ وعند المطابقة معاً.
 *
 * الجذر (٤/٩): حقول الباركود كانت تُحفَظ بلا أيّ تطبيع (مخطّطات zod بلا `.trim()` والإدراج يكتب
 * المُدخل خاماً)، بينما مسارات المسح/البحث تُقارن بمساواةٍ SQL خامّة على العمود المخزَّن. فمسافةٌ
 * طرفية واحدة عند الحفظ (لصقٌ من Excel، قارئٌ يُلحق مسافة، ضغطةُ مسافةٍ عرضية) تجعل الباركود
 * غير قابل للمطابقة أبداً بعدها — بلا خطأ ولا تحذير، فقط «الرمز الممسوح لا يطابق» على منتجٍ موجود.
 *
 * القاعدة: حدّ الإدخال (`server/lib/schemas.ts`) وخدمات الحفظ ومسارات المطابقة تُطبّع بهذه الدالّة
 * نفسها — ولا يُعاد اختراع «trim» في مكانٍ ثالث.
 */

const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

// علامات اتجاه/تنسيق قد تُنسخ من صفحات RTL أو تُحقنها لوحة مفاتيح الهاتف. ليست جزءاً من
// أيّ باركود منتج، وبقاؤها يجعل رمزاً مرئياً واحداً هويتين مختلفتين.
const INVISIBLE_FORMAT_MARKS = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// قارئات HID وبعض ملفات CSV تلحق محارف framing. نزيلها عند الحافتين فقط؛ وجودها داخل
// الرمز خطأٌ يجب أن يرفضه حدّ الـAPI، لا أن يحوّله صامتاً إلى رمز آخر.
const EDGE_SCANNER_FRAMING = /^[\s\u0000-\u001f\u007f-\u009f]+|[\s\u0000-\u001f\u007f-\u009f]+$/g;
const INTERNAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const NON_ASCII_WHITESPACE = /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const UNSUPPORTED_FORMAT = /[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/;

/**
 * يُطبِّع باركوداً واحداً:
 * - يُزيل مسافات ASCII (0x20) **الطرفية والداخلية** معاً. الجذر (١٣/٩، بلاغ المالك المتكرّر):
 *   ١٢٥ صنفاً في الإنتاج خُزِّنت باركوداتها بمسافةٍ داخلية زائدة على الصورة «1  XXXX» (بايتاها
 *   `20 20`، من لصق Excel/إدخالٍ يدويّ). المتصفّح يطوي المسافتين إلى واحدةٍ عند العرض فيراها
 *   الموظّف «1 XXXX»، ولا قارئٌ ولا كاتبٌ يُعيد إنتاج مسافةٍ داخلية بموثوقية ⇒ الصنف غير قابلٍ
 *   للمسح ولا للبحث ولا للبيع أبداً. لا ترميز باركودٍ رقميّ (EAN/UPC/Code128) يحمل مسافةً، وفحصُ
 *   الإنتاج أثبت صفرَ تصادمٍ عند إسقاطها؛ فالمسافة الداخلية ضجيجٌ لا هوية. (محرف تحكّم داخليّ
 *   كالتبويب يبقى ويرفضه `hasUnsupportedBarcodeCharacters` — إسقاطُ المسافة وحدها هو المقصود.)
 * - يطوي الأرقام العربية-الهندية والفارسية إلى لاتينية: لا ترميز باركودٍ معياريّ يعتمدها حرفاً،
 *   فظهورها دليلٌ قاطع على تسرّب تخطيط لوحة مفاتيح عربية أو لصقٍ من مصدرٍ غير مطبَّع.
 * - لا يمسّ حالة الأحرف: الحفظ يحتفظ بما طُبع على الملصق، والمطابقة توحّد الحالة في طرفها.
 * ⚠️ عند تعديل هذه الدالّة عدّل نظيرها SQL معاً: `drizzle/barcodeIdentitySql.ts:barcodeIdentitySql`
 *   والعمودُ المولَّد `barcodeNormalized` — يحرس تطابقَهما اختبار `barcodeAliases.test.ts`.
 */
export function canonicalizeBarcodeInput(raw: string): string {
  return normalizeBarcode(raw, { stripInternalSpace: true });
}

/**
 * تطبيعُ **التخزين** — يُحفَظ الباركود «كما هو من المصنع» (قرار المالك ١٥/٩، بالصور): لا إزالةَ مسافةٍ
 * داخلية، ولا إضافة، ولا إعادة ترتيب، ولا قلب/عكس. يختلف عن `canonicalizeBarcodeInput` في أمرٍ واحد:
 * **يُبقي مسافةَ ASCII الداخلية (0x20)** فتُحفَظ صيغة المصنع «1  0172» حرفيّاً وتُطبَع/تُعرَض كما هي.
 * ما يزال يُزيله (كلاهما غير مرئيّ ولا يُغيّر التسلسل المرئيّ للباركود):
 * - علاماتُ الاتجاه/التنسيق الخفيّة (bidi/zero-width) — **وجودها هو ما يُسبِّب القلب/العكس** الذي حذّر
 *   منه المالك، فإسقاطُها يصون التسلسل الأماميّ الصحيح لا يكسره.
 * - الفراغُ/التحكّم الطرفيّ (لصقُ Excel، لاحقةُ الماسح CR/LF/Tab) — طرفيٌّ فقط، غيرُ مرئيّ، وليس جزءاً
 *   من ملصق المصنع.
 * - طيُّ الأرقام العربية-الهندية/الفارسية إلى لاتينية: لا ترميزَ باركودٍ يعتمدها، فظهورُها تسرّبُ تخطيطِ
 *   لوحةٍ عربية لا رقمٌ مقصود — والطيُّ **يُطابق** المخزَّنَ بملصق المصنع اللاتينيّ لا يُخالفه (وعلى
 *   الباركود اللاتينيّ الصحيح هو لا-عمليّة، فلا «تغيير» على ما يكتبه المستخدم فعلاً).
 * المطابقةُ لا تعتمد هذا النصّ المخزَّن مباشرةً بل العمودَ المولَّد `barcodeNormalized` (يُسقط المسافة
 * ويطوي ويصغّر للهوية) — فيُحفَظ المرئيُّ حرفيّاً ويُطابَق المسحُ عبر الهوية المُطبَّعة معاً.
 */
export function canonicalizeBarcodeForStorage(raw: string): string {
  return normalizeBarcode(raw, { stripInternalSpace: false });
}

function normalizeBarcode(raw: string, opts: { stripInternalSpace: boolean }): string {
  const trimmed = (raw ?? "")
    .replace(INVISIBLE_FORMAT_MARKS, "")
    .replace(EDGE_SCANNER_FRAMING, "");
  let out = "";
  for (const ch of trimmed) {
    if (ch === " ") {
      if (opts.stripInternalSpace) continue; // الهوية تُسقط المسافة؛ التخزين يُبقيها (صيغة المصنع)
      out += ch;
      continue;
    }
    const ai = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (ai >= 0) {
      out += String(ai);
      continue;
    }
    const pi = PERSIAN_DIGITS.indexOf(ch);
    out += pi >= 0 ? String(pi) : ch;
  }
  return out;
}

/**
 * «نواة الأرقام» لباركود: هويتُه بعد **إسقاط بادئةٍ غير رقمية** (حرف/رمز) يضعها المصنّع على الملصق
 * دلالةً (مقاس «B5»، رمز موديل…) لكنّ الماسح **لا يُنتجها** أصلاً. الجذر (١٤/٩، بلاغ المالك المُثبَت
 * باختبار Notepad): وحداتٌ خُزِّن باركودها «B51822572015» بينما ملصقُها المطبوع يقرؤه الماسح
 * «51822572015» بلا B — فالمساواةُ على الهوية الكاملة تُخطئه رغم أنّه «هو نفسه» بعين المستخدم.
 *
 * تُستعمَل حصراً **كمسارٍ احتياطيٍّ محسوم بالتفرّد** بعد فشل التطابق التامّ والمُطبَّع: نطابق
 * نواةَ أرقام المُدخل بنواة أرقام العمود المخزَّن، ونرفض الحسم عند تعدّد المالك (§٥: لا نُسعّر
 * المسحَ لغير صاحبه — الغموض يسأل ولا يخمّن). ولذلك لا نُغيّر الهويةَ الأساسية ولا العمودَ المولَّد
 * (بلا انحدار على أيّ باركودٍ يُحلّ اليوم)، بل نضيف قدرةَ تسامحٍ عند غياب المطابقة وحدها.
 *
 * ⚠️ نظيرُها SQL في `server/services/catalog/barcodeAliases.ts` (`storedBarcodeDigitCoreSql`):
 *   `regexp_replace(<الهوية المُطبَّعة المُصغَّرة>, '^[^0-9]+', '')` — يحرس تطابقَهما `barcodeAliases.test.ts`.
 */
export function barcodeDigitCore(raw: string): string {
  return canonicalizeBarcodeInput(raw).replace(/^[^0-9]+/, "").toLowerCase();
}

/** أدنى طولٍ لنواة الأرقام كي تُعتبَر مسارَ استرداد (يوازي POS_SCAN_MIN_LENGTH) — يمنع نواةً قصيرة
 *  من مطابقة ضجيجٍ عرَضيّ. المطابقة محسومةٌ بالتفرّد فوق ذلك (الغموض يسأل، لا يخمّن — §٥). */
export const BARCODE_DIGIT_CORE_MIN_LENGTH = 4;

/** محارف لا يمكن حفظها/طباعتها بأمان داخل هوية باركود المنتج. */
export function hasUnsupportedBarcodeCharacters(raw: string): boolean {
  const normalized = canonicalizeBarcodeInput(raw);
  return INTERNAL_CONTROL.test(normalized)
    || NON_ASCII_WHITESPACE.test(normalized)
    || UNSUPPORTED_FORMAT.test(normalized);
}

function upcCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

function ean13CheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

function isValidUpcA(code: string): boolean {
  return /^\d{12}$/.test(code) && Number(code[11]) === upcCheckDigit(code.slice(0, 11));
}

function isZeroPrefixedEan13(code: string): boolean {
  return /^0\d{12}$/.test(code) && Number(code[12]) === ean13CheckDigit(code.slice(0, 12));
}

/**
 * صور الهوية المكافئة التي قد تعيدها محركات المسح لنفس GTIN.
 *
 * ZXing قد يعيد EAN-13 البادئ بصفر كـUPC-A من 12 خانة. نوسّع صفراً واحداً فقط وبعد
 * التحقق من خانة الفحص؛ الأكواد القصيرة وغير القياسية تبقى حرفية ولا تفقد أصفارها.
 */
export function barcodeIdentityCandidates(raw: string): string[] {
  const code = canonicalizeBarcodeInput(raw);
  if (!code) return [];
  if (isValidUpcA(code)) return [code, `0${code}`];
  if (isZeroPrefixedEan13(code)) return [code, code.slice(1)];
  return [code];
}

/** مفتاح المقارنة الحالي للنظام: التطبيع النصي + عدم حساسية حالة الأحرف. */
export function barcodeComparisonKey(raw: string): string {
  return canonicalizeBarcodeInput(raw).toLowerCase();
}

export function barcodesEquivalent(left: string, right: string): boolean {
  const rightKeys = new Set(barcodeIdentityCandidates(right).map(barcodeComparisonKey));
  return barcodeIdentityCandidates(left).some((candidate) => rightKeys.has(barcodeComparisonKey(candidate)));
}
