import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveDocumentTotal,
  distributeToSubtotal,
  matchSupplierInvoice,
  subtotalForInvoiceTotal,
} from "../supplierInvoiceMatching";
import { calcTotals } from "../totals";
import type { InvoiceLine, InvoiceState } from "../types";

describe("invoice module portability", () => {
  it("does not contain module stems that collide on case-insensitive filesystems", () => {
    const moduleFiles = readdirSync(path.resolve(import.meta.dirname, ".."), {
      withFileTypes: true,
    })
      .filter(entry => entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name))
      .map(entry => entry.name);

    const pathsByStem = new Map<string, string[]>();
    for (const file of moduleFiles) {
      const stem = path.basename(file, path.extname(file)).toLocaleLowerCase("en-US");
      pathsByStem.set(stem, [...(pathsByStem.get(stem) ?? []), file]);
    }

    const collisions = [...pathsByStem.values()].filter(files => files.length > 1);
    expect(collisions).toEqual([]);
  });
});

/**
 * بلاغ المالك (١٧/٨/٢٦): «لا يتم قبول الفاتورة ولا يمكن مطابقتها مع المورد وقيمة الفاتورة».
 * هذه الحزمة تُثبّت منطق المطابقة: حكمٌ برقمٍ وسبب، وتوزيعٌ يبلغ الهدف بالضبط أو يُفصح عن متبقّيه.
 */
describe("matchSupplierInvoice — حكمُ المطابقة", () => {
  it("بلا قيمة ⇒ UNSET بلا رسالة (الحقل اختياريّ، السلوك التاريخيّ محفوظ)", () => {
    for (const empty of ["", "   "]) {
      const r = matchSupplierInvoice("14509.90", empty, "IQD");
      expect(r.verdict).toBe("UNSET");
      expect(r.message).toBe("");
      expect(r.derived).toBe("14509.90");
    }
  });

  it("مطابقٌ تماماً ⇒ MATCH وفرقٌ صفر", () => {
    const r = matchSupplierInvoice("14509.90", "14509.90", "IQD");
    expect(r.verdict).toBe("MATCH");
    expect(r.difference).toBe("0.00");
    expect(r.message).toContain("مطابق");
  });

  it("بنودنا أعلى ⇒ OURS_HIGHER برسالةٍ تحمل الرقمين والفرق وسببه المعتاد (خصم المورّد)", () => {
    const r = matchSupplierInvoice("14509.90", "14000", "IQD");
    expect(r.verdict).toBe("OURS_HIGHER");
    expect(r.difference).toBe("-509.90");
    expect(r.message).toContain("14509.90");
    expect(r.message).toContain("14000.00");
    expect(r.message).toContain("509.90");
    expect(r.message).toContain("خصم");
  });

  it("فاتورة المورّد أعلى ⇒ OURS_LOWER ويُلمّح لبندٍ ناقص أو شحنٍ مدرَج", () => {
    const r = matchSupplierInvoice("17283.00", "17383.00", "USD");
    expect(r.verdict).toBe("OURS_LOWER");
    expect(r.difference).toBe("100.00");
    expect(r.message).toContain("$");
    expect(r.message).toContain("بندٌ لم يُدخَل");
    expect(r.message).toContain("شحن");
  });

  it("قيمة سالبة أو نصّ تالف ⇒ INVALID/UNSET بلا انهيار", () => {
    expect(matchSupplierInvoice("100", "-5", "IQD").verdict).toBe("INVALID");
    expect(matchSupplierInvoice("100", "abc", "IQD").verdict).toBe("UNSET");
    expect(matchSupplierInvoice("100", "1.2.3", "IQD").verdict).toBe("UNSET");
  });

  it("يقارن بدقّة Decimal لا بـfloat (فرق سنتٍ لا يضيع)", () => {
    expect(matchSupplierInvoice("0.30", "0.30", "IQD").verdict).toBe("MATCH");
    const r = matchSupplierInvoice("1000000.01", "1000000.00", "IQD");
    expect(r.verdict).toBe("OURS_HIGHER");
    expect(r.difference).toBe("-0.01");
  });
});

