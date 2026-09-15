/**
 * كاشف ومضة قارئ الباركود — آلة حالةٍ نقيّة (بلا DOM/React) تميّز مسح القارئ السريع عن الكتابة
 * البشرية، وتبني مخزن الباركود من **المفاتيح الفيزيائية** (`event.code`) لا الحروف المشوّهة بالتخطيط.
 *
 * لماذا نقيّة ومستقلّة: منطق التوقيت كان مكرّراً في ثلاثة خطّافات (`useBarcodeScanner` العالميّ،
 * `useBarcodeInput`، `useSmartScanInput`) بعتباتٍ متضاربة وبلا **أيّ اختبار توقيت** — فمرّ انحدار
 * #1070 (خفض العتبة 80→60مي + اعتراض عدوانيّ) دون كشف. توحيدُه هنا يجعل السلوك مصدراً واحداً
 * قابلاً للاختبار بالمؤقّتات الوهمية، ويصلح العلل الثلاث معاً:
 *
 *   ١. **الرموز العربية:** كلّ محرفٍ يُفكّ عبر `scannerCharFromEvent` (المفتاح الفيزيائيّ) عند
 *      اعتماد الومضة، لا عبر الحرف الناتج المشوّه بالتخطيط.
 *   ٢. **«يعمل أحياناً»:** كشف الومضة **متسامحٌ مع تذبذب توقيت USB**. الجذر: الكود السابق كان
 *      يكسر الومضة (أو يفشل ببدئها) عند أوّل فاصلٍ يتجاوز عتبةً ضيّقة (60مي)، بينما فواصل القارئ
 *      الحقيقية تتذبذب (استقصاء USB + جدولة النظام) فتتجاوزها لحظياً ⇒ يتسرّب الحرف الأوّل دائماً
 *      ويضيع من الباركود. هنا الفاصل السخيّ (افتراض 120مي) يغطّي التذبذب، وبمجرّد بدء الومضة
 *      تُلتقط كلّ الأحرف حتى سكونٍ واضح أو Enter.
 *   ٣. **التسريب:** قد يظهر المرشّح الأوّل لحظياً في الحقل قبل تأكيد الومضة؛ يُزال عند
 *      `startBurst` مع إبقاء النصّ السابق للحقل كما هو.
 *
 * القرار التصميميّ: نحتفظ بالضغطات كاملةً (`ScannerKeyEvent[]`) ونقرّر عند الإفراغ — فإن كانت
 * ومضةً حقيقية نفكّها فيزيائياً (لاتينيّ نظيف)، وإن كانت كتابةً بشريّة قصيرة نعيد **الحروف الخام**
 * كما كتبها المستخدم (نصون بحثه العربيّ بلا تحويلٍ خطأً إلى لاتينيّ).
 */
import { scannerCharFromEvent, type ScannerKeyEvent } from "@shared/barcodeKeyDecode";
import { normalizeBarcodeScannerInput, looksLikeSystemBarcode } from "@shared/barcodeScanner";
import { barcodeDigitCore, hasUnsupportedBarcodeCharacters } from "@shared/barcodeNormalize";

export interface ScanBurstOptions {
  /** أدنى طولٍ لاعتبار الومضة باركوداً (افتراضي 3؛ حقول القارئ المخصَّصة قد تخفضه إلى 2). */
  minLength?: number;
  /**
   * أقصى فاصلٍ بين ضغطتين لاعتبارهما ضمن ومضةٍ واحدة (مي). سخيٌّ عمداً (افتراضي 120) ليتحمّل
   * تذبذب توقيت قارئ HID — الإنسان نادراً ما يُبقي أقلّ منه بين حرفَين متتاليَين عبر باركودٍ كامل،
   * والقارئ دائماً أسرع بكثير. القيمة قابلة للضبط لكلّ سطح.
   */
  intraGapMs?: number;
}

