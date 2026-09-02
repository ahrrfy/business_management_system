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
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { D, fmt, fmtInt } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { STOCKTAKE_REASON_LABEL } from "@/lib/printing/stocktakeTemplates";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  Printer,
  Download,
  Lock,
  AlertTriangle,
  RefreshCw,
  Scale,
  Pen,
  Info,
  Check,
  X,
  CheckCheck,
  Undo2,
} from "lucide-react";

/* ───────── ثوابت العرض ───────── */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  COUNTING: {
    label: "قيد العدّ",
    cls: "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30",
  },
  REVIEW: {
    label: "قيد المراجعة",
    cls: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border-[var(--sem-warn)]/40",
  },
  APPROVED: {
    label: "معتمدة ومُسوّاة",
    cls: "bg-money-positive/10 text-money-positive border-money-positive/40",
  },
  CANCELLED: {
    label: "ملغاة",
    cls: "bg-money-negative/10 text-money-negative border-money-negative/40",
  },
};
const MTYPE: Record<string, string> = {
  IN: "وارد",
  OUT: "صادر",
  RETURN: "مرتجع",
  ADJUST: "تسوية",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
};
type Reason =
  | "UNSPECIFIED"
  | "DAMAGE"
  | "LOSS_THEFT"
  | "ENTRY_ERROR"
  | "PRINT_WASTE";
/** أسباب الفروقات الخمسة المعتمدة — تغذي تقرير الانكماش والقيد المحاسبي. */
const REASONS: { v: Reason; label: string }[] = [
  { v: "UNSPECIFIED", label: "غير محدد" },
  { v: "DAMAGE", label: "تلف / كسر" },
  { v: "LOSS_THEFT", label: "فقدان / سرقة" },
  { v: "ENTRY_ERROR", label: "خطأ إدخال" },
  { v: "PRINT_WASTE", label: "هدر تشغيل مطبعة" },
];
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

/* ───────── أدوات تنسيق (أرقام لاتينية، أموال decimal.js حصراً) ───────── */
const nf = (n: number | null | undefined) => fmtInt(n ?? 0);
const signed = (n: number) =>
  (n > 0 ? "+" : n < 0 ? "−" : "") + fmtInt(Math.abs(n));
const money = (v: string | number | null | undefined) => {
  const d = D(v ?? 0);
  return (d.isNegative() ? "−" : "") + fmt(d.abs().toFixed(2)) + " د.ع";
};
const pctStr = (v: string | number | null | undefined) =>
  D(v ?? 0)
    .toNumber()
    .toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });
