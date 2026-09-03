// الحجوزات — واجهة R-م٣ (النواة). قائمة الحجوزات + حوار حجز جديد (استعلام منتج + بنود) + إلغاء/تمديد.
// الخادم جاهز: server/routers/reservationsRouter.ts + server/services/reservations/*. هذا يستهلكه فقط.
// حجز ناعم (ATP): الإنشاء يعرض تحذير «فوق المتاح» (overbooked) لا يمنع — قرار المالك. العربون/التحويل R-م٤/م٥.
import { receptionChannelLabel } from "@shared/receptionChannel";
import { FILTER_LABELS } from "@shared/uiContracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftRight, ArrowRight, Banknote, CalendarClock, Clock, CreditCard, Download, Eye, FilterX, Plus, Printer, Search, ShoppingCart, Trash2, TriangleAlert, X } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmtDateTime } from "@/lib/date";
import { fmt } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { RowActions } from "@/components/list/RowActions";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import CustomerPicker from "@/components/CustomerPicker";
import { ProductSearchBar } from "@/components/invoice/ProductSearchBar";
import type { InvoiceLine } from "@/components/invoice/types";
import { cn } from "@/lib/utils";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import { printReservationTicket } from "@/lib/printing/reservationTicket";
import {
  captureReservationAvailability,
  findReservationAvailabilityDrops,
  findReservationStockShortages,
  reservationConversionClosedMessage,
  reservationConversionErrorClosesDialog,
  type ReservationAvailabilitySnapshot,
} from "@/lib/reservationConversionGuard";
import { ACTION_LABELS } from "@shared/actionLabels";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const RESERVATION_WRITE_ROLES = ["cashier", "manager", "sales_rep"] as const;
const RESERVATION_MANAGER_ROLES = ["manager"] as const;

type ReservationStatus = "ACTIVE" | "PARTIALLY_FULFILLED" | "FULFILLED" | "EXPIRED" | "CANCELLED" | "RELEASED";
type Channel = "PHONE" | "WALK_IN" | "WHATSAPP" | "STORE";
type CheckoutMethod = "CASH" | "CARD" | "TRANSFER";
type SortKey = "EXPIRY" | "NEWEST";
type ReservationRow = RouterOutputs["reservations"]["list"]["rows"][number];
type ReservationDetail = RouterOutputs["reservations"]["get"];

/** حجم صفحة القائمة — ترقيم خادمي (offset/hasMore) بدل الاقتطاع الصامت عند ٢٠٠. */
const PAGE_SIZE = 50;

const STATUS_LABEL: Record<ReservationStatus, string> = {
  ACTIVE: "نشط",
  PARTIALLY_FULFILLED: "منفَّذ جزئياً",
  FULFILLED: "منفَّذ",
  EXPIRED: "منتهٍ",
  CANCELLED: "ملغى",
  RELEASED: "محرَّر",
};
const STATUS_VARIANT: Record<ReservationStatus, "default" | "secondary" | "destructive" | "outline"> = {
  ACTIVE: "default",
  PARTIALLY_FULFILLED: "secondary",
  FULFILLED: "outline",
  EXPIRED: "destructive",
  CANCELLED: "destructive",
  RELEASED: "secondary",
};
const CHANNEL_LABEL: Record<Channel, string> = {
  PHONE: receptionChannelLabel("PHONE"),
  WALK_IN: receptionChannelLabel("WALK_IN"),
  WHATSAPP: receptionChannelLabel("WHATSAPP"),
  STORE: receptionChannelLabel("STORE"),
};
const CHANNELS = Object.keys(CHANNEL_LABEL) as Channel[];
const CLOSEABLE: ReservationStatus[] = ["ACTIVE", "PARTIALLY_FULFILLED"];

interface ReservationsHubProps {
  embedded?: boolean;
  fixedBranchId?: number;
  currentShiftId?: number | null;
  onClose?: () => void;
}

