import { Button } from "@/components/ui/button";
import { ActorCell } from "@/components/data-table/ActorCell";
import { ATTRIBUTION_LABELS } from "@shared/uiContracts";
import { FILTER_LABELS } from "@shared/uiContracts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
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
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { FilterField, RowActions } from "@/components/list";
import { confirm } from "@/lib/confirm";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmtDate } from "@/lib/date";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import {
  printVoucherReceipt,
  printVoucherA4,
  type VoucherPrintData,
} from "@/lib/printing/voucherPrint";
import {
  releaseReservedPrintWindow,
  reservePrintWindow,
} from "@/lib/printing/brand";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { usePrintAudit } from "@/hooks/usePrintAudit";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import type { PrintOpenResult } from "@shared/printAudit";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  CheckCircle2,
  XCircle,
  Paperclip,
  ShieldQuestion,
  Link2,
  X,
} from "lucide-react";
import {
  accrualPaymentAttemptLabel,
  accrualPaymentResubmitPayload,
  canShowAccrualPaymentResubmit,
  canPrintOfficialVoucher,
  canShowVoucherApprovalAction,
  canShowVoucherRejectAction,
  expectedVoucherSourceLabel,
  validAccrualReissueReason,
  voucherApprovalLabel,
} from "@/components/vouchers/voucherUiPolicy";
import { DigitalStampOverlay } from "@/components/vouchers/DigitalStampOverlay";
import { ResubmitVoucherDialog } from "@/components/vouchers/ResubmitVoucherDialog";
import { selectClsFull } from "@/lib/ui/formStyles";
import { ACTION_LABELS } from "@shared/actionLabels";

type VoucherRow = RouterOutputs["vouchers"]["list"][number];

/** سجلّ السندات المستقلّة (قبض + صرف) — vouchers-pro: تَصنيف + اعتماد + بَصمة + مُرفق. */

const TYPE_LABEL: Record<string, string> = { IN: "قبض", OUT: "صرف" };
const PARTY_LABEL: Record<string, string> = {
  CUSTOMER: "عميل",
  SUPPLIER: "مورّد",
  DELIVERY_PARTY: "جهة توصيل",
  OTHER: "أخرى",
};
// التسمية من `@/lib/paymentMethod` (مصدر واحد مع POS والفواتير وحوار الوردية) — كانت نسخةً
// محلّية سابقة للمركزيّ بـ«صيرفة»، فبقيت EXCHANGE ناقصةً هناك وظهرت خاماً في شاشة الخزينة.
function shortHash(h?: string | null): string {
  return h ? String(h).slice(0, 8).toUpperCase() : "—";
}

const SYSTEM_PAYMENT_PREFIXES = [
  "ASSET-ACQ-",
  "ASSET-REACQ-",
  "ASSET-MAINT-",
  "ASSET-SUP-SETTLE-",
  "PO-PAY-",
  "PO-USD-PAY-",
  "SHIP-",
  "EXCHANGE-IQD-DEP-",
  "DIGITAL-WALLET-DEP-",
  "CANCEL-VCH-",
  "TERM-SETTLEMENT-",
  "ACCRUAL-REFUND-",
] as const;

function isSystemPaymentReference(reference?: string | null): boolean {
  return (
    !!reference &&
    SYSTEM_PAYMENT_PREFIXES.some((prefix) => reference.startsWith(prefix))
  );
}

function isPurchaseSupplierPaymentReference(
  reference?: string | null,
): boolean {
  return (
    !!reference &&
    (reference.startsWith("PO-PAY-") || reference.startsWith("PO-USD-PAY-"))
  );
}

