// ورشة فواتير محطة خدمة الزبائن — ش١ (docs/reception-cashier-system-design-2026-08-05.md §٨.٥).
import { useMemo, useRef, useState } from "react";
import {
  Banknote,
  FileText,
  FileWarning,
  HandCoins,
  PencilLine,
  Printer,
  Receipt,
  RotateCcw,
  Truck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { resolveOrderLookupBarcode } from "@/lib/scanRouter";
import { Label } from "@/components/ui/label";
import { CardBrandLogos } from "@/components/ui/CardBrandLogos";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import type { DispatchParty } from "@/components/delivery/DispatchDialog";
import { InvoiceDispatchDialog } from "@/components/delivery/InvoiceDispatchDialog";
import { InvoiceDetailDrawer } from "@/components/invoice/InvoiceDetailDrawer";
import { SalesReturnDrawer } from "@/components/invoice/SalesReturnDrawer";
import { QuickCancelInvoiceDialog } from "@/components/invoice/QuickCancelInvoiceDialog";
import ReverseDeliveryRequestDialog from "@/components/workorder/ReverseDeliveryRequestDialog";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { invoiceToReceipt } from "@/lib/printing/invoiceReceipt";
import { useInvoiceReceiptPrinter } from "@/hooks/useInvoiceReceiptPrinter";
import { useInvoiceActionPermissions } from "@/hooks/useInvoiceActionPermissions";
import { receptionInvoiceActions, receptionOperationAllowed } from "@/lib/receptionOperationAccess";
import { hasPendingFirstInvoicePrint } from "@/lib/printing/invoicePrintAttempt";
import { invoiceDetailPrintData } from "@/lib/printing/invoiceDetailPrintData";
import { printInvoiceA4 } from "@/lib/printing/printTemplates";
import { preopenDocumentWindow } from "@/lib/printing/print";
import { reservePrintWindow, releaseReservedPrintWindow } from "@/lib/printing/brand";
import { printInvoicePaymentReceipt } from "@/lib/printing/cashierLifecycleReceipts";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/lib/date";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { INBOUND_TELECOM_DISABLED_MESSAGE } from "@shared/inboundPaymentPolicy";
import { invoiceStatusLabel, invoiceStatusBadgeVariant } from "@shared/invoiceStatus";
import { getDeviceCode } from "@/lib/offline/outbox";

type QueueOut = RouterOutputs["reception"]["invoiceQueue"];
type Row = QueueOut["rows"][number];

type RangeChip = "MY_SHIFT" | "TODAY" | "WEEK";
type PayChip = "ALL" | "UNSETTLED" | "PAID" | "CARD";

export function ReceptionInvoiceQueue({
  branchId,
  currentShiftId,
  branchName,
  defaultPayChip,
}: {
  branchId: number;
  currentShiftId: number | null;
  branchName: string;
  parties: DispatchParty[];
  defaultPayChip?: PayChip;
}) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const actions = receptionInvoiceActions(me.data);
  const { canFirstPrint, canReprint } = useInvoiceActionPermissions(me.data);
  const { printAuthorizedReceiptData, printAuthorizedDocument } = useInvoiceReceiptPrinter(me.data, me.data?.id);
  const canRetryThermal = (invoiceId: number) =>
    canReprint || (canFirstPrint && hasPendingFirstInvoicePrint(me.data?.id, invoiceId, "THERMAL"));
  const [range, setRange] = useState<RangeChip>(currentShiftId ? "MY_SHIFT" : "TODAY");
  const [payChip, setPayChip] = useState<PayChip>(defaultPayChip ?? "ALL");
  const [search, setSearch] = useState("");
  const debouncedQ = useDebouncedValue(search, 250);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [accRows, setAccRows] = useState<Row[]>([]);

  const queryInput = useMemo(() => {
    const base = {
      branchId,
      q: debouncedQ.trim() || undefined,
      paymentState:
        payChip === "UNSETTLED"
          ? ("UNSETTLED" as const)
          : payChip === "PAID"
            ? ("PAID" as const)
            : undefined,
      method: payChip === "CARD" ? ("CARD" as const) : undefined,
      limit: 50,
      cursor,
    };
    if (debouncedQ.trim()) return { ...base, sinceDays: 90 };
    if (range === "MY_SHIFT" && currentShiftId) return { ...base, shiftIds: [currentShiftId] };
    return { ...base, sinceDays: range === "TODAY" ? 0 : 7 };
  }, [branchId, debouncedQ, payChip, range, currentShiftId, cursor]);

  const q = trpc.reception.invoiceQueue.useQuery(queryInput, {
    enabled: receptionOperationAllowed(me.data, "reception.invoiceQueue"),
    placeholderData: (prev) => prev,
  });

  const rows = useMemo(() => {
    const page = q.data?.rows ?? [];
    if (!cursor) return page;
    const seen = new Set(accRows.map((r) => Number(r.id)));
    return [...accRows, ...page.filter((r) => !seen.has(Number(r.id)))];
  }, [q.data, cursor, accRows]);

  function resetPaging() {
    setCursor(undefined);
    setAccRows([]);
  }
  function loadMore() {
    if (!q.data?.hasMore || q.data.nextCursor == null) return;
    setAccRows(rows);
    setCursor(q.data.nextCursor);
  }

  const [collectTarget, setCollectTarget] = useState<Row | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<Row | null>(null);
  const [returnTarget, setReturnTarget] = useState<Row | null>(null);
  const [inlineReturnId, setInlineReturnId] = useState<number | null>(null);
  const [cancelInvoiceId, setCancelInvoiceId] = useState<number | null>(null);
  const [detailInvoiceId, setDetailInvoiceId] = useState<number | null>(null);
  const [printingId, setPrintingId] = useState<number | null>(null);
  const taxSettings = trpc.system.getTaxSettings.useQuery(undefined, { staleTime: 300_000 });

  async function reprintThermal(row: Row) {
    if (printingId != null || !actions.canReadInvoice || !canRetryThermal(Number(row.id))) return;
    reservePrintWindow();
    setPrintingId(Number(row.id));
    try {
      const d = await utils.sales.get.fetch({ invoiceId: Number(row.id) });
      if (!d) { notify.err("تعذّر جلب الفاتورة"); return; }
      const result = await printAuthorizedReceiptData(invoiceToReceipt(d), true);
      if (!result.ok) notify.err("تعذّرت الطباعة", "حجب المتصفح نافذة الطباعة البديلة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة");
      else if (result.via === "browser") notify.warn("الطابعة المباشرة غير متاحة", "فُتحت نافذة الطباعة البديلة");
      else notify.ok("تمت إعادة الطباعة", `الفاتورة ${d.invoiceNumber}`);
    } catch (e) {
      notify.err(e);
    } finally {
      releaseReservedPrintWindow();
      setPrintingId(null);
    }
  }

  async function printA4(row: Row) {
    if (!actions.canReadInvoice || (!canFirstPrint && !canReprint)) return;
    reservePrintWindow();
    try {
      const d = await utils.sales.get.fetch({ invoiceId: Number(row.id) });
      if (!d) { notify.err("تعذّر جلب الفاتورة"); return; }
      await printAuthorizedDocument(Number(row.id), "A4", canReprint, async () =>
        (await printInvoiceA4(invoiceDetailPrintData(d, taxSettings.data?.taxRegistrationNumber ?? null)))
          ? { ok: true, via: "browser" }
          : { ok: false, via: "browser", reason: "popup-blocked" },
      );
    } catch (e) {
      notify.err(e);
    } finally {
      releaseReservedPrintWindow();
    }
  }

  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;

  const remainingOf = (r: Row) =>
    round2(D(r.total).minus(D(r.paidAmount ?? 0)).minus(D(r.returnedTotal ?? 0))).toNumber();

  const chip = (active: boolean) =>
    cn(
      "inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-bold transition-colors",
      active ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted",
    );

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="ورشة فواتير المحطة">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 border-b bg-muted/30 px-3 py-2">
        {currentShiftId != null && (
          <button type="button" className={chip(range === "MY_SHIFT")} onClick={() => { setRange("MY_SHIFT"); resetPaging(); }}>
            ورديتي
          </button>
        )}
        <button type="button" className={chip(range === "TODAY")} onClick={() => { setRange("TODAY"); resetPaging(); }}>
          اليوم
        </button>
        <button type="button" className={chip(range === "WEEK")} onClick={() => { setRange("WEEK"); resetPaging(); }}>
          ٧ أيام
        </button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <button type="button" className={chip(payChip === "ALL")} onClick={() => { setPayChip("ALL"); resetPaging(); }}>
          الكل
        </button>
        <button type="button" className={chip(payChip === "UNSETTLED")} onClick={() => { setPayChip((p) => (p === "UNSETTLED" ? "ALL" : "UNSETTLED")); resetPaging(); }}>
          غير مسدّدة
        </button>
        <button type="button" className={chip(payChip === "PAID")} onClick={() => { setPayChip((p) => (p === "PAID" ? "ALL" : "PAID")); resetPaging(); }}>
          مسدّدة
        </button>
        <button type="button" className={chip(payChip === "CARD")} onClick={() => { setPayChip((p) => (p === "CARD" ? "ALL" : "CARD")); resetPaging(); }}>
          <CardBrandLogos size="xs" />
          <span>بالبطاقة</span>
        </button>
        <UnifiedSearchInput
          barcode={true}
          debounceMs={0}
          value={search}
          onScan={(code) => { setSearch(resolveOrderLookupBarcode(code)); resetPaging(); }}
          onChange={(val) => { setSearch(val); resetPaging(); }}
          placeholder="امسح الباركود أو اكتب رقم الفاتورة أو اسم/هاتف الزبون"
          className="h-8 text-xs"
          wrapperClassName="ms-auto min-w-44 flex-1 sm:max-w-72"
          aria-label="بحث في فواتير المحطة"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && !q.isFetching ? (
          <EmptyState
            icon={Receipt}
            title="لا فواتير ضمن هذا النطاق"
            description="غيّر الفلتر إلى اليوم أو ٧ أيام، أو امسح باركود الفاتورة للبحث الشامل."
          />
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-muted/60 text-[10px] text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-right font-bold">الفاتورة</th>
                <th className="px-2 py-2 text-right font-bold">الوقت</th>
                <th className="px-2 py-2 text-right font-bold">الزبون</th>
                <th className="px-2 py-2 text-center font-bold">الإجمالي</th>
                <th className="px-2 py-2 text-center font-bold">المدفوع</th>
                <th className="px-2 py-2 text-center font-bold">المتبقّي</th>
                <th className="px-2 py-2 text-center font-bold">الحالة</th>
                <th className="px-2 py-2 text-right font-bold">التسليم</th>
                <th className="px-2 py-2 text-right font-bold">الموظف</th>
                <th className="px-2 py-2 text-center font-bold">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const remaining = remainingOf(row);
                const canCorrect = actions.canCorrect;
                const parsedWorkOrderId = (() => {
                  if (row.workOrderId != null) return Number(row.workOrderId);
                  const m = /^WO-(\d+)(?::R\d+)?$/.exec(String(row.sourceId ?? ""));
                  return m ? Number(m[1]) : null;
                })();
                const isWorkOrderInvoice =
                  row.sourceType === "WORKORDER" || parsedWorkOrderId != null;
                const isLiveRow =
                  row.status !== "RETURNED" &&
                  row.status !== "CANCELLED" &&
                  row.status !== "SUPERSEDED";
                const canCancelRow =
                  isLiveRow &&
                  !isWorkOrderInvoice &&
                  row.consignmentStatus !== "DELIVERED" &&
                  row.consignmentStatus !== "PARTIAL" &&
                  (actions.canCancelInvoice || actions.canCancelUnpaidCod);

                return (
                  <tr key={String(row.id)} className="border-b align-middle hover:bg-muted/30">
                    <td className="px-2 py-2 font-bold" dir="ltr">
                      {row.invoiceNumber}
                      {row.offlineReceiptNumber && (
                        <div className="text-[9px] font-medium text-muted-foreground">{row.offlineReceiptNumber}</div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground" dir="ltr">
                      {row.invoiceDate ? fmtDateTime(row.invoiceDate) : "—"}
                    </td>
                    <td className="px-2 py-2">
                      <div className="max-w-36 truncate font-semibold">
                        {row.customerName ?? row.contactName ?? "عميل نقدي"}
                      </div>
                      {(row.customerPhone ?? row.contactPhone) && (
                        <div className="text-[10px] text-muted-foreground" dir="ltr">{row.customerPhone ?? row.contactPhone}</div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center font-bold tabular-nums" dir="ltr">{fmt(row.total)}</td>
                    <td className="px-2 py-2 text-center tabular-nums" dir="ltr">{fmt(row.paidAmount ?? "0")}</td>
                    <td className={cn("px-2 py-2 text-center font-extrabold tabular-nums", remaining > 0 ? "text-[var(--sem-warn)]" : "text-muted-foreground")} dir="ltr">
                      {fmt(remaining)}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <Badge variant={invoiceStatusBadgeVariant(row.status)} className="text-[10px]">
                        {invoiceStatusLabel(row.status)}
                      </Badge>
                    </td>
                    <td className="px-2 py-2">
                      {row.consignmentNumber && row.consignmentStatus !== "CANCELLED" ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold">
                          <Truck aria-hidden className="size-3" />
                          {row.consignmentNumber}
                          <span className="text-muted-foreground">· {row.partyName ?? "مندوب"}</span>
                          <span className="text-muted-foreground">
                            {row.consignmentStatus === "DELIVERED" ? "(سُلِّمت)" : row.consignmentStatus === "PARTIAL" ? "(جزئي)" : "(بالطريق)"}
                          </span>
                        </span>
                      ) : parsedWorkOrderId != null ? (
                        <a href={`/work-orders/${parsedWorkOrderId}`} className="text-[10px] text-primary hover:underline">
                          طلب {row.workOrderNumber ?? `#${parsedWorkOrderId}`}
                        </a>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">مباشر</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-[10px] text-muted-foreground">
                      {row.lastCollectorName ?? row.createdByName ?? "—"}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap items-center justify-center gap-1">
                        {actions.canCollect && remaining > 0 && row.consignmentStatus !== "DISPATCHED" && row.consignmentStatus !== "PARTIAL" && (
                          <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => setCollectTarget(row)}>
                            <HandCoins aria-hidden className="size-3 me-1" />
                            تسديد
                          </Button>
                        )}
                        {remaining > 0 && (row.consignmentStatus === "DISPATCHED" || row.consignmentStatus === "PARTIAL") && (
                          <span className="inline-flex h-7 items-center rounded-md border border-dashed px-1.5 text-[10px] text-muted-foreground" title="الفاتورة مع المندوب">
                            مع المندوب
                          </span>
                        )}
                        {isLiveRow && isWorkOrderInvoice && actions.canReverseWorkOrder && parsedWorkOrderId != null && (
                          <ReverseDeliveryRequestDialog
                            workOrderId={parsedWorkOrderId}
                            orderNumber={row.workOrderNumber ?? String(row.sourceId ?? parsedWorkOrderId)}
                            title={`فاتورة ${row.invoiceNumber}`}
                            buttonLabel="مرتجع"
                            size="sm"
                            onRequested={() => {
                              resetPaging();
                              void utils.reception.invoiceQueue.invalidate();
                            }}
                          />
                        )}
                        {isLiveRow && !isWorkOrderInvoice && actions.canCreateReturn && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 px-2 text-[10px] font-bold"
                            onClick={() => setInlineReturnId(Number(row.id))}
                          >
                            <RotateCcw aria-hidden className="size-3" />
                            مرتجع
                          </Button>
                        )}
                        {isLiveRow && !isWorkOrderInvoice && !actions.canCreateReturn && actions.canRequestReturn && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 px-2 text-[10px]"
                            onClick={() => setReturnTarget(row)}
                          >
                            <RotateCcw aria-hidden className="size-3" />
                            مرتجع
                          </Button>
                        )}
                        {canCancelRow && (
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 gap-1 px-2 text-[10px] font-bold"
                            onClick={() => setCancelInvoiceId(Number(row.id))}
                          >
                            <FileWarning aria-hidden className="size-3" />
                            إلغاء
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="h-7 px-1.5" title="إعادة طباعة حرارية" aria-label={`إعادة طباعة الفاتورة ${row.invoiceNumber}`} disabled={printingId != null || !canRetryThermal(Number(row.id))} onClick={() => void reprintThermal(row)}>
                          <Printer aria-hidden className="size-3" />
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 px-1.5" title="طباعة A4" aria-label={`طباعة A4 للفاتورة ${row.invoiceNumber}`} disabled={!canFirstPrint && !canReprint} onClick={() => void printA4(row)}>
                          <FileText aria-hidden className="size-3" />
                        </Button>
                        {canCorrect && isLiveRow && !isWorkOrderInvoice && (
                          <a
                            href={`/reception/workflow?section=edit&invoice=${encodeURIComponent(row.invoiceNumber)}`}
                            className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)] px-1.5 text-[10px] font-bold text-[var(--sem-warn)] hover:bg-muted"
                            title="تعديل أصناف الفاتورة"
                            aria-label={`تعديل الفاتورة ${row.invoiceNumber}`}
                          >
                            <PencilLine aria-hidden className="size-3" />
                            تعديل
                          </a>
                        )}
                        {isLiveRow && (!row.consignmentId || row.consignmentStatus === "CANCELLED") && actions.canDispatch && (
                          <Button size="sm" variant="outline" className="h-7 px-1.5" title="إسناد للتوصيل" aria-label={`إسناد الفاتورة ${row.invoiceNumber} للتوصيل`} onClick={() => setDispatchTarget(row)}>
                            <Truck aria-hidden className="size-3" />
                          </Button>
                        )}
                        {actions.canReadInvoice && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-1.5 text-[10px] font-bold"
                            onClick={() => setDetailInvoiceId(Number(row.id))}
                          >
                            تفاصيل
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {q.data?.hasMore && (
          <div className="p-3 text-center">
            <Button variant="outline" size="sm" onClick={loadMore} disabled={q.isFetching}>
              {q.isFetching ? "جارٍ التحميل…" : "تحميل المزيد"}
            </Button>
          </div>
        )}
      </div>

      {collectTarget && actions.canCollect && (
        <CollectPaymentDialog
          row={collectTarget}
          remaining={remainingOf(collectTarget)}
          branchId={branchId}
          currentShiftId={currentShiftId}
          branchName={branchName}
          onClose={() => setCollectTarget(null)}
          onDone={() => {
            setCollectTarget(null);
            resetPaging();
            void utils.reception.invoiceQueue.invalidate();
          }}
        />
      )}

      {dispatchTarget && actions.canDispatch && (
        <InvoiceDispatchDialog
          open
          invoice={{
            id: Number(dispatchTarget.id),
            invoiceNumber: dispatchTarget.invoiceNumber,
            total: dispatchTarget.total,
            paidAmount: dispatchTarget.paidAmount,
            returnedTotal: dispatchTarget.returnedTotal,
            customerName: dispatchTarget.customerName ?? dispatchTarget.contactName,
            customerPhone: dispatchTarget.customerPhone ?? dispatchTarget.contactPhone ?? dispatchTarget.deliveryPhone,
            deliveryAddress: dispatchTarget.deliveryAddress,
            branchId,
          }}
          onOpenChange={(open) => { if (!open) setDispatchTarget(null); }}
          onCompleted={() => {
            resetPaging();
            void utils.reception.invoiceQueue.invalidate();
            void utils.workOrders.list.invalidate();
          }}
        />
      )}

      <InvoiceDetailDrawer
        invoiceId={detailInvoiceId}
        onClose={() => setDetailInvoiceId(null)}
        onOpenReturn={(id) => {
          setDetailInvoiceId(null);
          setInlineReturnId(id);
        }}
      />

      <SalesReturnDrawer
        invoiceId={inlineReturnId}
        initialMode="FULL"
        onClose={() => setInlineReturnId(null)}
        onSuccess={() => {
          setInlineReturnId(null);
          resetPaging();
          void utils.reception.invoiceQueue.invalidate();
        }}
      />

      <QuickCancelInvoiceDialog
        invoiceId={cancelInvoiceId}
        open={cancelInvoiceId != null}
        onOpenChange={(v) => { if (!v) setCancelInvoiceId(null); }}
        onSwitchToReturn={(id) => setInlineReturnId(id)}
        onSuccess={() => {
          setCancelInvoiceId(null);
          resetPaging();
          void utils.reception.invoiceQueue.invalidate();
        }}
      />

      {returnTarget && actions.canRequestReturn && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" dir="rtl" onClick={() => setReturnTarget(null)}>
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-extrabold">مرتجع — {returnTarget.invoiceNumber}</h3>
            <StaffReturnRequestForm row={returnTarget} onClose={() => setReturnTarget(null)} />
          </div>
        </div>
      )}
    </section>
  );
}

function CollectPaymentDialog({
  row,
  remaining,
  branchId,
  currentShiftId,
  branchName,
  onClose,
  onDone,
}: {
  row: Row;
  remaining: number;
  branchId: number;
  currentShiftId: number | null;
  branchName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const me = trpc.auth.me.useQuery();
  const actions = receptionInvoiceActions(me.data);
  const [amount, setAmount] = useState(String(remaining));
  const [method, setMethod] = useState<"CASH" | "CARD" | "TRANSFER" | "WALLET" | "TELECOM">("CASH");
  const [reference, setReference] = useState("");
  const [telecomConfirmed, setTelecomConfirmed] = useState(false);
  const [clientRequestId] = useState(() => crypto.randomUUID());

  const [externalAttempt, setExternalAttempt] = useState<{
    attemptId: number | null;
    requestId: string;
    deviceId: string;
    fingerprint: string;
    confirmed: boolean;
  } | null>(null);

  const payWinRef = useRef<Window | null>(null);
  const collect = trpc.reception.collectOnInvoice.useMutation({
    onSuccess: (r) => {
      const win = payWinRef.current;
      payWinRef.current = null;
      notify.ok(
        `سُدِّدت دفعة على ${row.invoiceNumber}`,
        "notice" in r && r.notice
          ? r.notice
          : method === "CASH" && r.collectedIntoShiftId
            ? `دخل المبلغ درج ورديتك #${r.collectedIntoShiftId}`
            : r.collectedIntoShiftId
              ? `سُجِّلت على ورديتك #${r.collectedIntoShiftId} — لا تدخل درج النقد`
              : undefined,
      );
      const paidNow = round2(D(amount || "0")).toFixed(2);
      const remAfter = round2(D(remaining).minus(D(paidNow)));
      void printInvoicePaymentReceipt(
        {
          invoiceNumber: row.invoiceNumber,
          customerName: row.customerName ?? row.contactName ?? null,
          customerPhone: row.customerPhone ?? row.contactPhone ?? null,
          invoiceTotal: row.total,
          paidBefore: D(row.paidAmount ?? 0).toFixed(2),
          amountPaid: paidNow,
          remainingAfter: (remAfter.gt(0) ? remAfter : D(0)).toFixed(2),
          paymentMethod: method,
          reference: method !== "CASH" ? reference.trim() || null : null,
          branchName,
          cashierName: me.data?.name ?? null,
        },
        win ? { into: win } : undefined,
      );
      onDone();
    },
    onError: (e) => {
      try { payWinRef.current?.close(); } catch { /* noop */ }
      payWinRef.current = null;
      notify.err(e);
    },
  });

  const initiateExternal = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.sales.confirmExternalPayment.useMutation();

  const needRef = method !== "CASH";
  const normalizedAmount = round2(D(amount || "0")).toFixed(2);
  const externalFingerprint = `SALES_COLLECTION|${branchId}|${method}|${normalizedAmount}|${reference.trim()}`;
  const externalConfirmed =
    method === "CASH" ||
    (externalAttempt?.confirmed === true && externalAttempt.fingerprint === externalFingerprint);

  async function confirmReceptionExternalPayment() {
    if (!actions.canCollect || !actions.canConfirmExternalPayment) return;
    const normalizedReference = reference.trim();
    if (!normalizedReference || !D(amount || "0").gt(0) || method === "CASH" || method === "TELECOM") return;
    try {
      const prior = externalAttempt?.fingerprint === externalFingerprint ? externalAttempt : null;
      const deviceId = prior?.deviceId ?? (await getDeviceCode());
      const requestId = prior?.requestId ?? crypto.randomUUID();
      let attemptId = prior?.attemptId ?? null;
      if (attemptId == null) {
        const initiated = await initiateExternal.mutateAsync({
          branchId,
          channel: "SALES_COLLECTION",
          method,
          amount: normalizedAmount,
          reference: normalizedReference,
          requestId,
          deviceId,
        });
        attemptId = initiated.attemptId;
        setExternalAttempt({ attemptId, requestId, deviceId, fingerprint: externalFingerprint, confirmed: false });
      }
      await confirmExternal.mutateAsync({ branchId, channel: "SALES_COLLECTION", attemptId, deviceId });
      setExternalAttempt({ attemptId, requestId, deviceId, fingerprint: externalFingerprint, confirmed: true });
      notify.ok("تأكّد الدفع الخارجي", `ثُبّت المرجع ${normalizedReference}`);
    } catch (error) {
      notify.err(error, "تعذّر تأكيد الدفع الخارجي");
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold">تسديد دفعة — {row.invoiceNumber}</h3>
        <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          <span className="text-muted-foreground">المتبقّي على الفاتورة</span>
          <span className="font-extrabold tabular-nums" dir="ltr">{fmt(remaining)} د.ع</span>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">المبلغ المقبوض</Label>
          <MoneyInput value={amount} onChange={setAmount} ariaLabel="مبلغ الدفعة" className="h-10 text-sm font-bold" />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              { v: "CASH", label: "نقدي" },
              { v: "CARD", label: "بطاقة" },
              { v: "TRANSFER", label: "تحويل" },
              { v: "WALLET", label: "محفظة" },
              { v: "TELECOM", label: "رصيد زين" },
            ] as const
          ).map((p) => (
            <button
              key={p.v}
              type="button"
              onClick={() => {
                if (!isPosPaymentMethodEnabled(p.v)) return;
                setMethod(p.v);
                setReference("");
                setExternalAttempt(null);
                setTelecomConfirmed(false);
              }}
              disabled={!isPosPaymentMethodEnabled(p.v)}
              aria-describedby={!isPosPaymentMethodEnabled(p.v) ? "reception-collection-external-disabled" : undefined}
              title={isPosPaymentMethodEnabled(p.v) ? p.label : posPaymentRejectionMessage(p.v)}
              className={cn(
                "min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-lg border-2 px-2 text-xs font-extrabold",
                method === p.v
                  ? "border-primary bg-primary text-primary-foreground"
                  : isPosPaymentMethodEnabled(p.v)
                    ? "bg-card hover:bg-muted"
                    : "cursor-not-allowed bg-muted/40 text-muted-foreground/45",
              )}
            >
              {p.v === "CARD" && <CardBrandLogos size="xs" />}
              <span>{p.label}</span>
            </button>
          ))}
        </div>
        <p id="reception-collection-external-disabled" className="text-[10px] leading-relaxed text-muted-foreground">
          {INBOUND_TELECOM_DISABLED_MESSAGE}
        </p>
        {needRef && method !== "TELECOM" && (
          <PaymentReferenceField
            value={reference}
            onChange={(value) => {
              setReference(value);
              setExternalAttempt(null);
            }}
            method={method}
            confirmed={externalConfirmed}
            confirming={initiateExternal.isPending || confirmExternal.isPending}
            onConfirm={confirmReceptionExternalPayment}
            inputId="reception-invoice-pay-reference"
            colors={{
              border: "var(--border)",
              muted: "var(--muted)",
              mutedFg: "var(--muted-foreground)",
              fg: "var(--foreground)",
              amber: "var(--sem-warn)",
              success: "var(--sem-pos)",
            }}
          />
        )}
        {method === "TELECOM" && (
          <Input
            value={reference}
            onChange={(e) => { setReference(e.target.value); setTelecomConfirmed(false); }}
            placeholder="أرقام كارت شحن زين (الكود)"
            className="h-9 text-xs"
            dir="ltr"
          />
        )}
        {method === "TELECOM" && (
          <label className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--sem-warn)]">
            <input
              type="checkbox"
              checked={telecomConfirmed}
              onChange={(e) => setTelecomConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            <span>تحقّقتُ أنّ الرصيد وصل فعلاً</span>
          </label>
        )}
        <p className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--sem-warn)]">
          <Banknote aria-hidden className="me-1 inline size-3.5" />
          {method === "CASH" ? (
            <>
              سيدخل المبلغ <span className="underline">درجك أنت</span>
              {currentShiftId ? ` — وردية #${currentShiftId}` : " (لا وردية مفتوحة — النقدي سيُرفض)"}{" "}
              · {branchName}
            </>
          ) : (
            <>
              يُسجَّل على ورديتك{currentShiftId ? ` #${currentShiftId}` : ""} · {branchName}
            </>
          )}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
          <Button
            className="flex-1"
            disabled={
              !actions.canCollect ||
              collect.isPending ||
              D(amount || 0).lte(0) ||
              (needRef && !reference.trim()) ||
              !externalConfirmed ||
              (method === "TELECOM" && !telecomConfirmed)
            }
            onClick={() => {
              payWinRef.current = preopenDocumentWindow();
              collect.mutate({
                invoiceId: Number(row.id),
                amount: round2(D(amount)).toFixed(2),
                method,
                reference: needRef ? reference.trim() : undefined,
                ...(method === "CASH"
                  ? {}
                  : {
                      externalPaymentAttemptId: externalAttempt?.attemptId ?? undefined,
                      externalPaymentDeviceId: externalAttempt?.deviceId ?? undefined,
                    }),
                clientRequestId,
              });
            }}
          >
            {collect.isPending ? "جارٍ التسديد…" : "تأكيد التسديد"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StaffReturnRequestForm({ row, onClose }: { row: Row; onClose: () => void }) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canRequest = receptionInvoiceActions(me.data).canRequestReturn;
  const detail = trpc.sales.get.useQuery({ invoiceId: Number(row.id) }, { enabled: canRequest });
  const [qty, setQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState("تراجع الزبون");

  const req = trpc.returns.request.useMutation({
    onSuccess: (r) => {
      notify.ok("أُرسل طلب المرتجع", `طلب #${r.requestId} بانتظار موافقة المدير.`);
      void utils.returns.requests.invalidate();
      onClose();
    },
    onError: (e) => notify.err(e),
  });

  const items = (detail.data?.items ?? [])
    .map((it) => ({
      id: Number(it.id),
      name: it.productName ?? it.sku ?? `بند ${it.id}`,
      remaining: Number(it.baseQuantity) - Number(it.returnedBaseQuantity ?? 0),
    }))
    .filter((it) => it.remaining > 0);

  const lines = items
    .map((it) => ({
      invoiceItemId: it.id,
      baseQuantity: Math.min(qty[it.id] ?? it.remaining, it.remaining),
    }))
    .filter((l) => l.baseQuantity > 0);
  const canSubmit = canRequest && lines.length > 0 && reason.trim().length >= 3 && !req.isPending;

  return (
    <>
      <p className="text-xs text-muted-foreground">
        حدّد الأصناف المرتجعة واضغط إرسال لاعتمادها من المدير.
      </p>
      {detail.isLoading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">جارٍ تحميل البنود…</p>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">لا توجد بنود متبقية للإرجاع.</p>
      ) : (
        <div className="max-h-52 space-y-1.5 overflow-y-auto">
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-2 rounded-lg border p-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-bold">{it.name}</div>
                <div className="text-[10px] text-muted-foreground">المتبقّي: {it.remaining}</div>
              </div>
              <Input
                type="number"
                min={0}
                max={it.remaining}
                value={qty[it.id] ?? it.remaining}
                onChange={(e) =>
                  setQty((prev) => ({
                    ...prev,
                    [it.id]: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
                className="h-8 w-20 text-center tabular-nums"
                aria-label={`كمية إرجاع ${it.name}`}
              />
            </div>
          ))}
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="ret-reason" className="text-xs">السبب</Label>
        <Input
          id="ret-reason"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder="سبب المرتجع"
          className="h-9"
        />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
        <Button
          className="flex-1"
          disabled={!canSubmit}
          onClick={() => req.mutate({ invoiceId: Number(row.id), lines, reason: reason.trim() })}
        >
          {req.isPending ? "جارٍ الإرسال…" : "إرسال للمدير"}
        </Button>
      </div>
    </>
  );
}

export default ReceptionInvoiceQueue;