export default function ReservationsHub({ embedded = false, fixedBranchId, currentShiftId, onClose }: ReservationsHubProps) {
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const role = (me.data?.role ?? "user") as RoleKey;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const canWrite = moduleAccessAllowed(role, override, "reservations", "FULL", RESERVATION_WRITE_ROLES);
  const canManage = moduleAccessAllowed(role, override, "reservations", "FULL", RESERVATION_MANAGER_ROLES) && (role === "admin" || role === "manager");

  const userBranchId = me.data?.branchId ?? null;
  const [branchId, setBranchId] = useState<number | null>(null);
  const effectiveBranch = fixedBranchId ?? branchId ?? userBranchId ?? branches.data?.[0]?.id ?? null;

  // Codex P2 على PR #559: `Date.now()` يُقاس أثناء render فقط ⇒ حجزٌ يعبر عتبة ٤س لن يتحوّل إلى
  // «ينتهي قريباً» تلقائياً على شاشة كاشيرٍ مفتوحة لساعات. مؤقّت كلّ ٦٠ث يُطلق re-render يعيد حساب
  // `expiringSoon` بحبيبة الدقيقة — كافٍ لعتبة الساعات، خفيفٌ (setState فارغ عبر counter).
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const [status, setStatus] = useState<"" | ReservationStatus>("");
  const [q, setQ] = useState("");
  // مدى تاريخ الانتهاء (اختياري) + الترتيب: «ينتهي أولاً» افتراضياً — طابور الصباح.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<SortKey>("EXPIRY");
  const [page, setPage] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [convertTarget, setConvertTarget] = useState<ReservationRow | null>(null);
  const [convertAmount, setConvertAmount] = useState("");
  const [convertMethod, setConvertMethod] = useState<CheckoutMethod>("CASH");
  const [convertReference, setConvertReference] = useState("");
  const [convertAvailabilitySnapshot, setConvertAvailabilitySnapshot] = useState<ReservationAvailabilitySnapshot | null>(null);
  const [convertAvailabilityWarning, setConvertAvailabilityWarning] = useState<string | null>(null);
  const [isConversionBusy, setIsConversionBusy] = useState(false);
  const activeConvertTargetIdRef = useRef<number | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ReservationRow | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [extendTarget, setExtendTarget] = useState<ReservationRow | null>(null);
  const [extendHours, setExtendHours] = useState("24");

  const closeConversionDialog = useCallback(() => {
    activeConvertTargetIdRef.current = null;
    setIsConversionBusy(false);
    setConvertTarget(null);
    setConvertAmount("");
    setConvertReference("");
    setConvertAvailabilitySnapshot(null);
    setConvertAvailabilityWarning(null);
  }, []);

  // أي تغيير فلتر يعيد الترقيم لأول صفحة (وإلا صفحة خارج النطاق ⇒ قائمة فارغة مضللة).
  useEffect(() => { setPage(0); }, [status, q, from, to, sort, effectiveBranch]);

  const filters = {
    status: status || undefined,
    branchId: effectiveBranch ?? undefined,
    q: q.trim() || undefined,
    from: from || undefined,
    to: to || undefined,
    sort,
  };

  const list = trpc.reservations.list.useQuery(
    { ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    { enabled: effectiveBranch != null },
  );
  const utils = trpc.useUtils();
  // بنود الحجز («ماذا حجزتُ لك؟») لحوار التفاصيل وحوار التحويل.
  const detail = trpc.reservations.get.useQuery(
    { id: detailId ?? 0 },
    { enabled: detailId != null },
  );
  const convertDetail = trpc.reservations.get.useQuery(
    { id: Number(convertTarget?.id ?? 0) },
    {
      enabled: convertTarget != null,
      // يرصد إلغاء/تحرير الحجز أو تغير ATP أثناء بقاء الحوار مفتوحاً؛ التحقق الحاسم يُعاد عند التأكيد.
      refetchInterval: convertTarget != null && !isConversionBusy ? 10_000 : false,
      refetchOnWindowFocus: true,
    },
  );

  useEffect(() => {
    if (convertTarget && convertDetail.data && convertAvailabilitySnapshot == null) {
      setConvertAvailabilitySnapshot(captureReservationAvailability(convertDetail.data));
    }
  }, [convertAvailabilitySnapshot, convertDetail.data, convertTarget]);

  useEffect(() => {
    if (!convertTarget || !convertDetail.data || isConversionBusy) return;
    const closedMessage = reservationConversionClosedMessage(convertDetail.data);
    if (closedMessage) {
      closeConversionDialog();
      notify.err(closedMessage);
      void utils.reservations.list.invalidate();
      return;
    }
    const expiresAtMs = new Date(convertDetail.data.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) return;
    const timer = window.setTimeout(() => {
      closeConversionDialog();
      notify.err("انتهت مدّة الحجز أثناء فتح الحوار؛ أُغلق التحويل ولم تُنشأ فاتورة.");
      void utils.reservations.list.invalidate();
    }, Math.max(1, expiresAtMs - Date.now() + 25));
    return () => window.clearTimeout(timer);
  }, [closeConversionDialog, convertDetail.data, convertTarget, isConversionBusy, utils.reservations.list]);

  const cancel = trpc.reservations.cancel.useMutation({
    onSuccess: () => {
      notify.ok("أُلغي الحجز");
      setCancelTarget(null);
      setCancelReason("");
      utils.reservations.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const extend = trpc.reservations.extend.useMutation({
    onSuccess: () => {
      notify.ok("مُدّد الحجز");
      setExtendTarget(null);
      utils.reservations.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const convert = trpc.reservations.convert.useMutation({
    onSuccess: (r) => {
      notify.ok(`أُنشئت الفاتورة ${r.invoiceNumber}`);
      closeConversionDialog();
      utils.reservations.list.invalidate();
    },
    onError: (e) => {
      if (reservationConversionErrorClosesDialog(e)) {
        closeConversionDialog();
        notify.err("انتهى الحجز أو تغيّرت حالته قبل اكتمال التحويل؛ لم تُنشأ فاتورة.");
        void utils.reservations.list.invalidate();
        return;
      }
      setIsConversionBusy(false);
      notify.err(e);
      // إن خرج مخزون فعلي في السباق الأخير، تعيد القراءة إظهار النقص داخل الحوار بدلاً من خطأ مبهم.
      void convertDetail.refetch();
    },
  });

  function onConvert(r: ReservationRow) {
    activeConvertTargetIdRef.current = Number(r.id);
    setIsConversionBusy(false);
    setConvertTarget(r);
    setConvertAmount("");
    setConvertMethod("CASH");
    setConvertReference("");
    setConvertAvailabilitySnapshot(null);
    setConvertAvailabilityWarning(null);
  }
  async function submitConversion() {
    if (!convertTarget) return;
    if (!isPosPaymentMethodEnabled(convertMethod)) {
      notify.err(posPaymentRejectionMessage(convertMethod));
      return;
    }
    const amount = convertAmount.trim();
    if (amount && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
      notify.err("أدخل مبلغاً صحيحاً أكبر من صفر، أو اتركه فارغاً للبيع الآجل");
      return;
    }
    if (amount && convertMethod !== "CASH" && !convertReference.trim()) {
      notify.err(convertMethod === "CARD" ? "رقم عملية البطاقة مطلوب" : "رقم مرجع التحويل مطلوب");
      return;
    }
    if (!amount && !convertTarget.customerId) {
      notify.err("لا يمكن البيع الآجل لحجز بلا عميل مسجل؛ أدخل دفعة أو اربط الحجز بعميل");
      return;
    }
    const payment = amount
      ? { amount, method: convertMethod, reference: convertMethod === "CASH" ? null : convertReference.trim() }
      : null;

    const targetId = Number(convertTarget.id);
    setIsConversionBusy(true);
    try {
      const fresh = await convertDetail.refetch();
      if (activeConvertTargetIdRef.current !== targetId) return;
      if (fresh.error || !fresh.data) {
        setIsConversionBusy(false);
        notify.err("تعذّر التحقق من الحجز الآن؛ تحقّق من الاتصال وأعد المحاولة.");
        return;
      }
      const closedMessage = reservationConversionClosedMessage(fresh.data);
      if (closedMessage) {
        closeConversionDialog();
        notify.err(closedMessage);
        void utils.reservations.list.invalidate();
        return;
      }
      const shortages = findReservationStockShortages(fresh.data);
      if (shortages.length) {
        setIsConversionBusy(false);
        notify.warn(
          "المخزون الفعلي لم يعد يغطي الحجز",
          `${shortages.map((row) => row.productName).join("، ")} — لم تُنشأ فاتورة ناقصة.`,
        );
        return;
      }
      const drops = findReservationAvailabilityDrops(convertAvailabilitySnapshot, fresh.data);
      if (drops.length) {
        // تثبيت اللقطة الجديدة يجعل الضغط التالي إقراراً واعياً؛ انخفاض ATP لا يحجب صاحب الحجز
        // ما دام الرصيد الفعلي يغطيه، لكنه لا يمر بصمت أيضاً.
        setIsConversionBusy(false);
        setConvertAvailabilitySnapshot(captureReservationAvailability(fresh.data));
        setConvertAvailabilityWarning("انخفض المتاح العام بعد فتح الحوار. أولوية هذا الحجز محفوظة؛ راجع البنود ثم أكّد مرة أخرى.");
        notify.warn("انخفض المتاح منذ فتح الحوار", "أولوية الحجز محفوظة. راجع التحذير ثم اضغط تأكيد الطلب مرة أخرى.");
        return;
      }
      convert.mutate({
        reservationId: targetId,
        // المضيف الذي يعرف ورديته يمرّر رقماً أو null صريحاً؛ غياب الخاصية يبقي التدفق المستقل
        // (ومن ضمنه PointOfSale المضمّن) على محلّل وردية RETAIL الخادمي.
        shiftId: currentShiftId,
        payment,
      });
    } catch {
      if (activeConvertTargetIdRef.current !== targetId) return;
      setIsConversionBusy(false);
      notify.err("تعذّر التحقق من الحجز الآن؛ تحقّق من الاتصال وأعد المحاولة.");
    }
  }
  // حوارا الإلغاء/التمديد بحوارات النظام (Dialog) بدل window.prompt.
  function onCancel(r: ReservationRow) {
    setCancelTarget(r);
    setCancelReason("");
  }
  function onExtend(r: ReservationRow) {
    setExtendTarget(r);
    setExtendHours("24");
  }
  function submitCancel() {
    if (!cancelTarget) return;
    cancel.mutate({ id: Number(cancelTarget.id), reason: cancelReason.trim() || null });
  }
  function submitExtend() {
    if (!extendTarget) return;
    const hours = Number(extendHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) { notify.err("مدّة غير صالحة (١–٧٢ ساعة)"); return; }
    extend.mutate({ id: Number(extendTarget.id), hours });
  }

  const hasFilters = !!(status || q.trim() || from || to || sort !== "EXPIRY" || branchId != null);
  function clearFilters() {
    setStatus("");
    setQ("");
    setFrom("");
    setTo("");
    setSort("EXPIRY");
    setBranchId(null);
    setPage(0);
  }

  // تصدير كامل النتائج المطابقة للفلاتر (كل الصفحات عبر offset) — لا الصفحة المعروضة فقط.
  function exportAll() {
    exportRows(
      () =>
        fetchAllPaged(
          (offset, limit) =>
            utils.reservations.list.fetch({ ...filters, limit, offset }).then((res) => ({ rows: res.rows })),
          { pageSize: 200 },
        ),
      {
        filename: "الحجوزات",
        title: "قائمة الحجوزات",
        columns: [
          { key: "reservationNumber", header: "رقم الحجز" },
          { key: "contactName", header: "العميل" },
          { key: "contactPhone", header: "الهاتف" },
          { key: "channel", header: "طريقة وصول الحجز", map: (r) => CHANNEL_LABEL[r.channel as Channel] ?? r.channel },
          { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status as ReservationStatus] ?? r.status },
          { key: "expiresAt", header: "ينتهي", map: (r) => (r.expiresAt ? fmtDateTime(r.expiresAt) : "") },
          { key: "createdAt", header: "أُنشئ", map: (r) => (r.createdAt ? fmtDateTime(r.createdAt) : "") },
          { key: "notes", header: "ملاحظات" },
        ],
      },
    );
  }

  const rows = list.data?.rows ?? [];
  const hasMore = list.data?.hasMore ?? false;
  const conversionAvailabilityDrops = convertDetail.data
    ? findReservationAvailabilityDrops(convertAvailabilitySnapshot, convertDetail.data)
    : [];
  const conversionStockShortages = convertDetail.data
    ? findReservationStockShortages(convertDetail.data)
    : [];

  return (
    <div className={cn("space-y-4", embedded && "h-full overflow-y-auto bg-background p-4")}>
      {embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card p-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <CalendarClock className="size-5" aria-hidden />
            </span>
            <div>
              <h1 className="text-lg font-extrabold">حجوزات خدمة العملاء</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                أنشئ الحجز أو ابحث عنه، ثم حوّله إلى طلب عند حضور العميل.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canWrite && (
              <Button size="sm" onClick={() => setShowNew(true)} disabled={effectiveBranch == null}>
                <Plus aria-hidden className="size-4 me-1" /> حجز جديد
              </Button>
            )}
            {onClose && (
              <Button size="sm" variant="outline" onClick={onClose}>
                <ArrowRight aria-hidden className="size-4 me-1" /> العودة إلى الطلب
              </Button>
            )}
          </div>
        </div>
      ) : (
        <PageHeader
          title="الحجوزات"
          description="حجز منتجات للعملاء بمدّة انتهاء — حجز ناعم يخصم «المتاح» دون مسّ المخزون الفعلي. يُستدعى عند حضور العميل ليتحوّل إلى فاتورة."
          icon={<CalendarClock className="size-5" aria-hidden />}
          actions={
            canWrite ? (
              <Button size="sm" onClick={() => setShowNew(true)} disabled={effectiveBranch == null}>
                <Plus aria-hidden className="size-4 me-1" /> حجز جديد
              </Button>
            ) : undefined
          }
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* منتقي الفرع للمرتفعين فقط (Codex P2): غير المرتفع مُقيَّد بفرعه خادمياً، فإظهاره يضلّله. */}
        {fixedBranchId == null && (role === "admin" || role === "manager") && (branches.data?.length ?? 0) > 1 && (
          <AppSelect
            className="h-9"
            value={String(effectiveBranch ?? "")}
            onValueChange={(next) => setBranchId(next ? Number(next) : null)}
            aria-label="الفرع"
          >
            {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </AppSelect>
        )}
        <AppSelect className="h-9" value={status} onValueChange={(next) => setStatus(next as "" | ReservationStatus)} aria-label="الحالة">
          <option value="">كل الحالات</option>
          {(Object.keys(STATUS_LABEL) as ReservationStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </AppSelect>
        <AppSelect
          value={sort}
          onValueChange={(v) => setSort(v as SortKey)}
          aria-label="الترتيب"
          className="min-w-36"
        >
          <option value="EXPIRY">ينتهي أولاً</option>
          <option value="NEWEST">الأحدث أولاً</option>
        </AppSelect>
        <div className="flex items-center gap-1.5">
          <label htmlFor="res-filter-from" className="text-xs text-muted-foreground whitespace-nowrap">ينتهي من</label>
          <input id="res-filter-from" type="date" className={selectCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          <label htmlFor="res-filter-to" className="text-xs text-muted-foreground">إلى</label>
          <input id="res-filter-to" type="date" className={selectCls} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="relative flex-1 min-w-52">
          <span aria-hidden className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground"><Search className="size-4" /></span>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث برقم الحجز أو اسم/هاتف العميل…" className="pe-9" />
        </div>
        <Button size="sm" variant="outline" onClick={clearFilters} disabled={!hasFilters}>
          <FilterX aria-hidden className="size-4 me-1" /> {FILTER_LABELS.reset}
        </Button>
        <Button size="sm" variant="outline" onClick={exportAll} disabled={effectiveBranch == null}>
          <Download aria-hidden className="size-4 me-1" /> تصدير Excel
        </Button>
      </div>

      {list.isLoading ? (
        <LoadingState />
      ) : list.isError ? (
        <ErrorState onRetry={() => list.refetch()} />
      ) : (
        <ScrollTableShell>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>رقم الحجز</TableHead>
                <TableHead>العميل</TableHead>
                <TableHead>الهاتف</TableHead>
                <TableHead>طريقة وصول الحجز</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead>ينتهي</TableHead>
                <TableHead>إجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">لا حجوزات مطابقة.</TableCell></TableRow>
              ) : (
                rows.map((r) => {
                  const st = r.status as ReservationStatus;
                  const closeable = CLOSEABLE.includes(st);
                  // D (١٢/٨): إبراز بصريّ للحجوزات قرب الانتهاء + المنتهية — «أكثر وضوحاً وتطوّراً».
                  // - active + <٤س: تظليل كهرمانيّ + شارة «ينتهي قريباً» + رقم/تاريخ بلون التحذير.
                  // - EXPIRED: تظليل رماديّ باهت (اكتمل السحب من الكرون، لكن السطر مرئيّ للفهم).
                  // العتبة ٤س = ربع مدّة الحجز الافتراضيّة (١٦س) — «آخر ربع» يعطي الكاشير فرصة الاتّصال أو التمديد.
                  const msLeft = r.expiresAt && closeable ? new Date(r.expiresAt).getTime() - Date.now() : null;
                  const expiringSoon = msLeft != null && msLeft > 0 && msLeft < 4 * 3600 * 1000;
                  const isExpired = st === "EXPIRED";
                  return (
                    <TableRow
                      key={r.id}
                      className={cn(
                        expiringSoon && "bg-[var(--sem-warn)]/10 hover:bg-[var(--sem-warn)]/20",
                        isExpired && "bg-muted/50 text-muted-foreground",
                      )}
                    >
                      <TableCell className="font-mono" dir="ltr">{r.reservationNumber}</TableCell>
                      <TableCell>{r.contactName || <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell dir="ltr">{r.contactPhone}</TableCell>
                      <TableCell>{CHANNEL_LABEL[r.channel as Channel] ?? r.channel}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Badge variant={STATUS_VARIANT[st]}>{STATUS_LABEL[st] ?? st}</Badge>
                          {expiringSoon && (
                            <Badge variant="outline" className="border-[var(--sem-warn)] text-[var(--sem-warn)] font-bold text-[10px]">
                              ينتهي قريباً
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className={cn("text-xs", expiringSoon && "font-bold text-[var(--sem-warn)]")} dir="ltr">
                        {r.expiresAt ? fmtDateTime(r.expiresAt) : "—"}
                      </TableCell>
                      <TableCell>
                        <RowActions
                          mode="auto"
                          contact={{
                            phone: r.contactPhone,
                            label: `واتساب ${r.contactName || "العميل"}`,
                            message: buildOperationalContactMessage({
                              partyName: r.contactName,
                              entityLabel: "الحجز",
                              reference: r.reservationNumber,
                              status: STATUS_LABEL[st] ?? st,
                              dueAt: r.expiresAt,
                              nextAction: closeable ? "يرجى تأكيد الحجز أو التواصل معنا قبل انتهاء مدته." : null,
                            }),
                            gate: { module: "reservations", level: "READ" },
                          }}
                          actions={[
                            {
                              key: "view",
                              kind: "view",
                              label: "التفاصيل",
                              icon: Eye,
                              onSelect: () => setDetailId(Number(r.id)),
                              gate: { module: "reservations", level: "READ" },
                            },
                            {
                              // B (١٢/٨): طباعة تذكرة حجز حراريّة — تفتح حوار التفاصيل ثمّ الطباعة
                              // منه (ملاحظة Codex P2 على PR #557): استدعاءُ `printDoc` بعد await شبكيّ
                              // يفقد **user activation** فيرفض المتصفّح `window.open` في المسار الاحتياطي
                              // (لا جسر ولا WebUSB). زرّ الطباعة في تذييل الحوار يُطلقه بعد اكتمال جلب
                              // التفاصيل ⇒ ضغطة زرٍّ متزامنةٌ حديثة الـactivation، وبيانات كاملة جاهزة.
                              key: "print",
                              kind: "view",
                              label: "طباعة تذكرة الحجز",
                              icon: Printer,
                              onSelect: () => setDetailId(Number(r.id)),
                              gate: { module: "reservations", level: "READ" },
                            },
                            {
                              key: "convert",
                              kind: "create",
                              label: "تحويل إلى فاتورة",
                              icon: ShoppingCart,
                              hidden: !canWrite || !closeable,
                              gate: { roles: ["cashier", "manager", "sales_rep"], module: "reservations", level: "FULL" },
                              disabled: convert.isPending,
                              disabledReason: "جارٍ تحويل الحجز",
                              onSelect: () => onConvert(r),
                            },
                            {
                              key: "cancel",
                              kind: "delete",
                              label: "إلغاء الحجز",
                              icon: Trash2,
                              variant: "destructive",
                              hidden: !canWrite || !closeable,
                              gate: { roles: ["cashier", "manager", "sales_rep"], module: "reservations", level: "FULL" },
                              disabled: cancel.isPending,
                              disabledReason: "جارٍ إلغاء الحجز",
                              onSelect: () => onCancel(r),
                            },
                            {
                              key: "extend",
                              kind: "edit",
                              label: "تمديد الحجز",
                              icon: Clock,
                              hidden: !canManage || !closeable,
                              gate: { roles: ["manager"], module: "reservations", level: "FULL" },
                              disabled: extend.isPending,
                              disabledReason: "جارٍ تمديد الحجز",
                              onSelect: () => onExtend(r),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </ScrollTableShell>
      )}

      {/* ترقيم خادمي (offset/hasMore) — بدل الاقتطاع الصامت عند ٢٠٠. */}
      {!list.isLoading && !list.isError && (page > 0 || hasMore) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0 || list.isFetching}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            السابق
          </Button>
          <span className="text-xs text-muted-foreground">
            صفحة {page + 1}
            {hasMore ? " — توجد نتائج أخرى، انتقل للتالي أو ضيّق الفلاتر" : ""}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!hasMore || list.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            التالي
          </Button>
        </div>
      )}

      {showNew && effectiveBranch != null && (
        <NewReservationDialog
          branchId={effectiveBranch}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); utils.reservations.list.invalidate(); }}
        />
      )}

      <Dialog open={convertTarget != null} onOpenChange={(open) => !open && !isConversionBusy && !convert.isPending && closeConversionDialog()}>
        <DialogContent className="sm:max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle>تحويل الحجز إلى طلب</DialogTitle>
            <DialogDescription>
              الحجز {convertTarget?.reservationNumber} جاهز للتنفيذ. أدخل المبلغ الذي استلمته من العميل الآن.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            {conversionStockShortages.length ? (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden />
                <AlertTitle>المخزون الفعلي لم يعد يغطي الحجز</AlertTitle>
                <AlertDescription>
                  {conversionStockShortages.map((row) => `${row.productName}: المتبقي ${row.remainingBase}، الفعلي ${row.currentOnHandBase}`).join(" — ")}
                  . لن تُنشأ فاتورة ناقصة؛ عالج الرصيد أولاً.
                </AlertDescription>
              </Alert>
            ) : conversionAvailabilityDrops.length || convertAvailabilityWarning ? (
              <Alert className="border-warning/30 bg-warning/5">
                <TriangleAlert className="text-warning" aria-hidden />
                <AlertTitle>انخفض المتاح بعد فتح الحوار</AlertTitle>
                <AlertDescription>
                  {convertAvailabilityWarning ?? "أولوية هذا الحجز محفوظة؛ انخفاض ATP بسبب حجوزات أخرى لا يمنع التحويل ما دام المخزون الفعلي يغطيه."}
                </AlertDescription>
              </Alert>
            ) : null}

            {/* «ماذا حجزتُ لك؟» — بنود الحجز والإجمالي قبل استلام المبلغ. */}
            <div className="space-y-1.5">
              <Label>بنود الحجز</Label>
              {convertDetail.isLoading ? (
                <LoadingState />
              ) : convertDetail.data ? (
                <ReservationLinesBlock detail={convertDetail.data} />
              ) : (
                <p className="text-xs text-muted-foreground">تعذّر تحميل بنود الحجز.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reservation-payment-amount">المبلغ المدفوع الآن (د.ع)</Label>
              <MoneyInput
                id="reservation-payment-amount"
                value={convertAmount}
                onChange={setConvertAmount}
                disabled={isConversionBusy || convert.isPending}
                decimals={0}
                placeholder="اتركه فارغاً للبيع الآجل"
                ariaLabel="المبلغ المدفوع عند تحويل الحجز"
              />
              <p className="text-[11px] text-muted-foreground">النقد يُضاف إلى مبلغ الدرج. البطاقة والتحويل يُسجّلان منفصلين.</p>
            </div>

            {convertAmount.trim() && Number(convertAmount) > 0 ? (
              <div className="space-y-2">
                <Label>طريقة الدفع</Label>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { value: "CASH", label: "نقدي", Icon: Banknote },
                    { value: "CARD", label: "بطاقة", Icon: CreditCard },
                    { value: "TRANSFER", label: "تحويل", Icon: ArrowLeftRight },
                  ] as const).map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      type="button"
                      disabled={isConversionBusy || convert.isPending || !isPosPaymentMethodEnabled(value)}
                      aria-describedby={!isPosPaymentMethodEnabled(value) ? "reservation-external-payment-disabled" : undefined}
                      title={isPosPaymentMethodEnabled(value) ? label : posPaymentRejectionMessage(value)}
                      onClick={() => {
                        if (!isPosPaymentMethodEnabled(value)) return;
                        setConvertMethod(value);
                        setConvertReference("");
                      }}
                      className={cn(
                        "flex h-14 flex-col items-center justify-center gap-1 rounded-lg border-2 text-xs font-extrabold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                        convertMethod === value ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
                      )}
                    >
                      <Icon className="size-4" aria-hidden /> {label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {convertAmount.trim() && Number(convertAmount) > 0 && convertMethod !== "CASH" ? (
              <div className="space-y-1.5">
                <Label htmlFor="reservation-payment-reference">
                  {convertMethod === "CARD" ? "رقم عملية البطاقة" : "رقم مرجع التحويل"} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="reservation-payment-reference"
                  value={convertReference}
                  onChange={(e) => setConvertReference(e.target.value)}
                  disabled={isConversionBusy || convert.isPending}
                  maxLength={100}
                  autoComplete="off"
                  placeholder="أدخل الرقم الظاهر في الإيصال أو تطبيق البنك"
                  dir="ltr"
                />
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={closeConversionDialog} disabled={isConversionBusy || convert.isPending}>إلغاء</Button>
            <Button
              onClick={() => void submitConversion()}
              disabled={isConversionBusy || convert.isPending || convertDetail.isFetching || convertAvailabilitySnapshot == null || conversionStockShortages.length > 0}
            >
              <ShoppingCart className="size-4 me-1" aria-hidden />
              {convert.isPending ? "جارٍ الإتمام…" : isConversionBusy || convertDetail.isFetching ? "جارٍ التحقق…" : "تأكيد الطلب"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار التفاصيل — بنود الحجز (منتجات/كميات/أسعار) مع الإجمالي. */}
      <Dialog open={detailId != null} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent className="sm:max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle>تفاصيل الحجز {detail.data?.reservationNumber ?? ""}</DialogTitle>
            <DialogDescription>البنود المحجوزة بسعرها المرجعي وقت الحجز.</DialogDescription>
          </DialogHeader>
          {detail.isLoading ? (
            <LoadingState />
          ) : detail.isError ? (
            <ErrorState onRetry={() => detail.refetch()} />
          ) : detail.data ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <div><span className="text-muted-foreground">العميل: </span>{detail.data.contactName || "—"}</div>
                <div><span className="text-muted-foreground">الهاتف: </span><span dir="ltr">{detail.data.contactPhone}</span></div>
                <div><span className="text-muted-foreground">طريقة وصول الحجز: </span>{CHANNEL_LABEL[detail.data.channel as Channel] ?? detail.data.channel}</div>
                <div>
                  <span className="text-muted-foreground">الحالة: </span>
                  <Badge variant={STATUS_VARIANT[detail.data.status as ReservationStatus]}>
                    {STATUS_LABEL[detail.data.status as ReservationStatus] ?? detail.data.status}
                  </Badge>
                </div>
                <div><span className="text-muted-foreground">ينتهي: </span><span dir="ltr">{detail.data.expiresAt ? fmtDateTime(detail.data.expiresAt) : "—"}</span></div>
                <div><span className="text-muted-foreground">أُنشئ: </span><span dir="ltr">{detail.data.createdAt ? fmtDateTime(detail.data.createdAt) : "—"}</span></div>
              </div>
              <ReservationLinesBlock detail={detail.data} />
              {detail.data.notes && (
                <p className="text-xs text-muted-foreground">ملاحظات: {detail.data.notes}</p>
              )}
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-2">
            {/* B (١٢/٨): زرّ طباعة داخل الحوار — بارزٌ عند فتح التفاصيل، لا حاجة للعودة لمنسدل الصفّ. */}
            {detail.data && (
              <Button
                variant="outline"
                onClick={() => detail.data && printReservationTicket(detail.data)}
              >
                <Printer className="size-4 me-1" aria-hidden />
                طباعة تذكرة حرارية
              </Button>
            )}
            <Button variant="outline" onClick={() => setDetailId(null)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار الإلغاء (بديل window.prompt) — سبب اختياري. */}
      <Dialog
        open={cancelTarget != null}
        onOpenChange={(o) => { if (!o && !cancel.isPending) { setCancelTarget(null); setCancelReason(""); } }}
      >
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>إلغاء الحجز {cancelTarget?.reservationNumber}</DialogTitle>
            <DialogDescription>يُحرَّر المحجوز فوراً ويُعلَّم الحجز «ملغى». لا يمكن التراجع بعد التأكيد.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="res-cancel-reason">سبب الإلغاء (اختياري)</Label>
            <Input
              id="res-cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              maxLength={300}
              placeholder="مثال: العميل اعتذر عن الحضور"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => { setCancelTarget(null); setCancelReason(""); }} disabled={cancel.isPending}>تراجع</Button>
            <Button variant="destructive" onClick={submitCancel} disabled={cancel.isPending}>
              <Trash2 className="size-4 me-1" aria-hidden />
              {cancel.isPending ? ACTION_LABELS.cancelling : "تأكيد الإلغاء"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار التمديد (بديل window.prompt) — ساعات ١–٧٢. */}
      <Dialog
        open={extendTarget != null}
        onOpenChange={(o) => { if (!o && !extend.isPending) setExtendTarget(null); }}
      >
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>تمديد الحجز {extendTarget?.reservationNumber}</DialogTitle>
            <DialogDescription>
              ينتهي حالياً: <span dir="ltr">{extendTarget?.expiresAt ? fmtDateTime(extendTarget.expiresAt) : "—"}</span> — تُضاف المدّة إلى وقت الانتهاء.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="res-extend-hours">مدّة التمديد بالساعات (١–٧٢)</Label>
            <Input
              id="res-extend-hours"
              dir="ltr"
              type="number"
              min={1}
              max={72}
              value={extendHours}
              onChange={(e) => setExtendHours(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setExtendTarget(null)} disabled={extend.isPending}>تراجع</Button>
            <Button onClick={submitExtend} disabled={extend.isPending}>
              <Clock className="size-4 me-1" aria-hidden />
              {extend.isPending ? "جارٍ التمديد…" : "تمديد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** بنود الحجز مع الإجمالي — تُستعمل في حوار التفاصيل وحوار التحويل («ماذا حجزتُ لك؟»).
 *  المبالغ نصوص جاهزة من الخادم (decimal) — العرض بـfmt فقط، بلا حساب عميلي. */
function ReservationLinesBlock({ detail }: { detail: ReservationDetail }) {
  if (detail.lines.length === 0) {
    return <p className="text-xs text-muted-foreground">لا بنود مسجلة لهذا الحجز.</p>;
  }
  return (
    <div className="rounded-md border divide-y text-sm">
      {detail.lines.map((l) => {
        const variantLabel = l.variantName || [l.color, l.size].filter(Boolean).join(" / ");
        return (
          <div key={l.id} className="flex items-center gap-2 p-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">
                {l.productName}
                {variantLabel ? <span className="text-muted-foreground"> — {variantLabel}</span> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {l.unitName} × {l.quantity.toLocaleString("en-US")}
                {l.quotedUnitPrice != null ? ` · السعر ${fmt(l.quotedUnitPrice)} د.ع` : " · بلا سعر مرجعي"}
              </div>
            </div>
            <div className="font-bold tabular-nums" dir="ltr">{l.lineTotal != null ? fmt(l.lineTotal) : "—"}</div>
          </div>
        );
      })}
      <div className="flex items-center justify-between p-2 bg-muted/40">
        <span className="font-bold">الإجمالي{detail.hasUnpriced ? " (جزئي — بند بلا سعر مرجعي)" : ""}</span>
        <span className="font-extrabold tabular-nums" dir="ltr">{fmt(detail.total)} د.ع</span>
      </div>
    </div>
  );
}

interface LineDraft {
  variantId: number;
  productUnitId: number;
  name: string;
  unit: string;
  stockBase: number;
  price: string;
  qty: number;
}

function NewReservationDialog({ branchId, onClose, onCreated }: { branchId: number; onClose: () => void; onCreated: () => void }) {
  const [contactPhone, setContactPhone] = useState("");
  const [contactName, setContactName] = useState("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [channel, setChannel] = useState<Channel>("PHONE");
  const [expiresInHours, setExpiresInHours] = useState("24");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);

  const create = trpc.reservations.create.useMutation({
    onSuccess: (r) => {
      if (r.overbookedVariantIds.length > 0) {
        notify.warn(`أُنشئ الحجز ${r.reservationNumber} — تنبيه: ${r.overbookedVariantIds.length} منتج محجوز فوق المتاح.`);
      } else {
        notify.ok(`أُنشئ الحجز ${r.reservationNumber}`);
      }
      onCreated();
    },
    onError: (e) => notify.err(e),
  });

  function addFromSearch(line: InvoiceLine) {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.variantId === line.variantId && l.productUnitId === line.productUnitId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
        return next;
      }
      return [...prev, {
        variantId: line.variantId,
        productUnitId: line.productUnitId,
        name: line.name,
        unit: line.unit,
        stockBase: line.stockBase,
        price: line.price || "0",
        qty: 1,
      }];
    });
  }
  function setQty(i: number, qty: number) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, qty } : l)));
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  function submit() {
    if (!contactPhone.trim()) { notify.err("هاتف العميل مطلوب"); return; }
    if (lines.length === 0) { notify.err("أضف منتجاً واحداً على الأقل"); return; }
    if (lines.some((l) => !(l.qty > 0))) { notify.err("كل كمية يجب أن تكون موجبة"); return; }
    const hours = Number(expiresInHours);
    create.mutate({
      branchId,
      contactPhone: contactPhone.trim(),
      contactName: contactName.trim() || null,
      customerId,
      channel,
      expiresInHours: Number.isInteger(hours) && hours > 0 && hours <= 72 ? hours : null,
      notes: notes.trim() || null,
      lines: lines.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        quantity: l.qty,
        quotedUnitPrice: l.price,
      })),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>حجز جديد</DialogTitle>
          <DialogDescription>احجز منتجات لعميل بمدّة انتهاء. الهاتف إلزاميّ لاستدعاء الحجز عند الحضور.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[70vh] overflow-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="res-phone">هاتف العميل *</Label>
              <IntlPhoneInput id="res-phone" value={contactPhone} onChange={setContactPhone} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="res-name">اسم العميل</Label>
              <Input id="res-name" placeholder="اختياري" value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </div>
          </div>

          <CustomerPicker customerId={customerId} onCustomerChange={setCustomerId} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="res-channel">طريقة وصول الحجز</Label>
              <AppSelect id="res-channel" className={`${selectCls} w-full`} value={channel} onValueChange={(next) => setChannel(next as Channel)}>
                {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="res-hours">مدّة الحجز (ساعات، ≤٧٢)</Label>
              <Input id="res-hours" dir="ltr" type="number" min={1} max={72} value={expiresInHours} onChange={(e) => setExpiresInHours(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>المنتجات</Label>
            <ProductSearchBar invoiceType="SALE" branchId={branchId} tier="RETAIL" onAddProduct={addFromSearch} onNotify={(m, k) => (k === "error" ? notify.err(m) : notify.info(m))} />
            {lines.length > 0 && (
              <div className="rounded-md border divide-y">
                {lines.map((l, i) => (
                  <div key={`${l.variantId}-${l.productUnitId}`} className="flex items-center gap-2 p-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{l.name}</div>
                      <div className="text-xs text-muted-foreground">{l.unit} · مخزون {l.stockBase.toLocaleString("en-US")}</div>
                    </div>
                    <Input
                      dir="ltr" type="number" min={1} step="any" className="w-20 h-8"
                      value={l.qty}
                      onChange={(e) => setQty(i, Number(e.target.value))}
                      aria-label="الكمية"
                    />
                    <Button size="sm" variant="ghost" onClick={() => removeLine(i)} aria-label="حذف المنتج"><X aria-hidden className="size-4" /></Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="res-notes">ملاحظات</Label>
            <Input id="res-notes" placeholder="اختياري" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={submit} disabled={create.isPending || !contactPhone.trim() || lines.length === 0}>
            {create.isPending ? "جارٍ…" : "إنشاء الحجز"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
