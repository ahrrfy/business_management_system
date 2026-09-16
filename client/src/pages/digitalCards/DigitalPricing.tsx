// شاشة «أسعار الكروت اليوم» (ش٤). حقلان واضحان لكل صفّ: تكلفة المزوّد وسعر البيع.
// الهامش وحراس الخسارة يأتيان **من الخادم** عبر معاينة مشتقّة من دالة النشر نفسها —
// عمداً لا تُعاد قواعد القرار المالي هنا (§٧.٣ من وثيقة التصميم).
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { fmtAr } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  CopyPlus,
  Send,
  Save,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";

type PriceLine = {
  offeringId: number;
  providerShare: string;
  sellPrice: string;
};

type MismatchReport =
  RouterOutputs["digitalCards"]["pricing"]["mismatchReports"][number];

/** صفُّ «تغيير كبير في الحصة» كما يصله من ورقة الصباح. */
type BigChangeRow =
  RouterOutputs["digitalCards"]["pricing"]["getMorningSheet"]["bigChanges"][number];

/** بصمة حتمية تمنع نشر أرقام لم تصل معاينتها الخادمية الحالية بعد. */
function priceLinesKey(lines: PriceLine[]): string {
  return [...lines]
    .sort((a, b) => a.offeringId - b.offeringId)
    .map((line) => `${line.offeringId}:${line.providerShare}:${line.sellPrice}`)
    .join("|");
}

