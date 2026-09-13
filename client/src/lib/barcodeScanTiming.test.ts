import { describe, it, expect } from "vitest";
import { ScanBurstDetector, resolveScanSettle, recoverSlowScanCode, type FeedAction, type FlushResult } from "./barcodeScanTiming";
import type { ScannerKeyEvent } from "@shared/barcodeKeyDecode";

/** يبني ضغطةً بموقعٍ فيزيائيّ مشتقٍّ من الرقم/الحرف (لتبسيط الاختبار على مدخلٍ لاتينيّ). */
function digit(d: string): ScannerKeyEvent {
  return { code: `Digit${d}`, key: d, shiftKey: false };
}

/** يغذّي سلسلةً من الأحرف بفواصل زمنيةٍ محدّدة، ويعيد قائمة الأفعال الناتجة. */
function feedSequence(
  det: ScanBurstDetector,
  events: ScannerKeyEvent[],
  gapsMs: number[],
  startMs = 1000,
): FeedAction[] {
  let now = startMs;
  const actions: FeedAction[] = [];
  events.forEach((e, i) => {
    if (i > 0) now += gapsMs[i - 1];
    actions.push(det.feed(e, now));
  });
  return actions;
}

describe("ScanBurstDetector — كشف الومضة", () => {
  it("يكشف ومضةً سريعة: أوّل حرفٍ pass، الثاني startBurst، الباقي capture", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    const actions = feedSequence(det, ["6", "2", "8", "1"].map(digit), [10, 10, 10]);
    expect(actions).toEqual(["pass", "startBurst", "capture", "capture"]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(true);
    expect(code).toBe("6281");
  });

  it("يستعيد الحرف الأوّل حين يكون أوّل فاصلٍ بطيئاً (بدءُ قارئٍ بطيء) — لا يُبتَر الباركود", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    // أوّل فاصلٍ 150مي (>العتبة) ثمّ سريع: يجب ألّا يسقط «6».
    const actions = feedSequence(det, ["6", "2", "8", "1"].map(digit), [150, 10, 10]);
    expect(actions).toEqual(["pass", "pass", "startBurst", "capture"]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(true);
    expect(code).toBe("6281"); // مع الحرف الأوّل المستعاد، لا "281"
  });

  it("لا يستعيد حرفاً مُسقطاً قديماً خارج نافذة الاستعادة (حرفٌ شاردٌ قبل المسح)", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    // «a» شاردٌ ثمّ فجوةٌ كبيرة (400مي) ثمّ مسحٌ سريع: يجب ألّا يُلحَق «a» بالباركود.
    const events: ScannerKeyEvent[] = [
      { code: "KeyA", key: "a" },
      { code: "Digit6", key: "6" },
      { code: "Digit2", key: "2" },
      { code: "Digit8", key: "8" },
    ];
    feedSequence(det, events, [400, 10, 10]);
    const { code } = det.flush();
    expect(code).toBe("628");
  });

  it("مناعةٌ تامّة لتذبذب التوقيت وسط الومضة (فاصلٌ كبيرٌ لا يكسرها بعد التأكيد)", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    // بعد بدء الومضة، فاصل 300مي (تذبذب/جدولة نظام) يجب ألّا يكسرها.
    const actions = feedSequence(det, ["1", "2", "3", "4", "5"].map(digit), [15, 300, 12, 9]);
    expect(actions).toEqual(["pass", "startBurst", "capture", "capture", "capture"]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(true);
    expect(code).toBe("12345");
  });

  it("يتسامح مع فاصلٍ بدائيّ بحجم العتبة تماماً", () => {
    const det = new ScanBurstDetector({ minLength: 2, intraGapMs: 120 });
    const actions = feedSequence(det, ["7", "7"].map(digit), [120]);
    expect(actions).toEqual(["pass", "startBurst"]);
    expect(det.isActive).toBe(true);
  });

  it("لا يبدأ ومضةً حين يتجاوز الفاصل الأوّل العتبة (كتابةٌ بشرية)", () => {
    const det = new ScanBurstDetector({ minLength: 2, intraGapMs: 120 });
    const actions = feedSequence(det, ["7", "7"].map(digit), [121]);
    expect(actions).toEqual(["pass", "pass"]);
    expect(det.isActive).toBe(false);
  });

  it("الكتابة البشرية البطيئة كلّها pass ولا تُقبَل ومضةً", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    const actions = feedSequence(det, ["1", "2", "3"].map(digit), [200, 250]);
    expect(actions).toEqual(["pass", "pass", "pass"]);
    const { accepted } = det.flush();
    expect(accepted).toBe(false);
  });

  it("ومضةٌ أقصر من الحدّ الأدنى تُرفَض وتُعيد الحروف الخام للاستعادة", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    // حرفان سريعان فقط (نشِطة لكن طولها 2 < 3).
    feedSequence(det, [{ code: "KeyA", key: "a" }, { code: "KeyB", key: "b" }], [10]);
    expect(det.isActive).toBe(true);
    const { accepted, text } = det.flush();
    expect(accepted).toBe(false);
    expect(text).toBe("ab");
  });
});

