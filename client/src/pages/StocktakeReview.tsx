import { ReviewItemRow } from "@/components/stocktake/ReviewItemRow";
import type { Reason } from "@/components/stocktake/ReviewRowTypes";
import { StatusBadge, Pill, Stat, nf, money, pctStr, dt } from "@/components/stocktake/ReviewDisplay";
import { ReviewDecisionDialogs } from "@/components/stocktake/ReviewDecisionDialogs";
import { ReviewApprovalDialogs } from "@/components/stocktake/ReviewApprovalDialogs";
import { ReviewBarriers } from "@/components/stocktake/ReviewBarriers";
import { stocktakeOperationAccess } from "@/lib/stocktakeOperationAccess";
/**
 * مراجعة وتدقيق واعتماد الجرد — /stocktakes/:id/review (الشاشة الأهم في الدورة)
 * مرجع التصميم: jrd-review.jsx — hi-fi بمكونات النظام.
 * البيانات: trpc.stocktakes.review({ sessionId, autoAdjust }) — مخرجه مُعرَّف حرفياً في العقد §٤.
 * الصلاحية: managerProcedure في الخادم (قيم التكلفة محجوبة عن غيره أصلاً) — الواجهة تعرض
 * رسالة لطيفة لغير المخوَّل ولا تستعلم أصلاً.
 *
 * المعادلات تُحسب في الخادم (rawCount/netAfter/adjustedCount/diff/value/pct) — هذه الشاشة
 * تعرضها فقط وتدير القرارات: سبب الفرق + تسوية/إبقاء (decide)، فصل التعارض (resolveConflict)،
 * إعادة العدّ (requestRecount)، والتوقيع المزدوج (firstSign ثم approve بمستخدم مختلف).
 */
import { Button } from "@/components/ui/button";

import { Card } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { StocktakeOverlapNotice } from "@/components/stocktake/StocktakeOverlapNotice";
import { Switch } from "@/components/ui/switch";



import { trpc } from "@/lib/trpc";

import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { ACTION_LABELS } from "@shared/actionLabels";
import { variantDisplayName, variantDescriptor } from "@shared/variantDisplay";
import { ErrorState } from "@/components/PageState";
import { STOCKTAKE_REASON_LABEL } from "@/lib/printing/stocktakeTemplates";
import { useState } from "react";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { Link, useLocation, useParams } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { willRowSettleNegative } from "@/components/stocktake/NegativeSettlementUi";
import { Printer, Download, Lock, AlertTriangle, RefreshCw, Scale, Pen, Info, Check } from "lucide-react";

/* ───────── ثوابت العرض ───────── */

const FILTERS = [
  ["all", "الكل"],
  ["ready", "جاهز للاعتماد"],
  ["approved", "معتمد مرحلياً"],
  ["diff", "الفروقات فقط"],
  ["over", "يتجاوز الحدّ"],
  ["conflict", "تعارضات"],
  ["recount", "إعادة عدّ"],
  ["uncounted", "غير معدود"],
] as const;
type FilterKey = (typeof FILTERS)[number][0];

const PAGE = 200; // سقف عرض تدريجي — جلسات الجرد الشامل قد تحوي آلاف المنتجات.

