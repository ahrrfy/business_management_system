import { describe, expect, it } from "vitest";
import {
  assertPaymentTotals,
  assertSupplierInvoicePayable,
  assertSupplierPaymentTreasuryDecisionAuthority,
  SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
} from "../purchase/supplierPayments";

describe("supplier invoice payment S6 contracts", () => {
  it("accepts only POSTED OPEN AP invoices", () => {
    expect(() => assertSupplierInvoicePayable({ status: "POSTED", paymentGate: "OPEN", liabilityClass: "NATIVE_AP" })).not.toThrow();
    expect(() => assertSupplierInvoicePayable({ status: "POSTED", paymentGate: "OPEN", liabilityClass: "LEGACY_CASH_CLEARING" })).toThrow(/CASH_CLEARING/);
    expect(() => assertSupplierInvoicePayable({ status: "MATCHED", paymentGate: "OPEN", liabilityClass: "NATIVE_AP" })).toThrow(/POSTED/);
    expect(() => assertSupplierInvoicePayable({ status: "POSTED", paymentGate: "OPEN", liabilityClass: "LEGACY_AP", legacySettlementEvidenceHash: null })).toThrow(/دليل تسوية/);
  });

  it("requires atomic allocations to equal both payment totals", () => {
    expect(() => assertPaymentTotals("100.00", "2.00", [{ amount: "40", currencyAmount: "0.8" }, { amount: "60", currencyAmount: "1.2" }])).not.toThrow();
    expect(() => assertPaymentTotals("100.00", "2.00", [{ amount: "99", currencyAmount: "2" }])).toThrow(/مجموع تخصيصات/);
  });

  it("يحصر قرار السداد والاسترداد بالخزينة حتى لو كان الفاعل مسؤول مشتريات", () => {
    expect(() =>
      assertSupplierPaymentTreasuryDecisionAuthority({
        userId: 7,
        branchId: 1,
        role: "purchasing",
      }),
    ).toThrow(/الخزينة الكاملة/);
    for (const role of ["admin", "manager", "accountant"] as const) {
      expect(() =>
        assertSupplierPaymentTreasuryDecisionAuthority({
          userId: 8,
          branchId: 1,
          role,
        }),
      ).not.toThrow();
    }
    expect(() =>
      assertSupplierPaymentTreasuryDecisionAuthority(
        { userId: 9, branchId: 1, role: "purchasing" },
        SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
      ),
    ).not.toThrow();
  });
});
