import { describe, expect, it } from "vitest";
import {
  receptionReceiptChange,
  receptionReceiptSettlements,
  receptionReceiptMethodLabel,
} from "@/lib/receptionReceiptSettlement";

const regular = { invoiceId: 1, total: "10000.00" };
const print = { invoiceId: 2, total: "10000.00" };
describe("Reception committed receipt payment allocation", () => {
  it("identifies held payment without inventing credit or a new cash receipt", () => {
    expect(
      receptionReceiptMethodLabel({
        settlement: { held: "10000", newlyPaid: "0" },
        methodLabel: "نقدي",
        paymentMode: "CREDIT",
      }),
    ).toBe("عربون مقبوض سابقاً");
    expect(
      receptionReceiptMethodLabel({
        settlement: { held: "5000", newlyPaid: "5000" },
        methodLabel: "بطاقة",
        paymentMode: "CASH",
      }),
    ).toBe("بطاقة + عربون مقبوض سابقاً");
  });
  it("prints cash change from tendered cash without treating change as an invoice payment", () => {
    expect(receptionReceiptChange("CASH", "20000", "15000")).toBe("5000.00");
    expect(receptionReceiptChange("CARD", "20000", "15000")).toBeNull();
    expect(receptionReceiptChange("CASH", "10000", "15000")).toBeNull();
    const result = receptionReceiptSettlements({
      regular,
      print: null,
      newlyPaid: "15000",
      printFirst: false,
    });
    expect(result.regular).toMatchObject({ paid: "10000.00", credit: null });
  });
  it("uses prior regular-invoice allocation before assigning new cash to the print invoice", () => {
    const result = receptionReceiptSettlements({
      regular,
      print,
      newlyPaid: "10000",
      printFirst: false,
      appliedPayments: [
        { appliedKind: "INVOICE", appliedId: 1, amount: "10000" },
      ],
    });
    expect(result.regular).toEqual({
      paid: "10000.00",
      credit: null,
      held: "10000.00",
      newlyPaid: "0.00",
    });
    expect(result.print).toEqual({
      paid: "10000.00",
      credit: null,
      held: null,
      newlyPaid: "10000.00",
    });
  });
  it("allocates only the remaining invoice balance and ignores work-order or unrelated held deposits", () => {
    const result = receptionReceiptSettlements({
      regular,
      print,
      newlyPaid: "8000",
      printFirst: false,
      appliedPayments: [
        { appliedKind: "INVOICE", appliedId: 1, amount: "6000" },
        { appliedKind: "WORKORDER", appliedId: 2, amount: "9000" },
        { appliedKind: "INVOICE", appliedId: 99, amount: "3000" },
      ],
    });
    expect(result.regular).toMatchObject({
      paid: "10000.00",
      credit: null,
      newlyPaid: "4000.00",
    });
    expect(result.print).toMatchObject({
      paid: "4000.00",
      credit: "6000.00",
      held: null,
    });
  });
  it("preserves print-first COD allocation with a partial held print deposit", () => {
    const result = receptionReceiptSettlements({
      regular,
      print,
      newlyPaid: "11000",
      printFirst: true,
      appliedPayments: [
        { appliedKind: "INVOICE", appliedId: 2, amount: "4000" },
      ],
    });
    expect(result.print).toMatchObject({
      paid: "10000.00",
      credit: null,
      newlyPaid: "6000.00",
    });
    expect(result.regular).toMatchObject({
      paid: "5000.00",
      credit: "5000.00",
      newlyPaid: "5000.00",
    });
  });
  it("prints fully funded draft invoices without false credit when nothing new was collected", () => {
    const result = receptionReceiptSettlements({
      regular,
      print: null,
      newlyPaid: "0",
      printFirst: false,
      appliedPayments: [
        { appliedKind: "INVOICE", appliedId: 1, amount: "10000" },
      ],
    });
    expect(result.regular).toMatchObject({
      paid: "10000.00",
      credit: null,
      newlyPaid: "0.00",
    });
  });
});