export type FeedAction =
  /** حرفٌ مرشّح (قد يكون بشرياً أو بداية مسح): يظهر في الحقل، لا يُحجب. */
  | "pass"
  /** بدأت ومضةٌ مؤكَّدة: احجب هذا الحرف، وأزل المرشّح السابق الذي تسرّب للحقل. */
  | "startBurst"
  /** ضمن ومضةٍ جارية: احجب الحرف. */
  | "capture";

export interface FlushResult {
  /** هل التسلسل ومضةُ قارئٍ مقبولة (نشطة + بلغت الحدّ الأدنى)؟ */
  accepted: boolean;
  /** الباركود المفكوك فيزيائياً والمطبَّع — يُستعمَل عند `accepted`. */
  code: string;
  /** الحروف الخام كما بُثّت — تُستعاد للحقل عند رفض الومضة (صون الكتابة البشرية). */
  text: string;
}

export class ScanBurstDetector {
  private keys: ScannerKeyEvent[] = [];
  private lastMs = 0;
  private active = false;
  // وجود مرشّحٍ سابق ضمن نافذة الاستعادة البرمجية المقترحة يجعل الومضة التالية ملتبسة: قد يكون
  // أولَ حرفٍ بطيئاً من القارئ أو مفتاحاً يدوياً سبق المسح. لا يوجد دليل توقيتي يفرّق بينهما،
  // لذلك نرفضها بدلاً من إصدار باركودٍ ملوّث أو مبتور.
  private ambiguousStart = false;

  readonly minLength: number;
  readonly intraGapMs: number;

  constructor(opts: ScanBurstOptions = {}) {
    this.minLength = Math.max(1, opts.minLength ?? 3);
    this.intraGapMs = Math.max(1, opts.intraGapMs ?? 120);
  }

  /** هل نحن داخل ومضةِ مسحٍ مؤكَّدة الآن؟ */
  get isActive(): boolean {
    return this.active;
  }

  /** عدد الأحرف المُجمَّعة (الومضة الجارية أو المرشّح). */
  get length(): number {
    return this.keys.length;
  }

  /**
   * يغذّي ضغطة مفتاحٍ قابلٍ للطباعة (على المستدعي تصفية Enter/Escape/مفاتيح التحكّم مسبقاً).
   * يعيد القرار الذي يترجمه الخطّاف إلى فعلٍ على DOM (حجب/استعادة).
   */
  feed(input: ScannerKeyEvent, now: number): FeedAction {
    const gap = this.lastMs > 0 ? now - this.lastMs : Number.POSITIVE_INFINITY;
    this.lastMs = now;

    // داخل ومضةٍ مؤكَّدة: التقط كلّ حرفٍ بلا فحص فاصلٍ إضافيّ (مناعةٌ تامّة للتذبذب حتى الإفراغ).
    if (this.active) {
      this.keys.push(input);
      return "capture";
    }

    // مسافةٌ بسرعةٍ بشرية (فاصلٌ أبطأ من عتبة القارئ) خارجَ ومضةٍ نشطة = فاصلُ كلماتٍ يكتبه الإنسان
    // (اسمُ منتج «عمار السلامي») لا جزءٌ من باركود. نكسر أيّ مرشّحٍ ناشئ ونمرّرها كما تُكتب فلا يُختطَف
    // بحثُ المستخدم ولا يُقفَز حقلُه (بلاغ المالك ١٥/٩). أمّا المسافةُ بسرعة القارئ (≤ العتبة) فتسقط
    // لمنطق الومضة أدناه فتبقى ملتقطةً — باركودُ المصنع «1  0172»/«A 1234» يُمسَح كاملاً بلا بترِ
    // البادئة (مراجعة Codex ١٥/٩: الومضةُ تتأكّد بالحرف الثاني، فإسقاطُ الفراغ الأوّل يبتر المرشّح).
    if (input.key === " " && gap > this.intraGapMs) {
      this.ambiguousStart = false;
      this.keys = [];
      return "pass";
    }

    // الحرف الثاني وصل بسرعة القارئ بعد المرشّح الأوّل ⇒ ومضةٌ مؤكَّدة.
    if (this.keys.length === 1 && gap <= this.intraGapMs) {
      this.active = true;
      this.keys.push(input);
      return "startBurst";
    }

    // فاصلٌ بشريّ (أو أوّل ضغطةٍ على الإطلاق) ⇒ ابدأ مرشّحاً جديداً يظهر في الحقل. إن كان لدينا
    // مرشّح سابق فالبداية التالية ملتبسة، فلا نقبل لاحقتها كباركود. لا نضمّ
    // المفتاح السابق لاحقاً: التوقيت وحده لا يميّز أولَ حرفٍ من قارئ بطيء البدء عن كتابةٍ يدوية
    // سبقت مسحاً سريعاً، واستعادته قد تغيّر هوية الباركود إلى صنفٍ آخر.
    this.ambiguousStart = this.keys.length > 0 && gap <= this.ambiguousStartMs;
    this.keys = [input];
    return "pass";
  }

