/**
 * OrderFulfillment — الجهة الإدارية لطلبات المتجر الإلكترونية (لوحة تنفيذ بنمط Kanban خفيف).
 *
 * الموظف: يرى الطلبات الواردة (وارد) ← يثبّتها ← يطبع ملصق الطلب على طابعة الملصقات (بضغطة،
 * صفر إدخال يدوي = منع الخطأ) ← **يُرسلها لمندوب** (نقطة العرض = نقطة الفرض: هنا تُنشأ فاتورة COD
 * حقيقية + يُخصم المخزون + قيد دفتر عبر orders.dispatch) ← تُسلَّم. عزل الفرع خادمياً.
 * الإرسال مديريّ فقط (يُقرّ ائتمان COD المؤقّت للزبون النقدي) — يُخفى زرّه عن غير المدير.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ClipboardList, FileText, Loader2, Package, Printer, ReceiptText, Store, Truck, X } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { D, fmtInt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { buildOnlineOrderFollowupMessage } from "@/lib/whatsapp";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import {
  ONLINE_ORDER_STATUSES,
  ORDER_NEXT_STEP,
  orderStatusChipClass,
  orderStatusLabel,
  type OnlineOrderStatus,
} from "@shared/onlineOrderStatus";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { RowActions } from "@/components/list/RowActions";
import { ListToolbar } from "@/components/list/ListToolbar";
import { Input } from "@/components/ui/input";
import { ShippingLabelSizeSelect } from "@/components/ShippingLabelSizeSelect";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { preopenShippingLabelWindow, printShippingLabel } from "@/lib/printing/shippingLabel";
import { printOnlineOrderPreparationA4, printOnlineOrderThermal } from "@/lib/printing/onlineOrder";
import { storefrontUrl } from "@/lib/siteHosts";

// حالات الطلب + خرائط العرض/الانتقال ⇐ shared/onlineOrderStatus.ts (مصدر الحقيقة الوحيد).
// كانت مُعرَّفةً محلياً هنا (وفي Storefront/StoreDashboard/StoreAnalytics) بألوانٍ متفاوتة —
// التوحيد قرارٌ حاسمٌ من تدقيق ٢٨/٨/٢٦ لمنع انجراف قواميس المتجر.

const FILTERS: { value: OnlineOrderStatus | null; label: string }[] = [
  { value: null, label: "الكل" },
  { value: "PENDING", label: "وارد" },
  { value: "CONFIRMED", label: "مثبَّت" },
  { value: "PROCESSING", label: "قيد التجهيز" },
  { value: "SHIPPED", label: "مع المندوب" },
  { value: "DELIVERED", label: "سُلّم" },
];

function money(v: string | number | null): string {
  return v == null || v === "" ? "0" : fmtInt(v);
}

/** حالة الطلب كما يفهمها القاموس المشترك — أيّ قيمة غريبة تُقرأ «وارد» (السلوك القائم). */
function normalizeOrderStatus(status: string): OnlineOrderStatus {
  return (ONLINE_ORDER_STATUSES as readonly string[]).includes(status) ? (status as OnlineOrderStatus) : "PENDING";
}

type OrderRow = { id: number; orderNumber: string; total: string; customerName: string | null };
type Row = RouterOutputs["storeAdmin"]["orders"]["list"][number];

// حجم صفحة الطلبات — نفس الافتراضي التاريخي (كان سقفاً صامتاً)، الآن صفحة أولى من ترقيم حقيقي.
const PAGE_SIZE = 200;

