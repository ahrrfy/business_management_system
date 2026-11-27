import { ActorCell } from "@/components/data-table/ActorCell";
import { sanitizeAttachmentHref } from "@shared/attachmentUrl";
import { MovementTypeBadge, PaymentMethodChip } from "@/components/common/MovementBadges";
import { DataTable } from "@/components/data-table/DataTable";
import { StackedEntityCell } from "@/components/data-table/StackedEntityCell";
import { CopyInline } from "@/components/CopyButton";
import type { ImageItem } from "@/components/form/ImageUploader";
import { FilterField, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DigitalStampOverlay } from "@/components/vouchers/DigitalStampOverlay";
import { ResubmitVoucherDialog } from "@/components/vouchers/ResubmitVoucherDialog";
import { VoucherDeepLinkDialog } from "@/components/vouchers/VoucherDeepLinkDialog";
import { VoucherDetailDrawer } from "@/components/vouchers/VoucherDetailDrawer";
import {
  computeVoucherPeriodRange,
  getVoucherExportColumns,
  isNonPoVoucherSystemRef,
  isPurchaseSupplierVoucherRef,
  printVoucherWithAudit,
  toVoucherPrintPayload,
  voucherDirectionText,
  voucherPartyKindText,
  voucherPartyStatementHref,
  voucherShortHash,
  voucherShortHash as shortHash,
  type VoucherPeriodPreset,
  type VoucherRow,
} from "@/components/vouchers/voucherExport";
import { VoucherRejectDialog } from "@/components/vouchers/VoucherRejectDialog";
import { VoucherSummaryCards } from "@/components/vouchers/VoucherSummaryCards";
import {
  accrualPaymentAttemptLabel,
  accrualPaymentResubmitPayload,
  canPrintOfficialVoucher,
  canShowAccrualPaymentResubmit,
  canShowVoucherApprovalAction,
  canShowVoucherRejectAction,
  expectedVoucherSourceLabel,
  validAccrualReissueReason,
  voucherApprovalLabel,
} from "@/components/vouchers/voucherUiPolicy";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { usePrintAudit } from "@/hooks/usePrintAudit";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { printVouchersBatch } from "@/lib/printing/batchInvoicePrint";
import { treasuryOperationAllowed } from "@/lib/treasuryOperationAccess";
import { trpc } from "@/lib/trpc";
import { INBOUND_ENABLED_PAYMENT_METHODS } from "@shared/inboundPaymentPolicy";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { ATTRIBUTION_LABELS, FILTER_LABELS } from "@shared/uiContracts";
import type { ColumnDef } from "@tanstack/react-table";
import { Paperclip, Printer, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

export default function Vouchers() {
  const utils = trpc.useUtils();
  const printAudit = usePrintAudit();
  const me = trpc.auth.me.useQuery();
  const legacyCanManage =
    !!me.data &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "treasury",
      "FULL",
      ["manager", "accountant"],
    );
  const canCancel = treasuryOperationAllowed(me.data, "vouchers.cancel", legacyCanManage);
  const canResubmit = treasuryOperationAllowed(me.data, "vouchers.resubmitExpensePayment", legacyCanManage);
  const canApproveReceipt = treasuryOperationAllowed(me.data, "vouchers.approve", legacyCanManage);
  const canRejectReceipt = treasuryOperationAllowed(me.data, "vouchers.reject", legacyCanManage);
  // عرضٌ إرشادي فقط؛ approve على الخادم ملزم بإعادة قراءة isOwner النشط وفصل المنشئ عن المعتمد.
  const isOwner = me.data?.isOwner === true;
  // الفلاتر تعيش في querystring — تبقى مع فتح التفاصيل والرجوع، وتُشارَك رابطاً.
  const [f, setF, resetF] = useUrlFilters({
    type: "",
    party: "",
    method: "",
    approval: "",
    cat: "",
    branch: "",
    status: "",
    from: "",
    to: "",
    q: "",
  });
  const debouncedQ = useDebouncedValue(f.q, 250);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [batchPrintDetail, setBatchPrintDetail] = useState<"normal" | "detailed">("normal");
  const [batchPrinting, setBatchPrinting] = useState(false);
  const [drawerVoucherId, setDrawerVoucherId] = useState<number | null>(null);
  const limit = 100;

  /** أي تغيير فلتر يعيد الترقيم للصفحة الأولى. */
  function applyFilter(patch: Partial<typeof f>) {
    setF(patch);
    setPage(0);
  }

  const categories = trpc.voucherCategories.list.useQuery({
    includeInactive: true,
  });
  const branches = trpc.branches.list.useQuery();
  // فلتر الفرع فعّال للأدمن/مدير بلا فرع مُسنَد فقط — الخادم يفرض فرع البقية أياً كان المُرسَل.
  const canFilterBranch =
    me.data != null && (me.data.role === "admin" || me.data.branchId == null);
  // ٢٤/٨ (Codex P2 على PR #749): بوّابةٌ ضيّقة (`sales:READ`) لا `INVOICE_LIST_GATE` الواسعة.
  // مستخدمو `workorders:FULL` أو `pos:FULL` لهم نطاقُ فواتيرِ محطّتهم فقط عبر
  // `invoiceViewScopeForUser`. لقطةُ السند لا تحمل قناة الفاتورة (`sourceType`/`shiftType`)،
  // فلا نستطيع التمييزَ سطراً سطراً بين فاتورةٍ مسموحةٍ لهم وأخرى محجوبة. نُقصر الرابطَ على من
  // له sales:READ فيرى كلّ الفواتير — البقيّة يظلّ رقم الفاتورة نصاً (يجدها من محطّته).
  const canOpenInvoices = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "sales",
    "READ",
    ["admin", "manager", "accountant", "auditor"],
  );
  const canOpenStatement = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "reports",
    "READ",
    ["admin", "manager", "accountant", "auditor"],
  );
  const [, navigate] = useLocation();

  const filterInput = useMemo(
    () => ({
      voucherType: (f.type || undefined) as "RECEIPT" | "PAYMENT" | undefined,
      partyType: (f.party || undefined) as
        | "CUSTOMER"
        | "SUPPLIER"
        | "DELIVERY_PARTY"
        | "OTHER"
        | undefined,
      paymentMethod: (f.method || undefined) as
        | "CASH"
        | "CARD"
        | "CHECK"
        | "TRANSFER"
        | "WALLET"
        | "EXCHANGE"
        | undefined,
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

  const input = useMemo(() => ({ ...filterInput, limit, offset: page * limit }), [filterInput, page]);
  const list = trpc.vouchers.list.useQuery(input, { enabled: treasuryOperationAllowed(me.data, "vouchers.list", true) });
  const all = list.data ?? [];
  const agg = trpc.vouchers.aggregate.useQuery(filterInput, { enabled: treasuryOperationAllowed(me.data, "vouchers.aggregate", true) });

  const invalidateVoucherData = () => Promise.all([utils.vouchers.list.invalidate(), utils.vouchers.aggregate.invalidate()]);

  const cancelMut = trpc.vouchers.cancel.useMutation({
    onSuccess: async (res) => {
      await invalidateVoucherData();
      notify.ok(
        res.status === "PENDING_APPROVAL"
          ? `أرسل طلب إلغاء السند ${res.voucherNumber} — يبقى أثره نافذا حتى اعتماد مالك آخر.`
          : `ألغي الطلب غير المادي ${res.voucherNumber} بلا أثر مالي`,
      );
    },
    onError: (e) => notify.err(e),
  });

  const approveMut = trpc.vouchers.approve.useMutation({
    onSuccess: async (res, variables) => {
      const approvedDirection = all.find((row) => Number(row.id) === variables.receiptId)?.direction;
      await invalidateVoucherData();
      notify.ok(
        approvedDirection === "OUT"
          ? `اعتمد وصرف السند ${res.voucherNumber} — بصمة ${voucherShortHash(res.signatureHash)}`
          : `اعتمد السند ${res.voucherNumber} — بصمة ${voucherShortHash(res.signatureHash)}`,
      );
      setStampInfo({
        isOpen: true,
        voucherNumber: res.voucherNumber,
        title: approvedDirection === "OUT" ? "صرف واعتمد" : "معتمد رسميا",
        actorName: me.data?.name ?? undefined,
      });
    },
    onError: (e) => notify.err(e),
  });

  const [stampInfo, setStampInfo] = useState<{ isOpen: boolean; voucherNumber?: string; title?: string; actorName?: string }>({ isOpen: false });
  const [rejectTarget, setRejectTarget] = useState<VoucherRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [resubmitTarget, setResubmitTarget] = useState<VoucherRow | null>(null);
  const [reissueReason, setReissueReason] = useState("");
  const [resubmitNote, setResubmitNote] = useState("");
  const [resubmitAttachmentImages, setResubmitAttachmentImages] = useState<ImageItem[]>([]);

  const rejectMut = trpc.vouchers.reject.useMutation({
    onSuccess: async (res) => {
      setRejectTarget(null);
      await invalidateVoucherData();
      notify.ok(`رفض السند ${res.voucherNumber}`);
    },
    onError: (e) => notify.err(e),
  });

  const resubmitSystemPaymentMut = trpc.vouchers.resubmitExpensePayment.useMutation({
    onSuccess: async (res) => {
      setResubmitTarget(null); setReissueReason(""); setResubmitNote(""); setResubmitAttachmentImages([]);
      await invalidateVoucherData();
      notify.ok(
        res.replayed
          ? `استرجعت المحاولة A${res.attempt} بالسند ${res.voucherNumber} بلا إنشاء مكرر`
          : `أنشئت المحاولة A${res.attempt} بالسند ${res.voucherNumber} مرتبطة بالمحاولة #${res.priorReceiptId}`,
      );
    },
    onError: (e) => notify.err(e),
  });

  async function approveVoucher(r: VoucherRow) {
    if (!isOwner) { notify.err("اعتماد السندات متاح لحساب مالك نشط فقط."); return; }
    const partyLabel = r.counterpartyName?.trim() || voucherPartyKindText(r.partyType);
    const isPayment = r.direction === "OUT";
    const expectedSource = expectedVoucherSourceLabel(r);
    const isAccruedSystemPayment =
      r.referenceNumber?.startsWith("SHIP-") === true ||
      r.referenceNumber?.startsWith("ASSET-MAINT-") === true ||
      r.referenceNumber?.startsWith("ASSET-ACQ-") === true;
    const ok = await confirm({
      variant: "info",
      title: isPayment ? "اعتماد المالك وصرف السند" : "اعتماد المالك للسند",
      description: isPayment
        ? isAccruedSystemPayment
          ? `الأصل أو المصروف وقيد استحقاقه مثبتان مسبقا. سيعيد الخادم فحص المصدر والرصيد ثم يسوي الالتزام بالسند ${r.voucherNumber ?? ""} بمبلغ ${fmt(r.amount)} د.ع من ${expectedSource} مرة واحدة فقط.`
          : `سيتحقق الخادم من الرصيد ثم يعتمد ويصرف السند ${r.voucherNumber ?? ""} بمبلغ ${fmt(r.amount)} د.ع للطرف ${partyLabel} من ${expectedSource} ذريا. هل تتابع؟`
        : `سيصبح السند ${r.voucherNumber ?? ""} معتمدا ويسجل قيد الدفتر بمبلغ ${fmt(r.amount)} د.ع. هل تتابع؟`,
      confirmText: isPayment ? "اعتماد المالك وصرف" : "اعتماد المالك",
      cancelText: "تراجع",
    });
    if (ok) approveMut.mutate({ receiptId: Number(r.id) });
  }

  function openResubmitSystemPayment(r: VoucherRow) {
    setReissueReason(""); setResubmitNote(""); setResubmitAttachmentImages([]); setResubmitTarget(r);
  }

  function submitResubmitSystemPayment() {
    if (!resubmitTarget || resubmitSystemPaymentMut.isPending || !validAccrualReissueReason(reissueReason)) return;
    resubmitSystemPaymentMut.mutate(accrualPaymentResubmitPayload({
      receiptId: Number(resubmitTarget.id),
      reissueReason,
      attachmentUrl: resubmitAttachmentImages[0]?.dataUrl ?? null,
      note: resubmitNote,
    }));
  }

  function openReject(r: VoucherRow) {
    if (!isOwner) { notify.err("رفض طلبات السندات متاح لحساب مالك نشط فقط."); return; }
    setRejectReason(""); setRejectTarget(r);
  }

  function submitReject() {
    const reason = rejectReason.trim();
    if (reason && rejectTarget && !rejectMut.isPending) rejectMut.mutate({ receiptId: Number(rejectTarget.id), reason });
  }

  async function cancelVoucher(r: VoucherRow) {
    const partyLabel = voucherPartyKindText(r.partyType);
    const materialized = r.status === "COMPLETED" && r.approvalStatus === "APPROVED";
    const ok = await confirm({
      variant: "danger",
      title: materialized ? "طلب إلغاء السند" : "إلغاء الطلب غير المادي",
      description: materialized
        ? `سينشأ طلب إلغاء معلق للسند ${r.voucherNumber ?? ""} بمبلغ ${fmt(r.amount)} د.ع (الطرف: ${partyLabel}) حتى اعتماد مالك نشط آخر.`
        : `الطلب ${r.voucherNumber ?? ""} لم يعتمد ولم ينشئ أثرا ماليا؛ سيعلم ملغى.`,
      confirmText: materialized ? "إرسال طلب الإلغاء" : "إلغاء الطلب",
      cancelText: "تراجع",
    });
    if (ok) cancelMut.mutate({ receiptId: Number(r.id) });
  }

  const rows = all;
  const totalIn = agg.data?.totalIn ?? "0";
  const totalOut = agg.data?.totalOut ?? "0";
  const netTotal = useMemo(() => D(totalIn).minus(D(totalOut)), [totalIn, totalOut]);
  const totalCount = agg.data?.count;
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

  function fetchMatchingVouchers() {
    return fetchAllPaged<VoucherRow>(
      (offset, lim) => utils.vouchers.list.fetch({ ...filterInput, limit: lim, offset }).then((arr) => ({ rows: (arr ?? []) as VoucherRow[] })),
      { pageSize: 200 },
    );
  }

  async function exportAll() {
    if (exporting) return;
    setExporting(true);
    try {
      const fetched = await fetchMatchingVouchers();
      exportRows(fetched, { filename: "السندات", columns: getVoucherExportColumns({ branchMap, categoryMap }) });
    } catch (e) { notify.err(e); } finally { setExporting(false); }
  }

  async function batchPrintAll(mode: "merged" | "split") {
    if (batchPrinting) return;
    setBatchPrinting(true);
    try {
      const fetched = await fetchMatchingVouchers();
      const eligible = fetched.filter(canPrintOfficialVoucher);
      if (eligible.length === 0) {
        notify.err("لا تتاح الطباعة الرسمية قبل اعتماد السندات وتنفيذ أثرها المالي.");
        return;
      }
      const skipped = fetched.length - eligible.length;
      if (skipped > 0) {
        notify.info(`تم استبعاد ${skipped} سند غير معتمد أو غير مكتمل من الطباعة الرسمية.`);
      }

      const validDetails: NonNullable<Awaited<ReturnType<typeof utils.vouchers.get.fetch>>>[] = [];
      for (let i = 0; i < eligible.length; i += 8) {
        const chunk = await Promise.all(
          eligible.slice(i, i + 8).map((row) => utils.vouchers.get.fetch({ receiptId: Number(row.id) })),
        );
        for (const item of chunk) {
          if (item) validDetails.push(item);
        }
      }
      if (validDetails.length === 0) {
        notify.err("تعذر جلب تفاصيل السندات المعتمدة للطباعة.");
        return;
      }

      let opened = false;
      let batchExecuted = false;
      for (const item of validDetails) {
        await printAudit.run({
          documentType: "VOUCHER",
          documentId: Number(item.id),
          branchId: item.branchId == null ? null : Number(item.branchId),
          channel: "BROWSER",
          open: async (audit) => {
            if (!batchExecuted) {
              batchExecuted = true;
              const payloads = validDetails.map((v) => ({
                ...toVoucherPrintPayload(
                  v,
                  v.branchId != null ? (branchMap.get(Number(v.branchId)) ?? null) : null,
                ),
                printedByName: audit.actorName,
                printRequestedAt: String(audit.requestedAt),
              }));
              opened = await printVouchersBatch({
                vouchers: payloads,
                mode,
                detailLevel: batchPrintDetail,
                title: "سجل السندات",
                from: f.from || undefined,
                to: f.to || undefined,
              });
            }
            return opened;
          },
        });
      }
      if (!opened) notify.err("تعذر فتح نافذة الطباعة — تأكد من السماح بالنوافذ المنبثقة.");
    } catch (e) { notify.err(e); } finally { setBatchPrinting(false); }
  }

  async function printVoucher(r: VoucherRow, mode: "thermal" | "a4") {
    if (!canPrintOfficialVoucher(r)) {
      notify.err("لا تتاح الطباعة الرسمية قبل اعتماد السند وتنفيذ أثره المالي.");
      return;
    }
    await printVoucherWithAudit({
      receiptId: Number(r.id),
      mode,
      fetchVoucher: (id) => utils.vouchers.get.fetch({ receiptId: id }),
      branchMap,
      runPrintAudit: (inp) => printAudit.run(inp),
      onError: (e) => notify.err(e),
    });
  }

  const activeFilterCount = [f.type, f.party, f.method, f.approval, f.cat, f.branch, f.status, f.from, f.to].filter(Boolean).length;

  function resetFilters() { resetF(); setPage(0); }

  return (
    <div className="space-y-2.5">
      <PageHeader
        title="سندات القبض والصرف"
        description="سندات مستقلة بلا فاتورة — رواتب، إيجارات، إيرادات متفرقة، دفعات لعميل أو مورد."
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <AppSelect
              className="h-8 w-24 text-xs"
              value={batchPrintDetail}
              onValueChange={(v) => setBatchPrintDetail(v as "normal" | "detailed")}
              aria-label="مستوى تفاصيل الطباعة الجماعية"
            >
              <option value="normal">ملخص</option>
              <option value="detailed">مفصل</option>
            </AppSelect>
            <Button variant="outline" size="sm" disabled={rows.length === 0 || batchPrinting} onClick={() => void batchPrintAll("merged")}>
              <Printer aria-hidden className="size-3.5 ms-1" />{batchPrinting ? "جار التحضير…" : "طباعة مجمعة"}
            </Button>
            <Button variant="outline" size="sm" disabled={rows.length === 0 || batchPrinting} onClick={() => void batchPrintAll("split")}>
              طباعة مجزأة
            </Button>
            <Button variant="outline" size="sm" disabled={rows.length === 0 || exporting} onClick={() => void exportAll()}>
              {exporting ? "جار التحضير…" : "تصدير Excel"}
            </Button>
            <Link href="/voucher-categories"><Button variant="outline" size="sm">إدارة الفئات</Button></Link>
            <Link href="/vouchers/receipt/new">
              <Button size="sm" variant="success" disabled={!treasuryOperationAllowed(me.data, "vouchers.create", true)}>+ سند قبض</Button>
            </Link>
            <Link href="/vouchers/payment/new">
              <Button size="sm" variant="destructive" disabled={!treasuryOperationAllowed(me.data, "vouchers.create", true)}>+ طلب صرف</Button>
            </Link>
          </div>
        }
      />

      {/* البطاقات من aggregate الخادمي — كامل النطاق المفلتر لا صفوف الصفحة الحالية. */}
      <VoucherSummaryCards
        totalIn={totalIn}
        totalOut={totalOut}
        netTotal={netTotal}
        filterType={f.type}
        reversedCount={agg.data?.reversedCount ?? 0}
        pendingTotal={agg.data?.pendingTotal ?? "0"}
        pendingCount={agg.data?.pendingCount ?? 0}
      />

      <Card className="p-2.5 space-y-2">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 items-end">
          <FilterField label="بحث (رقم/وصف/اسم مُستفيد)" className="col-span-2 md:col-span-2 lg:col-span-2">
            <UnifiedSearchInput
              value={f.q}
              onChange={(val) => applyFilter({ q: val })}
              placeholder="رقم السند، الطرف، البيان، المبلغ، المرجع… (F2)"
              debounceMs={250}
              barcode={true}
              size="default"
              autoFocus
            />
          </FilterField>
          <FilterField label="النوع">
            <AppSelect className="h-8 text-xs" value={f.type} onValueChange={(value) => applyFilter({ type: value })}>
              <option value="">الكل</option>
              <option value="RECEIPT">قبض</option>
              <option value="PAYMENT">صرف</option>
            </AppSelect>
          </FilterField>
          <FilterField label="الطرف">
            <AppSelect className="h-8 text-xs" value={f.party} onValueChange={(value) => applyFilter({ party: value })}>
              <option value="">الكل</option>
              <option value="CUSTOMER">عميل</option>
              <option value="SUPPLIER">مورد</option>
              <option value="DELIVERY_PARTY">جهة توصيل</option>
              <option value="OTHER">أخرى</option>
            </AppSelect>
          </FilterField>
          <FilterField label="طريقة الدفع">
            <AppSelect className="h-8 text-xs" value={f.method} onValueChange={(value) => applyFilter({ method: value })}>
              <option value="">الكل</option>
              {[...INBOUND_ENABLED_PAYMENT_METHODS, "EXCHANGE" as const].map((m) => (
                <option key={m} value={m}>{paymentMethodLabel(m)}</option>
              ))}
            </AppSelect>
          </FilterField>
          <FilterField label="الاعتماد">
            <AppSelect className="h-8 text-xs" value={f.approval} onValueChange={(value) => applyFilter({ approval: value })}>
              <option value="">الكل</option>
              <option value="APPROVED">{f.type === "PAYMENT" ? "معتمد ومصروف" : f.type === "RECEIPT" ? "معتمد" : "معتمد / مصروف"}</option>
              <option value="PENDING_APPROVAL">{f.type === "PAYMENT" ? "بانتظار الاعتماد والصرف" : f.type === "RECEIPT" ? "بانتظار الاعتماد" : "بانتظار الاعتماد / الصرف"}</option>
              <option value="REJECTED">مرفوض</option>
            </AppSelect>
          </FilterField>
          <FilterField label="حالة السند">
            <AppSelect className="h-8 text-xs" value={f.status || "all"} onValueChange={(v) => applyFilter({ status: v === "all" ? "" : v })} aria-label="فلتر حالة السند">
              <option value="all">الكل</option>
              <option value="COMPLETED">مكتمل</option>
              <option value="REVERSED">ملغى</option>
            </AppSelect>
          </FilterField>
          {canFilterBranch && (
            <FilterField label="الفرع">
              <AppSelect className="h-8 text-xs" value={f.branch || "all"} onValueChange={(v) => applyFilter({ branch: v === "all" ? "" : v })} aria-label="فلتر الفرع">
                <option value="all">الكل</option>
                {(branches.data ?? []).map((b) => <option key={Number(b.id)} value={String(b.id)}>{b.name}</option>)}
              </AppSelect>
            </FilterField>
          )}
          <FilterField label="الفئة">
            <AppSelect className="h-8 text-xs" value={f.cat} onValueChange={(value) => applyFilter({ cat: value })}>
              <option value="">الكل</option>
              {(categories.data ?? []).map((c) => <option key={Number(c.id)} value={String(c.id)}>{c.name}</option>)}
            </AppSelect>
          </FilterField>
          <FilterField label="من تاريخ">
            <Input type="date" dir="ltr" className="h-8 text-xs" value={f.from} onChange={(e) => applyFilter({ from: e.target.value })} />
          </FilterField>
          <FilterField label="إلى تاريخ">
            <Input type="date" dir="ltr" className="h-8 text-xs" value={f.to} onChange={(e) => applyFilter({ to: e.target.value })} />
          </FilterField>
          <div className="flex items-center justify-end gap-2">
            <span className="text-xs text-muted-foreground">
              {list.isLoading ? "" : totalCount != null ? `${totalCount.toLocaleString("ar-IQ-u-nu-latn")} سند` : `${rows.length.toLocaleString("ar-IQ-u-nu-latn")} سند`}
            </span>
            {(activeFilterCount > 0 || f.q !== "") && (
              <Button variant="ghost" size="sm" onClick={resetFilters} className="h-8 px-2 text-xs text-muted-foreground">
                <X aria-hidden className="size-3.5" />{FILTER_LABELS.reset}
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 border-t pt-2">
          <span className="text-xs text-muted-foreground me-1">فترة سريعة:</span>
          {(
            [
              ["today", "اليوم"],
              ["last7", "آخر 7 أيام"],
              ["thisMonth", "هذا الشهر"],
              ["lastMonth", "الشهر الماضي"],
              ["all", "الكل"],
            ] as const satisfies readonly (readonly [VoucherPeriodPreset, string])[]
          ).map(([preset, label]) => {
            const range = computeVoucherPeriodRange(preset);
            const active = f.from === range.from && f.to === range.to;
            return (
              <Button
                key={preset}
                type="button"
                size="sm"
                variant={active ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                onClick={() => applyFilter(range)}
              >
                {label}
              </Button>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardContent className="p-0">
          <DataTable<VoucherRow>
            data={rows}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            searchable={false}
            externalFiltersActive={activeFilterCount > 0 || f.q !== ""}
            onRowClick={(r) => setDrawerVoucherId(Number(r.id))}
            serverPagination={{ page, onPageChange: setPage, pageSize: limit, total: totalCount, hasMore: hasNext, isFetching: list.isFetching }}
            getRowClassName={(r) =>
              [
                r.status === "REVERSED" ? "opacity-60" : "",
                r.approvalStatus === "PENDING_APPROVAL" ? "[&>td]:bg-[var(--sem-warn-bg)]" : "",
                r.approvalStatus === "REJECTED" ? "[&>td]:bg-[var(--sem-neg-bg)]" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            emptyText="لا سندات مطابقة. أضف سند قبض أو صرف جديدا."
            columns={[
              {
                id: "voucherNumber",
                header: "رقم السند / المرجع",
                accessorFn: (r) =>
                  [r.voucherNumber ? String(r.voucherNumber) : null, r.referenceNumber, r.signatureHash ? `#${shortHash(r.signatureHash)}` : null]
                    .filter(Boolean)
                    .join(" · "),
                meta: { width: "stacked" },
                sortDescFirst: true,
                sortingFn: (a, b) => String(a.original.voucherNumber ?? "").localeCompare(String(b.original.voucherNumber ?? ""), "en", { numeric: true }),
                cell: ({ row }) => {
                  const r = row.original;
                  const vNum = String(r.voucherNumber ?? "—");
                  const refOrHash = r.referenceNumber || (r.signatureHash ? `#${shortHash(r.signatureHash)}` : undefined);
                  const attemptLabel = accrualPaymentAttemptLabel({
                    attempt: r.resubmitAttempt,
                    rootReceiptId: r.resubmitRootReceiptId,
                    priorReceiptId: r.resubmitPriorReceiptId,
                  });
                  return (
                    <div className="flex flex-col gap-0.5">
                      <StackedEntityCell
                        primary={vNum}
                        primaryTitle={vNum}
                        secondary={refOrHash}
                        secondaryTitle={r.signatureHash ? `بصمة كاملة: ${r.signatureHash}` : r.referenceNumber ? `مرجع: ${r.referenceNumber}` : undefined}
                        copyValue={r.voucherNumber ? String(r.voucherNumber) : null}
                        copyTitle="نسخ رقم السند"
                      />
                      {attemptLabel && <div className="text-[10px] text-muted-foreground font-sans" dir="rtl">{attemptLabel}</div>}
                      {r.resubmitReason && <div className="max-w-52 truncate text-[10px] text-muted-foreground font-sans" title={r.resubmitReason} dir="rtl">سبب إعادة الإصدار: {r.resubmitReason}</div>}
                      {r.resubmitLineageStatus === "BROKEN" && <div className="text-[10px] text-[var(--sem-neg)] font-sans" dir="rtl">سلسلة إعادة الإصدار غير مكتملة — يلزم تدقيق</div>}
                    </div>
                  );
                },
              },
              {
                id: "voucherDate",
                header: "التاريخ",
                accessorFn: (r) => fmtDate(r.voucherDate),
                /* بلا kind: "date" — الخلية تحمل سطرا عربيا وأمر Dir يقلبه */
                meta: { width: "date" },
                sortDescFirst: true,
                sortingFn: (a, b) => new Date(a.original.voucherDate ?? 0).getTime() - new Date(b.original.voucherDate ?? 0).getTime(),
                cell: ({ row }) => (
                  <span className="text-xs">
                    {fmtDate(row.original.voucherDate)}
                    {row.original.voucherDate && row.original.createdAt && (
                      <div className="text-[10px] text-muted-foreground">أدخل: {fmtDate(row.original.createdAt)}</div>
                    )}
                  </span>
                ),
              },
              ...(canFilterBranch
                ? ([
                    {
                      id: "branch",
                      header: "الفرع",
                      accessorFn: (r) => (r.branchId != null ? (branchMap.get(Number(r.branchId)) ?? `فرع ${r.branchId}`) : "—"),
                      cell: ({ row }) => (
                        <span className="text-xs">
                          {row.original.branchId != null ? (branchMap.get(Number(row.original.branchId)) ?? `فرع ${row.original.branchId}`) : "—"}
                        </span>
                      ),
                    },
                  ] as ColumnDef<VoucherRow, unknown>[])
                : []),
              {
                id: "direction",
                header: "النوع والاعتماد",
                accessorFn: (r) => `${voucherDirectionText(r.direction)} - ${voucherApprovalLabel(r)}`,
                meta: { kind: "status" },
                cell: ({ row }) => {
                  const r = row.original;
                  const variant =
                    r.approvalStatus === "PENDING_APPROVAL" ? "warning" : r.approvalStatus === "REJECTED" ? "destructive" : "success";
                  return (
                    <div className="flex flex-col items-center gap-1">
                      <MovementTypeBadge kind={r.direction === "IN" ? "RECEIPT" : "PAYMENT"} />
                      <Badge variant={variant} className="text-[10px]">{voucherApprovalLabel(r)}</Badge>
                    </div>
                  );
                },
              },
              {
                id: "party",
                header: "الطرف / الفاتورة",
                accessorFn: (r) =>
                  [r.partyName?.trim() || r.counterpartyName?.trim() || voucherPartyKindText(r.partyType), r.invoiceNumber ? `فاتورة #${r.invoiceNumber}` : null]
                    .filter(Boolean)
                    .join(" · "),
                meta: { width: "stacked" },
                cell: ({ row }) => {
                  const r = row.original;
                  const partyDisplay = r.partyName?.trim() || r.counterpartyName?.trim() || voucherPartyKindText(r.partyType);
                  const invoiceText = r.invoiceNumber ? `فاتورة #${r.invoiceNumber}` : undefined;
                  const statementHref = (item: VoucherRow) => voucherPartyStatementHref(item.partyType, item.partyId);
                  const href = canOpenStatement ? statementHref(r) : null;
                  return (
                    <StackedEntityCell
                      primary={
                        <div className="flex flex-col">
                          {href ? (
                            <Link href={href} className="text-primary hover:underline" title="فتح كشف الحساب" onClick={(e) => e.stopPropagation()}>
                              {partyDisplay}
                            </Link>
                          ) : (
                            <span>{partyDisplay}</span>
                          )}
                          {r.partyType !== "OTHER" && r.counterpartyName && r.counterpartyName !== partyDisplay && (
                            <span className="text-[10px] text-muted-foreground">{r.counterpartyName}</span>
                          )}
                        </div>
                      }
                      primaryTitle={partyDisplay}
                      secondary={invoiceText}
                      secondaryTitle={invoiceText ? "فتح تفاصيل الفاتورة المرتبطة" : undefined}
                      secondaryIsCode={false}
                      secondaryDir="auto"
                      onSecondaryClick={canOpenInvoices && r.invoiceId != null ? () => navigate(`/invoices/${r.invoiceId}`) : undefined}
                      copyValue={r.invoiceNumber ?? undefined}
                      copyTitle="نسخ رقم الفاتورة"
                    />
                  );
                },
              },
              {
                id: "performedBy",
                header: ATTRIBUTION_LABELS.performedBy,
                accessorFn: (r) => r.createdByName ?? "",
                meta: { kind: "actor" },
                cell: ({ row }) => <ActorCell actor={{ name: row.original.createdByName, userId: row.original.createdBy }} />,
              },
              {
                id: "approvedBy",
                header: ATTRIBUTION_LABELS.approvedBy,
                accessorFn: (r) => (r as VoucherRow & { approvedByName?: string | null }).approvedByName ?? "",
                meta: { kind: "actor" },
                cell: ({ row }) => {
                  const r = row.original as VoucherRow & { approvedByName?: string | null };
                  return r.approvedBy != null ? (
                    <ActorCell actor={{ name: r.approvedByName, userId: r.approvedBy }} />
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  );
                },
              },
              {
                id: "category",
                header: "الفئة",
                accessorFn: (r) => (r.voucherCategoryId ? (categoryMap.get(Number(r.voucherCategoryId)) ?? "—") : "—"),
                cell: ({ row }) => (
                  <span className="text-xs">
                    {row.original.voucherCategoryId ? (categoryMap.get(Number(row.original.voucherCategoryId)) ?? "—") : "—"}
                  </span>
                ),
              },
              {
                id: "description",
                header: "الوصف",
                accessorFn: (r) => r.description ?? "—",
                meta: { width: "wide", wrap: true },
                cell: ({ row }) => row.original.description ?? "—",
              },
              {
                id: "amount",
                header: "المبلغ",
                accessorFn: (r) => fmt(r.amount),
                meta: { kind: "money" },
                cell: ({ row }) => <bdi dir="ltr" className="tabular-nums font-medium">{fmt(row.original.amount)}</bdi>,
                footer: ({ table }) => {
                  const sum = table.getRowModel().rows.reduce((acc, row) => acc.plus(D(row.original.amount ?? 0)), D(0));
                  return <bdi dir="ltr" className="tabular-nums font-bold">{fmt(sum.toFixed(2))} د.ع</bdi>;
                },
              },
              {
                id: "paymentMethod",
                header: "الدفع",
                accessorFn: (r) => paymentMethodLabel(r.paymentMethod),
                meta: { align: "center" },
                cell: ({ row }) => (
                  <PaymentMethodChip method={row.original.paymentMethod} cashBucket={row.original.cashBucket} cardLastFour={row.original.cardLastFour} />
                ),
              },
              {
                id: "attachment",
                header: "المرفق",
                accessorFn: (r) => (r.attachmentUrl ? "مرفق" : "—"),
                enableSorting: false,
                meta: { align: "center" },
                cell: ({ row }) => {
                  const safeHref = sanitizeAttachmentHref(row.original.attachmentUrl);
                  return safeHref ? (
                    <a href={safeHref} target="_blank" rel="noopener noreferrer" title="فتح المرفق" onClick={(e) => e.stopPropagation()}>
                      <Paperclip aria-hidden className="size-4 text-[var(--sem-pos)] inline" />
                    </a>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  );
                },
              },
              {
                id: "actions",
                header: "إجراء",
                enableSorting: false,
                meta: { kind: "actions" },
                cell: ({ row }) => {
                  const r = row.original;
                  return (
                    <RowActions
                      mode="auto"
                      actions={[
                        {
                          key: "print-thermal",
                          kind: "print",
                          label: "طباعة حرارية",
                          hidden: !canPrintOfficialVoucher(r),
                          onSelect: () => void printVoucher(r, "thermal"),
                          gate: {
                            operations: ["vouchers.get"],
                            roles: ["manager", "accountant"],
                            module: "treasury",
                            level: "READ",
                          },
                        },
                        {
                          key: "print-a4",
                          kind: "print",
                          label: "طباعة A4 (PDF)",
                          hidden: !canPrintOfficialVoucher(r),
                          onSelect: () => void printVoucher(r, "a4"),
                          gate: {
                            operations: ["vouchers.get"],
                            roles: ["manager", "accountant"],
                            module: "treasury",
                            level: "READ",
                          },
                        },
                        {
                          key: "approve",
                          kind: "approve",
                          label: r.direction === "OUT" ? "اعتماد المالك وصرف" : "اعتماد المالك",
                          hidden: !canShowVoucherApprovalAction({
                            direction: r.direction,
                            approvalStatus: r.approvalStatus,
                            isOwner,
                            canManageLegacyReceipt: canApproveReceipt,
                          }),
                          disabled: approveMut.isPending,
                          disabledReason: "توجد عملية اعتماد وصرف قيد التنفيذ",
                          onSelect: () => void approveVoucher(r),
                          gate: { operations: ["vouchers.approve"], module: "treasury", level: "FULL" },
                        },
                        {
                          key: "reject",
                          kind: "reverse",
                          label: r.direction === "OUT" ? "رفض المالك لطلب الصرف" : "رفض المالك للسند",
                          variant: "destructive",
                          hidden: !canShowVoucherRejectAction({
                            direction: r.direction,
                            approvalStatus: r.approvalStatus,
                            isOwner,
                            canManageLegacyReceipt: canRejectReceipt,
                          }),
                          disabled: rejectMut.isPending,
                          disabledReason: "توجد عملية رفض قيد التنفيذ",
                          onSelect: () => openReject(r),
                          gate: { operations: ["vouchers.reject"], module: "treasury", level: "FULL" },
                        },
                        {
                          key: "resubmit-system-payment",
                          kind: "create",
                          label: r.referenceNumber?.startsWith("TERM-SETTLEMENT-")
                            ? "إعادة تقديم تسوية نهاية الخدمة"
                            : isPurchaseSupplierVoucherRef(r.referenceNumber)
                              ? r.referenceNumber?.startsWith("PO-USD-PAY-")
                                ? "إعادة تقديم تسديد USD"
                                : "إعادة تقديم دفعة المورد"
                              : r.referenceNumber?.startsWith("ASSET-ACQ-")
                                ? "إعادة تقديم تسوية اقتناء الأصل"
                                : "إعادة تقديم دفع المصروف",
                          hidden:
                            !canShowAccrualPaymentResubmit({
                              referenceNumber: r.referenceNumber,
                              approvalStatus: r.approvalStatus,
                              resubmitLineageStatus: r.resubmitLineageStatus,
                              canManage: canResubmit,
                            }) &&
                            !(
                              canResubmit &&
                              r.approvalStatus === "REJECTED" &&
                              r.resubmitLineageStatus !== "BROKEN" &&
                              isPurchaseSupplierVoucherRef(r.referenceNumber)
                            ),
                          disabled: resubmitSystemPaymentMut.isPending,
                          disabledReason: "توجد إعادة تقديم قيد التنفيذ",
                          onSelect: () => openResubmitSystemPayment(r),
                          gate: { operations: ["vouchers.resubmitExpensePayment"], roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                        },
                        {
                          key: "stmt",
                          kind: "view",
                          label: "كشف حساب الطرف",
                          href: voucherPartyStatementHref(r.partyType, r.partyId) ?? undefined,
                          hidden: voucherPartyStatementHref(r.partyType, r.partyId) == null,
                          gate: { roles: ["manager", "accountant"], module: "treasury", level: "READ" },
                        },
                        {
                          key: "cancel",
                          kind: "reverse",
                          label: r.status === "COMPLETED" && r.approvalStatus === "APPROVED" ? "طلب إلغاء السند" : "إلغاء الطلب",
                          variant: "destructive",
                          hidden:
                            !canCancel ||
                            r.status === "REVERSED" ||
                            r.paymentMethod === "EXCHANGE" ||
                            r.referenceNumber?.startsWith("ACCRUAL-REFUND-") ||
                            isNonPoVoucherSystemRef(r.referenceNumber),
                          disabled: cancelMut.isPending,
                          disabledReason: "توجد عملية إلغاء قيد التنفيذ",
                          onSelect: () => void cancelVoucher(r),
                          gate: { operations: ["vouchers.cancel"], roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                        },
                      ]}
                    />
                  );
                },
              },
            ]}
          />
        </CardContent>
      </Card>

      <VoucherDetailDrawer
        voucherId={drawerVoucherId}
        open={drawerVoucherId != null}
        onOpenChange={(o) => { if (!o) setDrawerVoucherId(null); }}
        onActionSuccess={() => { void invalidateVoucherData(); }}
      />
      <VoucherDeepLinkDialog />
      {/* حوار سبب الرفض — بديل window.prompt: السبب سجلّ تدقيقي إلزامي. */}
      <VoucherRejectDialog
        rejectTarget={rejectTarget}
        rejectReason={rejectReason}
        setRejectReason={setRejectReason}
        isPending={rejectMut.isPending}
        onClose={() => setRejectTarget(null)}
        onSubmit={submitReject}
      />

      <ResubmitVoucherDialog
        resubmitTarget={resubmitTarget}
        onClose={() => {
          setResubmitTarget(null);
          setReissueReason("");
          setResubmitNote("");
          setResubmitAttachmentImages([]);
        }}
        onSubmit={submitResubmitSystemPayment}
        reissueReason={reissueReason}
        setReissueReason={setReissueReason}
        resubmitNote={resubmitNote}
        setResubmitNote={setResubmitNote}
        resubmitAttachmentImages={resubmitAttachmentImages}
        setResubmitAttachmentImages={setResubmitAttachmentImages}
        isPending={resubmitSystemPaymentMut.isPending}
      />

      <DigitalStampOverlay
        isOpen={stampInfo.isOpen}
        onClose={() => setStampInfo({ isOpen: false })}
        title={stampInfo.title}
        referenceNumber={stampInfo.voucherNumber}
        actorName={stampInfo.actorName}
      />
    </div>
  );
}
