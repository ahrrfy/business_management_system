import { describe, expect, it } from "vitest";
import {
  buildCashRemediationExportRows,
  buildCashRemediationPrintInput,
  cashRemediationScopeFingerprint,
} from "./CashRemediation";
import type { CashRemediationReport } from "../../../server/services/cashRemediation/types";

const report = {
  mode: "DRY_RUN_READ_ONLY",
  generatedAt: "2026-02-02T00:00:00.000Z",
  filters: { from: "2026-02-01", to: "2026-02-01" },
  safeguards: {
    mutationsAvailable: false,
    postedDocuments: 0,
    postedLedgerEntries: 0,
    sourceRowsChanged: 0,
  },
  summary: {
    shiftCount: 1,
    negativeShiftCount: 1,
    outflowCount: 1,
    unresolvedCount: 0,
    beforeExpectedCash: "-50.00",
    afterExpectedCash: "100.00",
    drawerDelta: "150.00",
    treasuryDelta: "-150.00",
    employeePayableDelta: "0.00",
    expenseDelta: "0.00",
  },
  shifts: [
    {
      shift: {
        id: 11,
        branchId: 1,
        branchName: "الرئيسي",
        userId: 7,
        userName: "تغريد",
        shiftType: "RETAIL",
        status: "CLOSED",
        openedAt: "2026-02-01T08:00:00.000Z",
        closedAt: "2026-02-01T16:00:00.000Z",
      },
      firstNegative: { point: "RECEIPT", receiptId: 22, occurredAt: "2026-02-01T10:00:00.000Z", balance: "-50.00" },
      before: {
        openingBalance: "100.00",
        computedExpectedCash: "-50.00",
        storedExpectedCash: "-50.00",
        countedCash: "100.00",
        computedVariance: "150.00",
        storedVariance: "150.00",
      },
      afterSimulation: {
        expectedCash: "100.00",
        variance: "0.00",
        drawerDelta: "150.00",
        treasuryDelta: "-150.00",
        employeePayableDelta: "0.00",
        expenseDelta: "0.00",
      },
      outflows: [
        {
          receiptId: 22,
          shiftId: 11,
          createdAt: "2026-02-01T10:00:00.000Z",
          amount: "150.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          description: "صرف نقل",
          actorId: 7,
          actorName: "تغريد",
          counterpartyName: "شركة نقل",
          source: {
            documentType: "EXPENSE",
            documentId: 31,
            expenseId: 31,
            expenseIds: [31],
            invoiceId: null,
            workOrderId: null,
            reservationId: null,
            voucherNumber: null,
            referenceNumber: null,
            ledgerEntryIds: [41],
            ledgerEntryTypes: ["PAYMENT_OUT"],
          },
          affectsDrawer: true,
          excludedClosingHandover: false,
          pairedTreasuryReceiptId: null,
          pairedTreasuryReceiptStatus: null,
          pairedTreasuryApprovalStatus: null,
          runningBalanceBefore: "100.00",
          runningBalanceAfter: "-50.00",
          suggestedClassification: "MISSING_INTERNAL_TRANSFER",
          confidence: "LOW",
          rationale: "فرضية",
          evidenceMissing: ["PAYMENT_PROOF", "MANAGER_DECISION"],
          duplicateOfReceiptId: null,
          simulation: {
            selectedClassification: "TREASURY_PAID",
            drawerDelta: "150.00",
            treasuryDelta: "-150.00",
            employeePayableDelta: "0.00",
            expenseDelta: "0.00",
          },
        },
      ],
    },
  ],
} satisfies CashRemediationReport;

describe("CashRemediation draft output", () => {
  it("يُوسم التصدير والطباعة صراحةً كمسودة بلا ترحيل", () => {
    const rows = buildCashRemediationExportRows(report);
    expect(rows[0]).toMatchObject({
      shift: "#11",
      employee: "تغريد",
      receipt: "#22",
      simulation: "دفع فعلي من الخزينة",
    });
    expect(rows[0].draftStatus).toMatch(/بلا ترحيل/);
    expect(rows[0]).toMatchObject({
      drawerDelta: "150.00",
      treasuryDelta: "-150.00",
      employeePayableDelta: "0.00",
      expenseDelta: "0.00",
    });

    const print = buildCashRemediationPrintInput(report);
    expect(print.title).toMatch(/مسودة/);
    expect(print.note).toMatch(/لا تنشئ إيصالاً أو قيداً/);
    expect(print.columns.map((column) => column.key)).toContain("simulationEffect");
    expect(print.columns.map((column) => column.key)).toContain("rationale");
    expect(print.headerExtra).toContainEqual({ label: "الوضع", value: "DRY-RUN للقراءة فقط" });
  });

  it("يضمّن كل معرّفات المصروفات المتعارضة في التصدير والطباعة", () => {
    const multiExpense = structuredClone(report) as CashRemediationReport;
    multiExpense.shifts[0].outflows[0].source.expenseIds = [31, 32];
    const rows = buildCashRemediationExportRows(multiExpense);
    expect(rows[0].source).toBe("EXPENSE 31، 32");
    const print = buildCashRemediationPrintInput(multiExpense);
    expect(print.rows[0].source).toBe("EXPENSE 31، 32");
    expect(print.rows[0].rationale).toBe("فرضية");
  });

  it("تتغير بصمة النطاق عند أي مرشح فلا تعبر اختيارات قديمة", () => {
    const base = {
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: "1",
      shiftIds: "11، 12",
      userIds: "7",
    };
    const fingerprint = cashRemediationScopeFingerprint(base);
    expect(cashRemediationScopeFingerprint({ ...base, to: "2026-03-01" })).not.toBe(fingerprint);
    expect(cashRemediationScopeFingerprint({ ...base, branchId: "2" })).not.toBe(fingerprint);
    expect(cashRemediationScopeFingerprint({ ...base, shiftIds: "11" })).not.toBe(fingerprint);
    expect(cashRemediationScopeFingerprint({ ...base, userIds: "8" })).not.toBe(fingerprint);
  });
});
