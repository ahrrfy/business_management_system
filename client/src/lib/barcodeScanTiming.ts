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
 *   ٣. **التسريب:** حرفٌ واحدٌ فقط قد يظهر لحظياً في الحقل (المرشّح الأوّل قبل تأكيد الومضة)،
 *      ويُستعاد فوراً عند بدء الومضة عبر `startBurst` — فلا يبقى رمزٌ مرئيّ ولا يضيع حرفٌ من الباركود.
 *
 * القرار التصميميّ: نحتفظ بالضغطات كاملةً (`ScannerKeyEvent[]`) ونقرّر عند الإفراغ — فإن كانت
 * ومضةً حقيقية نفكّها فيزيائياً (لاتينيّ نظيف)، وإن كانت كتابةً بشريّة قصيرة نعيد **الحروف الخام**
 * كما كتبها المستخدم (نصون بحثه العربيّ بلا تحويلٍ خطأً إلى لاتينيّ).
 */
import { scannerCharFromEvent, type ScannerKeyEvent } from "@shared/barcodeKeyDecode";
import { normalizeBarcodeScannerInput, looksLikeSystemBarcode } from "@shared/barcodeScanner";

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
  /** حرفٌ مرشّحٌ أوّل (قد يكون بشرياً أو بداية مسح): يظهر في الحقل، لا يُحجب. */
  | "pass"
  /** بدأت ومضةٌ مؤكَّدة: احجب هذا الحرف، واستعِد الحرف المرشّح الأوّل الذي تسرّب للحقل. */
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

    // الحرف الثاني وصل بسرعة القارئ بعد المرشّح الأوّل ⇒ ومضةٌ مؤكَّدة.
    if (this.keys.length === 1 && gap <= this.intraGapMs) {
      this.active = true;
      this.keys.push(input);
      return "startBurst";
    }

    // فاصلٌ بشريّ (أو أوّل ضغطةٍ على الإطلاق) ⇒ ابدأ مرشّحاً جديداً يظهر في الحقل.
    this.keys = [input];
    return "pass";
  }

  /** يفرّغ الحالة ويعيد القرار النهائيّ (ومضةٌ مقبولة أم كتابةٌ تُستعاد). */
  flush(): FlushResult {
    const keys = this.keys;
    const accepted = this.active && keys.length >= this.minLength;
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

/** محارف الباركود المسموحة عند الاسترداد (بلا مسافاتٍ داخلية). */
const BARCODE_CHARS = /^[A-Za-z0-9\-.$/+%]+$/;

/**
 * استرداد رمزٍ من نصٍّ **تسرّب** من قارئٍ بطيء لم يُكتشَف كومضة (فبدا كتابةً بشرية)، عند ضغط Enter.
 *
 * السبب: بعض القارئات تُضبَط بتأخيرٍ عالٍ بين المحارف فتطبع الرمز حرفاً حرفاً ببطءٍ يوازي الكتابة
 * البشرية — فيستحيل تمييزها بالتوقيت وحده. لكنّها تُنهي بـEnter غالباً؛ فعنده نفكّ محتوى الحقل
 * (خريطة تخطيط عربي 101 + طيّ الأرقام) ونستعلمه كباركود **بشرط أن يبدو باركوداً واثقاً** كي لا
 * نخطف بحثاً بشرياً عربياً (الذي يُفكّ إلى أحرفٍ لاتينية بلا أرقام).
 *
 * القبول: بعد التطبيع وإزالة المسافات، طولٌ ≥ max(4, minLength)، محارف باركودٍ فقط، و**يحوي رقماً**
 * (باركودات المنتجات تحوي أرقاماً؛ كلمات البحث العربية تُفكّ حروفاً بلا أرقام) أو بادئة ALR/مستند.
 * الحلّ الجذريّ يبقى ضبط القارئ (تأخير بين-المحارف = 0 + لاحقة Enter)، وهذا شبكةُ أمان.
 */
export function recoverSlowScanCode(rawFieldValue: string, minLength: number): string | null {
  const code = normalizeBarcodeScannerInput(rawFieldValue).replace(/\s+/g, "");
  if (code.length < Math.max(4, minLength)) return null;
  if (!BARCODE_CHARS.test(code)) return null;
  const barcodeLike = /\d/.test(code) || /^ALR/i.test(code) || looksLikeSystemBarcode(code);
  return barcodeLike ? code : null;
}
