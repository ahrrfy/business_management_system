// ورشة فواتير محطة خدمة الزبائن — ش١ (docs/reception-cashier-system-design-2026-08-05.md §٨.٥).
//
// «يرى الموظّف الفواتير مثل كاشير التجزئة ويقوم عليها بالإجراءات» — أوّل مطالب المالك:
// طابور keyset بفلاتر (الافتراض «ورديتي» لا يومٌ تقويميّ)، وستّ إجراءاتٍ لكل صفّ كلّها
// إعادة استعمال: إعادة طباعة حرارية (invoiceToReceipt) · A4 · **تسديد دفعة**
// (reception.collectOnInvoice — تدخل درج القابض) · إسناد توصيل · تفاصيل · طلب إرجاع (م٧:
// المرتجع مديريّ؛ الموظّف يستدعي المدير).
//
// محاسبياً: الإسناد لا يُنشئ فاتورةً ثانية ولا يمسّ قيد SALE؛ والتسديد يمرّ بـprocessPayment
// نفسها بحصرٍ بنيويّ (وردية إنشاء الفاتورة RECEPTION) — §٩.٢.
import { useMemo, useState } from "react";
import {
  Banknote,
  FileText,
  HandCoins,
  Printer,
  Receipt,
  RotateCcw,
  Search,
  Truck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { allocateLineTax } from "@/components/invoice";
import type { DispatchParty } from "@/components/delivery/DispatchDialog";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { invoiceToReceipt } from "@/lib/printing/invoiceReceipt";
import { printReceipt } from "@/lib/printing/print";
import { printInvoiceA4 } from "@/lib/printing/printTemplates";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/date";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { INBOUND_TELECOM_DISABLED_MESSAGE } from "@shared/inboundPaymentPolicy";
import { invoiceStatusLabel } from "@shared/invoiceStatus";

type QueueOut = RouterOutputs["reception"]["invoiceQueue"];
type Row = QueueOut["rows"][number];

type RangeChip = "MY_SHIFT" | "TODAY" | "WEEK";
type PayChip = "ALL" | "UNSETTLED" | "CARD";

export function ReceptionInvoiceQueue({
  branchId,
  currentShiftId,
  branchName,
  parties,
  canFulfill,
  isManager,
}: {
  branchId: number;
  /** وردية الاستقبال المفتوحة (رقاقة «ورديتي» + حوار التسديد «سيدخل درجك أنت»). */
  currentShiftId: number | null;
  branchName: string;
  parties: DispatchParty[];
  canFulfill: boolean;
  /** م٧: المرتجع مديريّ — للمدير رابط /returns، ولغيره حوار «استدعِ المدير». */
  isManager: boolean;
}) {
  const utils = trpc.useUtils();
  const [range, setRange] = useState<RangeChip>(currentShiftId ? "MY_SHIFT" : "TODAY");
  const [payChip, setPayChip] = useState<PayChip>("ALL");
  const [search, setSearch] = useState("");
  const debouncedQ = useDebouncedValue(search, 250);
  // صفحات keyset متراكمة (تحميل المزيد) — تُصفَّر عند تغيّر أي فلتر.
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [accRows, setAccRows] = useState<Row[]>([]);

  const queryInput = useMemo(() => {
    const base = {
      branchId,
      q: debouncedQ.trim() || undefined,
      paymentState: payChip === "UNSETTLED" ? ("UNSETTLED" as const) : undefined,
      method: payChip === "CARD" ? ("CARD" as const) : undefined,
      limit: 50,
      cursor,
    };
    if (range === "MY_SHIFT" && currentShiftId) return { ...base, shiftIds: [currentShiftId] };
    return { ...base, sinceDays: range === "TODAY" ? 0 : 7 };
  }, [branchId, debouncedQ, payChip, range, currentShiftId, cursor]);

  const q = trpc.reception.invoiceQueue.useQuery(queryInput, {
    // إبقاء الصفحة الظاهرة أثناء تبديل الفلاتر يمنع وميض جدولٍ فارغ.
    placeholderData: (prev) => prev,
  });

  // دمج صفحات keyset: الصفحة الأولى تستبدل، وصفحات المؤشّر تُلحَق.
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
  const [printingId, setPrintingId] = useState<number | null>(null);
  const taxSettings = trpc.system.getTaxSettings.useQuery(undefined, { staleTime: 300_000 });

  const dispatchInvoice = trpc.delivery.dispatchInvoice.useMutation({
    onSuccess: (r) => {
      notify.ok("أُسنِدت للتوصيل", `إرسالية ${r.consignmentNumber} — تحصيل ${fmt(r.codAmount)} د.ع`);
      setDispatchTarget(null);
      resetPaging();
      void utils.reception.invoiceQueue.invalidate();
      void utils.workOrders.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  /** إعادة الطباعة تتبع نطاق قراءة الفرع لا الملكية (§٨.٥): قراءةٌ محضة من لقطة الفاتورة. */
  async function reprintThermal(row: Row) {
    if (printingId != null) return;
    setPrintingId(Number(row.id));
    try {
      const d = await utils.sales.get.fetch({ invoiceId: Number(row.id) });
      if (!d) { notify.err("تعذّر جلب الفاتورة"); return; }
      const result = await printReceipt(invoiceToReceipt(d));
      if (result.via === "browser") notify.warn("الطابعة المباشرة غير متاحة", "فُتحت نافذة الطباعة البديلة");
      else notify.ok("تمت إعادة الطباعة", `الفاتورة ${d.invoiceNumber}`);
    } catch (e) {
      notify.err(e);
    } finally {
      setPrintingId(null);
    }
  }

  async function printA4(row: Row) {
    try {
      const d = await utils.sales.get.fetch({ invoiceId: Number(row.id) });
      if (!d) { notify.err("تعذّر جلب الفاتورة"); return; }
      const afterDisc = round2(D(d.subtotal).minus(D(d.discountAmount ?? "0"))).toFixed(2);
      const shares = allocateLineTax(
        d.items.map((it) => ({ total: String(it.total) })),
        String(d.taxAmount ?? "0"),
        afterDisc,
      );
      await printInvoiceA4({
        invoiceNumber: d.invoiceNumber,
        invoiceDate: d.invoiceDate,
        customerName: d.customerName,
        salespersonName: d.salespersonName,
        companyTaxId: taxSettings.data?.taxRegistrationNumber ?? null,
        paymentMethod: paymentMethodLabel(d.paymentMethod),
        subtotal: d.subtotal,
        discountAmount: d.discountAmount,
        taxAmount: d.taxAmount,
        taxRate: Number(d.taxRatePercent ?? 0),
        total: d.total,
        paidAmount: d.paidAmount,
        items: d.items.map((it, i) => ({
          productName: it.productName ?? "",
          unitName: it.unitName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          total: it.total,
          taxAmount: shares[i] ?? "0",
        })),
      });
    } catch (e) {
      notify.err(e);
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
      {/* الفلاتر: رقائق النطاق + الدفع + بحث (§٨.٥) */}
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
        <button type="button" className={chip(payChip === "UNSETTLED")} onClick={() => { setPayChip((p) => (p === "UNSETTLED" ? "ALL" : "UNSETTLED")); resetPaging(); }}>
          غير مسدّدة
        </button>
        <button type="button" className={chip(payChip === "CARD")} onClick={() => { setPayChip((p) => (p === "CARD" ? "ALL" : "CARD")); resetPaging(); }}>
          بالبطاقة
        </button>
        <div className="relative ms-auto min-w-44 flex-1 sm:max-w-64">
          <Search aria-hidden className="pointer-events-none absolute inset-y-0 end-2.5 my-auto size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPaging(); }}
            placeholder="رقم الفاتورة أو اسم/هاتف الزبون"
            className="h-8 pe-8 text-xs"
            aria-label="بحث في فواتير المحطة"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && !q.isFetching ? (
          <EmptyState
            icon={Receipt}
            title="لا فواتير ضمن هذا النطاق"
            description="أنجز طلباً من السلة، أو وسّع النطاق إلى اليوم أو ٧ أيام."
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
                <th className="px-2 py-2 text-right font-bold">قَبَضَها</th>
                <th className="px-2 py-2 text-center font-bold">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const remaining = remainingOf(r);
                return (
                  <tr key={String(r.id)} className="border-b align-middle hover:bg-muted/30">
                    <td className="px-2 py-2 font-bold" dir="ltr">
                      {r.invoiceNumber}
                      {r.offlineReceiptNumber && (
                        <div className="text-[9px] font-medium text-muted-foreground">{r.offlineReceiptNumber}</div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground" dir="ltr">
                      {r.invoiceDate
                        ? `${fmtDate(new Date(r.invoiceDate))} ${new Date(r.invoiceDate).toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" })}`
                        : "—"}
                    </td>
                    <td className="px-2 py-2">
                      <div className="max-w-36 truncate font-semibold">
                        {r.customerName ?? r.contactName ?? "عميل نقدي"}
                      </div>
                      {(r.customerPhone ?? r.contactPhone) && (
                        <div className="text-[10px] text-muted-foreground" dir="ltr">{r.customerPhone ?? r.contactPhone}</div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center font-bold tabular-nums" dir="ltr">{fmt(r.total)}</td>
                    <td className="px-2 py-2 text-center tabular-nums" dir="ltr">{fmt(r.paidAmount ?? "0")}</td>
                    <td className={cn("px-2 py-2 text-center font-extrabold tabular-nums", remaining > 0 ? "text-[var(--sem-warn)]" : "text-muted-foreground")} dir="ltr">
                      {fmt(remaining)}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <Badge variant={r.status === "PAID" ? "default" : r.status === "PARTIALLY_PAID" ? "secondary" : "outline"} className="text-[10px]">
                        {/* التعريب من المصدر المشترك — السلسلة الشرطية كانت تُسقِط CONFIRMED/CANCELLED/SUPERSEDED
                            إلى `r.status` رمزاً إنجليزياً خاماً في طابور الاستقبال. */}
                        {invoiceStatusLabel(r.status)}
                      </Badge>
                    </td>
                    <td className="px-2 py-2">
                      {r.consignmentNumber ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold">
                          <Truck aria-hidden className="size-3" />
                          {r.consignmentNumber}
                          <span className="text-muted-foreground">· {r.partyName ?? "مندوب"}</span>
                          <span className="text-muted-foreground">
                            {r.consignmentStatus === "DELIVERED" ? "(سُلِّمت)" : r.consignmentStatus === "PARTIAL" ? "(جزئي)" : "(بالطريق)"}
                          </span>
                        </span>
                      ) : r.workOrderId ? (
                        <span className="text-[10px] text-muted-foreground">طلب {r.workOrderNumber}</span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">كاونتر</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-[10px] text-muted-foreground">
                      {r.lastCollectorName ?? r.createdByName ?? "—"}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-center gap-1">
                        {/* بالطريق مع المندوب ⇒ التحصيل عبر توريده لا الدرج (مرآة حارس الخادم — مراجعة ٥/٨) */}
                        {remaining > 0 && r.consignmentStatus !== "DISPATCHED" && r.consignmentStatus !== "PARTIAL" && (
                          <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => setCollectTarget(r)}>
                            <HandCoins aria-hidden className="size-3 me-1" /> تسديد
                          </Button>
                        )}
                        {remaining > 0 && (r.consignmentStatus === "DISPATCHED" || r.consignmentStatus === "PARTIAL") && (
                          <span className="inline-flex h-7 items-center rounded-md border border-dashed px-1.5 text-[10px] text-muted-foreground" title="الفاتورة بالطريق مع المندوب — التحصيل عبر توريد المندوب">
                            مع المندوب
                          </span>
                        )}
                        <Button size="sm" variant="outline" className="h-7 px-1.5" title="إعادة طباعة حرارية" aria-label={`إعادة طباعة الفاتورة ${r.invoiceNumber}`} disabled={printingId != null} onClick={() => void reprintThermal(r)}>
                          <Printer aria-hidden className="size-3" />
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 px-1.5" title="طباعة A4" aria-label={`طباعة A4 للفاتورة ${r.invoiceNumber}`} onClick={() => void printA4(r)}>
                          <FileText aria-hidden className="size-3" />
                        </Button>
                        {!r.consignmentId && canFulfill && (
                          <Button size="sm" variant="outline" className="h-7 px-1.5" title="إسناد للتوصيل" aria-label={`إسناد الفاتورة ${r.invoiceNumber} للتوصيل`} onClick={() => setDispatchTarget(r)}>
                            <Truck aria-hidden className="size-3" />
                          </Button>
                        )}
                        <a
                          href={`/invoices/${r.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-7 items-center rounded-md border bg-card px-1.5 text-[10px] font-bold hover:bg-muted"
                          title="التفاصيل الكاملة (تبويب جديد — سلّتك محفوظة)"
                        >
                          تفاصيل
                        </a>
                        {r.status !== "RETURNED" && r.status !== "CANCELLED" && (
                          <Button size="sm" variant="ghost" className="h-7 px-1.5 text-[10px] text-muted-foreground" title="طلب إرجاع" onClick={() => setReturnTarget(r)}>
                            <RotateCcw aria-hidden className="size-3" />
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

      {/* §٨.٥ — سطرٌ ثابت بدل زرّ تعديلٍ يكذب: الفاتورة المثبَّتة لا تُعدَّل. */}
      <div className="flex-shrink-0 border-t bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
        الفاتورة المُثبَّتة لا تُعدَّل — التصحيح بمرتجعٍ (المدير) أو بتصحيح ملاحظات/استحقاق من شاشة التفاصيل.
      </div>

      {collectTarget && (
        <CollectPaymentDialog
          row={collectTarget}
          remaining={remainingOf(collectTarget)}
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

      {dispatchTarget && (
        <InvoiceDispatchDialog
          row={dispatchTarget}
          parties={parties}
          pending={dispatchInvoice.isPending}
          onClose={() => setDispatchTarget(null)}
          onConfirm={(args) =>
            dispatchInvoice.mutate({
              invoiceId: Number(dispatchTarget.id),
              partyId: args.partyId,
              deliveryFee: args.deliveryFee,
              feeCollection: args.feeCollection,
              recipientName: args.recipientName,
              recipientPhone: args.recipientPhone,
              deliveryAddress: args.deliveryAddress,
              assignedUserId: args.assignedUserId,
              clientRequestId: `dispinv-${dispatchTarget.id}-${Date.now()}`,
            })
          }
        />
      )}

      {returnTarget && (
        <ReturnRequestDialog
          row={returnTarget}
          isManager={isManager}
          onClose={() => setReturnTarget(null)}
        />
      )}
    </section>
  );
}

/** تسديد دفعة — ح٥ (V8): يسمّي الدرج صراحةً («سيدخل درجك أنت») ويولّد مفتاح idempotency لكل فتح. */
function CollectPaymentDialog({
  row,
  remaining,
  currentShiftId,
  branchName,
  onClose,
  onDone,
}: {
  row: Row;
  remaining: number;
  currentShiftId: number | null;
  branchName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(String(remaining));
  const [method, setMethod] = useState<"CASH" | "CARD" | "TRANSFER" | "WALLET" | "TELECOM">("CASH");
  const [reference, setReference] = useState("");
  const [telecomConfirmed, setTelecomConfirmed] = useState(false);
  const [clientRequestId] = useState(() => crypto.randomUUID());

  const collect = trpc.reception.collectOnInvoice.useMutation({
    onSuccess: (r) => {
      notify.ok(
        `سُدِّدت دفعة على ${row.invoiceNumber}`,
        method === "CASH" && r.collectedIntoShiftId
          ? `دخل المبلغ درج ورديتك #${r.collectedIntoShiftId}`
          : r.collectedIntoShiftId
            ? `سُجِّلت على ورديتك #${r.collectedIntoShiftId} — لا تدخل درج النقد`
            : undefined,
      );
      onDone();
    },
    onError: (e) => notify.err(e),
  });

  const needRef = method !== "CASH";
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
                setTelecomConfirmed(false);
              }}
              disabled={!isPosPaymentMethodEnabled(p.v)}
              aria-describedby={!isPosPaymentMethodEnabled(p.v) ? "reception-collection-external-disabled" : undefined}
              title={isPosPaymentMethodEnabled(p.v) ? p.label : posPaymentRejectionMessage(p.v)}
              className={cn(
                "min-h-[40px] rounded-lg border-2 text-xs font-extrabold",
                method === p.v
                  ? "border-primary bg-primary text-primary-foreground"
                  : isPosPaymentMethodEnabled(p.v)
                    ? "bg-card hover:bg-muted"
                    : "cursor-not-allowed bg-muted/40 text-muted-foreground/45",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p id="reception-collection-external-disabled" className="text-[10px] leading-relaxed text-muted-foreground">
          {INBOUND_TELECOM_DISABLED_MESSAGE}
        </p>
        {needRef && (
          <Input
            value={reference}
            onChange={(e) => { setReference(e.target.value); if (method === "TELECOM") setTelecomConfirmed(false); }}
            placeholder={
              method === "CARD" ? "رقم عملية البطاقة"
              : method === "WALLET" ? "رقم عملية المحفظة"
              : method === "TELECOM" ? "أرقام كارت شحن زين (الكود)"
              : "رقم مرجع التحويل"
            }
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
            <span>تحقّقتُ أنّ الرصيد وصل فعلاً — الكود يُقبل مرّةً واحدة ولا يدخل درج النقد</span>
          </label>
        )}
        {/* §٨.٥ — سطرٌ إلزاميّ: shiftIdForCashTx يفرض درج الفاعل، وهذه الشاشة تعلنه بدل أن يُفاجأ عند الإغلاق.
            I15: لغير النقد المبلغ يُسجَّل على الوردية للمحاسبة ولا يدخل الدرج. */}
        <p className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--sem-warn)]">
          <Banknote aria-hidden className="me-1 inline size-3.5" />
          {method === "CASH" ? (
            <>
              سيدخل المبلغ <span className="underline">درجك أنت</span>
              {currentShiftId ? ` — وردية #${currentShiftId}` : " (لا وردية مفتوحة — النقدي سيُرفض)"} · {branchName}
            </>
          ) : (
            <>
              يُسجَّل على ورديتك{currentShiftId ? ` #${currentShiftId}` : ""} للمحاسبة — لا يدخل درج النقد · {branchName}
            </>
          )}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
          <Button
            className="flex-1"
            disabled={collect.isPending || D(amount || 0).lte(0) || (needRef && !reference.trim()) || (method === "TELECOM" && !telecomConfirmed)}
            onClick={() =>
              collect.mutate({
                invoiceId: Number(row.id),
                amount: round2(D(amount)).toFixed(2),
                method,
                reference: needRef ? reference.trim() : undefined,
                clientRequestId,
              })
            }
          >
            {collect.isPending ? "جارٍ التسديد…" : "تأكيد التسديد"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** م٧ — المرتجع مديريّ: المدير يُوجَّه لشاشة المرتجعات، وغيره يستدعي المدير (لا تنفيذ ذاتيّ). */
function ReturnRequestDialog({ row, isManager, onClose }: { row: Row; isManager: boolean; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold">طلب إرجاع — {row.invoiceNumber}</h3>
        {isManager ? (
          <>
            <p className="text-xs text-muted-foreground">
              الإرجاع يعكس مخزوناً وقيوداً ونقداً — تُنفّذه من شاشة المرتجعات بصلاحيتك.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
              <a
                href={`/returns?invoiceId=${row.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex flex-1 items-center justify-center rounded-md bg-primary px-3 text-sm font-bold text-primary-foreground hover:bg-primary/90"
              >
                فتح شاشة المرتجعات
              </a>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-muted-foreground">
              الإرجاع صلاحية <span className="font-bold">مدير</span> (يعكس مخزوناً ونقداً وقيوداً).
              استدعِ المدير وأعطه رقم الفاتورة
              <span className="mx-1 rounded bg-muted px-1.5 py-0.5 font-bold" dir="ltr">{row.invoiceNumber}</span>
              ليُنفّذه من شاشة المرتجعات.
            </p>
            <Button className="w-full" onClick={onClose}>فهمت</Button>
          </>
        )}
      </div>
    </div>
  );
}

function InvoiceDispatchDialog({
  row,
  parties,
  pending,
  onClose,
  onConfirm,
}: {
  row: Row;
  parties: DispatchParty[];
  pending: boolean;
  onClose: () => void;
  onConfirm: (args: {
    partyId: number;
    deliveryFee: string;
    feeCollection: "COURIER" | "COUNTER" | "SHOP";
    recipientName?: string;
    recipientPhone?: string;
    deliveryAddress?: string;
    assignedUserId?: number;
  }) => void;
}) {
  const [partyId, setPartyId] = useState("");
  const [fee, setFee] = useState("0");
  // ش٠ (V15): COUNTER خارج مسار الفاتورة حتى ش٦ — النوع مُضيَّق عمداً ليمسك TypeScript أيّ إرجاعٍ سهويّ.
  const [feeCollection, setFeeCollection] = useState<"COURIER" | "SHOP">("COURIER");
  const [name, setName] = useState(row.customerName ?? row.contactName ?? "");
  const [phone, setPhone] = useState(row.customerPhone ?? row.contactPhone ?? row.deliveryPhone ?? "");
  const [address, setAddress] = useState(row.deliveryAddress ?? "");
  const [assignedUserId, setAssignedUserId] = useState("");
  const remaining = useMemo(
    () => round2(D(row.total).minus(D(row.paidAmount ?? 0)).minus(D(row.returnedTotal ?? 0))).toNumber(),
    [row],
  );
  const party = parties.find((p) => String(p.id) === partyId);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" dir="rtl">
      <div className="w-full max-w-md space-y-3 rounded-2xl bg-card p-4 shadow-2xl">
        <h3 className="text-sm font-extrabold">إسناد الفاتورة {row.invoiceNumber} للتوصيل</h3>

        <div className="space-y-1">
          <Label className="text-[11px]">جهة التوصيل</Label>
          <AppSelect
            value={partyId}
            onValueChange={(v) => {
              setPartyId(v);
              setAssignedUserId("");
              const p = parties.find((x) => String(x.id) === v);
              if (p) setFee(p.defaultFee ?? "0");
            }}
            aria-label="جهة التوصيل"
            placeholder="اختر مندوباً أو شركة"
          >
            <option value="">اختر مندوباً أو شركة</option>
            {parties.map((p) => (
              <option key={p.id} value={String(p.id)}>{p.name}</option>
            ))}
          </AppSelect>
        </div>

        {party?.partyType === "COMPANY" && (party.drivers?.length ?? 0) > 0 && (
          <div className="space-y-1">
            <Label className="text-[11px]">السائق داخل الشركة</Label>
            <AppSelect value={assignedUserId} onValueChange={setAssignedUserId} aria-label="السائق داخل الشركة">
              <option value="">طابور الشركة — يطالب به أول سائق</option>
              {party.drivers?.map((driver) => (
                <option key={driver.userId} value={driver.userId}>{driver.name}</option>
              ))}
            </AppSelect>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[11px]">اسم المستلم</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">هاتف المستلم</Label>
            <IntlPhoneInput value={phone} onChange={setPhone} ariaLabel="هاتف المستلم" className="text-xs" />
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px]">عنوان التوصيل</Label>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} className="h-8 text-xs" />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[11px]">أجرة التوصيل</Label>
            <MoneyInput value={fee} onChange={setFee} ariaLabel="أجرة التوصيل" className="text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">مَن يقبضها؟</Label>
            {/* ش٠ (V15): «مقبوضة في الكاشير» أُزيلت من مسار الفاتورة — لا قبضَ وارد يسبق الإرسال
                هنا (بخلاف أمر الشغل الذي يقبضها لحظة الإنشاء)، فقبولها يُنتج صرفاً للمندوب بلا
                قبضٍ يقابله ⇒ عجزٌ يمنع إغلاق الوردية. الخادم يحظرها أيضاً؛ تعود في ش٦ مع القبض. */}
            <AppSelect
              value={feeCollection}
              onValueChange={(v) => setFeeCollection(v as "COURIER" | "SHOP")}
              aria-label="من يقبض أجرة التوصيل"
            >
              <option value="COURIER">المندوب من الزبون</option>
              <option value="SHOP">على المكتبة</option>
            </AppSelect>
          </div>
        </div>

        {/* شفافية محاسبية صريحة: الأجرة ليست جزءاً ممّا يحصّله المندوب لنا. */}
        <p className="rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
          يحصّل المندوب <span className="font-bold tabular-nums" dir="ltr">{fmt(remaining.toFixed(2))}</span> د.ع
          لصالح المكتبة (المتبقّي على الفاتورة). أجرة التوصيل مبلغٌ مستقلّ لا يدخل الفاتورة ولا الإيراد
          {feeCollection === "SHOP" && " — وتتحمّلها المكتبة كمصروف"}.
        </p>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
          <Button
            className="flex-1"
            disabled={!partyId || pending}
            onClick={() => {
              if (!party) {
                notify.err("اختر جهة التوصيل");
                return;
              }
              onConfirm({
                partyId: Number(partyId),
                deliveryFee: round2(D(fee || 0)).toFixed(2),
                feeCollection,
                recipientName: name.trim() || undefined,
                recipientPhone: phone.trim() || undefined,
                deliveryAddress: address.trim() || undefined,
                assignedUserId: assignedUserId ? Number(assignedUserId) : undefined,
              });
            }}
          >
            {pending ? "جارٍ الإسناد…" : "إسناد وطباعة أوراق التوصيل"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ReceptionInvoiceQueue;
