import { describe, expect, it } from "vitest";
import {
  barcodeDigitCore,
  barcodeIdentityCandidates,
  barcodesEquivalent,
  canonicalizeBarcodeInput,
  canonicalizeBarcodeForStorage,
  hasUnsupportedBarcodeCharacters,
} from "./barcodeNormalize";

describe("canonicalizeBarcodeInput — تطبيع مدخل الباركود (مصدر واحد للحفظ والمطابقة)", () => {
  it("يقلّم المسافات الطرفية — سببُ «الرمز الممسوح لا يطابق» على منتجٍ موجود فعلاً", () => {
    expect(canonicalizeBarcodeInput("  10095 ")).toBe("10095");
    expect(canonicalizeBarcodeInput("\t6001000000017\n")).toBe("6001000000017");
  });

  it("يطوي الأرقام العربية-الهندية والفارسية إلى لاتينية", () => {
    expect(canonicalizeBarcodeInput("١٠٠٩٥")).toBe("10095");
    expect(canonicalizeBarcodeInput("۶۰۰۱۰۰۰۰۰۰۰۱۷")).toBe("6001000000017");
    expect(canonicalizeBarcodeInput("ALR٠٠٠١٠٨٤")).toBe("ALR0001084");
  });

  it("لا يلمس حالة الأحرف لكنه يُسقط مسافة ASCII الداخلية (ضجيج «1  XXXX»، ١٣/٩)", () => {
    expect(canonicalizeBarcodeInput("MLZ6A")).toBe("MLZ6A");
    expect(canonicalizeBarcodeInput("NASR-6A")).toBe("NASR-6A");
    // مسافةٌ داخلية = ضجيجُ لصقِ Excel/إدخالٍ يدويّ؛ تُسقَط فتُصبح كلّ صور «1  XXXX» هويةً واحدة.
    expect(canonicalizeBarcodeInput("AB 12")).toBe("AB12");
    expect(canonicalizeBarcodeInput("1  1172")).toBe("11172");
    expect(canonicalizeBarcodeInput("1 1172")).toBe("11172");
    expect(canonicalizeBarcodeInput("11172")).toBe("11172");
  });

  it("الفارغ والمسافات وحدها ⇒ سلسلة فارغة (يرفضها المخطّط لا الدالّة)", () => {
    expect(canonicalizeBarcodeInput("")).toBe("");
    expect(canonicalizeBarcodeInput("   ")).toBe("");
  });

  it("مُتعادِل: تطبيع المُطبَّع لا يغيّره", () => {
    for (const v of ["10095", "6001000000017", "MLZ6A", "AB12", "ALR0001084"]) {
      expect(canonicalizeBarcodeInput(canonicalizeBarcodeInput(v))).toBe(v);
    }
  });

  it("يزيل علامات الاتجاه غير المرئية ويكشف محارف التحكّم الداخلية", () => {
    expect(canonicalizeBarcodeInput("\u200f ١٠٠٩٥ \u2066")).toBe("10095");
    expect(hasUnsupportedBarcodeCharacters("AB 12")).toBe(false);
    expect(hasUnsupportedBarcodeCharacters("AB\t12")).toBe(true);
    expect(hasUnsupportedBarcodeCharacters("AB\u000012")).toBe(true);
    expect(canonicalizeBarcodeInput("AB\u2060\u00ad12")).toBe("AB12");
  });
});

