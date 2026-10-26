import { Printer, Tag } from "lucide-react";
import type { WorkflowScanPreview, WorkflowSourceKind } from "@shared/deliveryWorkflow";
import { trpc } from "@/lib/trpc";
import { useWorkflowDocumentPrinter } from "@/hooks/useWorkflowDocumentPrinter";
import { preopenDocumentWindow } from "@/lib/printing/print";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { Button } from "@/components/ui/button";

/** Print controls stay beside the scanned document in every station. */
export function WorkflowPrintActions({ branchId, preview, consignmentId, invoiceIds, source, settlementId, mode = "dispatch" }: {
  branchId: number;
  preview?: WorkflowScanPreview;
  consignmentId?: number | null;
  invoiceIds?: number[];
  settlementId?: number;
  source?: { kind: WorkflowSourceKind; id: number };
  mode?: "dispatch" | "collect" | "return" | "aftercare" | "edit" | "cancel";
}) {
  const resolved = trpc.delivery.workflow.previewBySource.useQuery(
    { source: source ?? { kind: "consignment", id: consignmentId ?? 0 }, station: mode === "cancel" ? "cancelAssignment" : mode, branchId },
    { enabled: !preview && (!!source || !!consignmentId), staleTime: 30_000 },
  );
  const current = preview ?? resolved.data;
  const leader = consignmentId ?? current?.group?.leaderConsignmentId ?? current?.relations.consignmentId;
  const invoices = Array.from(new Set(invoiceIds ?? current?.group?.invoiceIds ?? (current?.relations.invoiceId ? [current.relations.invoiceId] : [])));
  const documents = trpc.delivery.documents.list.useQuery({ sourceType: "SHIPMENT", sourceId: leader ?? 0, branchId }, { enabled: !!leader, staleTime: 0 });
  const settlementDocuments = trpc.delivery.documents.list.useQuery({ sourceType: "AFTERCARE_SETTLEMENT", sourceId: settlementId ?? 0, branchId }, { enabled: !!settlementId, staleTime: 0 });
  const printer = useWorkflowDocumentPrinter(branchId);
  if (!leader && !invoices.length && !source && !settlementId) return null;
  const extras = [...(settlementDocuments.data ?? []), ...(documents.data ?? [])]
    .filter((doc) => !["INVOICE", "DISPATCH_SLIP", "SHIPPING_LABEL"].includes(doc.documentType));
  return <section className="space-y-2 rounded-md border p-2" aria-label="مطبوعات المستند">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-sm">مطبوعات المستند</strong>
      {leader && <>
        <Button type="button" variant="outline" size="sm" disabled={printer.busy} onClick={() => { const window = preopenDocumentWindow(); void printer.printShipment(leader, window); }}>
          <Printer className="me-1 size-4" aria-hidden />{mode === "dispatch" ? "الفواتير والبوليصة والمحضر — 80 مم" : "إعادة طباعة مستندات الإسناد"}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={printer.busy} onClick={() => { const window = preopenShippingLabelWindow(); void printer.printLabel(leader, window); }}><Tag className="me-1 size-4" aria-hidden />ملصق الشحنة</Button>
      </>}
      {invoices.map((invoiceId) => <div key={invoiceId} className="flex flex-wrap gap-1">
        <Button type="button" variant="outline" size="sm" disabled={printer.busy || !printer.canInvoice} title={!printer.canInvoice ? "اطلب صلاحية طباعة الفاتورة أو إعادة طباعتها من المسؤول" : "نسخة الفاتورة بقيمها الحالية؛ لا إنشاء بيع أو قبض"} onClick={() => { const window = preopenDocumentWindow(); void printer.printInvoice(invoiceId, window); }}>فاتورة {invoices.length > 1 ? `#${invoiceId} ` : ""}حرارية</Button>
        <Button type="button" variant="outline" size="sm" disabled={printer.busy || !printer.canInvoice} onClick={() => { const window = preopenDocumentWindow(); void printer.printA4(invoiceId, window); }}>فاتورة {invoices.length > 1 ? `#${invoiceId} ` : ""}A4</Button>
      </div>)}
      {extras.map((snapshot) => <Button type="button" variant="outline" size="sm" key={snapshot.id} disabled={printer.busy} onClick={() => { const window = preopenDocumentWindow(); void printer.printSnapshot(snapshot, window); }}>
        {((snapshot.payload as { title?: string } | null)?.title) ?? snapshot.documentType} — {snapshot.documentNumber}
      </Button>)}
    </div>
    {!printer.canInvoice && invoices.length > 0 && <p className="text-xs text-muted-foreground">طباعة الفاتورة تحتاج صلاحية مستقلة؛ راجع مسؤول الصلاحيات. بقية مستندات التوصيل تبقى حسب تفويضك.</p>}
    {settlementId && !settlementDocuments.isLoading && !settlementDocuments.error && !settlementDocuments.data?.length && <p className="text-sm text-muted-foreground">لا توجد لقطة مطبوعة أصلية لهذه التسوية التاريخية؛ راجع مستند التسوية وسجل اعتمادها. لا تعِد ترحيلها لإنشاء مطبوع.</p>}
    {(documents.error || settlementDocuments.error || resolved.error) && <p role="alert" className="text-sm text-destructive">تعذر جلب المستندات؛ حدّث المعاينة أو أعد مسح المستند نفسه. لا تعِد المعاملة.</p>}
    {printer.message && <p role="status" className="text-sm whitespace-pre-wrap">{printer.message}</p>}
  </section>;
}