describe("ScanBurstDetector — الفكّ الفيزيائيّ تحت التخطيط العربي", () => {
  it("يفكّ باركوداً ممسوحاً بأرقامٍ عربية عبر code إلى لاتينيّ نظيف", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    const events: ScannerKeyEvent[] = [
      { code: "Digit6", key: "٦" },
      { code: "Digit2", key: "٢" },
      { code: "Digit8", key: "١" }, // حتّى لو اختلف key، code هو الحاكم
      { code: "Digit1", key: "١" },
    ];
    feedSequence(det, events, [8, 8, 8]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(true);
    expect(code).toBe("6281");
  });

  it("يفكّ بادئة مستندٍ مشوّهة (÷آ{ ⇒ INV) عبر المفاتيح الفيزيائية", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    // I,N,V بحروفٍ كبيرة (Shift) — تصل رموزاً تحت العربي، لكنّ code+shift يعيدها.
    const events: ScannerKeyEvent[] = [
      { code: "KeyI", key: "÷", shiftKey: true },
      { code: "KeyN", key: "آ", shiftKey: true },
      { code: "KeyV", key: "{", shiftKey: true },
      { code: "Minus", key: "-", shiftKey: false },
      { code: "Digit1", key: "١", shiftKey: false },
    ];
    feedSequence(det, events, [8, 8, 8, 8]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(true);
    expect(code).toBe("INV-1");
  });
});

describe("resolveScanSettle — صون البادئة والكتابة البشرية (ملاحظتا مراجعة #1107)", () => {
  const mk = (accepted: boolean, code: string, text: string): FlushResult => ({ accepted, code, text });

  it("ومضةٌ مقبولة: يمسح الحقل ويُصدر الباركود", () => {
    expect(resolveScanSettle(mk(true, "6281001234567", "6281001234567"), "قلم", 3)).toEqual({
      scan: "6281001234567",
      fieldValue: "",
    });
  });

  it("ومضةٌ قصيرة مرفوضة بلا بادئة: يعيد الحروف الخام (لا بحثٌ فارغ عند Enter)", () => {
    // كتابةٌ بشرية سريعة «de» (طولها 2 < 3) — يجب ألّا تضيع.
    expect(resolveScanSettle(mk(false, "de", "de"), "", 3)).toEqual({ scan: null, fieldValue: "de" });
  });

  it("ومضةٌ قصيرة مرفوضة فوق بحثٍ قائم: يصون البادئة + يُلحق الخام", () => {
    // الحقل فيه «abc»، ثمّ «de» سريعتان ثمّ سكون ⇒ لا تضيع «abc».
    expect(resolveScanSettle(mk(false, "de", "de"), "abc", 3)).toEqual({ scan: null, fieldValue: "abcde" });
  });

  it("رمزٌ مقبولٌ لكنّه أقصر من الحدّ الأدنى: يُعامَل كرفضٍ فيُستعاد", () => {
    // حاجزٌ ثانٍ: لو قصّ تجريدُ AIM الرمز دون الحدّ، لا نُطلق استعلاماً بمُدخلٍ ناقص.
    expect(resolveScanSettle(mk(true, "ab", "ab"), "x", 3)).toEqual({ scan: null, fieldValue: "xab" });
  });
});

describe("recoverSlowScanCode — استرداد مسح القارئ البطيء عند Enter", () => {
  it("يستردّ باركوداً رقمياً تسرّب (قارئٌ بطيء بأرقامٍ لاتينية)", () => {
    expect(recoverSlowScanCode("6281001234567", 3)).toBe("6281001234567");
  });

  it("يستردّ باركوداً رقمياً تسرّب بأرقامٍ عربية عبر الخريطة", () => {
    expect(recoverSlowScanCode("٦٢٨١٠٠١٢٣٤٥٦٧", 3)).toBe("6281001234567");
  });

  it("يستردّ باركوداً رقمياً بمسافةٍ داخلية ويُبقيها (عقد Code39؛ المطابقة اللا-حسّاسة للمسافة تتكفّل)", () => {
    // Comment 6: نستعمل العقد القياسيّ (لا تجريدٌ يدويّ) — المسافة تبقى، وbarcodeIdentityCandidates
    // يضيف الصورة بلا فراغات فيطابق الشكلين.
    expect(recoverSlowScanCode("0172 100055", 3)).toBe("0172 100055");
  });

  it("لا يخطف بحثاً بشرياً فيه رقمٌ عابر (Comment 3): «قلم A4» ⇒ null", () => {
    // يُفكّ إلى حروفٍ + رقم ⇒ ليس رقمياً محضاً ولا بادئة ⇒ يُترَك للبحث لا يُعامَل باركوداً.
    expect(recoverSlowScanCode("قلم a4", 3)).toBeNull();
    expect(recoverSlowScanCode("ab12", 3)).toBeNull();
  });

  it("يستردّ رمزاً داخلياً/مصنّعياً بأحرفٍ مشوّهة بالتخطيط العربي (شمق ⇒ alr)", () => {
    expect(recoverSlowScanCode("شمق005123", 3)).toBe("alr005123");
  });

  it("لا يخطف بحثاً بشرياً عربياً (يُفكّ حروفاً بلا أرقام)", () => {
    // «قلم ازرق» تحت الخريطة ⇒ حروفٌ لاتينية بلا رقمٍ ولا بادئة ⇒ يُترَك للبحث.
    expect(recoverSlowScanCode("قلم ازرق", 3)).toBeNull();
    expect(recoverSlowScanCode("كتاب", 3)).toBeNull();
  });

  it("يرفض الأقصر من الحدّ الأدنى (٤ محارف)", () => {
    expect(recoverSlowScanCode("12", 3)).toBeNull();
    expect(recoverSlowScanCode("ab1", 3)).toBeNull();
  });
});

describe("ScanBurstDetector — إعادة الضبط", () => {
  it("reset يمسح الحالة الجارية", () => {
    const det = new ScanBurstDetector({ minLength: 2, intraGapMs: 120 });
    feedSequence(det, ["1", "2"].map(digit), [10]);
    expect(det.isActive).toBe(true);
    det.reset();
    expect(det.isActive).toBe(false);
    expect(det.length).toBe(0);
    // بعد الضبط تبدأ ضغطةٌ جديدة كمرشّحٍ أوّل.
    expect(det.feed(digit("9"), 5000)).toBe("pass");
  });
});