export default function Vouchers() {
  const utils = trpc.useUtils();
  const printAudit = usePrintAudit();
  const me = trpc.auth.me.useQuery();
  const canManage =
    !!me.data &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "treasury",
      "FULL",
      ["manager", "accountant"],
    );
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
  const debouncedQ = useDebouncedValue(f.q.trim(), 250);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
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

  const filterInput = useMemo(
    () => ({
      voucherType: (f.type || undefined) as "RECEIPT" | "PAYMENT" | undefined,
      partyType: (f.party || undefined) as
        | "CUSTOMER"
        | "SUPPLIER"
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
      approvalStatus: (f.approval || undefined) as
        | "APPROVED"
        | "PENDING_APPROVAL"
        | "REJECTED"
        | undefined,
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
      await Promise.all([
        utils.vouchers.list.invalidate(),
        utils.vouchers.aggregate.invalidate(),
      ]);
      notify.ok(
        res.status === "PENDING_APPROVAL"
          ? `أُرسل طلب إلغاء السند ${res.voucherNumber} — يبقى أثره نافذاً حتى اعتماد مالك نشط آخر.`
          : `أُلغي الطلب غير المادي ${res.voucherNumber} بلا أثر مالي`,
      );
    },
    onError: (e) => notify.err(e),
  });

  const approveMut = trpc.vouchers.approve.useMutation({
    onSuccess: async (res, variables) => {
      const approvedDirection = all.find(
        (row) => Number(row.id) === variables.receiptId,
      )?.direction;
      await Promise.all([
        utils.vouchers.list.invalidate(),
        utils.vouchers.aggregate.invalidate(),
      ]);
      notify.ok(
        approvedDirection === "OUT"
          ? `اعتُمد وصُرف السند ${res.voucherNumber} — بَصمة ${shortHash(res.signatureHash)}`
          : `اعتُمد السند ${res.voucherNumber} — بَصمة ${shortHash(res.signatureHash)}`,
      );
      setStampInfo({
        isOpen: true,
        voucherNumber: res.voucherNumber,
        title: approvedDirection === "OUT" ? "صُرف واعتُمد" : "مُعتمَد رسمياً",
        actorName: me.data?.name ?? undefined,
      });
    },
    onError: (e) => notify.err(e),
  });

  const [stampInfo, setStampInfo] = useState<{
    isOpen: boolean;
    voucherNumber?: string;
    title?: string;
    actorName?: string;
  }>({ isOpen: false });

  // حوار سبب الرفض (بديل window.prompt — نمط حوارات النظام).
  const [rejectTarget, setRejectTarget] = useState<VoucherRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [resubmitTarget, setResubmitTarget] = useState<VoucherRow | null>(null);
  const [reissueReason, setReissueReason] = useState("");
  const [resubmitNote, setResubmitNote] = useState("");
  const [resubmitAttachmentImages, setResubmitAttachmentImages] = useState<
    ImageItem[]
  >([]);

  const rejectMut = trpc.vouchers.reject.useMutation({
    onSuccess: async (res) => {
      setRejectTarget(null);
      await Promise.all([
        utils.vouchers.list.invalidate(),
        utils.vouchers.aggregate.invalidate(),
      ]);
      notify.ok(`رُفض السند ${res.voucherNumber}`);
    },
    onError: (e) => notify.err(e),
  });

  const resubmitSystemPaymentMut =
    trpc.vouchers.resubmitExpensePayment.useMutation({
      onSuccess: async (res) => {
        setResubmitTarget(null);
        setReissueReason("");
        setResubmitNote("");
        setResubmitAttachmentImages([]);
        await Promise.all([
          utils.vouchers.list.invalidate(),
          utils.vouchers.aggregate.invalidate(),
        ]);
        notify.ok(
          res.replayed
            ? `استُرجعت المحاولة A${res.attempt} بالسند ${res.voucherNumber} بلا إنشاء أو أثرٍ مكرر`
            : `أُنشئت المحاولة A${res.attempt} بالسند ${res.voucherNumber} مرتبطة بالمحاولة #${res.priorReceiptId} بلا تكرارٍ للمصدر أو أثرٍ مالي`,
        );
      },
      onError: (e) => notify.err(e),
    });

  async function approveVoucher(r: VoucherRow) {
    // لا يُعد هذا حارس صلاحية؛ هو منع UX فقط، والإنفاذ الحاسم في الإجراء الخادمي.
    if (!isOwner) {
      notify.err("اعتماد السندات متاح لحساب مالك نشط فقط.");
      return;
    }
    const partyLabel =
      r.counterpartyName?.trim() || PARTY_LABEL[r.partyType ?? "OTHER"] || "—";
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
          ? `الأصل أو المصروف وقيد استحقاقه مُثبتان مسبقاً. سيُعيد الخادم فحص المصدر والرصيد ثم يسوّي الالتزام بالسند ${r.voucherNumber ?? ""} بمبلغ ${fmt(r.amount)} د.ع من ${expectedSource} مرةً واحدة فقط، بلا اعتراف أو استحقاق ثانٍ. عند أي فشل يبقى الطلب بلا أثر نقدي. هل تتابع؟`
          : `سيُتحقق الخادم من الرصيد ثم يعتمد ويصرف السند ${r.voucherNumber ?? ""} في عملية واحدة بلا مرحلة وسيطة. المبلغ: ${fmt(r.amount)} د.ع · الطرف: ${partyLabel} · المصدر المتوقع لحظة التأكيد: ${expectedSource}. يُعاد فحص المصدر والرصيد داخل المعاملة؛ عند أي فشل لن يُسجَّل إيصال أو قيد أو تغيير ذمة. هل تتابع؟`
        : `سَيُصبح السند ${r.voucherNumber ?? ""} مُعتمَداً ويُسجَّل قيد الدفتر ويُؤثّر على ${
            r.partyType === "CUSTOMER"
              ? "ذمة العميل"
              : r.partyType === "SUPPLIER"
                ? "ذمة المورّد"
                : "الصندوق"
          } بمبلغ ${fmt(r.amount)} د.ع. هل تتابع؟`,
      confirmText: isPayment ? "اعتماد المالك وصرف" : "اعتماد المالك",
      cancelText: "تراجع",
    });
    if (!ok) return;
    approveMut.mutate({ receiptId: Number(r.id) });
  }

  function openResubmitSystemPayment(r: VoucherRow) {
    setReissueReason("");
    setResubmitNote("");
    setResubmitAttachmentImages([]);
    setResubmitTarget(r);
  }

  function submitResubmitSystemPayment() {
    if (!resubmitTarget || resubmitSystemPaymentMut.isPending) return;
    if (!validAccrualReissueReason(reissueReason)) return;
    resubmitSystemPaymentMut.mutate(
      accrualPaymentResubmitPayload({
        receiptId: Number(resubmitTarget.id),
        reissueReason,
        attachmentUrl: resubmitAttachmentImages[0]?.dataUrl ?? null,
        note: resubmitNote,
      }),
    );
  }

  function openReject(r: VoucherRow) {
    // إخفاء/منع UX فقط؛ الخادم القادم يفرض isOwner النشط وفصل الواجبات.
    if (!isOwner) {
      notify.err("رفض طلبات السندات متاح لحساب مالك نشط فقط.");
      return;
    }
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
    const materialized =
      r.status === "COMPLETED" && r.approvalStatus === "APPROVED";
    const ok = await confirm({
      variant: "danger",
      title: materialized ? "طلب إلغاء السند" : "إلغاء الطلب غير المادي",
      description: materialized
        ? `سيُنشأ طلب إلغاء معلّق للسند ${r.voucherNumber ?? ""} بمبلغ ${fmt(r.amount)} د.ع (الطرف: ${partyLabel}). يبقى السند وأثره المالي نافذين بلا تغيير حتى يعتمد مالك نشط آخر مختلف عن طالب الإلغاء ومنشئ الأصل؛ عند الاعتماد فقط يُعكس الصندوق والدفتر والذمة ذرياً. هل تتابع؟`
        : `الطلب ${r.voucherNumber ?? ""} لم يُعتمد ولم يُنشئ أثراً مالياً؛ سيُعلّم ملغى بلا قيد أو حركة نقد. هل تتابع؟`,
      confirmText: materialized ? "إرسال طلب الإلغاء" : "إلغاء الطلب",
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
  const netTotal = useMemo(
    () => D(totalIn).minus(D(totalOut)),
    [totalIn, totalOut],
  );
  const totalCount = agg.data?.count;
  // «التالي» بcount الخادمي؛ وقبل وصول aggregate نتحفّظ بقاعدة «صفحة ممتلئة = قد يوجد تالٍ».
  const hasNext =
    totalCount != null ? (page + 1) * limit < totalCount : all.length >= limit;

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
          {
            key: "voucherDate",
            header: "تاريخ السند",
            map: (r) => fmtDate(r.voucherDate),
          },
          {
            key: "createdAt",
            header: "تاريخ الإدخال",
            map: (r) => fmtDate(r.createdAt),
          },
          {
            key: "branchId",
            header: "الفرع",
            map: (r) =>
              r.branchId != null
                ? (branchMap.get(Number(r.branchId)) ?? String(r.branchId))
                : "—",
          },
          {
            key: "direction",
            header: "النوع",
            map: (r) => TYPE_LABEL[r.direction] ?? r.direction,
          },
          {
            key: "partyType",
            header: "نوع الطرف",
            map: (r) => PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—",
          },
          {
            key: "partyName",
            header: "اسم الطرف",
            map: (r) => r.partyName ?? r.counterpartyName ?? "",
          },
          {
            key: "createdByName",
            header: "المنفذ",
            map: (r) =>
              r.createdByName ??
              (r.createdBy ? `مستخدم #${r.createdBy}` : "غير موثق"),
          },
          {
            key: "voucherCategoryId",
            header: "الفئة",
            map: (r) =>
              r.voucherCategoryId
                ? (categoryMap.get(Number(r.voucherCategoryId)) ?? "—")
                : "—",
          },
          { key: "description", header: "الوصف" },
          {
            key: "amount",
            header: "المبلغ",
            map: (r) => fmt(r.amount ?? "0"),
          },
          {
            key: "paymentMethod",
            header: "الدفع",
            map: (r) => paymentMethodLabel(r.paymentMethod),
          },
          { key: "referenceNumber", header: "الرقم المرجعي" },
          { key: "checkNumber", header: "مرجع التحويل/الصكّ" },
          { key: "cardLastFour", header: "آخر ٤ بطاقة" },
          {
            key: "approvalStatus",
            header: "حالة الاعتماد",
            map: (r) => voucherApprovalLabel(r),
          },
          {
            key: "status",
            header: "الحالة",
            map: (r) => (r.status === "REVERSED" ? "مُلغى" : "مكتمل"),
          },
          // attachment-upload (٥/٧): المُرفق أصبح data URL صورة (~٩٣٣ك حرفاً) — تصديره خاماً يُفسد
          // الخلية (حدّ Excel ~٣٢،٧٦٧ حرفاً) ⇒ نعم/لا فقط؛ المُلَفّ نفسه يُفتَح من الشاشة مباشرةً.
          {
            key: "attachmentUrl",
            header: "مُرفَق؟",
            map: (r) => (r.attachmentUrl ? "نعم" : "لا"),
          },
          {
            key: "invoiceNumber",
            header: "الفاتورة المرتبطة",
            map: (r) => r.invoiceNumber ?? "—",
          },
          {
            key: "signatureHash",
            header: "بَصمة",
            map: (r) => shortHash(r.signatureHash),
          },
          {
            key: "cashBucket",
            header: "نوع النَقد",
            map: (r) =>
              r.cashBucket === "DRAWER"
                ? "درج كاشير"
                : r.cashBucket === "TREASURY"
                  ? "خزينة إدارية"
                  : "—",
          },
          {
            key: "resubmitAttempt",
            header: "محاولة إعادة الإصدار",
            map: (r) =>
              r.resubmitAttempt == null ? "—" : `A${r.resubmitAttempt}`,
          },
          {
            key: "resubmitRootReceiptId",
            header: "سند أصل السلسلة",
            map: (r) => r.resubmitRootReceiptId ?? "—",
          },
          {
            key: "resubmitPriorReceiptId",
            header: "السند السابق",
            map: (r) => r.resubmitPriorReceiptId ?? "—",
          },
          {
            key: "resubmitReason",
            header: "سبب إعادة الإصدار",
            map: (r) => r.resubmitReason ?? "—",
          },
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
    if (!canPrintOfficialVoucher(r)) {
      notify.err(
        "لا تتاح الطباعة الرسمية قبل اعتماد السند وتنفيذ أثره المالي.",
      );
      return;
    }
    if (mode === "a4" && !reservePrintWindow()) {
      notify.err(
        "تعذّر فتح نافذة الطباعة — تحقّق من مانع النوافذ المنبثقة",
      );
      return;
    }
    try {
      const v = await utils.vouchers.get.fetch({ receiptId: Number(r.id) });
      if (!v) {
        notify.err("تعذّر جَلب تفاصيل السند");
        return;
      }
      const branchName = null; // يُمكن إضافة branches.list هنا لاحقاً إذا لَزِم
      const payload: VoucherPrintData = {
        voucherNumber: v.voucherNumber ?? "",
        direction: v.direction as "IN" | "OUT",
        voucherDate: String(v.voucherDate ?? fmtDate(v.createdAt)).slice(0, 10),
        createdAt: String(v.createdAt),
        branchName,
        amount: fmt(v.amount),
        paymentMethod: v.paymentMethod,
        paymentMethodLabel: paymentMethodLabel(v.paymentMethod),
        referenceNumber: v.referenceNumber,
        checkNumber: v.checkNumber,
        cardLastFour: v.cardLastFour,
        partyTypeLabel: PARTY_LABEL[v.partyType ?? "OTHER"] ?? "—",
        partyName: v.partyName ?? v.counterpartyName ?? "—",
        partyBalance: null,
        categoryName: v.categoryName,
        description: v.description ?? "",
        counterpartyName: v.counterpartyName,
        approvalStatus: v.approvalStatus as
          | "APPROVED"
          | "PENDING_APPROVAL"
          | "REJECTED",
        approvedByName: v.approvedByName,
        approvedAt: v.approvedAt ? String(v.approvedAt) : null,
        createdByName: v.createdByName,
        cashBucket: v.cashBucket as "DRAWER" | "TREASURY" | null,
        signatureHash: v.signatureHash,
        attachmentUrl: v.attachmentUrl,
        relatedInvoiceNumber: v.invoiceNumber ?? null,
      };
      const result = await printAudit.run({
        documentType: "VOUCHER",
        documentId: Number(r.id),
        branchId: v.branchId == null ? null : Number(v.branchId),
        channel: mode === "a4" ? "BROWSER" : "THERMAL",
        open: (audit): Promise<PrintOpenResult> => {
          const auditedPayload = {
            ...payload,
            printedByName: audit.actorName,
            printRequestedAt: String(audit.requestedAt),
          };
          return mode === "a4"
            ? printVoucherA4(auditedPayload)
            : printVoucherReceipt(auditedPayload);
        },
      });
      if (typeof result === "boolean" && !result) {
        notify.err(
          "تعذّر فتح نافذة الطباعة — تأكّد من السماح بالنوافذ المنبثقة.",
        );
      }
    } catch (e) {
      if (mode === "a4") releaseReservedPrintWindow();
      notify.err(e);
    }
  }

  const statementHref = (r: VoucherRow) =>
    r.partyType === "CUSTOMER"
      ? `/customers-statement?id=${r.partyId}`
      : `/suppliers-statement?id=${r.partyId}`;

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
              <Button variant="outline" size="sm">
                إدارة الفئات
              </Button>
            </Link>
            <Link href="/vouchers/receipt/new">
              <Button variant="success">+ سند قبض</Button>
            </Link>
            <Link href="/vouchers/payment/new">
              <Button variant="destructive">+ طلب صرف</Button>
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
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="text-muted-foreground"
            >
              <X aria-hidden className="size-4" />
              {FILTER_LABELS.reset}
            </Button>
          )}
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3 items-end">
          <FilterField label="النوع">
            <AppSelect
              className="h-9"
              value={f.type}
              onValueChange={(value) => applyFilter({ type: value })}
            >
              <option value="">الكل</option>
              <option value="RECEIPT">قبض</option>
              <option value="PAYMENT">صرف</option>
            </AppSelect>
          </FilterField>
          <FilterField label="الطرف">
            <AppSelect
              className="h-9"
              value={f.party}
              onValueChange={(value) => applyFilter({ party: value })}
            >
              <option value="">الكل</option>
              <option value="CUSTOMER">عميل</option>
              <option value="SUPPLIER">مورّد</option>
              <option value="DELIVERY_PARTY">جهة توصيل</option>
              <option value="OTHER">أخرى</option>
            </AppSelect>
          </FilterField>
          <FilterField label="طريقة الدفع">
            <AppSelect
              className="h-9"
              value={f.method}
              onValueChange={(value) => applyFilter({ method: value })}
            >
              <option value="">الكل</option>
              <option value="CASH">نقدي</option>
              <option value="CARD">بطاقة</option>
              {/* صكّ: للسجلات التاريخية فقط — الإنشاء الجديد بلا صكوك (قرار المالك). */}
              <option value="CHECK">صكّ</option>
              <option value="TRANSFER">تحويل</option>
              <option value="WALLET">محفظة</option>
              <option value="EXCHANGE">صيرفة</option>
            </AppSelect>
          </FilterField>
          <FilterField label="الاعتماد">
            <AppSelect
              className="h-9"
              value={f.approval}
              onValueChange={(value) => applyFilter({ approval: value })}
            >
              <option value="">الكل</option>
              <option value="APPROVED">
                {f.type === "PAYMENT"
                  ? "معتمد ومصروف"
                  : f.type === "RECEIPT"
                    ? "مُعتمَد"
                    : "مُعتمَد / مصروف"}
              </option>
              <option value="PENDING_APPROVAL">
                {f.type === "PAYMENT"
                  ? "بانتظار الاعتماد والصرف"
                  : f.type === "RECEIPT"
                    ? "بانتظار الاعتماد"
                    : "بانتظار الاعتماد / الصرف"}
              </option>
              <option value="REJECTED">مَرفوض</option>
            </AppSelect>
          </FilterField>
          <FilterField label="حالة السند">
            <AppSelect
              value={f.status || "all"}
              onValueChange={(v) =>
                applyFilter({ status: v === "all" ? "" : v })
              }
              aria-label="فلتر حالة السند"
            >
              <option value="all">الكل</option>
              <option value="COMPLETED">مكتمل</option>
              <option value="REVERSED">مُلغى</option>
            </AppSelect>
          </FilterField>
          {canFilterBranch && (
            <FilterField label="الفرع">
              <AppSelect
                value={f.branch || "all"}
                onValueChange={(v) =>
                  applyFilter({ branch: v === "all" ? "" : v })
                }
                aria-label="فلتر الفرع"
              >
                <option value="all">الكل</option>
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={String(b.id)}>
                    {b.name}
                  </option>
                ))}
              </AppSelect>
            </FilterField>
          )}
          <FilterField label="الفئة">
            <AppSelect
              className="h-9"
              value={f.cat}
              onValueChange={(value) => applyFilter({ cat: value })}
            >
              <option value="">الكل</option>
              {(categories.data ?? []).map((c) => (
                <option key={Number(c.id)} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </AppSelect>
          </FilterField>
          <FilterField label="من تاريخ">
            <Input
              type="date"
              dir="ltr"
              value={f.from}
              onChange={(e) => applyFilter({ from: e.target.value })}
            />
          </FilterField>
          <FilterField label="إلى تاريخ">
            <Input
              type="date"
              dir="ltr"
              value={f.to}
              onChange={(e) => applyFilter({ to: e.target.value })}
            />
          </FilterField>
          <FilterField label="بحث (رقم/وصف/اسم مُستفيد)" className="md:col-span-3 lg:col-span-5">
            <Input
              type="search"
              autoFocus
              value={f.q}
              onChange={(e) => applyFilter({ q: e.target.value })}
              placeholder="رقم السند، الوصف، المستفيد، المرجع أو رقم الفاتورة…"
            />
          </FilterField>
        </CardContent>
      </Card>

      {/* البطاقات من aggregate الخادمي — كامل النطاق المفلتر لا صفوف الصفحة الحالية. */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">
              إجمالي القبض (مُعتمَد)
            </div>
            <div
              className="text-xl font-bold text-money-positive tabular-nums"
              dir="ltr"
            >
              {fmt(totalIn)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">
              إجمالي الصرف (معتمد ومصروف)
            </div>
            <div
              className="text-xl font-bold text-money-negative tabular-nums"
              dir="ltr"
            >
              {fmt(totalOut)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">الصافي</div>
            <div
              className={`text-xl font-bold tabular-nums ${netTotal.gte(0) ? "text-money-positive" : "text-money-negative"}`}
              dir="ltr"
            >
              {fmt(netTotal.toFixed(2))}
            </div>
            {(agg.data?.reversedCount ?? 0) > 0 && (
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {(agg.data?.reversedCount ?? 0).toLocaleString(
                  "ar-IQ-u-nu-latn",
                )}{" "}
                سند مُلغى في النطاق
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <ShieldQuestion aria-hidden className="size-3.5" />
              {f.type === "PAYMENT"
                ? "بانتظار اعتماد وصرف (بلا أَثَر)"
                : f.type === "RECEIPT"
                  ? "بانتظار اعتماد (بلا أَثَر)"
                  : "بانتظار اعتماد / صرف (بلا أَثَر)"}
            </div>
            <div
              className="text-xl font-bold text-[var(--sem-warn)] tabular-nums"
              dir="ltr"
            >
              {fmt(agg.data?.pendingTotal ?? "0")}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {(agg.data?.pendingCount ?? 0).toLocaleString("ar-IQ-u-nu-latn")}{" "}
              سند معلّق
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
          <DataTable<VoucherRow>
            data={rows}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            /* البحث والفلاتر في بطاقة الفلاتر أعلاه (تغذّي الاستعلام) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            externalFiltersActive={activeFilterCount > 0 || f.q.trim() !== ""}
            /* الترقيم خادميّ (limit/offset + count) ⇒ شريطٌ واحد داخل الجدول بدل شريطٍ يدويّ تحته. */
            serverPagination={{
              page,
              onPageChange: setPage,
              pageSize: limit,
              total: totalCount,
              hasMore: hasNext,
              isFetching: list.isFetching,
            }}
            /*
             * لونُ المعلّق/المرفوض على **الخلايا** (`[&>td]:`) لا على `<tr>`: زِبرةُ الجدول
             * تُصدَّر `odd:bg-…` أي `&:nth-child(odd)` بنوعيّةٍ (0,2,0) تغلب `bg-…` العارية
             * (0,1,0) على العنصر نفسه ⇒ الوسمُ يموت صامتاً. و`opacity` يبقى على الصفّ
             * (خاصّيةٌ أخرى لا تنازع فيها).
             */
            getRowClassName={(r) =>
              [
                r.status === "REVERSED" ? "opacity-60" : "",
                r.approvalStatus === "PENDING_APPROVAL" ? "[&>td]:bg-[var(--sem-warn-bg)]" : "",
                r.approvalStatus === "REJECTED" ? "[&>td]:bg-[var(--sem-neg-bg)]" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            emptyText="لا سندات مطابقة. أضِف سند قبض أو صرف جديداً."
            columns={[
              {
                id: "voucherNumber",
                header: "رقم السند",
                accessorFn: (r) => String(r.voucherNumber ?? "—"),
                meta: { width: "wide" },
                cell: ({ row }) => {
                  const r = row.original;
                  return (
                    <span className="font-mono text-xs">
                      <CopyInline value={String(r.voucherNumber ?? "—")} />
                      {r.signatureHash && (
                        <div className="text-[10px] text-muted-foreground" title={`بَصمة كاملة: ${r.signatureHash}`}>
                          #{shortHash(r.signatureHash)}
                        </div>
                      )}
                      {accrualPaymentAttemptLabel({
                        attempt: r.resubmitAttempt,
                        rootReceiptId: r.resubmitRootReceiptId,
                        priorReceiptId: r.resubmitPriorReceiptId,
                      }) && (
                        <div className="mt-1 text-[10px] text-muted-foreground font-sans" dir="rtl">
                          {accrualPaymentAttemptLabel({
                            attempt: r.resubmitAttempt,
                            rootReceiptId: r.resubmitRootReceiptId,
                            priorReceiptId: r.resubmitPriorReceiptId,
                          })}
                        </div>
                      )}
                      {r.resubmitReason && (
                        <div
                          className="mt-0.5 max-w-52 truncate text-[10px] text-muted-foreground font-sans"
                          title={r.resubmitReason}
                          dir="rtl"
                        >
                          سبب إعادة الإصدار: {r.resubmitReason}
                        </div>
                      )}
                      {r.resubmitLineageStatus === "BROKEN" && (
                        <div className="mt-1 text-[10px] text-[var(--sem-neg)] font-sans" dir="rtl">
                          سلسلة إعادة الإصدار غير مكتملة — يلزم تدقيق
                        </div>
                      )}
                    </span>
                  );
                },
              },
              {
                id: "voucherDate",
                header: "التاريخ",
                accessorFn: (r) => fmtDate(r.voucherDate),
                /* بلا kind: "date" — الخليّة تحمل سطراً عربياً («أُدخل: …») وعزلُ الاتّجاه يقلبه. */
                meta: { width: "date" },
                cell: ({ row }) => (
                  <span className="text-xs">
                    {fmtDate(row.original.voucherDate)}
                    {row.original.voucherDate && row.original.createdAt && (
                      <div className="text-[10px] text-muted-foreground">
                        أُدخل: {fmtDate(row.original.createdAt)}
                      </div>
                    )}
                  </span>
                ),
              },
              /* ٢٤/٨ (تدقيق): عمود الفرع يُظهر للمرتفعين فقط — لغيرهم قيمةٌ واحدة مكرَّرة
                 في كلّ صفٍّ = إهدار عرضٍ لا فائدةَ منه. */
              ...(canFilterBranch
                ? ([
                    {
                      id: "branch",
                      header: "الفرع",
                      accessorFn: (r) =>
                        r.branchId != null ? (branchMap.get(Number(r.branchId)) ?? `فرع ${r.branchId}`) : "—",
                      cell: ({ row }) => (
                        <span className="text-xs">
                          {row.original.branchId != null
                            ? (branchMap.get(Number(row.original.branchId)) ?? `فرع ${row.original.branchId}`)
                            : "—"}
                        </span>
                      ),
                    },
                  ] as ColumnDef<VoucherRow, unknown>[])
                : []),
              {
                id: "direction",
                header: "النوع",
                accessorFn: (r) => TYPE_LABEL[r.direction],
                meta: { kind: "status" },
                cell: ({ row }) => (
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${row.original.direction === "IN" ? "badge-status-active" : "badge-stock-out"}`}>
                    {TYPE_LABEL[row.original.direction]}
                  </span>
                ),
              },
              {
                id: "party",
                header: "الطرف",
                accessorFn: (r) =>
                  r.partyName?.trim() || r.counterpartyName?.trim() || PARTY_LABEL[r.partyType ?? "OTHER"] || "—",
                meta: { width: "wide" },
                cell: ({ row }) => {
                  const r = row.original;
                  const partyDisplay =
                    r.partyName?.trim() || r.counterpartyName?.trim() || PARTY_LABEL[r.partyType ?? "OTHER"] || "—";
                  return (
                    <span className="text-xs">
                      {partyDisplay}
                      {r.partyType !== "OTHER" && r.counterpartyName && r.counterpartyName !== partyDisplay && (
                        <div className="text-[10px] text-muted-foreground">{r.counterpartyName}</div>
                      )}
                      {/*
                        أُزيل سطرُ «نفّذ: …» المدفون داخل خليّة الطرف: صار للفاعل عمودٌ
                        مستقلّ باسم العقد. إبقاؤه هنا يُكرّر المعلومة في خليّتين ويُبقي
                        الخلطَ الذي نُعالجه: الطرفُ الآخر والفاعلُ دوران مختلفان.
                      */}
                      {r.invoiceNumber && (
                        // ٢٤/٨ (تدقيق + Codex P2 على PR #746): رابطٌ مباشرٌ بـ`invoiceId` لا فلترٍ
                        // بالرقم — «INV-1» و«INV-10» و«INV-11» يتشابهان في `q=INV-1` فتُرجع
                        // القائمةُ نتائجَ كثيرة. الآن قفزةٌ مباشرة إلى الفاتورة المذكورة.
                        canOpenInvoices && r.invoiceId != null ? (
                          <Link
                            href={`/invoices/${r.invoiceId}`}
                            className="text-[10px] text-primary hover:underline inline-flex items-center gap-1"
                            title="فتح الفاتورة"
                          >
                            <Link2 aria-hidden className="size-3" /> فاتورة #{r.invoiceNumber}
                          </Link>
                        ) : (
                          <div className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                            فاتورة #{r.invoiceNumber}
                          </div>
                        )
                      )}
                    </span>
                  );
                },
              },
              {
                id: "performedBy",
                header: ATTRIBUTION_LABELS.performedBy,
                accessorFn: (r) => r.createdByName ?? "",
                meta: { kind: "actor" },
                cell: ({ row }) => (
                  <ActorCell actor={{ name: row.original.createdByName, userId: row.original.createdBy }} />
                ),
              },
              {
                id: "category",
                header: "الفئة",
                accessorFn: (r) => (r.voucherCategoryId ? (categoryMap.get(Number(r.voucherCategoryId)) ?? "—") : "—"),
                cell: ({ row }) => (
                  <span className="text-xs">
                    {row.original.voucherCategoryId
                      ? (categoryMap.get(Number(row.original.voucherCategoryId)) ?? "—")
                      : "—"}
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
                cell: ({ row }) => fmt(row.original.amount),
              },
              {
                id: "paymentMethod",
                header: "الدفع",
                accessorFn: (r) => paymentMethodLabel(r.paymentMethod),
                meta: { align: "center" },
                cell: ({ row }) => <span className="text-xs">{paymentMethodLabel(row.original.paymentMethod)}</span>,
              },
              {
                id: "approval",
                header: "الاعتماد",
                accessorFn: (r) => voucherApprovalLabel(r),
                meta: { kind: "status" },
                cell: ({ row }) => {
                  const r = row.original;
                  const isPending = r.approvalStatus === "PENDING_APPROVAL";
                  const isRejected = r.approvalStatus === "REJECTED";
                  return (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                        isPending ? "badge-status-pending" : isRejected ? "badge-status-cancelled" : "badge-status-active"
                      }`}
                    >
                      {isPending && <ShieldQuestion aria-hidden className="size-3" />}
                      {isRejected && <XCircle aria-hidden className="size-3" />}
                      {!isPending && !isRejected && <CheckCircle2 aria-hidden className="size-3" />}
                      {voucherApprovalLabel(r)}
                    </span>
                  );
                },
              },
              {
                id: "attachment",
                header: "المُرفَق",
                accessorFn: (r) => (r.attachmentUrl ? "مُرفَق" : "—"),
                enableSorting: false,
                meta: { align: "center" },
                cell: ({ row }) =>
                  row.original.attachmentUrl ? (
                    <a href={row.original.attachmentUrl} target="_blank" rel="noreferrer" title="فتح المُرفق">
                      <Paperclip aria-hidden className="size-4 text-[var(--sem-pos)] inline" />
                    </a>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  ),
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
                            canManageLegacyReceipt: canManage,
                          }),
                          disabled: approveMut.isPending,
                          disabledReason: "توجد عملية اعتماد وصرف قيد التنفيذ",
                          onSelect: () => void approveVoucher(r),
                          gate: { module: "treasury", level: "FULL" },
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
                            canManageLegacyReceipt: canManage,
                          }),
                          disabled: rejectMut.isPending,
                          disabledReason: "توجد عملية رفض قيد التنفيذ",
                          onSelect: () => openReject(r),
                          gate: { module: "treasury", level: "FULL" },
                        },
                        {
                          key: "resubmit-system-payment",
                          kind: "create",
                          label: r.referenceNumber?.startsWith("TERM-SETTLEMENT-")
                            ? "إعادة تقديم تسوية نهاية الخدمة"
                            : isPurchaseSupplierPaymentReference(r.referenceNumber)
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
                              canManage,
                            }) &&
                            !(
                              canManage &&
                              r.approvalStatus === "REJECTED" &&
                              r.resubmitLineageStatus !== "BROKEN" &&
                              isPurchaseSupplierPaymentReference(r.referenceNumber)
                            ),
                          disabled: resubmitSystemPaymentMut.isPending,
                          disabledReason: "توجد إعادة تقديم قيد التنفيذ",
                          onSelect: () => openResubmitSystemPayment(r),
                          gate: {
                            roles: ["manager", "accountant"],
                            module: "treasury",
                            level: "FULL",
                          },
                        },
                        {
                          key: "stmt",
                          kind: "view",
                          label: "كشف حساب الطرف",
                          href: statementHref(r),
                          hidden: r.partyType === "OTHER" || r.partyType == null || r.partyId == null,
                          gate: {
                            roles: ["manager", "accountant"],
                            module: "treasury",
                            level: "READ",
                          },
                        },
                        {
                          key: "cancel",
                          kind: "reverse",
                          label:
                            r.status === "COMPLETED" && r.approvalStatus === "APPROVED"
                              ? "طلب إلغاء السند"
                              : "إلغاء الطلب",
                          variant: "destructive",
                          hidden:
                            !canManage ||
                            r.status === "REVERSED" ||
                            r.paymentMethod === "EXCHANGE" ||
                            (isSystemPaymentReference(r.referenceNumber) &&
                              !isPurchaseSupplierPaymentReference(r.referenceNumber)),
                          disabled: cancelMut.isPending,
                          disabledReason: "توجد عملية إلغاء قيد التنفيذ",
                          onSelect: () => void cancelVoucher(r),
                          gate: {
                            roles: ["manager", "accountant"],
                            module: "treasury",
                            level: "FULL",
                          },
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

      {/* حوار سبب الرفض — بديل window.prompt: السبب سجلّ تدقيقي إلزامي. */}
      <Dialog
        open={rejectTarget != null}
        onOpenChange={(open) => {
          if (!open && !rejectMut.isPending) setRejectTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              رفض السند {rejectTarget?.voucherNumber ?? ""}
            </DialogTitle>
            <DialogDescription>
              {rejectTarget?.referenceNumber?.startsWith("TERM-SETTLEMENT-")
                ? "سبب الرفض إلزامي. يُرفض طلب الدفع فقط؛ يبقى إنهاء الخدمة مثبتاً وتبقى التسوية غير مدفوعة، ويمكن إعادة تقديمها صراحةً من السجل بلا تكرار."
                : isPurchaseSupplierPaymentReference(
                      rejectTarget?.referenceNumber,
                    )
                  ? "سبب الرفض إلزامي. لا تتغير ذمة المورد أو أمر الشراء، ويمكن إعادة تقديم الطلب مرتبطاً بالأمر نفسه بعد التصحيح."
                  : rejectTarget?.referenceNumber?.startsWith("ASSET-ACQ-")
                    ? "سبب الرفض إلزامي. يُرفض طلب التسوية فقط؛ يبقى الأصل والتزام اقتنائه مثبتين، ويمكن إعادة تقديم الدفع صراحةً بلا تكرار الأصل أو القيد."
                    : rejectTarget?.referenceNumber &&
                        (rejectTarget.referenceNumber.startsWith("SHIP-") ||
                          rejectTarget.referenceNumber.startsWith(
                            "ASSET-MAINT-",
                          ))
                      ? "سبب الرفض إلزامي. يُرفض طلب الدفع فقط؛ يبقى المصروف وقيد استحقاقه مثبتين، ولا يُنشأ طلب بديل حتى إعادة تقديمه صراحةً."
                      : "سبب الرفض إلزامي للسجل التَدقيقي — يَبقى السند في السجل بلا أي أَثَر مالي."}
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
            <Button
              variant="outline"
              onClick={() => setRejectTarget(null)}
              disabled={rejectMut.isPending}
            >
              تراجع
            </Button>
            <Button
              variant="destructive"
              onClick={submitReject}
              disabled={!rejectReason.trim() || rejectMut.isPending}
            >
              {rejectMut.isPending ? ACTION_LABELS.rejecting : "رفض السند"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
