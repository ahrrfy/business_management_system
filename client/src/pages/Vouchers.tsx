import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { CopyInline } from "@/components/CopyButton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { RowActions } from "@/components/list";
import { confirm } from "@/lib/confirm";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmtDate } from "@/lib/date";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printVoucherReceipt, printVoucherA4, type VoucherPrintData } from "@/lib/printing/voucherPrint";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { CheckCircle2, XCircle, Paperclip, ShieldQuestion, Link2, X } from "lucide-react";

type VoucherRow = RouterOutputs["vouchers"]["list"][number];

/** سجلّ السندات المستقلّة (قبض + صرف) — vouchers-pro: تَصنيف + اعتماد + بَصمة + مُرفق. */
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const TYPE_LABEL: Record<string, string> = { IN: "قبض", OUT: "صرف" };
const PARTY_LABEL: Record<string, string> = { CUSTOMER: "عميل", SUPPLIER: "مورّد", OTHER: "أخرى" };
const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "صكّ", TRANSFER: "تحويل", WALLET: "محفظة", EXCHANGE: "صيرفة", TELECOM: "رصيد زين",
};
const APPROVAL_LABEL: Record<string, string> = {
  APPROVED: "مُعتمَد",
  PENDING_APPROVAL: "بانتظار الاعتماد",
  REJECTED: "مَرفوض",
};

function shortHash(h?: string | null): string {
  return h ? String(h).slice(0, 8).toUpperCase() : "—";
}