export default function OrderFulfillment() {
  const [filter, setFilter] = useState<OnlineOrderStatus | null>(null);
  const [query, setQuery] = useState("");
  // مدى تاريخ الطلب (إنشاء الطلب) — محفوظ في querystring (يعيش مع الرجوع من التفاصيل، يُشارَك رابطاً).
  const [f, setF, resetF] = useUrlFilters({ from: "", to: "" });
  const [printingId, setPrintingId] = useState<number | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<OrderRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{ id: number; orderNumber: string } | null>(null);
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  // الإرسال مديريّ فقط — يعكس storeManagerProcedure خادمياً (admin يعبُر داخل moduleAccessAllowed).
  const canDispatch =
    !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "store", "FULL", ["manager"]);

  const countsQ = trpc.storeAdmin.orders.counts.useQuery();
  // ترقيم حقيقي بالمؤشّر (كان يُحمَّل ٢٠٠ صفّاً فقط بلا مؤشّر ولا لافتة — اقتطاعٌ صامت). orders.list
  // يبقى مصفوفة مسطّحة (عقدٌ يشاركه StoreDashboard.tsx خارج نطاق هذه الشاشة) ⇒ hasMore heuristic
  // بطول الصفحة (نمط BoardColumn في TasksHub.tsx)، لا حقل hasMore صريح من الخادم.
  const listQ = trpc.storeAdmin.orders.list.useInfiniteQuery(
    { status: filter, from: f.from || undefined, to: f.to || undefined, limit: PAGE_SIZE },
    { getNextPageParam: (last) => (last.length === PAGE_SIZE ? last[last.length - 1]?.id : undefined) },
  );
  const setStatusM = trpc.storeAdmin.orders.setStatus.useMutation({
    onSuccess: (res) => {
      notify.ok(`تم تحديث الطلب إلى «${orderStatusLabel(res.to)}»`);
      setCancelTarget(null);
      void utils.storeAdmin.orders.list.invalidate();
      void utils.storeAdmin.orders.counts.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const dispatchM = trpc.storeAdmin.orders.dispatch.useMutation({
    onSuccess: (res) => {
      notify.ok(`تم إنشاء الفاتورة ${res.invoiceNumber} وإسناد الطلب للمندوب`);
      setDispatchTarget(null);
      void utils.storeAdmin.orders.list.invalidate();
      void utils.storeAdmin.orders.counts.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const counts = countsQ.data ?? {};
  const orders = useMemo(() => (listQ.data?.pages ?? []).flatMap((p) => p), [listQ.data]);
  const visibleOrders = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ar");
    if (!needle) return orders;
    return orders.filter((order) =>
      [order.orderNumber, order.customerName, order.customerPhone, order.governorate]
        .some((value) => String(value ?? "").toLocaleLowerCase("ar").includes(needle)),
    );
  }, [orders, query]);

  const activeFilterCount = (filter ? 1 : 0) + (f.from || f.to ? 1 : 0);

  // أعمدة الطلبات — داخل المكوّن لأنّ عمود الإجراءات يستدعي الطباعة والطفرات وحالة الصلاحية.
  const orderColumns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    { id: "orderNumber", header: "رقم الطلب", accessorFn: (o) => o.orderNumber, meta: { kind: "code", width: "id" }, cell: ({ row }) => <span className="font-bold tracking-wider">{row.original.orderNumber}</span> },
    { id: "customerName", header: "العميل", accessorFn: (o) => o.customerName ?? "—", cell: ({ row }) => row.original.customerName ?? "—" },
    { id: "customerPhone", header: "الهاتف", accessorFn: (o) => o.customerPhone ?? "—", meta: { kind: "phone" }, cell: ({ row }) => row.original.customerPhone ?? "—" },
    { id: "governorate", header: "المحافظة", accessorFn: (o) => o.governorate ?? "—", cell: ({ row }) => row.original.governorate ?? "—" },
    { id: "itemCount", header: "أصناف", accessorFn: (o) => o.itemCount, meta: { kind: "number", align: "center" }, cell: ({ row }) => row.original.itemCount },
    // نصُّ العرض للنسخ، والفرز على القيمة الخامّ: الفرز النصّيّ على «1,234 د.ع» يقرأه أصغر
    // من «999 د.ع» فيقلب ترتيب مبالغ التحصيل عند الباب.
    { id: "total", header: "الإجمالي (COD)", accessorFn: (o) => `${money(o.total)} د.ع`, meta: { kind: "money" }, sortDescFirst: true, sortingFn: (a, b) => D(a.original.total ?? 0).cmp(D(b.original.total ?? 0)), cell: ({ row }) => <span className="font-bold">{money(row.original.total)} د.ع</span> },
    {
      id: "status",
      header: "الحالة",
      accessorFn: (o) => orderStatusLabel(normalizeOrderStatus(o.status)),
      meta: { kind: "status", wrap: true },
      cell: ({ row }) => {
        const o = row.original;
        const st = normalizeOrderStatus(o.status);
        return (
          <div className="flex flex-col items-center gap-0.5">
            <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${orderStatusChipClass(st)}`}>{orderStatusLabel(st)}</span>
            {st === "CANCELLED" && o.cancelReason && (
              <span className="max-w-[12rem] truncate text-[11px] text-muted-foreground" title={o.cancelReason}>{o.cancelReason}</span>
            )}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "الإجراءات",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => {
        const o = row.original;
        const st = normalizeOrderStatus(o.status);
        // طلب SHIPPED مُسنَد لمندوب يُسلَّم ويُحصَّل عبر «توصيلاتي» (لا زر «تم التسليم» بلا تحصيل
        // — يُخفي COD؛ مراجعة عدائية ١٢/٧). النقل اليدوي لـDELIVERED محجوبٌ خادمياً أيضاً.
        const courierShipped = st === "SHIPPED" && o.deliveryPartyId != null;
        const next = courierShipped ? undefined : ORDER_NEXT_STEP[st];
        const isBusy = setStatusM.isPending || printingId === o.id;
        return (
          <RowActions
            mode="menu"
            contact={{
              phone: o.customerPhone,
              label: `واتساب ${o.customerName ?? "العميل"}`,
              message: buildOnlineOrderFollowupMessage({
                orderNumber: o.orderNumber,
                customerName: o.customerName,
                total: o.total,
                status: o.status,
              }),
              gate: { module: "store", level: "READ" },
            }}
            actions={[
              {
                key: "print-label",
                kind: "print",
                label: printingId === o.id ? "جارٍ طباعة الملصق…" : "طباعة الملصق",
                icon: printingId === o.id ? Loader2 : Printer,
                gate: { module: "store", level: "READ" },
                disabled: isBusy,
                disabledReason: "هناك عملية جارية على الطلب",
                onSelect: () => printLabel(o.id),
              },
              {
                key: "print-thermal",
                kind: "print",
                label: "طباعة فاتورة حرارية",
                icon: ReceiptText,
                gate: { module: "store", level: "READ" },
                disabled: isBusy,
                disabledReason: "هناك عملية جارية على الطلب",
                onSelect: () => printThermal(o.id),
              },
              {
                key: "print-preparation-a4",
                kind: "print",
                label: "طباعة ورقة تجهيز A4",
                icon: FileText,
                gate: { module: "store", level: "READ" },
                disabled: isBusy,
                disabledReason: "هناك عملية جارية على الطلب",
                onSelect: () => printPreparationA4(o.id),
              },
              {
                key: "dispatch",
                kind: "approve",
                label: "إرسال لمندوب",
                icon: Truck,
                hidden: !canDispatch || (st !== "CONFIRMED" && st !== "PROCESSING"),
                gate: { roles: ["manager"], module: "store", level: "FULL" },
                disabled: isBusy || dispatchM.isPending,
                disabledReason: "هناك عملية جارية على الطلب",
                onSelect: () => setDispatchTarget({ id: o.id, orderNumber: o.orderNumber, total: o.total, customerName: o.customerName }),
              },
              {
                key: "advance",
                kind: "approve",
                label: next?.label ?? "تحديث الحالة",
                icon: Check,
                hidden: !next,
                gate: { module: "store", level: "FULL" },
                disabled: isBusy,
                disabledReason: "هناك عملية جارية على الطلب",
                onSelect: () => next && advance(o, next.to, next.label),
              },
              {
                key: "cancel",
                kind: "delete",
                label: "إلغاء الطلب",
                icon: X,
                variant: "destructive",
                hidden: st !== "PENDING" && st !== "CONFIRMED" && st !== "PROCESSING",
                gate: { module: "store", level: "FULL" },
                disabled: isBusy,
                disabledReason: "هناك عملية جارية على الطلب",
                onSelect: () => setCancelTarget({ id: o.id, orderNumber: o.orderNumber }),
              },
            ]}
          />
        );
      },
    },
  ], [canDispatch, printingId, setStatusM.isPending, dispatchM.isPending]);

  // تصدير/طباعة «الكل»: نمشي بمؤشّر id (لا offset — عقد orders.list) حتى تنضب الصفحات المطابقة
  // لفلاتر الحالة/المدى الحاليّة، بصرف النظر عمّا حُمِّل على الشاشة أو نطاق البحث المحلي.
  async function fetchAllOrders(): Promise<Row[]> {
    const out: Row[] = [];
    let cursor: number | undefined;
    for (let i = 0; i < 100; i++) { // صمّام أمان: حتى ٣٠ ألف طلب
      const page = await utils.storeAdmin.orders.list.fetch({ status: filter, from: f.from || undefined, to: f.to || undefined, cursor, limit: 300 });
      out.push(...page);
      if (page.length < 300) break;
      const lastId = page[page.length - 1]?.id;
      if (lastId == null) break;
      cursor = lastId;
    }
    return out;
  }

  // نصّ التأكيد يستعمل رقم الطلب الظاهر للمستخدم (orderNumber) لا معرّفه الداخلي (id).
  async function advance(order: { id: number; orderNumber: string }, to: OnlineOrderStatus, label: string) {
    const ok = await confirm({ title: `${label}؟`, description: `الطلب رقم ${order.orderNumber}` });
    if (ok) setStatusM.mutate({ id: order.id, status: to });
  }
  async function printLabel(id: number) {
    setPrintingId(id);
    // النافذة تُفتح متزامنةً مع النقرة (قبل await جلب التفاصيل) وإلا حجبها مانع النوافذ المتشدّد.
    const labelWin = preopenShippingLabelWindow();
    try {
      const d = await utils.storeAdmin.orders.detail.fetch({ id });
      if (!d) {
        labelWin?.close();
        notify.err("تعذّر جلب تفاصيل الطلب");
        return;
      }
      const res = await printShippingLabel(
        {
          orderNumber: d.orderNumber,
          customerName: d.customerName,
          customerPhone: d.customerPhone,
          governorate: d.governorate,
          addressText: d.addressText,
          total: d.total,
          deliveryPartyName: d.deliveryPartyName,
          createdAt: d.createdAt,
          items: d.items.map((it) => ({ productName: [it.productName, it.variantLabel].filter(Boolean).join(" — "), unitName: it.unitName, quantity: it.quantity })),
          qrUrl: `${storefrontUrl()}?order=${encodeURIComponent(d.orderNumber)}&token=${encodeURIComponent(d.labelToken)}`,
        },
        { into: labelWin },
      );
      notify.ok(res.ok ? "فُتحت نافذة طباعة ملصق الشحن" : "افسح مانع النوافذ المنبثقة لطباعة الملصق");
    } catch (e) {
      labelWin?.close();
      notify.err(e);
    } finally {
      setPrintingId(null);
    }
  }

  async function printThermal(id: number) {
    setPrintingId(id);
    try {
      const d = await utils.storeAdmin.orders.detail.fetch({ id });
      if (!d) { notify.err("تعذر جلب تفاصيل الطلب"); return; }
      await printOnlineOrderThermal(d);
      notify.ok("أُرسل الطلب إلى طابعة الإيصالات");
    } catch (e) { notify.err(e); }
    finally { setPrintingId(null); }
  }

  async function printPreparationA4(id: number) {
    setPrintingId(id);
    try {
      const d = await utils.storeAdmin.orders.detail.fetch({ id });
      if (!d) { notify.err("تعذر جلب تفاصيل الطلب"); return; }
      printOnlineOrderPreparationA4(d);
    } catch (e) { notify.err(e); }
    finally { setPrintingId(null); }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="طلبات الموقع"
        description="راجع الطلبات الواردة، ثبّتها وجهّزها للتوصيل"
        icon={<Store aria-hidden className="size-5" />}
        actions={<ShippingLabelSizeSelect />}
      />

      {/* بطاقات الحالة */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatCard label="وارد" value={counts.PENDING ?? 0} icon={ClipboardList} tone="warning" onClick={() => setFilter("PENDING")} />
        <StatCard label="مثبَّت" value={counts.CONFIRMED ?? 0} icon={Check} tone="info" onClick={() => setFilter("CONFIRMED")} />
        <StatCard label="قيد التجهيز" value={counts.PROCESSING ?? 0} icon={Package} tone="info" onClick={() => setFilter("PROCESSING")} />
        <StatCard label="مع المندوب" value={counts.SHIPPED ?? 0} icon={Truck} onClick={() => setFilter("SHIPPED")} />
        <StatCard label="سُلّم" value={counts.DELIVERED ?? 0} icon={Check} tone="positive" onClick={() => setFilter("DELIVERED")} />
      </div>

      <ListToolbar
        title="قائمة الطلبات"
        count={visibleOrders.length}
        loading={listQ.isLoading}
        search={{ value: query, onChange: setQuery, placeholder: "رقم الطلب، العميل، الهاتف أو المحافظة…" }}
        activeFilterCount={activeFilterCount}
        onResetFilters={() => { setQuery(""); setFilter(null); resetF(); }}
        onRefresh={() => { void listQ.refetch(); void countsQ.refetch(); }}
        refreshing={listQ.isFetching || countsQ.isFetching}
        onPrint={() => window.print()}
        printDisabled={visibleOrders.length === 0}
        exportSpec={{
          filename: "طلبات-المتجر",
          sheetName: "الطلبات",
          rows: visibleOrders,
          fetchAll: fetchAllOrders,
          formats: ["xlsx", "csv"],
          columns: [
            { key: "orderNumber", header: "رقم الطلب" },
            { key: "customerName", header: "العميل" },
            { key: "customerPhone", header: "الهاتف" },
            { key: "governorate", header: "المحافظة" },
            { key: "itemCount", header: "عدد الأصناف" },
            { key: "total", header: "الإجمالي", money: true },
            { key: "status", header: "الحالة", map: (r) => orderStatusLabel(r.status) },
          ],
        }}
        filters={
          <>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => setFilter(opt.value)}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                    filter === opt.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <Input type="date" value={f.from} onChange={(e) => setF({ from: e.target.value })} className="h-8 w-[8.5rem]" aria-label="من تاريخ الطلب" max={f.to || undefined} />
              <span className="text-xs text-muted-foreground">إلى</span>
              <Input type="date" value={f.to} onChange={(e) => setF({ to: e.target.value })} className="h-8 w-[8.5rem]" aria-label="إلى تاريخ الطلب" min={f.from || undefined} />
            </div>
          </>
        }
      />

      {/* لافتة حقيقية بدل الاقتطاع الصامت: الصفحة المحمَّلة الأخيرة بلغت السقف ⇒ قد توجد طلبات
          إضافية أقدم — لا نُخفي ذلك، ونعرض «تحميل المزيد» صراحةً. */}
      {listQ.hasNextPage && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-3 py-2 text-xs font-medium text-[var(--sem-warn)]">
          <span className="inline-flex items-center gap-1.5">
            <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
            معروض {orders.length} طلباً — قد توجد طلبات أقدم غير محمَّلة بعد.
          </span>
          <button
            type="button"
            onClick={() => listQ.fetchNextPage()}
            disabled={listQ.isFetchingNextPage}
            className="shrink-0 rounded-lg border border-[var(--sem-warn)]/60 bg-transparent px-3 py-1.5 text-xs font-bold text-[var(--sem-warn)] transition hover:bg-[var(--sem-warn-bg)] disabled:opacity-50"
          >
            {listQ.isFetchingNextPage ? "جارٍ التحميل…" : "تحميل المزيد"}
          </button>
        </div>
      )}

      {/* الجدول — البحث والفلاتر في `ListToolbar` أعلاه (تغذّي visibleOrders) ⇒ لا بحثَ داخليّ. */}
      <DataTable<Row>
        columns={orderColumns}
        data={visibleOrders}
        searchable={false}
        externalFiltersActive={activeFilterCount > 0 || query.trim() !== ""}
        loading={listQ.isLoading}
        errorState={{ isError: listQ.isError, message: listQ.error?.message, onRetry: () => void listQ.refetch() }}
        emptyText="لا توجد طلبات"
        viewKey="store-order-fulfillment"
      />

      {dispatchTarget && (
        <DispatchModal
          order={dispatchTarget}
          pending={dispatchM.isPending}
          onCancel={() => !dispatchM.isPending && setDispatchTarget(null)}
          onConfirm={(partyId) => dispatchM.mutate({ id: dispatchTarget.id, partyId })}
        />
      )}

      {cancelTarget && (
        <CancelModal
          order={cancelTarget}
          pending={setStatusM.isPending}
          onClose={() => !setStatusM.isPending && setCancelTarget(null)}
          onConfirm={(reason) => setStatusM.mutate({ id: cancelTarget.id, status: "CANCELLED", cancelReason: reason || undefined })}
        />
      )}
    </div>
  );
}

/** حوار إلغاء طلب المتجر — سببٌ اختياريّ (يظهر لاحقاً في صفّ الطلب الملغى وسجلّ التدقيق). محصورٌ
 *  بطلبٍ قبل الإرسال (بلا فاتورة) — الإلغاء بعده يكون بإرجاع الفاتورة أو «تعذّر التسليم». */
const CANCEL_REASONS = ["نفد المخزون", "تعذّر التواصل مع العميل", "طلب مكرَّر", "رفض العميل الطلب", "خارج نطاق التوصيل"];
function CancelModal({
  order,
  pending,
  onClose,
  onConfirm,
}: {
  order: { id: number; orderNumber: string };
  pending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !pending) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="إلغاء الطلب"
      onClick={onClose}
    >
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-[var(--sem-neg)]">
          <X aria-hidden className="size-5" />
          إلغاء الطلب <span dir="ltr" className="tracking-wider text-foreground">{order.orderNumber}</span>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          لا يمكن التراجع. اذكر سبب الإلغاء (اختياريّ) — يُحفَظ ويظهر في صفّ الطلب وسجلّ التدقيق.
        </p>

        <div className="mb-2 flex flex-wrap gap-1.5">
          {CANCEL_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              className={`rounded-full px-2.5 py-1 text-xs font-bold transition ${
                reason === r ? "bg-[var(--sem-neg)] text-background hover:bg-[var(--sem-neg)]/90" : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="سبب الإلغاء…"
          className="mb-3 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg border border-border px-3.5 py-1.5 text-xs font-bold transition hover:bg-accent disabled:opacity-50"
          >
            تراجع
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim())}
            disabled={pending}
            className="flex items-center gap-1 rounded-lg bg-[var(--sem-neg)] px-3.5 py-1.5 text-xs font-bold text-background transition hover:bg-[var(--sem-neg)]/90 disabled:opacity-50"
          >
            {pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <X aria-hidden className="size-3.5" />}
            تأكيد الإلغاء
          </button>
        </div>
      </div>
    </div>
  );
}

/** منتقي المندوب عند الإرسال — يُنشئ الفاتورة (COD) + يُسند الطلب. z-[100] (فوق Radix، تحت confirm). */
function DispatchModal({
  order,
  pending,
  onCancel,
  onConfirm,
}: {
  order: OrderRow;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (partyId: number) => void;
}) {
  const [partyId, setPartyId] = useState<number | null>(null);
  const partiesQ = trpc.storeAdmin.orders.parties.useQuery();
  // فقط الجهات المرتبطة بحساب مندوب (userId) — كي يستطيع المندوب تأكيد التسليم والتحصيل من «توصيلاتي».
  // جهةٌ بلا حساب (شركة خارجية) لا مسار لها لإنهاء الطلب داخل النظام ⇒ يبقى عالقاً (مراجعة عدائية ١٢/٧).
  const parties = (partiesQ.data ?? []).filter((p) => p.userId != null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="إرسال الطلب لمندوب"
      onClick={onCancel}
    >
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold">
          <Truck aria-hidden className="size-5 text-teal-600" />
          إرسال الطلب <span dir="ltr" className="tracking-wider">{order.orderNumber}</span>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          {/* ١٠/٨ تمرير كامل: order.total (بضاعة+شحن) = ما يُحصّله المندوب عند الباب، لا «قيمة
              الفاتورة/الذمّة» — الفاتورة وذمّة العميل تُنشآن بقيمة البضاعة فقط، وأجرة التوصيل
              يقبضها المندوب من الزبون ويحتفظ بها (خارج الفاتورة). لا تُلصِق الرقم بـ«فاتورة». */}
          يُحصّل المندوب <b className="text-foreground">{money(order.total)} د.ع</b> عند التسليم (COD) من{" "}
          {order.customerName ? <b className="text-foreground">{order.customerName}</b> : "العميل"}: قيمة البضاعة
          تُنشأ فاتورةً على ذمّته ويورّدها للمكتبة، وأجرة التوصيل يحتفظ بها المندوب. يُخصم المخزون ثم يُسند
          الطلب للمندوب المُختار.
        </p>

        {partiesQ.isLoading ? (
          <div className="py-8 text-center text-muted-foreground">
            <Loader2 aria-hidden className="mx-auto size-6 animate-spin" />
          </div>
        ) : parties.length === 0 ? (
          <div className="rounded-lg bg-muted p-4 text-center text-sm text-muted-foreground">
            لا يوجد مندوبٌ نشطٌ مرتبطٌ بحساب دخول. أنشئ حساب «مندوب توصيل» في المستخدمين، ثم اربطه بجهة توصيل من إدارة التوصيل ليظهر هنا (فيستطيع تأكيد التسليم عبر «توصيلاتي»).
          </div>
        ) : (
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {parties.map((p) => (
              <label
                key={p.id}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${
                  partyId === p.id ? "border-teal-500 bg-teal-50 dark:bg-teal-500/10" : "border-border hover:bg-accent"
                }`}
              >
                <input
                  type="radio"
                  name="dispatch-party"
                  className="size-4 accent-teal-600"
                  checked={partyId === p.id}
                  onChange={() => setPartyId(p.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-bold">
                    {p.name}
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {p.partyType === "COMPANY" ? "شركة توصيل" : "مندوب"}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                    {p.phone && <span dir="ltr">{p.phone}</span>}
                    {p.openConsignments > 0 && <span>قيد التوصيل: {p.openConsignments}</span>}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={pending}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            onClick={() => partyId != null && onConfirm(partyId)}
            disabled={pending || partyId == null || parties.length === 0}
            className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-teal-700 disabled:opacity-50"
          >
            {pending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />}
            تأكيد الإرسال
          </button>
        </div>
      </div>
    </div>
  );
}
