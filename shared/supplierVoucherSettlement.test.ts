import { describe, expect, it } from "vitest";
import {
  allocateSupplierVoucherFifo,
  validateSupplierVoucherAllocations,
} from "./supplierVoucherSettlement";

const invoices = [
  {
    id: 1,
    invoiceNumber: "NEW",
    invoiceDate: "2026-10-10",
    version: 1,
    remainingAmount: "60000.00",
  },
  {
    id: 2,
    invoiceNumber: "OLD",
    invoiceDate: "2026-09-01",
    version: 2,
    remainingAmount: "40000.00",
  },
];
describe("supplier voucher allocation contract", () => {
  it("pays the oldest invoice first and only part of the next", () => {
    expect(allocateSupplierVoucherFifo("50000", invoices)).toEqual([
      { supplierInvoiceId: 2, invoiceVersion: 2, amount: "40000.00" },
      { supplierInvoiceId: 1, invoiceVersion: 1, amount: "10000.00" },
    ]);
  });
  it("fully settles the exact outstanding amount", () => {
    const plan = allocateSupplierVoucherFifo("100000", invoices);
    expect(() =>
      validateSupplierVoucherAllocations("100000", invoices, plan),
    ).not.toThrow();
    expect(plan.map((row) => row.amount)).toEqual(["40000.00", "60000.00"]);
  });
  it("uses decimal cents and invoice id as a deterministic date tie-breaker", () => {
    const rows = [2, 1].map((id) => ({
      ...invoices[0],
      id,
      remainingAmount: "0.10",
    }));
    expect(allocateSupplierVoucherFifo("0.15", rows)).toEqual([
      { supplierInvoiceId: 1, invoiceVersion: 1, amount: "0.10" },
      { supplierInvoiceId: 2, invoiceVersion: 1, amount: "0.05" },
    ]);
  });
  it("allows an explicit distribution that differs from FIFO", () => {
    expect(() =>
      validateSupplierVoucherAllocations("20000", invoices, [
        { supplierInvoiceId: 1, invoiceVersion: 1, amount: "20000" },
      ]),
    ).not.toThrow();
  });
  it.each(["0", "-1", "NaN", "Infinity", "1.001", "100000.01"])(
    "rejects invalid or uncovered amount %s",
    (amount) => {
      expect(() => allocateSupplierVoucherFifo(amount, invoices)).toThrow();
    },
  );
  it.each([
    [{ supplierInvoiceId: 1, invoiceVersion: 1, amount: "19000" }],
    [{ supplierInvoiceId: 1, invoiceVersion: 2, amount: "20000" }],
    [{ supplierInvoiceId: 3, invoiceVersion: 1, amount: "20000" }],
    [
      { supplierInvoiceId: 1, invoiceVersion: 1, amount: "10000" },
      { supplierInvoiceId: 1, invoiceVersion: 1, amount: "10000" },
    ],
  ])("rejects invalid manual distribution %#", (...rows) => {
    expect(() =>
      validateSupplierVoucherAllocations("20000", invoices, rows),
    ).toThrow();
  });
});
