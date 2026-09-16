import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearch } from "wouter";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  FileCheck2,
  History,
  MessageCircle,
  Phone,
  Printer,
  RotateCcw,
  Send,
  ShieldCheck,
  Truck,
  Undo2,
  Wallet,
  XCircle,
} from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { CashCounter } from "@/components/CashCounter";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { RowActions } from "@/components/list";
import { ShippingLabelSizeSelect } from "@/components/ShippingLabelSizeSelect";
import { DispatchDialog } from "@/components/delivery/DispatchDialog";
import { DeliveryDepartureOverlay, type DeliveryDepartureData } from "@/components/delivery/DeliveryDepartureOverlay";
import { WhatsAppStageActionsMenu } from "@/components/delivery/WhatsAppStageActionsMenu";
import { ConsignmentTimelineDrawer } from "@/components/delivery/ConsignmentTimelineDrawer";
import { ReturnConsignmentDialog, type ReturnConsignmentTarget } from "@/components/delivery/ReturnConsignmentDialog";
import { PartyBoardSection } from "@/components/delivery/PartyBoardSection";
import { DeliverySettleTab } from "@/components/delivery/DeliverySettleTab";
import { CollectConsignmentDialog } from "@/components/delivery/CollectConsignmentDialog";
import { CancelDeliveryAssignmentDialog } from "@/components/delivery/CancelDeliveryAssignmentDialog";
import { StaffConfirmDialog, FailReasonDialog, DeclareReturnDialog, ManualProofDialog } from "@/components/delivery/TransitActionDialogs";
import { BarcodeDispatchStream } from "@/components/delivery/BarcodeDispatchStream";
import { BarcodeReturnStream } from "@/components/delivery/BarcodeReturnStream";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { playReadyBeep } from "@/lib/notifyBeep";
import { fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { type ShortfallReason } from "@shared/shortfallReason";
import { PARTY_EXPOSURE_LABEL_AR } from "@shared/partyExposure";
import { DELIVERY_TERMS as DT } from "@shared/deliveryTerminology";
import { cn } from "@/lib/utils";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { printDeliverySlip, printReadyOrderLabel } from "@/lib/printing/deliveryDocs";
import { buildCourierAssignmentMessage, buildCustomerDispatchMessage, buildWorkOrderStatusMessage, openWhatsApp } from "@/lib/whatsapp";
import {
  CONSIGNMENT_VIEW_AR,
  CONSIGNMENT_VIEW_CLS,
  CONSIGNMENT_VIEW_ORDER,
  deriveConsignmentView,
  type ConsignmentViewKey,
} from "@shared/consignmentView";
import {
  DELIVERY_AGE_CLS,
  DELIVERY_AGE_ESCALATE_HOURS,
  deliveryAgeLevel,
  formatDeliveryAge,
} from "@shared/deliveryAging";

/**
 * إدارة التوصيل (COD) — طاولة عمل لا شاشة عرض (بلاغ المالك ٢٢/٨: «لماذا لا توجد أزرار لتنفيذ
 * كذا؟ لماذا لا يوجد توجيه وإسناد لكي تكون عاملاً حقيقياً للعمل؟»):
 *  - «جاهز للإرسال»: تعيين جهة توصيل + أجرة لطلبٍ جاهز ⇒ إصدار فاتورة COD + عهدة.
 *  - «قيد التوصيل»: طاولة تحكّم بكل انتقالات الطرد المشروعة — خروج جماعي بيد الموظف، إعلان
 *    رجوع، تعذّر، استلام مرتجع، إثبات يدوي، درج زمني كامل.
 *  - «تسوية المناديب»: جدول التزامات الجهات (الأقدم أولاً) + توريد الكشف + صرف الأجور المجمّع.
 */

type ReadyOrder = RouterOutputs["delivery"]["readyForDispatch"][number];
type OpenConsignment = RouterOutputs["delivery"]["openConsignments"]["rows"][number];
type InTransitRow = RouterOutputs["delivery"]["inTransit"]["rows"][number];
/** صفُّ «قيد التوصيل» بعد إلحاق حالة العرض المشتقّة (`deriveConsignmentView`). */
type TransitRow = InTransitRow & { viewKey: ConsignmentViewKey };
type PartyObligation = RouterOutputs["delivery"]["obligations"][number];
type RemittanceRow = RouterOutputs["delivery"]["remittances"][number];

const tabBtn = (active: boolean) =>
  cn(
    "rounded-lg px-4 py-2 text-sm font-bold transition-colors",
    active ? "bg-primary text-primary-foreground" : "border bg-card hover:bg-muted/60",
  );

// م١ PR-C: «board» = لوحة الخمسة أعمدة — الصورة الحيّة لكلّ جهة + «سوِّ اليوم» بتأكيدٍ واحد (PartyBoardSection).
type HubTabKey = "dispatch" | "transit" | "settle" | "board";
function readTabFromSearch(search: string): HubTabKey {
  const t = new URLSearchParams(search).get("tab");
  return t === "transit" ? "transit" : t === "settle" ? "settle" : t === "board" ? "board" : "dispatch";
}

export default function DeliveryHub() {
  /**
   * ٢٣/٨ (Codex P1): `wouter/Link` يُنقّل داخل التطبيق فلا يُعاد mount للمكوّن — كان `tab`
   * يُقرأ من الـURL مرّةً على الـmount فقط، فيبقى «transit» حين ينقر الكاشير «سجّل التحصيل»
   * ولا تُركَّب `SettleTab` أبداً. `useSearch` من wouter يُحدَّث تفاعلياً على كل تنقّل ⇒
   * نُزامن `tab` معه في effect: النقر على الرابط يُظهر الشاشة الصحيحة فوراً، وإدخال التبويب
   * يدوياً يبقى يعمل (setTab يتقدّم على الـeffect للتحديث المحلّيّ الفوريّ).
   */
  const search = useSearch();
  const [tab, setTab] = useState<HubTabKey>(() => readTabFromSearch(search));
  useEffect(() => {
    setTab(readTabFromSearch(search));
  }, [search]);
  /**
   * شارةُ العدّاد: صفحةٌ واحدة (٢٠٠) تكفي عرفاً، ونضع «+» عندما يتجاوز العدد الصفحةَ الأولى
   * حتى لا يقرأ الكاشير رقماً كاذباً بعد الترقيم. الأعداد الدقيقة تحصل في التبويب نفسه.
   */
  const transitFirstPage = trpc.delivery.inTransit.useQuery(undefined, { refetchInterval: 30_000 });
  const transitCount = transitFirstPage.data?.rows.length ?? 0;
  const transitMore = transitFirstPage.data?.hasMore ?? false;
  return (
    <div className="space-y-5 p-4 md:p-6" dir="rtl">
      <PageHeader
        title="إدارة التوصيل"
        description="طاولة قيادة كاملة لدورة حياة الطرد: من الإسناد إلى التسليم إلى التسوية والتحصيل، بلا طلبٍ ضائعٍ أو صامت."
        icon={<Truck className="size-6 text-primary" aria-hidden />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ShippingLabelSizeSelect />
            <Button variant="outline" asChild>
              <Link href="/delivery?tab=parties">جهات التوصيل وذممها</Link>
            </Button>
          </div>
        }
      />
      <div className="flex gap-2">
        <button className={tabBtn(tab === "dispatch")} onClick={() => setTab("dispatch")}>جاهز للإرسال</button>
        <button className={tabBtn(tab === "transit")} onClick={() => setTab("transit")}>
          قيد التوصيل
          {transitCount > 0 && (
            <span className="ms-1.5 rounded-full bg-[var(--sem-warn)] px-1.5 text-[10px] font-black text-background tabular-nums">
              {transitCount}{transitMore ? "+" : ""}
            </span>
          )}
        </button>
        <button className={tabBtn(tab === "settle")} onClick={() => setTab("settle")}>تسوية المناديب</button>
        <button className={tabBtn(tab === "board")} onClick={() => setTab("board")}>اللوحة</button>
      </div>
      {tab === "dispatch" ? <DispatchTab /> : tab === "transit" ? <InTransitTab /> : tab === "board" ? <PartyBoardSection /> : <DeliverySettleTab />}
    </div>
  );
}

// ───────────────────────── تبويب: جاهز للإرسال ─────────────────────────
function DispatchTab() {
  const utils = trpc.useUtils();
  const ready = trpc.delivery.readyForDispatch.useQuery(undefined, { refetchInterval: 20_000, refetchOnWindowFocus: true });
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true }, { refetchInterval: 30_000, refetchOnWindowFocus: true });
  const me = trpc.auth.me.useQuery();
  const canDispatch = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["cashier", "manager"],
    );
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
                    deliveryFee: variables.deliveryFee ?? "0",
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
                    deliveryFee: variables.deliveryFee ?? "0",
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
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ar");
    if (!needle) return allRows;
    return allRows.filter((o) =>
      [o.orderNumber, o.title, o.customerName].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(needle)),
    );
  }, [allRows, query]);

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
      { id: "customer", header: "العميل", accessorFn: (o) => o.customerName ?? "عميل نقدي", cell: ({ row }) => row.original.customerName ?? "عميل نقدي" },
      { id: "salePrice", header: "سعر البيع", accessorFn: (o) => fmt(o.salePrice), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.salePrice) },
      {
        id: "deposit",
        header: "العربون",
        accessorFn: (o) => (Number(o.deposit ?? 0) > 0 ? fmt(o.deposit) : "—"),
        meta: { kind: "money" },
        cell: ({ row }) => <span className="text-money-positive">{Number(row.original.deposit ?? 0) > 0 ? fmt(row.original.deposit) : "—"}</span>,
      },
      {
        id: "cod",
        header: "مبلغ التحصيل (COD)",
        accessorFn: (o) => fmt(String(Math.max(0, Number(o.salePrice) - Number(o.deposit ?? 0)))),
        meta: { kind: "money" },
        cell: ({ row }) => <span className="font-bold">{fmt(String(Math.max(0, Number(row.original.salePrice) - Number(row.original.deposit ?? 0))))}</span>,
      },
      {
        id: "actions",
        header: "إجراء",
        enableSorting: false,
        meta: { kind: "actions" },
        cell: ({ row }) => {
          const o = row.original;
          const cod = Math.max(0, Number(o.salePrice) - Number(o.deposit ?? 0));
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
                  hidden: !canDispatch,
                  onSelect: () => setTarget(o),
                  gate: { roles: ["cashier", "manager"], module: "store", level: "FULL" },
                },
              ]}
            />
          );
        },
      },
    ],
    [canDispatch],
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
      {canDispatch && (
        <BarcodeDispatchStream
          onDispatchSuccess={() => {
            void ready.refetch();
            void utils.delivery.readyForDispatch.invalidate();
            void utils.delivery.inTransit.invalidate();
            void utils.delivery.openConsignments.invalidate();
          }}
        />
      )}
      <div className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <span className="text-sm font-bold">الطلبات الجاهزة للتوصيل ({rows.length})</span>
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="رقم الطلب أو العميل…"
              aria-label="بحث في الطلبات الجاهزة"
              className="h-8 w-56"
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
            const party = (parties.data ?? []).find((p) => p.id === partyId);
            const labelWin = preopenShippingLabelWindow();
            try {
              let r: { consignmentNumber: string; codAmount: string; invoiceNumber?: string | null; deliveryFee: string };
              if (ord.sourceType === "ONLINE_ORDER") {
                const res = await dispatchByBarcodeMutation.mutateAsync({
                  barcode: ord.orderNumber,
                  partyId,
                  deliveryFee: fee || undefined,
                  deliveryAddress: deliveryAddress || ord.deliveryAddress || undefined,
                  notes: notes || undefined,
                  assignedUserId,
                  externalTrackingRef: externalTrackingRef || undefined,
                  clientRequestId: crypto.randomUUID(),
                });
                r = {
                  consignmentNumber: res.consignmentNumber,
                  codAmount: res.codAmount,
                  invoiceNumber: res.invoiceNumber ?? res.sourceNumber,
                  deliveryFee: res.deliveryFee,
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
              void printReadyOrderLabel(ord, { partyName: party?.name ?? null, trackingNumber: r.consignmentNumber, cod: r.codAmount, externalTrackingRef: externalTrackingRef || undefined, into: labelWin });
              printDeliverySlip(ord, party, { ...r, invoiceNumber: r.invoiceNumber ?? ord.orderNumber, externalTrackingRef: externalTrackingRef || undefined });
              setDepartureData({
                consignmentNumber: r.consignmentNumber,
                orderNumber: ord.orderNumber,
                title: ord.title,
                customerName: recipientName || ord.customerName,
                customerPhone: recipientPhone || ord.deliveryPhone || ord.customerPhone,
                deliveryAddress: deliveryAddress || ord.deliveryAddress,
                courierName: party?.name ?? "المندوب",
                courierPhone: party?.phone,
                codAmount: r.codAmount,
                deliveryFee: fee,
                feeCollection: ord.deliveryFeeCollection ?? "COURIER",
              });
            } catch {
              labelWin?.close();
            }
          }}
        />
      </div>
      <DeliveryDepartureOverlay
        open={!!departureData}
        onClose={() => setDepartureData(null)}
        data={departureData}
      />
    </div>
  );
}

