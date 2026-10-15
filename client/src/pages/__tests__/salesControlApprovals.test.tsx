import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const server = (path: string) => readFileSync(new URL(`../../../../server/${path}`, import.meta.url), "utf8");

describe("واجهة حوكمة عمليات البيع الحرجة", () => {
  it("الإلغاء يوضح التنفيذ المباشر أو طلب الاعتماد، وبقية المسارات لا تدّعي أثراً مبكراً", () => {
    const invoice = page("InvoiceDetail.tsx");
    const reissue = page("SalesInvoiceNew.tsx");
    const returns = readFileSync(new URL(`../../components/returns/ReturnComposer.tsx`, import.meta.url), "utf8");
    expect(invoice).toContain("أُرسل طلب الإلغاء");
    expect(invoice).toContain("لم يتغير المخزون أو المال بعد");
    expect(invoice).toContain("فسينفذ النظام الإلغاء فور التأكيد");
    expect(invoice).toContain("تأكيد الإلغاء");
    expect(invoice).not.toContain("أُلغيت الفاتورة ${r.invoiceNumber}");
    expect(reissue).toContain("أُرسل طلب إعادة الإصدار");
    expect(reissue).toContain("requestExchange");
    expect(reissue).toContain('primaryLabel={isCorrection ? "حفظ التعديل" : undefined}');
    expect(reissue).toContain("أُرسل طلب الاستبدال");
    expect(reissue).toContain("لم تتغيّر الفاتورة أو المخزون أو المال بعد");
    expect(returns).toContain("إرسال طلب المرتجع");
    expect(returns).toContain("invalidateFinancialQueries(queryClient, inv?.branchId)");
  });

  it("طابور الاعتماد يبرز السبب والبصمة وفصل المهام", () => {
    const approvals = page("SalesControlApprovals.tsx");
    expect(approvals).toContain("SALES_CONTROL_TYPE_LABELS");
    expect(approvals).toContain("request.payloadHash.slice(0, 12)");
    expect(approvals).toContain("لا يمكن للطالب أو منشئ الفاتورة اعتمادها");
    expect(approvals).toContain("canReview ? { status: \"PENDING\" } : { mine: true }");
    expect(approvals).toContain("SALES_CONTROL_STATUS_LABELS");
    expect(approvals).toContain('lifecycleActionAllowed(me.data, "salesControl.approve", legacyCanReview)');
    expect(approvals).toContain('lifecycleActionAllowed(me.data, "salesControl.reject", legacyCanReview)');
    expect(approvals).toContain('lifecycleActionAllowed(me.data, "salesControl.withdraw", !!me.data)');
    /**
     * حقائقُ الحمولة انتقلت إلى مصدرٍ مشترك (`shared/salesControlFacts.ts`) يعرضه الويب
     * ويُرسله الخادمُ لصندوق موافقات أندرويد — كان تعريفُها محلّياً هنا يعرض «مصير البضاعة»
     * معكوساً للزبون العابر، وكاد أندرويد يُعيد العطب من بابٍ ثانٍ (Codex على PR #932).
     * الحارسُ يتبع المصدر: الشاشةُ تُفوّض، والمصدرُ يعرف كلّ الأنواع.
     */
    expect(approvals).toContain("salesControlFacts");
    expect(approvals).toContain("@shared/salesControlFacts");
    const facts = readFileSync(new URL("../../../../shared/salesControlFacts.ts", import.meta.url), "utf8");
    expect(facts).toContain("SALES_DUE_DATE_CHANGE");
    expect(facts).toContain("تاريخ الاستحقاق المطلوب");
    // ومصيرُ البضاعة يُشتقّ من المصدرين معاً لا من `restock` وحده.
    expect(facts).toContain('resolution.disposition === "DAMAGED"');
    expect(approvals).toContain("اعتماد وتنفيذ");
    expect(approvals).toContain("رفض طلب البيع");
  });

  it("لا يعرض حقل وردية المرتجع إلا لرد CASH موجب فعلاً", () => {
    const approvals = page("SalesControlApprovals.tsx");
    expect(approvals).toContain('returnMoney?.method === "CASH"');
    expect(approvals).toContain('D(returnMoney.amount ?? "0").gt(0)');
    expect(approvals).toContain("canReview && (returnNeedsCashRouting || cancelNeedsCashRouting) && !reviewerConflict");
  });

  it("يتيح للمراجع اختيار درج ممول أو خزينة الفرع لإلغاء نقدي", () => {
    const approvals = page("SalesControlApprovals.tsx");
    expect(approvals).toContain('request.requestType === "SALES_CANCEL"');
    expect(approvals).toContain('refundPaymentMethod === "CASH"');
    expect(approvals).toContain('routingUseTreasury ? "TREASURY"');
    expect(approvals).toContain("خزينة الفرع");
  });

  it("يعرض تعديل الفاتورة كمقارنة كان/سيصبح ويطبع الحرارية وليبل الشحن بلا كتابة الرقم", () => {
    const approvals = page("SalesControlApprovals.tsx");
    const controlRouter = server("routers/salesControlRouter.ts");
    const correctionConfirm = approvals.slice(
      approvals.indexOf("async function approveOne"),
      approvals.indexOf("function beginRouting"),
    );
    expect(approvals).toContain("كان هكذا");
    expect(approvals).toContain("سيصبح هكذا");
    expect(approvals).toContain("buildSalesCorrectionComparison");
    expect(approvals).toContain("requestShippingLabelPrint");
    expect(approvals).toContain("طُبعت حرارياً تلقائياً");
    expect(approvals).toContain('{ openDrawer: false }');
    expect(approvals).toContain("trpc.invoicePrinting.requestPrint.useMutation()");
    expect(approvals).toContain("trpc.invoicePrinting.requestReprint.useMutation()");
    expect(approvals.indexOf('purpose: "THERMAL"')).toBeLessThan(approvals.indexOf("await printReceipt("));
    expect(approvals.indexOf('purpose: "SHIPPING_LABEL"')).toBeLessThan(approvals.indexOf("await printShippingLabel("));
    expect(correctionConfirm).toContain('type === "SALES_REISSUE" || type === "SALES_EXCHANGE"');
    expect(correctionConfirm).toContain('{ requireText: invoiceNumber }');
    expect(controlRouter).toContain("claimCorrectionPayment");
    expect(controlRouter).toContain("deviceId: z.string().trim().min(1).max(64)");
    expect(approvals).toContain("استُعيد حجز دفع سابق");
    expect(approvals).toContain("لا تمرّر المبلغ مرة ثانية");
    expect(approvals).toContain("recoveredClaimFor");
    expect(approvals).toContain("مرجع القسيمة الموجودة — لا تُعد الدفع");
    expect(approvals).toContain('requireText: "لم يتم الدفع"');
  });

  it("الإلغاء المباشر يمر بقرار تشغيلي وتتحول الاستثناءات إلى طلب اعتماد", () => {
    const saleRouter = server("routers/saleRouter.ts");
    const returnRouter = server("routers/returnRouter.ts");
    expect(saleRouter).toContain("requestSalesControl");
    expect(saleRouter).toContain("enforceOperationalDecision: true");
    expect(saleRouter).toContain("OperationalApprovalRequiredError");
    expect(saleRouter).toMatch(/await\s+cancelSale\s*\(/);
    expect(saleRouter).not.toMatch(/await\s+correctSale\s*\(/);
    expect(returnRouter).not.toMatch(/await\s+returnSale\s*\(/);
  });

  it("تاريخ الاستحقاق يمر بطلب مستقل وتطابق صلاحية واجهة التصحيح الخادم", () => {
    const invoice = page("InvoiceDetail.tsx");
    const saleRouter = server("routers/saleRouter.ts");
    const controlService = server("services/sale/controlRequests.ts");
    const notesOnlyRoute = saleRouter.slice(
      saleRouter.indexOf("correct: salesManagerProcedure"),
      saleRouter.indexOf("reissue: salesCorrectionProcedure"),
    );
    const correctionGate = readFileSync(new URL("../../hooks/useInvoiceActionPermissions.ts", import.meta.url), "utf8");
    expect(invoice).toContain("salesControl.requestDueDateChange.useMutation");
    expect(correctionGate).toContain("moduleAccessAllowed(");
    expect(correctionGate).toContain('["manager"]');
    expect(correctionGate).toContain('allowed("sales.correct", manager)');
    expect(correctionGate).toContain('"salesControl.requestDueDateChange"');
    expect(invoice).toContain("disabled={!canCorrectInvoice}");
    expect(invoice).toContain("disabled={!canRequestDueDateChange}");
    expect(correctionGate).not.toContain('me.data.role === "admin"');
    expect(notesOnlyRoute).not.toContain("dueDate:");
    expect(notesOnlyRoute).toContain("SALES_DUE_DATE_CHANGE");
    expect(controlService).toContain('request.requestType === "SALES_DUE_DATE_CHANGE"');
    expect(controlService).toContain("await assertPeriodOpen(tx, lockedInvoice.invoiceDate)");
    expect(controlService).toContain("assertLockedInvoiceControlSnapshotTx");
  });
});
