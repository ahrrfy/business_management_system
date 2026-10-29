import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { MapPin, Phone, Printer, RotateCcw, ScanBarcode, Truck } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { RowActions } from "@/components/list";
import { DispatchDialog } from "@/components/delivery/DispatchDialog";
import {
  DeliveryDepartureOverlay,
  type DeliveryDepartureData,
} from "@/components/delivery/DeliveryDepartureOverlay";
import { notify } from "@/lib/notify";
import { playReadyBeep } from "@/lib/notifyBeep";
import { D, fmt, positiveDiff } from "@/lib/money";
import type { DeliverySourceReference } from "@shared/deliverySource";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import { filterOperationalRows } from "@/lib/deliveryOperations";
import { cn } from "@/lib/utils";
import { preopenDocumentWindow } from "@/lib/printing/print";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import {
  printDeliverySlip,
  printReadyOrderLabel,
} from "@/lib/printing/deliveryDocs";
import {
  buildCourierAssignmentMessage,
  buildCustomerDispatchMessage,
  buildWorkOrderStatusMessage,
  openWhatsApp,
} from "@/lib/whatsapp";

type ReadyOrder = RouterOutputs["delivery"]["readyForDispatch"][number];

// ───────────────────────── تبويب: جاهز للإرسال ─────────────────────────
export function DeliveryReadyForDispatchTab() {
  const utils = trpc.useUtils();
  const ready = trpc.delivery.readyForDispatch.useQuery(undefined, { refetchOnWindowFocus: true });
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true }, { refetchOnWindowFocus: true });
  const me = trpc.auth.me.useQuery();
  const canDispatch = useOperationPermission("delivery.dispatch").allowed;
  const canDispatchByBarcode = useOperationPermission("delivery.dispatchByBarcode").allowed;
  const [target, setTarget] = useState<ReadyOrder | null>(null);
  const [query, setQuery] = useState("");
  const [departureData, setDepartureData] = useState<DeliveryDepartureData | null>(null);

  // كشفُ الطلبات الجديدة بين استعلامَين متتاليَين (Slice A، ٢٩/٨/٢٦) — بلاغ المالك: «الطلب انجزة
  // فني المطبعة وحوّله لجاهز، لا شي يظهر ولا شي يلاحظه موظّفو الاستقبال والتوصيل». تبويب Dispatch
  // يعتمد `readyForDispatch` (READY + hasDelivery ولا إرسالية بعد) — أي طلبٍ يظهر فيه لأوّل مرّة
  // هو *بالتحديد* حالةٌ تحتاج فعلاً بشرياً. نفس نمط ReceptionOrderQueue حرفياً.
  const knownReadyRef = useRef<Set<number>>(new Set());
  const firstLoadRef = useRef<boolean>(true);
  useEffect(() => {
    const rows = ready.data;
    if (!rows) return;
    const currentIds = new Set<number>();
    for (const r of rows) currentIds.add(Number(r.id));
    if (firstLoadRef.current) {
      knownReadyRef.current = currentIds;
      firstLoadRef.current = false;
      return;
    }
    const freshIds: number[] = [];
    Array.from(currentIds).forEach((id) => {
      if (!knownReadyRef.current.has(id)) freshIds.push(id);
    });
    knownReadyRef.current = currentIds;
    if (freshIds.length > 0) {
      const freshRows = rows.filter((r) => freshIds.includes(Number(r.id)));
      const first = freshRows[0]!;
      const suffix = freshRows.length > 1 ? ` (و${freshRows.length - 1} طلب/طلبات أخرى)` : "";
      notify.info(
        `طلب جاهز للإرسال: ${first.orderNumber}${suffix}`,
        first.customerName ? `العميل: ${first.customerName}` : undefined,
      );
      playReadyBeep();
    }
  }, [ready.data]);

  const dispatch = trpc.delivery.dispatch.useMutation({
    onSuccess: (r, variables) => {
      // Slice M (٣٠/٨/٢٦): تفاصيل الإسناد للمندوب بضغطةٍ من التوست — يفتح واتساب برسالةٍ مُعدّة.
      // الجهة تُلتقط بـpartyId المُرسَل + قائمة parties الحيّة (لا استعلام إضافيّ).
      const dispatchedParty = parties.data?.find((p) => Number(p.id) === Number(variables.partyId));
      const dispatchedOrder = target; // النافذة لا تُغلَق حتى إتمام دورة onSuccess.
      const courierPhone = dispatchedParty?.phone;
      const canSendWhatsapp = !!courierPhone && !!dispatchedOrder;
      notify.ok(
        "أُرسل عبر المندوب",
        `إرسالية ${r.consignmentNumber} — COD ${fmt(r.codAmount)} د.ع`,
        canSendWhatsapp
          ? {
              label: "أرسل تفاصيل واتساب",
              onClick: () => {
                openWhatsApp(
                  courierPhone!,
                  buildCourierAssignmentMessage({
                    consignmentNumber: r.consignmentNumber,
                    orderNumber: dispatchedOrder!.orderNumber,
                    title: dispatchedOrder!.title,
                    customerName: dispatchedOrder!.customerName,
                    customerPhone: dispatchedOrder!.deliveryPhone ?? dispatchedOrder!.customerPhone,
                    deliveryAddress: dispatchedOrder!.deliveryAddress,
                    codAmount: r.codAmount,
                    deliveryFee: r.deliveryFee,
                    feeCollection: dispatchedOrder!.deliveryFeeCollection ?? "COURIER",
                  }),
                );
              },
            }
          : undefined,
      );
      // Slice N (٣٠/٨/٢٦): توست ثانٍ للعميل — يعرف مَن يُوصِل طلبَه ورقم هاتفه (لا يفاجَأ برقم غريب).
      // ينفصل عن التوست الأوّل كي لا نُفقد الموظّف زرَّ المندوب حين يُغلق العميل من غير عمد.
      const customerPhone = dispatchedOrder?.deliveryPhone ?? dispatchedOrder?.customerPhone;
      if (customerPhone && dispatchedParty && dispatchedOrder) {
        notify.info(
          "أعلم العميل بالمندوب",
          `اضغط للإرسال — ${dispatchedOrder.customerName ?? "العميل"} يعرف مَن يُوصِل طلبَه`,
        );
        // نمرّر الزرّ في التوست الثاني (info بدل ok كي يتمايز بصرياً — الأوّل نجاح، الثاني إجراءٌ اختياريّ).
        setTimeout(() => {
          notify.ok(
            `أعلم ${dispatchedOrder.customerName ?? "العميل"} بالمندوب`,
            `${dispatchedParty.name} — ${dispatchedParty.phone ?? "بلا هاتف"}`,
            {
              label: "أرسل واتساب للعميل",
              onClick: () => {
                openWhatsApp(
                  customerPhone,
                  buildCustomerDispatchMessage({
                    orderNumber: dispatchedOrder.orderNumber,
                    title: dispatchedOrder.title,
                    customerName: dispatchedOrder.customerName,
                    courierName: dispatchedParty.name,
                    courierPhone: dispatchedParty.phone,
                    codAmount: r.codAmount,
                    deliveryFee: r.deliveryFee,
                    feeCollection: dispatchedOrder.deliveryFeeCollection ?? "COURIER",
                  }),
                );
              },
            },
          );
        }, 400);
      }
      setTarget(null);
      utils.delivery.readyForDispatch.invalidate();
      utils.delivery.listParties.invalidate();
      utils.delivery.consignments.invalidate();
      utils.delivery.openConsignments.invalidate();
      utils.delivery.inTransit.invalidate();
      utils.delivery.obligations.invalidate();
      utils.workOrders.list.invalidate();
      utils.workOrders.counts.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const allRows = ready.data ?? [];
  const rows = useMemo(() => filterOperationalRows(allRows, query), [allRows, query]);

  const readyColumns = useMemo<ColumnDef<ReadyOrder, unknown>[]>(
    () => [
      { id: "orderNumber", header: "رقم الطلب", accessorFn: (o) => o.orderNumber, meta: { kind: "code", width: "id" }, cell: ({ row }) => <span className="font-medium">{row.original.orderNumber}</span> },
      {
        id: "title",
        header: "العنوان",
        accessorFn: (o) => o.title,
        /* عنوانُ أمر الشغل نصٌّ حرّ طويل — `wrap` يُبقيه على أسطرٍ كما كان في الجدول الخامّ. */
        meta: { width: "wide", wrap: true },
        cell: ({ row }) => (
          <>
            {row.original.title}
            {row.original.sourceType === "ONLINE_ORDER" ? (
              <Badge variant="outline" className="ms-2 border-primary text-primary font-bold">متجر</Badge>
            ) : (
              row.original.hasDelivery && <Badge variant="secondary" className="ms-2">توصيل</Badge>
            )}
          </>
        ),
      },
      {
        id: "customer",
        header: "العميل",
        accessorFn: (o) => o.customerName ?? "عميل نقدي",
        cell: ({ row }) => {
          const o = row.original;
          const phone = o.deliveryPhone ?? o.customerPhone;
          const addr = o.deliveryAddress;
          return (
            <div className="flex flex-col text-xs gap-0.5">
              <span className="font-semibold text-foreground">{o.customerName ?? "عميل نقدي"}</span>
              {phone && (
                <span className="inline-flex items-center gap-1 font-mono text-muted-foreground" dir="ltr">
                  <Phone className="size-3 text-muted-foreground" />
                  <span>{phone}</span>
                </span>
              )}
              {addr && (
                <span className="inline-flex items-center gap-1 text-muted-foreground truncate max-w-[200px]" title={addr}>
                  <MapPin className="size-3 text-muted-foreground shrink-0" />
                  <span className="truncate">{addr}</span>
                </span>
              )}
            </div>
          );
        },
      },
      { id: "salePrice", header: "سعر البيع", accessorFn: (o) => fmt(o.salePrice), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.salePrice) },
      {
        id: "deposit",
        header: "العربون",
        accessorFn: (o) => (D(o.deposit).isPositive() ? fmt(o.deposit) : "—"),
        meta: { kind: "money" },
        cell: ({ row }) => <span className="text-money-positive">{D(row.original.deposit).isPositive() ? fmt(row.original.deposit) : "—"}</span>,
      },
      {
        id: "cod",
        header: "مبلغ التحصيل (COD)",
        accessorFn: (o) => fmt(positiveDiff(o.salePrice, o.deposit).toFixed(2)),
        meta: { kind: "money" },
        cell: ({ row }) => <span className="font-bold">{fmt(positiveDiff(row.original.salePrice, row.original.deposit).toFixed(2))}</span>,
      },
      {
        id: "actions",
        header: "إجراء",
        enableSorting: false,
        meta: { kind: "actions" },
        cell: ({ row }) => {
          const o = row.original;
          const cod = positiveDiff(o.salePrice, o.deposit).toFixed(2);
          return (
            <RowActions
              mode="inline"
              contact={{
                phone: o.deliveryPhone ?? o.customerPhone,
                alternativePhones: [o.customerPhone],
                label: `واتساب ${o.customerName ?? "المستلم"}`,
                message: buildWorkOrderStatusMessage({
                  orderNumber: o.orderNumber,
                  title: o.title,
                  status: "READY",
                  customerName: o.customerName,
                  quantity: o.quantity,
                  dueDate: o.dueDate ? String(o.dueDate) : null,
                  amountDue: cod,
                  // Slice E (٢٩/٨/٢٦): تمرير الأجرة وطريقة القبض ⇒ رسالةٌ صادقة عن الإجماليّ.
                  hasDelivery: o.hasDelivery,
                  deliveryFee: o.deliveryCost ?? "0",
                  deliveryFeeCollection: o.deliveryFeeCollection ?? "COURIER",
                }),
                gate: { module: "store", level: "READ" },
              }}
              actions={[
                {
                  key: "label",
                  kind: "print",
                  label: "ملصق",
                  icon: Printer,
                  onSelect: () => void printReadyOrderLabel(o),
                  gate: { module: "store", level: "READ" },
                },
                {
                  key: "dispatch",
                  kind: "approve",
                  label: "تسليم لمندوب",
                  hidden:
                    o.sourceType === "ONLINE_ORDER"
                      ? !canDispatchByBarcode
                      : !canDispatch,
                  onSelect: () => setTarget(o),
                  gate: {
                    roles: ["cashier", "manager"],
                    module: "store",
                    level: "FULL",
                    operations: [
                      o.sourceType === "ONLINE_ORDER"
                        ? "delivery.dispatchByBarcode"
                        : "delivery.dispatch",
                    ],
                  },
                },
              ]}
            />
          );
        },
      },
    ],
    [canDispatch, canDispatchByBarcode],
  );

  const dispatchByBarcodeMutation = trpc.delivery.dispatchByBarcode.useMutation();

  /*
   * ⚠️ **بعد `useMemo`** (٢/٩/٢٦): كان هذا الحارس فوقه، فانقلابُ `ready.isError` عند
   * فشل إعادة جلبٍ يُنقص عدد الخطّافات بين تصييرَين وReact يسقط بدل عرض رسالة الخطأ.
   * أمسكه `react-hooks/rules-of-hooks` أوّلَ تشغيلٍ للمُدقّق.
   */
  if (ready.isError) return <ErrorState onRetry={() => ready.refetch()} />;

  return (
    <div className="space-y-4">
      {canDispatchByBarcode && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3.5 sm:px-4">
          <div className="flex items-center gap-2.5">
            <ScanBarcode className="size-5 text-primary shrink-0" aria-hidden />
            <div>
              <p className="text-sm font-bold text-foreground">مسار الإسناد والتحصيل السريع بالباركود</p>
              <p className="text-xs text-muted-foreground">امسح باركود الفواتير (INV)، أوامر الشغل (WO)، أو طلبات المتجر (ORD) في واجهة موحدة.</p>
            </div>
          </div>
          <Button variant="default" size="sm" asChild className="gap-1.5 font-bold">
            <Link href="/delivery?tab=workflow">
              <ScanBarcode className="size-4" aria-hidden />
              سير العمل بالباركود
            </Link>
          </Button>
        </div>
      )}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <span className="text-sm font-bold">الطلبات الجاهزة للتوصيل ({rows.length})</span>
          <div className="flex items-center gap-2">
            <UnifiedSearchInput
              value={query}
              onChange={setQuery}
              placeholder="بحث بالهاتف أو الزبون أو الطلب…"
              aria-label="بحث في الطلبات الجاهزة"
              className="h-8 w-64"
            />
            <Button variant="outline" size="sm" onClick={() => void ready.refetch()} disabled={ready.isFetching}>
              <RotateCcw aria-hidden className={cn("size-3.5", ready.isFetching && "animate-spin")} />
              تحديث
            </Button>
          </div>
        </div>
        {/*
          * موجة الجداول (٢/٩/٢٦): قائمةُ عرضٍ خالصة ⇒ `DataTable`. البحث في ترويسة البطاقة أعلاه
          * (يُغذّي `rows`) ⇒ `searchable={false}` مع `externalFiltersActive` كي لا يُعلن الجدولُ
          * «لا صفوف بعد» بينما الصفوفُ محجوبةٌ بالبحث وحده.
          */}
        <DataTable<ReadyOrder>
          columns={readyColumns}
          data={rows}
          searchable={false}
          externalFiltersActive={query.trim() !== ""}
          loading={ready.isLoading}
          emptyState={<EmptyState icon={Truck} title="لا طلبات جاهزة" description="لا توجد طلبات بحالة «جاهز» للإرسال حالياً." />}
          emptyFilteredState={<EmptyState icon={Truck} title="لا نتائج" description="لا طلبات مطابقة لبحثك." />}
        />
        <DispatchDialog
          order={target}
          parties={parties.data ?? []}
          pending={dispatch.isPending || dispatchByBarcodeMutation.isPending}
          onClose={() => setTarget(null)}
          onConfirm={async ({ partyId, fee, recipientName, recipientPhone, deliveryAddress, notes, assignedUserId, externalTrackingRef }) => {
            const ord = target!;
            if (
              ord.sourceType === "ONLINE_ORDER"
                ? !canDispatchByBarcode
                : !canDispatch
            ) {
              notify.err("عملية إسناد التوصيل غير مفوضة لحسابك");
              return;
            }
            const party = (parties.data ?? []).find((p) => p.id === partyId);
            const labelWin = preopenShippingLabelWindow();
            const slipWin = preopenDocumentWindow();
            try {
              let r: DeliverySourceReference & {
                consignmentNumber: string;
                codAmount: string;
                invoiceNumber?: string | null;
                deliveryFee: string;
                feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
                recipientName?: string | null;
                recipientPhone?: string | null;
                deliveryAddress?: string | null;
              };
              if (ord.sourceType === "ONLINE_ORDER") {
                const res = await dispatchByBarcodeMutation.mutateAsync({
                  barcode: ord.orderNumber,
                  partyId,
                  deliveryFee: fee || undefined,
                  recipientName: recipientName || undefined,
                  recipientPhone: recipientPhone || undefined,
                  deliveryAddress: deliveryAddress || ord.deliveryAddress || undefined,
                  notes: notes || undefined,
                  assignedUserId,
                  externalTrackingRef: externalTrackingRef || undefined,
                  clientRequestId: crypto.randomUUID(),
                });
                r = {
                  ...res,
                  sourceType: res.sourceType,
                  invoiceNumber: res.invoiceNumber,
                };
              } else {
                r = await dispatch.mutateAsync({
                  workOrderId: ord.id,
                  partyId,
                  deliveryFee: fee,
                  recipientName: recipientName || undefined,
                  recipientPhone: recipientPhone || undefined,
                  deliveryAddress: deliveryAddress || ord.deliveryAddress || undefined,
                  notes: notes || undefined,
                  clientRequestId: crypto.randomUUID(),
                  assignedUserId,
                  externalTrackingRef: externalTrackingRef || undefined,
                });
              }
              const dispatchedOrder = {
                ...ord,
                customerName: "recipientName" in r ? r.recipientName ?? null : (recipientName || ord.customerName),
                customerPhone: "recipientPhone" in r ? r.recipientPhone ?? null : (recipientPhone || ord.deliveryPhone || ord.customerPhone),
                deliveryAddress: "deliveryAddress" in r ? r.deliveryAddress ?? null : (deliveryAddress || ord.deliveryAddress),
                deliveryCost: r.deliveryFee,
                deliveryFeeCollection: r.feeCollection ?? ord.deliveryFeeCollection ?? "COURIER",
              };
              void printReadyOrderLabel(dispatchedOrder, { partyName: party?.name ?? null, trackingNumber: r.consignmentNumber, cod: r.codAmount, externalTrackingRef: externalTrackingRef || undefined, into: labelWin });
              printDeliverySlip(dispatchedOrder, party, { ...r, sourceType: r.sourceType ?? ord.sourceType, sourceId: r.sourceId ?? ord.id, feeCollection: dispatchedOrder.deliveryFeeCollection, externalTrackingRef: externalTrackingRef || undefined }, ...(slipWin ? [{ into: slipWin }] : []));
              setDepartureData({
                consignmentNumber: r.consignmentNumber,
                orderNumber: ord.orderNumber,
                title: ord.title,
                customerName: dispatchedOrder.customerName,
                customerPhone: dispatchedOrder.customerPhone,
                deliveryAddress: dispatchedOrder.deliveryAddress,
                courierName: party?.name ?? "المندوب",
                courierPhone: party?.phone,
                codAmount: r.codAmount,
                deliveryFee: r.deliveryFee,
                feeCollection: dispatchedOrder.deliveryFeeCollection,
              });
            } catch {
              labelWin?.close();
              slipWin?.close();
            }
          }}
        />
      </Card>
      <DeliveryDepartureOverlay
        open={!!departureData}
        onClose={() => setDepartureData(null)}
        data={departureData}
      />
    </div>
  );
}
