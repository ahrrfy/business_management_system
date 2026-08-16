import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { createPostingIntentEvidence } from "../accounting/postingEngine";
import {
  payrollAccrualPosting,
  payrollSettlementPosting,
} from "../payroll/accounting";
import {
  payrollBreakdown,
  payrollHash,
  periodAccrualDate,
} from "../payroll/helpers";
import {
  assertValidRemittanceDocument,
  payrollRemittancePaymentReference,
} from "../payroll/remittance";
import {
  assertPayrollPaymentEvidence,
  payrollSalaryPaymentSourceKey,
} from "../payroll/settlement";

function item(overrides: Record<string, unknown> = {}) {
  return {
    gross: "1000000.00",
    overtime: "100000.00",
    commission: "50000.00",
    deductions: "200000.00",
    wageReduction: "20000.00",
    advanceDeduction: "100000.00",
    socialSecurityEmployee: "50000.00",
    incomeTax: "30000.00",
    socialSecurityEmployer: "120000.00",
    endOfServiceAccrual: "40000.00",
    net: "950000.00",
    ...overrides,
  };
}

describe("payroll accrual backend contract", () => {
  it("classifies every dinar and computes E/N/employer expense exactly", () => {
    const value = payrollBreakdown(item());
    expect(value.wageReduction.toFixed(2)).toBe("20000.00");
    expect(value.earnedWage.toFixed(2)).toBe("1130000.00");
    expect(value.net.toFixed(2)).toBe("950000.00");
    expect(value.expenseTotal.toFixed(2)).toBe("1290000.00");
  });

  it("rejects an unclassified deduction and accepts a legitimate zero-net line", () => {
    expect(() =>
      payrollBreakdown(item({ deductions: "200001.00" })),
    ).toThrow(/لا تطابق تصنيفها/);

    const zero = payrollBreakdown(
      item({
        gross: "200.00",
        overtime: "0.00",
        commission: "0.00",
        deductions: "200.00",
        wageReduction: "200.00",
        advanceDeduction: "0.00",
        socialSecurityEmployee: "0.00",
        incomeTax: "0.00",
        socialSecurityEmployer: "0.00",
        endOfServiceAccrual: "0.00",
        net: "0.00",
      }),
    );
    expect(zero.net.isZero()).toBe(true);
    expect(zero.expenseTotal.isZero()).toBe(true);
  });

  it("posts the frozen accrual and its exact inverse against the approved profiles", () => {
    const value = payrollBreakdown(item());
    const accrual = payrollAccrualPosting(value);
    const reversal = payrollAccrualPosting(value, true);

    expect(accrual.amount.toFixed(2)).toBe("1290000.00");
    expect(reversal.amount.toFixed(2)).toBe("-1290000.00");
    expect(() =>
      createPostingIntentEvidence(accrual.intent, {
        amount: accrual.amount,
        ...accrual.source,
      }),
    ).not.toThrow();
    expect(() =>
      createPostingIntentEvidence(reversal.intent, {
        amount: reversal.amount,
        ...reversal.source,
      }),
    ).not.toThrow();
  });

  it("keeps zero net explicit while classifying statutory, advance, and employer costs exactly", () => {
    const value = payrollBreakdown(item({
      gross: "1000.00",
      overtime: "0.00",
      commission: "0.00",
      deductions: "1000.00",
      wageReduction: "0.00",
      advanceDeduction: "500.00",
      socialSecurityEmployee: "300.00",
      incomeTax: "200.00",
      socialSecurityEmployer: "100.00",
      endOfServiceAccrual: "50.00",
      net: "0.00",
    }));
    const accrual = payrollAccrualPosting(value);
    const reversal = payrollAccrualPosting(value, true);

    expect(accrual.profile).toBe("ADJUST_PAYROLL_ACCRUAL");
    expect(accrual.amount.toFixed(2)).toBe("1150.00");
    expect(accrual.source).toEqual({
      roleDebits: {
        SALARIES: "1000.00",
        SOCIAL_SECURITY_EXPENSE: "100.00",
        EOS_EXPENSE: "50.00",
      },
      roleCredits: {
        ACCRUED_SALARY: "0.00",
        EMPLOYEE_ADVANCES: "500.00",
        PAYROLL_TAX_PAYABLE: "200.00",
        SOCIAL_SECURITY_PAYABLE: "400.00",
        EOS_PROVISION: "50.00",
      },
    });
    expect(() => createPostingIntentEvidence(accrual.intent, {
      amount: accrual.amount,
      ...accrual.source,
    })).not.toThrow();

    expect(reversal.profile).toBe("ADJUST_PAYROLL_ACCRUAL_REVERSAL");
    expect(reversal.amount.toFixed(2)).toBe("-1150.00");
    expect(reversal.source).toEqual({
      roleDebits: {
        ACCRUED_SALARY: "0.00",
        EMPLOYEE_ADVANCES: "500.00",
        PAYROLL_TAX_PAYABLE: "200.00",
        SOCIAL_SECURITY_PAYABLE: "400.00",
        EOS_PROVISION: "50.00",
      },
      roleCredits: {
        SALARIES: "1000.00",
        SOCIAL_SECURITY_EXPENSE: "100.00",
        EOS_EXPENSE: "50.00",
      },
    });
    expect(() => createPostingIntentEvidence(reversal.intent, {
      amount: reversal.amount,
      ...reversal.source,
    })).not.toThrow();
  });

  it("keeps zero statutory/advance roles explicit without creating zero journal lines", () => {
    const value = payrollBreakdown(
      item({
        gross: "1000000.00",
        overtime: "0.00",
        commission: "0.00",
        deductions: "0.00",
        wageReduction: "0.00",
        advanceDeduction: "0.00",
        socialSecurityEmployee: "0.00",
        incomeTax: "0.00",
        socialSecurityEmployer: "0.00",
        endOfServiceAccrual: "0.00",
        net: "1000000.00",
      }),
    );
    const posting = payrollAccrualPosting(value);
    expect(posting.intent.lines).toHaveLength(2);
    expect(() =>
      createPostingIntentEvidence(posting.intent, {
        amount: posting.amount,
        ...posting.source,
      }),
    ).not.toThrow();
  });

  it.each([
    ["SALARY", "OUT", "CASH", "PAYMENT_OUT_PAYROLL_NET"],
    ["SALARY", "IN", "TRANSFER", "PAYMENT_IN_PAYROLL_NET_RETURN"],
    ["INCOME_TAX", "OUT", "CARD", "PAYMENT_OUT_PAYROLL_TAX_REMIT"],
    ["INCOME_TAX", "IN", "CASH", "PAYMENT_IN_PAYROLL_TAX_RETURN"],
    ["SOCIAL_SECURITY", "OUT", "WALLET", "PAYMENT_OUT_PAYROLL_SS_REMIT"],
    ["SOCIAL_SECURITY", "IN", "TRANSFER", "PAYMENT_IN_PAYROLL_SS_RETURN"],
  ] as const)("validates %s %s via %s", (kind, direction, paymentMethod, profile) => {
    const posting = payrollSettlementPosting({
      kind,
      direction,
      paymentMethod,
      amount: new Decimal("125000.00"),
    });
    expect(posting.profile).toBe(profile);
    expect(() =>
      createPostingIntentEvidence(posting.intent, {
        amount: "125000.00",
        ...posting.source,
      }),
    ).not.toThrow();
  });

  it("uses the civil month end as the accrual date", () => {
    expect(periodAccrualDate("2026-02")).toBe("2026-02-28");
    expect(periodAccrualDate("2028-02")).toBe("2028-02-29");
    expect(periodAccrualDate("2026-12")).toBe("2026-12-31");
  });

  it("keeps snapshot hashes stable across MySQL JSON key reordering", () => {
    expect(
      payrollHash({ settings: { enabled: false, rate: "0" }, version: 1 }),
    ).toBe(
      payrollHash({ version: 1, settings: { rate: "0", enabled: false } }),
    );
  });

  it("accepts only bounded raster-image evidence for remittance documents", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlA+uQAAAAASUVORK5CYII=";
    expect(() => assertValidRemittanceDocument(png)).not.toThrow();
    expect(() => assertValidRemittanceDocument("data:image/png;base64,iVBORw0KGgo=")).toThrow();
    expect(() => assertValidRemittanceDocument("data:image/jpeg;base64,/9j/4A==")).toThrow();
    expect(() => assertValidRemittanceDocument("data:image/webp;base64,UklGRgAAAABXRUJQ")).toThrow();
    expect(() => assertValidRemittanceDocument("javascript:alert(1)")).toThrow();
    expect(() =>
      assertValidRemittanceDocument("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="),
    ).toThrow();
    expect(() =>
      assertValidRemittanceDocument("data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+"),
    ).toThrow();
    expect(() =>
      assertValidRemittanceDocument(`data:image/png;base64,${"A".repeat(2_800_000)}`),
    ).toThrow();
  });

  it("normalizes receipt evidence and requires exactly four card digits", () => {
    for (const validator of [assertPayrollPaymentEvidence, payrollRemittancePaymentReference]) {
      expect(validator("CASH", "ignored")).toBeNull();
      expect(validator("CARD", "1234")).toBe("1234");
      expect(() => validator("CARD", "CARD-1234")).toThrow();
      expect(() => validator("CARD", "123")).toThrow();
      expect(validator("TRANSFER", " TRX-1 ")).toBe("TRX-1");
      expect(() => validator("WALLET", " ")).toThrow();
    }
  });

  it("keeps salary payment source keys unique across returns and payroll revisions", () => {
    expect(payrollSalaryPaymentSourceKey(7, 19, 0)).toBe("PAYROLL:7:19");
    expect(payrollSalaryPaymentSourceKey(7, 19, 1)).toBe("PAYROLL:7:19:r1");
    expect(payrollSalaryPaymentSourceKey(7, 19, 2)).toBe("PAYROLL:7:19:r2");
  });
});
