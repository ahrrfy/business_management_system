import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/data-table/DataTable", () => ({
  DataTable: ({ columns, data }: any) => (
    <div>
      {data.map((item: any) => (
        <div key={item.supplierInvoiceId}>
          {columns.map((column: any) => (
            <span key={column.id}>
              {column.cell({ row: { original: item } })}
            </span>
          ))}
        </div>
      ))}
    </div>
  ),
}));
Object.assign(globalThis, { React });
import { SupplierVoucherSettlementSummary } from "./SupplierVoucherSettlementSummary";

describe("saved supplier voucher settlement summary", () => {
  const allocations = [
    {
      supplierInvoiceId: 7,
      invoiceNumber: "SUP-OLD",
      amount: "1200.25",
      invoiceDate: "2026-01-01",
    },
    {
      supplierInvoiceId: 8,
      invoiceNumber: "SUP-NEW",
      amount: "0.10",
      invoiceDate: "2026-02-01",
    },
  ];
  it("shows saved invoice references, dates, exact amounts and execution status without edit controls", () => {
    const html = renderToStaticMarkup(
      <SupplierVoucherSettlementSummary
        settlement={{ status: "APPROVED", allocations }}
      />,
    );
    expect(html).toContain("SUP-OLD");
    expect(html).toContain("SUP-NEW");
    expect(html).toContain("2026-01-01");
    expect(html).toContain("2026-02-01");
    expect(html).toContain("1,200.25");
    expect(html).toContain("0.1");
    expect(html).toContain("معتمد ومصروف");
    expect(html).not.toMatch(/<(input|button|select)\b/);
  });
  it("labels a historical pending settlement as awaiting approval", () => {
    const html = renderToStaticMarkup(
      <SupplierVoucherSettlementSummary
        settlement={{ status: "PENDING", allocations }}
      />,
    );
    expect(html).toContain("بانتظار الاعتماد والصرف");
    expect(html).not.toContain("معتمد ومصروف");
  });
  it("renders nothing for vouchers without a saved supplier settlement", () => {
    expect(
      renderToStaticMarkup(
        <SupplierVoucherSettlementSummary settlement={null} />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <SupplierVoucherSettlementSummary settlement={undefined} />,
      ),
    ).toBe("");
  });
  it("shows BOOK invoice/opening targets and documentary credits without calling them native payments or tender", () => {
    const html = renderToStaticMarkup(
      <SupplierVoucherSettlementSummary
        settlement={null}
        bookSettlement={{
          kind: "BOOK",
          status: "PARTIALLY_REVERSED",
          accountingEntryId: 55,
          allocations: [
            {
              id: 1,
              targetKind: "INVOICE",
              openingEntryId: null,
              invoiceNumber: "USD-OLD",
              targetDate: "2026-01-01",
              amount: "1200.25",
              reversedAmount: "200.00",
              currency: "USD",
              currencyAmount: "0.80",
            },
            {
              id: 2,
              targetKind: "OPENING",
              openingEntryId: 21,
              invoiceNumber: null,
              targetDate: "2025-01-01",
              amount: "500.00",
              reversedAmount: "0.00",
              currency: null,
              currencyAmount: "0.00",
            },
          ],
          credits: [
            {
              id: 3,
              accountingEntryId: 88,
              invoiceNumber: "USD-OLD",
              invoiceDate: "2026-01-01",
              amount: "0.84",
              reversedAmount: "0.00",
              currency: "USD",
              currencyAmount: "0.00",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("USD-OLD");
    expect(html).toContain("رصيد افتتاحي #21");
    expect(html).toContain("1,200.25");
    expect(html).toContain("200");
    expect(html).toContain("عكس جزئي");
    expect(html).toContain("تخفيضات دفترية مستقلة");
    expect(html).toContain("0.84");
    expect(html).not.toContain("معتمد ومصروف");
    expect(html).not.toMatch(/<(input|button|select)\b/);
  });
});
