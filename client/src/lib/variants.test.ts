import { describe, it, expect } from "vitest";
import {
  ean13CheckDigit,
  isValidEan13,
  genEan13,
  incEan13,
  deriveSku,
  barcodeState,
  marginPercent,
  toArabicDigits,
  onlyDigits,
  variantStockTotal,
  parseVariantPaste,
} from "./variants";

describe("EAN-13", () => {
  it("يحسب خانة التحقّق القياسية", () => {
    // 6291041500213 — باركود مرجعي شائع، خانة تحقّقه 3.
    expect(ean13CheckDigit("629104150021")).toBe(3);
    // مثال GS1 القياسي 400638133393 ⇒ 1.
    expect(ean13CheckDigit("400638133393")).toBe(1);
  });

  it("يقبل الصالح ويرفض غير الصالح", () => {
    expect(isValidEan13("6291041500213")).toBe(true);
    expect(isValidEan13("6291041500214")).toBe(false); // خانة تحقّق خاطئة
    expect(isValidEan13("62910415002")).toBe(false); // أقصر من ١٣
    expect(isValidEan13("629104150021A")).toBe(false); // حرف غير رقمي
    expect(isValidEan13("")).toBe(false);
  });

  it("genEan13 ينتج باركوداً صالحاً بالبادئة المطلوبة", () => {
    for (let i = 0; i < 50; i++) {
      const code = genEan13("621");
      expect(code).toMatch(/^\d{13}$/);
      expect(code.startsWith("621")).toBe(true);
      expect(isValidEan13(code)).toBe(true);
    }
  });

  it("incEan13 يزيد بمقدار واحد ويبقى صالحاً", () => {
    const start = genEan13("621");
    const next = incEan13(start);
    expect(isValidEan13(next)).toBe(true);
    // الجسم (أول ١٢ رقماً) يزيد بمقدار ١.
    expect(Number(next.slice(0, 12)) - Number(start.slice(0, 12))).toBe(1);
  });

  it("incEan13 يبدأ من مجال افتراضي حين يكون المدخل غير صالح", () => {
    expect(isValidEan13(incEan13(""))).toBe(true);
    expect(isValidEan13(incEan13("abc"))).toBe(true);
  });
});

describe("deriveSku", () => {
  it("يشتقّ رمزاً من البادئة + كود اللون + القياس", () => {
    expect(deriveSku("PG-G2", "أزرق")).toBe("PG-G2-BLU");
    expect(deriveSku("PG-G2", "أحمر", "M")).toBe("PG-G2-RED-M");
    expect(deriveSku("PG-G2", "أزرق", "0.7")).toBe("PG-G2-BLU-0.7");
  });

  it("يتعامل مع لون غير معروف وبادئة فارغة", () => {
    // لون عربي غير معروف (بلا كود ولا لاتينية): الكود يسقط ⇒ يبقى الأساس فقط.
    expect(deriveSku("BASE", "تركواز")).toBe("BASE");
    // بادئة فارغة ⇒ "PR" الافتراضية.
    expect(deriveSku("", "أزرق")).toBe("PR-BLU");
    // لون لاتيني غير معروف: أوّل ٣ محارف بحروف كبيرة.
    expect(deriveSku("X", "Teal")).toBe("X-TEA");
  });
});

describe("barcodeState", () => {
  it("يصنّف الحالات بالأولوية الصحيحة", () => {
    expect(barcodeState("", { countInForm: 0, takenInDb: false })).toBe("empty");
    expect(barcodeState("6291041500213", { countInForm: 1, takenInDb: true })).toBe("takenInDb");
    expect(barcodeState("6291041500213", { countInForm: 2, takenInDb: false })).toBe("dupInForm");
    expect(barcodeState("6291041500214", { countInForm: 1, takenInDb: false })).toBe("invalid");
    expect(barcodeState("6291041500213", { countInForm: 1, takenInDb: false })).toBe("valid");
  });

  it("المحجوز في القاعدة يسبق فحص خانة التحقّق", () => {
    // باركود غير صالح لكنه محجوز ⇒ نُظهر «محجوز» (الأهمّ للحفظ).
    expect(barcodeState("0000000000000", { countInForm: 1, takenInDb: true })).toBe("takenInDb");
  });
});

describe("marginPercent", () => {
  it("يحسب الربح الموجب", () => {
    expect(marginPercent(150, 250)).toEqual({ pct: 40, loss: false });
  });
  it("يكشف الخسارة حين السعر دون التكلفة", () => {
    const m = marginPercent(300, 250);
    expect(m?.loss).toBe(true);
  });
  it("يعيد null لسعر بيع غير موجب أو غير رقمي", () => {
    expect(marginPercent(150, 0)).toBeNull();
    expect(marginPercent(150, "")).toBeNull();
    expect(marginPercent("abc", "def")).toBeNull();
  });
  it("يقبل سلاسل بفواصل/نصوص ويستخرج الرقم", () => {
    expect(marginPercent("150", "250 د.ع")).toEqual({ pct: 40, loss: false });
  });
});

describe("parseVariantPaste", () => {
  it("يحلّل صفوفاً مفصولة بـTab بترتيب التصدير (لون، قياس، SKU، باركود/وحدة…، مخزون)", () => {
    // وحدتان ⇒ ٦ أعمدة: لون، قياس، SKU، باركود١، باركود٢، مخزون.
    const text = "أزرق\tM\t\t6291041500244\t6291041511244\t24\nأخضر\tL\tGR-L\t6291041500268\t\t30";
    const rows = parseVariantPaste(text, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ color: "أزرق", size: "M", sku: "", barcodes: ["6291041500244", "6291041511244"], stock: "24" });
    expect(rows[1]).toEqual({ color: "أخضر", size: "L", sku: "GR-L", barcodes: ["6291041500268", ""], stock: "30" });
  });

  it("يتجاهل الأسطر الفارغة وما لا لون له", () => {
    expect(parseVariantPaste("\n\n  \n", 1)).toEqual([]);
    // صفّ بعمود لون فارغ (الفاصلة لا تُقتطع بـtrim) ⇒ يُسقَط.
    expect(parseVariantPaste(",M,123", 1)).toEqual([]);
  });

  it("يقبل الفاصلة كفاصل أعمدة", () => {
    const rows = parseVariantPaste("أحمر,S,RED-S,629,50", 1);
    expect(rows[0]).toEqual({ color: "أحمر", size: "S", sku: "RED-S", barcodes: ["629"], stock: "50" });
  });
});

describe("أدوات العرض", () => {
  it("toArabicDigits يحوّل الأرقام", () => {
    expect(toArabicDigits(2026)).toBe("٢٠٢٦");
    expect(toArabicDigits("12 صنف")).toBe("١٢ صنف");
  });
  it("onlyDigits يُبقي الأرقام فقط", () => {
    expect(onlyDigits("12a3 ب4")).toBe("1234");
    expect(onlyDigits("--")).toBe("");
  });
  it("variantStockTotal يجمع كل الفروع", () => {
    expect(variantStockTotal({ 1: "48", 2: "12" })).toBe(60);
    expect(variantStockTotal({ 1: "", 2: "5" })).toBe(5);
    expect(variantStockTotal({})).toBe(0);
  });
});