/** تاريخ اليوم بصيغة YYYY-MM-DD (توقيت الجهاز — يوم العمل التشغيليّ للمستخدم). */
function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function positiveId(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export default function DigitalPricing() {
  const utils = trpc.useUtils();
  const search = useSearch();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const providers = trpc.digitalCards.providers.list.useQuery();

  const [branchId, setBranchId] = useState<number | null>(null);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [businessDate, setBusinessDate] = useState(todayYmd());
  const [changeReason, setChangeReason] = useState("");
  /** السعران قيد التحرير — التكلفة تخصم من المحفظة، والبيع يراه الزبون. */
  const [costs, setCosts] = useState<Record<number, string>>({});
  const [sellPrices, setSellPrices] = useState<Record<number, string>>({});
  const initialScope = useRef({
    branchId: positiveId(new URLSearchParams(search).get("branchId")),
    providerId: positiveId(new URLSearchParams(search).get("providerId")),
  });
  const scopeInitialized = useRef(false);

  const activeProviders = useMemo(
    () => (providers.data ?? []).filter((p) => p.isActive),
    [providers.data],
  );

  // رابط لوحة الجاهزية يمرّر الفرع والمزوّد. نقرأه مرةً ثم نتحقق من وجود القيم
  // وإتاحتها؛ الرابط القديم/المعطوب لا يرسل استعلاماً بنطاق غير صالح.
  useEffect(() => {
    if (
      scopeInitialized.current ||
      me.isLoading ||
      branches.isLoading ||
      providers.isLoading
    )
      return;

    const requested = initialScope.current;
    const mine = me.data?.branchId;
    const branchRows = branches.data ?? [];
    const requestedBranch = branchRows.find(
      (branch) => branch.id === requested.branchId,
    );
    const mineBranch = branchRows.find((branch) => branch.id === Number(mine));
    const requestedProvider = activeProviders.find(
      (provider) => provider.id === requested.providerId,
    );

    setBranchId(
      requestedBranch?.id ?? mineBranch?.id ?? branchRows[0]?.id ?? null,
    );
    setProviderId(requestedProvider?.id ?? activeProviders[0]?.id ?? null);
    scopeInitialized.current = true;
  }, [
    activeProviders,
    branches.data,
    branches.isLoading,
    me.data?.branchId,
    me.isLoading,
    providers.isLoading,
  ]);

  const scopeReady = branchId != null && providerId != null;
  const scope = scopeReady
    ? { branchId: branchId!, providerId: providerId!, businessDate }
    : undefined;

  const sheet = trpc.digitalCards.pricing.getMorningSheet.useQuery(scope!, {
    enabled: scopeReady,
  });
  const reports = trpc.digitalCards.pricing.mismatchReports.useQuery(
    { branchId: branchId ?? undefined, status: "OPEN" },
    { enabled: branchId != null },
  );

  // تحميل الحصص من المسوّدة/السعر المُرحَّل عند وصول الكشف.
  useEffect(() => {
    if (!sheet.data) return;
    const nextCosts: Record<number, string> = {};
    const nextSales: Record<number, string> = {};
    for (const r of sheet.data.rows) {
      nextCosts[r.offeringId] =
        r.draftProviderShare ?? r.currentProviderShare ?? "";
      nextSales[r.offeringId] = r.draftSellPrice ?? r.currentSellPrice ?? "";
    }
    setCosts(nextCosts);
    setSellPrices(nextSales);
  }, [sheet.data]);

  // لا نعيد ضبط ما يكتبه المدير عند كل إعادة جلب؛ نحمّل السبب فقط عند تبدّل المسوّدة نفسها.
  useEffect(() => {
    setChangeReason(sheet.data?.batch?.changeReason ?? "");
  }, [sheet.data?.batch?.id]);

  const rows = useMemo(() => sheet.data?.rows ?? [], [sheet.data?.rows]);
  const filledPriceLines = useMemo<PriceLine[]>(
    () =>
      rows.flatMap((row) => {
        const providerShare = costs[row.offeringId] ?? "";
        const sellPrice = sellPrices[row.offeringId] ?? "";
        return providerShare !== "" && sellPrice !== ""
          ? [{ offeringId: row.offeringId, providerShare, sellPrice }]
          : [];
      }),
    [rows, costs, sellPrices],
  );
  const filledPriceLinesKey = priceLinesKey(filledPriceLines);

  // معاينة خادمية مُهدّأة (debounce) لكل الصفوف المملوءة.
  const [previewInput, setPreviewInput] = useState<PriceLine[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      setPreviewInput(filledPriceLines);
    }, 350);
    return () => clearTimeout(t);
  }, [filledPriceLines, filledPriceLinesKey]);

  const preview = trpc.digitalCards.pricing.preview.useQuery(
    { branchId: branchId!, providerId: providerId!, lines: previewInput },
    { enabled: scopeReady && previewInput.length > 0 },
  );
  const previewById = useMemo(
    () => new Map((preview.data ?? []).map((p) => [p.offeringId, p])),
    [preview.data],
  );
  const previewMatchesCurrent =
    priceLinesKey(previewInput) === filledPriceLinesKey;
  const previewReady =
    rows.length > 0 &&
    filledPriceLines.length === rows.length &&
    previewMatchesCurrent &&
    !preview.isFetching &&
    !preview.isError &&
    preview.data?.length === rows.length &&
    rows.every((row) => previewById.has(row.offeringId));

  function invalidate() {
    void utils.digitalCards.pricing.getMorningSheet.invalidate();
    void utils.digitalCards.pricing.mismatchReports.invalidate();
  }

  /** النشر يغيّر ما يراه الكاشير واللوحة، لا شاشة التسعير وحدها. */
  async function invalidatePublishedPrices() {
    // invalidateQueries يعيد جلب الاستعلامات النشطة فوراً، ويبطل cache غير النشط
    // كي لا يعود كاشير/لوحة مفتوحان لاحقاً إلى نتيجة طازجة ظاهرياً قبل النشر.
    await Promise.all([
      utils.digitalCards.pricing.getMorningSheet.invalidate(),
      utils.digitalCards.pricing.mismatchReports.invalidate(),
      utils.digitalCards.pos.listCards.invalidate(),
      utils.digitalCards.pos.confirmCard.invalidate(),
      utils.digitalCards.dashboard.priceHealth.invalidate(),
    ]);
  }

  const copyMut = trpc.digitalCards.pricing.copyPrevious.useMutation({
    onSuccess: (r) => {
      invalidate();
      notify.ok(
        `نُسخ ${r.copiedCount} سعراً`,
        r.skippedCount
          ? `${r.skippedCount} بطاقة بلا سعر سابق تحتاج إدخالاً`
          : undefined,
      );
    },
    onError: (e) => notify.err(e),
  });
  const saveMut = trpc.digitalCards.pricing.saveDraft.useMutation({
    onSuccess: (r) => {
      invalidate();
      notify.ok(`حُفظت مسوّدة ${r.savedCount} سعراً`);
    },
    onError: (e) => notify.err(e),
  });
  const publishMut = trpc.digitalCards.pricing.publish.useMutation({
    onSuccess: async (r, variables) => {
      await invalidatePublishedPrices();
      const requestedCount = variables.lines.length;
      const branchName =
        branches.data?.find((branch) => branch.id === variables.branchId)
          ?.name ?? `الفرع #${variables.branchId}`;
      const providerName =
        activeProviders.find((provider) => provider.id === variables.providerId)
          ?.supplierName ?? `المزوّد #${variables.providerId}`;
      const scopeMissing = Math.max(
        0,
        r.readiness.scopeTotal - r.readiness.scopeReady,
      );
      const branchMissing = Math.max(
        0,
        r.readiness.branchTotal - r.readiness.branchReady,
      );
      const readinessDescription =
        `${branchName} — ${providerName}. ` +
        `جاهزية أسعار هذا المزوّد: ${r.readiness.scopeReady}/${r.readiness.scopeTotal}، ` +
        `وجاهزية أسعار الفرع: ${r.readiness.branchReady}/${r.readiness.branchTotal}، ` +
        `والأسعار غير الجاهزة في الفرع: ${branchMissing}.`;

      if (r.publishedCount !== requestedCount || scopeMissing > 0) {
        notify.warn(
          `نُشر ${r.publishedCount} من ${requestedCount} سعراً فقط`,
          `${readinessDescription} لم تُعتبر قائمة هذا المزوّد مكتملة؛ راجع الأسعار قبل البيع.`,
        );
        return;
      }

      if (branchMissing > 0) {
        notify.warn(
          `اكتمل نشر ${r.publishedCount} سعراً لـ${providerName}`,
          `${readinessDescription} أسعار هذا المزوّد نافذة، لكن أسعار بقية الفرع ليست جاهزة بالكامل بعد.`,
        );
      } else {
        notify.ok(
          `نُشر ${r.publishedCount} من ${requestedCount} سعراً`,
          `${readinessDescription} كل أسعار الفرع جاهزة للكاشير الآن.`,
        );
      }
    },
    onError: (e) => notify.err(e),
  });
  const approveMut = trpc.digitalCards.pricing.approveMismatch.useMutation({
    onSuccess: async (_result, variables) => {
      const report = (reports.data ?? []).find(
        (item) => item.id === variables.reportId,
      );
      await invalidatePublishedPrices();
      notify.ok(
        `اعتُمد بلاغ ${report?.offeringName ?? `#${variables.reportId}`}`,
        `${report?.branchName ?? "الفرع المحدد"} — ${report?.providerName ?? "المزوّد المحدد"}. بقي سعر البيع ${fmtAr(variables.sellPrice)} دون تغيير ونُشرت التكلفة الجديدة.`,
      );
    },
    onError: (e) => notify.err(e),
  });
  const rejectMut = trpc.digitalCards.pricing.rejectMismatch.useMutation({
    onSuccess: () => {
      invalidate();
      notify.ok("رُفض البلاغ — لم يتغيّر أيّ سعر");
    },
    onError: (e) => notify.err(e),
  });
  const cancelMut = trpc.digitalCards.pricing.cancelDraft.useMutation({
    onSuccess: () => {
      invalidate();
      notify.ok("أُلغيت المسوّدة", "الأسعار النافذة لم تتغيّر.");
    },
    onError: (e) => notify.err(e),
  });
  const approveBigMut = trpc.digitalCards.pricing.approveBigChange.useMutation({
    onSuccess: (r) => {
      invalidate();
      notify.ok(
        `اعتُمد التغيير الكبير (${r.approved.length} بطاقة)`,
        "صار النشر متاحاً — أيّ تعديل لاحق يُبطل الاعتماد.",
      );
    },
    onError: (e) => notify.err(e),
  });

  function filledLines() {
    return filledPriceLines;
  }

  function saveDraft() {
    if (!scope) return;
    const lines = filledLines();
    if (!lines.length) return notify.err("أدخِل حصة مزوّد واحدة على الأقل");
    saveMut.mutate({
      ...scope,
      changeReason: changeReason.trim() || null,
      lines,
    });
  }

  async function publish() {
    if (!scope) return;
    const lines = filledLines();
    const total = sheet.data?.rows.length ?? 0;
    if (lines.length < total) {
      return notify.err(
        `ينقص ${total - lines.length} سعراً — النشر يتطلّب سعراً لكل بطاقة فعّالة`,
      );
    }
    if (!previewReady) {
      return notify.err(
        previewMatchesCurrent && preview.isError
          ? "تعذّرت معاينة الأسعار — أعد المحاولة قبل النشر"
          : "انتظر اكتمال التحقق من كل الأسعار قبل النشر",
      );
    }
    const belowCost = (preview.data ?? []).filter((p) => p.belowCost);
    if (belowCost.length) {
      return notify.err(
        `${belowCost.length} بطاقة تُباع بخسارة — سعر البيع أقل من التكلفة`,
      );
    }
    const below = (preview.data ?? []).filter((p) => p.belowMinimum);
    if (below.length) {
      return notify.err(
        `${below.length} بطاقة هامشها دون الحدّ الأدنى — عدّلها قبل النشر`,
      );
    }
    if (
      !(await confirm({
        title: `نشر أسعار ${activeProviders.find((provider) => provider.id === scope.providerId)?.supplierName ?? "المزوّد"} في ${branches.data?.find((branch) => branch.id === scope.branchId)?.name ?? "الفرع"}`,
        description: `ستصبح ${lines.length} بطاقة قابلةً للبيع بأسعارها الجديدة فوراً في هذا الفرع، وتستبدل الأسعار السابقة. لا يمكن التراجع عن النشر — التصحيح يكون بنشر قائمة جديدة. متابعة؟`,
        confirmText: "نشر",
      }))
    )
      return;
    publishMut.mutate({
      ...scope,
      changeReason: changeReason.trim() || null,
      lines,
    });
  }

  async function approveMismatch(report: MismatchReport) {
    if (report.currentSellPrice == null) {
      notify.err(
        `لا يمكن اعتماد بلاغ «${report.offeringName}» بلا سعر بيع نافذ`,
      );
      return;
    }
    if (
      !(await confirm({
        title: `اعتماد تكلفة «${report.offeringName}» ونشرها`,
        description:
          `الفرع: ${report.branchName} — المزوّد: ${report.providerName}. ` +
          `ستتغيّر تكلفة البطاقة من ${fmtAr(report.currentProviderShare)} إلى ${fmtAr(report.reportedProviderShare)}، ` +
          `ويبقى سعر البيع للعميل ${fmtAr(report.currentSellPrice)} دون تغيير. ` +
          "سيُنشر القرار فوراً في كاشير هذا الفرع. متابعة؟",
        confirmText: "اعتماد التكلفة ونشرها",
      }))
    )
      return;

    approveMut.mutate({
      reportId: report.id,
      businessDate,
      sellPrice: report.currentSellPrice,
    });
  }

  const draftBatchId = sheet.data?.batch?.id ?? null;

  async function cancelDraft() {
    if (draftBatchId == null) return;
    if (
      !(await confirm({
        variant: "danger",
        title: "إلغاء المسوّدة",
        description:
          "ستُحذف الحصص المحفوظة لهذا اليوم ويعود الكشف فارغاً. الأسعار النافذة في الكاشير لا تتأثّر. متابعة؟",
        confirmText: "إلغاء المسوّدة",
      }))
    )
      return;
    cancelMut.mutate({ batchId: draftBatchId });
  }

  const busy =
    saveMut.isPending ||
    publishMut.isPending ||
    copyMut.isPending ||
    cancelMut.isPending;
  const openReports = reports.data ?? [];

  // §٧.١: بوّابة التغيير الكبير — تُعرَض قبل النشر لا بعد ارتطامه.
  const bigChanges = sheet.data?.bigChanges ?? [];
  const threshold = sheet.data?.bigChangeThresholdPercent ?? 50;
  const bigApprovedBy = sheet.data?.batch?.bigChangeApprovedBy ?? null;
  const draftCreatedBy = sheet.data?.batch?.createdBy ?? null;
  // مرآة حارس الخادم: لا يعتمد مُنشئ المسوّدة، ومالك النظام مستثنى من الاعتماد الثاني.
  const canApproveBig =
    Boolean(me.data?.isOwner) || Number(me.data?.id) !== Number(draftCreatedBy);
  const bigChangeBlocking = bigChanges.length > 0 && bigApprovedBy == null;

  /** أعمدة «تغيير كبير في الحصة» — عرضٌ محض، مُضمَّنٌ في بطاقة العنوان. */
  const bigChangeColumns: ColumnDef<BigChangeRow, unknown>[] = [
    { id: "name", header: "البطاقة", accessorFn: (b) => b.name, cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    {
      id: "currentShare",
      header: "التكلفة النافذة",
      accessorFn: (b) => fmtAr(b.currentShare),
      meta: { kind: "money" },
      cell: ({ row }) => <span className="text-muted-foreground">{fmtAr(row.original.currentShare)}</span>,
    },
    {
      id: "newShare",
      header: "التكلفة الجديدة",
      accessorFn: (b) => fmtAr(b.newShare),
      meta: { kind: "money" },
      cell: ({ row }) => <span className="font-medium">{fmtAr(row.original.newShare)}</span>,
    },
    {
      id: "changePercent",
      header: "نسبة التغيّر",
      accessorFn: (b) => `${b.changePercent}%`,
      meta: { kind: "number" },
      cell: ({ row }) => <span className="text-destructive font-medium">{row.original.changePercent}%</span>,
    },
  ];

  /** أعمدة «بلاغات تغيّر السعر» — تُغلِق على قراري الاعتماد والرفض. */
  const reportColumns: ColumnDef<MismatchReport, unknown>[] = [
    { id: "offeringName", header: "البطاقة", accessorFn: (r) => r.offeringName, cell: ({ row }) => <span className="font-medium">{row.original.offeringName}</span> },
    {
      id: "providerName",
      header: "المزوّد",
      accessorFn: (r) => r.providerName,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.providerName}</span>,
    },
    {
      id: "currentProviderShare",
      header: "التكلفة في النظام",
      accessorFn: (r) => fmtAr(r.currentProviderShare),
      meta: { kind: "money" },
      cell: ({ row }) => fmtAr(row.original.currentProviderShare),
    },
    {
      id: "reportedProviderShare",
      header: "التكلفة التي أبلغ بها الكاشير",
      accessorFn: (r) => fmtAr(r.reportedProviderShare),
      meta: { kind: "money" },
      cell: ({ row }) => <span className="font-medium">{fmtAr(row.original.reportedProviderShare)}</span>,
    },
    {
      id: "currentSellPrice",
      header: "سعر البيع الذي سيبقى",
      accessorFn: (r) => (r.currentSellPrice != null ? fmtAr(r.currentSellPrice) : "—"),
      meta: { kind: "money" },
      cell: ({ row }) => <span className="font-medium">{row.original.currentSellPrice != null ? fmtAr(row.original.currentSellPrice) : "—"}</span>,
    },
    {
      id: "notes",
      header: "ملاحظة",
      accessorFn: (r) => r.notes || "—",
      meta: { wrap: true },
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.notes || "—"}</span>,
    },
    {
      id: "decision",
      header: "قرار",
      enableSorting: false,
      meta: { kind: "actions", width: "wide" },
      cell: ({ row }) => (
        <div className="flex justify-center gap-2">
          <Button size="sm" disabled={approveMut.isPending} onClick={() => void approveMismatch(row.original)}>
            مراجعة واعتماد
          </Button>
          <Button size="sm" variant="outline" disabled={rejectMut.isPending} onClick={() => rejectMut.mutate({ reportId: row.original.id })}>
            رفض
          </Button>
        </div>
      ),
    },
  ];
  const publishBlockedReason = bigChangeBlocking
    ? `تغييرٌ ≥${threshold}% ينتظر اعتماد مديرٍ آخر`
    : rows.length > 0 && !previewReady
      ? filledPriceLines.length < rows.length
        ? `ينقص ${rows.length - filledPriceLines.length} سعراً`
        : previewMatchesCurrent && preview.isError
          ? "تعذّرت معاينة الأسعار — أعد المحاولة"
          : "جارٍ التحقق من كل الأسعار"
      : undefined;

  return (
    <div className="space-y-4">
      <PageHeader
        title="أسعار الكروت اليوم"
        description="أدخِل تكلفة الشراء وسعر البيع لكل بطاقة بشكل مباشر وواضح. الربح يُحسب ويُرحّل تلقائياً، ولا تصل الأسعار إلى الكاشير إلا بعد «نشر»."
      />

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-4">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="dp-branch">
              الفرع
            </label>
            <AppSelect
              id="dp-branch"
              value={branchId == null ? "" : String(branchId)}
              onValueChange={(next) => setBranchId(next ? Number(next) : null)}
            >
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="dp-provider">
              المزوّد
            </label>
            <AppSelect
              id="dp-provider"
              value={providerId == null ? "" : String(providerId)}
              onValueChange={(next) => setProviderId(next ? Number(next) : null)}
            >
              {activeProviders.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.supplierName}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="dp-date">
              تاريخ يوم العمل
            </label>
            <Input
              id="dp-date"
              type="date"
              value={businessDate}
              onChange={(e) => setBusinessDate(e.target.value)}
              dir="ltr"
            />
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={!scopeReady || busy}
              onClick={() =>
                scope &&
                copyMut.mutate({
                  ...scope,
                  changeReason: changeReason.trim() || null,
                })
              }
            >
              <CopyPlus className="size-4" /> نسخ آخر أسعار منشورة
            </Button>
          </div>
          <div className="space-y-1 sm:col-span-4">
            <label className="text-sm font-medium" htmlFor="dp-change-reason">
              سبب تغيير سعر اليوم (اختياري)
            </label>
            <textarea
              id="dp-change-reason"
              className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
              value={changeReason}
              onChange={(e) => setChangeReason(e.target.value)}
              maxLength={300}
              placeholder="مثال: تغيّر سعر جهاز المزوّد أو عرض منافس"
            />
            <p className="text-xs text-muted-foreground">
              يُحفظ السبب مع قرار السعر المنشور لسهولة المراجعة والتدقيق.
            </p>
          </div>
        </CardContent>
      </Card>

      {bigChanges.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2 text-sm font-medium">
            <TriangleAlert aria-hidden className="size-4" />
            تغيير كبير في الحصة ({bigChanges.length}) — العتبة {threshold}%
            {bigApprovedBy != null && (
              <span className="ms-2 inline-block rounded-full px-2 py-0.5 text-xs badge-status-active">
                مُعتمَد
              </span>
            )}
          </CardHeader>
          <CardContent className="space-y-3 p-0">
            {/* مُضمَّن: البطاقة تحمل العنوان والعدّ؛ pageSize=Infinity لازمٌ معه (شريط الترقيم مكتوم).
                و`maxHeightClass` (مع `bounded` الافتراضيّة) استعادةٌ لِـ`ScrollTableShell` الذي
                كان يلفّ الجدول قبل التحويل: كان `bounded={false}` يعطي حاويةً بلا سقفِ ارتفاعٍ
                ولا ترويسةٍ لاصقة، فعلى موجةٍ فيها عشراتُ البطاقات يختفي رأسُ الأعمدة عند
                التمرير — والمديرُ يقرأ عمودَي «التكلفة النافذة/الجديدة» متجاورَين بلا عنوان،
                وهما رقمان متشابهان لا يفرّقهما إلّا الرأس. والقيمةُ هي افتراضُ `ScrollTableShell`
                نفسه قبل التحويل. وفائدةٌ ثانية: زرّ «اعتماد التغيير الكبير» أسفلَه يبقى
                مرئياً بدل أن يدفعه الجدولُ الطويل خارج الشاشة. */}
            <DataTable<BigChangeRow>
              embedded
              searchable={false}
              maxHeightClass="max-h-[calc(100dvh-15rem)]"
              pageSize={Infinity}
              data={bigChanges}
              columns={bigChangeColumns}
            />
            <div className="flex flex-wrap items-center gap-3 px-4 pb-4 text-sm text-muted-foreground">
              {bigApprovedBy != null ? (
                <span>
                  اعتُمد النشر. أيّ تعديل على المسوّدة بعد الآن يُبطل الاعتماد
                  ويعيد طلبه.
                </span>
              ) : (
                <>
                  <span>
                    النشر موقوفٌ حتى يعتمده مديرٌ آخر غير مُنشئ المسوّدة. مالك النظام مستثنى.
                  </span>
                  <Button
                    size="sm"
                    disabled={
                      !canApproveBig ||
                      approveBigMut.isPending ||
                      draftBatchId == null
                    }
                    title={
                      !canApproveBig
                        ? "لا تعتمد تغييراً في مسوّدةٍ أنشأتَها — يلزم مديرٌ آخر، ويُستثنى مالك النظام"
                        : undefined
                    }
                    onClick={() =>
                      draftBatchId != null &&
                      approveBigMut.mutate({ batchId: draftBatchId })
                    }
                  >
                    <ShieldCheck className="size-4" /> اعتماد التغيير الكبير
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {openReports.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2 text-sm font-medium">
            <TriangleAlert aria-hidden className="size-4" />
            بلاغات تغيّر السعر ({openReports.length})
          </CardHeader>
          <CardContent className="p-0">
            {/* نفس السبب: سقفُ ارتفاعٍ + ترويسةٌ لاصقة كما كان `ScrollTableShell` قبل التحويل.
                وهذا الجدولُ أشدُّ حاجةً إليها — سبعةُ أعمدةٍ منها ثلاثةُ مبالغَ متشابهة
                («في النظام» · «التي أبلغ بها الكاشير» · «الذي سيبقى»)، وقرارُ الاعتماد
                يُتّخذ من موضعِ العمود. رأسٌ يغيب عند التمرير = اعتمادُ الرقم الخطأ. */}
            <DataTable<MismatchReport>
              embedded
              searchable={false}
              maxHeightClass="max-h-[calc(100dvh-15rem)]"
              pageSize={Infinity}
              data={openReports}
              columns={reportColumns}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            {sheet.isLoading ? "" : `${rows.length} بطاقة`}
            {sheet.data?.missingCount
              ? ` — ${sheet.data.missingCount} بلا سعر`
              : ""}
            {sheet.data?.batch ? " — مسوّدة محفوظة" : ""}
          </span>
          <div className="flex gap-2">
            {draftBatchId != null && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void cancelDraft()}
              >
                <Trash2 className="size-4" /> إلغاء المسوّدة
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!scopeReady || busy}
              onClick={saveDraft}
            >
              <Save className="size-4" /> حفظ مسوّدة
            </Button>
            <Button
              size="sm"
              disabled={
                !scopeReady ||
                busy ||
                rows.length === 0 ||
                bigChangeBlocking ||
                !previewReady
              }
              title={publishBlockedReason}
              onClick={() => void publish()}
            >
              <Send className="size-4" /> نشر الأسعار
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* شبكةُ تحرير لا عرض (موجة الجداول ٢/٩/٢٦): كل صفٍّ يحمل `MoneyInput`ين — تكلفة
              الشراء وسعر البيع — يكتبان في `costs`/`sellPrices` المحلّيتين اللتين تُبنى منهما
              المسوّدة والنشر؛ `DataTable` أداةُ عرضٍ فتبقى هذه خامّةً عن قصد. (جدولا «التغيير
              الكبير» و«بلاغات تغيّر السعر» أعلاه محوَّلان أصلاً — كلاهما عرضٌ خالص.) */}
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">البطاقة</th>
                  <th className="p-2 text-start">آخر سعر</th>
                  <th className="p-2 text-start w-40">تكلفة الشراء</th>
                  <th className="p-2 text-start">سعر البيع</th>
                  <th className="p-2 text-start">ربح الشركة</th>
                  <th className="p-2 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const p = previewById.get(r.offeringId);
                  return (
                    <tr key={r.offeringId} className="border-t">
                      <td className="p-2 font-medium">{r.name}</td>
                      <td className="p-2 tabular-nums text-muted-foreground">
                        {r.currentSellPrice ? (
                          <>
                            <span>بيع {fmtAr(r.currentSellPrice)}</span>
                            <br />
                            <span className="text-xs">
                              تكلفة {fmtAr(r.currentProviderShare ?? "0")}
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="p-2">
                        <MoneyInput
                          value={costs[r.offeringId] ?? ""}
                          onChange={(v) =>
                            setCosts((prev) => ({ ...prev, [r.offeringId]: v }))
                          }
                          ariaLabel={`تكلفة شراء ${r.name}`}
                        />
                      </td>
                      <td className="p-2">
                        <MoneyInput
                          value={sellPrices[r.offeringId] ?? ""}
                          onChange={(v) =>
                            setSellPrices((prev) => ({
                              ...prev,
                              [r.offeringId]: v,
                            }))
                          }
                          ariaLabel={`سعر بيع ${r.name}`}
                        />
                      </td>
                      <td
                        className={`p-2 tabular-nums ${p?.belowMinimum ? "text-destructive font-medium" : ""}`}
                      >
                        {p ? fmtAr(p.marginAmount) : "—"}
                        {p?.belowCost && (
                          <span className="ms-1 text-xs">(خسارة)</span>
                        )}
                        {p?.belowMinimum && (
                          <span className="ms-1 text-xs">
                            (الحدّ {fmtAr(p.minimumMargin)})
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-center">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                            r.status === "NEEDS_INPUT"
                              ? "badge-stock-out"
                              : r.status === "DRAFTED"
                                ? "badge-status-active"
                                : "badge-status-neutral"
                          }`}
                        >
                          {r.status === "NEEDS_INPUT"
                            ? "بلا سعر"
                            : r.status === "DRAFTED"
                              ? "مسوّدة"
                              : "مُرحَّل"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {sheet.isLoading && (
                  <tr>
                    <td colSpan={6}>
                      <LoadingState />
                    </td>
                  </tr>
                )}
                {!sheet.isLoading && rows.length === 0 && (
                  <TableEmptyRow
                    colSpan={6}
                    message="لا بطاقات فعّالة لهذا المزوّد في هذا الفرع."
                  />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>
    </div>
  );
}
