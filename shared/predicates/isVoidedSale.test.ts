import { describe, it, expect } from "vitest";
import { isVoidedSale, VOIDED_INVOICE_STATUSES } from "./isVoidedSale";
import { isVoidedInvoiceStatus } from "../invoiceStatus";
import { isDeadInvoice } from "./isDeadInvoice";

describe("isVoidedSale — تغليفٌ يحرس التمييز عن isDeadInvoice", () => {
  it("يعطي نفس نتيجة isVoidedInvoiceStatus حرفياً لكلّ الحالات", () => {
    const cases = [
      "PENDING",
      "CONFIRMED",
      "PAID",
      "PARTIALLY_PAID",
      "CANCELLED",
      "RETURNED",
      "SUPERSEDED",
    ] as const;
    for (const s of cases) {
      expect(isVoidedSale(s), `تباين على ${s}`).toBe(isVoidedInvoiceStatus(s));
    }
  });

  it("يقبل الفاتورة الكاملة (نمط الشاشة والاختبار العدائيّ)", () => {
    expect(isVoidedSale({ status: "CANCELLED" })).toBe(true);
    expect(isVoidedSale({ status: "RETURNED" })).toBe(false);
    expect(isVoidedSale(null)).toBe(false);
  });

  it("⚠️ التمييزُ الحاكم: RETURNED ميّتةٌ لكنّها ليست مُبطَلة (بيعٌ وقع ثمّ أُرجع)", () => {
    // الخلطُ يُنتج طرحاً مزدوجاً للمرتجع من الإيراد ⇒ عطبٌ ماليّ صامت.
    expect(isDeadInvoice("RETURNED")).toBe(true);
    expect(isVoidedSale("RETURNED")).toBe(false);
  });

  it("⚠️ SUPERSEDED في المجموعتين (البديلة تحمل الرقم)", () => {
    expect(isDeadInvoice("SUPERSEDED")).toBe(true);
    expect(isVoidedSale("SUPERSEDED")).toBe(true);
  });

  it("VOIDED يشمل CANCELLED و SUPERSEDED فقط — الحرسُ نصّيّ", () => {
    expect(VOIDED_INVOICE_STATUSES).toContain("CANCELLED");
    expect(VOIDED_INVOICE_STATUSES).toContain("SUPERSEDED");
    expect(VOIDED_INVOICE_STATUSES).not.toContain("RETURNED");
    expect(VOIDED_INVOICE_STATUSES.length).toBe(2);
  });
});
