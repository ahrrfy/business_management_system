import { describe, expect, it } from "vitest";
import { analyzeCashRemediation } from "../classifier";
import { receiptStatusAffectsCash } from "../statusPolicy";
import type {
  CashRemediationFilters,
  RawCashRemediationDataset,
  RawRemediationReceipt,
  RawRemediationShift,
} from "../types";

const filters: CashRemediationFilters = {
  from: "2026-01-01",
  to: "2026-12-31",
};

function shift(overrides: Partial<RawRemediationShift> = {}): RawRemediationShift {
  return {
    id: 1,
    branchId: 1,
    branchName: "الرئيسي",
    userId: 7,
    userName: "تغريد",
    shiftType: "RETAIL",
    status: "CLOSED",
    openingBalance: "100.00",
    storedExpectedCash: "-50.00",
    countedCash: "100.00",
    storedVariance: "150.00",
    openedAt: new Date("2026-02-01T08:00:00.000Z"),
    closedAt: new Date("2026-02-01T16:00:00.000Z"),
    ...overrides,
  };
}

function receipt(id: number, overrides: Partial<RawRemediationReceipt> = {}): RawRemediationReceipt {
  return {
    id,
    shiftId: 1,
    branchId: 1,
    direction: "OUT",
    amount: "150.00",
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    referenceNumber: null,
    voucherNumber: null,
    invoiceId: null,
    workOrderId: null,
    reservationId: null,
    partyType: null,
    partyId: null,
    counterpartyName: null,
    description: "صرف تاريخي",
    attachmentUrl: null,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 7,
    createdByName: "تغريد",
    createdAt: new Date(`2026-02-01T0${id}:00:00.000Z`),
    expense: null,
    linkedExpenseIds: [],
    ledgerEntryIds: [],
    ledgerEntryTypes: [],
    pairedTreasuryReceiptId: null,
    pairedTreasuryReceiptStatus: null,
    pairedTreasuryApprovalStatus: null,
    ...overrides,
  };
}

