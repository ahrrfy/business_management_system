import { describe, it, expect } from "vitest";
import { isDeadInvoice, DEAD_INVOICE_STATUSES } from "./isDeadInvoice";
import { isDeadInvoiceStatus } from "../invoiceStatus";

/**
 * اختبارٌ عقديّ: التغليفُ **حرفيّ** ولا يُغيّر السلوك. الفرقُ الوحيد أنّه يقبل الفاتورة الكاملة
 * بالإضافة إلى الحالة النصّية. اختبارٌ نصّيٌّ صريح يمنع أيّ انحرافٍ صامتٍ عن `isDeadInvoiceStatus`.
 */
describe("isDeadInvoice — تغليفٌ يحرس الاسم لا السلوك", () => {
  it("يعطي نفس نتيجة isDeadInvoiceStatus حرفياً لكلّ الحالات المعروفة", () => {
    const cases = [
      "PENDING",
      "CONFIRMED",
      "PAID",
      "PARTIALLY_PAID",
      "CANCELLED",
      "RETURNED",
      "SUPERSEDED",
      "UNKNOWN_XYZ", // حالةٌ مجهولة — يجب ألّا تُصنَّف ميّتةً
    ] as const;
    for (const s of cases) {
      expect(isDeadInvoice(s), `تباين على ${s}`).toBe(isDeadInvoiceStatus(s));
    }
  });

  it("يقبل الفاتورة الكاملة بحقل `status` (نمط الشاشة)", () => {
    expect(isDeadInvoice({ status: "CANCELLED" })).toBe(true);
    expect(isDeadInvoice({ status: "PAID" })).toBe(false);
    expect(isDeadInvoice({ status: null })).toBe(false);
    expect(isDeadInvoice({})).toBe(false);
  });

  it("null/undefined ⇒ false (لا يُسقط قائمةً بسبب صفٍّ ناقص)", () => {
    expect(isDeadInvoice(null)).toBe(false);
    expect(isDeadInvoice(undefined)).toBe(false);
  });

  it("DEAD يشمل الثلاثةَ حتماً — تمييزٌ حاكم يحرسه هذا الاختبار العقديّ", () => {
    // القاموس مسّه في المستقبل بلا كسر اختبار = خطر. هذا يحرس عدم إسقاط أيٍّ منها بلا انتباه.
    expect(DEAD_INVOICE_STATUSES).toContain("CANCELLED");
    expect(DEAD_INVOICE_STATUSES).toContain("RETURNED");
    expect(DEAD_INVOICE_STATUSES).toContain("SUPERSEDED");
    expect(DEAD_INVOICE_STATUSES.length).toBe(3);
  });
});