  /** نافذة البداية الملتبسة: تغطي اقتراح 1.5ث في #1114 لكن نتيجتها الرفض الآمن لا الاستعادة. */
  private get ambiguousStartMs(): number {
    return Math.max(this.intraGapMs * 2, 1_500);
  }

  /** يفرّغ الحالة ويعيد القرار النهائيّ (ومضةٌ مقبولة أم كتابةٌ تُستعاد). */
  flush(): FlushResult {
    const keys = this.keys;
    const accepted = this.active && !this.ambiguousStart && keys.length >= this.minLength;
    const text = keys.map((k) => k.key).join("");
    const code = normalizeBarcodeScannerInput(keys.map((k) => scannerCharFromEvent(k)).join(""));
    this.reset();
    return { accepted, code, text };
  }

  /** يُلغي الحالة الجارية بلا إصدار (تركيزٌ جديد/Escape/مغادرة). */
  reset(): void {
    this.keys = [];
    this.lastMs = 0;
    this.active = false;
    this.ambiguousStart = false;
  }
}

/** قرار تسوية ومضةٍ على حقلٍ نصّيّ: باركودٌ يُصدَر (إن قُبِل)، وقيمةُ الحقل النهائية. */
export interface SettleDecision {
  /** الباركود المُصدَر عند القبول، وإلّا `null`. */
  scan: string | null;
  /** ما يجب أن يحمله الحقل بعد التسوية. */
  fieldValue: string;
}

/**
 * يقرّر تسوية الومضة على حقلٍ نصّيّ بحسب نتيجة الإفراغ والبادئة (قيمة الحقل قبل الومضة):
 * - **مقبولة** (ومضةٌ نشطة بلغت الحدّ الأدنى وطولُ الرمز كافٍ): امسح الحقل ثم استعلم بالباركود.
 * - **مرفوضة** (كتابةٌ بشرية قصيرة صُنّفت خطأً كمسح): أعِد **البادئة + الحروف الخام** — فلا يضيع
 *   البحث القائم في الحقل ولا ما كتبه المستخدم (يعالج ملاحظتَي مراجعة #1107).
 *
 * نقيّة كي تُختبَر بلا DOM/React — الخطّافات تترجم القرار إلى `setValue`/`onScan`.
 */
export function resolveScanSettle(result: FlushResult, prefix: string, minLength: number): SettleDecision {
  if (result.accepted && result.code.length >= minLength) {
    return { scan: result.code, fieldValue: "" };
  }
  return { scan: null, fieldValue: prefix + result.text };
}

