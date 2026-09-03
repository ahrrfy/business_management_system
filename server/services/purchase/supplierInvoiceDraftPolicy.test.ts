import { describe, expect, it } from "vitest";
import {
  buildSupplierInvoiceDraftDocument,
  buildSupplierInvoiceDraftRequestHash,
} from "./supplierInvoiceDraftPolicy";
import { assertAgreedRateAmount } from "./supplierPayments";

const base = {
  externalInvoiceNumber: " SUP- 100 ",
  invoiceDate: "2026-08-31",
  dueDate: null,
  taxAmount: "0",
  discountAmount: "50.00",
  evidenceType: "PDF" as const,
  evidenceReference: "sha256:document",
  lines: [
    {
      purchaseOrderRevisionItemId: 41,
      description: "ورق",
      invoicedBaseQuantity: 10,
      unitPrice: "100.00",
    },
  ],
};

describe("سياسة مراجعة مسودة فاتورة المورد", () => {
  it("تبني لقطة مالية حتمية وبصمة تشمل السطور والدليل", () => {
    const first = buildSupplierInvoiceDraftDocument(
      { supplierId: 7, branchId: 2, currency: "IQD" },
      base,
    );
    const second = buildSupplierInvoiceDraftDocument(
      { supplierId: 7, branchId: 2, currency: "IQD" },
      { ...base, externalInvoiceNumber: "SUP- 100" },
    );
    expect(first.total.toFixed(2)).toBe("950.00");
    expect(first.payloadHash).toBe(second.payloadHash);
    expect(first.canonical).toContain('"evidenceReference":"sha256:document"');
    expect(first.canonical).toContain('"purchaseOrderRevisionItemId":41');
  });

  it("يحفظ أربع منازل لسعر وحدة الدولار ويرفض تجاوزها", () => {
    const usd = buildSupplierInvoiceDraftDocument(
      { supplierId: 7, branchId: 2, currency: "USD" },
      { ...base, discountAmount: "0", agreedRate: "1450.0000", lines: [{ ...base.lines[0]!, unitPrice: "3.4566" }] },
    );
    expect(usd.lines[0]?.usdUnitPrice?.toFixed(4)).toBe("3.4566");
    expect(usd.total.toFixed(2)).toBe("50126.50");
    expect(() => buildSupplierInvoiceDraftDocument(
      { supplierId: 7, branchId: 2, currency: "USD" },
      { ...base, discountAmount: "0", agreedRate: "1450", lines: [{ ...base.lines[0]!, unitPrice: "3.45661" }] },
    )).toThrow(/4 منازل/);
  });

  it("يطبق رأس USD بعملة المستند ويغلق رصيدي IQD وUSD معاً", () => {
    const usd = buildSupplierInvoiceDraftDocument(
      { supplierId: 7, branchId: 2, currency: "USD" },
      {
        ...base,
        agreedRate: "1300.0000",
        discountAmount: "10.00",
        lines: [{ ...base.lines[0]!, invoicedBaseQuantity: 1, unitPrice: "100.00" }],
      },
    );
    expect(usd.subtotal.toFixed(2)).toBe("130000.00");
    expect(usd.discount.toFixed(2)).toBe("13000.00");
    expect(usd.total.toFixed(2)).toBe("117000.00");
    expect(usd.usdTotal?.toFixed(2)).toBe("90.00");
    expect(usd.lines[0]?.usdTotal?.toFixed(2)).toBe("90.00");
    expect(() =>
      assertAgreedRateAmount(
        usd.total,
        usd.usdTotal!,
        usd.rate,
        "تسوية فاتورة المورد",
      ),
    ).not.toThrow();
    expect(() =>
      assertAgreedRateAmount("117000.00", "89.99", usd.rate, "تسوية فاتورة المورد"),
    ).toThrow(/لا يساوي/);
  });

  it("يقبل الضريبة ويظل يرفض التاريخ التالف والتكرار في بنود النسخة", () => {
    const taxed = buildSupplierInvoiceDraftDocument(
      { supplierId: 7, branchId: 2, currency: "IQD" },
      { ...base, taxAmount: "1.00" },
    );
    expect(taxed.tax.toFixed(2)).toBe("1.00");
    expect(taxed.total.toFixed(2)).toBe("951.00");
    expect(() => buildSupplierInvoiceDraftDocument(
      { supplierId: 7, branchId: 2, currency: "IQD" },
      { ...base, invoiceDate: "2026-02-30" },
    )).toThrow(/تاريخ/);
    expect(() => buildSupplierInvoiceDraftDocument(
      { supplierId: 7, branchId: 2, currency: "IQD" },
      { ...base, lines: [base.lines[0]!, base.lines[0]!] },
    )).toThrow(/مكررة/);
  });

  it("تفصل بصمة طلب التعديل عن الإلغاء وعن نسخة الأساس", () => {
    const update = buildSupplierInvoiceDraftRequestHash({
      action: "UPDATE_DRAFT",
      supplierInvoiceId: 5,
      expectedVersion: 1,
      reason: "تصحيح رقم المستند",
      document: base,
    });
    const voided = buildSupplierInvoiceDraftRequestHash({
      action: "VOID_DRAFT",
      supplierInvoiceId: 5,
      expectedVersion: 1,
      reason: "تصحيح رقم المستند",
    });
    const nextVersion = buildSupplierInvoiceDraftRequestHash({
      action: "UPDATE_DRAFT",
      supplierInvoiceId: 5,
      expectedVersion: 2,
      reason: "تصحيح رقم المستند",
      document: base,
    });
    expect(update).not.toBe(voided);
    expect(update).not.toBe(nextVersion);
  });
});
