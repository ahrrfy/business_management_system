import { describe, expect, it } from "vitest";
import { evaluateRefundOperationalDecision } from "./operationalDecision";

const base = {
  operationAllowed: true,
  sameBranch: true,
  ownsTransaction: true,
  sameOpenShift: true,
  sameBusinessDay: true,
  accountingPeriodOpen: true,
  hasSourceDocument: true,
  hasDownstreamEffects: false,
  refundAmountIqd: "50000.00",
  maxRefundAmountIqd: "50000.00",
  refundMethod: "CASH",
  originalPaymentMethods: ["CASH"],
  originalPaymentAmounts: { CASH: "50000.00" },
  drawerHasFunds: true,
  approvalOperation: "sales.cancel.approve",
} as const;

describe("evaluateRefundOperationalDecision", () => {
  it("executes a same-shift refund at the cap", () => {
    expect(evaluateRefundOperationalDecision(base).result).toBe("DIRECT");
  });

  it("routes an over-cap refund to approval", () => {
    expect(
      evaluateRefundOperationalDecision({ ...base, refundAmountIqd: "50000.01" }),
    ).toMatchObject({
      result: "APPROVAL_REQUIRED",
      approvalOperation: "sales.cancel.approve",
    });
  });

  it("routes a short drawer to approval for a funded alternative source", () => {
    expect(
      evaluateRefundOperationalDecision({ ...base, drawerHasFunds: false }),
    ).toMatchObject({
      result: "APPROVAL_REQUIRED",
      approvalOperation: "sales.cancel.approve",
    });
  });

  it("requires the original payment rail", () => {
    expect(
      evaluateRefundOperationalDecision({ ...base, refundMethod: "CARD" }),
    ).toMatchObject({ result: "APPROVAL_REQUIRED" });
  });

  it("routes an aggregate refund that exceeds the selected rail to approval", () => {
    expect(evaluateRefundOperationalDecision({
      ...base,
      refundAmountIqd: "100.00",
      originalPaymentMethods: ["CASH", "CARD"],
      originalPaymentAmounts: { CASH: "10.00", CARD: "90.00" },
    })).toMatchObject({
      result: "APPROVAL_REQUIRED",
      reason: "مبلغ الرد يتجاوز المقبوض المتبقي على طريقة الدفع المختارة",
    });
  });

  it("reports an invalid payment rail before shift approval routing", () => {
    expect(
      evaluateRefundOperationalDecision({ ...base, refundMethod: "CARD", sameOpenShift: false }),
    ).toMatchObject({
      result: "APPROVAL_REQUIRED",
      reason: "طريقة الرد لا تطابق طريقة الدفع الأصلية",
    });
  });
});
