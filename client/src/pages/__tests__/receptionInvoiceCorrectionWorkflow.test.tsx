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
    expect(workflow).toContain('type Section = "dispatch" | "collect" | "edit" | "return"');
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
    expect(lookup).toContain('actor.role === "admin" ? undefined : eq(invoices.branchId, actor.branchId)');
    expect(correct).toContain("assertInvoiceReversalDeliverySafeTx");
    expect(correct).toContain("assertNoActiveInstallmentPlanAfterInvoiceLockTx");
  });
});
