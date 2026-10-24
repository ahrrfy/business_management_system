import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readClient = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const readServer = (path: string) => readFileSync(new URL(`../../../../server/${path}`, import.meta.url), "utf8");

describe("مسار تعديل الفاتورة من الاستقبال", () => {
  it("يوفر اختصاراً ثم مسحاً دقيقاً وزراً كبيراً إلى محرر الفاتورة الأصلي", () => {
    const reception = readClient("pages/Reception.tsx");
    const workflow = readClient("pages/reception/ReceptionWorkflowPage.tsx");
    expect(reception).toContain('/reception/workflow?section=edit');
    expect(reception).toContain("تعديل فاتورة");
    for (const station of ["dispatch", "collect", "edit", "return", "cancelAssignment", "aftercare"]) expect(workflow).toContain(`"${station}"`);
    expect(workflow).toContain("lookupForCorrection.fetch");
    expect(workflow).toContain("امسح باركود الفاتورة للتعديل");
    expect(workflow).toContain("تعديل الفاتورة");
    expect(workflow).toContain("/correct?from=reception-edit");
  });

  it("مطابقة الخادم تامة ومعزولة بالفرع ومحرك الاعتماد يبقى السلطة النهائية", () => {
    const router = readServer("routers/saleRouter.ts");
    const lookup = readServer("services/sale/correctionLookup.ts");
    const correct = readServer("services/sale/correct.ts");
    expect(router).toContain("lookupForCorrection: salesCorrectionProcedure");
    expect(lookup).toContain("eq(invoices.invoiceNumber, number)");
    expect(lookup.replace(/\s+/g, " ")).toContain('actor.role === "admin" ? undefined : eq(invoices.branchId, actor.branchId)');
    expect(correct).toContain("assertInvoiceReversalDeliverySafeTx");
    expect(correct).toContain("assertNoActiveInstallmentPlanAfterInvoiceLockTx");
  });

  it("يراقب معاينة التعديل برقم المسح ومعاينة المرتجع بمعرفه دون إعادة ضبط مسودة المرتجع", () => {
    const workflow = readClient("pages/reception/ReceptionWorkflowPage.tsx");
    const returns = readClient("components/delivery/workflow/WorkflowLegacyReturnStation.tsx");
    expect(workflow).toContain("trpc.sales.lookupForCorrection.useQuery");
    expect(workflow).toContain("invoiceNumber: editInvoiceNumber");
    expect(workflow).toContain("setEditInvoiceNumber(invoiceNumber)");
    expect(workflow).toContain("const editScanned = editPreview.data");
    expect(returns).toContain("trpc.returns.getInvoice.useQuery");
    expect(returns).toContain('source?.kind === "invoice" ? source.id : 0');
    expect(returns).toContain("invoiceStatusLabel(invoice.data.status)");
    expect(returns).toContain("فاتورة بيع #{invoice.data.invoiceNumber}");
    expect(returns).toContain("invoiceId={source.id}");
    expect(workflow).not.toContain("delivery.returnByBarcode");
    expect(returns).not.toContain("delivery.returnByBarcode");
    expect(workflow).not.toContain("setEditScanned(invoice)");
    expect(workflow).not.toContain("invoiceStatusLabel(returnScanned.status)");
  });
});
