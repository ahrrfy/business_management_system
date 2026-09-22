import { describe, expect, it } from "vitest";
import { toFinancialReconciliationSummary } from "../reports/reconcileSummary";

describe("financial reconciliation mobile summary", () => {
  it("serializes counts and status without sensitive detail rows", () => {
    const summary = toFinancialReconciliationSummary({
      customers: [{
        entity: "customer",
        id: 91,
        expected: "999999.00",
        actual: "1.00",
        drift: "999998.00",
        note: "private-customer-note",
      }],
      suppliers: [],
      delivery: [{ entity: "deliveryParty", id: 7, expected: "80", actual: "20", drift: "60" }],
      inventory: [],
      ledger: [],
      onlineOrders: [],
      journalOrphans: [],
      unbilledGoodsReceipts: [],
      runAt: "2026-08-09T21:15:00.000Z",
    });

    expect(summary).toEqual({
      runAt: "2026-08-09T21:15:00.000Z",
      totalIssueCount: 2,
      balanced: false,
      sections: {
        customers: { issueCount: 1, balanced: false },
        suppliers: { issueCount: 0, balanced: true },
        delivery: { issueCount: 1, balanced: false },
        inventory: { issueCount: 0, balanced: true },
        ledger: { issueCount: 0, balanced: true },
        onlineOrders: { issueCount: 0, balanced: true },
        journalOrphans: { issueCount: 0, balanced: true },
      },
    });

    const serialized = JSON.stringify(summary);
    for (const forbidden of ["\"id\"", "expected", "actual", "drift", "note", "999999.00", "private-customer-note"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("reports a fully balanced empty snapshot explicitly", () => {
    const summary = toFinancialReconciliationSummary({
      customers: [],
      suppliers: [],
      delivery: [],
      inventory: [],
      ledger: [],
      onlineOrders: [],
      journalOrphans: [],
      unbilledGoodsReceipts: [],
      runAt: "2026-08-09T21:15:00.000Z",
    });

    expect(summary.totalIssueCount).toBe(0);
    expect(summary.balanced).toBe(true);
    expect(Object.values(summary.sections).every((section) => section.balanced)).toBe(true);
  });

  it("incorporates unbilledGoodsReceipts into suppliers axis for Android backward compatibility", () => {
    const summary = toFinancialReconciliationSummary({
      customers: [],
      suppliers: [],
      delivery: [],
      inventory: [],
      ledger: [],
      onlineOrders: [],
      journalOrphans: [],
      unbilledGoodsReceipts: [{
        entity: "goodsReceipt",
        id: 128,
        expected: "0.00",
        actual: "1155000.00",
        drift: "1155000.00",
        note: "إذن استلام مخزني غير مفوتر",
      }],
      runAt: "2026-09-02T10:00:00.000Z",
    });

    expect(summary.totalIssueCount).toBe(1);
    expect(summary.balanced).toBe(false);
    expect(summary.sections.suppliers.issueCount).toBe(1);
    expect(summary.sections.suppliers.balanced).toBe(false);
    // Strict 7-axes check for Android native
    expect(Object.keys(summary.sections)).toEqual([
      "customers",
      "suppliers",
      "delivery",
      "inventory",
      "ledger",
      "onlineOrders",
      "journalOrphans",
    ]);
  });
});
