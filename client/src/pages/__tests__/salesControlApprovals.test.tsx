import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const server = (path: string) => readFileSync(new URL(`../../../../server/${path}`, import.meta.url), "utf8");

describe("واجهة حوكمة عمليات البيع الحرجة", () => {
  it("الإلغاء والمرتجع وإعادة الإصدار ترسل طلباً ولا تدّعي تنفيذ الأثر", () => {
    const invoice = page("InvoiceDetail.tsx");
    const reissue = page("SalesInvoiceNew.tsx");
    const returns = readFileSync(new URL(`../../components/returns/ReturnComposer.tsx`, import.meta.url), "utf8");
    expect(invoice).toContain("أُرسل طلب الإلغاء");
    expect(invoice).toContain("لم يتغير المخزون أو المال بعد");
    expect(invoice).not.toContain("أُلغيت الفاتورة ${r.invoiceNumber}");
    expect(reissue).toContain("أُرسل طلب إعادة الإصدار");
    expect(reissue).toContain("requestExchange");
    expect(reissue).toContain("إرسال طلب الاستبدال");
    expect(reissue).toContain("لم تتغيّر الفاتورة أو المخزون أو المال بعد");
    expect(returns).toContain("إرسال طلب المرتجع");
    expect(returns).toContain("utils.salesControl.list.invalidate");
  });

  it("طابور الاعتماد يبرز السبب والبصمة وفصل المهام", () => {
    const approvals = page("SalesControlApprovals.tsx");
    expect(approvals).toContain("SALES_CONTROL_TYPE_LABELS");
    expect(approvals).toContain("request.payloadHash.slice(0, 12)");
    expect(approvals).toContain("لا يمكن للطالب أو منشئ الفاتورة اعتمادها");
    expect(approvals).toContain("canReview ? { status: \"PENDING\" } : { mine: true }");
    expect(approvals).toContain("SALES_CONTROL_STATUS_LABELS");
    expect(approvals).toContain("SALES_DUE_DATE_CHANGE");
    expect(approvals).toContain("تاريخ الاستحقاق المطلوب");
    expect(approvals).toContain("اعتماد وتنفيذ");
    expect(approvals).toContain("رفض طلب البيع");
  });

  it("الراوترات العامة لا تستدعي cancelSale/correctSale/returnSale مباشرة", () => {
    const saleRouter = server("routers/saleRouter.ts");
    const returnRouter = server("routers/returnRouter.ts");
    expect(saleRouter).toContain("requestSalesControl");
    expect(saleRouter).not.toMatch(/await\s+cancelSale\s*\(/);
    expect(saleRouter).not.toMatch(/await\s+correctSale\s*\(/);
    expect(returnRouter).not.toMatch(/await\s+returnSale\s*\(/);
  });

  it("تاريخ الاستحقاق يمر بطلب مستقل وتطابق صلاحية واجهة التصحيح الخادم", () => {
    const invoice = page("InvoiceDetail.tsx");
    const saleRouter = server("routers/saleRouter.ts");
    const controlService = server("services/sale/controlRequests.ts");
    const notesOnlyRoute = saleRouter.slice(
      saleRouter.indexOf("correct: salesManagerProcedure"),
      saleRouter.indexOf("reissue: salesCashierProcedure"),
    );
    const correctionGate = invoice.slice(
      invoice.indexOf("const canCorrectInvoice"),
      invoice.indexOf("const corrections"),
    );
    expect(invoice).toContain("salesControl.requestDueDateChange.useMutation");
    expect(correctionGate).toContain("moduleAccessAllowed(");
    expect(correctionGate).toContain('["manager"]');
    expect(correctionGate).not.toContain('me.data.role === "admin"');
    expect(notesOnlyRoute).not.toContain("dueDate:");
    expect(notesOnlyRoute).toContain("SALES_DUE_DATE_CHANGE");
    expect(controlService).toContain('request.requestType === "SALES_DUE_DATE_CHANGE"');
    expect(controlService).toContain("await assertPeriodOpen(tx, lockedInvoice.invoiceDate)");
    expect(controlService).toContain("assertLockedInvoiceControlSnapshotTx");
  });
});
