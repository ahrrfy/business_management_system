import { describe, expect, it } from "vitest";
import { receptionDocumentPaymentLegs } from "./receptionReceiptPayments";
import type { ReceptionPaymentMetadata } from "@shared/receptionPayments";
const metadata: ReceptionPaymentMetadata = {
  paymentSummary: {
    tenderedAmount: "170.00",
    appliedAmount: "150.00",
    changeAmount: "20.00",
  },
  paymentAllocations: [
    {
      paymentIndex: 0,
      receiptId: 1,
      invoiceId: 10,
      method: "CASH",
      amount: "40.00",
      reference: null,
    },
    {
      paymentIndex: 1,
      receiptId: 2,
      invoiceId: 10,
      method: "CARD",
      amount: "60.00",
      reference: "000123",
    },
    {
      paymentIndex: 1,
      receiptId: 3,
      invoiceId: 11,
      method: "CARD",
      amount: "30.00",
      reference: "000123",
    },
    {
      paymentIndex: 0,
      receiptId: 4,
      workOrderId: 20,
      method: "CASH",
      amount: "20.00",
      reference: null,
    },
  ],
};
describe("reception printed payment breakdown", () => {
  it("prints only the current document's actual allocations and explicitly includes old held money", () => {
    expect(
      receptionDocumentPaymentLegs(metadata, { invoiceId: 10 }, "125.00"),
    ).toEqual([
      { method: "مقبوض سابقاً", amount: "25.00", reference: null },
      { method: "نقدي", amount: "40.00", reference: null },
      { method: "بطاقة", amount: "60.00", reference: "000123" },
    ]);
  });
  it("keeps WO deposits and the other invoice separate", () => {
    expect(
      receptionDocumentPaymentLegs(metadata, { workOrderId: 20 }, "20.00"),
    ).toEqual([{ method: "نقدي", amount: "20.00", reference: null }]);
    expect(
      receptionDocumentPaymentLegs(metadata, { invoiceId: 11 }, "30.00"),
    ).toEqual([{ method: "بطاقة", amount: "30.00", reference: "000123" }]);
  });
  it("retains the legacy receipt path when metadata is absent", () => {
    expect(
      receptionDocumentPaymentLegs({}, { invoiceId: 10 }, "125.00"),
    ).toBeNull();
  });
  it("fails loudly if fee or another document's money makes a breakdown exceed recorded payment", () => {
    expect(() =>
      receptionDocumentPaymentLegs(metadata, { invoiceId: 10 }, "90.00"),
    ).toThrow("لا يطابق");
  });
  it("does not mutate or duplicate allocations when a saved result is replayed", () => {
    const before = JSON.stringify(metadata);
    const first = receptionDocumentPaymentLegs(
      metadata,
      { invoiceId: 10 },
      "100.00",
    );
    expect(
      receptionDocumentPaymentLegs(metadata, { invoiceId: 10 }, "100.00"),
    ).toEqual(first);
    expect(JSON.stringify(metadata)).toBe(before);
  });
});
