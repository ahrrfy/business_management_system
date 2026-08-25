/* ============================================================================
 * شاشة «تشغيلات العمولة» — وحدة الأهداف والعمولات (S3). مرآة UX شاشة الرواتب.
 *
 * دورة الحياة: احتساب (مسوّدة) → اعتماد (SOD: المعتمِد ≠ المحتسِب) → يلتقطها مسيّر
 * الرواتب لنفس الشهر (S4). إعادة الاحتساب والحذف على المسوّدة فقط؛ إلغاء الاعتماد
 * ممنوع بعد الالتقاط أو وجود شهر أحدث (سلسلة الترحيل). كل الأرقام من الخادم (لقطات).
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { CommissionGuide } from "@/components/commissions/CommissionGuide";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MonthPicker, thisMonth } from "@/components/form/MonthPicker";
import { confirm, confirmDelete } from "@/lib/confirm";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { exportRows } from "@/lib/export";
import { fmtDate } from "@/lib/date";
import { D, fmtAr, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { printCommissionStatementV2 } from "@/lib/printing/printCommissionV2";
import { Calculator, Check, FileDown, Link2, Printer, RotateCcw, Trash2, TrendingUp, Undo2, Wallet } from "lucide-react";
import { Link } from "wouter";
import { useMemo, useState } from "react";
import { selectClsSm } from "@/lib/ui/formStyles";


const STATUS_LABEL: Record<string, string> = { draft: "مسوّدة", approved: "معتمدة" };
const STATUS_CLS: Record<string, string> = { draft: "badge-stock-low", approved: "badge-status-active" };

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${STATUS_CLS[status] ?? "bg-muted text-muted-foreground"}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function StatCard({ label, value, sub, accent, icon }: { label: string; value: string; sub?: string; accent?: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-xs">{label}</div>
          <span style={{ color: accent }}>{icon}</span>
        </div>
        <div className="mt-1 text-2xl font-bold tabular-nums" dir="ltr" style={{ color: accent }}>{value}</div>
        {sub && <div className="text-muted-foreground text-xs mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** شريط تقدّم الإنجاز — أخضر عند بلوغ الهدف، أزرق دونه. */