describe("canonicalizeBarcodeForStorage — حفظُ صيغة المصنع حرفيّاً (قرار المالك ١٥/٩)", () => {
  it("يُبقي المسافة الداخلية (صيغة المصنع «1  0172») — لا إزالةَ ولا إضافة", () => {
    expect(canonicalizeBarcodeForStorage("1  0172")).toBe("1  0172"); // مسافتان تبقيان كما هما
    expect(canonicalizeBarcodeForStorage("1 0172")).toBe("1 0172");
    expect(canonicalizeBarcodeForStorage("AB 12")).toBe("AB 12");
    expect(canonicalizeBarcodeForStorage("10172")).toBe("10172"); // بلا مسافة أصلاً ⇒ كما هو
  });

  it("يقلّم الحواف غير المرئية فقط (لصق Excel/لاحقة الماسح) دون المساس بالتسلسل المرئيّ", () => {
    expect(canonicalizeBarcodeForStorage("  1  0172 ")).toBe("1  0172"); // طرفيٌّ يُزال، داخليٌّ يبقى
    expect(canonicalizeBarcodeForStorage("\t1  0172\n")).toBe("1  0172");
    expect(canonicalizeBarcodeForStorage("‏ 1  0172 ⁦")).toBe("1  0172"); // علامات bidi تُسبّب القلب ⇒ تُزال
  });

  it("يطوي الأرقام العربية-الهندية إلى لاتينية (تسرّبُ تخطيطٍ لا رقمٌ مقصود) مع إبقاء المسافة", () => {
    expect(canonicalizeBarcodeForStorage("١  ٠١٧٢")).toBe("1  0172");
    expect(canonicalizeBarcodeForStorage("ALR٠٠٠١٠٨٤")).toBe("ALR0001084");
  });

  it("الفارغ والمسافات وحدها ⇒ سلسلة فارغة", () => {
    expect(canonicalizeBarcodeForStorage("")).toBe("");
    expect(canonicalizeBarcodeForStorage("   ")).toBe(""); // كلّها طرفية ⇒ تُقلَّم
  });

  it("مُتعادِل: تطبيعُ المُطبَّع لا يغيّره (idempotent) — لا قلبٌ ولا إعادةُ ترتيب", () => {
    for (const v of ["1  0172", "1 0172", "AB 12", "10172", "ALR0001084"]) {
      expect(canonicalizeBarcodeForStorage(canonicalizeBarcodeForStorage(v))).toBe(v);
    }
  });

  it("⭐ العقد الحاكم: المخزَّن يحفظ المسافة، والهويةُ تُسقطها ⇒ المسحُ «10172» يطابق المخزَّن «1  0172»", () => {
    const stored = canonicalizeBarcodeForStorage("1  0172");
    expect(stored).toBe("1  0172"); // العرض/الطباعة: صيغة المصنع
    // الهوية المشتقّة من المخزَّن (نظير عمود barcodeNormalized): تُسقط المسافة ⇒ تطابق المسحَ عديمَ المسافة
    expect(canonicalizeBarcodeInput(stored)).toBe("10172");
    expect(canonicalizeBarcodeInput("10172")).toBe("10172");
    expect(barcodesEquivalent(stored, "10172")).toBe(true); // مسحٌ بلا مسافة يطابق مخزَّناً بمسافة
  });

  it("يوافق canonicalizeBarcodeInput حين لا مسافة داخلية (الفرقُ الوحيد هو المسافة)", () => {
    for (const v of ["  10095 ", "١٠٠٩٥", "MLZ6A", "NASR-6A", "ALR٠٠٠١٠٨٤", "‏10095⁦"]) {
      expect(canonicalizeBarcodeForStorage(v)).toBe(canonicalizeBarcodeInput(v));
    }
  });
});

describe("barcodeIdentityCandidates — صور الهوية التي قد تعيدها محركات المسح", () => {
  it("يعامل UPC-A الصحيح وEAN-13 ذي الصفر البادئ هويةً واحدةً بالاتجاهين", () => {
    expect(barcodeIdentityCandidates("036000291452")).toEqual(["036000291452", "0036000291452"]);
    expect(barcodeIdentityCandidates("0036000291452")).toEqual(["0036000291452", "036000291452"]);
    expect(barcodesEquivalent("036000291452", "0036000291452")).toBe(true);
  });

  it("لا يحذف صفراً من كود غير قياسي ولا يوسّع EAN-8/ITF-14/الأبجدي", () => {
    expect(barcodeIdentityCandidates("036000291453")).toEqual(["036000291453"]);
    expect(barcodeIdentityCandidates("96385074")).toEqual(["96385074"]);
    expect(barcodeIdentityCandidates("10012345678902")).toEqual(["10012345678902"]);
    expect(barcodeIdentityCandidates("ALR000123")).toEqual(["ALR000123"]);
  });
});

describe("barcodeDigitCore — نواة الأرقام (بادئةٌ غير رقمية لا يُنتجها الماسح، ١٤/٩)", () => {
  it("يُسقط بادئةً غير رقمية ويُصغّر الحالة — «B51822572015» ⇒ «51822572015»", () => {
    expect(barcodeDigitCore("B51822572015")).toBe("51822572015");
    expect(barcodeDigitCore("b51822572015")).toBe("51822572015");
    expect(barcodeDigitCore("AB-95")).toBe("95");
    expect(barcodeDigitCore("$X 007 2")).toBe("0072"); // المسافةُ الداخلية تُسقَط أولاً ثمّ البادئة غير الرقمية
  });

  it("لا يمسّ رمزاً رقميّاً بحتاً (نواته = هويته)", () => {
    expect(barcodeDigitCore("51822572015")).toBe("51822572015");
    expect(barcodeDigitCore("٠١٧٢")).toBe("0172"); // طيّ الأرقام العربية أولاً
    expect(barcodeDigitCore("01721")).toBe("01721"); // الصفرُ البادئ رقمٌ — يبقى
  });

  it("يُبقي حرفاً داخلياً بعد أوّل رقم (البادئة فقط تُسقَط)", () => {
    expect(barcodeDigitCore("B5A8")).toBe("5a8");
    expect(barcodeDigitCore("XY12Z34")).toBe("12z34");
  });

  it("رمزٌ بلا أرقام ⇒ نواةٌ فارغة (لا يُطابَق)", () => {
    expect(barcodeDigitCore("ABC")).toBe("");
    expect(barcodeDigitCore("")).toBe("");
  });
});