export default function StocktakeReview() {
  const params = useParams();
  const sessionId = Number(params.id);
  const idOk = Number.isFinite(sessionId) && sessionId > 0;
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  const { canOperation, role, canReview } = stocktakeOperationAccess(me.data);

  /* ───── حالة الشاشة ───── */
  const [autoAdjust, setAutoAdjust] = useState(true); // التصحيح الآلي للحركات اللاحقة (افتراضي ON)
  const [filter, setFilterRaw] = useState<FilterKey>("all");
  const [q, setQ] = useState("");
  const [visible, setVisible] = useState(PAGE);
  const [recountFor, setRecountFor] = useState<{
    variantId: number;
    label: string;
  } | null>(null);
  const [recountReason, setRecountReason] = useState("");
  const [reopenFor, setReopenFor] = useState<{
    variantId: number;
    label: string;
  } | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [conflictFor, setConflictFor] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [valuationRefreshOpen, setValuationRefreshOpen] = useState(false);
  const [valuationRefreshReason, setValuationRefreshReason] = useState("");
  /** سبب الفرق المختار محلياً لكل منتج (قبل/مع القرار). */
  const [reasonSel, setReasonSel] = useState<Record<number, Reason>>({});
  const [selectedForApproval, setSelectedForApproval] = useState<Set<number>>(
    () => new Set(),
  );

  function setFilter(f: FilterKey) {
    setFilterRaw(f);
    setVisible(PAGE);
  }

  // autoAdjust جزء من مفتاح الاستعلام ⇒ تبديله يعيد الاستعلام بالبنية نفسها (العقد §٤).
  const review = trpc.stocktakes.review.useQuery(
    { sessionId, autoAdjust },
    { enabled: (idOk && canReview) && canOperation("stocktakes.review") },
  );
  const reviewData = canOperation("stocktakes.review") ? review.data : undefined;

  /* ───── الطفرات ───── */
  const invalidate = async () =>
    Promise.all([
      utils.stocktakes.review.invalidate(),
      utils.stocktakes.monitor.invalidate(),
      utils.stocktakes.remaining.invalidate(),
      utils.stocktakes.list.invalidate(),
    ]);

  const decide = trpc.stocktakes.decide.useMutation({
    onSuccess: () => utils.stocktakes.review.invalidate(),
    onError: (e) => notify.err(e),
  });
  const approveItems = trpc.stocktakes.approveItems.useMutation({
    onSuccess: async (r) => {
      setSelectedForApproval(new Set());
      notify.ok(
        `اعتُمد ${nf(r.approvedCount)} منتج مرحلياً`,
        r.refreshedCount > 0
          ? `أُعيد تثبيت بصمة ${nf(r.refreshedCount)} اعتماد قديم. يستمر العدّ، ولا ترحيل قبل اعتماد الجلسة.`
          : "يستمر العمال في عدّ البقية، وتُرحّل التسوية عند الاعتماد النهائي للجلسة.",
      );
      await invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const reopenItemReview = trpc.stocktakes.reopenItemReview.useMutation({
    onSuccess: async () => {
      setReopenFor(null);
      setReopenReason("");
      notify.ok(
        "أُلغي الاعتماد المرحلي وأُعيد المنتج للمراجعة",
        "سُجّل السبب داخل أثر التدقيق الذرّي للجرد.",
      );
      await invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const resolveConflict = trpc.stocktakes.resolveConflict.useMutation({
    onSuccess: async () => {
      setConflictFor(null);
      notify.ok("فُصل في التعارض — العدّان محفوظان في السجلّ");
      await invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const requestRecount = trpc.stocktakes.requestRecount.useMutation({
    onSuccess: async () => {
      setRecountFor(null);
      setRecountReason("");
      notify.ok("أُرسل طلب إعادة العدّ لشاشة العامل");
      await invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const firstSign = trpc.stocktakes.firstSign.useMutation({
    onSuccess: async (r) => {
      notify.ok(
        "وُقّع التوقيع الأول",
        `${r.firstSignByName} · ${dt(r.firstSignAt)} — الاعتماد النهائي يلزم أن يكون من مسؤول آخر.`,
      );
      await invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const approve = trpc.stocktakes.approve.useMutation({
    onSuccess: async (r) => {
      setConfirmOpen(false);
      if (r.alreadyApproved) notify.info("الجلسة معتمدة سلفاً — لا أثر جديد.");
      else
        notify.ok(
          "اعتُمدت الجلسة ونُفّذت التسوية",
          `${nf(r.adjustedCount)} حركة تسوية — عجز ${money(r.shortExpense)} · زيادة ${money(r.overGain)}` +
            (r.negativeSettlements > 0
              ? ` — ${nf(r.negativeSettlements)} صنف بأرصدة سالبة (راجع تقرير السوالب)`
              : ""),
        );
      await invalidate();
      // اعتماد الجلسة يكتب مباشرةً إلى branchStock (سالباً محتملاً) — تقرير السوالب خارج
      // نطاق invalidate() (مقصورة على stocktakes.*)، ولها staleTime 60ث في شاشته
      // (InventoryOpsReport.tsx)؛ بلا هذا قد يُوجَّه المعتمد لتقريرٍ لا يعرض ما أَحدَثه للتوّ.
      if (!r.alreadyApproved) await utils.reports.negativeStock.invalidate();
      navigate(`/stocktakes/${sessionId}/report`);
    },
    onError: (e) => notify.err(e),
  });
  const refreshOpeningValuation =
    trpc.stocktakes.refreshOpeningValuationBasis.useMutation({
      onSuccess: async (r) => {
        setValuationRefreshOpen(false);
        setValuationRefreshReason("");
        notify.ok(
          `صُحّح أساس تكلفة ${nf(r.changedCount)} منتج دون لمس الكميات أو النقد`,
          `تغيّر التقييم من ${money(r.oldNetValue)} إلى ${money(r.newNetValue)}، وأُعيد فتح ${nf(r.reopenedCount)} اعتماد للمراجعة.`,
        );
        await invalidate();
      },
      onError: (e) => notify.err(e),
    });

  /* ───── حواجز عرض مبكرة (بعد كل الـhooks) ───── */
  if (!idOk)
    return (
      <div className="p-10 text-center text-muted-foreground">
        معرّف الجلسة غير صالح.
      </div>
    );
  if (me.isLoading)
    return (
      <div className="p-10 text-center text-muted-foreground">
        {ACTION_LABELS.loading}
      </div>
    );
  /* هويّةٌ لم تصل ⇒ `me.data` غائبة فيسقط حاجزُ الصلاحية أدناه ويُعرَض ملفُّ المراجعة كاملاً
   * كأنّ الدور مشرف (الخادم يحمي البيانات، لكنّ الشاشة تكذب). نُعلن الفشل بدل السقوط المفتوح.
   * الشرط `!me.data` يُبقي البيانات المخزَّنة عاملةً حين يفشل تحديثٌ خلفيّ فقط. */
  if (me.isError && !me.data)
    return (
      <ErrorState
        className="p-10"
        message={me.error?.message ?? "تعذّر التحقّق من صلاحيتك."}
        onRetry={() => void me.refetch()}
      />
    );
  if (me.data && !canReview)
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10 text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-full bg-muted text-muted-foreground">
          <Lock aria-hidden className="size-8" />
        </div>
        <p className="font-bold">يتطلب عرض المراجعة تفويض مراجعة الجرد</p>
        <p className="text-sm text-muted-foreground">
          لم يمنحك الحساب صلاحية عرض المراجعة. يمكنك متابعة
          تقدم العدّ وطلب إعادة العدّ من شاشة المتابعة.
        </p>
        <Link href={`/stocktakes/${sessionId}`}>
          <Button variant="outline">→ شاشة متابعة العدّ</Button>
        </Link>
      </div>
    );
  if (review.isLoading)
    return (
      <div className="p-10 text-center text-muted-foreground">
        جارٍ تحميل المراجعة…
      </div>
    );
  if (review.error)
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10 text-center">
        <p className="font-bold text-money-negative">تعذّر تحميل المراجعة</p>
        <p className="text-sm text-muted-foreground">{review.error.message}</p>
        <Link href="/stocktakes">
          <Button variant="outline">→ جلسات الجرد</Button>
        </Link>
      </div>
    );
  if (!reviewData)
    return (
      <div className="p-10 text-center text-muted-foreground">
        الجلسة غير موجودة.
      </div>
    );

  const {
    session: s,
    rows,
    totals,
    barriers,
    ledgerPreview,
    valuationIntegrity,
    countIntegrity,
  } = reviewData;
  const isOpening = s.sessionType === "OPENING";
  const hasMissingBaseCost = valuationIntegrity.rows.some(
    (row) => row.reason === "ZERO_BASE_COST",
  );

  type ValuationIntegrityRow = (typeof valuationIntegrity.rows)[number];
  type CountIntegrityRow = (typeof countIntegrity.rows)[number];

  /* جدولا الحارسين مُضمَّنان في بطاقتَي تحذيرٍ تحملان عنوانيهما وعدَّهما. */
  const INTEGRITY_TABLE = { embedded: true, searchable: false, bounded: false, pageSize: Infinity } as const;

  /** اسم المنتج مع بديله ورمزه — نصٌّ واحد للنسخ وعرضٌ مركّب للقراءة. */
  const integrityNameCell = (row: { productName: string; variantName?: string | null; color?: string | null; size?: string | null; variantKind?: string | null; sku: string }) => (
    <>
      {row.productName}
      {variantDescriptor(row) ? " — " + variantDescriptor(row) : ""}
      <span className="ms-1 font-mono text-[10px] text-muted-foreground" dir="ltr">
        {row.sku}
      </span>
    </>
  );

  const valuationIntegrityColumns: ColumnDef<ValuationIntegrityRow, unknown>[] = [
    {
      id: "product",
      header: "المنتج",
      accessorFn: (r) => variantDisplayName(r) + " · " + r.sku,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => <span className="font-semibold">{integrityNameCell(row.original)}</span>,
    },
    { id: "diff", header: "الفرق", accessorFn: (r) => nf(r.diff), meta: { kind: "number" }, cell: ({ row }) => nf(row.original.diff) },
    { id: "snapshotUnitCost", header: "تكلفة اللقطة", accessorFn: (r) => money(r.snapshotUnitCost), meta: { kind: "money" }, cell: ({ row }) => money(row.original.snapshotUnitCost) },
    { id: "currentBaseUnitCost", header: "تكلفة الأساس الحالية", accessorFn: (r) => money(r.currentBaseUnitCost), meta: { kind: "money" }, cell: ({ row }) => money(row.original.currentBaseUnitCost) },
    { id: "snapshotValue", header: "القيمة المسجلة", accessorFn: (r) => money(r.snapshotValue), meta: { kind: "money" }, cell: ({ row }) => money(row.original.snapshotValue) },
    { id: "currentBaseValue", header: "القيمة الحالية", accessorFn: (r) => money(r.currentBaseValue), meta: { kind: "money" }, cell: ({ row }) => money(row.original.currentBaseValue) },
    {
      id: "status",
      header: "الحالة",
      accessorFn: (r) => (r.blocking ? "حاجب" : "يحتاج مراجعة"),
      meta: { kind: "status" },
      cell: ({ row }) => <Pill tone={row.original.blocking ? "rose" : "amber"}>{row.original.blocking ? "حاجب" : "يحتاج مراجعة"}</Pill>,
    },
  ];

  const countIntegrityColumns: ColumnDef<CountIntegrityRow, unknown>[] = [
    {
      id: "product",
      header: "المنتج",
      accessorFn: (r) => variantDisplayName(r) + " · " + r.sku,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => <span className="font-semibold">{integrityNameCell(row.original)}</span>,
    },
    {
      id: "rawCount",
      header: "الكمية المشبوهة",
      accessorFn: (r) => nf(r.rawCount),
      meta: { kind: "number" },
      cell: ({ row }) => <span className="font-mono">{nf(row.original.rawCount)}</span>,
    },
    {
      id: "matchedCodeKind",
      header: "مصدر المطابقة",
      accessorFn: (r) => (r.matchedCodeKind === "ALIAS" ? "باركود بديل" : r.matchedCodeKind === "SKU" ? "رمز SKU" : "باركود وحدة"),
      meta: { kind: "status" },
      cell: ({ row }) => (
        <Pill tone="rose">
          {row.original.matchedCodeKind === "ALIAS" ? "باركود بديل" : row.original.matchedCodeKind === "SKU" ? "رمز SKU" : "باركود وحدة"}
        </Pill>
      ),
    },
  ];
  const effectiveDirectUnderThreshold = isOpening || s.directUnderThreshold;
  const isReview = s.status === "REVIEW";
  const isOperational = s.status === "COUNTING" || s.status === "REVIEW";
  const isApproved = s.status === "APPROVED";
  const dualItems = rows.filter(
    (r: { requiresDualSign: boolean }) => r.requiresDualSign,
  );

  type Row = (typeof rows)[number];

  /** سبب الفرق الفعّال للصف: اختيار محلي ← قرار محفوظ ← غير محدد. */
  const effReason = (r: Row): Reason =>
    (reasonSel[r.variantId] as Reason | undefined) ??
    (r.decision?.reason as Reason | undefined) ??
    "UNSPECIFIED";

  const rowSettlesNegative = (r: Row) =>
    willRowSettleNegative(r, effectiveDirectUnderThreshold);

  /* ───── الفلاتر + البحث المحلي ───── */
  const qNorm = q.trim().toLowerCase();
  const filtered = rows.filter((r: Row) => {
    if (qNorm) {
      const hay =
        `${r.productName} ${r.variantName ?? ""} ${r.sku}`.toLowerCase();
      if (!hay.includes(qNorm)) return false;
    }
    switch (filter) {
      case "ready":
        return r.readyForReviewApproval && !r.reviewApproved?.isCurrent;
      case "approved":
        return r.reviewApproved?.isCurrent === true;
      case "diff":
        return r.diff != null && r.diff !== 0;
      case "over":
        return r.overThreshold;
      case "conflict":
        return r.conflict != null && r.conflict.resolvedPick == null;
      case "recount":
        return r.recount != null;
      case "uncounted":
        return r.rawCount == null;
      default:
        return true;
    }
  });
  const shown = filtered.slice(0, visible);
  const shownReady = shown.filter(
    (r: Row) => r.readyForReviewApproval && !r.reviewApproved?.isCurrent,
  );
  const selectedReady = rows.filter(
    (r: Row) =>
      selectedForApproval.has(r.variantId) &&
      r.readyForReviewApproval &&
      !r.reviewApproved?.isCurrent,
  );

  function toggleApprovalSelection(variantId: number, checked: boolean) {
    setSelectedForApproval((prev) => {
      const next = new Set(prev);
      if (checked) next.add(variantId);
      else next.delete(variantId);
      return next;
    });
  }

  function selectShownReady() {
    setSelectedForApproval(
      new Set(shownReady.slice(0, 500).map((r: Row) => r.variantId)),
    );
  }

  async function approveSelectedItems() {
    const ids = selectedReady.slice(0, 500).map((r: Row) => r.variantId);
    if (!ids.length) return;
    const ok = await confirm({
      variant: "warning",
      title: `اعتماد مرحلي لـ${nf(ids.length)} منتج`,
      description:
        "سيُقفل عدّ هذه المنتجات إدارياً كي لا يتغير بعد المراجعة، بينما يستمر العمال في عدّ المنتجات المتبقية. لا تُرحّل حركة مخزون أو قيد مالي حتى الاعتماد النهائي للجلسة.",
      confirmText: "اعتماد المحدد ومتابعة الجرد",
    });
    if (ok) (canOperation("stocktakes.approveItems") && approveItems.mutate({ sessionId, variantIds: ids }));
  }

  function submitReopen() {
    if (!reopenFor) return;
    const reason = reopenReason.trim();
    if (reason.length < 3) {
      notify.warn("اكتب سبب إعادة الفتح (3 أحرف على الأقل)");
      return;
    }
    (canOperation("stocktakes.reopenItemReview") && reopenItemReview.mutate({
      sessionId,
      variantId: reopenFor.variantId,
      reason,
    }));
  }

  /* ───── زر الاعتماد (التدفق المزدوج) ───── */
  let approveLabel: string;
  let approveMode: "final" | "first" | "wait";
  if (!barriers.requiresDualSign) {
    approveMode = "final";
    approveLabel = isOpening
      ? "اعتماد وتثبيت الأرصدة الافتتاحية"
      : "اعتماد الجلسة وتنفيذ التسوية";
  } else if (!barriers.firstSigned) {
    approveMode = "first";
    approveLabel = "توقيع أول — إرسال للتوقيع الثاني";
  } else if (!barriers.canFinalApprove) {
    approveMode = "wait";
    approveLabel = "بانتظار توقيع مسؤول آخر…";
  } else {
    approveMode = "final";
    approveLabel = "التوقيع الثاني والاعتماد النهائي";
  }
  const approveDisabled =
    !canOperation(approveMode === "first" ? "stocktakes.firstSign" : "stocktakes.approve") ||
    !isReview ||
    !barriers.canApprove ||
    approveMode === "wait" ||
    approve.isPending ||
    firstSign.isPending;
  const approveTitle = !isReview
    ? isApproved
      ? "الجلسة معتمدة ومقفلة"
      : "الاعتماد متاح لجلسة قيد المراجعة فقط"
    : barriers.activeStocktakeOverlaps > 0
      ? `${nf(barriers.activeStocktakeOverlaps)} صنف مرتبط بجرد نشط آخر — أكمله أو ألغِه أولاً`
      : barriers.interveningStocktakeCounts > 0
        ? `${nf(barriers.interveningStocktakeCounts)} عدّ قديم تخلله اعتماد جرد آخر — اطلب إعادة عدّ الأصناف المتأثرة`
    : barriers.valuationBlockingAnomalies > 0
      ? `${nf(barriers.valuationBlockingAnomalies)} تضخم تكلفة/وحدة مادي يحجب الاعتماد`
      : barriers.countInputAnomalies > 0
        ? `${nf(barriers.countInputAnomalies)} كمية تطابق بصمة إدخال باركود وتحتاج إعادة عد مستقلة`
        : barriers.openConflicts > 0
          ? `${nf(barriers.openConflicts)} تعارض بين عدَّين يحتاج فصلاً`
          : barriers.notCounted > 0
            ? `${nf(barriers.notCounted)} منتج غير معدود يحجب الاعتماد النهائي`
            : barriers.pendingRecounts > 0
              ? `${nf(barriers.pendingRecounts)} منتج بانتظار إعادة العدّ`
              : barriers.undecidedOverThreshold > 0
                ? `${nf(barriers.undecidedOverThreshold)} فرق يتجاوز الحدّ بلا قرار`
                : barriers.overThresholdNeedingRecount > 0
                  ? `${nf(barriers.overThresholdNeedingRecount)} فرق يتجاوز الحدّ يلزمه إعادة عدّ فعلية`
                  : barriers.countedPendingReview > 0
                  ? `${nf(barriers.countedPendingReview)} منتج يحتاج اعتماداً مرحلياً صالحاً`
                  : barriers.reviewerFinalSeparationBlocked
                    ? "راجعتَ فرقاً عالي القيمة مرحلياً — الاعتماد النهائي لمسؤول آخر"
                    : approveMode === "wait"
                      ? "وقّعتَ أولاً — التوقيع الثاني يلزم أن يكون من مسؤول آخر"
                      : "";

  /* ───── إحصاءات حوار التأكيد ───── */
  const autoCount = rows.filter(
    (r: Row) =>
      r.diff != null &&
      r.diff !== 0 &&
      !r.decision &&
      !r.overThreshold &&
      effectiveDirectUnderThreshold,
  ).length;
  const adjustExplicit = rows.filter(
    (r: Row) => r.decision?.action === "ADJUST" && !r.decision.autoApplied,
  ).length;
  const keepCount = rows.filter(
    (r: Row) => r.decision?.action === "KEEP",
  ).length;
  const noReasonCount = rows.filter(
    (r: Row) =>
      r.diff != null && r.diff !== 0 && effReason(r) === "UNSPECIFIED",
  ).length;
  /* بيعٌ استمرّ بعد العدّ وتجاوزه ⇒ العدّ المصحَّح سالب. تُثبَّت برصيدها الحقيقي عند الاعتماد
   * (لا تُحجَب — انظر finalize.ts) وتظهر في تقرير السوالب؛ هذا العدّ للتنبيه المسبق فقط. */
  const negativeSettleCount = rows.filter(rowSettlesNegative).length;
  const hasShort = D(ledgerPreview.shortExpense).gt(0);
  const hasOver = D(ledgerPreview.overGain).gt(0);

  /* ───── أفعال ───── */
  function onReasonChange(r: Row, value: Reason) {
    if (!canOperation("stocktakes.decide")) return;
    setReasonSel((prev) => ({ ...prev, [r.variantId]: value }));
    if (r.decision) {
      // تحديث سبب قرار قائم بإعادة استدعاء decide بنفس الفعل (upsert في الخادم).
      (canOperation("stocktakes.decide") && decide.mutate({
        sessionId,
        variantId: r.variantId,
        action: r.decision.action,
        reason: value,
      }));
    } else if (
      r.diff != null &&
      r.diff !== 0 &&
      !r.overThreshold &&
      s.directUnderThreshold
    ) {
      // ضمن الحدّ: تثبيت التصنيف فوراً كقرار تسوية صريح — نفس أثر التسوية التلقائية مع حفظ السبب
      // (وإلا ضاع السبب وسُجِّل «غير محدد» في القرار التلقائي عند الاعتماد).
      (canOperation("stocktakes.decide") && decide.mutate({
        sessionId,
        variantId: r.variantId,
        action: "ADJUST",
        reason: value,
      }));
    }
  }
  function onDecide(r: Row, action: "ADJUST" | "KEEP") {
    (canOperation("stocktakes.decide") && decide.mutate({
      sessionId,
      variantId: r.variantId,
      action,
      reason: effReason(r),
    }));
  }
  function openRecount(r: Row) {
    setRecountReason("");
    setRecountFor({
      variantId: r.variantId,
      label: `${r.productName}${r.variantName ? ` — ${r.variantName}` : ""}`,
    });
  }
  function submitRecount() {
    if (!recountFor) return;
    const reason = recountReason.trim();
    if (reason.length < 3) {
      notify.warn(
        "سبب الطلب إلزامي (٣ أحرف على الأقل) — يُسجَّل في سجلّ التدقيق.",
      );
      return;
    }
    (canOperation("stocktakes.requestRecount") && requestRecount.mutate({
      sessionId,
      variantId: recountFor.variantId,
      reason,
    }));
  }
  async function onApproveClick() {
    if (approveDisabled) return;
    if (approveMode === "first") {
      if (
        !(await confirm({
          variant: "warning",
          title: "تأكيد التوقيع الأول",
          description: `سيُسجَّل توقيعك الأول على جلسة الجرد ${s.code} ويُرسَل للتوقيع الثاني من مسؤول آخر. لن يُنفَّذ أي تسوية بعد — الاعتماد النهائي يلزم توقيعاً ثانياً من شخص مختلف.`,
          confirmText: "توقيع أول وإرسال",
        }))
      )
        return;
      (canOperation("stocktakes.firstSign") && firstSign.mutate({ sessionId }));
    } else setConfirmOpen(true);
  }

  function submitValuationRefresh() {
    const reason = valuationRefreshReason.trim();
    if (reason.length < 10) {
      notify.warn("اكتب سبباً موثقاً لا يقل عن 10 أحرف");
      return;
    }
    (canOperation("stocktakes.refreshOpeningValuationBasis") && refreshOpeningValuation.mutate({
      sessionId,
      expectedDigest: valuationIntegrity.digest,
      reason,
    }));
  }

  /** تصدير صفوف الفروقات إلى Excel (المعروضة بعد الفلتر/البحث) — للمدير+ فقط. */
  function onExport() {
    const exportable = filtered.filter(
      (r: Row) => r.diff != null && r.diff !== 0,
    );
    if (exportable.length === 0) {
      notify.warn("لا فروقات للتصدير ضمن الفلتر الحالي.");
      return;
    }
    exportRows(exportable, {
      filename: `فروقات الجرد ${s.code}`,
      columns: [
        { key: "productName", header: "المنتج" },
        {
          key: "variantName",
          header: "المتغيّر",
          map: (r) => r.variantName ?? "",
        },
        { key: "sku", header: "SKU" },
        { key: "baseUnit", header: "الوحدة", map: (r) => r.baseUnit ?? "" },
        {
          key: "unitCost",
          header: "تكلفة وحدة الأساس",
          map: (r) => Number(r.unitCost),
        },
        { key: "bookNow", header: "الدفتري", map: (r) => r.bookNow },
        {
          key: "adjustedCount",
          header: "المعدود المصحَّح",
          map: (r) => r.adjustedCount ?? "",
        },
        { key: "diff", header: "الفرق", map: (r) => r.diff ?? "" },
        {
          key: "value",
          header: "قيمة الفرق",
          map: (r) => (r.value == null ? "" : Number(r.value)),
        },
        {
          key: "pct",
          header: "النسبة ٪",
          map: (r) => (r.pct == null ? "" : Number(r.pct.toFixed(2))),
        },
        {
          key: "status",
          header: "ضمن الحدّ / يتجاوز",
          map: (r) =>
            r.overThreshold
              ? "يتجاوز الحدّ"
              : r.withinThreshold
                ? "ضمن الحدّ"
                : "—",
        },
        {
          key: "decision",
          header: "القرار",
          map: (r) =>
            r.decision
              ? r.decision.action === "ADJUST"
                ? "تسوية بالمعدود"
                : "إبقاء الدفتري"
              : !r.overThreshold && effectiveDirectUnderThreshold
                ? "تسوية تلقائية"
                : "بلا قرار",
        },
        {
          key: "reason",
          header: "السبب",
          map: (r) => STOCKTAKE_REASON_LABEL[effReason(r)] ?? effReason(r),
        },
      ],
    });
  }

  const conflictRow =
    conflictFor != null
      ? rows.find((r: Row) => r.variantId === conflictFor)
      : undefined;

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            مراجعة وتدقيق الجرد
            <StatusBadge status={s.status} />
          </span>
        }
        description={
          <>
            {s.name} ·{" "}
            <span className="font-mono" dir="ltr">
              {s.code}
            </span>{" "}
            · {s.branchName}
            {s.submittedAt && <> · سلّم العدّ {dt(s.submittedAt)}</>} · الحدّ
            المعتمد: {pctStr(s.thresholdPct)}٪ أو {money(s.thresholdValue)}
          </>
        }
        breadcrumbs={[{ label: "جلسات الجرد", href: "/stocktakes" }, { label: `${s.name} — المراجعة` }]}
        actions={<>
          <Link href={`/stocktakes/${sessionId}`}>
            <Button variant="outline" size="sm">
              تفاصيل العدّ والسجلّ
            </Button>
          </Link>
          <Link href={`/stocktakes/${sessionId}/sheets`}>
            <Button variant="outline" size="sm">
              <Printer aria-hidden className="size-4" /> قوائم العدّ الورقية
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={onExport}
            title="تصدير صفوف الفروقات إلى Excel"
          >
            <Download aria-hidden className="size-4" /> تصدير Excel
          </Button>
          {isApproved ? (
            <Link href={`/stocktakes/${sessionId}/report`}>
              <Button
                size="lg"
                className="bg-[var(--money-positive)] text-white hover:opacity-90"
              >
                المحضر والتقرير ←
              </Button>
            </Link>
          ) : (
            <Button
              size="lg"
              className="bg-[var(--money-positive)] text-white hover:opacity-90"
              disabled={approveDisabled}
              title={approveTitle}
              onClick={onApproveClick}
            >
              {firstSign.isPending || approve.isPending
                ? "جارٍ التنفيذ…"
                : approveLabel}
            </Button>
          )}
        </>}
      />

      {/* لافتات الحالة والحواجز */}
      {s.sessionType === "OPENING" && (
        <div className="rounded-lg border border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)] px-4 py-2.5 text-sm text-[var(--sem-warn)]">
          <span className="font-bold">جرد افتتاحي — تأسيس الأرصدة:</span> يُعتمد
          العدّ كرصيد افتتاحي
          <b> بلا أي قيد عجز/زيادة على الأرباح</b>، وكل منتج معدود يُختم
          «مُفتتَحاً» فيُقفل عليه البيع بالسالب فوراً. توقيعان إلزاميان دائماً
          (الموقّع الأول ≠ المعتمد، ومنشئ الجلسة أو من كُلّف بالعدّ لا يعتمد).{" "}
          <b>
            القيمة المعروضة تقييم مخزون بالتكلفة وليست نقداً أو ربحاً أو رصيد
            صندوق.
          </b>
        </div>
      )}
      {isOpening && valuationIntegrity.mismatchCount > 0 && (
        <Card className="gap-0 overflow-hidden border-money-negative/50 py-0">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-money-negative/40 bg-money-negative/10 px-4 py-3 text-money-negative">
            <div>
              <p className="flex items-center gap-1.5 font-bold">
                <AlertTriangle aria-hidden className="size-4" /> حارس تضخم تقييم
                المخزون
              </p>
              <p className="mt-1 text-xs">
                {nf(valuationIntegrity.mismatchCount)} صف تقييم يحتاج مراجعة
                مقارنةً بتكلفة وحدة الأساس الحالية، منها{" "}
                <b>{nf(valuationIntegrity.blockingCount)} اختلاف مادي حاجب</b>.
                التقييم المسجل{" "}
                <span dir="ltr" className="font-bold tabular-nums">
                  {money(valuationIntegrity.snapshotNetValue)}
                </span>{" "}
                مقابل إعادة الحساب الحالية{" "}
                <span dir="ltr" className="font-bold tabular-nums">
                  {money(valuationIntegrity.currentBaseNetValue)}
                </span>
                .
              </p>
            </div>
            {role === "admin" && isOperational && (
              <Button
                variant="destructive"
                size="sm"
                disabled={
                  refreshOpeningValuation.isPending || hasMissingBaseCost
                }
                title={
                  hasMissingBaseCost
                    ? "صحح تكاليف الأساس الصفرية في الكتالوج أولاً"
                    : undefined
                }
                onClick={() => setValuationRefreshOpen(true)}
              >
                <RefreshCw aria-hidden className="size-4" /> معاينة وتنفيذ إنقاذ
                أساس التكلفة
              </Button>
            )}
          </div>
          {/* أوّل ١٢ صفّاً وحدها: البطاقة تحذيرٌ لا تقرير — والتقرير الكامل في التصدير. */}
          <DataTable<ValuationIntegrityRow>
            {...INTEGRITY_TABLE}
            data={valuationIntegrity.rows.slice(0, 12)}
            columns={valuationIntegrityColumns}
            emptyText="لا صفوف تقييم تحتاج مراجعة."
          />
          {hasMissingBaseCost && (
            <p className="border-t border-money-negative/40 bg-money-negative/10 px-4 py-2 text-xs font-semibold text-money-negative">
              الإنقاذ معطّل: توجد تكلفة أساس صفرية. صحح الكتالوج أولاً؛ لن يحوّل
              النظام قيمة مخزون حقيقية إلى صفر.
            </p>
          )}
        </Card>
      )}
      {countIntegrity.blockingCount > 0 && (
        <Card className="gap-0 overflow-hidden border-money-negative/50 py-0">
          <div className="border-b border-money-negative/40 bg-money-negative/10 px-4 py-3 text-money-negative">
            <p className="flex items-center gap-1.5 font-bold">
              <AlertTriangle aria-hidden className="size-4" /> حارس سلامة كميات
              الجرد
            </p>
            <p className="mt-1 text-xs">
              حُجب الاعتماد لأن {nf(countIntegrity.blockingCount)} كمية تطابق
              حرفياً بصمة قارئ باركود أُدخل داخل حقل العدد. يجب إعادة عدها
              مستقلاً أو اعتماد العدّ التحققي الصحيح؛ لا تُصحّح تلقائياً.
            </p>
          </div>
          <DataTable<CountIntegrityRow>
            {...INTEGRITY_TABLE}
            data={countIntegrity.rows}
            columns={countIntegrityColumns}
            emptyText="لا كميات مشبوهة."
          />
        </Card>
      )}
      {s.status === "COUNTING" && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] px-4 py-2.5 text-sm text-[var(--sem-info)]">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-bold">المراجعة الحية فعّالة:</span> يمكنك فحص
            المنتجات المعدودة واتخاذ القرار واعتمادها مرحلياً الآن، بينما يستمر
            العمال في عدّ البقية. تنفيذ التسويات والإقفال المالي يبقيان عند
            الاعتماد النهائي بعد اكتمال العدّ.{" "}
            <Link
              href={`/stocktakes/${sessionId}/remaining`}
              className="font-bold underline"
            >
              عرض المنتجات المتبقية ←
            </Link>
          </span>
        </div>
      )}
      {s.status === "CANCELLED" && (
        <div className="rounded-lg border border-money-negative/40 bg-money-negative/10 px-4 py-2.5 text-sm text-money-negative">
          أُلغيت هذه الجلسة — العدّات موثّقة للاطلاع فقط ولا تسوية عليها.
        </div>
      )}
      {isApproved && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-money-positive/40 bg-money-positive/10 px-4 py-2.5 text-sm text-money-positive">
          <Check aria-hidden className="size-4" />
          <span className="font-bold">معتمدة ومُسوّاة</span>
          {s.approved && (
            <>
              {" "}
              — اعتمدها {s.approved.byName} · {dt(s.approved.at)}
            </>
          )}
          {s.firstSign && (
            <>
              {" "}
              (التوقيع الأول: {s.firstSign.byName} · {dt(s.firstSign.at)})
            </>
          )}{" "}
          · الجلسة مقفلة نهائياً.{" "}
          <Link
            href={`/stocktakes/${sessionId}/report`}
            className="font-bold underline"
          >
            المحضر والتقرير ←
          </Link>
        </div>
      )}
      {isOperational && <StocktakeOverlapNotice barriers={barriers} />}
      {isOperational &&
        (barriers.openConflicts > 0 ||
          barriers.pendingRecounts > 0 ||
          barriers.undecidedOverThreshold > 0) && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-4 py-2.5 text-sm text-[var(--sem-warn)]">
            <span className="font-bold">قبل الاعتماد:</span>
            {barriers.openConflicts > 0 && (
              <span className="inline-flex items-center gap-1">
                <AlertTriangle aria-hidden className="size-3.5" />{" "}
                {nf(barriers.openConflicts)} تعارض بين عدَّين يحتاج فصلاً
              </span>
            )}
            {barriers.pendingRecounts > 0 && (
              <span className="inline-flex items-center gap-1">
                <RefreshCw aria-hidden className="size-3.5" />{" "}
                {nf(barriers.pendingRecounts)} منتج بانتظار إعادة العدّ
              </span>
            )}
            {barriers.undecidedOverThreshold > 0 && (
              <span className="inline-flex items-center gap-1">
                <Scale aria-hidden className="size-3.5" />{" "}
                {nf(barriers.undecidedOverThreshold)} فرق يتجاوز الحدّ يحتاج
                قرارك (تسوية / إبقاء / إعادة عدّ)
              </span>
            )}
            <button
              type="button"
              className="me-auto font-bold underline"
              onClick={() =>
                setFilter(
                  barriers.openConflicts > 0
                    ? "conflict"
                    : barriers.pendingRecounts > 0
                      ? "recount"
                      : "over",
                )
              }
            >
              أظهرها ←
            </button>
          </div>
        )}
      {barriers.requiresDualSign && !isApproved && (
        <div className="flex flex-wrap items-start gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm text-violet-800">
          <Pen aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-bold">اعتماد مزدوج (توقيعان):</span>{" "}
            {isOpening ? (
              <>
                الجرد الافتتاحي يؤسس الأرصدة، لذلك يتطلب مسؤولَين مختلفَين
                دائماً.
              </>
            ) : (
              <>
                {nf(dualItems.length)} فرق تتجاوز قيمته{" "}
                <span className="tabular-nums" dir="ltr">
                  {money(s.dualThreshold)}
                </span>
                .
              </>
            )}
            {s.firstSign && (
              <span className="me-2 inline-flex items-center gap-1 font-bold">
                التوقيع الأول: {s.firstSign.byName} · {dt(s.firstSign.at)}
                <Check aria-hidden className="size-3.5" />— بانتظار التوقيع
                الثاني من مسؤول آخر.
              </span>
            )}
          </span>
        </div>
      )}
      {barriers.notCounted > 0 && !isApproved && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] px-4 py-2.5 text-sm text-[var(--sem-neg)]">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {nf(barriers.notCounted)} منتج لم يُعَدّ — الاعتماد النهائي محجوب
            حتى يكتمل نطاق الجرد.
          </span>
        </div>
      )}

      {/* مؤشرات الملخّص */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-7">
        <Stat
          label="منتجات معدودة"
          value={`${nf(totals.counted)} / ${nf(totals.total)}`}
        />
        <Stat
          label="معتمدة مرحلياً"
          value={nf(barriers.reviewApproved)}
          sub={`بانتظار المراجعة ${nf(barriers.countedPendingReview)}`}
          tone="emerald"
        />
        <Stat
          label={isOpening ? "بلا تغيير عن السابق" : "مطابقة تماماً"}
          value={nf(totals.matched)}
          tone="emerald"
        />
        <Stat
          label={isOpening ? "تغيير افتتاحي موجب" : "زيادة"}
          value={nf(totals.over)}
          sub={`+${money(totals.overValue)}`}
          tone="blue"
        />
        <Stat
          label={isOpening ? "تغيير افتتاحي سالب" : "نقص (عجز)"}
          value={nf(totals.short)}
          sub={money(totals.shortValue)}
          tone="rose"
        />
        <Stat
          label={isOpening ? "شذوذات تقييم حاجبة" : "تتجاوز الحدّ"}
          value={nf(
            isOpening ? barriers.valuationBlockingAnomalies : totals.overThr,
          )}
          sub={isOpening ? "تكلفة / وحدة" : "تستوجب قراراً"}
          tone="amber"
        />
        <Stat
          label={
            isOpening ? "قيمة التغيير الافتتاحي بالتكلفة" : "صافي قيمة الفرق"
          }
          value={money(totals.netValue)}
          tone={D(totals.netValue).isNegative() ? "rose" : "emerald"}
        />
      </div>

      <ReviewBarriers {...{ barriers, s, isOpening }} />

      {/* أدوات الجدول + الجدول */}
      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-3 border-b p-3">
          <div className="flex flex-wrap rounded-lg border bg-muted p-0.5">
            {FILTERS.map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  filter === k
                    ? "bg-card shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          {isOperational && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                disabled={!canOperation("stocktakes.approveItems") || (shownReady.length === 0 || approveItems.isPending)}
                onClick={selectShownReady}
              >
                تحديد الجاهز المعروض ({nf(Math.min(shownReady.length, 500))})
              </Button>
              <Button
                size="sm"
                className="bg-[var(--stock-ok)] text-white hover:opacity-90"
                disabled={!canOperation("stocktakes.approveItems") || (selectedReady.length === 0 || approveItems.isPending)}
                onClick={() => void approveSelectedItems()}
              >
                {approveItems.isPending
                  ? ACTION_LABELS.approving
                  : `اعتماد المحدد مرحلياً (${nf(selectedReady.length)})`}
              </Button>
            </div>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold">
            <Switch checked={autoAdjust} onCheckedChange={setAutoAdjust} />
            التصحيح الآلي للحركات اللاحقة للعدّ
            <span className="hidden font-normal text-muted-foreground lg:inline">
              (بيع/شراء وقع بعد عدّ المنتج يُحتسب تلقائياً — يمنع الفروقات
              الزائفة)
            </span>
          </label>
          <UnifiedSearchInput barcode={false} debounceMs={0} value={q} onChange={(v) => { setQ(v); setVisible(PAGE); }} placeholder="بحث: اسم / SKU…" className="w-44" inputClassName="h-8 text-xs" />
          <span className="me-auto text-xs text-muted-foreground">
            {nf(filtered.length)} منتجاً{review.isFetching ? " · يُحدَّث…" : ""}
          </span>
        </div>

        {/* شبكةُ قرارٍ لا عرض: كل صفٍّ يحمل مربّع اعتمادٍ ومنتقي سببٍ وأزرار تسوية/إبقاء
            خاصّة به — `DataTable` أداةُ عرضٍ فتبقى هذه خامّةً عن قصد. */}
        <ScrollTableShell bordered={false}>
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-muted/60">
              <tr className="text-end text-xs text-muted-foreground">
                <th className="w-10 p-2.5 text-center font-semibold">تحديد</th>
                <th className="p-2.5 font-semibold">المنتج</th>
                <th className="p-2.5 font-semibold">عدّه</th>
                <th
                  className="p-2.5 text-center font-semibold"
                  title="لقطة الرصيد الدفتري لحظة إنشاء الجلسة"
                >
                  الدفتري المتوقع
                </th>
                <th className="p-2.5 text-center font-semibold">
                  المعدود الخام
                </th>
                <th
                  className="p-2.5 text-center font-semibold"
                  title="صافي حركات المخزون بعد وقت عدّ المنتج"
                >
                  حركات لاحقة
                </th>
                <th className="p-2.5 text-center font-semibold">
                  المعدود المصحَّح
                </th>
                <th className="p-2.5 text-center font-semibold">
                  رصيد الدفتر الآن
                </th>
                <th className="p-2.5 text-center font-semibold">الفرق ±</th>
                <th className="p-2.5 text-center font-semibold">قيمة الفرق</th>
                <th className="p-2.5 text-center font-semibold">الحالة</th>
                <th className="p-2.5 text-center font-semibold">القرار</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r: Row) => <ReviewItemRow key={r.variantId} r={r} autoAdjust={autoAdjust}
                rowSettlesNegative={rowSettlesNegative} effReason={effReason}
                actions={{s, isOperational, canOperation, selectedForApproval, toggleApprovalSelection, setReopenFor, setReopenReason, setConflictFor, decide, onDecide, openRecount, onReasonChange}} />)}
              {shown.length === 0 && <tr><td colSpan={12} className="p-8 text-center text-sm text-muted-foreground">لا منتجات مطابقة لهذا الفلتر.</td></tr>}
            </tbody>
          </table>
        </ScrollTableShell>
        {filtered.length > shown.length && (
          <div className="border-t p-3 text-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVisible((v) => v + PAGE)}
            >
              عرض {nf(Math.min(PAGE, filtered.length - shown.length))} منتجاً
              إضافياً (المعروض {nf(shown.length)} من {nf(filtered.length)})
            </Button>
          </div>
        )}
      </Card>

      <ReviewDecisionDialogs {...{ conflictRow, setConflictFor, canOperation, resolveConflict, isOperational, sessionId, openRecount, reopenFor, setReopenFor, reopenReason, setReopenReason, submitReopen, reopenItemReview, recountFor, setRecountFor, recountReason, setRecountReason, submitRecount, requestRecount }} />
      <ReviewApprovalDialogs {...{ valuationRefreshOpen, setValuationRefreshOpen, valuationIntegrity, valuationRefreshReason, setValuationRefreshReason, refreshOpeningValuation, submitValuationRefresh, canOperation, confirmOpen, setConfirmOpen, isOpening, s, autoCount, adjustExplicit, keepCount, totals, hasShort, hasOver, ledgerPreview, noReasonCount, negativeSettleCount, barriers, approve, sessionId }} actorName={me.data?.name} />
    </div>
  );
}
