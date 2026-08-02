// شاشة «أسعار الكروت اليوم» (ش٤). حقلٌ واحد لكل صفّ: حصة المزوّد (تكلفة الجهاز).
// سعر البيع والهامش يأتيان **من الخادم** عبر معاينة مُشتقّة من نفس دالة التسعير المُختبَرة —
// عمداً لا تُعاد المعادلة هنا (§٧.٣ من وثيقة التصميم).
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { MoneyInput } from "@/components/form/MoneyInput";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import {
  CopyPlus,
  Send,
  Save,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

/** تاريخ اليوم بصيغة YYYY-MM-DD (توقيت الجهاز — يوم العمل التشغيليّ للمستخدم). */
function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function DigitalPricing() {
  const utils = trpc.useUtils();
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

  const activeProviders = useMemo(
    () => (providers.data ?? []).filter((p) => p.isActive),
    [providers.data],
  );

  // فرع افتراضي: فرع المستخدم إن كان مُسنَداً، وإلا أوّل فرع.
  useEffect(() => {
    if (branchId != null) return;
    const mine = me.data?.branchId;
    if (mine != null) {
      setBranchId(Number(mine));
      return;
    }
    const first = branches.data?.[0]?.id;
    if (first != null) setBranchId(Number(first));
  }, [branchId, me.data?.branchId, branches.data]);

  useEffect(() => {
    if (providerId == null && activeProviders.length)
      setProviderId(activeProviders[0].id);
  }, [providerId, activeProviders]);

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

  // تحميل الحصص من المسودّة/السعر المُرحَّل عند وصول الكشف.
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

  // لا نعيد ضبط ما يكتبه المدير عند كل إعادة جلب؛ نحمّل السبب فقط عند تبدّل المسودّة نفسها.
  useEffect(() => {
    setChangeReason(sheet.data?.batch?.changeReason ?? "");
  }, [sheet.data?.batch?.id]);

  // معاينة خادمية مُهدّأة (debounce) لكل الصفوف المملوءة.
  const [previewInput, setPreviewInput] = useState<
    { offeringId: number; providerShare: string; sellPrice: string }[]
  >([]);
  useEffect(() => {
    const t = setTimeout(() => {
      setPreviewInput(
        Object.entries(costs)
          .filter(
            ([key, cost]) =>
              cost !== "" &&
              cost != null &&
              (sellPrices[Number(key)] ?? "") !== "",
          )
          .map(([key, cost]) => ({
            offeringId: Number(key),
            providerShare: cost,
            sellPrice: sellPrices[Number(key)],
          })),
      );
    }, 350);
    return () => clearTimeout(t);
  }, [costs, sellPrices]);

  const preview = trpc.digitalCards.pricing.preview.useQuery(
    { branchId: branchId!, providerId: providerId!, lines: previewInput },
    { enabled: scopeReady && previewInput.length > 0 },
  );
  const previewById = useMemo(
    () => new Map((preview.data ?? []).map((p) => [p.offeringId, p])),
    [preview.data],
  );

  function invalidate() {
    void utils.digitalCards.pricing.getMorningSheet.invalidate();
    void utils.digitalCards.pricing.mismatchReports.invalidate();
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
      notify.ok(`حُفظت مسودّة ${r.savedCount} سعراً`);
    },
    onError: (e) => notify.err(e),
  });
  const publishMut = trpc.digitalCards.pricing.publish.useMutation({
    onSuccess: (r) => {
      invalidate();
      notify.ok(
        `نُشر ${r.publishedCount} سعراً`,
        "الأسعار نافذة في الكاشير الآن",
      );
    },
    onError: (e) => notify.err(e),
  });
  const approveMut = trpc.digitalCards.pricing.approveMismatch.useMutation({
    onSuccess: () => {
      invalidate();
      notify.ok("اعتُمد البلاغ ونُشر سعر جديد");
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
      notify.ok("أُلغيت المسودّة", "الأسعار النافذة لم تتغيّر.");
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
    return Object.entries(costs)
      .filter(
        ([key, cost]) =>
          cost !== "" && cost != null && (sellPrices[Number(key)] ?? "") !== "",
      )
      .map(([key, cost]) => ({
        offeringId: Number(key),
        providerShare: cost,
        sellPrice: sellPrices[Number(key)],
      }));
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
        title: "نشر أسعار اليوم",
        description: `ستصبح ${lines.length} بطاقة قابلةً للبيع بأسعارها الجديدة فوراً، وتُسوَّد الأسعار السابقة. النشر لا يُلغى — التصحيح يكون بنشر دُفعة جديدة. متابعة؟`,
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

  const draftBatchId = sheet.data?.batch?.id ?? null;

  async function cancelDraft() {
    if (draftBatchId == null) return;
    if (
      !(await confirm({
        variant: "danger",
        title: "إلغاء المسودّة",
        description:
          "ستُحذف الحصص المحفوظة لهذا اليوم ويعود الكشف فارغاً. الأسعار النافذة في الكاشير لا تتأثّر. متابعة؟",
        confirmText: "إلغاء المسودّة",
      }))
    )
      return;
    cancelMut.mutate({ batchId: draftBatchId });
  }

  const rows = sheet.data?.rows ?? [];
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
  // مرآة حارس الخادم: لا يعتمد مُنشئ المسودّة (admin مُستثنى) ⇒ لا زرٌّ يعِد بما يُرفَض.
  const canApproveBig =
    me.data?.role === "admin" || Number(me.data?.id) !== Number(draftCreatedBy);
  const bigChangeBlocking = bigChanges.length > 0 && bigApprovedBy == null;

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
            <select
              id="dp-branch"
              className={selectCls}
              value={branchId ?? ""}
              onChange={(e) =>
                setBranchId(e.target.value ? Number(e.target.value) : null)
              }
            >
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="dp-provider">
              المزوّد
            </label>
            <select
              id="dp-provider"
              className={selectCls}
              value={providerId ?? ""}
              onChange={(e) =>
                setProviderId(e.target.value ? Number(e.target.value) : null)
              }
            >
              {activeProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.supplierName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="dp-date">
              تاريخ يوم العمل
            </label>
            <input
              id="dp-date"
              type="date"
              className={selectCls}
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
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">البطاقة</th>
                    <th className="p-2 text-start">التكلفة النافذة</th>
                    <th className="p-2 text-start">التكلفة الجديدة</th>
                    <th className="p-2 text-start">نسبة التغيّر</th>
                  </tr>
                </thead>
                <tbody>
                  {bigChanges.map((b) => (
                    <tr key={b.offeringId} className="border-t">
                      <td className="p-2 font-medium">{b.name}</td>
                      <td className="p-2 tabular-nums text-muted-foreground">
                        {fmtAr(b.currentShare)}
                      </td>
                      <td className="p-2 tabular-nums font-medium">
                        {fmtAr(b.newShare)}
                      </td>
                      <td className="p-2 tabular-nums text-destructive font-medium">
                        {b.changePercent}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
            <div className="flex flex-wrap items-center gap-3 px-4 pb-4 text-sm text-muted-foreground">
              {bigApprovedBy != null ? (
                <span>
                  اعتُمد النشر. أيّ تعديل على المسودّة بعد الآن يُبطل الاعتماد
                  ويعيد طلبه.
                </span>
              ) : (
                <>
                  <span>
                    النشر موقوفٌ حتى يعتمده مديرٌ آخر غير مُنشئ المسودّة.
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
                        ? "لا تعتمد تغييراً في مسودّةٍ أنشأتَها — يلزم مديرٌ آخر"
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
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">البطاقة</th>
                    <th className="p-2 text-start">المزوّد</th>
                    <th className="p-2 text-start">التكلفة في النظام</th>
                    <th className="p-2 text-start">
                      التكلفة التي أبلغ بها الكاشير
                    </th>
                    <th className="p-2 text-start">ملاحظة</th>
                    <th className="p-2 text-center">قرار</th>
                  </tr>
                </thead>
                <tbody>
                  {openReports.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="p-2 font-medium">{r.offeringName}</td>
                      <td className="p-2 text-muted-foreground">
                        {r.providerName}
                      </td>
                      <td className="p-2 tabular-nums">
                        {fmtAr(r.currentProviderShare)}
                      </td>
                      <td className="p-2 tabular-nums font-medium">
                        {fmtAr(r.reportedProviderShare)}
                      </td>
                      <td className="p-2 text-muted-foreground">
                        {r.notes || "—"}
                      </td>
                      <td className="p-2 text-center">
                        <div className="flex justify-center gap-2">
                          <Button
                            size="sm"
                            disabled={approveMut.isPending}
                            onClick={() =>
                              approveMut.mutate({
                                reportId: r.id,
                                businessDate,
                              })
                            }
                          >
                            اعتماد ونشر
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={rejectMut.isPending}
                            onClick={() => rejectMut.mutate({ reportId: r.id })}
                          >
                            رفض
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
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
            {sheet.data?.batch ? " — مسودّة محفوظة" : ""}
          </span>
          <div className="flex gap-2">
            {draftBatchId != null && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void cancelDraft()}
              >
                <Trash2 className="size-4" /> إلغاء المسودّة
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!scopeReady || busy}
              onClick={saveDraft}
            >
              <Save className="size-4" /> حفظ مسودّة
            </Button>
            <Button
              size="sm"
              disabled={
                !scopeReady || busy || rows.length === 0 || bigChangeBlocking
              }
              title={
                bigChangeBlocking
                  ? `تغييرٌ ≥${threshold}% ينتظر اعتماد مديرٍ آخر`
                  : undefined
              }
              onClick={() => void publish()}
            >
              <Send className="size-4" /> نشر الأسعار
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
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
                              ? "مسودّة"
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