function AchievementBar({ pct }: { pct: number }) {
  const capped = Math.max(0, Math.min(pct, 130));
  const reached = pct >= 100;
  return (
    <div className="min-w-28">
      <div className="flex items-center justify-between text-[11px] tabular-nums" dir="ltr">
        <span className={reached ? "text-money-positive font-bold" : "text-muted-foreground"}>{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={`h-full rounded-full ${reached ? "bg-[var(--money-positive,#059669)]" : "bg-primary"}`}
          style={{ width: `${(capped / 130) * 100}%` }}
        />
      </div>
    </div>
  );
}

type RunDetail = NonNullable<RouterOutputs["commissions"]["runs"]["get"]>;
type RunLine = RunDetail["lines"][number];

export default function CommissionRuns() {
  const utils = trpc.useUtils();
  // بوّابة عرض مطابقة للخادم: الكتابة (احتساب/اعتماد/حذف) commissionsManagerProcedure(["manager"],"commissions","FULL")
  // — نفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد. القراءة (accountant/auditor) عرض وكشوف فقط.
  const me = trpc.auth.me.useQuery();
  const canWrite = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "commissions", "FULL", ["manager"]);
  const runsQ = trpc.commissions.runs.list.useQuery();
  const runs = runsQ.data ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const effectiveId = selectedId ?? (runs.length ? Number(runs[0].id) : null);
  const runQ = trpc.commissions.runs.get.useQuery({ id: effectiveId ?? 0 }, { enabled: effectiveId != null });
  const run = runQ.data ?? null;

  const [computeOpen, setComputeOpen] = useState(false);
  const [computePeriod, setComputePeriod] = useState(thisMonth());
  const [detailLine, setDetailLine] = useState<RunLine | null>(null);

  const refresh = async () => {
    await Promise.all([utils.commissions.runs.list.invalidate(), utils.commissions.runs.get.invalidate()]);
  };

  const compute = trpc.commissions.runs.compute.useMutation({
    onSuccess: async (r) => {
      notify.ok(r.recomputed ? "أُعيد احتساب كشف الشهر" : "احتُسب كشف عمولات الشهر (مسوّدة)");
      setComputeOpen(false);
      setSelectedId(r.runId);
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const approve = trpc.commissions.runs.approve.useMutation({
    onSuccess: async (r) => {
      notify.ok("اعتُمد كشف العمولات");
      if (r.requiresPayrollRegeneration) {
        notify.errBig(
          "مسيّر رواتب هذا الشهر ما يزال مسوّدة",
          "أعد توليد المسيّر من تبويب «الرواتب» كي يظهر فيه بند العمولة (احذف المسوّدة ثم ولّدها مجدداً).",
        );
      }
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const unapprove = trpc.commissions.runs.unapprove.useMutation({
    onSuccess: async () => { notify.ok("أُلغي الاعتماد — عاد الكشف مسوّدةً"); await refresh(); },
    onError: (e) => notify.err(e),
  });
  const remove = trpc.commissions.runs.remove.useMutation({
    onSuccess: async () => { notify.ok("حُذفت المسوّدة"); setSelectedId(null); await refresh(); },
    onError: (e) => notify.err(e),
  });

  const lines = run?.lines ?? [];
  const isDraft = run?.status === "draft";
  const isApproved = run?.status === "approved";
  const busy = compute.isPending || approve.isPending || unapprove.isPending || remove.isPending;

  const stats = useMemo(() => {
    const netBase = run ? round2(D(run.totalBaseSales).minus(D(run.totalBaseReturns))).toFixed(2) : "0";
    let reached = 0;
    let withTarget = 0;
    let carryNeg = D(0);
    let effectiveSum = D(0);
    for (const l of lines) {
      if (l.targetAmount != null) {
        withTarget++;
        if (l.achievementPct != null && D(l.achievementPct).gte(100)) reached++;
      }
      carryNeg = carryNeg.plus(D(l.carryOut));
      effectiveSum = effectiveSum.plus(D(l.effectiveBase));
    }
    return {
      netBase,
      commission: run?.totalCommission ?? "0",
      reached,
      withTarget,
      carryNeg: round2(carryNeg).toFixed(2),
      effectiveSum: round2(effectiveSum).toFixed(2),
    };
  }, [run, lines]);

  function printStatement(l: RunLine) {
    if (!run) return;
    const d = (l.detail ?? {}) as { tierMode?: "TARGET_PCT" | "AMOUNT_SLAB"; tierThreshold?: string | null; planName?: string };
    printCommissionStatementV2({
      runId: Number(run.id),
      period: run.period,
      statusLabel: STATUS_LABEL[run.status] ?? run.status,
      employeeName: l.employeeName,
      position: l.position,
      planName: l.planName ?? d.planName ?? "—",
      tierMode: d.tierMode ?? "TARGET_PCT",
      baseSales: l.baseSales,
      baseReturns: l.baseReturns,
      consignDeduction: l.baseConsignDeduction,
      carryIn: l.carryIn,
      effectiveBase: l.effectiveBase,
      targetAmount: l.targetAmount,
      achievementPct: l.achievementPct,
      tierApplied: l.tierIndex != null,
      tierThreshold: d.tierThreshold,
      ratePct: l.ratePct,
      fixedBonus: l.fixedBonus,
      commissionAmount: l.commissionAmount,
      carryOut: l.carryOut,
      computedAt: fmtDate(run.computedAt),
    });
  }

  function exportExcel() {
    if (!run) return;
    exportRows(lines, {
      filename: `عمولات-${run.period}`,
      title: `كشف عمولات ${run.period} — ${STATUS_LABEL[run.status]}`,
      columns: [
        { key: "employeeName", header: "الموظف" },
        { key: "planName", header: "الخطة" },
        { key: "baseSales", header: "المبيعات", money: true },
        { key: "baseReturns", header: "المرتجعات", money: true },
        { key: "carryIn", header: "مرحَّل من السابق", money: true },
        { key: "effectiveBase", header: "المبلغ المحتسَب عليه", money: true },
        { key: "targetAmount", header: "الهدف", money: true },
        { key: "achievementPct", header: "نسبة التحقيق ٪" },
        { key: "ratePct", header: "النسبة ٪" },
        { key: "fixedBonus", header: "مكافأة ثابتة", money: true },
        { key: "commissionAmount", header: "العمولة", money: true },
        { key: "carryOut", header: "يُرحَّل للقادم", money: true },
      ],
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="احتساب العمولات الشهري"
        description="في نهاية كل شهر يجمع النظام مبيعات كل بائع من الفواتير، يطرح مرتجعاته، ثم يطبّق خطته ويخرج عمولته. يبدأ الكشف «مسوّدة» قابلة للتعديل، ويعتمده شخص غير الذي احتسبه، ثم يُصرَف بنداً في مسيّر رواتب الشهر نفسه."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <select
              className={selectClsSm}
              value={effectiveId != null ? String(effectiveId) : ""}
              onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
              aria-label="كشف الشهر"
            >
              {runs.length === 0 && <option value="">لا كشوف بعد</option>}
              {runs.map((r) => (
                <option key={r.id} value={String(r.id)}>
                  عمولات {r.period} — {STATUS_LABEL[r.status]}
                </option>
              ))}
            </select>
            {canWrite && (
              <Button onClick={() => setComputeOpen(true)} disabled={busy}>
                <Calculator className="size-4" /> احتساب شهر
              </Button>
            )}
          </div>
        }
      />

      <CommissionGuide />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="المبيعات المحتسَبة" value={iqd(stats.netBase)} sub="المبيعات بعد خصم المرتجعات (د.ع)" icon={<Wallet className="size-4" />} />
        <StatCard label="إجمالي العمولات" value={iqd(stats.commission)} sub="د.ع مستحقة للموظفين" accent="var(--status-done, #059669)" icon={<Check className="size-4" />} />
        <StatCard label="حقّقوا هدفهم" value={`${stats.reached}/${stats.withTarget}`} sub="موظف بلغ 100% من هدفه" accent="var(--status-active, #2563eb)" icon={<TrendingUp className="size-4" />} />
        <StatCard label="يُرحَّل للشهر القادم" value={iqd(stats.carryNeg)} sub="سالب يُخصم من عمولة الشهر القادم" accent="var(--money-negative, #dc2626)" icon={<Undo2 className="size-4" />} />
      </div>

      {run && (
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={run.status} />
          <span className="text-sm text-muted-foreground">عمولات {run.period} — {run.employeeCount} موظف</span>
          {run.payrollRunId != null && (
            <Link href="/hr?tab=payroll" className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary hover:underline">
              <Link2 className="size-3" aria-hidden /> أُدرجت في مسيّر رواتب {run.period}
            </Link>
          )}
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={exportExcel} disabled={lines.length === 0}>
            <FileDown className="size-4" /> Excel
          </Button>
          {isDraft && canWrite && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  if (!(await confirm({ variant: "warning", title: `إعادة احتساب عمولات ${run.period}`, description: "ستُستبدل كل الأسطر بأرقام المبيعات والخطط والأهداف كما هي الآن. متابعة؟", confirmText: "إعادة الاحتساب" }))) return;
                  compute.mutate({ period: run.period });
                }}
              >
                <RotateCcw className="size-4" /> إعادة الاحتساب
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={async () => {
                  if (!(await confirm({ variant: "warning", title: `اعتماد عمولات ${run.period}`, description: `سيُقفل التعديل ويصبح الكشف جاهزاً للإدراج في مسيّر رواتب ${run.period} (إجمالي العمولات ${iqd(run.totalCommission)} د.ع). يشترط النظام أن يعتمده شخص غير الذي احتسبه.`, confirmText: "اعتماد" }))) return;
                  approve.mutate({ id: Number(run.id) });
                }}
              >
                <Check className="size-4" /> اعتماد
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                disabled={busy}
                onClick={async () => {
                  if (!(await confirmDelete({ description: `حذف مسوّدة عمولات ${run.period} وكل أسطرها (${run.employeeCount} موظف)؟` }))) return;
                  remove.mutate({ id: Number(run.id) });
                }}
              >
                <Trash2 className="size-4" /> حذف المسوّدة
              </Button>
            </>
          )}
          {isApproved && canWrite && run.payrollRunId == null && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              disabled={busy}
              onClick={async () => {
                if (!(await confirm({ variant: "danger", title: `إلغاء اعتماد عمولات ${run.period}`, description: "يعود الكشف مسوّدةً قابلة لإعادة الاحتساب. ممنوع إن أُدرج في مسيّر رواتب أو وُجد كشف لشهر أحدث.", confirmText: "إلغاء الاعتماد" }))) return;
                unapprove.mutate({ id: Number(run.id) });
              }}
            >
              <Undo2 className="size-4" /> إلغاء الاعتماد
            </Button>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{run ? `عمولات ${run.period} — ${lines.length} موظف` : "احتساب العمولات الشهري"}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2.5 text-start">الموظف</th>
                  <th className="p-2.5 text-right">المبيعات</th>
                  <th className="p-2.5 text-right">المرتجعات</th>
                  {/* بلا whitespace-nowrap: تسميات مفهومة تُلَفّ على سطرين أفضل من ترويسة
                      مختصرة غامضة أو من جدول يتجاوز عرض الشاشة. */}
                  <th className="p-2.5 text-right">مرحَّل من السابق</th>
                  <th className="p-2.5 text-right">المبلغ المحتسَب عليه</th>
                  <th className="p-2.5 text-right">هدفه</th>
                  <th className="p-2.5">نسبة التحقيق</th>
                  <th className="p-2.5 text-center">المستوى المطبَّق</th>
                  <th className="p-2.5 text-right">عمولته</th>
                  <th className="p-2.5 text-right">يُرحَّل للقادم</th>
                  <th className="p-2.5 text-center"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const detail = (l.detail ?? {}) as { noTarget?: boolean; planName?: string };
                  return (
                    <tr key={l.id} className="border-t hover:bg-accent/40">
                      <td className="p-2.5">
                        <div className="flex items-center gap-2.5">
                          <EmpAvatar name={l.employeeName} color={l.colorTag} photoUrl={l.photoUrl} sizePx={32} />
                          <div className="min-w-0">
                            <div className="font-medium text-[13px] whitespace-nowrap">{l.employeeName}</div>
                            {/* اسم الخطة قد يطول — يُقصّ بدل توسيع العمود ودفع الجدول خارج الشاشة. */}
                            <div
                              className="max-w-[11rem] truncate text-[11px] text-muted-foreground"
                              title={l.planName ?? detail.planName ?? undefined}
                            >
                              {l.planName ?? detail.planName ?? "—"}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{iqd(l.baseSales)}</td>
                      <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">
                        {D(l.baseReturns).gt(0) ? `−${iqd(l.baseReturns)}` : "—"}
                      </td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">
                        {D(l.carryIn).isZero() ? "—" : iqd(l.carryIn)}
                      </td>
                      <td className="p-2.5 text-right tabular-nums font-medium" dir="ltr">{iqd(l.effectiveBase)}</td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">
                        {l.targetAmount != null ? iqd(l.targetAmount) : "—"}
                      </td>
                      <td className="p-2.5">
                        {l.achievementPct != null ? (
                          <AchievementBar pct={Number(l.achievementPct)} />
                        ) : detail.noTarget ? (
                          <span className="inline-block rounded-full px-2 py-0.5 text-[11px] badge-stock-low">بلا هدف</span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="p-2.5 text-center tabular-nums text-xs" dir="ltr">
                        {l.tierIndex != null ? `${fmtAr(l.ratePct)}%${D(l.fixedBonus).gt(0) ? ` +${iqd(l.fixedBonus)}` : ""}` : "—"}
                      </td>
                      <td className="p-2.5 text-right tabular-nums font-bold" dir="ltr">{iqd(l.commissionAmount)}</td>
                      <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">
                        {D(l.carryOut).isZero() ? "—" : iqd(l.carryOut)}
                      </td>
                      <td className="p-2.5 text-center whitespace-nowrap">
                        <button onClick={() => printStatement(l)} className="text-xs text-primary font-medium hover:underline inline-flex items-center gap-1">
                          <Printer className="size-3.5" aria-hidden /> كشف
                        </button>
                        <button onClick={() => setDetailLine(l)} className="text-xs text-muted-foreground font-medium hover:underline ms-3">
                          تفاصيل
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {lines.length > 0 && run && (
                  <tr className="border-t-2 bg-muted/40 font-bold">
                    <td className="p-2.5">الإجمالي</td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{iqd(run.totalBaseSales)}</td>
                    <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">−{iqd(run.totalBaseReturns)}</td>
                    <td></td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{iqd(stats.effectiveSum)}</td>
                    <td colSpan={3}></td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{iqd(run.totalCommission)}</td>
                    <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">{iqd(stats.carryNeg)}</td>
                    <td></td>
                  </tr>
                )}
                {runQ.isLoading && effectiveId != null && (
                  <tr><td colSpan={11}><LoadingState /></td></tr>
                )}
                {!runQ.isLoading && lines.length === 0 && (
                  <TableEmptyRow colSpan={11} message={runs.length === 0 ? "لا كشوف عمولات بعد — اضغط «احتساب شهر» للبدء." : "لا أسطر في كشف هذا الشهر."} />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* حوار احتساب شهر */}
      <Dialog open={computeOpen} onOpenChange={(o) => !o && setComputeOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>احتساب عمولات شهر</DialogTitle>
            <DialogDescription>
              لكل بائع: صافي فواتيره (بعد الخصم) ناقص مرتجعات الشهر — والمرتجع يُخصم من البائع الأصلي لا من غيره —
              ثمّ يُضاف المرحَّل من الشهر السابق. فاتورة أمر الشغل تُحسب لمن أنشأ أمر الشغل لا لمن سلّمه.
              وإن خرج المجموع سالباً رُحِّل إلى الشهر التالي.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 flex justify-center">
            <MonthPicker value={computePeriod} onChange={setComputePeriod} max={thisMonth()} ariaLabel="شهر الاحتساب" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setComputeOpen(false)}>إلغاء</Button>
            <Button onClick={() => compute.mutate({ period: computePeriod })} disabled={compute.isPending}>
              {compute.isPending ? "جارٍ الاحتساب…" : "احتساب"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار تفاصيل سطر */}
      <Dialog open={!!detailLine} onOpenChange={(o) => !o && setDetailLine(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>تفاصيل الاحتساب — {detailLine?.employeeName}</DialogTitle></DialogHeader>
          {detailLine && (() => {
            const d = (detailLine.detail ?? {}) as {
              planName?: string; tierMode?: string; tierThreshold?: string | null;
              saleEntryCount?: number; returnEntryCount?: number; noTarget?: boolean;
            };
            const row = (label: string, value: React.ReactNode, cls = "") => (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{label}</span>
                <span className={`tabular-nums ${cls}`} dir="ltr">{value}</span>
              </div>
            );
            return (
              <div className="space-y-2 py-1">
                {row("الخطة", d.planName ?? detailLine.planName ?? "—")}
                {row("عدد فواتير البيع / المرتجع", `${d.saleEntryCount ?? 0} / ${d.returnEntryCount ?? 0}`)}
                {row("المبيعات", iqd(detailLine.baseSales))}
                {row("المرتجعات", `−${iqd(detailLine.baseReturns)}`, "text-money-negative")}
                {row("مرحَّل من الشهر السابق", iqd(detailLine.carryIn))}
                <div className="border-t pt-2">{row("المبلغ المحتسَب عليه", iqd(detailLine.effectiveBase), "font-bold")}</div>
                {detailLine.targetAmount != null && row("هدفه الشهري", iqd(detailLine.targetAmount))}
                {detailLine.achievementPct != null && row("نسبة تحقيق الهدف", `${fmtAr(detailLine.achievementPct)}%`)}
                {d.noTarget && (
                  <p className="text-xs text-destructive">لا هدف محدَّداً لهذا الشهر — وخطة «حسب نسبة تحقيق الهدف» بلا هدف تعطي صفراً. حدّد هدفه من تبويب «الأهداف الشهرية» ثم أعد الاحتساب.</p>
                )}
                {row(
                  "المستوى المطبَّق",
                  detailLine.tierIndex != null ? `من ${d.tierThreshold ?? "?"} ← ${fmtAr(detailLine.ratePct)}%` : "لم يبلغ أي مستوى",
                )}
                {D(detailLine.fixedBonus).gt(0) && row("مكافأة ثابتة", `+${iqd(detailLine.fixedBonus)}`, "text-money-positive")}
                <div className="border-t pt-2">{row("العمولة المستحقّة", iqd(detailLine.commissionAmount), "font-bold text-money-positive")}</div>
                {!D(detailLine.carryOut).isZero() && row("يُرحَّل للشهر القادم", iqd(detailLine.carryOut), "text-money-negative")}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailLine(null)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