describe("analyzeCashRemediation", () => {
  it("يوحّد أثر الحالات: COMPLETED وREVERSED فقط؛ PENDING وFAILED صفر", () => {
    expect(receiptStatusAffectsCash("COMPLETED")).toBe(true);
    expect(receiptStatusAffectsCash("REVERSED")).toBe(true);
    expect(receiptStatusAffectsCash("PENDING")).toBe(false);
    expect(receiptStatusAffectsCash("FAILED")).toBe(false);

    const dataset: RawCashRemediationDataset = {
      shifts: [shift({ openingBalance: "100.00", countedCash: "70.00" })],
      receipts: [
        receipt(1, { amount: "150.00", status: "PENDING" }),
        receipt(2, { amount: "150.00", status: "FAILED" }),
        receipt(3, { amount: "30.00", status: "REVERSED" }),
        receipt(4, { direction: "IN", amount: "500.00", status: "PENDING" }),
        receipt(5, { direction: "IN", amount: "500.00", status: "FAILED" }),
      ],
    };
    const report = analyzeCashRemediation(dataset, filters);
    const result = report.shifts[0];
    expect(result.before.computedExpectedCash).toBe("70.00");
    expect(result.firstNegative).toBeNull();
    expect(
      result.outflows.map((row) => ({
        id: row.receiptId,
        before: row.runningBalanceBefore,
        after: row.runningBalanceAfter,
        affects: row.affectsDrawer,
      })),
    ).toEqual([
      { id: 1, before: "100.00", after: "100.00", affects: false },
      { id: 2, before: "100.00", after: "100.00", affects: false },
      { id: 3, before: "100.00", after: "70.00", affects: true },
    ]);
    expect(() =>
      analyzeCashRemediation(dataset, {
        ...filters,
        simulations: [{ receiptId: 1, classification: "DUPLICATE_OR_ERROR" }],
      }),
    ).toThrow(/لا يقبل محاكاة تسوية/);
  });

  it("يحسب الرصيد الجاري وأول نقطة سالب ويعرض كل OUT ومصدره", () => {
    const dataset: RawCashRemediationDataset = {
      shifts: [shift()],
      receipts: [
        receipt(1, { direction: "IN", amount: "20.00" }),
        receipt(2, {
          amount: "150.00",
          expense: {
            id: 80,
            receiptId: 2,
            amount: "150.00",
            paymentMethod: "CASH",
            cashBucket: "DRAWER",
            status: "ACTIVE",
            category: "OTHER",
            description: "نقل",
            referenceNumber: "EXP-80",
            payee: "شركة نقل",
          },
          linkedExpenseIds: [80],
          ledgerEntryIds: [90],
          ledgerEntryTypes: ["PAYMENT_OUT"],
        }),
        receipt(3, { amount: "5.00", paymentMethod: "CARD", cashBucket: null }),
      ],
    };

    const report = analyzeCashRemediation(dataset, filters, new Date("2026-02-02T00:00:00Z"));
    const result = report.shifts[0];
    expect(result.before.computedExpectedCash).toBe("-30.00");
    expect(result.firstNegative).toEqual({
      point: "RECEIPT",
      receiptId: 2,
      occurredAt: "2026-02-01T02:00:00.000Z",
      balance: "-30.00",
    });
    expect(result.outflows.map((row) => row.receiptId)).toEqual([2, 3]);
    expect(result.outflows[0].source).toMatchObject({
      documentType: "EXPENSE",
      documentId: 80,
      ledgerEntryIds: [90],
    });
    expect(result.outflows[0].suggestedClassification).toBe("MISSING_INTERNAL_TRANSFER");
    expect(result.outflows[0].confidence).toBe("LOW");
    expect(result.outflows[0].evidenceMissing).toContain("TREASURY_HANDOVER_OR_FUNDING_PROOF");
    expect(report.safeguards).toEqual({
      mutationsAvailable: false,
      postedDocuments: 0,
      postedLedgerEntries: 0,
      sourceRowsChanged: 0,
    });
  });

  it("يسجل الرصيد الافتتاحي نفسه كأول نقطة سالب", () => {
    const report = analyzeCashRemediation(
      {
        shifts: [shift({ openingBalance: "-25.00", countedCash: "0.00" })],
        receipts: [],
      },
      filters,
    );
    expect(report.shifts[0].firstNegative).toEqual({
      point: "OPENING",
      receiptId: null,
      occurredAt: "2026-02-01T08:00:00.000Z",
      balance: "-25.00",
    });
    expect(report.summary.negativeShiftCount).toBe(1);
  });

  it("يستبعد CH المثبت من الجاري ويبقي CD المثبت خارجاً من الدرج", () => {
    const report = analyzeCashRemediation(
      {
        shifts: [shift({ openingBalance: "200.00", countedCash: "140.00" })],
        receipts: [
          receipt(1, {
            amount: "200.00",
            referenceNumber: "CH-1-20260201-1",
            pairedTreasuryReceiptId: 101,
            pairedTreasuryReceiptStatus: "COMPLETED",
            pairedTreasuryApprovalStatus: "APPROVED",
            ledgerEntryIds: [501],
            ledgerEntryTypes: ["CASH_HANDOVER"],
          }),
          receipt(2, {
            amount: "60.00",
            referenceNumber: "CD-1-20260201-1",
            pairedTreasuryReceiptId: 102,
            pairedTreasuryReceiptStatus: "PENDING",
            pairedTreasuryApprovalStatus: "APPROVED",
          }),
        ],
      },
      filters,
    );

    const result = report.shifts[0];
    expect(result.before.computedExpectedCash).toBe("140.00");
    expect(result.firstNegative).toBeNull();
    expect(result.outflows[0]).toMatchObject({
      excludedClosingHandover: true,
      affectsDrawer: false,
      suggestedClassification: "VERIFIED_INTERNAL_TRANSFER",
    });
    expect(result.outflows[1]).toMatchObject({
      excludedClosingHandover: false,
      affectsDrawer: true,
      suggestedClassification: "UNVERIFIED_INTERNAL_TRANSFER",
      confidence: "LOW",
    });
    expect(result.outflows[1].evidenceMissing).toContain("TREASURY_HANDOVER_OR_FUNDING_PROOF");
  });

  it("لا يسمي تحويل الخزينة مثبتاً إذا غاب CASH_HANDOVER رغم اكتمال الزوج واعتماده", () => {
    const report = analyzeCashRemediation(
      {
        shifts: [shift({ openingBalance: "200.00" })],
        receipts: [
          receipt(1, {
            amount: "50.00",
            referenceNumber: "CH-1-20260201-2",
            pairedTreasuryReceiptId: 101,
            pairedTreasuryReceiptStatus: "COMPLETED",
            pairedTreasuryApprovalStatus: "APPROVED",
          }),
        ],
      },
      filters,
    );
    expect(report.shifts[0].outflows[0]).toMatchObject({
      suggestedClassification: "UNVERIFIED_INTERNAL_TRANSFER",
      confidence: "LOW",
    });
    expect(report.shifts[0].outflows[0].evidenceMissing).toContain("LEDGER_ENTRY");
  });

  it("يتعرف إلى إلغاء المصروف المتصافر ولا يسمح بعكسه مرة ثانية", () => {
    const cancelledExpense = {
      id: 80,
      receiptId: 1,
      amount: "50.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER" as const,
      status: "CANCELLED" as const,
      category: "OTHER",
      description: "ملغى",
      referenceNumber: null,
      payee: "طرف",
    };
    const dataset = {
      shifts: [shift()],
      receipts: [
        receipt(1, {
          amount: "50.00",
          status: "REVERSED",
          expense: cancelledExpense,
          linkedExpenseIds: [80],
          ledgerEntryIds: [90],
          ledgerEntryTypes: ["PAYMENT_OUT"],
        }),
        receipt(2, {
          direction: "IN" as const,
          amount: "50.00",
          referenceNumber: "CANCEL-EXP-80",
          ledgerEntryIds: [91],
          ledgerEntryTypes: ["PAYMENT_IN"],
        }),
      ],
    };
    const report = analyzeCashRemediation(dataset, filters);
    expect(report.shifts[0].before.computedExpectedCash).toBe("100.00");
    expect(report.shifts[0].outflows[0]).toMatchObject({
      suggestedClassification: "VERIFIED_REVERSAL",
      confidence: "HIGH",
      evidenceMissing: [],
    });
    expect(() =>
      analyzeCashRemediation(dataset, {
        ...filters,
        simulations: [{ receiptId: 1, classification: "DUPLICATE_OR_ERROR" }],
      }),
    ).toThrow(/لا يقبل محاكاة تسوية/);

    const incomplete = analyzeCashRemediation(
      {
        ...dataset,
        receipts: [
          dataset.receipts[0],
          {
            ...dataset.receipts[1],
            status: "FAILED",
            ledgerEntryIds: [],
            ledgerEntryTypes: [],
          },
        ],
      },
      filters,
    );
    expect(incomplete.shifts[0].outflows[0]).toMatchObject({
      suggestedClassification: "UNVERIFIED_REVERSAL",
      confidence: "LOW",
    });
    expect(incomplete.shifts[0].outflows[0].evidenceMissing).toEqual(
      expect.arrayContaining(["PAYMENT_PROOF", "MANAGER_DECISION", "LEDGER_ENTRY"]),
    );
  });

  it("يعرض before/after لمحاكاة الدفع الشخصي بلا ترحيل", () => {
    const report = analyzeCashRemediation(
      { shifts: [shift()], receipts: [receipt(2)] },
      {
        ...filters,
        simulations: [{ receiptId: 2, classification: "EMPLOYEE_PERSONAL_PAID" }],
      },
    );
    expect(report.shifts[0].before.computedExpectedCash).toBe("-50.00");
    expect(report.shifts[0].afterSimulation).toMatchObject({
      expectedCash: "100.00",
      drawerDelta: "150.00",
      treasuryDelta: "0.00",
      employeePayableDelta: "150.00",
      expenseDelta: "0.00",
    });
    expect(report.summary.afterExpectedCash).toBe("100.00");
    expect(report.safeguards.postedDocuments).toBe(0);
  });

  it("يصنف المصدر المكرر ولا يسمح بمحاكاة إيصال خارج النطاق", () => {
    const duplicatedExpense = {
      id: 80,
      receiptId: 2,
      amount: "10.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER" as const,
      status: "ACTIVE" as const,
      category: "OTHER",
      description: "نقل",
      referenceNumber: "EXP-80",
      payee: "شركة نقل",
    };
    const report = analyzeCashRemediation(
      {
        shifts: [shift({ openingBalance: "100.00" })],
        receipts: [
          receipt(1, {
            amount: "10.00",
            expense: { ...duplicatedExpense, receiptId: 1 },
          }),
          receipt(2, {
            amount: "10.00",
            expense: duplicatedExpense,
            linkedExpenseIds: [80],
          }),
        ],
      },
      filters,
    );
    expect(report.shifts[0].outflows[1]).toMatchObject({
      suggestedClassification: "DUPLICATE_OR_ERROR",
      confidence: "HIGH",
      duplicateOfReceiptId: 1,
    });
    expect(() =>
      analyzeCashRemediation(
        { shifts: [shift()], receipts: [receipt(1)] },
        {
          ...filters,
          simulations: [{ receiptId: 999, classification: "TREASURY_PAID" }],
        },
      ),
    ).toThrow(/ليس حركة OUT ضمن نطاق التقرير/);
    expect(() =>
      analyzeCashRemediation(
        {
          shifts: [shift()],
          receipts: [receipt(1, { paymentMethod: "CARD", cashBucket: null })],
        },
        {
          ...filters,
          simulations: [{ receiptId: 1, classification: "TREASURY_PAID" }],
        },
      ),
    ).toThrow(/لا يقبل محاكاة تسوية/);

    const conflictingSources = analyzeCashRemediation(
      {
        shifts: [shift()],
        receipts: [
          receipt(3, {
            amount: "10.00",
            expense: { ...duplicatedExpense, receiptId: 3 },
            linkedExpenseIds: [80, 81],
          }),
        ],
      },
      filters,
    );
    expect(conflictingSources.shifts[0].outflows[0]).toMatchObject({
      suggestedClassification: "DUPLICATE_OR_ERROR",
      confidence: "HIGH",
    });
    expect(conflictingSources.shifts[0].outflows[0].source.expenseIds).toEqual([80, 81]);
    expect(() =>
      analyzeCashRemediation(
        {
          shifts: [shift()],
          receipts: [
            receipt(3, {
              amount: "10.00",
              expense: { ...duplicatedExpense, receiptId: 3 },
              linkedExpenseIds: [80, 81],
            }),
          ],
        },
        {
          ...filters,
          simulations: [{ receiptId: 3, classification: "DUPLICATE_OR_ERROR" }],
        },
      ),
    ).toThrow(/لا يقبل محاكاة تسوية/);
  });
});
