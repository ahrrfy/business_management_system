import { describe, expect, it } from "vitest";
import {
  EMPTY_TERMINATION_SETTLEMENT,
  terminationSettlementTotal,
  validateTerminationSettlement,
  TERMINATION_PAYMENT_METHOD_LABEL,
  TERMINATION_PAYMENT_METHODS,
  terminationPaymentMethodLabel,
} from "./terminationSettlement";

describe("termination settlement breakdown", () => {
  it("derives net earned wages and payout from explicit gross-to-net classifications", () => {
    expect(
      terminationSettlementTotal({
        earnedGrossWages: "200.10",
        wageReductions: "10.00",
        advanceRecovery: "40.00",
        incomeTax: "25.00",
        employeeSocialSecurity: "25.00",
        employerSocialSecurity: "30.00",
        leaveCompensation: "20.20",
        noticeCompensation: "30.30",
        eosBenefit: "40.40",
        otherSettlement: "9.00",
        otherSettlementLabel: "بدل عهدة مستحق",
      }),
    ).toBe("200.00");
  });

  it("requires an explicit label for any other amount", () => {
    expect(
      validateTerminationSettlement({
        ...EMPTY_TERMINATION_SETTLEMENT,
        otherSettlement: "1",
      }),
    ).toContain("تصنيف");
  });

  it("rejects negative or over-precision values and accepts a classified zero total", () => {
    expect(
      validateTerminationSettlement({
        ...EMPTY_TERMINATION_SETTLEMENT,
        earnedGrossWages: "-1",
      }),
    ).toContain("غير سالب");
    expect(
      validateTerminationSettlement({
        ...EMPTY_TERMINATION_SETTLEMENT,
        eosBenefit: "1.001",
      }),
    ).toContain("منزلتين");
    expect(
      validateTerminationSettlement({
        ...EMPTY_TERMINATION_SETTLEMENT,
        earnedGrossWages: "100",
        incomeTax: "101",
      }),
    ).toContain("صافي");
    expect(validateTerminationSettlement(EMPTY_TERMINATION_SETTLEMENT)).toBeNull();
  });
});


describe("termination payment vocabulary", () => {
  it("retains four permitted methods and describes treasury direction accurately", () => {
    expect(TERMINATION_PAYMENT_METHODS).toEqual(["CASH", "CARD", "TRANSFER", "WALLET"]);
    expect(Object.keys(TERMINATION_PAYMENT_METHOD_LABEL)).toEqual([...TERMINATION_PAYMENT_METHODS]);
    expect(TERMINATION_PAYMENT_METHOD_LABEL.CASH).toBe("نقداً من الخزينة");
    expect(terminationPaymentMethodLabel("CASH", "IN")).toBe("نقداً إلى الخزينة");
    expect(terminationPaymentMethodLabel("TRANSFER")).toBe("تحويلٌ مصرفيّ");
    expect(terminationPaymentMethodLabel("LEGACY_CODE")).toBe("LEGACY_CODE");
    expect(terminationPaymentMethodLabel("")).toBe("");
  });
});
