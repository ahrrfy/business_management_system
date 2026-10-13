import { describe, expect, it } from "vitest";
import { getPurchaseSettlement } from "./purchaseSettlement";

describe("purchase settlement display", () => {
  it("does not turn cash intent into payment", () => {
    expect(
      getPurchaseSettlement({
        total: "240000",
        paidAmount: "0",
        settlementType: "CASH",
      }),
    ).toMatchObject({
      paidAmount: "0.00",
      remainingAmount: "240000.00",
      status: "UNPAID",
      intentLabel: "نقدي (طريقة السداد)",
      statusLabel: "غير مسددة",
    });
  });
  it("uses the server evidence instead of an inflated historical cache", () => {
    expect(
      getPurchaseSettlement({
        total: "240000",
        paidAmount: "240000",
        settlement: {
          paidAmountIqd: "60000.00",
          returnedAmountIqd: "0.00",
          remainingAmountIqd: "180000.00",
          paidAmountCurrency: "60000.00",
          returnedAmountCurrency: "0.00",
          remainingAmountCurrency: "180000.00",
          status: "PARTIAL",
          requiresReview: true,
        },
      }),
    ).toMatchObject({
      paidAmount: "60000.00",
      remainingAmount: "180000.00",
      status: "PARTIAL",
      requiresReview: true,
    });
  });
  it("keeps credited returns distinct from actual payment", () => {
    expect(
      getPurchaseSettlement({
        total: "240000",
        paidAmount: "0",
        returnedAmount: "240000",
      }),
    ).toMatchObject({
      paidAmount: "0.00",
      returnedAmount: "240000.00",
      remainingAmount: "0.00",
      status: "CREDITED",
    });
  });
  it("keeps dollar amounts and dollar credits in their document currency", () => {
    expect(
      getPurchaseSettlement({
        agreedCurrency: "USD",
        total: "145000",
        usdTotal: "100",
        paidAmount: "72500",
        paidUsd: "50",
        returnedUsd: "10",
      }),
    ).toMatchObject({
      paidAmount: "50.00",
      returnedAmount: "10.00",
      remainingAmount: "40.00",
      status: "PARTIAL",
    });
  });
  it("uses linked payment evidence when reading an older server response", () => {
    expect(
      getPurchaseSettlement({
        total: "240000",
        paidAmount: "0",
        linkedCashPaidAmount: "60000",
      }),
    ).toMatchObject({
      paidAmount: "60000.00",
      remainingAmount: "180000.00",
      status: "PARTIAL",
    });
  });
  it("never produces a negative payable from excess payment", () => {
    expect(
      getPurchaseSettlement({ total: "0.10", paidAmount: "0.11" }),
    ).toMatchObject({ remainingAmount: "0.00", status: "PAID" });
  });
});
