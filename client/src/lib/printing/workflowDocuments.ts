import type { PrintDoc, PrintResult } from "./print";
import { esc } from "./brand";
import type { DispatchSlipData } from "./printDeliveryDispatchSlip";
import { fmtDateTime } from "@/lib/date";
import type { WorkflowDocumentType } from "@shared/deliveryWorkflow";

export interface WorkflowDocumentSnapshot {
  id: number;
  documentType: WorkflowDocumentType;
  documentNumber: string;
  eventOccurredAt: Date | string;
  payload: unknown;
  printHistory: Array<{ status: string }>;
}
export interface DispatchDocumentPayload {
  shipment: { consignmentId: number; consignmentNumber: string; fulfillmentRequestId: number | null; sourceType: string; sourceId: number };
  party: { id: number; name: string };
  recipient: { name: string | null; phone: string | null; address: string | null; governorate: string | null };
  money: { codAmount: string | null; deliveryFee: string | null; feeCollection: "COURIER" | "COUNTER" | "SHOP" | null; currentTotal: string | null; paidAmount: string | null };
  invoices: Array<{ id: number; invoiceNumber: string; total: string | null }>;
  evidence?: { notice?: string };
}
export function dispatchDocumentPayload(snapshot: WorkflowDocumentSnapshot): DispatchDocumentPayload {
  const payload = snapshot.payload as Partial<DispatchDocumentPayload> | null;
  if (!payload?.shipment?.consignmentNumber || !payload.party || !payload.recipient || !payload.money || !Array.isArray(payload.invoices))
    throw new Error("لقطة الإسناد غير مكتملة؛ راجع المستند الأصلي قبل الطباعة");
  return payload as DispatchDocumentPayload;
}
export function dispatchDocumentData(snapshot: WorkflowDocumentSnapshot): DispatchSlipData {
  const payload = dispatchDocumentPayload(snapshot);
  const invoice = payload.invoices.length === 1 ? payload.invoices[0] : null;
  return {
    sourceType: payload.shipment.sourceType as DispatchSlipData["sourceType"], sourceId: payload.shipment.sourceId,
    fulfillmentRequestId: payload.shipment.fulfillmentRequestId, invoiceId: invoice?.id ?? null, invoiceNumber: invoice?.invoiceNumber ?? null,
    consignmentNumber: payload.shipment.consignmentNumber,
    orderNumber: payload.invoices.map((item) => item.invoiceNumber).join("، ") || payload.shipment.consignmentNumber,
    orderKind: payload.shipment.sourceType === "AFTERCARE_EXECUTION" ? "aftercare" : undefined,
    partyName: payload.party.name, recipientName: payload.recipient.name ?? "", recipientPhone: payload.recipient.phone ?? "",
    deliveryAddress: payload.recipient.address ?? "", governorate: payload.recipient.governorate,
    salePrice: payload.money.currentTotal, deposit: payload.money.paidAmount, codAmount: payload.money.codAmount,
    deliveryFee: payload.money.deliveryFee, feeCollection: payload.money.feeCollection, dispatchedAt: snapshot.eventOccurredAt,
    notes: payload.evidence?.notice ?? null,
    items: payload.invoices.map((item) => ({ name: `فاتورة ${item.invoiceNumber}`, quantity: 1, ...(item.total == null ? {} : { total: item.total }) })),
    copy: snapshot.printHistory.some((attempt) => attempt.status === "SENT") ? { kind: "REPRINT", reason: "إعادة طباعة من محطة سير العمل" } : { kind: "ORIGINAL" },
  };
}
export function workflowEventDocument(snapshot: WorkflowDocumentSnapshot): PrintDoc {
  const payload = snapshot.payload as { schemaVersion?: number; title?: string; documentNumber?: string; eventOccurredAt?: string; rows?: Array<{ label: string; value: string }>; totals?: Array<{ label: string; value: string }>; notice?: string } | null;
  if (payload?.schemaVersion !== 1 || !payload.title || !Array.isArray(payload.rows) || payload.rows.some((row) => typeof row.label !== "string" || typeof row.value !== "string"))
    throw new Error("بيانات المستند الأصلي غير مكتملة؛ لا يمكن إنشاء إيصال من القيم الحية");
  return { kind: "zreport", title: payload.title, subtitle: payload.documentNumber ?? snapshot.documentNumber,
    meta: [`وقت العملية: ${fmtDateTime(snapshot.eventOccurredAt)}`, `وقت الطباعة: ${fmtDateTime(new Date())}`,
      snapshot.printHistory.some((attempt) => attempt.status === "SENT") ? "نسخة معاد طباعتها — من محطة سير العمل" : "نسخة من المستند المثبت"],
    columns: ["البيان", "القيمة"], rows: payload.rows.map((row) => [row.label, row.value]), totals: payload.totals,
    footer: payload.notice ?? "طباعة المستند لا تنشئ بيعاً أو قبضاً أو حركة مخزون.",
    barcodeSet: { barcode128: payload.documentNumber ?? snapshot.documentNumber, qrPayload: "", displayLabel: payload.documentNumber ?? snapshot.documentNumber },
  };
}