/**
 * استرداد رمزٍ من نصٍّ **تسرّب** من قارئٍ بطيء لم يُكتشَف كومضة (فبدا كتابةً بشرية)، عند ضغط Enter.
 *
 * السبب: بعض القارئات تُضبَط بتأخيرٍ عالٍ بين المحارف فتطبع الرمز حرفاً حرفاً ببطءٍ يوازي الكتابة
 * البشرية — فيستحيل تمييزها بالتوقيت وحده. لكنّها تُنهي بـEnter غالباً؛ فعنده نطبّع محتوى الحقل
 * ونستعلمه كباركود **بشرط أن يبدو باركوداً واثقاً** كي لا نخطف بحثاً بشرياً.
 *
 * **يستعمل نفس عقد الحفظ/البحث** (مراجعة #1108): التطبيع عبر `normalizeBarcodeScannerInput` (يترجم
 * تخطيط عربي 101 + يطوي الأرقام + يقلّم + يجرّد بادئة AIM، ويُبقي المسافة الداخلية — عقد Code39)،
 * وفحص المحارف عبر `hasUnsupportedBarcodeCharacters` القياسيّ (يقبل ترقيم Code128 مثل `_ = ?`، لا
 * قائمةٌ بيضاء ضيّقة). ولا نُجرّد المسافة الداخلية من القيمة المُعادة — تكافلُ المطابقة اللا-حسّاسة
 * للمسافة على `barcodeIdentityCandidates`.
 *
 * بوّابة الباركود الواثق: طولٌ ≥ max(4, minLength)، ومحارفُ مدعومة، و**رقميٌّ محضٌ** (بعد طيّ الفراغات)
 * أو بادئة داخلية ALR/بادئة مستندٍ معروفة — كي لا نخطف بحثاً بشرياً فيه رقمٌ عابر («قلم A4» يُفكّ
 * حروفاً + رقماً ⇒ يُترَك للبحث). الحلّ الجذريّ لبطء القارئ يبقى ضبطه (تأخير = 0 + لاحقة Enter).
 */
export function recoverSlowScanCode(rawFieldValue: string, minLength: number): string | null {
  const code = normalizeBarcodeScannerInput(rawFieldValue);
  return isConfidentScanCode(code, minLength) ? code : null;
}

/**
 * هل يبدو الرمزُ المُطبَّع (بعد `normalizeBarcodeScannerInput`/فكّ الومضة) **باركوداً واثقاً**؟
 *
 * بوّابةُ الثقة — تفصلُ مسحَ القارئ عن الكتابة البشرية السريعة التي صُنّفت خطأً كومضة: تحت تخطيطٍ
 * عربيّ، الكتابةُ السريعة لاسمٍ عربيّ («عمار السلامي») تُفكّ عبر `event.code` إلى ASCII عشوائيّ يمرّ
 * فحصَ الطول وحده ⇒ يُصدَر «مسحاً» فيُحوَّل البحثُ إلى إنجليزيّةٍ وتُبتَر المسافة (بلاغ المالك ١٥/٩).
 * فنشترط أن يكون الرمز: رقميّاً محضاً (بعد طيّ الفراغ)، أو بادئةَ مستندٍ ALR، أو باركودَ نظامٍ معروفاً،
 * أو بادئةَ حرفٍ قصيرة **لاصقة** لنواةٍ رقمية (مقاس مصنعٍ «B5»…). الأسماءُ العربية المفكوكة (حروفٌ بلا
 * أرقام) تسقط ⇒ تبقى بحثاً نصّياً. نفسُ البوّابة يستعملها `recoverSlowScanCode` (قارئٌ بطيء عند Enter)
 * والوضعُ التمريريّ في `useBarcodeInput` (حقولُ بحثِ الاسم) — مصدرٌ واحد لتعريف «الباركود الواثق».
 * ⚠️ نقيس الالتصاق على `code` بمسافاته لا على `digitsOnly` — وإلّا عُدَّ «حرفان + فراغ + رقم» («في 2026»
 * ⇐ «td 2026») باركوداً خطأً (§٥؛ مراجعة Codex ١٤/٩).
 */
export function isConfidentScanCode(code: string, minLength: number): boolean {
  if (code.length < Math.max(4, minLength)) return false;
  if (hasUnsupportedBarcodeCharacters(code)) return false;
  const digitsOnly = code.replace(/\s+/g, "");
  const shortLetterPrefixedDigits =
    /^[^\d\s]{1,2}\d+$/.test(code) && barcodeDigitCore(code).length >= Math.max(4, minLength);
  return (
    /^\d+$/.test(digitsOnly) || /^ALR/i.test(code) || looksLikeSystemBarcode(code) || shortLetterPrefixedDigits
  );
}
