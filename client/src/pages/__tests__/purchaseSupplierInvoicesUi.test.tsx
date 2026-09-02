import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../components/purchases/SupplierInvoicesWorkspace.tsx", import.meta.url),
  "utf8",
);

describe("واجهة فواتير المورد والمطابقة الثلاثية S4", () => {
  it("تحفظ مستند المورد بدليله ولقطة مراجعة أمر الشراء", () => {
    expect(source).toContain("supplierInvoices.create.useMutation");
    expect(source).toContain("purchaseOrderRevisionItemId");
    expect(source).toContain("externalInvoiceNumber: externalInvoiceNumber.trim()");
    expect(source).toContain("evidenceReference: evidenceReference.trim()");
    expect(source).toContain("clientRequestId: createKey.current");
  });

  it("تعرض PO وGRN والفاتورة جنباً إلى جنب وتمنع HOLD من طلب الترحيل", () => {
    expect(source).toContain("المطابقة الثلاثية");
    expect(source).toContain("فاتورة المورد / أمر الشراء");
    expect(source).toContain("إذن الاستلام للمقارنة");
    expect(source).toContain("supplierInvoices.runMatch.useMutation");
    expect(source).toContain('latestMatch.outcome !== "HOLD"');
    expect(source).toContain("priceTolerancePercent");
    expect(source).toContain("latestHoldCodes");
  });

  it("يفصل طلب الترحيل والعكس عن القرار المستقل", () => {
    expect(source).toContain("supplierInvoices.requestApproval.useMutation");
    expect(source).toContain("supplierInvoices.decideApproval.useMutation");
    expect(source).toContain('kind: requestKind');
    expect(source).toContain("منشئ الفاتورة أو طالب الترحيل لا يعتمد الطلب");
    expect(source).toContain("errorState={{ isError: invoices.isError");
  });

  it("يوفر مراجعات تعديل وإلغاء للمسودة مع النسخة والسبب", () => {
    expect(source).toContain("supplierInvoices.updateDraft.useMutation");
    expect(source).toContain("supplierInvoices.voidDraft.useMutation");
    expect(source).toContain("supplierInvoices.draftGovernance.useQuery");
    expect(source).toContain("expectedVersion: Number(detail.invoice.version)");
    expect(source).toContain("reason: editReason.trim()");
    expect(source).toContain("reason: voidReason.trim()");
    expect(source).toContain('draftGovernance.data?.state === "ACTIVE"');
  });

  it("يتيح إدخال ضريبة رأس فاتورة المورد في الإنشاء والتعديل", () => {
    expect(source).not.toContain("السياسة الحالية صفر");
    expect(source).not.toContain("الضريبة (صفر)");
    expect(source).toContain('<MoneyInput value={taxAmount} onChange={setTaxAmount} />');
    expect(source).toContain('<MoneyInput value={editTaxAmount} onChange={setEditTaxAmount} />');
  });
});
