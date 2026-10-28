import { describe, expect, it } from "vitest";
import { balanceStatementRows, customerStatementLedger, statementClosingBalance } from "@/lib/statementPeriodLedger";

describe("statement period closing", () => {
  it("keeps a posted cancelled original with its dated reversal in the historical ledger", () => {
    const original = { invoiceDate: "2026-09-01", invoiceNumber: "CANCELLED-POSTED", status: "CANCELLED", total: "100", ledgerTotal: "100.00" };
    expect(customerStatementLedger({ summary: { openingBalance: "0" }, invoices: [original], payments: [] }).closingBalance).toBe("100.00");
    expect(customerStatementLedger({ summary: { openingBalance: "0" }, invoices: [original],
      payments: [{ createdAt: "2026-10-01", direction: "IN", amount: "100", paymentMethod: "RETURN" }] }).closingBalance).toBe("0.00");
  });
  it.each(["customer", "supplier"] as const)("keeps historical %s closing separate from live balance with only an end date", (kind) => {
    const rows = [{ t: 1, debit: kind === "customer" ? "50" : null, credit: kind === "supplier" ? "50" : null }];
    const ledger = balanceStatementRows(rows, "100", kind);
    expect(ledger.rows[0].balance).toBe("150.00");
    expect(statementClosingBalance("", "2026-09-30", ledger.closingBalance, "130.00")).toBe("150.00");
    expect(statementClosingBalance("2026-09-01", "", ledger.closingBalance, "130.00")).toBe("150.00");
    expect(statementClosingBalance("", "", ledger.closingBalance, "130.00")).toBe("130.00");
  });

  it("seeds imported customer opening without adding it to period debit/credit totals", () => {
    const result = customerStatementLedger({
      summary: { openingBalance: "100.10" },
      invoices: [{ invoiceDate: "2026-09-02", invoiceNumber: "INV-1", status: "PENDING", total: "50.20" }],
      payments: [{ createdAt: "2026-09-03", direction: "IN", amount: "20.30" }],
    });
    expect(result.txs.map((row) => row.balance)).toEqual(["150.30", "130.00"]);
    expect(result).toMatchObject({ totDebit: "50.20", totCredit: "20.30", closingBalance: "130.00" });
  });

  it("orders movements by actual dates, preserves adjustments/refunds and excludes cancelled sales", () => {
    const result = customerStatementLedger({
      summary: { openingBalance: "-10" },
      invoices: [
        { invoiceDate: "2026-10-02", invoiceNumber: "INV-2", status: "PENDING", total: "30" },
        { invoiceDate: "2026-09-01", invoiceNumber: "VOID", status: "CANCELLED", total: "999" },
      ],
      payments: [
        { createdAt: "2026-10-03", direction: "OUT", amount: "5", isStandalone: true },
        { createdAt: "2026-09-30", direction: "IN", amount: "2", paymentMethod: "OPENING_ADJ" },
      ],
    });
    expect(result.txs.map((row) => row.balance)).toEqual(["-12.00", "18.00", "23.00"]);
    expect(result.txs.map((row) => row.description)).toEqual(["تصحيح رصيد افتتاحي", "فاتورة مبيعات", "سند صرف مستقل"]);
    expect(result).toMatchObject({ totDebit: "35.00", totCredit: "2.00" });
  });

  it("keeps a corrected invoice and its noncash reversal together with the replacement", () => {
    const result = customerStatementLedger({
      summary: { openingBalance: "50.00" },
      invoices: [
        { invoiceDate: "2026-09-01", invoiceNumber: "ORIGINAL", status: "SUPERSEDED", total: "100" },
        { invoiceDate: "2026-09-03", invoiceNumber: "REPLACEMENT", status: "PENDING", total: "80" },
      ],
      payments: [{ createdAt: "2026-09-02", direction: "IN", amount: "100", paymentMethod: "INVOICE_ADJUSTMENT" }],
    });
    expect(result).toMatchObject({ closingBalance: "130.00", totDebit: "180.00", totCredit: "100.00" });
    expect(result.txs[1].description).toBe("تسوية ذمة الفاتورة دون حركة نقدية");
  });
});
