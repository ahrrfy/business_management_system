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
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
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
import { notify } from "@/lib/notify";
import { D, fmt, fmtInt } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { STOCKTAKE_REASON_LABEL } from "@/lib/printing/stocktakeTemplates";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";

/* ───────── ثوابت العرض ───────── */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  COUNTING: { label: "قيد العدّ", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  REVIEW: { label: "قيد المراجعة", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  APPROVED: { label: "معتمدة ومُسوّاة", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  CANCELLED: { label: "ملغاة", cls: "bg-rose-50 text-rose-700 border-rose-200" },
};
const MTYPE: Record<string, string> = {
  IN: "وارد",
  OUT: "صادر",
  RETURN: "مرتجع",
  ADJUST: "تسوية",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
};
type Reason = "UNSPECIFIED" | "DAMAGE" | "LOSS_THEFT" | "ENTRY_ERROR" | "PRINT_WASTE";
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
  ["diff", "الفروقات فقط"],
  ["over", "يتجاوز الحدّ"],
  ["conflict", "تعارضات"],
  ["recount", "إعادة عدّ"],
  ["uncounted", "غير معدود"],
] as const;
type FilterKey = (typeof FILTERS)[number][0];

/* ───────── أدوات تنسيق (أرقام لاتينية، أموال decimal.js حصراً) ───────── */
const nf = (n: number | null | undefined) => fmtInt(n ?? 0);
const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmtInt(Math.abs(n));
const money = (v: string | number | null | undefined) => {
  const d = D(v ?? 0);
  return (d.isNegative() ? "−" : "") + fmt(d.abs().toFixed(2)) + " د.ع";
};
const pctStr = (v: string | number | null | undefined) =>
  D(v ?? 0).toNumber().toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });
const dt = (v: string | number | Date | null | undefined) =>
  v ? new Date(v).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "medium", timeStyle: "short" }) : "—";

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status, cls: "bg-muted text-muted-foreground border-border" };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${m.cls}`}>
      {m.label}
    </span>
  );
}
function Pill({ tone, children, title }: { tone: "muted" | "blue" | "amber" | "green" | "emerald" | "rose" | "violet"; children: ReactNode; title?: string }) {
  const tones: Record<string, string> = {
    muted: "bg-muted text-muted-foreground border-border",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    green: "bg-green-50 text-green-700 border-green-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rose: "bg-rose-50 text-rose-700 border-rose-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
  };
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}
function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "blue" | "amber" | "emerald" | "rose" }) {
  const tones: Record<string, string> = {
    blue: "text-blue-700",
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
  };
  return (
    <Card className="p-4 gap-1">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${tone ? tones[tone] : ""}`} dir="ltr">{value}</p>
      {sub && <p className="text-xs tabular-nums text-muted-foreground" dir="ltr">{sub}</p>}
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
  const [recountFor, setRecountFor] = useState<{ variantId: number; label: string } | null>(null);
  const [recountReason, setRecountReason] = useState("");
  const [conflictFor, setConflictFor] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** سبب الفرق المختار محلياً لكل منتج (قبل/مع القرار). */
  const [reasonSel, setReasonSel] = useState<Record<number, Reason>>({});

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
    Promise.all([utils.stocktakes.review.invalidate(), utils.stocktakes.monitor.invalidate(), utils.stocktakes.list.invalidate()]);

  const decide = trpc.stocktakes.decide.useMutation({
    onSuccess: () => utils.stocktakes.review.invalidate(),
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
      notify.ok("وُقّع التوقيع الأول ✓", `${r.firstSignByName} · ${dt(r.firstSignAt)} — الاعتماد النهائي يلزم أن يكون من مسؤول آخر.`);
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
          "اعتُمدت الجلسة ونُفّذت التسوية ✓",
          `${nf(r.adjustedCount)} حركة تسوية — عجز ${money(r.shortExpense)} · زيادة ${money(r.overGain)}`,
        );
      await invalidate();
      navigate(`/stocktakes/${sessionId}/report`);
    },
    onError: (e) => notify.err(e),
  });

  /* ───── حواجز عرض مبكرة (بعد كل الـhooks) ───── */
  if (!idOk) return <div className="p-10 text-center text-muted-foreground">معرّف الجلسة غير صالح.</div>;
  if (me.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (me.data && !isManager)
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10 text-center">
        <p className="text-4xl">🔒</p>
        <p className="font-bold">مراجعة الجرد واعتماده صلاحية مشرف فأعلى</p>
        <p className="text-sm text-muted-foreground">
          قيم التكلفة وقرارات التسوية محجوبة عن دورك في الخادم. يمكنك متابعة تقدم العدّ وطلب إعادة العدّ من
          شاشة المتابعة.
        </p>
        <Link href={`/stocktakes/${sessionId}`}><Button variant="outline">→ شاشة متابعة العدّ</Button></Link>
      </div>
    );
  if (review.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ تحميل المراجعة…</div>;
  if (review.error)
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10 text-center">
        <p className="font-bold text-rose-700">تعذّر تحميل المراجعة</p>
        <p className="text-sm text-muted-foreground">{review.error.message}</p>
        <Link href="/stocktakes"><Button variant="outline">→ جلسات الجرد</Button></Link>
      </div>
    );
  if (!review.data) return <div className="p-10 text-center text-muted-foreground">الجلسة غير موجودة.</div>;

  const { session: s, rows, totals, barriers, ledgerPreview } = review.data;
  const isReview = s.status === "REVIEW";
  const isApproved = s.status === "APPROVED";
  const dualItems = rows.filter((r: { requiresDualSign: boolean }) => r.requiresDualSign);

  type Row = (typeof rows)[number];

  /** سبب الفرق الفعّال للصف: اختيار محلي ← قرار محفوظ ← غير محدد. */
  const effReason = (r: Row): Reason =>
    (reasonSel[r.variantId] as Reason | undefined) ?? ((r.decision?.reason as Reason | undefined) ?? "UNSPECIFIED");

  /* ───── الفلاتر + البحث المحلي ───── */
  const qNorm = q.trim().toLowerCase();
  const filtered = rows.filter((r: Row) => {
    if (qNorm) {
      const hay = `${r.productName} ${r.variantName ?? ""} ${r.sku}`.toLowerCase();
      if (!hay.includes(qNorm)) return false;
    }
    switch (filter) {
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

  /* ───── زر الاعتماد (التدفق المزدوج) ───── */
  let approveLabel: string;
  let approveMode: "final" | "first" | "wait";
  if (!barriers.requiresDualSign) {
    approveMode = "final";
    approveLabel = "اعتماد الجلسة وتنفيذ التسوية";
  } else if (!barriers.firstSigned) {
    approveMode = "first";
    approveLabel = "🖊 توقيع أول — إرسال للتوقيع الثاني";
  } else if (!barriers.canFinalApprove) {
    approveMode = "wait";
    approveLabel = "بانتظار توقيع مسؤول آخر…";
  } else {
    approveMode = "final";
    approveLabel = "🖊 التوقيع الثاني والاعتماد النهائي";
  }
  const approveDisabled =
    !isReview || !barriers.canApprove || approveMode === "wait" || approve.isPending || firstSign.isPending;
  const approveTitle = !isReview
    ? isApproved
      ? "الجلسة معتمدة ومقفلة"
      : "الاعتماد متاح لجلسة قيد المراجعة فقط"
    : barriers.openConflicts > 0
      ? `⚠ ${nf(barriers.openConflicts)} تعارض بين عدَّين يحتاج فصلاً`
      : barriers.pendingRecounts > 0
        ? `⟳ ${nf(barriers.pendingRecounts)} منتج بانتظار إعادة العدّ`
        : barriers.undecidedOverThreshold > 0
          ? `⚖ ${nf(barriers.undecidedOverThreshold)} فرق يتجاوز الحدّ بلا قرار`
          : approveMode === "wait"
            ? "وقّعتَ أولاً — التوقيع الثاني يلزم أن يكون من مسؤول آخر"
            : "";

  /* ───── إحصاءات حوار التأكيد ───── */
  const autoCount = rows.filter(
    (r: Row) => r.diff != null && r.diff !== 0 && !r.decision && !r.overThreshold && s.directUnderThreshold,
  ).length;
  const adjustExplicit = rows.filter((r: Row) => r.decision?.action === "ADJUST" && !r.decision.autoApplied).length;
  const keepCount = rows.filter((r: Row) => r.decision?.action === "KEEP").length;
  const noReasonCount = rows.filter((r: Row) => r.diff != null && r.diff !== 0 && effReason(r) === "UNSPECIFIED").length;
  const hasShort = D(ledgerPreview.shortExpense).gt(0);
  const hasOver = D(ledgerPreview.overGain).gt(0);

  /* ───── أفعال ───── */
  function onReasonChange(r: Row, value: Reason) {
    setReasonSel((prev) => ({ ...prev, [r.variantId]: value }));
    if (r.decision) {
      // تحديث سبب قرار قائم بإعادة استدعاء decide بنفس الفعل (upsert في الخادم).
      decide.mutate({ sessionId, variantId: r.variantId, action: r.decision.action, reason: value });
    } else if (r.diff != null && r.diff !== 0 && !r.overThreshold && s.directUnderThreshold) {
      // ضمن الحدّ: تثبيت التصنيف فوراً كقرار تسوية صريح — نفس أثر التسوية التلقائية مع حفظ السبب
      // (وإلا ضاع السبب وسُجِّل «غير محدد» في القرار التلقائي عند الاعتماد).
      decide.mutate({ sessionId, variantId: r.variantId, action: "ADJUST", reason: value });
    }
  }
  function onDecide(r: Row, action: "ADJUST" | "KEEP") {
    decide.mutate({ sessionId, variantId: r.variantId, action, reason: effReason(r) });
  }
  function openRecount(r: Row) {
    setRecountReason("");
    setRecountFor({ variantId: r.variantId, label: `${r.productName}${r.variantName ? ` — ${r.variantName}` : ""}` });
  }
  function submitRecount() {
    if (!recountFor) return;
    const reason = recountReason.trim();
    if (reason.length < 3) {
      notify.warn("سبب الطلب إلزامي (٣ أحرف على الأقل) — يُسجَّل في سجلّ التدقيق.");
      return;
    }
    requestRecount.mutate({ sessionId, variantId: recountFor.variantId, reason });
  }
  function onApproveClick() {
    if (approveMode === "first") firstSign.mutate({ sessionId });
    else setConfirmOpen(true);
  }

  /** تصدير صفوف الفروقات إلى Excel (المعروضة بعد الفلتر/البحث) — للمدير+ فقط. */
  function onExport() {
    const exportable = filtered.filter((r: Row) => r.diff != null && r.diff !== 0);
    if (exportable.length === 0) {
      notify.warn("لا فروقات للتصدير ضمن الفلتر الحالي.");
      return;
    }
    exportRows(exportable, {
      filename: `فروقات الجرد ${s.code}`,
      columns: [
        { key: "productName", header: "المنتج" },
        { key: "variantName", header: "المتغيّر", map: (r) => r.variantName ?? "" },
        { key: "sku", header: "SKU" },
        { key: "baseUnit", header: "الوحدة", map: (r) => r.baseUnit ?? "" },
        { key: "bookNow", header: "الدفتري", map: (r) => r.bookNow },
        { key: "adjustedCount", header: "المعدود المصحَّح", map: (r) => r.adjustedCount ?? "" },
        { key: "diff", header: "الفرق", map: (r) => r.diff ?? "" },
        { key: "value", header: "قيمة الفرق", map: (r) => (r.value == null ? "" : Number(r.value)) },
        { key: "pct", header: "النسبة ٪", map: (r) => (r.pct == null ? "" : Number(r.pct.toFixed(2))) },
        {
          key: "status",
          header: "ضمن الحدّ / يتجاوز",
          map: (r) => (r.overThreshold ? "يتجاوز الحدّ" : r.withinThreshold ? "ضمن الحدّ" : "—"),
        },
        {
          key: "decision",
          header: "القرار",
          map: (r) =>
            r.decision
              ? r.decision.action === "ADJUST"
                ? "تسوية بالمعدود"
                : "إبقاء الدفتري"
              : !r.overThreshold && s.directUnderThreshold
                ? "تسوية تلقائية"
                : "بلا قرار",
        },
        { key: "reason", header: "السبب", map: (r) => STOCKTAKE_REASON_LABEL[effReason(r)] ?? effReason(r) },
      ],
    });
  }

  const conflictRow = conflictFor != null ? rows.find((r: Row) => r.variantId === conflictFor) : undefined;

  return (
    <div className="space-y-4">
      {/* مسار الرجوع */}
      <div className="flex items-center gap-2 text-sm">
        <Link href="/stocktakes" className="font-semibold text-primary hover:underline">→ جلسات الجرد</Link>
        <span className="text-border">/</span>
        <span className="text-muted-foreground">{s.name} — المراجعة</span>
      </div>

      {/* الترويسة */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">مراجعة وتدقيق الجرد</h1>
            <StatusBadge status={s.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {s.name} · <span className="font-mono" dir="ltr">{s.code}</span> · {s.branchName}
            {s.submittedAt && <> · سلّم العدّ {dt(s.submittedAt)}</>}
            {" "}· الحدّ المعتمد: {pctStr(s.thresholdPct)}٪ أو {money(s.thresholdValue)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/stocktakes/${sessionId}`}>
            <Button variant="outline" size="sm">تفاصيل العدّ والسجلّ</Button>
          </Link>
          <Link href={`/stocktakes/${sessionId}/sheets`}>
            <Button variant="outline" size="sm">🖨 قوائم العدّ الورقية</Button>
          </Link>
          <Button variant="outline" size="sm" onClick={onExport} title="تصدير صفوف الفروقات إلى Excel">
            ⬇ تصدير Excel
          </Button>
          {isApproved ? (
            <Link href={`/stocktakes/${sessionId}/report`}>
              <Button size="lg" className="bg-emerald-600 text-white hover:bg-emerald-700">المحضر والتقرير ←</Button>
            </Link>
          ) : (
            <Button
              size="lg"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={approveDisabled}
              title={approveTitle}
              onClick={onApproveClick}
            >
              {firstSign.isPending || approve.isPending ? "جارٍ التنفيذ…" : approveLabel}
            </Button>
          )}
        </div>
      </div>

      {/* لافتات الحالة والحواجز */}
      {s.status === "COUNTING" && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-800">
          ℹ الجلسة ما تزال قيد العدّ — هذه معاينة حية. الاعتماد يتاح بعد تسليم العدّ أو إغلاقه من{" "}
          <Link href={`/stocktakes/${sessionId}`} className="font-bold underline">شاشة المتابعة</Link>.
        </div>
      )}
      {s.status === "CANCELLED" && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-800">
          أُلغيت هذه الجلسة — العدّات موثّقة للاطلاع فقط ولا تسوية عليها.
        </div>
      )}
      {isApproved && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          ✓ <span className="font-bold">معتمدة ومُسوّاة</span>
          {s.approved && <> — اعتمدها {s.approved.byName} · {dt(s.approved.at)}</>}
          {s.firstSign && <> (التوقيع الأول: {s.firstSign.byName} · {dt(s.firstSign.at)})</>}
          {" "}· الجلسة مقفلة نهائياً.{" "}
          <Link href={`/stocktakes/${sessionId}/report`} className="font-bold underline">المحضر والتقرير ←</Link>
        </div>
      )}
      {isReview &&
        (barriers.openConflicts > 0 || barriers.pendingRecounts > 0 || barriers.undecidedOverThreshold > 0) && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            <span className="font-bold">قبل الاعتماد:</span>
            {barriers.openConflicts > 0 && <span>⚠ {nf(barriers.openConflicts)} تعارض بين عدَّين يحتاج فصلاً</span>}
            {barriers.pendingRecounts > 0 && <span>⟳ {nf(barriers.pendingRecounts)} منتج بانتظار إعادة العدّ</span>}
            {barriers.undecidedOverThreshold > 0 && (
              <span>⚖ {nf(barriers.undecidedOverThreshold)} فرق يتجاوز الحدّ يحتاج قرارك (تسوية / إبقاء / إعادة عدّ)</span>
            )}
            <button
              type="button"
              className="mr-auto font-bold underline"
              onClick={() =>
                setFilter(barriers.openConflicts > 0 ? "conflict" : barriers.pendingRecounts > 0 ? "recount" : "over")
              }
            >
              أظهرها ←
            </button>
          </div>
        )}
      {barriers.requiresDualSign && !isApproved && (
        <div className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm text-violet-800">
          🖊 <span className="font-bold">اعتماد مزدوج (توقيعان):</span> {nf(dualItems.length)} فرق تتجاوز قيمته{" "}
          <span className="tabular-nums" dir="ltr">{money(s.dualThreshold)}</span> — يستوجب توقيع مسؤولَين مختلفَين قبل
          التنفيذ.
          {s.firstSign && (
            <span className="mr-2 font-bold">
              التوقيع الأول: {s.firstSign.byName} · {dt(s.firstSign.at)} ✓ — بانتظار التوقيع الثاني من مسؤول آخر.
            </span>
          )}
        </div>
      )}
      {barriers.notCounted > 0 && !isApproved && (
        <div className="rounded-lg border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
          ℹ مراجعة جزئية: {nf(barriers.notCounted)} منتج لم يُعَدّ — سيبقى رصيده الدفتري دون تسوية.
        </div>
      )}

      {/* مؤشرات الملخّص */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="منتجات معدودة" value={`${nf(totals.counted)} / ${nf(totals.total)}`} />
        <Stat label="مطابقة تماماً" value={nf(totals.matched)} tone="emerald" />
        <Stat label="زيادة" value={nf(totals.over)} sub={`+${money(totals.overValue)}`} tone="blue" />
        <Stat label="نقص (عجز)" value={nf(totals.short)} sub={money(totals.shortValue)} tone="rose" />
        <Stat label="تتجاوز الحدّ" value={nf(totals.overThr)} sub="تستوجب قراراً" tone="amber" />
        <Stat
          label="صافي قيمة الفرق"
          value={money(totals.netValue)}
          tone={D(totals.netValue).isNegative() ? "rose" : "emerald"}
        />
      </div>

      {/* لوحة حواجز الاعتماد */}
      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-4 py-3">
          <CardTitle className="text-sm">حواجز الاعتماد — يجب أن تخضرّ كلها قبل التنفيذ</CardTitle>
        </CardHeader>
        <div className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <p className={barriers.notCounted === 0 ? "text-emerald-700" : "text-amber-700"}>
            {barriers.notCounted === 0 ? "✓ كل منتجات النطاق معدودة" : `⚠ ${nf(barriers.notCounted)} منتج غير معدود (لا يحجب — يبقى دفترياً)`}
          </p>
          <p className={barriers.pendingRecounts === 0 ? "text-emerald-700" : "text-rose-700"}>
            {barriers.pendingRecounts === 0 ? "✓ لا إعادات عدّ معلّقة" : `✗ ${nf(barriers.pendingRecounts)} منتج بانتظار إعادة العدّ`}
          </p>
          <p className={barriers.openConflicts === 0 ? "text-emerald-700" : "text-rose-700"}>
            {barriers.openConflicts === 0 ? "✓ لا تعارض بين عدَّين" : `✗ ${nf(barriers.openConflicts)} تعارض مفتوح يحتاج فصلاً`}
          </p>
          <p className={barriers.undecidedOverThreshold === 0 ? "text-emerald-700" : "text-rose-700"}>
            {barriers.undecidedOverThreshold === 0
              ? "✓ كل ما يتجاوز الحدّ له قرار"
              : `✗ ${nf(barriers.undecidedOverThreshold)} فرق يتجاوز الحدّ بلا قرار`}
          </p>
          {barriers.requiresDualSign && (
            <p className={`sm:col-span-2 xl:col-span-4 ${barriers.firstSigned ? "text-violet-700" : "text-amber-700"}`}>
              🖊 توقيع مزدوج مطلوب (فروقات فوق {money(s.dualThreshold)}) —{" "}
              {barriers.firstSigned
                ? `التوقيع الأول ✓ ${s.firstSign ? `(${s.firstSign.byName} · ${dt(s.firstSign.at)})` : ""} — الاعتماد النهائي من مسؤول آخر`
                : "لم يوقَّع التوقيع الأول بعد"}
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
                  filter === k ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold">
            <Switch checked={autoAdjust} onCheckedChange={setAutoAdjust} />
            التصحيح الآلي للحركات اللاحقة للعدّ
            <span className="hidden font-normal text-muted-foreground lg:inline">
              (بيع/شراء وقع بعد عدّ المنتج يُحتسب تلقائياً — يمنع الفروقات الزائفة)
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
          <span className="mr-auto text-xs text-muted-foreground">
            {nf(filtered.length)} منتجاً{review.isFetching ? " · يُحدَّث…" : ""}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-muted/60">
              <tr className="text-right text-xs text-muted-foreground">
                <th className="p-2.5 font-semibold">المنتج</th>
                <th className="p-2.5 font-semibold">عدّه</th>
                <th className="p-2.5 text-center font-semibold" title="لقطة الرصيد الدفتري لحظة إنشاء الجلسة">الدفتري المتوقع</th>
                <th className="p-2.5 text-center font-semibold">المعدود الخام</th>
                <th className="p-2.5 text-center font-semibold" title="صافي حركات المخزون بعد وقت عدّ المنتج">حركات لاحقة</th>
                <th className="p-2.5 text-center font-semibold">المعدود المصحَّح</th>
                <th className="p-2.5 text-center font-semibold">رصيد الدفتر الآن</th>
                <th className="p-2.5 text-center font-semibold">الفرق ±</th>
                <th className="p-2.5 text-center font-semibold">قيمة الفرق</th>
                <th className="p-2.5 text-center font-semibold">الحالة</th>
                <th className="p-2.5 text-center font-semibold">القرار</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r: Row) => {
                const conflictOpen = r.conflict != null && r.conflict.resolvedPick == null;
                const recPending = r.recount?.status === "PENDING";
                const recDone = r.recount?.status === "DONE";
                const uncounted = r.rawCount == null;
                const movesTitle = r.movesAfter
                  .map(
                    (m: { type: string; qty: number; ref: string | null; at: string | Date }) =>
                      `${MTYPE[m.type] ?? m.type} ${signed(m.qty)}${m.ref ? ` (${m.ref})` : ""} — ${dt(m.at)}`,
                  )
                  .join("\n");
                const reason = effReason(r);
                return (
                  <tr
                    key={r.variantId}
                    className={`border-t align-top ${
                      r.overThreshold && !r.decision && !recPending
                        ? "bg-rose-50/40"
                        : r.diff != null && r.diff !== 0
                          ? "bg-amber-50/30"
                          : ""
                    }`}
                  >
                    {/* المنتج */}
                    <td className="p-2.5">
                      <p className="font-bold">
                        {r.productName}{" "}
                        {r.variantName && <span className="font-normal text-muted-foreground">{r.variantName}</span>}
                      </p>
                      <p className="font-mono text-[11px] text-muted-foreground" dir="ltr">{r.sku}</p>
                      <p className="text-[11px] text-muted-foreground">
                        الوحدة: {r.baseUnit}
                        {r.zone ? ` · المنطقة: ${r.zone}` : ""}
                        {r.assignmentName ? ` · ${r.assignmentName}` : ""}
                      </p>
                      {recDone && r.recount && (
                        <p className="mt-1 text-[11px] font-semibold text-violet-700">
                          ⟲ أُعيد عدّه وتأكدت الكمية{" "}
                          <span className="tabular-nums" dir="ltr">{r.recount.qty2 != null ? nf(r.recount.qty2) : "—"}</span>
                          {" "}(طلبها {r.recount.requestedByName} — {r.recount.reason})
                        </p>
                      )}
                      {recPending && r.recount && (
                        <p className="mt-1 text-[11px] font-semibold text-violet-700">
                          ⟳ إعادة عدّ معلّقة (طلبها {r.recount.requestedByName} — {r.recount.reason})
                        </p>
                      )}
                      {r.verify && r.verify.match && !conflictOpen && (
                        <p className="mt-1 text-[11px] font-semibold text-emerald-700">
                          ✓✓ عدّ تحقّقي مطابق من {r.verify.byName}
                        </p>
                      )}
                      {conflictOpen && r.conflict && (
                        <p className="mt-1 inline-flex items-center gap-1 rounded-md bg-rose-50 px-1.5 py-0.5 text-[11px] font-bold text-rose-700">
                          ⚠ تعارض: {r.conflict.by1} عدّ <span dir="ltr">{nf(r.conflict.qty1)}</span> — {r.conflict.by2} عدّ{" "}
                          <span dir="ltr">{nf(r.conflict.qty2)}</span>
                        </p>
                      )}
                      {r.conflict?.resolvedPick && (
                        <p className="mt-1 text-[11px] font-semibold text-violet-700">
                          ⚖ فُصل في تعارض العدَّين: اعتُمد عدّ{" "}
                          {r.conflict.resolvedPick === "FIRST" ? r.conflict.by1 : r.conflict.by2}
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
                            <p className="mt-0.5"><Pill tone="violet">إعادة عدّ</Pill></p>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    {/* الدفتري المتوقع */}
                    <td className="p-2.5 text-center font-mono tabular-nums" dir="ltr">{nf(r.expectedQty)}</td>
                    {/* المعدود الخام */}
                    <td className="p-2.5 text-center font-mono tabular-nums" dir="ltr">
                      {r.rawCount == null ? "—" : nf(r.rawCount)}
                    </td>
                    {/* الحركات اللاحقة */}
                    <td className="p-2.5 text-center">
                      {r.netAfter === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <span
                          className="inline-flex cursor-help items-center rounded-md bg-blue-50 px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-blue-700"
                          dir="ltr"
                          title={movesTitle}
                        >
                          {signed(r.netAfter)}
                        </span>
                      )}
                      {r.netAfter !== 0 && (
                        <p className={`mt-0.5 text-[10px] ${autoAdjust ? "text-blue-600" : "font-bold text-rose-600"}`}>
                          {autoAdjust ? "مُصحَّحة آلياً" : "غير محتسبة!"}
                        </p>
                      )}
                    </td>
                    {/* المعدود المصحَّح */}
                    <td className="p-2.5 text-center font-mono font-bold tabular-nums" dir="ltr">
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
                          {r.netAfter !== 0 && autoAdjust && <span className="text-[10px] text-blue-600">*</span>}
                        </span>
                      )}
                    </td>
                    {/* رصيد الدفتر الآن */}
                    <td className="p-2.5 text-center font-mono tabular-nums" dir="ltr">{nf(r.bookNow)}</td>
                    {/* الفرق */}
                    <td
                      className={`p-2.5 text-center font-mono font-bold tabular-nums ${
                        r.diff != null && r.diff > 0
                          ? "text-blue-700"
                          : r.diff != null && r.diff < 0
                            ? "text-rose-700"
                            : "text-emerald-700"
                      }`}
                      dir="ltr"
                    >
                      {r.diff == null ? "—" : signed(r.diff)}
                      {r.pct != null && r.diff != null && r.diff !== 0 && (
                        <p className="text-[10px] font-normal text-muted-foreground">({r.pct.toFixed(1)}٪)</p>
                      )}
                    </td>
                    {/* قيمة الفرق */}
                    <td
                      className={`p-2.5 text-center font-mono tabular-nums ${
                        r.value != null && D(r.value).isNegative()
                          ? "text-rose-700"
                          : r.value != null && D(r.value).gt(0)
                            ? "text-blue-700"
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
                          <Pill tone="rose">⚠ تعارض عدَّين</Pill>
                        ) : recPending ? (
                          <Pill tone="violet">⟳ إعادة عدّ معلّقة</Pill>
                        ) : r.diff === 0 ? (
                          <Pill tone="emerald">مطابق</Pill>
                        ) : r.overThreshold ? (
                          <Pill tone="amber">يتجاوز الحدّ</Pill>
                        ) : (
                          <Pill tone="green">ضمن الحدّ</Pill>
                        )}
                        {r.requiresDualSign && (
                          <Pill tone="violet" title={`قيمة الفرق تتجاوز حدّ التوقيعين ${money(s.dualThreshold)}`}>
                            🖊 توقيعان
                          </Pill>
                        )}
                        {recDone && !conflictOpen && <Pill tone="violet">⟲ إعادة عدّ منجزة</Pill>}
                        {r.verify && r.verify.match && !conflictOpen && <Pill tone="emerald">✓✓ تحقّقي مطابق</Pill>}
                      </div>
                    </td>
                    {/* القرار */}
                    <td className="p-2.5 text-center">
                      {conflictOpen ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-rose-700"
                          disabled={!isReview}
                          onClick={() => setConflictFor(r.variantId)}
                        >
                          ⚖ الفصل في التعارض
                        </Button>
                      ) : uncounted || recPending ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : r.diff === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-col items-center gap-1">
                          {r.decision ? (
                            <>
                              <Pill tone={r.decision.action === "ADJUST" ? "emerald" : "muted"}>
                                {r.decision.action === "ADJUST" ? "تسوية بالمعدود" : "إبقاء الدفتري"}
                              </Pill>
                              <p className="text-[10px] text-muted-foreground">
                                {r.decision.autoApplied || !r.decision.decidedByName
                                  ? "تلقائي (ضمن الحدّ)"
                                  : `بقرار ${r.decision.decidedByName}`}
                              </p>
                              {isReview && (
                                <div className="flex gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-[11px]"
                                    disabled={decide.isPending}
                                    title="تبديل القرار"
                                    onClick={() => onDecide(r, r.decision!.action === "ADJUST" ? "KEEP" : "ADJUST")}
                                  >
                                    {r.decision.action === "ADJUST" ? "حوّل لإبقاء" : "حوّل لتسوية"}
                                  </Button>
                                </div>
                              )}
                            </>
                          ) : !r.overThreshold && s.directUnderThreshold ? (
                            <>
                              <span className="text-xs font-semibold text-emerald-700">تسوية تلقائية ✓</span>
                              {isReview && (
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
                                    ⟳ إعادة عدّ
                                  </Button>
                                </div>
                              )}
                            </>
                          ) : isReview ? (
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
                                ⟳ إعادة عدّ
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                          {/* سبب الفرق — يغذي تقرير الانكماش والقيد المحاسبي */}
                          <select
                            value={reason}
                            disabled={!isReview || decide.isPending}
                            onChange={(e) => onReasonChange(r, e.target.value as Reason)}
                            title="سبب الفرق — يُسجَّل في تقرير الانكماش"
                            className={`mt-1 h-7 w-full max-w-[150px] cursor-pointer rounded-md border bg-card px-1.5 text-[11px] ${
                              reason !== "UNSPECIFIED" ? "border-input text-foreground" : "border-amber-300 text-amber-800"
                            }`}
                          >
                            {REASONS.map((x) => (
                              <option key={x.v} value={x.v}>
                                {x.v === "UNSPECIFIED" ? "السبب؟" : x.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-sm text-muted-foreground">
                    لا منتجات مطابقة لهذا الفلتر.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > shown.length && (
          <div className="border-t p-3 text-center">
            <Button variant="outline" size="sm" onClick={() => setVisible((v) => v + PAGE)}>
              عرض {nf(Math.min(PAGE, filtered.length - shown.length))} منتجاً إضافياً (المعروض {nf(shown.length)} من{" "}
              {nf(filtered.length)})
            </Button>
          </div>
        )}
      </Card>

      {/* حوار فصل تعارض العدَّين */}
      <Dialog open={conflictRow != null} onOpenChange={(o) => { if (!o) setConflictFor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>الفصل في تعارض عدَّين</DialogTitle>
            <DialogDescription>
              {conflictRow && (
                <>
                  المنتج{" "}
                  <b className="text-foreground">
                    {conflictRow.productName}
                    {conflictRow.variantName ? ` — ${conflictRow.variantName}` : ""}
                  </b>{" "}
                  عُدّ مرتين بكميتين مختلفتين. اعتمد أحد العدَّين أو اطلب عدّاً ثالثاً حاسماً — العدّان يبقيان
                  موثّقَين في السجلّ أياً كان القرار.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {conflictRow?.conflict && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-center text-sm">
                <div className="rounded-lg border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">العدّ الأول — {conflictRow.conflict.by1}</p>
                  <p className="font-mono text-2xl font-bold tabular-nums" dir="ltr">{nf(conflictRow.conflict.qty1)}</p>
                </div>
                <div className="rounded-lg border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">العدّ التحقّقي — {conflictRow.conflict.by2}</p>
                  <p className="font-mono text-2xl font-bold tabular-nums" dir="ltr">{nf(conflictRow.conflict.qty2)}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  disabled={resolveConflict.isPending || !isReview}
                  onClick={() => resolveConflict.mutate({ sessionId, variantId: conflictRow.variantId, pick: "FIRST" })}
                >
                  اعتماد عدّ {conflictRow.conflict.by1}
                </Button>
                <Button
                  variant="outline"
                  disabled={resolveConflict.isPending || !isReview}
                  onClick={() => resolveConflict.mutate({ sessionId, variantId: conflictRow.variantId, pick: "VERIFY" })}
                >
                  اعتماد عدّ {conflictRow.conflict.by2}
                </Button>
              </div>
              <Button
                variant="ghost"
                className="w-full text-violet-700"
                disabled={!isReview}
                onClick={() => {
                  const r = conflictRow;
                  setConflictFor(null);
                  openRecount(r);
                }}
              >
                ⟳ طلب عدّ ثالث حاسم (يمسح التعارض ويحلّ محلّ العدَّين)
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConflictFor(null)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار طلب إعادة العدّ — سبب إلزامي */}
      <Dialog open={recountFor != null} onOpenChange={(o) => { if (!o) setRecountFor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>طلب إعادة عدّ ثانية</DialogTitle>
            <DialogDescription>
              سيظهر المنتج <b className="text-foreground">{recountFor?.label}</b> كمهمة إعادة عدّ في شاشة العامل،
              دون كشف الرصيد الدفتري أو سبب الفرق له. عدّ الإعادة يحلّ محلّ العدّ الأول في الحساب.
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
            <Button variant="ghost" onClick={() => setRecountFor(null)}>إلغاء</Button>
            <Button onClick={submitRecount} disabled={requestRecount.isPending}>
              {requestRecount.isPending ? "جارٍ الإرسال…" : "إرسال الطلب للعامل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار تأكيد الاعتماد وتنفيذ التسوية */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-h-[88vh] overflow-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>تأكيد اعتماد الجلسة وتنفيذ التسوية</DialogTitle>
            <DialogDescription>
              سيُنفَّذ التالي فور التأكيد — بمعاملة ذرّية واحدة بمرجع{" "}
              <span className="font-mono font-bold text-foreground" dir="ltr">{s.code}</span>:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <ul className="space-y-1.5">
              <li className="flex justify-between rounded-md bg-muted/60 px-3 py-2">
                <span>تسويات تلقائية (ضمن الحدّ)</span>
                <span className="font-bold tabular-nums" dir="ltr">{nf(autoCount)}</span>
              </li>
              <li className="flex justify-between rounded-md bg-muted/60 px-3 py-2">
                <span>تسويات بقرار صريح</span>
                <span className="font-bold tabular-nums" dir="ltr">{nf(adjustExplicit)}</span>
              </li>
              <li className="flex justify-between rounded-md bg-muted/60 px-3 py-2">
                <span>منتجات أُبقي رصيدها الدفتري</span>
                <span className="font-bold tabular-nums" dir="ltr">{nf(keepCount)}</span>
              </li>
              <li className="flex justify-between rounded-md bg-rose-50 px-3 py-2 font-bold text-rose-700">
                <span>صافي قيمة التسوية</span>
                <span className="tabular-nums" dir="ltr">{money(totals.netValue)}</span>
              </li>
            </ul>

            {/* معاينة القيد المحاسبي */}
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="mb-1.5 text-xs font-bold">
                القيد المحاسبي الآلي في الدفتر (مرجع <span className="font-mono" dir="ltr">{s.code}</span>):
              </p>
              <div className="space-y-1 text-xs">
                {hasShort && (
                  <p className="flex justify-between">
                    <span>مصروف عجز مخزون (مدين)</span>
                    <span className="font-mono font-bold tabular-nums text-rose-700" dir="ltr">
                      {money(ledgerPreview.shortExpense)}
                    </span>
                  </p>
                )}
                {hasOver && (
                  <p className="flex justify-between">
                    <span>تسوية زيادة مخزون (دائن)</span>
                    <span className="font-mono font-bold tabular-nums text-emerald-700" dir="ltr">
                      {money(ledgerPreview.overGain)}
                    </span>
                  </p>
                )}
                {!hasShort && !hasOver && <p className="text-muted-foreground">لا قيد — لا تسويات ذات قيمة.</p>}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                بهذا تبقى الأرباح صادقة — العجز لا «يختفي» بل يظهر مصروفاً صريحاً.
              </p>
            </div>

            {noReasonCount > 0 && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                ⚠ {nf(noReasonCount)} فرق بلا سبب محدد — يُنصح بتصنيفها (تلف/فقدان/خطأ إدخال) ليصدق تقرير
                الانكماش السنوي. يمكنك المتابعة على أي حال.
              </p>
            )}
            {barriers.requiresDualSign && s.firstSign && (
              <p className="rounded-md bg-violet-50 px-3 py-2 text-xs text-violet-800">
                🖊 اعتماد مزدوج: التوقيع الأول {s.firstSign.byName} · {dt(s.firstSign.at)} — توقيعك الآن هو النهائي.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              تُكتب حركات التسوية في سجلّ حركات المخزون وتُحدَّث الأرصدة تحت قفل، ويُقفل تعديل الجلسة نهائياً.
              الاعتماد باسم: <span className="font-bold text-foreground">{me.data?.name}</span>.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>رجوع</Button>
            <Button
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={approve.isPending}
              onClick={() => approve.mutate({ sessionId })}
            >
              {approve.isPending ? "جارٍ التنفيذ…" : "تأكيد الاعتماد والتنفيذ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