export default function Vouchers() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canManage = me.data &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "treasury", "FULL", ["manager", "accountant"]);
  // الفلاتر تعيش في querystring — تبقى مع فتح التفاصيل والرجوع، وتُشارَك رابطاً.
  const [f, setF, resetF] = useUrlFilters({
    type: "", party: "", method: "", approval: "", cat: "", branch: "", status: "", from: "", to: "", q: "",
  });
  const debouncedQ = useDebouncedValue(f.q.trim(), 250);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const limit = 100;

  /** أي تغيير فلتر يعيد الترقيم للصفحة الأولى. */
  function applyFilter(patch: Partial<typeof f>) {
    setF(patch);
    setPage(0);
  }

  const categories = trpc.voucherCategories.list.useQuery({ includeInactive: true });
  const branches = trpc.branches.list.useQuery();
  // فلتر الفرع فعّال للأدمن/مدير بلا فرع مُسنَد فقط — الخادم يفرض فرع البقية أياً كان المُرسَل.
  const canFilterBranch = me.data != null && (me.data.role === "admin" || me.data.branchId == null);

  const filterInput = useMemo(
    () => ({
      voucherType: (f.type || undefined) as "RECEIPT" | "PAYMENT" | undefined,
      partyType: (f.party || undefined) as "CUSTOMER" | "SUPPLIER" | "OTHER" | undefined,
      paymentMethod: (f.method || undefined) as "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET" | "EXCHANGE" | undefined,
      approvalStatus: (f.approval || undefined) as "APPROVED" | "PENDING_APPROVAL" | "REJECTED" | undefined,
      status: (f.status || undefined) as "COMPLETED" | "REVERSED" | undefined,
      branchId: f.branch ? Number(f.branch) : undefined,
      voucherCategoryId: f.cat ? Number(f.cat) : undefined,
      q: debouncedQ || undefined,
      from: f.from || undefined,
      to: f.to || undefined,
    }),
    [f, debouncedQ],
  );

  const input = useMemo(
    () => ({ ...filterInput, limit, offset: page * limit }),
    [filterInput, page],
  );
  const list = trpc.vouchers.list.useQuery(input);
  const all = list.data ?? [];
  // مجاميع كامل النطاق المفلتر من الخادم (لا جمع صفوف الصفحة — كان مضلّلاً فوق ١٠٠ سند).
  const agg = trpc.vouchers.aggregate.useQuery(filterInput);

  const cancelMut = trpc.vouchers.cancel.useMutation({
    onSuccess: async (res) => {
      await Promise.all([utils.vouchers.list.invalidate(), utils.vouchers.aggregate.invalidate()]);
      notify.ok(`أُلغي السند ${res.voucherNumber} وعُكست آثاره المالية`);
    },
    onError: (e) => notify.err(e),
  });

  const approveMut = trpc.vouchers.approve.useMutation({
    onSuccess: async (res) => {
      await Promise.all([utils.vouchers.list.invalidate(), utils.vouchers.aggregate.invalidate()]);
      notify.ok(`اعتُمد السند ${res.voucherNumber} — بَصمة ${shortHash(res.signatureHash)}`);
    },
    onError: (e) => notify.err(e),
  });

  // حوار سبب الرفض (بديل window.prompt — نمط حوارات النظام).
  const [rejectTarget, setRejectTarget] = useState<VoucherRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const rejectMut = trpc.vouchers.reject.useMutation({
    onSuccess: async (res) => {
      setRejectTarget(null);
      await Promise.all([utils.vouchers.list.invalidate(), utils.vouchers.aggregate.invalidate()]);
      notify.ok(`رُفض السند ${res.voucherNumber}`);
    },
    onError: (e) => notify.err(e),
  });

  async function approveVoucher(r: VoucherRow) {
    const ok = await confirm({
      variant: "info",
      title: "اعتماد السند",
      description: `سَيُصبح السند ${r.voucherNumber ?? ""} مُعتمَداً ويُسجَّل قيد الدفتر ويُؤثّر على ${
        r.partyType === "CUSTOMER" ? "ذمة العميل" : r.partyType === "SUPPLIER" ? "ذمة المورّد" : "الصندوق"
      } بمبلغ ${fmt(r.amount)} د.ع. هل تتابع؟`,
      confirmText: "اعتماد",
      cancelText: "تراجع",
    });
    if (!ok) return;
    approveMut.mutate({ receiptId: Number(r.id) });
  }

  function openReject(r: VoucherRow) {
    setRejectReason("");
    setRejectTarget(r);
  }

  function submitReject() {
    const reason = rejectReason.trim();
    if (!reason || !rejectTarget || rejectMut.isPending) return;
    rejectMut.mutate({ receiptId: Number(rejectTarget.id), reason });
  }

  async function cancelVoucher(r: VoucherRow) {
    const partyLabel = PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—";
    const ok = await confirm({
      variant: "danger",
      title: "إلغاء السند",
      description: `سيُعلَّم السند ${r.voucherNumber ?? ""} «مُلغى» ويُعكس مبلغ ${fmt(r.amount)} د.ع (الطرف: ${partyLabel}) في الصندوق والدفتر ورصيد الطرف. هل تتابع؟`,
      confirmText: "إلغاء السند",
      cancelText: "تراجع",
    });
    if (!ok) return;
    cancelMut.mutate({ receiptId: Number(r.id) });
  }

  // البحث جزء من استعلام الخادم، لذلك تشمل النتائج كل السندات لا الصفحة الحالية فقط.
  const rows = all;

  // المَجاميع خادمية (aggregate) على كامل النطاق المفلتر — القبض/الصرف من المُعتمَد غير الملغى،
  // والمعلّق بلا أَثَر مالي بَعد. الصافي بdecimal لا Number (أموال).
  const totalIn = agg.data?.totalIn ?? "0";
  const totalOut = agg.data?.totalOut ?? "0";
  const netTotal = useMemo(() => D(totalIn).minus(D(totalOut)), [totalIn, totalOut]);
  const totalCount = agg.data?.count;
  const pageCount = totalCount != null ? Math.max(1, Math.ceil(totalCount / limit)) : null;
  // «التالي» بcount الخادمي؛ وقبل وصول aggregate نتحفّظ بقاعدة «صفحة ممتلئة = قد يوجد تالٍ».
  const hasNext = totalCount != null ? (page + 1) * limit < totalCount : all.length >= limit;

  const categoryMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of categories.data ?? []) m.set(Number(c.id), c.name);
    return m;
  }, [categories.data]);

  const branchMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of branches.data ?? []) m.set(Number(b.id), b.name);
    return m;
  }, [branches.data]);

  async function exportAll() {
    if (exporting) return;
    setExporting(true);
    try {
      const fetched = await fetchAllPaged<VoucherRow>(
        (offset, lim) =>
          utils.vouchers.list
            .fetch({ ...filterInput, limit: lim, offset })
            .then((arr) => ({ rows: (arr ?? []) as VoucherRow[] })),
        { pageSize: 200 },
      );
      exportRows(fetched, {
        filename: "السندات",
        columns: [
          { key: "voucherNumber", header: "رقم السند" },
          { key: "voucherDate", header: "تاريخ السند", map: (r) => fmtDate(r.voucherDate as any) },
          { key: "createdAt", header: "تاريخ الإدخال", map: (r) => fmtDate(r.createdAt as any) },
          { key: "branchId", header: "الفرع", map: (r) => (r.branchId != null ? (branchMap.get(Number(r.branchId)) ?? String(r.branchId)) : "—") },
          { key: "direction", header: "النوع", map: (r) => TYPE_LABEL[r.direction] ?? r.direction },
          { key: "partyType", header: "نوع الطرف", map: (r) => PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—" },
          { key: "counterpartyName", header: "اسم المُستفيد" },
          {
            key: "voucherCategoryId",
            header: "الفئة",
            map: (r) => (r.voucherCategoryId ? (categoryMap.get(Number(r.voucherCategoryId)) ?? "—") : "—"),
          },
          { key: "description", header: "الوصف" },
          { key: "amount", header: "المبلغ", map: (r) => Number(r.amount ?? 0) },
          { key: "paymentMethod", header: "الدفع", map: (r) => METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod },
          { key: "referenceNumber", header: "الرقم المرجعي" },
          { key: "checkNumber", header: "رقم الصكّ" },
          { key: "cardLastFour", header: "آخر ٤ بطاقة" },
          { key: "approvalStatus", header: "حالة الاعتماد", map: (r) => APPROVAL_LABEL[r.approvalStatus ?? "APPROVED"] ?? "—" },
          { key: "status", header: "الحالة", map: (r) => (r.status === "REVERSED" ? "مُلغى" : "مكتمل") },
          // attachment-upload (٥/٧): المُرفق أصبح data URL صورة (~٩٣٣ك حرفاً) — تصديره خاماً يُفسد
          // الخلية (حدّ Excel ~٣٢،٧٦٧ حرفاً) ⇒ نعم/لا فقط؛ المُلَفّ نفسه يُفتَح من الشاشة مباشرةً.
          { key: "attachmentUrl", header: "مُرفَق؟", map: (r) => (r.attachmentUrl ? "نعم" : "لا") },
          { key: "invoiceNumber", header: "الفاتورة المرتبطة", map: (r) => r.invoiceNumber ?? "—" },
          { key: "signatureHash", header: "بَصمة", map: (r) => shortHash(r.signatureHash) },
          { key: "cashBucket", header: "نوع النَقد", map: (r) => (r.cashBucket === "DRAWER" ? "درج كاشير" : r.cashBucket === "TREASURY" ? "خزينة إدارية" : "—") },
        ],
      });
    } catch (e) {
      notify.err(e);
    } finally {
      setExporting(false);
    }
  }

  // طباعة السند: نَطلب السند الكامل من السيرفر (يَتضمَّن createdByName/approvedByName/categoryName/partyName).
  async function printVoucher(r: VoucherRow, mode: "thermal" | "a4") {
    try {
      const v = await utils.vouchers.get.fetch({ receiptId: Number(r.id) });
      if (!v) { notify.err("تعذّر جَلب تفاصيل السند"); return; }
      const branchName = null; // يُمكن إضافة branches.list هنا لاحقاً إذا لَزِم
      const payload: VoucherPrintData = {
        voucherNumber: v.voucherNumber ?? "",
        direction: v.direction as "IN" | "OUT",
        voucherDate: String(v.voucherDate ?? fmtDate(v.createdAt as any)).slice(0, 10),
        createdAt: String(v.createdAt),
        branchName,
        amount: fmt(v.amount),
        paymentMethod: v.paymentMethod,
        paymentMethodLabel: METHOD_LABEL[v.paymentMethod] ?? v.paymentMethod,
        referenceNumber: v.referenceNumber,
        checkNumber: v.checkNumber,
        cardLastFour: v.cardLastFour,
        partyTypeLabel: PARTY_LABEL[v.partyType ?? "OTHER"] ?? "—",
        partyName: v.partyName ?? (v.counterpartyName ?? "—"),
        partyBalance: null,
        categoryName: v.categoryName,
        description: v.description ?? "",
        counterpartyName: v.counterpartyName,
        approvalStatus: v.approvalStatus as "APPROVED" | "PENDING_APPROVAL" | "REJECTED",
        approvedByName: v.approvedByName,
        approvedAt: v.approvedAt ? String(v.approvedAt) : null,
        createdByName: v.createdByName,
        cashBucket: v.cashBucket as "DRAWER" | "TREASURY" | null,
        signatureHash: v.signatureHash,
        attachmentUrl: v.attachmentUrl,
        relatedInvoiceNumber: v.invoiceNumber ?? null,
      };
      if (mode === "a4") await printVoucherA4(payload);
      else await printVoucherReceipt(payload);
    } catch (e) {
      notify.err(e);
    }
  }

  const statementHref = (r: VoucherRow) =>
    r.partyType === "CUSTOMER" ? `/customers-statement?id=${r.partyId}` : `/suppliers-statement?id=${r.partyId}`;

  const activeFilterCount = [
    f.type,
    f.party,
    f.method,
    f.approval,
    f.cat,
    f.branch,
    f.status,
    f.from,
    f.to,
  ].filter((value) => value !== "").length;

  function resetFilters() {
    resetF();
    setPage(0);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="سندات القبض والصرف"
        description="سندات مستقلّة بلا فاتورة — رواتب، إيجارات، إيرادات متفرّقة، دفعات لعميل/مورّد بلا ربط بفاتورة محدّدة."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/voucher-categories">
              <Button variant="outline" size="sm">إدارة الفئات</Button>
            </Link>
            <Link href="/vouchers/receipt/new">
              <Button className="bg-emerald-600 hover:bg-emerald-700">+ سند قبض</Button>
            </Link>
            <Link href="/vouchers/payment/new">
              <Button className="bg-rose-600 hover:bg-rose-700">+ سند صرف</Button>
            </Link>
          </div>
        }
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">فلاتر</CardTitle>
            {activeFilterCount > 0 && (
              <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                {activeFilterCount.toLocaleString("ar-IQ-u-nu-latn")} فلاتر
              </span>
            )}
          </div>
          {(activeFilterCount > 0 || f.q.trim()) && (
            <Button variant="ghost" size="sm" onClick={resetFilters} className="text-muted-foreground">
              <X aria-hidden className="size-4" />
              مسح الفلاتر
            </Button>
          )}
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3 items-end">
          <div className="space-y-1">
            <Label>النوع</Label>
            <select className={selectCls} value={f.type} onChange={(e) => applyFilter({ type: e.target.value })}>
              <option value="">الكل</option>
              <option value="RECEIPT">قبض</option>
              <option value="PAYMENT">صرف</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>الطرف</Label>
            <select className={selectCls} value={f.party} onChange={(e) => applyFilter({ party: e.target.value })}>
              <option value="">الكل</option>
              <option value="CUSTOMER">عميل</option>
              <option value="SUPPLIER">مورّد</option>
              <option value="OTHER">أخرى</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>طريقة الدفع</Label>
            <select className={selectCls} value={f.method} onChange={(e) => applyFilter({ method: e.target.value })}>
              <option value="">الكل</option>
              <option value="CASH">نقدي</option>
              <option value="CARD">بطاقة</option>
              {/* صكّ: للسجلات التاريخية فقط — الإنشاء الجديد بلا صكوك (قرار المالك). */}
              <option value="CHECK">صكّ</option>
              <option value="TRANSFER">تحويل</option>
              <option value="WALLET">محفظة</option>
              <option value="EXCHANGE">صيرفة</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>الاعتماد</Label>
            <select className={selectCls} value={f.approval} onChange={(e) => applyFilter({ approval: e.target.value })}>
              <option value="">الكل</option>
              <option value="APPROVED">مُعتمَد</option>
              <option value="PENDING_APPROVAL">بانتظار الاعتماد</option>
              <option value="REJECTED">مَرفوض</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>حالة السند</Label>
            <AppSelect
              value={f.status || "all"}
              onValueChange={(v) => applyFilter({ status: v === "all" ? "" : v })}
              aria-label="فلتر حالة السند"
            >
              <option value="all">الكل</option>
              <option value="COMPLETED">مكتمل</option>
              <option value="REVERSED">مُلغى</option>
            </AppSelect>
          </div>
          {canFilterBranch && (
            <div className="space-y-1">
              <Label>الفرع</Label>
              <AppSelect
                value={f.branch || "all"}
                onValueChange={(v) => applyFilter({ branch: v === "all" ? "" : v })}
                aria-label="فلتر الفرع"
              >
                <option value="all">الكل</option>
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={String(b.id)}>{b.name}</option>
                ))}
              </AppSelect>
            </div>
          )}
          <div className="space-y-1">
            <Label>الفئة</Label>
            <select className={selectCls} value={f.cat} onChange={(e) => applyFilter({ cat: e.target.value })}>
              <option value="">الكل</option>
              {(categories.data ?? []).map((c) => (
                <option key={Number(c.id)} value={String(c.id)}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>من تاريخ</Label>
            <Input type="date" dir="ltr" value={f.from} onChange={(e) => applyFilter({ from: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>إلى تاريخ</Label>
            <Input type="date" dir="ltr" value={f.to} onChange={(e) => applyFilter({ to: e.target.value })} />
          </div>
          <div className="space-y-1 md:col-span-3 lg:col-span-5">
            <Label>بحث (رقم/وصف/اسم مُستفيد)</Label>
            <Input
              type="search"
              value={f.q}
              onChange={(e) => applyFilter({ q: e.target.value })}
              placeholder="رقم السند، الوصف، المستفيد، المرجع أو رقم الفاتورة…"
            />
          </div>
        </CardContent>
      </Card>

      {/* البطاقات من aggregate الخادمي — كامل النطاق المفلتر لا صفوف الصفحة الحالية. */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">إجمالي القبض (مُعتمَد)</div>
            <div className="text-xl font-bold text-money-positive tabular-nums" dir="ltr">{fmt(totalIn)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">إجمالي الصرف (مُعتمَد)</div>
            <div className="text-xl font-bold text-money-negative tabular-nums" dir="ltr">{fmt(totalOut)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">الصافي</div>
            <div className={`text-xl font-bold tabular-nums ${netTotal.gte(0) ? "text-money-positive" : "text-money-negative"}`} dir="ltr">
              {fmt(netTotal.toFixed(2))}
            </div>
            {(agg.data?.reversedCount ?? 0) > 0 && (
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {(agg.data?.reversedCount ?? 0).toLocaleString("ar-IQ-u-nu-latn")} سند مُلغى في النطاق
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <ShieldQuestion aria-hidden className="size-3.5" />
              بانتظار اعتماد (بلا أَثَر)
            </div>
            <div className="text-xl font-bold text-amber-700 tabular-nums" dir="ltr">{fmt(agg.data?.pendingTotal ?? "0")}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {(agg.data?.pendingCount ?? 0).toLocaleString("ar-IQ-u-nu-latn")} سند معلّق
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">القائمة</CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {list.isLoading
                ? ""
                : totalCount != null
                  ? `${totalCount.toLocaleString("ar-IQ-u-nu-latn")} سند`
                  : `${rows.length.toLocaleString("ar-IQ-u-nu-latn")} سند`}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0 || exporting}
              onClick={() => void exportAll()}
            >
              {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">رقم السند</th>
                  <th className="p-2">التاريخ</th>
                  <th className="p-2">الفرع</th>
                  <th className="p-2 text-center">النوع</th>
                  <th className="p-2">الطرف</th>
                  <th className="p-2">الفئة</th>
                  <th className="p-2">الوصف</th>
                  <th className="p-2 text-right">المبلغ</th>
                  <th className="p-2 text-center">الدفع</th>
                  <th className="p-2 text-center">الاعتماد</th>
                  <th className="p-2 text-center">المُرفَق</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading && (
                  <tr><td colSpan={12}><LoadingState /></td></tr>
                )}
                {list.isError && !list.isLoading && (
                  <tr>
                    <td colSpan={12}>
                      <ErrorState message={list.error?.message} onRetry={() => void list.refetch()} />
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const partyDisplay = r.partyType === "OTHER"
                    ? (r.counterpartyName ?? "—")
                    : (PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—");
                  const isPending = r.approvalStatus === "PENDING_APPROVAL";
                  const isRejected = r.approvalStatus === "REJECTED";
                  return (
                    <tr
                      key={Number(r.id)}
                      className={`border-t ${r.status === "REVERSED" ? "opacity-60" : ""} ${isPending ? "bg-amber-50/60 dark:bg-amber-950/20" : ""} ${isRejected ? "bg-rose-50/60 dark:bg-rose-950/20" : ""}`}
                    >
                      <td className="p-2 font-mono text-xs">
                        <CopyInline value={String(r.voucherNumber ?? "—")} />
                        {r.signatureHash && (
                          <div className="text-[10px] text-muted-foreground" title={`بَصمة كاملة: ${r.signatureHash}`}>
                            #{shortHash(r.signatureHash)}
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-xs">
                        {fmtDate(r.voucherDate as any)}
                        {r.voucherDate && r.createdAt && (
                          <div className="text-[10px] text-muted-foreground">
                            أُدخل: {fmtDate(r.createdAt as any)}
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-xs">
                        {r.branchId != null ? (branchMap.get(Number(r.branchId)) ?? `فرع ${r.branchId}`) : "—"}
                      </td>
                      <td className="p-2 text-center">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.direction === "IN" ? "badge-status-active" : "badge-stock-out"}`}>
                          {TYPE_LABEL[r.direction]}
                        </span>
                      </td>
                      <td className="p-2 text-xs">
                        {partyDisplay}
                        {r.partyType !== "OTHER" && r.counterpartyName && (
                          <div className="text-[10px] text-muted-foreground">{r.counterpartyName}</div>
                        )}
                        {r.invoiceNumber && (
                          <div className="text-[10px] text-muted-foreground inline-flex items-center gap-1"><Link2 aria-hidden className="size-3" /> فاتورة #{r.invoiceNumber}</div>
                        )}
                      </td>
                      <td className="p-2 text-xs">
                        {r.voucherCategoryId ? (categoryMap.get(Number(r.voucherCategoryId)) ?? "—") : "—"}
                      </td>
                      <td className="p-2">{r.description ?? "—"}</td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.amount)}</td>
                      <td className="p-2 text-center text-xs">{METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}</td>
                      <td className="p-2 text-center">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                          isPending ? "bg-amber-100 text-amber-800"
                          : isRejected ? "bg-rose-100 text-rose-800"
                          : "bg-emerald-100 text-emerald-800"
                        }`}>
                          {isPending && <ShieldQuestion aria-hidden className="size-3" />}
                          {isRejected && <XCircle aria-hidden className="size-3" />}
                          {!isPending && !isRejected && <CheckCircle2 aria-hidden className="size-3" />}
                          {APPROVAL_LABEL[r.approvalStatus ?? "APPROVED"]}
                        </span>
                      </td>
                      <td className="p-2 text-center">
                        {r.attachmentUrl ? (
                          <a href={r.attachmentUrl} target="_blank" rel="noreferrer" title="فتح المُرفق">
                            <Paperclip aria-hidden className="size-4 text-emerald-700 inline" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="p-2 text-center">
                        <RowActions
                          mode="auto"
                          actions={[
                            {
                              key: "print-thermal",
                              kind: "print",
                              label: "طباعة حرارية",
                              onSelect: () => void printVoucher(r, "thermal"),
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "READ" },
                            },
                            {
                              key: "print-a4",
                              kind: "print",
                              label: "طباعة A4 (PDF)",
                              onSelect: () => void printVoucher(r, "a4"),
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "READ" },
                            },
                            {
                              key: "approve",
                              kind: "approve",
                              label: "اعتماد السند",
                              hidden: !canManage || r.approvalStatus !== "PENDING_APPROVAL",
                              disabled: approveMut.isPending,
                              disabledReason: "توجد عملية اعتماد قيد التنفيذ",
                              onSelect: () => void approveVoucher(r),
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                            },
                            {
                              key: "reject",
                              kind: "reverse",
                              label: "رفض السند",
                              variant: "destructive",
                              hidden: !canManage || r.approvalStatus !== "PENDING_APPROVAL",
                              disabled: rejectMut.isPending,
                              disabledReason: "توجد عملية رفض قيد التنفيذ",
                              onSelect: () => openReject(r),
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                            },
                            {
                              key: "stmt",
                              kind: "view",
                              label: "كشف حساب الطرف",
                              href: statementHref(r),
                              hidden: r.partyType === "OTHER" || r.partyType == null || r.partyId == null,
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "READ" },
                            },
                            {
                              key: "cancel",
                              kind: "reverse",
                              label: "إلغاء السند",
                              variant: "destructive",
                              hidden: !canManage || r.status === "REVERSED" || r.paymentMethod === "EXCHANGE",
                              disabled: cancelMut.isPending,
                              disabledReason: "توجد عملية إلغاء قيد التنفيذ",
                              onSelect: () => void cancelVoucher(r),
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
                {!list.isLoading && !list.isError && rows.length === 0 && (
                  <TableEmptyRow colSpan={12} message="لا سندات مطابقة. أضِف سند قبض أو صرف جديداً." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* الترقيم: «التالي» يُعطَّل على آخر صفحة اعتماداً على count الخادمي (كان يقفز لصفحة فارغة). */}
      {(page > 0 || hasNext) && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← السابق</Button>
          <div className="text-muted-foreground">
            صفحة {(page + 1).toLocaleString("ar-IQ-u-nu-latn")}
            {pageCount != null ? ` من ${pageCount.toLocaleString("ar-IQ-u-nu-latn")}` : ""}
          </div>
          <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>التالي →</Button>
        </div>
      )}

      {/* حوار سبب الرفض — بديل window.prompt (سجل تَدقيقي إلزامي). */}
      <Dialog open={rejectTarget != null} onOpenChange={(open) => { if (!open && !rejectMut.isPending) setRejectTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>رفض السند {rejectTarget?.voucherNumber ?? ""}</DialogTitle>
            <DialogDescription>
              سبب الرفض إلزامي للسجل التَدقيقي — يَبقى السند في السجل بلا أي أَثَر مالي.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="voucher-reject-reason">سبب الرفض *</Label>
            <Textarea
              id="voucher-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="مَثلاً: المبلغ لا يطابق المستند المُرفَق"
              rows={3}
              maxLength={500}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)} disabled={rejectMut.isPending}>
              تراجع
            </Button>
            <Button
              variant="destructive"
              onClick={submitReject}
              disabled={!rejectReason.trim() || rejectMut.isPending}
            >
              {rejectMut.isPending ? "جارٍ الرفض…" : "رفض السند"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
