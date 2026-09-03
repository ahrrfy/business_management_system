import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { invoiceRemaining, isFullyPaid } from "./invoiceRemaining";

/**
 * اختبارٌ عقديّ: النتيجةُ رقمياً مطابقةٌ للنسخ التسع القائمة في الخادم (`total − returnedTotal − paidAmount`)،
 * ويُعالج الحدود التي كانت مصدرَ العلل: `returnedTotal ?? "0"` · `paidAmount` نصّاً · Decimal مباشر · null.
 */
describe("invoiceRemaining — صيغةٌ حاكمة لا تتكرّر", () => {
  it("الحالة الأساسية: 100 − 40 دفع = 60", () => {
    expect(invoiceRemaining({ total: "100", paidAmount: "40" }).toString()).toBe("60");
  });

  it("مسدَّدة كلياً ⇒ صفر (`isFullyPaid` = true)", () => {
    const inv = { total: "100", paidAmount: "100" };
    expect(invoiceRemaining(inv).toString()).toBe("0");
    expect(isFullyPaid(inv)).toBe(true);
  });

  it("مرتجع كليّاً ⇒ صفر (يُطرَح مع الدفع الجزئيّ)", () => {
    const inv = { total: "100", paidAmount: "60", returnedTotal: "40" };
    expect(invoiceRemaining(inv).toString()).toBe("0");
    expect(isFullyPaid(inv)).toBe(true);
  });

  it("سدادٌ زائد ⇒ سالب (المسند يبلغ عنه، الاستهلاك يقرّر ما يفعل)", () => {
    const inv = { total: "100", paidAmount: "120" };
    expect(invoiceRemaining(inv).toString()).toBe("-20");
    expect(isFullyPaid(inv)).toBe(true); // «مُسدَّدة» — لا يُطالَب المرء بها
  });

  it("مرتجعٌ يبتلع سداداً سابقاً ⇒ سالب", () => {
    const inv = { total: "100", paidAmount: "80", returnedTotal: "40" };
    expect(invoiceRemaining(inv).toString()).toBe("-20");
    expect(isFullyPaid(inv)).toBe(true);
  });

  it("`returnedTotal` غائب ⇒ يُعامَل صفراً (النمط القائم في الخادم: `?? \"0\"`)", () => {
    expect(invoiceRemaining({ total: "100", paidAmount: "40" }).toString()).toBe("60");
    expect(invoiceRemaining({ total: "100", paidAmount: "40", returnedTotal: null }).toString()).toBe("60");
    expect(invoiceRemaining({ total: "100", paidAmount: "40", returnedTotal: "" }).toString()).toBe("60");
  });

  it("قيمٌ فاسدة ⇒ صفرٌ في تلك الحدود بلا رمي (يفشل مغلقاً في القراءة)", () => {
    expect(invoiceRemaining({ total: "abc", paidAmount: "40" }).toString()).toBe("-40");
    expect(invoiceRemaining({ total: null, paidAmount: null }).toString()).toBe("0");
    expect(invoiceRemaining(null).toString()).toBe("0");
  });

  it("يقبل Decimal رقمياً — نفس الجواب مهما كان الشكل (نصّ أو رقم أو Decimal.toString())", () => {
    const asString = invoiceRemaining({ total: "1250.75", paidAmount: "500.25" }).toString();
    const asNumber = invoiceRemaining({ total: 1250.75, paidAmount: 500.25 }).toString();
    const asDecimal = invoiceRemaining({
      total: new Decimal("1250.75").toString(),
      paidAmount: new Decimal("500.25").toString(),
    }).toString();
    expect(asString).toBe("750.5");
    expect(asNumber).toBe("750.5");
    expect(asDecimal).toBe("750.5");
  });

  it("دقّةٌ كاملة بلا تقريبٍ صامت (القرار عند الاستهلاك)", () => {
    // 100 − 33.33 = 66.67 بلا خسارة (اختبارٌ يمنع إدخالَ toDecimalPlaces صامتاً).
    const r = invoiceRemaining({ total: "100", paidAmount: "33.33" });
    expect(r.toString()).toBe("66.67");
  });
});

describe("isFullyPaid — عتبةٌ ≤ صفر", () => {
  it("`> 0` = غير مُسدَّدة", () => {
    expect(isFullyPaid({ total: "100", paidAmount: "99.99" })).toBe(false);
    expect(isFullyPaid({ total: "100", paidAmount: "0" })).toBe(false);
  });

  it("`≤ 0` = مُسدَّدة (يشمل الزائد)", () => {
    expect(isFullyPaid({ total: "100", paidAmount: "100" })).toBe(true);
    expect(isFullyPaid({ total: "100", paidAmount: "500" })).toBe(true);
  });

  it("null ⇒ صفر ⇒ مُسدَّدة (لا فاتورة ⇒ لا مطالبة)", () => {
    expect(isFullyPaid(null)).toBe(true);
    expect(isFullyPaid(undefined)).toBe(true);
  });
});