describe("deriveDocumentTotal — الإجماليّ بترتيب تقريب الخادم", () => {
  it("يقرّب كلّ سطرٍ ثمّ يجمع (لا العكس) ⇒ يطابق computePurchaseDocument", () => {
    // 3.4566 × 7 = 24.1962 ⇒ الخادم يقرّب السطر إلى 24.20 قبل الجمع.
    const r = deriveDocumentTotal([{ price: "3.4566", qty: 7 }, { price: "3.4566", qty: 7 }]);
    expect(r.subtotal).toBe("48.40"); // 24.20 + 24.20
    expect(r.total).toBe("48.40");
  });

  it("يختلف عن calcTotals — وهذا سببُ وجوده (لا تكرارٌ بلا داعٍ)", () => {
    // `calcTotals` تجمع غير المقرَّب ثمّ تقرّب مرّة: round2(48.3924) = 48.39 ⇒ فلسٌ فرقاً.
    // لو استُعملت في المطابقة لأظهرت اللوحة «مطابق» بينما يرفض الخادم (أو العكس).
    const lines = [
      { price: "3.4566", qty: 7, discount: "0", discountType: "percent" },
      { price: "3.4566", qty: 7, discount: "0", discountType: "percent" },
    ] as unknown as InvoiceLine[];
    const state = {
      globalDiscount: "", globalDiscountType: "percent", shipping: "", shippingFree: false,
      otherExpenses: "", paidAmount: "", taxEnabled: false, taxRatePercent: "0",
    } as unknown as InvoiceState;
    expect(calcTotals(lines, state).grandTotal).toBe("48.39");
    expect(deriveDocumentTotal(lines).total).toBe("48.40");
  });

  it("الضريبة تُحسَب على المجموع الفرعيّ المقرَّب", () => {
    const r = deriveDocumentTotal([{ price: "100", qty: 10 }], "15");
    expect(r.subtotal).toBe("1000.00");
    expect(r.tax).toBe("150.00");
    expect(r.total).toBe("1150.00");
  });

  it("بلا بنود ⇒ أصفار بلا انهيار", () => {
    expect(deriveDocumentTotal([])).toEqual({
      grossSubtotal: "0.00", discount: "0.00", subtotal: "0.00", tax: "0.00", total: "0.00",
    });
  });

  it("خصم الفاتورة (0204) يَنقص المجموع، والضريبة على الوعاء **بعده**", () => {
    const r = deriveDocumentTotal([{ price: "1000", qty: 10 }, { price: "500", qty: 10 }], "0", "1500");
    expect(r.grossSubtotal).toBe("15000.00");
    expect(r.discount).toBe("1500.00");
    expect(r.subtotal).toBe("13500.00");
    expect(r.total).toBe("13500.00");

    // مع ضريبة ١٠٪: الوعاء ١٣٬٥٠٠ لا ١٥٬٠٠٠ (مطابقةً لـcomputePurchaseDocument).
    const taxed = deriveDocumentTotal([{ price: "1000", qty: 10 }, { price: "500", qty: 10 }], "10", "1500");
    expect(taxed.tax).toBe("1350.00");
    expect(taxed.total).toBe("14850.00");
  });

  it("خصمٌ يتجاوز البضاعة يُقصّ في المعاينة (لا إجماليّ سالب أثناء الكتابة)", () => {
    const r = deriveDocumentTotal([{ price: "100", qty: 1 }], "0", "500");
    expect(r.discount).toBe("100.00");
    expect(r.subtotal).toBe("0.00");
    expect(r.total).toBe("0.00");
  });

  it("خصمٌ سالب أو تالف ⇒ يُهمَل (صفر) بدل زيادة الإجمالي", () => {
    expect(deriveDocumentTotal([{ price: "100", qty: 1 }], "0", "-50").discount).toBe("0.00");
    expect(deriveDocumentTotal([{ price: "100", qty: 1 }], "0", "abc").discount).toBe("0.00");
  });
});

