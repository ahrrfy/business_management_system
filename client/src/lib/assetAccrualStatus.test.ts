import { describe, expect, it } from "vitest";
import { assetSettlementPresentation } from "./assetAccrualStatus";

describe("asset accrual settlement presentation", () => {
  it.each(["ACCRUED_UNPAID", "PAYMENT_PENDING", "PAYABLE_UNSETTLED"])(
    "keeps %s operationally separate while the liability is outstanding",
    (status) => {
      const result = assetSettlementPresentation(status);
      expect(result.liabilityOutstanding).toBe(true);
      expect(result.cashMoved).toBe(false);
      expect(result.detail).not.toContain("تعطيل الأصل");
    },
  );

  it("distinguishes paid, refund-pending, and fully corrected states", () => {
    expect(assetSettlementPresentation("PAID")).toMatchObject({
      label: "مسوّى ومدفوع",
      liabilityOutstanding: false,
      cashMoved: true,
    });
    expect(assetSettlementPresentation("REFUND_PENDING")).toMatchObject({
      label: "استرداد معلّق",
      cashMoved: true,
    });
    expect(assetSettlementPresentation("RECOGNITION_REVERSED")).toMatchObject({
      label: "مصحح ومعكوس",
      tone: "cancelled",
      cashMoved: false,
    });
  });
});
