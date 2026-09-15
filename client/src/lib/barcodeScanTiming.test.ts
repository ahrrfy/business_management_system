import { describe, it, expect } from "vitest";
import { ScanBurstDetector, resolveScanSettle, recoverSlowScanCode, isConfidentScanCode, type FeedAction, type FlushResult } from "./barcodeScanTiming";
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

  it("لا يضمّ مفتاحاً يدوياً سابقاً إلى الومضة اللاحقة ويرفض المصدر الملتبس", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    const events: ScannerKeyEvent[] = [
      { code: "KeyA", key: "A", shiftKey: true }, // كتابة يدوية لا تنتمي إلى المسح
      { code: "KeyB", key: "B", shiftKey: true },
      digit("5"),
      digit("1"),
      digit("8"),
    ];
    const actions = feedSequence(det, events, [800, 10, 10, 10]);
    expect(actions).toEqual(["pass", "pass", "startBurst", "capture", "capture"]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(false);
    expect(code).toBe("B518");
  });

  it("يرفض لاحقة المسح المبتورة عند نمط البدء البطيء لأنّ التوقيت وحده لا يثبت مصدر السلف", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    const events: ScannerKeyEvent[] = [
      { code: "KeyB", key: "B", shiftKey: true },
      digit("5"),
      digit("1"),
      digit("8"),
    ];
    feedSequence(det, events, [150, 10, 10]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(false);
    expect(code).toBe("518");
  });

  it("يرفض لاحقة قارئٍ ذي فجوة بدء 800مي بدلاً من إصدار رمزٍ مبتور", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    const events: ScannerKeyEvent[] = [
      { code: "KeyB", key: "B", shiftKey: true },
      digit("5"),
      digit("1"),
      digit("8"),
    ];
    feedSequence(det, events, [800, 10, 10]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(false);
    expect(code).toBe("518");
  });

  it("لا يلحق حرفاً شارداً سابقاً بلاحقةٍ سريعة ضمن نافذة الالتباس", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    // «a» شاردٌ ثمّ فجوةٌ كبيرة (400مي) ثمّ مسحٌ سريع: يجب ألّا يُلحَق «a» بالباركود.
    const events: ScannerKeyEvent[] = [
      { code: "KeyA", key: "a" },
      { code: "Digit6", key: "6" },
      { code: "Digit2", key: "2" },
      { code: "Digit8", key: "8" },
    ];
    feedSequence(det, events, [400, 10, 10]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(false);
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

describe("ScanBurstDetector — المسافة: قارئٌ سريع تُلتقَط، كتابةٌ بطيئة تُمرَّر (١٥/٩)", () => {
  const letter = (c: string): ScannerKeyEvent => ({ code: `Key${c.toUpperCase()}`, key: c, shiftKey: /[A-Z]/.test(c) });
  const SP: ScannerKeyEvent = { code: "Space", key: " ", shiftKey: false };

  it("مسافةٌ بسرعة القارئ داخل الباركود لا تبتر البادئة — «A 1234» يُمسَح كاملاً (مراجعة Codex)", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    const actions = feedSequence(det, [letter("A"), SP, ...["1", "2", "3", "4"].map(digit)], [10, 10, 10, 10, 10]);
    expect(actions).toEqual(["pass", "startBurst", "capture", "capture", "capture", "capture"]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(true);
    expect(code).toBe("A 1234"); // البادئة «A» محفوظةٌ والفراغ ملتقط
  });

  it("باركود المصنع ذو الفراغ المزدوج «1  0172» يُمسَح كاملاً بسرعة القارئ (لا بتر)", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    feedSequence(det, [digit("1"), SP, SP, ...["0", "1", "7", "2"].map(digit)], [10, 10, 10, 10, 10, 10]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(true);
    expect(code).toBe("1  0172");
  });

  it("مسافةٌ بسرعةٍ بشرية (فاصلُ كلمات) تُمرَّر وتكسر المرشّح فلا يُختطَف البحث — «A␣1» بلا ومضة", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    const actions = feedSequence(det, [letter("A"), SP, digit("1")], [200, 200]);
    expect(actions).toEqual(["pass", "pass", "pass"]); // لا startBurst
    expect(det.isActive).toBe(false);
    const { accepted } = det.flush();
    expect(accepted).toBe(false); // كتابةٌ بشرية تُستعاد نصّاً، لا تُصدَر باركوداً
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

  it("يستردّ باركوداً ببادئة حرفٍ قصيرة تحت التخطيط العربي (بلاغ المالك ١٤/٩: «B51822572015» ⇐ «لا…»)", () => {
    // القارئ البطيء تحت لغةٍ عربية يُنتج «لا51822572015» (المفتاح الفيزيائيّ B ⇐ لا)؛ الترجمةُ تعيده
    // «b…»، والبادئةُ الحرفية القصيرة (≤٢) بنواةٍ رقمية تُقبَل فيحلّها مسارُ «نواة الأرقام» الخادميّ #1119
    // ⇒ لا تتأثّر القراءة بلغة الكيبورد.
    expect(recoverSlowScanCode("لا51822572015", 3)).toBe("b51822572015");
    expect(recoverSlowScanCode("B51822572015", 3)).toBe("B51822572015");
    // بادئةٌ أطول من حرفين (كلمةُ بحثٍ بشرية) تبقى بحثاً، لا باركوداً.
    expect(recoverSlowScanCode("abc12345", 3)).toBeNull();
    // مراجعة Codex: «حرفان + فراغ + أرقام» = عبارةُ بحثٍ بشرية لا باركود — الفراغُ يفصل البادئة عن النواة.
    // «في 2026» ⇐ «td 2026» يجب أن تبقى بحثاً (البادئةُ لا تلاصق الرقم).
    expect(recoverSlowScanCode("في 2026", 3)).toBeNull();
    expect(recoverSlowScanCode("td 2026", 3)).toBeNull();
    expect(recoverSlowScanCode("x 12345", 3)).toBeNull();
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

describe("isConfidentScanCode — بوّابة الباركود الواثق (تفصل المسح عن الكتابة العربية السريعة، ١٥/٩)", () => {
  it("يقبل الرقميّ المحض وALR والنظاميّ وبادئة الحرف اللاصقة لنواةٍ رقمية", () => {
    expect(isConfidentScanCode("10172", 3)).toBe(true);
    expect(isConfidentScanCode("6001000000017", 3)).toBe(true);
    expect(isConfidentScanCode("ALR0001084", 3)).toBe(true);
    expect(isConfidentScanCode("b51822572015", 3)).toBe(true); // «B…» مقاسُ مصنعٍ لاصقٌ لرقم
  });

  it("يرفض الحروفَ المحضة (اسمٌ عربيّ مفكوكٌ لِـASCII) والقصيرَ و«حرفان+فراغ+رقم»", () => {
    expect(isConfidentScanCode("abcd", 3)).toBe(false); // حروفٌ بلا أرقام ⇒ ليست باركوداً
    expect(isConfidentScanCode("hgsm", 3)).toBe(false); // «عمار» مفكوكاً تحت التخطيط ⇒ حروف
    expect(isConfidentScanCode("abc", 3)).toBe(false); // أقصر من 4
    expect(isConfidentScanCode("td 2026", 3)).toBe(false); // «في 2026» — الفراغ دليلُ عبارة بشرية
    expect(isConfidentScanCode("", 3)).toBe(false);
  });
});

describe("عقد الوضع التمريريّ (passthrough) — ومضةُ الحروف تُقبَل توقيتاً لكنّها غيرُ واثقة فلا تُصدَر مسحاً", () => {
  const letter = (c: string): ScannerKeyEvent => ({ code: `Key${c.toUpperCase()}`, key: c, shiftKey: false });

  it("⭐ اسمٌ عربيّ سريع (يظهر ASCII بالفكّ) — accepted بالتوقيت، لكنّ isConfidentScanCode=false ⇒ يبقى بحثاً", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    // أربعةُ أحرفٍ لاتينية سريعة (نظيرُ اسمٍ عربيّ مفكوكٍ عبر event.code): ومضةٌ توقيتاً.
    feedSequence(det, ["a", "b", "c", "d"].map(letter), [10, 10, 10]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(true); // التوقيت وحده صنّفها ومضة
    // في الوضع التمريريّ لا تُصدَر مسحاً لأنّها غيرُ واثقة ⇒ لا تحويلَ لإنجليزية ولا اختطافَ بحث.
    expect(isConfidentScanCode(code, 3)).toBe(false);
  });

  it("مسحٌ رقميّ سريع — accepted **و** واثق ⇒ يُصدَر مسحاً في الوضع التمريريّ", () => {
    const det = new ScanBurstDetector({ minLength: 3, intraGapMs: 120 });
    feedSequence(det, ["6", "2", "8", "1"].map(digit), [10, 10, 10]);
    const { accepted, code } = det.flush();
    expect(accepted).toBe(true);
    expect(isConfidentScanCode(code, 3)).toBe(true);
    expect(code).toBe("6281");
  });
});