describe("subtotalForInvoiceTotal — المجموع الفرعيّ اللازم لبلوغ إجماليّ الفاتورة", () => {
  it("بلا ضريبة (الافتراضيّ في العراق) ⇒ الهدف نفسه بلا تقريب", () => {
    expect(subtotalForInvoiceTotal("14000", "0")).toBe("14000.00");
    expect(subtotalForInvoiceTotal("14000.55", 0)).toBe("14000.55");
  });

  it("مع ضريبة ⇒ يُنزَع أثرها: 11500 عند ١٥٪ ⇒ 10000", () => {
    expect(subtotalForInvoiceTotal("11500", "15")).toBe("10000.00");
  });
});

describe("distributeToSubtotal — توزيع الفرق على الأسعار", () => {
  it("يبلغ الهدف بالضبط ويحفظ نسب البنود (توزيعٌ بنسبة القيمة)", () => {
    const lines = [
      { price: "100", qty: 10 }, // 1000
      { price: "50", qty: 10 }, // 500
    ];
    const res = distributeToSubtotal(lines, "1350", "IQD");
    expect(res.reachedSubtotal).toBe("1350.00");
    expect(res.residual).toBe("0.00");
    // خصم ١٠٪ موزَّعٌ بالنسبة: 90 و45.
    expect(res.prices).toEqual(["90.00", "45.00"]);
  });

  it("آخر بندٍ يمتصّ باقي التقريب ⇒ المجموع = الهدف بالضبط لا انجراف سنتات", () => {
    // التحجيم وحده يُعطي 333.32 (سنتٌ ناقص)؛ البند الأخير (كمّية ١) يمتصّ الفرق فيبلغ الهدف.
    const lines = [
      { price: "100", qty: 3 },
      { price: "100", qty: 1 },
    ];
    const res = distributeToSubtotal(lines, "333.33", "IQD");
    expect(res.reachedSubtotal).toBe("333.33");
    expect(res.residual).toBe("0.00");
    expect(res.prices).toEqual(["83.33", "83.34"]);
  });

  it("حدُّ حبيبة الكمّية: هدفٌ لا تبلغه أسعارُ ٢dp × كمّية ٣ ⇒ متبقٍّ مُعلَن لا تطابقٌ مُدّعى", () => {
    // خطوةُ السعر الواحدة (0.01) تُحرّك المجموع ٠٫٠٣ ⇒ هدفٌ يبعد سنتاً واحداً غير بالغ.
    const res = distributeToSubtotal([{ price: "33.33", qty: 3 }, { price: "66.67", qty: 3 }], "299.99", "IQD");
    expect(res.reachedSubtotal).toBe("300.00");
    expect(res.residual).toBe("-0.01");
  });

  it("الدولار يوزَّع بأربع منازل (دقّة عملته)", () => {
    const res = distributeToSubtotal([{ price: "3.4566", qty: 5000 }], "17000", "USD");
    expect(res.reachedSubtotal).toBe("17000.00");
    expect(res.prices[0]).toBe("3.4000");
  });

  it("يُفصح عن المتبقّي حين لا يبلغ الهدفُ بأسعارٍ ضمن دقّة العملة (لا ادّعاء تطابق)", () => {
    // كمّية ١٠٬٠٠٠ بالدينار: أصغر خطوةِ سعرٍ (0.01) تُحرّك المجموع ١٠٠ ⇒ هدفٌ بفرق ٥٠ غير بالغ.
    const res = distributeToSubtotal([{ price: "10", qty: 10_000 }], "100050", "IQD");
    expect(res.residual).not.toBe("0.00");
    expect(Number(res.reachedSubtotal)).toBeGreaterThan(0);
  });

  it("بنودٌ بقيمةٍ صفرية ⇒ خطأٌ صريح بدل قسمةٍ على صفر", () => {
    const res = distributeToSubtotal([{ price: "0", qty: 5 }], "1000", "IQD");
    expect(res.prices).toEqual([]);
    expect(res.error).toContain("صفرية");
  });

  it("هدفٌ سالب ⇒ يُرفض", () => {
    const res = distributeToSubtotal([{ price: "10", qty: 1 }], "-5", "IQD");
    expect(res.prices).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  it("لا يُنتج سعراً سالباً حتى مع هدفٍ صفر", () => {
    const res = distributeToSubtotal([{ price: "10", qty: 2 }, { price: "20", qty: 1 }], "0", "IQD");
    for (const p of res.prices) expect(Number(p)).toBeGreaterThanOrEqual(0);
  });
});
