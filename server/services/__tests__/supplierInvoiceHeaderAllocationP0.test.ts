import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  allocateSupplierInvoiceHeaderAmounts,
  buildSupplierInvoiceDraftDocument,
} from "../purchase/supplierInvoiceDraftPolicy";
import { allocateSupplierInvoiceLineNetAcrossMatches } from "../purchase/threeWayMatch";
import { assertSupplierInvoiceReversalDependenciesClear } from "../purchase/supplierInvoices";

describe("P0 — supplier invoice header allocation", () => {
  it("allocates tax and discount proportionally with deterministic cent remainders", () => {
    const allocated = allocateSupplierInvoiceHeaderAmounts(
      [
        { lineNo: 1, netAmount: "100.00" },
        { lineNo: 2, netAmount: "200.00" },
        { lineNo: 3, netAmount: "300.00" },
      ],
      "1.00",
      "10.00",
    );

    expect(
      allocated.map((line) => ({
        gross: line.grossNetAmount.toFixed(2),
        discount: line.discountAmount.toFixed(2),
        net: line.netAmount.toFixed(2),
        tax: line.taxAmount.toFixed(2),
        total: line.totalAmount.toFixed(2),
      })),
    ).toEqual([
      {
        gross: "100.00",
        discount: "1.67",
        net: "98.33",
        tax: "0.17",
        total: "98.50",
      },
      {
        gross: "200.00",
        discount: "3.33",
        net: "196.67",
        tax: "0.33",
        total: "197.00",
      },
      {
        gross: "300.00",
        discount: "5.00",
        net: "295.00",
        tax: "0.50",
        total: "295.50",
      },
    ]);
    expect(
      allocated
        .reduce((sum, line) => sum.plus(line.totalAmount), new Decimal(0))
        .toFixed(2),
    ).toBe("591.00");
  });

  it("uses line number as the stable tie-breaker independent of input order", () => {
    const allocated = allocateSupplierInvoiceHeaderAmounts(
      [
        { lineNo: 2, netAmount: "1.00" },
        { lineNo: 1, netAmount: "1.00" },
      ],
      "0.01",
      "0.00",
    );
    expect(
      allocated.find((line) => line.lineNo === 1)?.taxAmount.toFixed(2),
    ).toBe("0.01");
    expect(
      allocated.find((line) => line.lineNo === 2)?.taxAmount.toFixed(2),
    ).toBe("0.00");
  });

  it("persists discounted line net values in the draft builder so a full return equals the header", () => {
    const document = buildSupplierInvoiceDraftDocument(
      { supplierId: 7, branchId: 2, currency: "IQD" },
      {
        externalInvoiceNumber: "SUP-77",
        invoiceDate: "2026-08-31",
        taxAmount: "0.00",
        discountAmount: "0.01",
        evidenceType: "PDF",
        evidenceReference: "evidence://sup-77",
        lines: [
          {
            purchaseOrderRevisionItemId: 11,
            description: "أ",
            invoicedBaseQuantity: 1,
            unitPrice: "1.00",
          },
          {
            purchaseOrderRevisionItemId: 12,
            description: "ب",
            invoicedBaseQuantity: 1,
            unitPrice: "1.00",
          },
        ],
      },
    );
    const fullReturn = document.lines.reduce(
      (sum, line) => sum.plus(line.netAmount).plus(line.taxAmount),
      new Decimal(0),
    );
    expect(document.total.toFixed(2)).toBe("1.99");
    expect(fullReturn.toFixed(2)).toBe(document.total.toFixed(2));
    expect(document.lines.map((line) => line.totalAmount.toFixed(2))).toEqual([
      "0.99",
      "1.00",
    ]);
  });

  it("accepts and persists a non-zero header tax through the real draft builder", () => {
    const document = buildSupplierInvoiceDraftDocument(
      { supplierId: 7, branchId: 2, currency: "IQD" },
      {
        externalInvoiceNumber: "SUP-TAX-1",
        invoiceDate: "2026-08-31",
        taxAmount: "10.00",
        discountAmount: "5.00",
        evidenceType: "PDF",
        evidenceReference: "evidence://sup-tax-1",
        lines: [{ purchaseOrderRevisionItemId: 31, description: "خاضع", invoicedBaseQuantity: 1, unitPrice: "100.00" }],
      },
    );
    expect(document.tax.toFixed(2)).toBe("10.00");
    expect(document.discount.toFixed(2)).toBe("5.00");
    expect(document.lines[0]!.totalAmount.toFixed(2)).toBe("105.00");
    expect(document.total.toFixed(2)).toBe("105.00");
  });

  it("allocates a fully matched discounted line exactly across multiple receipts", () => {
    const amounts = allocateSupplierInvoiceLineNetAcrossMatches({
      lineNetAmount: "98.33",
      invoicedBaseQuantity: 3,
      matches: [
        { matchedBaseQuantity: 1, stableKey: 20 },
        { matchedBaseQuantity: 2, stableKey: 10 },
      ],
    });
    expect(amounts.map((amount) => amount.toFixed(2))).toEqual([
      "32.78",
      "65.55",
    ]);
    expect(
      amounts
        .reduce((sum, amount) => sum.plus(amount), new Decimal(0))
        .toFixed(2),
    ).toBe("98.33");
  });
});

describe("P1 — supplier invoice reversal dependency guards", () => {
  it("allows reversal only after payment allocations and returns are fully reversed", () => {
    expect(() =>
      assertSupplierInvoiceReversalDependenciesClear({
        paymentAllocations: [
          { allocatedAmount: "100.00", refundedAmount: "100.00" },
        ],
        purchaseReturns: [
          { id: 9, totalAmount: "30.00", reversalAmounts: ["10.00", "20.00"] },
        ],
      }),
    ).not.toThrow();
  });

  it("blocks a positive net payment allocation", () => {
    expect(() =>
      assertSupplierInvoiceReversalDependenciesClear({
        paymentAllocations: [
          { allocatedAmount: "100.00", refundedAmount: "99.99" },
        ],
        purchaseReturns: [],
      }),
    ).toThrow("تخصيص سداد صافٍ");
  });

  it("blocks a purchase return that is not fully reversed", () => {
    expect(() =>
      assertSupplierInvoiceReversalDependenciesClear({
        paymentAllocations: [],
        purchaseReturns: [
          { id: 9, totalAmount: "30.00", reversalAmounts: ["29.99"] },
        ],
      }),
    ).toThrow("مرتجع شراء غير معكوس بالكامل");
  });

  it("uses invoice-specific settlement dependencies, never generic supplier journal entries", () => {
    const invoiceSource = readFileSync(
      "server/services/purchase/supplierInvoices.ts",
      "utf8",
    );
    const revisionSource = readFileSync(
      "server/services/purchase/supplierInvoiceRevisions.ts",
      "utf8",
    );
    expect(invoiceSource).not.toContain("accountingEntries");
    expect(invoiceSource).toContain(".from(supplierPaymentAllocations)");
    expect(invoiceSource).toContain(".from(purchaseReturns)");
    expect(invoiceSource).toContain(".from(purchaseReturnReversals)");
    expect(revisionSource).toContain("taxAmount: toDbMoney(line.taxAmount)");
    expect(revisionSource).toContain(
      "totalAmount: toDbMoney(line.totalAmount)",
    );
  });
});
