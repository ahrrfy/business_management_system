/**
 * PUR-UNIT-01 (٤/٩/٢٦): تدقيق Codex أثبت بصرياً (لقطة cp47) أنّ ProductSearchBar/BulkPicker
 * يعرضان «١٥٠ د.ع/درزن» لصنفٍ تكلفةُ قطعتِه ١٥٠ ومعامل درزنه ١٢ (الصحيح ١٨٠٠). حمولةُ الشراء
 * تحمل `unitPrice=l.price`، فيقسمه `receive.ts` على المعامل ⇒ costPerBase=12.50 يسمّم WAVG.
 *
 * **الجولة الثانية (Codex #980):** الفرع الدولاريّ كان يضع الناتجَ الدينارّي حرفياً في حقلٍ
 * يُرسَل خادمياً كـ`unitPrice` بعملة `USD` ⇒ يضربه الخادم بسعر التثبيت مرّةً ثانية ⇒ ذمّة
 * المورّد وWAVG تنتفخان بمقدار `agreedRate`. الآن الحساب: `IQD × factor / agreedRate` ⇒
 * الحقلُ يمتلئ بـ‎$1.24 لا ‎$1800. وبلا تثبيتٍ صحيح ⇒ حقلٌ فارغٌ صراحةً لا افتراضٌ صامت.
 *
 * هذه الحزمة تُثبّت **الحساب النقيّ** الذي يُغذّي مسارَي الإضافة (بحث سريع + إضافة جماعية):
 * `price = costBase × conversionFactor` (بالدينار) أو نفسه مقسوماً على سعر التثبيت (بالدولار).
 * الاختبار يفشل قبل الإصلاح ويمرّ بعده.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  derivePurchaseLinePriceFromRequisition,
  estimatedPurchaseUnitPrice,
} from "../purchasePrice";

describe("estimatedPurchaseUnitPrice — PUR-UNIT-01", () => {
  it("الوحدة الأساس (معامل ١) ⇒ لا تغيّر: تكلفةُ قطعةٍ ١٥٠ ⇒ ١٥٠", () => {
    expect(estimatedPurchaseUnitPrice("150", "1")).toBe("150.00");
  });

  it("درزن (معامل ١٢): تكلفةُ قطعةٍ ١٥٠ ⇒ ١٨٠٠ (نواة البلاغ — كان يُنتج ١٥٠ فيسمّم WAVG)", () => {
    expect(estimatedPurchaseUnitPrice("150", "12")).toBe("1800.00");
  });

  it("كرتون (معامل ٤٨): تكلفةُ قطعةٍ ١٢٥ ⇒ ٦٠٠٠", () => {
    expect(estimatedPurchaseUnitPrice("125", "48")).toBe("6000.00");
  });

  it("تكلفةٌ كسريّة بمنزلتين ⇒ ضربٌ بلا فقدٍ ثمّ منزلتان: ٧٫٥٠ × ١٢ = ٩٠٫٠٠", () => {
    expect(estimatedPurchaseUnitPrice("7.50", "12")).toBe("90.00");
  });

  it("عملة الدولار **بلا سعر تثبيت** ⇒ نصٌّ فارغ (لا تخمين، المستخدم يُدخل يدوياً)", () => {
    // Codex #980: قبل الإصلاح كان يُنتج قيمةً دولاريّة بالمبلغ الدينارّيّ حرفياً (١٨٠٠ في حقل $) ⇒
    // يضربها الخادم بسعر التثبيت مرّةً أخرى ⇒ AP يتضخّم بمقدار `agreedRate`.
    expect(estimatedPurchaseUnitPrice("150", "12", "USD")).toBe("");
    expect(estimatedPurchaseUnitPrice("150", "12", "USD", null)).toBe("");
    expect(estimatedPurchaseUnitPrice("150", "12", "USD", "")).toBe("");
    expect(estimatedPurchaseUnitPrice("150", "12", "USD", "0")).toBe("");
    expect(estimatedPurchaseUnitPrice("150", "12", "USD", "-1")).toBe("");
  });

  it("عملة الدولار مع سعر تثبيت صحيح (١٤٥٠ د.ع/$): درزن (معامل ١٢) بتكلفة ١٥٠ د.ع ⇒ ‎$1.2414", () => {
    // 150 × 12 = 1800 د.ع؛ 1800 / 1450 = 1.24137931... ⇒ 1.2414 (HALF_UP بأربع منازل).
    expect(estimatedPurchaseUnitPrice("150", "12", "USD", "1450")).toBe("1.2414");
  });

  it("عملة الدولار مع سعر تثبيت للوحدة الأساس (معامل ١): تكلفة ١٥٠ د.ع/قطعة ⇒ ‎$0.1034", () => {
    // 150 × 1 / 1450 = 0.10344827... ⇒ 0.1034 (HALF_UP بأربع منازل).
    expect(estimatedPurchaseUnitPrice("150", "1", "USD", "1450")).toBe("0.1034");
  });

  it("عملة الدولار: كسرٌ عاليُّ الدقّة يبقى ضمن ٤ منازل بلا فقد", () => {
    // 3 × 4 = 12؛ 12 / 1450 = 0.00827586... ⇒ 0.0083.
    expect(estimatedPurchaseUnitPrice("3", "4", "USD", "1450")).toBe("0.0083");
  });

  it("عملة الدولار: تكلفة أساسٍ صفريّة تبقى فارغةً إن غاب التثبيت (لا رقمٌ من عدم)", () => {
    // بلا تثبيتٍ لا نُلفّق ‎$0.0000؛ الحقل فارغٌ يُوجّه المستخدمَ لضبط التثبيت أوّلاً.
    expect(estimatedPurchaseUnitPrice("0", "12", "USD")).toBe("");
    expect(estimatedPurchaseUnitPrice("0", "12", "USD", "1450")).toBe("0.0000");
  });

  it("عملة الدينار: تكلفةٌ صفريّة (بكجٌ صار متاحاً بغلطة؟) ⇒ ٠ لا رمي: ٠ × ١٢ = ٠", () => {
    expect(estimatedPurchaseUnitPrice("0", "12")).toBe("0.00");
    expect(estimatedPurchaseUnitPrice("0.00", "12")).toBe("0.00");
  });

  it("معاملٌ ≤ صفر أو معدوم ⇒ التكلفةُ كما هي (كأنّ الوحدة أساس) — لا قسمةَ على صفر", () => {
    expect(estimatedPurchaseUnitPrice("150", "0")).toBe("150.00");
    expect(estimatedPurchaseUnitPrice("150", null)).toBe("150.00");
    expect(estimatedPurchaseUnitPrice("150", undefined)).toBe("150.00");
    expect(estimatedPurchaseUnitPrice("150", "-3")).toBe("150.00");
  });

  it("مدخلٌ نصّيٌّ فارغ/نال ⇒ صفرٌ بلا رمي (`D()` الخام يرمي)", () => {
    expect(estimatedPurchaseUnitPrice("", "12")).toBe("0.00");
    expect(estimatedPurchaseUnitPrice(null, "12")).toBe("0.00");
    expect(estimatedPurchaseUnitPrice(undefined, "12")).toBe("0.00");
  });
});

describe("derivePurchaseLinePriceFromRequisition — Codex #980 Finding 4", () => {
  it("سطرٌ من طلب مصابٌ بالعطب القديم: `estimatedUnitPrice=150` لدرزنٍ (معامل ١٢) بتكلفة ١٥٠ ⇒ يُصلَح إلى ١٨٠٠", () => {
    // نواة البلاغ: `PurchaseRequisitions.addCatalogItem` كان يُخزّنه بلا ضربٍ.
    // الآن الاستحضار يكشف الإصابة (القادم ≤ تكلفة الأساس بينما المعامل > ١) فيُعيد الحساب.
    expect(derivePurchaseLinePriceFromRequisition("150", "150", "12")).toBe("1800.00");
  });

  it("سطرٌ من طلبٍ صحيح: `estimatedUnitPrice=1800` لدرزنٍ (معامل ١٢) بتكلفة ١٥٠ ⇒ يُحترَم كما هو", () => {
    // القيمةُ فوق التكلفة صريحة ⇒ لا نُعيد كتابتها (تُحفظ نصّاً حرفياً).
    expect(derivePurchaseLinePriceFromRequisition("1800", "150", "12")).toBe("1800");
  });

  it("سطرٌ من طلبٍ صحيح للوحدة الأساس: `estimatedUnitPrice=150` لقطعةٍ (معامل ١) ⇒ يُحترَم", () => {
    // معامل ١ ⇒ لا مؤشّرَ إصابة (لا ضربٌ متوقّع). القيمةُ تُحفظ كما هي.
    expect(derivePurchaseLinePriceFromRequisition("150", "150", "1")).toBe("150");
  });

  it("سطرٌ بلا `estimatedUnitPrice` (null): اشتقاقٌ مباشرٌ من التكلفة × المعامل — كرتون (٤٨) بتكلفة ١٢٥ ⇒ ٦٠٠٠", () => {
    expect(derivePurchaseLinePriceFromRequisition(null, "125", "48")).toBe("6000.00");
  });

  it("سطرٌ بـ`estimatedUnitPrice=\"\"`: كأنّه غائب ⇒ اشتقاق من التكلفة × المعامل", () => {
    expect(derivePurchaseLinePriceFromRequisition("", "150", "12")).toBe("1800.00");
  });

  it("تسعيرٌ يدويٌّ للمُعتمِد أعلى من التكلفة (١٧٥٠ لدرزنٍ بتكلفة ١٥٠) ⇒ يُحترَم لأنّه فوق مؤشّر الإصابة", () => {
    expect(derivePurchaseLinePriceFromRequisition("1750", "150", "12")).toBe("1750");
  });

  it("معاملٌ ≤ ١ (وحدة أساس) بقيمةٍ مساوية للتكلفة: لا يُعتبَر مصاباً — لا ضربٌ متوقّع", () => {
    expect(derivePurchaseLinePriceFromRequisition("150", "150", "1")).toBe("150");
  });
});

/**
 * حزامٌ نصّيٌّ يمنع انحدارَ Finding 3: طباعةُ أمر الشراء المُحرَّر لا يجوز أن تحسب السعرَ بـ
 * `l.costBase || l.price` (كان يُخرِج الأصل بدل ما حرّره المستخدم). هذا حارسٌ صغير — لا يفحص
 * جودة الحساب، بل وجودَ النمط المُدان في `printOrder` بالتحديد.
 */
describe("PurchaseEdit.printOrder — Codex #980 Finding 3 source guard", () => {
  it("لا يستعمل `l.costBase || l.price` — طباعةٌ توافق ما حفظه المستخدم", () => {
    const filePath = path.resolve(__dirname, "../../../pages/PurchaseEdit.tsx");
    const source = readFileSync(filePath, "utf8");
    // نطاق البحث: كتلة `printOrder` وحدها — قبل أوّل `function ` تالية.
    const start = source.indexOf("function printOrder");
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const nextFn = rest.indexOf("\n  function ", 1);
    const block = nextFn > 0 ? rest.slice(0, nextFn) : rest;
    expect(block).toMatch(/l\.price/);
    expect(block).not.toMatch(/l\.costBase\s*\|\|/);
  });
});