/** One browser preview for the documents which did NOT reach a silent printer. */
export function workflowPrintPackHtml(documents: Array<{ title: string; html: string }>): string {
  if (!documents.length) throw new Error("حزمة الطباعة فارغة");
  const parsed = documents.map((item) => ({ title: item.title, doc: new DOMParser().parseFromString(item.html, "text/html") }));
  for (const { doc } of parsed) doc.querySelectorAll("script").forEach((script) => script.remove());
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>حزمة مستندات سير العمل — 80 مم</title>${parsed.map(({ doc }) => doc.head.innerHTML).join("")}<style>
  .workflow-pack-toolbar{position:sticky;top:0;background:#fff;color:#000;border-bottom:1px solid #777;padding:10px;font:700 14px Arial;z-index:20;width:100%}.workflow-pack-toolbar button{padding:8px 14px;margin:3px;border:1px solid #777;background:#fff;color:#000;cursor:pointer}.workflow-pack-item{break-after:page;margin-bottom:8mm}.workflow-pack-item:last-child{break-after:auto}.workflow-pack-title{font:700 11px Arial;border-bottom:1px solid #000;margin-bottom:3mm;padding:2mm}
  @media print{.workflow-pack-toolbar{display:none!important}.workflow-pack-item{margin:0}body{width:80mm!important;margin:0!important}}
  </style></head><body><nav class="workflow-pack-toolbar">معاينة حزمة 80 مم <button id="doc-btn-print">طباعة الحزمة</button><button id="doc-btn-close">إغلاق</button></nav>${parsed.map(({ title, doc }) => `<section class="workflow-pack-item"><div class="workflow-pack-title">${esc(title)}</div>${doc.body.innerHTML}</section>`).join("")}</body></html>`;
}

export interface WorkflowPrintJob {
  title: string;
  silent: () => Promise<PrintResult>;
  html: () => Promise<string>;
  complete: (sent: boolean, error?: string) => Promise<void>;
}
export interface WorkflowPrintOutcome { title: string; sent: boolean; via?: PrintResult["via"]; error?: string }
/** Printing and its journal are isolated from the already committed transaction. */
export async function runWorkflowPrintPack(jobs: WorkflowPrintJob[], openPreview: (html: string) => boolean): Promise<WorkflowPrintOutcome[]> {
  const outcomes: WorkflowPrintOutcome[] = [];
  const browser: Array<{ index: number; html: string }> = [];
  for (const job of jobs) {
    const index = outcomes.length;
    outcomes.push({ title: job.title, sent: false });
    try {
      const result = await job.silent();
      if (result.ok) outcomes[index] = { title: job.title, sent: true, via: result.via };
      else browser.push({ index, html: await job.html() });
    } catch (cause) { outcomes[index].error = cause instanceof Error ? cause.message : "تعذرت طباعة المستند"; }
  }
  if (browser.length) {
    try {
      const opened = openPreview(workflowPrintPackHtml(browser.map((item) => ({ title: jobs[item.index].title, html: item.html }))));
      for (const item of browser) outcomes[item.index] = { title: jobs[item.index].title, sent: opened, via: "browser", ...(!opened ? { error: "حُجبت نافذة الطباعة؛ أعد فتح المعاينة من زر الطباعة" } : {}) };
    } catch (cause) { for (const item of browser) outcomes[item.index].error = cause instanceof Error ? cause.message : "تعذرت معاينة الحزمة"; }
  }
  for (const [index, outcome] of Array.from(outcomes.entries())) {
    try { await jobs[index].complete(outcome.sent, outcome.error); }
    catch { outcome.error = outcome.sent ? "أرسل المستند للطباعة؛ تعذر تسجيل النتيجة، راجع سجل الطباعة قبل تكرار النسخة" : outcome.error ?? "تعذر تسجيل فشل الطباعة"; }
  }
  return outcomes;
}