// ───────────────────────── تبويب: قيد التوصيل (طاولة عمل) ─────────────────────────
/**
 * الشاشة التي كانت مفقودة (بلاغ المالك ١٨/٨) وتحوّلت الآن إلى **طاولة عمل** (٢٢/٨):
 * كل صف يعرض «الإجراء التالي» الصحيح لحالته، تحديد جماعي لإجراءات الدُفعة (خروج/تعذّر/محضر
 * تسليم)، ودرج زمني بنقرةٍ واحدة على رقم الإرسالية.
 */
function InTransitTab() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  /**
   * Codex P1 #1 (٢٥/٨): تبويبُ «قيد التوصيل» طاولةُ عملٍ يفلتر عليها الكاشير ويأخذ إجراءاتٍ
   * جماعية — إخفاءُ صفوفٍ بالترقيم يعني إجراءً على «الكلّ» ينسى الطرود المُخفاة. نجمع كلّ
   * الصفحات (٥٠٠ لكل نداء) قبل السماح بأيّ فعلٍ يعتمد على القائمة.
   */
  const rows = trpc.delivery.inTransit.useInfiniteQuery(
    { limit: 500 },
    {
      refetchInterval: 20_000,
      refetchOnWindowFocus: true,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  useEffect(() => {
    if (rows.hasNextPage && !rows.isFetchingNextPage) void rows.fetchNextPage();
  }, [rows.hasNextPage, rows.isFetchingNextPage, rows.fetchNextPage]);
  // م١ PR-C: لوحة الجهات تفتح هذا التبويب بفلترٍ وبحثٍ من الرابط (?view=…&q=…) — يُقرآن مرّةً عند التركيب.
  const transitSearch = useSearch();
  const [query, setQuery] = useState(() => new URLSearchParams(transitSearch).get("q") ?? "");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [failTarget, setFailTarget] = useState<{ ids: number[] } | null>(null);
  const [manualProofTarget, setManualProofTarget] = useState<InTransitRow | null>(null);
  const [staffConfirmTarget, setStaffConfirmTarget] = useState<InTransitRow | null>(null);
  const [declareTarget, setDeclareTarget] = useState<InTransitRow | null>(null);
  /** الطردُ المفتوحُ حوارُ إرجاعه — يحمل درجَ الردّ الذي كانت الشاشةُ عاجزةً عن تحديده. */
  const [returnTarget, setReturnTarget] = useState<ReturnConsignmentTarget | null>(null);
  const [collectTarget, setCollectTarget] = useState<InTransitRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{ id: number; number: string } | null>(null);

  const canFulfil = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager", "cashier", "sales_rep"],
    );
  /**
   * ٢٣/٨ (Codex P2 #3): `deliveryCashierProcedure` = `moduleProcedure(["cashier","manager"],"store","FULL")`
   * — لا يشمل `sales_rep`. `canFulfil` أعلاه أوسع (يشمله). إظهارُ زرّ «تم التسليم» عليه
   * كان يُنتج `FORBIDDEN` من الخادم على كل نقرة. مرآةُ بوّابة الخادم حرفياً هنا.
   */
  const canStaffConfirm = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager", "cashier"],
    );
  const isManager = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager"],
    );

  // ── Mutations ──
  const invalidateAll = () => {
    utils.delivery.inTransit.invalidate();
    utils.delivery.obligations.invalidate();
    utils.delivery.listParties.invalidate();
    utils.delivery.openConsignments.invalidate();
    utils.delivery.readyForDispatch.invalidate();
    utils.workOrders.list.invalidate();
  };
  const staffHandover = trpc.delivery.staffHandover.useMutation({
    onSuccess: (r) => {
      const skippedNote = r.skipped.length > 0 ? ` — تُخطّي ${r.skipped.length}` : "";
      notify.ok("خرجت الطرود مع المندوب", `أُخرج ${r.moved} طرداً${skippedNote}`);
      setSelectedIds(new Set());
      invalidateAll();
    },
    onError: (e) => notify.err(e),
  });
  const staffMarkFailed = trpc.delivery.staffMarkFailed.useMutation({
    onSuccess: () => { notify.ok("وُسم متعذّر التسليم"); invalidateAll(); },
    onError: (e) => notify.err(e),
  });
  const declareReturn = trpc.delivery.declareReturn.useMutation({
    onSuccess: (res) => {
      notify.ok("سُجّل رجوعٌ مُعلَن", `تحرّر تحصيلٌ متوقّع ${fmt(res.releasedExposure ?? "0")} د.ع — والبضاعة تنتظر الاستلام والفحص`);
      invalidateAll();
    },
    onError: (e) => notify.err(e),
  });
  const returnCn = trpc.delivery.returnConsignment.useMutation({
    onSuccess: () => { notify.ok("رجع الطرد للمكتبة", "عُكس البيع كاملاً: المخزون والفاتورة وذمّة العميل وعهدة المندوب."); invalidateAll(); },
    onError: (e) => notify.err(e),
  });
  const manualProof = trpc.delivery.manualProof.useMutation({
    onSuccess: () => { notify.ok("سُجّل إثبات التسليم اليدويّ", "أُثبت التسليم بالسلطة الاستثنائية — مُوثَّق في سجلّ التدقيق."); invalidateAll(); setManualProofTarget(null); },
    onError: (e) => notify.err(e),
  });
  const staffConfirm = trpc.delivery.staffConfirm.useMutation({
    onSuccess: () => { notify.ok("تم التسليم", "سُجّل تأكيدُك بالمُسلَّم من المندوب — والنقد صار بذمّته حتى تسويته."); invalidateAll(); setStaffConfirmTarget(null); },
    onError: (e) => notify.err(e),
  });

  // ── Filtering ──
  const [stateFilter, setStateFilter] = useState<ConsignmentViewKey | "ALL">(() => {
    const v = new URLSearchParams(transitSearch).get("view");
    return v && (CONSIGNMENT_VIEW_ORDER as readonly string[]).includes(v) ? (v as ConsignmentViewKey) : "ALL";
  });
  const rowsWithView = useMemo(() => {
    const flat = (rows.data?.pages ?? []).flatMap((p) => p.rows);
    return flat.map((r) => ({
      ...r,
      viewKey: deriveConsignmentView({
        parcelStatus: r.parcelStatus,
        status: "DISPATCHED",
        moneyStatus: r.moneyStatus,
        returnDeclaredAt: r.returnDeclaredAt,
        partyHasPortal: r.partyHasPortal,
      }),
    }));
  }, [rows.data]);
  const filtered = useMemo(() => {
    if (stateFilter === "ALL") return rowsWithView;
    return rowsWithView.filter((r) => r.viewKey === stateFilter);
  }, [rowsWithView, stateFilter]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter((r) =>
      [r.consignmentNumber, r.invoiceNumber, r.orderNumber, r.partyName, r.driverName, r.recipientName, r.customerName, r.recipientPhone, r.returnDeclaredReason, r.address]
        .some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [filtered, query]);

  // ── Counts per view key (صادقة، بحسب الاشتقاق الموحّد) ──
  const counts = useMemo(() => {
    const map = new Map<ConsignmentViewKey, number>();
    for (const r of rowsWithView) map.set(r.viewKey, (map.get(r.viewKey) ?? 0) + 1);
    return map;
  }, [rowsWithView]);

  /**
   * ── Exposure totals — Slice DFP1 (٣٠/٨/٢٦، P1 #3a): يُشتقّان من `list` (نتيجة الفلاتر
   * والبحث)، لا من `rowsWithView` (الأصل الخام). كان الفلتر يُغيّر الصفوف المعروضة فيبقى
   * الرأس يُعلن مسؤوليّة الجهات كلّها — تناقضٌ بصريّ يوجّه المدير لقرارٍ خاطئ.
   * الآن: ما تراه هو ما يُجمَع في الرأس، ويُضاف رأسُ «قيمة البضاعة» بجوار «التحصيل» بلونٍ
   * حذر — طردٌ مدفوعٌ سلفاً بـ500,000 ليس «صفر مسؤوليّة»، والبضاعة بيد المندوب حتى تصل.
   */
  const totals = useMemo(() => {
    const codDue = list.reduce((s, r) => s + Number(r.codDue || 0), 0);
    const goodsValue = list.reduce((s, r) => s + Math.max(0, Number(r.invoiceTotal || 0) - Number(r.invoiceReturnedTotal || 0)), 0);
    return { codDue, goodsValue };
  }, [list]);

  // ── Bulk selection helpers ──
  const eligibleForHandoverIds = list.filter((r) => r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT").map((r) => Number(r.id));
  const selectedList = list.filter((r) => selectedIds.has(Number(r.id)));
  const toggleOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  /**
   * «تحديد كل المرئي» في `DataTable` يمرّ من هنا. الجدولُ يعمل بـ`pageSize={Infinity}`
   * عمداً (Codex P1 #1 أعلاه) ⇒ «المرئي» = كلّ الصفوف بعد الفلتر والبحث، وهو نفسُ نطاق
   * زرّ التحديد الجماعيّ القديم بالضبط — لا طردَ يختفي خلف ترقيمٍ ثمّ يسقط من إجراء الدُفعة.
   */
  const setManySelected = (ids: number[], value: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (value) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  // ── Bulk actions ──
  async function bulkHandover() {
    const ids = selectedList.filter((r) => r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT").map((r) => Number(r.id));
    if (ids.length === 0) { notify.err("لا طرود قابلة للخروج ضمن المحدَّد"); return; }
    const ok = await confirm({
      title: `تأكيد خروج ${ids.length} طرداً مع المندوب`,
      description: "سيُوسَم الطرد «خرج للتوصيل» ويُدوَّن في خطّه الزمنيّ بسلطة موظّف. يُستعمَل حين تُدار الجهةُ بكشفٍ لا ببوّابة سائق.",
      confirmText: "خرجت الطرود",
    });
    if (!ok) return;
    staffHandover.mutate({ consignmentIds: ids, clientRequestId: crypto.randomUUID() });
  }

  const [singleHandoverParty, setSingleHandoverParty] = useState<number | null>(null); // unused reserved

  async function singleHandover(id: number) {
    const ok = await confirm({
      title: `خروج الطرد ${id} مع المندوب`,
      description: "تأكيد التسليم اليدويّ للسائق — يُنقَل «خرج للتوصيل» ويُدوَّن في الخطّ الزمنيّ.",
      confirmText: "خرج",
    });
    if (!ok) return;
    staffHandover.mutate({ consignmentIds: [id], clientRequestId: crypto.randomUUID() });
  }

  async function askDeclareReturn(r: InTransitRow) {
    setDeclareTarget(r);
  }
  /**
   * الحوارُ بدل `confirm()` النصّية: القبولُ وحده لا يكفي — حين يتعدّد الدرج المفتوح يطلب
   * الخادمُ `refundShiftId`، ولم يكن لهذه الشاشة حقلٌ يُعطيه ⇒ إرجاعُ طردٍ مدفوعٍ مستحيل.
   */
  function askReceiveReturn(r: InTransitRow) {
    setReturnTarget({
      consignmentId: r.id,
      label: `الإرسالية ${r.consignmentNumber ?? r.id}`,
    });
  }

  /**
   * أعمدةُ «قيد التوصيل» — موجة الجداول (٢/٩/٢٦). الجدول قائمةُ عرضٍ (أزرارُ الإجراء لا
   * تُعدّل حالةَ صفٍّ محلّية بل تفتح حواراً أو تُرسل طفرة) ⇒ يصحّ عليه `DataTable`.
   * تُعاد بناؤها عند تغيّر الصلاحيات أو أيّ `isPending` كي لا تتجمّد أزرارُ الصفّ مُفعَّلةً
   * أثناء تنفيذ طفرةٍ جارية.
   */
  const transitColumns = useMemo<ColumnDef<TransitRow, unknown>[]>(
    () => [
      {
        id: "consignment",
        header: "الإرسالية / الطلب",
        accessorFn: (r) => [r.consignmentNumber, r.orderNumber ?? r.invoiceNumber].filter(Boolean).join(" · "),
        meta: { width: "wide" },
        cell: ({ row }) => {
          const r = row.original;
          return (
            <>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => setDrawerId(Number(r.id))} className="font-bold tabular-nums text-primary hover:underline" dir="ltr">
                  {r.consignmentNumber}
                </button>
                <span className="rounded bg-muted px-1.5 py-px text-[10px] font-bold text-muted-foreground">
                  {r.sourceType === "WORK_ORDER" ? "أمر شغل" : r.sourceType === "ONLINE_ORDER" ? "طلب متجر" : "فاتورة"}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground" dir="ltr">
                {r.orderNumber ?? r.invoiceNumber ?? `#${r.sourceId}`}
              </div>
            </>
          );
        },
      },
      {
        id: "party",
        header: "الجهة والسائق",
        accessorFn: (r) => [r.partyName ?? "—", r.driverName ?? "بلا سائق مسند"].join(" · "),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <>
              <div className="flex items-center gap-1.5">
                <span className="font-bold">{r.partyName ?? "—"}</span>
                {!r.partyHasPortal && (
                  <span className="rounded bg-[var(--sem-info-bg)] px-1 py-px text-[9px] font-bold text-[var(--sem-info)]" title="جهةٌ تُدار بالكشف — لا بوّابة مندوب">كشف</span>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground">{r.driverName ?? "بلا سائق مسند"}</div>
            </>
          );
        },
      },
      {
        id: "recipient",
        header: "المستلم / العنوان",
        accessorFn: (r) => r.recipientName ?? r.customerName ?? "—",
        cell: ({ row }) => {
          const r = row.original;
          const phone = (r.recipientPhone ?? "").trim();
          return (
            <>
              <div>{r.recipientName ?? r.customerName ?? "—"}</div>
              <div className="text-[11px] text-muted-foreground" dir="ltr">{phone || "—"}</div>
              {r.address && <div className="mt-0.5 max-w-64 truncate text-[10px] text-muted-foreground" title={r.address}>{r.address}</div>}
            </>
          );
        },
      },
      {
        id: "view",
        header: "الحالة",
        accessorFn: (r) => CONSIGNMENT_VIEW_AR[r.viewKey],
        meta: { kind: "status", align: "start", width: "wide", wrap: true },
        cell: ({ row }) => {
          const r = row.original;
          return (
            <>
              <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-extrabold", CONSIGNMENT_VIEW_CLS[r.viewKey])}>
                {CONSIGNMENT_VIEW_AR[r.viewKey]}
              </span>
              {r.returnDeclaredAt != null && (
                <div className="mt-0.5 max-w-56 text-[11px] font-bold text-[var(--sem-warn)]">{r.returnDeclaredReason ?? "بلا سبب"}</div>
              )}
              {r.failureReason && <div className="mt-0.5 max-w-40 text-[11px] text-[var(--sem-danger)]">{r.failureReason}</div>}
            </>
          );
        },
      },
      {
        id: "codDue",
        header: "المطلوب تحصيله",
        accessorFn: (r) => fmt(r.codDue),
        meta: { kind: "money" },
        cell: ({ row }) => <span className="font-black">{fmt(row.original.codDue)}</span>,
      },
      {
        id: "age",
        header: "العمر",
        accessorFn: (r) => formatDeliveryAge(Number(r.ageHours ?? 0)),
        meta: { align: "end", width: "status" },
        /* استثناءٌ مقصود على قاعدة «لا sortingFn»: النصّ يخلط الساعات والأيام («37 س» مقابل
           «5 أيام») فأيّ مقارنةٍ مشتقّة منه تقلب الترتيب — نفرز على الساعات الخام. */
        sortingFn: (a, b) => Number(a.original.ageHours ?? 0) - Number(b.original.ageHours ?? 0),
        cell: ({ row }) => {
          const ageHours = Number(row.original.ageHours ?? 0);
          return (
            <div className="inline-flex items-center gap-1">
              <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-black", DELIVERY_AGE_CLS[deliveryAgeLevel(ageHours)])} dir="ltr">
                {formatDeliveryAge(ageHours)}
              </span>
              {ageHours >= DELIVERY_AGE_ESCALATE_HOURS && (
                <span className="rounded bg-[var(--sem-danger-bg)] px-1 py-px text-[9px] font-bold text-[var(--sem-danger)]" title="طرد متصعَّد لركوده">تصعيد</span>
              )}
            </div>
          );
        },
      },
      {
        id: "nextAction",
        header: "الإجراء التالي",
        enableSorting: false,
        meta: { kind: "actions", align: "start", width: "wide", wrap: true },
        cell: ({ row }) => {
          const r = row.original;
          const rowId = Number(r.id);
          const phone = (r.recipientPhone ?? "").trim();
          return (
            <div className="flex flex-wrap items-center gap-1">
              {/* الإجراء التالي حسب الحالة */}
              {canFulfil && (r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT") && (
                <Button size="sm" variant="outline" title="سلّمتُه للمندوب — يبدأ رحلة التوصيل" disabled={staffHandover.isPending} onClick={() => void singleHandover(rowId)}>
                  <Send aria-hidden className="size-3" /> أعطيتُه للمندوب
                </Button>
              )}
              {/*
                ٢٣/٨ — «تم التسليم» بيد الكاشير: للحالة اليوميّة الشائعة (اتصال المندوب/رسالة)
                — لا يحتاج انتظار كشف الشركة ولا موافقة المدير. سلطةٌ متوسّطة توثَّق باسمك.
              */}
              {canStaffConfirm && (r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT" || r.viewKey === "IN_TRANSIT") && (
                <Button size="sm" variant="default" title="أخبرَني المندوب أنه سلّمه للزبون" disabled={staffConfirm.isPending} onClick={() => setStaffConfirmTarget(r)}>
                  <CheckCircle2 aria-hidden className="size-3" /> تم التسليم
                </Button>
              )}
              {canFulfil && (r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT" || r.viewKey === "IN_TRANSIT") && (
                <Button size="sm" variant="outline" title="لم يستلمه الزبون — نحتاج إعادة محاولة أو إرجاع" disabled={staffMarkFailed.isPending} onClick={() => setFailTarget({ ids: [rowId] })}>
                  <XCircle aria-hidden className="size-3" /> لم يُسلَّم
                </Button>
              )}
              {/*
                ٢٣/٨ — الجسر المفقود: الطرد سُلِّم لكن نقده لم يُورَّد بعد ⇒ زرٌّ واحد
                يفتح نافذة التحصيل والتوريد الفوري وتصفير الذمة مع إمكانية طباعة السند،
                مع خيار الانتقال المباشر لتبويب التسوية.
              */}
              {canFulfil && r.viewKey === "DELIVERED_AWAITING_REMIT" && (
                <>
                  <Button
                    size="sm"
                    variant="default"
                    className="font-bold gap-1"
                    title="قبض النقد من المندوب وإصدار سند التوريد فوراً"
                    onClick={() => setCollectTarget(r)}
                  >
                    <Wallet aria-hidden className="size-3" /> سجّل التحصيل
                  </Button>
                  <Button size="sm" variant="ghost" asChild title="الانتقال إلى تسوية الجهة بالكامل">
                    <Link href={`/delivery?tab=settle&party=${r.partyId}`}>
                      تسوية الجهة
                    </Link>
                  </Button>
                </>
              )}
              {/* إلغاء إسناد الطرد قبل قبوله أو عند تعذّره لإعادته للمخزن أو إعادة التوجيه */}
              {isManager && (r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT" || r.viewKey === "FAILED") && Number(r.collectedAmount ?? 0) === 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  title="إلغاء إسناد الطرد للمندوب وتحرير العهدة وإعادته للفرز"
                  onClick={() => setCancelTarget({ id: rowId, number: r.consignmentNumber ?? String(rowId) })}
                >
                  <Ban aria-hidden className="size-3" /> إلغاء الإسناد
                </Button>
              )}
              {canFulfil && r.viewKey === "FAILED" && r.returnDeclaredAt == null && (
                <Button size="sm" variant="outline" title="الشركة أخبرتنا أنّ الطرد راجعٌ إلينا" disabled={declareReturn.isPending} onClick={() => void askDeclareReturn(r)}>
                  <Undo2 aria-hidden className="size-3" /> الشركة تُرجعه
                </Button>
              )}
              {canFulfil && (r.viewKey === "FAILED" || r.viewKey === "RETURN_DECLARED") && (
                <Button size="sm" variant="outline" title={r.returnDeclaredAt != null ? "وصلت البضاعة للمكتبة وفُحصت — أُعيدها للمخزون" : "وصلت البضاعة للمكتبة — أُعيدها للمخزون"} disabled={returnCn.isPending} onClick={() => void askReceiveReturn(r)}>
                  <RotateCcw aria-hidden className="size-3" /> استلمتُ الرجعة
                </Button>
              )}
              {/*
                ٢٢/٨ (Codex P2 #1): إثبات يدويّ يمرّ عبر `confirmConsignmentDelivery`
                الذي يرتدّ `alreadyDelivered` فوراً على أيّ طردٍ سبق ختمُه.
                ٢٣/٨: تصنيف السلطة صار: كاشير («تم التسليم») → مدير («تأكيد بموافقة مدير»).
                يظهر زرّ المدير كسلطةٍ أعلى لحالاتٍ تحتاج دليلاً مكتوباً موسَّعاً.
              */}
              {isManager && (r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT" || r.viewKey === "IN_TRANSIT") && (
                <Button size="sm" variant="outline" title="سلطةٌ استثنائية للمدير — بدليلٍ مكتوبٍ في التدقيق" disabled={manualProof.isPending} onClick={() => setManualProofTarget(r)}>
                  <ShieldCheck aria-hidden className="size-3" /> تأكيد المدير
                </Button>
              )}
              {phone && (
                <>
                  <Button size="sm" variant="ghost" asChild title="اتصال بالمستلم">
                    <a href={`tel:${phone}`}><Phone aria-hidden className="size-3" /></a>
                  </Button>
                  <WhatsAppStageActionsMenu
                    data={{
                      consignmentNumber: r.consignmentNumber,
                      orderNumber: r.orderNumber ?? r.invoiceNumber,
                      customerName: r.recipientName ?? r.customerName,
                      customerPhone: phone,
                      deliveryAddress: r.address,
                      courierName: r.partyName,
                      codAmount: r.codDue,
                    }}
                    target="customer"
                    size="sm"
                    variant="ghost"
                    iconOnly
                    label="رسائل واتساب للمستلم"
                  />
                </>
              )}
              <Button size="sm" variant="ghost" asChild title="فتح جهة التوصيل وتسويتها">
                <Link href={`/delivery?tab=parties&detail=${r.partyId}`}><Wallet aria-hidden className="size-3" /></Link>
              </Button>
              <Button size="sm" variant="ghost" title="خط زمن الطرد" onClick={() => setDrawerId(rowId)}>
                <History aria-hidden className="size-3" />
              </Button>
            </div>
          );
        },
      },
    ],
    [canFulfil, canStaffConfirm, isManager, staffHandover.isPending, staffMarkFailed.isPending, staffConfirm.isPending, declareReturn.isPending, returnCn.isPending, manualProof.isPending],
  );

  if (rows.isError) return <ErrorState onRetry={() => void rows.refetch()} />;

  return (
    <div className="space-y-4">
      {canFulfil && (
        <BarcodeReturnStream
          onReturnSuccess={() => {
            invalidateAll();
          }}
        />
      )}
      {/* ─── الشريط العلوي: عدّادات صادقة + تعرّض مضاعف + بحث + إجراءات جماعية ─── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-10 items-center gap-1 rounded-lg border bg-muted/40 p-1" role="tablist" aria-label="حالة الطرد">
          <button
            type="button"
            role="tab"
            aria-selected={stateFilter === "ALL"}
            onClick={() => setStateFilter("ALL")}
            className={cn(
              "h-8 rounded-md px-2.5 text-xs font-black transition-colors",
              stateFilter === "ALL" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            الكل <span className="ms-1 tabular-nums opacity-70">{rowsWithView.length}</span>
          </button>
          {CONSIGNMENT_VIEW_ORDER.filter((k) => k !== "CLOSED" && (counts.get(k) ?? 0) > 0).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={stateFilter === k}
              onClick={() => setStateFilter(k)}
              className={cn(
                "h-8 rounded-md px-2.5 text-xs font-black transition-colors",
                stateFilter === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {CONSIGNMENT_VIEW_AR[k]} <span className="ms-1 tabular-nums opacity-70">{counts.get(k) ?? 0}</span>
            </button>
          ))}
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="بحث برقم الإرسالية/الفاتورة/الطلب، أو الجهة أو المستلم أو العنوان…"
          className="h-10 max-w-md"
        />
        <div className="ms-auto flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-md border bg-muted/40 px-2 py-1 font-bold" title="طرودٌ لم تُغلَق ماليّاً بعد (بالطريق أو مُسلَّمة بلا توريد نقدها)">
            طرود مفتوحة: <span className="tabular-nums">{list.length}</span>
          </span>
          <span className="rounded-md border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] px-2 py-1 font-bold text-[var(--sem-warn)]" title="مبالغُ COD المطلوب تحصيلها من العملاء (لا تشمل الأجور)">
            قيد التحصيل من العملاء: <span className="tabular-nums" dir="ltr">{fmt(totals.codDue)}</span> د.ع
          </span>
          <span className="rounded-md border border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)] px-2 py-1 font-bold text-[var(--sem-info)]">
            قيمة البضاعة المفتوحة: <span className="tabular-nums" dir="ltr">{fmt(totals.goodsValue)}</span> د.ع
          </span>
        </div>
      </div>

      {/* ─── شريط الإجراءات الجماعية (يظهر حين يوجد محدَّد) ─── */}
      {selectedIds.size > 0 && canFulfil && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-2 text-sm">
          <span className="font-bold">المحدَّد: <span className="tabular-nums">{selectedIds.size}</span></span>
          <Button size="sm" variant="outline" disabled={staffHandover.isPending || eligibleForHandoverIds.filter((id) => selectedIds.has(id)).length === 0} onClick={bulkHandover}>
            <Send aria-hidden className="size-3.5" /> خرج مع المندوب ({selectedList.filter((r) => r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT").length})
          </Button>
          <Button size="sm" variant="outline" disabled={staffMarkFailed.isPending} onClick={() => setFailTarget({ ids: Array.from(selectedIds) })}>
            <XCircle aria-hidden className="size-3.5" /> علّم متعذّراً
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>مسح التحديد</Button>
        </div>
      )}

      {/*
        * موجة الجداول (٢/٩/٢٦): `pageSize={Infinity}` **شرطٌ لا زينة** — Codex P1 #1 أعلاه:
        * إخفاءُ صفوفٍ خلف ترقيمٍ يجعل «تحديد الكل» ينسى طروداً فيخرج إجراءُ الدُفعة ناقصاً.
        * والبحث والفلاتر في الشريط العلويّ ⇒ `searchable={false}` مع `externalFiltersActive`.
        */}
      <DataTable<TransitRow, number>
        columns={transitColumns}
        data={list}
        getRowId={(r) => Number(r.id)}
        selection={
          canFulfil
            ? {
                selected: selectedIds,
                toggle: toggleOne,
                isSelected: (id) => selectedIds.has(id),
                count: selectedIds.size,
                setMany: setManySelected,
              }
            : undefined
        }
        pageSize={Infinity}
        searchable={false}
        externalFiltersActive={stateFilter !== "ALL" || query.trim() !== ""}
        loading={rows.isLoading}
        emptyState={
          <EmptyState
            icon={Truck}
            title="لا طرود بالطريق"
            description="كل ما أُسنِد للمناديب إمّا سُلّم وسُوّي أو أُرجع."
          />
        }
        emptyFilteredState={
          <EmptyState
            icon={Truck}
            title={stateFilter === "ALL" ? "لا نتائج مطابقة" : `لا طرود في «${CONSIGNMENT_VIEW_AR[stateFilter]}»`}
            description={stateFilter === "ALL" ? "لا طرود مطابقة لبحثك." : "طابور فارغ لهذا الفلتر — قد يكون هذا الوضع الطبيعيّ."}
          />
        }
      />

      {/* ─── درج الخط الزمنيّ (يفتح بنقر رقم الإرسالية أو أيقونة التاريخ) ─── */}
      <ConsignmentTimelineDrawer consignmentId={drawerId} onClose={() => setDrawerId(null)} />

      {/* ─── حوار التعذّر (مفرد أو جماعي) ─── */}
      {failTarget && (
        <FailReasonDialog
          count={failTarget.ids.length}
          pending={staffMarkFailed.isPending}
          onCancel={() => setFailTarget(null)}
          onConfirm={async (reason) => {
            const results = await Promise.allSettled(
              failTarget.ids.map((id) => staffMarkFailed.mutateAsync({
                consignmentId: id,
                reason,
                clientRequestId: crypto.randomUUID(),
              })),
            );
            const ok = results.filter((r) => r.status === "fulfilled").length;
            const err = results.length - ok;
            if (err === 0) notify.ok(`وُسم ${ok} طرداً متعذّراً`);
            else notify.err(`نجح ${ok} وفشل ${err}`);
            setSelectedIds(new Set());
            setFailTarget(null);
            invalidateAll();
          }}
        />
      )}

      {/* ─── حوار إعلان الرجوع (بديل window.prompt) ─── */}
      {declareTarget && (
        <DeclareReturnDialog
          row={declareTarget}
          pending={declareReturn.isPending}
          onCancel={() => setDeclareTarget(null)}
          onConfirm={(reason, statementNumber) => {
            declareReturn.mutate({
              consignmentId: declareTarget.id,
              reason,
              ...(statementNumber ? { statementNumber } : {}),
              clientRequestId: crypto.randomUUID(),
            });
            setDeclareTarget(null);
          }}
        />
      )}

      {/* ─── حوار إرجاع الطرد (يحمل منتقي درج الردّ) ─── */}
      <ReturnConsignmentDialog
        target={returnTarget}
        pending={returnCn.isPending}
        onClose={() => setReturnTarget(null)}
        onConfirm={({ consignmentId, refundShiftId }) => {
          returnCn.mutate({ consignmentId, clientRequestId: crypto.randomUUID(), refundShiftId });
          setReturnTarget(null);
        }}
      />

      {/* ─── حوار «تم التسليم» (كاشير) ─── */}
      {staffConfirmTarget && (
        <StaffConfirmDialog
          row={staffConfirmTarget}
          pending={staffConfirm.isPending}
          onCancel={() => setStaffConfirmTarget(null)}
          onConfirm={(collectedAmount, evidence, shortfallReason) => {
            staffConfirm.mutate({
              consignmentId: staffConfirmTarget.id,
              collectedAmount,
              evidence,
              clientRequestId: crypto.randomUUID(),
              // Slice DFP1 (٣٠/٨/٢٦): سببُ العجز يُرسَل فقط حين وقع عجز — للحفاظ على توافق الحمولة
              // للحالة السائدة (تحصيل كامل بلا سبب مطلوب). الخادم يرفضه إن لزم وغاب.
              ...(shortfallReason ? { shortfallReason } : {}),
            });
          }}
        />
      )}

      {/* ─── حوار الإثبات اليدوي (مدير فقط) ─── */}
      {manualProofTarget && (
        <ManualProofDialog
          row={manualProofTarget}
          pending={manualProof.isPending}
          onCancel={() => setManualProofTarget(null)}
          onConfirm={(collectedAmount, evidence) => {
            manualProof.mutate({
              consignmentId: manualProofTarget.id,
              collectedAmount,
              evidence,
              clientRequestId: crypto.randomUUID(),
            });
          }}
        />
      )}

      {/* ─── حوار قبض النقد وتوريد العهدة (مفرد أو كامل الذمة) ─── */}
      <CollectConsignmentDialog
        consignment={
          collectTarget
            ? {
                id: Number(collectTarget.id),
                consignmentNumber: collectTarget.consignmentNumber,
                partyId: Number(collectTarget.partyId),
                partyName: collectTarget.partyName,
                orderNumber: collectTarget.orderNumber,
                invoiceNumber: collectTarget.invoiceNumber,
                customerName: collectTarget.recipientName ?? collectTarget.customerName,
                recipientPhone: collectTarget.recipientPhone,
                codDue: collectTarget.codDue,
                codAmount: collectTarget.codDue,
                collectedAmount: collectTarget.collectedAmount,
                parcelStatus: collectTarget.parcelStatus,
              }
            : null
        }
        open={collectTarget != null}
        onOpenChange={(open) => {
          if (!open) setCollectTarget(null);
        }}
        onCompleted={() => {
          setCollectTarget(null);
          invalidateAll();
        }}
      />

      {/* ─── حوار إلغاء إسناد الإرسالية وتحرير العهدة ─── */}
      <CancelDeliveryAssignmentDialog
        consignment={cancelTarget}
        open={cancelTarget != null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        onCompleted={() => {
          setCancelTarget(null);
          invalidateAll();
        }}
      />
    </div>
  );
}
