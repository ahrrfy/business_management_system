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
});
