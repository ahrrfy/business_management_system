import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { notify, errMsg } from "@/lib/notify";
import { D } from "@/lib/money";
import { openPrintWindow } from "@/lib/printing/brand";
import { printDoc, printReceipt, type PrintResult } from "@/lib/printing/print";
import { docToHtml } from "@/lib/printing/render";
import { buildDeliveryDispatchSlipDoc } from "@/lib/printing/printDeliveryDispatchSlip";
import { printShippingLabel, resolveShippingLabelPaymentState } from "@/lib/printing/shippingLabel";
import { buildBrowserReceiptHtml, printInvoiceA4 } from "@/lib/printing/printTemplates";
import { invoiceToReceipt } from "@/lib/printing/invoiceReceipt";
import { invoiceDetailPrintData } from "@/lib/printing/invoiceDetailPrintData";
import { beginInvoicePrintAttempt, completeInvoicePrintAttempt, type InvoicePrintPurpose } from "@/lib/printing/invoicePrintAttempt";
import { dispatchDocumentData, dispatchDocumentPayload, workflowEventDocument, runWorkflowPrintPack, type WorkflowDocumentSnapshot, type WorkflowPrintJob } from "@/lib/printing/workflowDocuments";
import { operationDecision } from "@shared/operationPermissions";
import { beginWorkflowPrintAttempt, saveWorkflowPrintAttempt, finishWorkflowPrintAttempt, discardRejectedWorkflowPrintAttempt, withWorkflowPrintOwnership, type WorkflowPrintAttempt } from "@/lib/printing/workflowPrintAttempt";