const dt = (v: string | number | Date | null | undefined) => fmtDateTime(v);

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? {
    label: status,
    cls: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${m.cls}`}
    >
      {m.label}
    </span>
  );
}
function Pill({
  tone,
  children,
  title,
}: {
  tone: "muted" | "blue" | "amber" | "green" | "emerald" | "rose" | "violet";
  children: ReactNode;
  title?: string;
}) {
  const tones: Record<string, string> = {
    muted: "bg-muted text-muted-foreground border-border",
    blue: "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30",
    amber:
      "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border-[var(--sem-warn)]/40",
    green: "bg-money-positive/10 text-money-positive border-money-positive/40",
    emerald:
      "bg-money-positive/10 text-money-positive border-money-positive/40",
    rose: "bg-money-negative/10 text-money-negative border-money-negative/40",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "blue" | "amber" | "emerald" | "rose";
}) {
  const tones: Record<string, string> = {
    blue: "text-[var(--sem-info)]",
    amber: "text-[var(--sem-warn)]",
    emerald: "text-money-positive",
    rose: "text-money-negative",
  };
  return (
    <Card className="p-4 gap-1">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p
        className={`text-xl font-bold tabular-nums ${tone ? tones[tone] : ""}`}
        dir="ltr"
      >
        {value}
      </p>
      {sub && (
        <p className="text-xs tabular-nums text-muted-foreground" dir="ltr">
          {sub}
        </p>
      )}
    </Card>
  );
}

const PAGE = 200; // سقف عرض تدريجي — جلسات الجرد الشامل قد تحوي آلاف المنتجات.

export default function StocktakeReview() {
  const params = useParams();
  const sessionId = Number(params.id);
  const idOk = Number.isFinite(sessionId) && sessionId > 0;
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const isManager = role === "admin" || role === "manager";

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
    { enabled: idOk && isManager },
  );

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
          `${nf(r.adjustedCount)} حركة تسوية — عجز ${money(r.shortExpense)} · زيادة ${money(r.overGain)}`,
        );
      await invalidate();
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
        جارٍ التحميل…
      </div>
    );
  if (me.data && !isManager)
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10 text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-full bg-muted text-muted-foreground">
          <Lock aria-hidden className="size-8" />
        </div>
        <p className="font-bold">مراجعة الجرد واعتماده صلاحية مشرف فأعلى</p>
        <p className="text-sm text-muted-foreground">
          قيم التكلفة وقرارات التسوية محجوبة عن دورك في الخادم. يمكنك متابعة
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
  if (!review.data)
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
  } = review.data;
  const isOpening = s.sessionType === "OPENING";
  const hasMissingBaseCost = valuationIntegrity.rows.some(
    (row) => row.reason === "ZERO_BASE_COST",
  );

  type ValuationIntegrityRow = (typeof valuationIntegrity.rows)[number];
  type CountIntegrityRow = (typeof countIntegrity.rows)[number];

  /* جدولا الحارسين مُضمَّنان في بطاقتَي تحذيرٍ تحملان عنوانيهما وعدَّهما. */
  const INTEGRITY_TABLE = { embedded: true, searchable: false, bounded: false, pageSize: Infinity } as const;

  /** اسم المنتج مع بديله ورمزه — نصٌّ واحد للنسخ وعرضٌ مركّب للقراءة. */
  const integrityNameCell = (row: { productName: string; variantName?: string | null; sku: string }) => (
    <>
      {row.productName}
      {row.variantName ? " — " + row.variantName : ""}
      <span className="ms-1 font-mono text-[10px] text-muted-foreground" dir="ltr">
        {row.sku}
      </span>
    </>
  );

  const valuationIntegrityColumns: ColumnDef<ValuationIntegrityRow, unknown>[] = [
    {
      id: "product",
      header: "المنتج",
      accessorFn: (r) => r.productName + (r.variantName ? " — " + r.variantName : "") + " · " + r.sku,
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
      accessorFn: (r) => r.productName + (r.variantName ? " — " + r.variantName : "") + " · " + r.sku,
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
    if (ok) approveItems.mutate({ sessionId, variantIds: ids });
  }

  function submitReopen() {
    if (!reopenFor) return;
    const reason = reopenReason.trim();
    if (reason.length < 3) {
      notify.warn("اكتب سبب إعادة الفتح (3 أحرف على الأقل)");
      return;
    }
    reopenItemReview.mutate({
      sessionId,
      variantId: reopenFor.variantId,
      reason,
    });
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
    !isReview ||
    !barriers.canApprove ||
    approveMode === "wait" ||
    approve.isPending ||
    firstSign.isPending;
  const approveTitle = !isReview
    ? isApproved
      ? "الجلسة معتمدة ومقفلة"
      : "الاعتماد متاح لجلسة قيد المراجعة فقط"
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
  const hasShort = D(ledgerPreview.shortExpense).gt(0);
  const hasOver = D(ledgerPreview.overGain).gt(0);

  /* ───── أفعال ───── */
  function onReasonChange(r: Row, value: Reason) {
    setReasonSel((prev) => ({ ...prev, [r.variantId]: value }));
    if (r.decision) {
      // تحديث سبب قرار قائم بإعادة استدعاء decide بنفس الفعل (upsert في الخادم).
      decide.mutate({
        sessionId,
        variantId: r.variantId,
        action: r.decision.action,
        reason: value,
      });
    } else if (
      r.diff != null &&
      r.diff !== 0 &&
      !r.overThreshold &&
      s.directUnderThreshold
    ) {
      // ضمن الحدّ: تثبيت التصنيف فوراً كقرار تسوية صريح — نفس أثر التسوية التلقائية مع حفظ السبب
      // (وإلا ضاع السبب وسُجِّل «غير محدد» في القرار التلقائي عند الاعتماد).
      decide.mutate({
        sessionId,
        variantId: r.variantId,
        action: "ADJUST",
        reason: value,
      });
    }
  }
  function onDecide(r: Row, action: "ADJUST" | "KEEP") {
    decide.mutate({
      sessionId,
      variantId: r.variantId,
      action,
      reason: effReason(r),
    });
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
    requestRecount.mutate({
      sessionId,
      variantId: recountFor.variantId,
      reason,
    });
  }
  async function onApproveClick() {
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
      firstSign.mutate({ sessionId });
    } else setConfirmOpen(true);
  }

  function submitValuationRefresh() {
    const reason = valuationRefreshReason.trim();
    if (reason.length < 10) {
      notify.warn("اكتب سبباً موثقاً لا يقل عن 10 أحرف");
      return;
    }
    refreshOpeningValuation.mutate({
      sessionId,
      expectedDigest: valuationIntegrity.digest,
      reason,
    });
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

      {/* لوحة حواجز الاعتماد */}
      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-4 py-3">
          <CardTitle className="text-sm">
            حواجز الاعتماد — يجب أن تخضرّ كلها قبل التنفيذ
          </CardTitle>
        </CardHeader>
        <div className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <p
            className={`inline-flex items-center gap-1.5 ${barriers.notCounted === 0 ? "text-[var(--sem-pos)]" : "text-[var(--sem-neg)]"}`}
          >
            {barriers.notCounted === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> كل منتجات النطاق
                معدودة
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" /> {nf(barriers.notCounted)}{" "}
                منتج غير معدود — يحجب الاعتماد
              </>
            )}
          </p>
          <p
            className={`inline-flex items-center gap-1.5 ${barriers.countedPendingReview === 0 ? "text-[var(--sem-pos)]" : "text-[var(--sem-neg)]"}`}
          >
            {barriers.countedPendingReview === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> كل المنتجات المعدودة
                معتمدة ببصمة صالحة
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" />{" "}
                {nf(barriers.countedPendingReview)} منتج يحتاج اعتماداً مرحلياً
                {barriers.staleReviewApprovals > 0
                  ? ` (${nf(barriers.staleReviewApprovals)} اعتماد قديم)`
                  : ""}
              </>
            )}
          </p>
          <p
            className={`inline-flex items-center gap-1.5 ${barriers.pendingRecounts === 0 ? "text-money-positive" : "text-money-negative"}`}
          >
            {barriers.pendingRecounts === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> لا إعادات عدّ معلّقة
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" />{" "}
                {nf(barriers.pendingRecounts)} منتج بانتظار إعادة العدّ
              </>
            )}
          </p>
          <p
            className={`inline-flex items-center gap-1.5 ${barriers.openConflicts === 0 ? "text-money-positive" : "text-money-negative"}`}
          >
            {barriers.openConflicts === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> لا تعارض بين عدَّين
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" />{" "}
                {nf(barriers.openConflicts)} تعارض مفتوح يحتاج فصلاً
              </>
            )}
          </p>
          <p
            className={`inline-flex items-center gap-1.5 ${barriers.undecidedOverThreshold === 0 ? "text-money-positive" : "text-money-negative"}`}
          >
            {barriers.undecidedOverThreshold === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> كل ما يتجاوز الحدّ له
                قرار
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" />{" "}
                {nf(barriers.undecidedOverThreshold)} فرق يتجاوز الحدّ بلا قرار
              </>
            )}
          </p>
          {s.requireRecountOverThreshold && (
            <p
              className={`inline-flex items-center gap-1.5 ${barriers.overThresholdNeedingRecount === 0 ? "text-money-positive" : "text-money-negative"}`}
            >
              {barriers.overThresholdNeedingRecount === 0 ? (
                <>
                  <Check aria-hidden className="size-3.5" /> كل ما يتجاوز الحدّ
                  أُعيد عدّه
                </>
              ) : (
                <>
                  <X aria-hidden className="size-3.5" />{" "}
                  {nf(barriers.overThresholdNeedingRecount)} فرق يتجاوز الحدّ يلزمه
                  إعادة عدّ فعلية
                </>
              )}
            </p>
          )}
          {isOpening && (
            <p
              className={`inline-flex items-center gap-1.5 ${
                barriers.valuationBlockingAnomalies === 0
                  ? "text-money-positive"
                  : "text-money-negative"
              }`}
            >
              {barriers.valuationBlockingAnomalies === 0 ? (
                <>
                  <Check aria-hidden className="size-3.5" /> لا تضخم مادي في
                  أساس التكلفة
                </>
              ) : (
                <>
                  <X aria-hidden className="size-3.5" />{" "}
                  {nf(barriers.valuationBlockingAnomalies)} تضخم تكلفة/وحدة يحجب
                  الاعتماد
                </>
              )}
            </p>
          )}
          <p
            className={`inline-flex items-center gap-1.5 ${
              barriers.countInputAnomalies === 0
                ? "text-money-positive"
                : "text-money-negative"
            }`}
          >
            {barriers.countInputAnomalies === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> لا توجد بصمة باركود
                داخل كميات العدّ
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" />{" "}
                {nf(barriers.countInputAnomalies)} كمية مشتبهة تحجب الاعتماد
              </>
            )}
          </p>
          {barriers.requiresDualSign && (
            <p
              className={`inline-flex items-center gap-1.5 sm:col-span-2 xl:col-span-4 ${barriers.firstSigned ? "text-violet-700" : "text-[var(--sem-warn)]"}`}
            >
              <Pen aria-hidden className="size-3.5" />
              <span>
                {isOpening
                  ? "توقيع مزدوج إلزامي لتأسيس الأرصدة"
                  : `توقيع مزدوج مطلوب (فروقات فوق ${money(s.dualThreshold)})`}{" "}
                —{" "}
                {barriers.firstSigned ? (
                  <>
                    التوقيع الأول
                    <Check
                      aria-hidden
                      className="mx-1 inline size-3.5 align-text-bottom"
                    />
                    {s.firstSign
                      ? `(${s.firstSign.byName} · ${dt(s.firstSign.at)})`
                      : ""}{" "}
                    — الاعتماد النهائي من مسؤول آخر
                  </>
                ) : (
                  "لم يوقَّع التوقيع الأول بعد"
                )}
              </span>
            </p>
          )}
        </div>
      </Card>

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
                disabled={shownReady.length === 0 || approveItems.isPending}
                onClick={selectShownReady}
              >
                تحديد الجاهز المعروض ({nf(Math.min(shownReady.length, 500))})
              </Button>
              <Button
                size="sm"
                className="bg-[var(--stock-ok)] text-white hover:opacity-90"
                disabled={selectedReady.length === 0 || approveItems.isPending}
                onClick={() => void approveSelectedItems()}
              >
                {approveItems.isPending
                  ? "جارٍ الاعتماد…"
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
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setVisible(PAGE);
            }}
            placeholder="بحث: اسم / SKU…"
            className="h-8 w-44 rounded-md border bg-card px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
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
              {shown.map((r: Row) => {
                const conflictOpen =
                  r.conflict != null && r.conflict.resolvedPick == null;
                const recPending = r.recount?.status === "PENDING";
                const recDone = r.recount?.status === "DONE";
                const uncounted = r.rawCount == null;
                const movesTitle = r.movesAfter
                  .map(
                    (m: {
                      type: string;
                      qty: number;
                      ref: string | null;
                      at: string | Date;
                    }) =>
                      `${MTYPE[m.type] ?? m.type} ${signed(m.qty)}${m.ref ? ` (${m.ref})` : ""} — ${dt(m.at)}`,
                  )
                  .join("\n");
                const reason = effReason(r);
                return (
                  <tr
                    key={r.variantId}
                    className={`border-t align-top ${
                      r.overThreshold && !r.decision && !recPending
                        ? "bg-[var(--sem-neg-bg)]/60"
                        : r.diff != null && r.diff !== 0
                          ? "bg-[var(--sem-warn-bg)]/40"
                          : ""
                    }`}
                  >
                    <td className="p-2.5 text-center">
                      {r.reviewApproved?.isCurrent ? (
                        <CheckCheck
                          aria-label="معتمد مرحلياً"
                          className="mx-auto size-4 text-[var(--stock-ok)]"
                        />
                      ) : r.readyForReviewApproval && isOperational ? (
                        <input
                          type="checkbox"
                          checked={selectedForApproval.has(r.variantId)}
                          onChange={(e) =>
                            toggleApprovalSelection(
                              r.variantId,
                              e.target.checked,
                            )
                          }
                          className="size-4 accent-[var(--stock-ok)]"
                          aria-label={`تحديد ${r.productName} للاعتماد المرحلي`}
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    {/* المنتج */}
                    <td className="p-2.5">
                      <p className="font-bold">
                        {r.productName}{" "}
                        {r.variantName && (
                          <span className="font-normal text-muted-foreground">
                            {r.variantName}
                          </span>
                        )}
                      </p>
                      <p
                        className="font-mono text-[11px] text-muted-foreground"
                        dir="ltr"
                      >
                        {r.sku}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        الوحدة: {r.baseUnit}
                        {r.zone ? ` · المنطقة: ${r.zone}` : ""}
                        {r.assignmentName ? ` · ${r.assignmentName}` : ""}
                      </p>
                      {recDone && r.recount && (
                        <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700">
                          <Undo2 aria-hidden className="size-3" />
                          <span>
                            أُعيد عدّه وتأكدت الكمية{" "}
                            <span className="tabular-nums" dir="ltr">
                              {r.recount.qty2 != null
                                ? nf(r.recount.qty2)
                                : "—"}
                            </span>{" "}
                            (طلبها {r.recount.requestedByName} —{" "}
                            {r.recount.reason})
                          </span>
                        </p>
                      )}
                      {recPending && r.recount && (
                        <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700">
                          <RefreshCw aria-hidden className="size-3" />
                          إعادة عدّ معلّقة (طلبها {
                            r.recount.requestedByName
                          } — {r.recount.reason})
                        </p>
                      )}
                      {r.verify && r.verify.match && !conflictOpen && (
                        <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--sem-pos)]">
                          <CheckCheck aria-hidden className="size-3" />
                          عدّ تحقّقي مطابق من {r.verify.byName}
                        </p>
                      )}
                      {conflictOpen && r.conflict && (
                        <p className="mt-1 inline-flex items-center gap-1 rounded-md bg-[var(--sem-neg-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-neg)]">
                          <AlertTriangle aria-hidden className="size-3" />
                          تعارض: {r.conflict.by1} عدّ{" "}
                          <span dir="ltr">{nf(r.conflict.qty1)}</span> —{" "}
                          {r.conflict.by2} عدّ{" "}
                          <span dir="ltr">{nf(r.conflict.qty2)}</span>
                        </p>
                      )}
                      {r.conflict?.resolvedPick && (
                        <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700">
                          <Scale aria-hidden className="size-3" />
                          فُصل في تعارض العدَّين: اعتُمد عدّ{" "}
                          {r.conflict.resolvedPick === "FIRST"
                            ? r.conflict.by1
                            : r.conflict.by2}
                        </p>
                      )}
                    </td>
                    {/* عدّه */}
                    <td className="p-2.5 text-xs text-muted-foreground">
                      {r.countedByName ? (
                        <>
                          {r.countedByName}
                          <br />
                          {dt(r.countedAt)}
                          {r.kindUsed === "RECOUNT" && (
                            <p className="mt-0.5">
                              <Pill tone="violet">إعادة عدّ</Pill>
                            </p>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    {/* الدفتري المتوقع */}
                    <td
                      className="p-2.5 text-center font-mono tabular-nums"
                      dir="ltr"
                    >
                      {nf(r.expectedQty)}
                    </td>
                    {/* المعدود الخام */}
                    <td
                      className="p-2.5 text-center font-mono tabular-nums"
                      dir="ltr"
                    >
                      {r.rawCount == null ? "—" : nf(r.rawCount)}
                    </td>
                    {/* الحركات اللاحقة */}
                    <td className="p-2.5 text-center">
                      {r.netAfter === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <span
                          className="inline-flex cursor-help items-center rounded-md bg-[var(--sem-info-bg)] px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-[var(--sem-info)]"
                          dir="ltr"
                          title={movesTitle}
                        >
                          {signed(r.netAfter)}
                        </span>
                      )}
                      {r.netAfter !== 0 && (
                        <p
                          className={`mt-0.5 text-[10px] ${autoAdjust ? "text-[var(--sem-info)]" : "font-bold text-money-negative"}`}
                        >
                          {autoAdjust ? "مُصحَّحة آلياً" : "غير محتسبة!"}
                        </p>
                      )}
                    </td>
                    {/* المعدود المصحَّح */}
                    <td
                      className="p-2.5 text-center font-mono font-bold tabular-nums"
                      dir="ltr"
                    >
                      {r.adjustedCount == null ? (
                        "—"
                      ) : (
                        <span
                          title={
                            r.netAfter !== 0 && autoAdjust && r.rawCount != null
                              ? `العدّ الخام ${nf(r.rawCount)} ${signed(r.netAfter)} حركات لاحقة`
                              : ""
                          }
                        >
                          {nf(r.adjustedCount)}
                          {r.netAfter !== 0 && autoAdjust && (
                            <span className="text-[10px] text-[var(--sem-info)]">
                              *
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    {/* رصيد الدفتر الآن */}
                    <td
                      className="p-2.5 text-center font-mono tabular-nums"
                      dir="ltr"
                    >
                      {nf(r.bookNow)}
                    </td>
                    {/* الفرق */}
                    <td
                      className={`p-2.5 text-center font-mono font-bold tabular-nums ${
                        r.diff != null && r.diff > 0
                          ? "text-[var(--sem-info)]"
                          : r.diff != null && r.diff < 0
                            ? "text-[var(--sem-neg)]"
                            : "text-[var(--sem-pos)]"
                      }`}
                      dir="ltr"
                    >
                      {r.diff == null ? "—" : signed(r.diff)}
                      {r.pct != null && r.diff != null && r.diff !== 0 && (
                        <p className="text-[10px] font-normal text-muted-foreground">
                          ({r.pct.toFixed(1)}٪)
                        </p>
                      )}
                    </td>
                    {/* قيمة الفرق */}
                    <td
                      className={`p-2.5 text-center font-mono tabular-nums ${
                        r.value != null && D(r.value).isNegative()
                          ? "text-[var(--sem-neg)]"
                          : r.value != null && D(r.value).gt(0)
                            ? "text-[var(--sem-info)]"
                            : "text-muted-foreground"
                      }`}
                      dir="ltr"
                    >
                      {r.value == null || r.diff === 0 ? "—" : money(r.value)}
                    </td>
                    {/* الحالة */}
                    <td className="p-2.5 text-center">
                      <div className="flex flex-col items-center gap-1">
                        {uncounted ? (
                          <Pill tone="muted">لم يُعَدّ</Pill>
                        ) : conflictOpen ? (
                          <Pill tone="rose">
                            <AlertTriangle aria-hidden className="size-3" />{" "}
                            تعارض عدَّين
                          </Pill>
                        ) : recPending ? (
                          <Pill tone="violet">
                            <RefreshCw aria-hidden className="size-3" /> إعادة
                            عدّ معلّقة
                          </Pill>
                        ) : r.diff === 0 ? (
                          <Pill tone="emerald">مطابق</Pill>
                        ) : r.overThreshold ? (
                          <Pill tone="amber">يتجاوز الحدّ</Pill>
                        ) : (
                          <Pill tone="green">ضمن الحدّ</Pill>
                        )}
                        {r.reviewApproved?.isCurrent ? (
                          <Pill
                            tone="emerald"
                            title={`اعتمده ${r.reviewApproved.byName} · ${dt(r.reviewApproved.at)} · الكمية المثبّتة ${nf(r.reviewApproved.snapshotQty)}`}
                          >
                            <CheckCheck aria-hidden className="size-3" /> معتمد
                            ببصمة مثبتة
                          </Pill>
                        ) : r.reviewApproved ? (
                          <Pill
                            tone="amber"
                            title="اعتماد سابق بلا بصمة مطابقة — حدده ثم أعد تثبيت الاعتماد"
                          >
                            <AlertTriangle aria-hidden className="size-3" />{" "}
                            يحتاج إعادة تثبيت
                          </Pill>
                        ) : null}
                        {r.reviewApproved && isOperational && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px] text-[var(--sem-neg)]"
                            onClick={() => {
                              setReopenFor({
                                variantId: r.variantId,
                                label: r.variantName
                                  ? `${r.productName} — ${r.variantName}`
                                  : r.productName,
                              });
                              setReopenReason("");
                            }}
                          >
                            إلغاء الاعتماد
                          </Button>
                        )}
                        {r.requiresDualSign && (
                          <Pill
                            tone="violet"
                            title={`قيمة الفرق تتجاوز حدّ التوقيعين ${money(s.dualThreshold)}`}
                          >
                            <Pen aria-hidden className="size-3" /> توقيعان
                          </Pill>
                        )}
                        {recDone && !conflictOpen && (
                          <Pill tone="violet">
                            <Undo2 aria-hidden className="size-3" /> إعادة عدّ
                            منجزة
                          </Pill>
                        )}
                        {r.verify && r.verify.match && !conflictOpen && (
                          <Pill tone="emerald">
                            <CheckCheck aria-hidden className="size-3" /> تحقّقي
                            مطابق
                          </Pill>
                        )}
                      </div>
                    </td>
                    {/* القرار */}
                    <td className="p-2.5 text-center">
                      {conflictOpen ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-[var(--sem-neg)]"
                          disabled={!isOperational || !!r.reviewApproved}
                          onClick={() => setConflictFor(r.variantId)}
                        >
                          <Scale aria-hidden className="size-4" /> الفصل في
                          التعارض
                        </Button>
                      ) : uncounted || recPending ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : r.diff === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-col items-center gap-1">
                          {r.decision ? (
                            <>
                              <Pill
                                tone={
                                  r.decision.action === "ADJUST"
                                    ? "emerald"
                                    : "muted"
                                }
                              >
                                {r.decision.action === "ADJUST"
                                  ? "تسوية بالمعدود"
                                  : "إبقاء الدفتري"}
                              </Pill>
                              <p className="text-[10px] text-muted-foreground">
                                {r.decision.autoApplied ||
                                !r.decision.decidedByName
                                  ? "تلقائي (ضمن الحدّ)"
                                  : `بقرار ${r.decision.decidedByName}`}
                              </p>
                              {isOperational && !r.reviewApproved && (
                                <div className="flex flex-wrap justify-center gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-[11px]"
                                    disabled={decide.isPending}
                                    title="تبديل القرار"
                                    onClick={() =>
                                      onDecide(
                                        r,
                                        r.decision!.action === "ADJUST"
                                          ? "KEEP"
                                          : "ADJUST",
                                      )
                                    }
                                  >
                                    {r.decision.action === "ADJUST"
                                      ? "حوّل لإبقاء"
                                      : "حوّل لتسوية"}
                                  </Button>
                                  {/* حوكمة م٥: صفٌّ فوق الحدّ لم يُعَد عدّه بعدُ يبقى حاجزاً حتى لو
                                      اتُّخذ قراره ⇒ نُبقي زرّ إعادة العدّ ظاهراً كي لا تُقفَل الجلسة
                                      (Codex P1: كان الزرّ يختفي على الصفّ المقرَّر فيتعذّر رفع الحاجز). */}
                                  {s.requireRecountOverThreshold &&
                                    r.overThreshold &&
                                    r.kindUsed !== "RECOUNT" && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 px-2 text-[11px] text-violet-700"
                                        title="طلب إعادة عدّ (سبب إلزامي) — إلزاميّ فوق الحدّ"
                                        onClick={() => openRecount(r)}
                                      >
                                        <RefreshCw aria-hidden className="size-3" />{" "}
                                        إعادة عدّ
                                      </Button>
                                    )}
                                </div>
                              )}
                            </>
                          ) : !r.overThreshold && s.directUnderThreshold ? (
                            <>
                              <span className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--sem-pos)]">
                                تسوية تلقائية{" "}
                                <Check aria-hidden className="size-3" />
                              </span>
                              {isOperational && !r.reviewApproved && (
                                <div className="flex flex-wrap justify-center gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-[11px]"
                                    disabled={decide.isPending}
                                    title="تجاهل العدّ وإبقاء الرصيد الدفتري"
                                    onClick={() => onDecide(r, "KEEP")}
                                  >
                                    إبقاء بدلاً
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-[11px] text-violet-700"
                                    title="طلب إعادة عدّ (سبب إلزامي)"
                                    onClick={() => openRecount(r)}
                                  >
                                    <RefreshCw aria-hidden className="size-3" />{" "}
                                    إعادة عدّ
                                  </Button>
                                </div>
                              )}
                            </>
                          ) : isOperational && !r.reviewApproved ? (
                            <div className="flex flex-wrap justify-center gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={decide.isPending}
                                title="اعتماد الكمية المعدودة وتسوية الفرق"
                                onClick={() => onDecide(r, "ADJUST")}
                              >
                                تسوية
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={decide.isPending}
                                title="تجاهل العدّ وإبقاء الرصيد الدفتري"
                                onClick={() => onDecide(r, "KEEP")}
                              >
                                إبقاء
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-violet-700"
                                title="طلب إعادة عدّ (سبب إلزامي)"
                                onClick={() => openRecount(r)}
                              >
                                <RefreshCw aria-hidden className="size-4" />{" "}
                                إعادة عدّ
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                          {/* سبب الفرق — يغذي تقرير الانكماش والقيد المحاسبي */}
                          <AppSelect
                            value={reason}
                            disabled={
                              !isOperational ||
                              !!r.reviewApproved ||
                              decide.isPending
                            }
                            onValueChange={(v) => onReasonChange(r, v as Reason)}
                            title="سبب الفرق — يُسجَّل في تقرير الانكماش"
                            aria-label="سبب الفرق"
                            className={`mt-1 h-7 w-full max-w-[150px] px-1.5 text-[11px] ${
                              reason !== "UNSPECIFIED"
                                ? "border-input text-foreground"
                                : "border-[var(--sem-warn)]/50 text-[var(--sem-warn)]"
                            }`}
                          >
                            {REASONS.map((x) => (
                              <option key={x.v} value={x.v}>
                                {x.v === "UNSPECIFIED" ? "السبب؟" : x.label}
                              </option>
                            ))}
                          </AppSelect>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td
                    colSpan={12}
                    className="p-8 text-center text-sm text-muted-foreground"
                  >
                    لا منتجات مطابقة لهذا الفلتر.
                  </td>
                </tr>
              )}
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

      {/* حوار فصل تعارض العدَّين */}
      <Dialog
        open={conflictRow != null}
        onOpenChange={(o) => {
          if (!o) setConflictFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>الفصل في تعارض عدَّين</DialogTitle>
            <DialogDescription>
              {conflictRow && (
                <>
                  المنتج{" "}
                  <b className="text-foreground">
                    {conflictRow.productName}
                    {conflictRow.variantName
                      ? ` — ${conflictRow.variantName}`
                      : ""}
                  </b>{" "}
                  عُدّ مرتين بكميتين مختلفتين. اعتمد أحد العدَّين أو اطلب عدّاً
                  ثالثاً حاسماً — العدّان يبقيان موثّقَين في السجلّ أياً كان
                  القرار.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {conflictRow?.conflict && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-center text-sm">
                <div className="rounded-lg border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">
                    العدّ الأول — {conflictRow.conflict.by1}
                  </p>
                  <p
                    className="font-mono text-2xl font-bold tabular-nums"
                    dir="ltr"
                  >
                    {nf(conflictRow.conflict.qty1)}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">
                    العدّ التحقّقي — {conflictRow.conflict.by2}
                  </p>
                  <p
                    className="font-mono text-2xl font-bold tabular-nums"
                    dir="ltr"
                  >
                    {nf(conflictRow.conflict.qty2)}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  disabled={
                    resolveConflict.isPending ||
                    !isOperational ||
                    !!conflictRow.reviewApproved
                  }
                  onClick={() =>
                    resolveConflict.mutate({
                      sessionId,
                      variantId: conflictRow.variantId,
                      pick: "FIRST",
                    })
                  }
                >
                  اعتماد عدّ {conflictRow.conflict.by1}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    resolveConflict.isPending ||
                    !isOperational ||
                    !!conflictRow.reviewApproved
                  }
                  onClick={() =>
                    resolveConflict.mutate({
                      sessionId,
                      variantId: conflictRow.variantId,
                      pick: "VERIFY",
                    })
                  }
                >
                  اعتماد عدّ {conflictRow.conflict.by2}
                </Button>
              </div>
              <Button
                variant="ghost"
                className="w-full text-violet-700"
                disabled={!isOperational || !!conflictRow.reviewApproved}
                onClick={() => {
                  const r = conflictRow;
                  setConflictFor(null);
                  openRecount(r);
                }}
              >
                <RefreshCw aria-hidden className="size-4" /> طلب عدّ ثالث حاسم
                (يمسح التعارض ويحلّ محلّ العدَّين)
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConflictFor(null)}>
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار إلغاء الاعتماد المرحلي — لا تعديل صامت لصف سبق توقيعه */}
      <Dialog
        open={reopenFor != null}
        onOpenChange={(o) => {
          if (!o) setReopenFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>إلغاء الاعتماد المرحلي وإعادة الفتح</DialogTitle>
            <DialogDescription>
              سيعود المنتج <b className="text-foreground">{reopenFor?.label}</b>{" "}
              إلى قائمة المراجعة ويمكن بعدها تغيير القرار. لن يُنشأ طلب إعادة
              عدّ تلقائياً؛ استخدم «إعادة عدّ» إذا كانت الكمية نفسها موضع شك.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>سبب إعادة الفتح (إلزامي — محفوظ داخل معاملة الجرد)</Label>
            <Textarea
              rows={2}
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="مثال: اكتشاف مستند استلام يحتاج إعادة فحص القرار"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReopenFor(null)}>
              إلغاء
            </Button>
            <Button
              variant="destructive"
              onClick={submitReopen}
              disabled={reopenItemReview.isPending}
            >
              {reopenItemReview.isPending
                ? "جارٍ إعادة الفتح…"
                : "إلغاء الاعتماد وإعادة الفتح"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار طلب إعادة العدّ — سبب إلزامي */}
      <Dialog
        open={recountFor != null}
        onOpenChange={(o) => {
          if (!o) setRecountFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>طلب إعادة عدّ ثانية</DialogTitle>
            <DialogDescription>
              سيظهر المنتج{" "}
              <b className="text-foreground">{recountFor?.label}</b> كمهمة إعادة
              عدّ في شاشة العامل، دون كشف الرصيد الدفتري أو سبب الفرق له. عدّ
              الإعادة يحلّ محلّ العدّ الأول في الحساب.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>سبب الطلب (إلزامي — يُسجَّل في سجلّ التدقيق)</Label>
            <Textarea
              rows={2}
              value={recountReason}
              onChange={(e) => setRecountReason(e.target.value)}
              placeholder="مثال: فرق عالي القيمة — تأكيد العدّ"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRecountFor(null)}>
              إلغاء
            </Button>
            <Button onClick={submitRecount} disabled={requestRecount.isPending}>
              {requestRecount.isPending
                ? "جارٍ الإرسال…"
                : "إرسال الطلب للعامل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار إنقاذ أساس التكلفة — أدمن فقط، لا يقبل سعراً من العميل */}
      <Dialog
        open={valuationRefreshOpen}
        onOpenChange={setValuationRefreshOpen}
      >
        <DialogContent className="max-h-[88vh] overflow-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>إنقاذ أساس تقييم الجرد الافتتاحي</DialogTitle>
            <DialogDescription>
              سيعيد الخادم اشتقاق تكاليف كل الصفوف المختلفة من تكلفة وحدة الأساس
              الحالية تحت الأقفال، ثم يقارن بصمة المعاينة قبل أي كتابة. لا يمكن
              إرسال سعر أو اختيار جزء من الصفوف من هذه الشاشة.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-md bg-money-negative/10 p-3">
                <p className="text-xs text-money-negative">التقييم المسجل</p>
                <p
                  className="font-bold tabular-nums text-money-negative"
                  dir="ltr"
                >
                  {money(valuationIntegrity.snapshotNetValue)}
                </p>
              </div>
              <div className="rounded-md bg-money-positive/10 p-3">
                <p className="text-xs text-money-positive">
                  بكلفة الأساس الحالية
                </p>
                <p
                  className="font-bold tabular-nums text-money-positive"
                  dir="ltr"
                >
                  {money(valuationIntegrity.currentBaseNetValue)}
                </p>
              </div>
              <div className="rounded-md bg-muted p-3">
                <p className="text-xs text-muted-foreground">فرق التضخم</p>
                <p className="font-bold tabular-nums" dir="ltr">
                  {money(valuationIntegrity.inflationDelta)}
                </p>
              </div>
            </div>
            <ul className="space-y-1 rounded-md border p-3 text-xs">
              <li>لا تتغير أي كمية معدودة أو رصيد مخزني.</li>
              <li>لا تُنشأ حركة مخزون أو قيد دفتر أو قبض أو صرف.</li>
              <li>تُفتح اعتمادات الصفوف المتغيرة ويُبطل التوقيع السابق.</li>
              <li>فشل أي خطوة أو تغير البصمة يلغي العملية كاملة.</li>
            </ul>
            <div className="space-y-1.5">
              <Label htmlFor="valuation-refresh-reason">
                سبب التصحيح ومصدر التحقق
              </Label>
              <Textarea
                id="valuation-refresh-reason"
                value={valuationRefreshReason}
                onChange={(e) => setValuationRefreshReason(e.target.value)}
                maxLength={500}
                placeholder="مثال: ثُبت من وحدة اللتر عامل 12,500 ومن الكتالوج أن 0.92 هي تكلفة وحدة الأساس"
              />
              <p className="text-[11px] text-muted-foreground">
                يُحفظ السبب والإجماليان وأكبر الفروقات في سجل تدقيق ذري.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setValuationRefreshOpen(false)}
            >
              رجوع بلا تغيير
            </Button>
            <Button
              variant="destructive"
              disabled={
                valuationRefreshReason.trim().length < 10 ||
                refreshOpeningValuation.isPending
              }
              onClick={submitValuationRefresh}
            >
              {refreshOpeningValuation.isPending
                ? "جارٍ التحقق والتنفيذ…"
                : "تنفيذ الإنقاذ وفتح الاعتمادات المتأثرة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار تأكيد الاعتماد وتنفيذ التسوية */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-h-[88vh] overflow-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {isOpening
                ? "تأكيد اعتماد وتثبيت الأرصدة الافتتاحية"
                : "تأكيد اعتماد الجلسة وتنفيذ التسوية"}
            </DialogTitle>
            <DialogDescription>
              {isOpening
                ? "ستُثبَّت الأرصدة التالية"
                : "سيُنفَّذ التالي فور التأكيد"}{" "}
              — بمعاملة ذرّية واحدة بمرجع{" "}
              <span className="font-mono font-bold text-foreground" dir="ltr">
                {s.code}
              </span>
              :
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <ul className="space-y-1.5">
              <li className="flex justify-between rounded-md bg-muted/60 px-3 py-2">
                <span>
                  {isOpening
                    ? "أرصدة افتتاحية ستُثبت تلقائياً"
                    : "تسويات تلقائية (ضمن الحدّ)"}
                </span>
                <span className="font-bold tabular-nums" dir="ltr">
                  {nf(autoCount)}
                </span>
              </li>
              <li className="flex justify-between rounded-md bg-muted/60 px-3 py-2">
                <span>
                  {isOpening ? "أرصدة بقرار صريح" : "تسويات بقرار صريح"}
                </span>
                <span className="font-bold tabular-nums" dir="ltr">
                  {nf(adjustExplicit)}
                </span>
              </li>
              <li className="flex justify-between rounded-md bg-muted/60 px-3 py-2">
                <span>منتجات أُبقي رصيدها الدفتري</span>
                <span className="font-bold tabular-nums" dir="ltr">
                  {nf(keepCount)}
                </span>
              </li>
              <li className="flex justify-between rounded-md bg-money-negative/10 px-3 py-2 font-bold text-money-negative">
                <span>
                  {isOpening
                    ? "قيمة التغيير الافتتاحي بالتكلفة"
                    : "صافي قيمة التسوية"}
                </span>
                <span className="tabular-nums" dir="ltr">
                  {money(totals.netValue)}
                </span>
              </li>
            </ul>

            {/* معاينة القيد المحاسبي */}
            {isOpening ? (
              <div className="rounded-lg border border-money-positive/40 bg-money-positive/10 p-3 text-xs text-money-positive">
                <p className="font-bold">الأثر المحاسبي والنقدي: صفر</p>
                <p className="mt-1">
                  لا قيد عجز أو زيادة، ولا قبض أو صرف، ولا حركة صندوق أو مصرف أو
                  ذمم. العملية تثبت كميات المخزون فقط بحركات OPENING موثقة.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border bg-muted/40 p-3">
                <p className="mb-1.5 text-xs font-bold">
                  القيد المحاسبي الآلي في الدفتر (مرجع{" "}
                  <span className="font-mono" dir="ltr">
                    {s.code}
                  </span>
                  ):
                </p>
                <div className="space-y-1 text-xs">
                  {hasShort && (
                    <p className="flex justify-between">
                      <span>مصروف عجز مخزون (مدين)</span>
                      <span
                        className="font-mono font-bold tabular-nums text-money-negative"
                        dir="ltr"
                      >
                        {money(ledgerPreview.shortExpense)}
                      </span>
                    </p>
                  )}
                  {hasOver && (
                    <p className="flex justify-between">
                      <span>تسوية زيادة مخزون (دائن)</span>
                      <span
                        className="font-mono font-bold tabular-nums text-money-positive"
                        dir="ltr"
                      >
                        {money(ledgerPreview.overGain)}
                      </span>
                    </p>
                  )}
                  {!hasShort && !hasOver && (
                    <p className="text-muted-foreground">
                      لا قيد — لا تسويات ذات قيمة.
                    </p>
                  )}
                </div>
              </div>
            )}

            {noReasonCount > 0 && (
              <p className="flex items-start gap-1.5 rounded-md bg-[var(--sem-warn-bg)] px-3 py-2 text-xs text-[var(--sem-warn)]">
                <AlertTriangle
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0"
                />
                <span>
                  {nf(noReasonCount)} فرق بلا سبب محدد — يُنصح بتصنيفها
                  (تلف/فقدان/خطأ إدخال) ليصدق تقرير الانكماش السنوي. يمكنك
                  المتابعة على أي حال.
                </span>
              </p>
            )}
            {barriers.requiresDualSign && s.firstSign && (
              <p className="flex items-start gap-1.5 rounded-md bg-violet-50 px-3 py-2 text-xs text-violet-800">
                <Pen aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  اعتماد مزدوج: التوقيع الأول {s.firstSign.byName} ·{" "}
                  {dt(s.firstSign.at)} — توقيعك الآن هو النهائي.
                </span>
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              تُكتب حركات التسوية في سجلّ حركات المخزون وتُحدَّث الأرصدة تحت
              قفل، ويُقفل تعديل الجلسة نهائياً. الاعتماد باسم:{" "}
              <span className="font-bold text-foreground">{me.data?.name}</span>
              .
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              رجوع
            </Button>
            <Button
              className="bg-[var(--money-positive)] text-white hover:opacity-90"
              disabled={approve.isPending}
              onClick={() => approve.mutate({ sessionId })}
            >
              {approve.isPending
                ? "جارٍ التنفيذ…"
                : isOpening
                  ? "تأكيد تثبيت الأرصدة"
                  : "تأكيد الاعتماد والتنفيذ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
