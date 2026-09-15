import { describe, expect, it } from "vitest";
import { receptionInvoiceCorrectionBlockReason } from "./receptionInvoiceCorrection";

describe("receptionInvoiceCorrectionBlockReason", () => {
  it.each(["PENDING", "PARTIALLY_PAID", "PAID", "CONFIRMED"])(
    "يسمح بتصحيح الفاتورة الحية %s",
    (status) => {
      expect(receptionInvoiceCorrectionBlockReason({ status, returnedTotal: "0" })).toBeNull();
    },
  );

  it.each(["CANCELLED", "RETURNED", "SUPERSEDED"])(
    "يمنع المستند الميت %s من إعادة إصدار ثانية",
    (status) => {
      expect(receptionInvoiceCorrectionBlockReason({ status })).toMatch(/منتهية/);
    },
  );

  it("يمنع مسارات تحتاج عكساً متخصصاً", () => {
    expect(receptionInvoiceCorrectionBlockReason({ status: "PAID", workOrderId: 4 })).toMatch(/أمر الشغل/);
    expect(receptionInvoiceCorrectionBlockReason({ status: "PAID", consignmentId: 8 })).toMatch(/التوصيل/);
    expect(receptionInvoiceCorrectionBlockReason({ status: "PAID", returnedTotal: "1.00" })).toMatch(/مرتجع/);
  });
});