/** Only reads documents and journals printing; never calls a financial command. */
export function useWorkflowDocumentPrinter(branchId: number) {
  const utils = trpc.useUtils();
  const user = trpc.auth.me.useQuery();
  const prepare = trpc.delivery.documents.prepareShipmentPrintBundle.useMutation();
  const request = trpc.delivery.documents.requestPrint.useMutation();
  const complete = trpc.delivery.documents.completePrint.useMutation();
  const firstInvoice = trpc.invoicePrinting.requestPrint.useMutation();
  const reprintInvoice = trpc.invoicePrinting.requestReprint.useMutation();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const canInvoice = !!user.data && (user.data.isOwner || operationDecision(user.data, "invoicePrinting.requestReprint").allowed || operationDecision(user.data, "invoicePrinting.requestPrint").allowed);
  function closeUnused(window: Window | null | undefined) { if (window && !window.closed) window.close(); }
  async function snapshots(consignmentId: number) {
    // Preparing metadata always inspects the latest actual assignment event.
    // Reassignment must never reuse a former carrier's label.
    return prepare.mutateAsync({ consignmentId, branchId });
  }
  async function invoiceJob(invoiceId: number): Promise<WorkflowPrintJob> {
    const source = await utils.sales.get.fetch({ invoiceId });
    if (!source || source.branchId !== branchId) throw new Error("فاتورة المصدر خارج الفرع الحالي أو غير متاحة ضمن صلاحياتك");
    const attempt = await authorizeInvoice(invoiceId, "THERMAL");
    const receipt = {
      ...invoiceToReceipt(source),
      copyLabel:
        attempt.mode === "REPRINT"
          ? "نسخة معاد طباعتها — بالقيم الحالية"
          : "النسخة الأصلية",
    };
    return { title: `نسخة الفاتورة الحالية ${source.invoiceNumber}`, silent: () => printReceipt(receipt, { openDrawer: false, into: null }),
      html: async () => buildBrowserReceiptHtml(receipt), complete: async (sent) => { if (sent) completeInvoicePrintAttempt(attempt); } };
  }
  async function authorizeInvoice(invoiceId: number, purpose: InvoicePrintPurpose) {
    const current = user.data;
    if (!current || !canInvoice) throw new Error("طباعة الفاتورة تحتاج صلاحية الطباعة أو إعادة الطباعة؛ اطلبها من مسؤول الصلاحيات");
    const reprint = current.isOwner || operationDecision(current, "invoicePrinting.requestReprint").allowed;
    const attempt = beginInvoicePrintAttempt(current.id, invoiceId, purpose, reprint, current.isOwner || operationDecision(current, "invoicePrinting.requestPrint").allowed);
    await (attempt.mode === "REPRINT" ? reprintInvoice : firstInvoice).mutateAsync({ invoiceId, purpose, requestId: attempt.requestId });
    return attempt;
  }
  async function snapshotJob(snapshot: WorkflowDocumentSnapshot): Promise<WorkflowPrintJob> {
    const dispatchSlip = snapshot.documentType === "DISPATCH_SLIP" ||
      (snapshot.documentType === "AFTERCARE_WAYBILL" && !!(snapshot.payload as { shipment?: unknown } | null)?.shipment);
    const doc = dispatchSlip
      ? buildDeliveryDispatchSlipDoc(dispatchDocumentData(snapshot)) : workflowEventDocument(snapshot);
    const attempt = await authorizeSnapshot(snapshot, "إعادة طباعة من محطة سير العمل");
    return { title: doc.title, silent: async () => {
        const known = knownPrintResult(attempt);
        if (known) return known;
        const result = await printDoc(doc, { into: null });
        if (result.ok) rememberOutcome(attempt, true, undefined, result.via);
        return result;
      }, html: () => docToHtml(doc),
      complete: async (sent, error) => {
        if (!attempt.outcome) rememberOutcome(attempt, sent, error, sent ? "browser" : undefined);
        await acknowledgeOutcome(attempt);
      } };
  }
  async function authorizeSnapshot(snapshot: WorkflowDocumentSnapshot, reason: string) {
    if (!user.data) throw new Error("تعذر تحديد مستخدم الطباعة؛ أعد تسجيل الدخول ثم أعد فتح المستند");
    const attempt = beginWorkflowPrintAttempt(user.data.id, branchId, snapshot, reason);
    const response = await request.mutateAsync(attempt.request).catch(async (cause: unknown) => {
      if (discardRejectedWorkflowPrintAttempt(attempt, cause)) {
        // Refresh the winner's history so a later click can explicitly reprint.
        try { await utils.delivery.documents.list.invalidate(); } catch { /* Preserve the request's rejection message. */ }
      }
      throw cause;
    });
    attempt.printId = response.print.id;
    if (!attempt.outcome && response.print.status !== "REQUESTED" && ["SENT", "FAILED", "CANCELLED"].includes(response.print.status)) {
      attempt.outcome = { status: response.print.status as "SENT" | "FAILED" | "CANCELLED",
        ...(response.print.status === "FAILED" ? { errorMessage: response.print.errorMessage || "تعذرت الطباعة" } : {}) };
    }
    saveWorkflowPrintAttempt(attempt);
    return attempt;
  }
  function rememberOutcome(attempt: WorkflowPrintAttempt, sent: boolean, error?: string, via?: PrintResult["via"]) {
    attempt.outcome = { status: sent ? "SENT" : "FAILED", ...(via ? { via } : {}),
      ...(!sent ? { errorMessage: (error || "تعذرت الطباعة").slice(0, 500) } : {}) };
    saveWorkflowPrintAttempt(attempt);
  }
  function knownPrintResult(attempt: WorkflowPrintAttempt): PrintResult | undefined {
    if (!attempt.outcome) return;
    if (attempt.outcome.status !== "SENT") throw new Error(attempt.outcome.errorMessage || "محاولة الطباعة السابقة ملغاة؛ أعد الطباعة بمحاولة جديدة");
    return { ok: true, via: attempt.outcome.via ?? "server" };
  }
  async function acknowledgeOutcome(attempt: WorkflowPrintAttempt) {
    const outcome = attempt.outcome!;
    await complete.mutateAsync({ printId: attempt.printId!, branchId: attempt.request.branchId, status: outcome.status,
      ...(outcome.status === "FAILED" ? { errorMessage: outcome.errorMessage } : {}) });
    finishWorkflowPrintAttempt(attempt);
    await utils.delivery.documents.list.invalidate();
  }
  function unavailableJob(title: string, cause: unknown): WorkflowPrintJob {
    return { title, silent: async () => { throw new Error(errMsg(cause)); }, html: async () => "", complete: async () => {} };
  }
  function ownOperationalPrint<T>(action: () => Promise<T>) {
    if (!user.data) throw new Error("تعذر تحديد مستخدم الطباعة؛ أعد تسجيل الدخول ثم أعد فتح المستند");
    return withWorkflowPrintOwnership(user.data.id, branchId, action);
  }
  async function run(window: Window | null, build: () => Promise<WorkflowPrintJob[]>, operational = false) {
    if (lock.current) { closeUnused(window); return; }
    lock.current = true; setBusy(true); setMessage("");
    try {
      const execute = async () => {
      const jobs = await build();
      if (!jobs.length) throw new Error("لا يوجد مستند مثبت متاح للطباعة في هذه العملية");
      let previewOpened = false;
      const outcomes = await runWorkflowPrintPack(jobs, (html) => { previewOpened = openPrintWindow(html, "width=480,height=800", { into: window }); return previewOpened; });
      if (!previewOpened) closeUnused(window);
      const sent = outcomes.filter((outcome) => outcome.sent).length;
      const failures = outcomes.filter((outcome) => outcome.error);
      const text = `${sent} من ${outcomes.length} مستند: ${outcomes.some((outcome) => outcome.sent && outcome.via === "browser") ? "فتحت معاينة الطباعة" : "أرسلت إلى الطابعة"}${failures.length ? ` — ${failures.map((outcome) => `${outcome.title}: ${outcome.error}`).join("؛ ")}` : ""}`;
      setMessage(text);
      if (failures.length) notify.warn("تمت المعاملة؛ راجع نتيجة الطباعة", text);
      return outcomes;
      };
      return await (operational ? ownOperationalPrint(execute) : execute());
    } catch (cause) { closeUnused(window); const text = `تمت المعاملة؛ تعذرت الطباعة فقط. ${errMsg(cause)} — أعد الطباعة دون إعادة المعاملة.`; setMessage(text); notify.err(text); }
    finally { lock.current = false; setBusy(false); }
  }
  const printShipment = (consignmentId: number, window: Window | null) => run(window, async () => {
    let documents: Awaited<ReturnType<typeof snapshots>> = [];
    let prepareError: unknown;
    try { documents = await snapshots(consignmentId); } catch (cause) { prepareError = cause; }
    const slip = documents.find((doc) => doc.documentType === "DISPATCH_SLIP");
    const manifest = slip
      ? documents.find(
          (doc) =>
            doc.documentType === "DELIVERY_MANIFEST" &&
            doc.eventKey === slip.eventKey,
        )
      : undefined;
    const payload = slip ? dispatchDocumentPayload(slip) : null;
    const jobs: WorkflowPrintJob[] = [];
    const preview = payload ? null : await utils.delivery.workflow.previewBySource.fetch({ source: { kind: "consignment", id: consignmentId }, station: "dispatch", branchId });
    const invoiceIds = payload?.invoices.map((invoice) => invoice.id) ?? preview?.group?.invoiceIds ?? (preview?.relations.invoiceId ? [preview.relations.invoiceId] : []);
    const aftercare = payload?.shipment.sourceType === "AFTERCARE_EXECUTION" || preview?.relations.aftercareExecutionId != null;
    if (!aftercare)
      for (const id of Array.from(new Set(invoiceIds))) {
        try { jobs.push(await invoiceJob(id)); } catch (cause) { jobs.push(unavailableJob(`فاتورة #${id}`, cause)); }
      }
    try { if (!slip) throw prepareError ?? new Error("بوليصة الإسناد الأصلية غير متاحة؛ راجع سجل الإسناد"); jobs.push(await snapshotJob(slip)); }
    catch (cause) { jobs.push(unavailableJob("بوليصة الإسناد", cause)); }
    try { if (!manifest) throw prepareError ?? new Error("محضر تسليم الشحنة غير متاح؛ راجع سجل الإسناد"); jobs.push(await snapshotJob(manifest)); }
    catch (cause) { jobs.push(unavailableJob("محضر تسليم الشحنة", cause)); }
    return jobs;
  }, true);
  const printInvoice = (invoiceId: number, window: Window | null) => run(window, async () => [await invoiceJob(invoiceId)]);
  const printSnapshot = (snapshot: WorkflowDocumentSnapshot, window: Window | null) => run(window, async () => [await snapshotJob(snapshot)], true);
  async function printA4(invoiceId: number, window: Window | null) {
    if (lock.current) { closeUnused(window); return; }
    lock.current = true; setBusy(true);
    try { const source = await utils.sales.get.fetch({ invoiceId }); if (!source || source.branchId !== branchId) throw new Error("الفاتورة ليست في الفرع الحالي");
      const attempt = await authorizeInvoice(invoiceId, "A4"); const opened = await printInvoiceA4({ ...invoiceDetailPrintData(source, null), copyLabel: attempt.mode === "REPRINT" ? "نسخة معاد طباعتها — بالقيم الحالية" : "النسخة الأصلية" }, { into: window });
      if (!opened) throw new Error("حُجبت نافذة الطباعة؛ افتحها من زر الفاتورة مجدداً");
      completeInvoicePrintAttempt(attempt); setMessage("فتحت معاينة نسخة الفاتورة الحالية A4");
    } catch (cause) { closeUnused(window); setMessage(errMsg(cause)); notify.err(cause, "تعذرت طباعة نسخة الفاتورة"); }
    finally { lock.current = false; setBusy(false); }
  }
  async function printLabel(consignmentId: number, window: Window | null) {
    if (lock.current) { closeUnused(window); return; }
    lock.current = true; setBusy(true);
    try {
      await ownOperationalPrint(async () => {
      const documents = await snapshots(consignmentId); const snapshot = documents.find((doc) => doc.documentType === "SHIPPING_LABEL");
      if (!snapshot) throw new Error("لقطة ملصق الشحنة غير متاحة");
      const payload = dispatchDocumentPayload(snapshot);
      const attempt = await authorizeSnapshot(snapshot, "إعادة طباعة ملصق الشحنة من محطة سير العمل");
      if (attempt.outcome) {
        await acknowledgeOutcome(attempt);
        closeUnused(window);
        knownPrintResult(attempt);
        setMessage("تم تسجيل نتيجة ملصق الشحنة السابق دون إرسال نسخة أخرى");
        return;
      }
      const atDoor = payload.money.codAmount == null || (payload.money.feeCollection === "COURIER" && payload.money.deliveryFee == null) ? null : D(payload.money.codAmount).plus(payload.money.feeCollection === "COURIER" ? payload.money.deliveryFee! : 0).toFixed(2);
      const result = await printShippingLabel({ orderNumber: payload.shipment.consignmentNumber, barcodeValue: payload.shipment.consignmentNumber, customerName: payload.recipient.name, customerPhone: payload.recipient.phone,
        governorate: payload.recipient.governorate, addressText: payload.recipient.address, total: atDoor, subtotal: payload.money.currentTotal, shippingFee: payload.money.deliveryFee, paidAmount: payload.money.paidAmount,
        paymentState: resolveShippingLabelPaymentState(atDoor == null ? null : Number(atDoor)), deliveryPartyName: payload.party.name, createdAt: snapshot.eventOccurredAt, printedAt: new Date(), isReprint: attempt.request.copyType === "REPRINT", notes: payload.evidence?.notice,
        items: payload.invoices.map((invoice) => ({ productName: `فاتورة ${invoice.invoiceNumber}`, unitName: "", quantity: "1" })) }, { into: window });
      rememberOutcome(attempt, result.ok, "حجبت نافذة معاينة الملصق", "browser");
      await acknowledgeOutcome(attempt);
      if (!result.ok) throw new Error("حجبت نافذة معاينة الملصق؛ أعد فتحها من زر الملصق"); setMessage("فتحت معاينة ملصق الشحنة بالطابعة والمقاس المحفوظين");
      });
    } catch (cause) { closeUnused(window); setMessage(errMsg(cause)); notify.err(cause, "تعذرت طباعة الملصق فقط"); }
    finally { lock.current = false; setBusy(false); }
  }
  return { busy, message, canInvoice, printShipment, printInvoice, printA4, printLabel, printSnapshot };
}
