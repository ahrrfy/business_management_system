// تقارير مركز واتساب (S6، T6.2) — تستهلك الأربعة endpoints التي بناها T6.1
// (server/services/reports/whatsappReports.ts) خلف بوّابة التقارير الحمراء (reportViewerProcedure).
// أربعة أقسام بتبويبات تشترك نطاق تاريخ + منتقي فرع للأدمن (نمط تقارير المركز القائم — ReportShell):
//   ١) الاستجابة والحل — زمن أول ردّ/حلّ P50/P90 + التزام SLA + الحل من أول تواصل + إعادة الفتح.
//   ٢) أحجام الموظفين — **حِمل عمل لا مراقبة أداء** (لا رسائل/زمن اتصال، فقط إسناد/إنجاز/CSAT).
//   ٣) رضا العملاء CSAT — توزيع الدرجات + المتوسط + معدّل الاستجابة.
//   ٤) أداء الحملات — قمع أُرسل→سُلّم→قُرئ لكل حملة + الكلفة التقديرية مقابل الفعلية.
// لا اعتماديات جديدة — القمع/التوزيع بأشرطة CSS بسيطة (لا مكتبة رسوم).
import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem, type KpiTone } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { exportRows } from "@/lib/export";
import { fmtAr, formatIqd } from "@/lib/money";
import { KIND_LABEL, type TaskKind } from "@/pages/TasksHub";
import { Star } from "lucide-react";

type TaskResponseData = RouterOutputs["reports"]["whatsappTaskResponse"];
type KindRow = TaskResponseData["byKind"][number];
type AgentVolumeData = RouterOutputs["reports"]["whatsappAgentVolume"];
type AgentRow = AgentVolumeData["rows"][number];
type CsatData = RouterOutputs["reports"]["whatsappCsat"];
type CampaignData = RouterOutputs["reports"]["whatsappCampaignPerformance"];
type CampaignRow = CampaignData["rows"][number];

type TabKey = "response" | "agents" | "csat" | "campaigns";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const dateCls = selectCls;

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "danger" | "info" | "neutral";

const CAMPAIGN_STATUS_META: Record<string, { label: string; variant: BadgeVariant }> = {
  DRAFT: { label: "مسودة", variant: "neutral" },
  PENDING_APPROVAL: { label: "بانتظار الاعتماد", variant: "warning" },
  APPROVED: { label: "معتمدة", variant: "success" },
  RUNNING: { label: "قيد التشغيل", variant: "success" },
  PAUSED: { label: "موقوفة مؤقتاً", variant: "warning" },
  COMPLETED: { label: "مكتملة", variant: "info" },
  CANCELLED: { label: "ملغاة", variant: "neutral" },
};

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return ymdLocal(d);
}

/** ١٢.٣٠ ⇒ "12.3" بلا صفر عشري زائد. */
function trimNum(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
/** دقائق → عرض مقروء: أقلّ من ساعة بالدقائق، وإلا بالساعات. null ⇒ «—» (لم تُلتقط بعد). */
function fmtMinutes(v: string | null): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n < 60) return `${trimNum(n)} د`;
  return `${trimNum(n / 60)} س`;
}
/** نِسَب الخادم مُنسَّقة سلفاً "12.34" (٠-١٠٠) — عرضٌ مباشر بلا إعادة حساب. */
function fmtPctStr(v: string | null): string {
  return v == null ? "—" : `${v}%`;
}
function pctTone(v: string | null, goodAt = 90, warnAt = 70): KpiTone {
  if (v == null) return "default";
  const n = Number(v);
  if (!Number.isFinite(n)) return "default";
  if (n >= goodAt) return "positive";
  if (n >= warnAt) return "warning";
  return "negative";
}

const TASK_RESPONSE_NOTE =
  "زمن أول ردّ/حلّ يُحسَب من إنشاء المهمّة. «SLA» يشمل مهامّاً محلولة ولها موعد استحقاق مضبوط فقط. «الحلّ من أوّل تواصل» = محلولة بلا أي إعادة فتح.";
const AGENT_VOLUME_NOTE =
  "قياس حِمل عمل وجودة خدمة — لا مراقبة أداء فردية (لا عدّ رسائل ولا زمن اتصال/أونلاين، فقط الإسناد والإنجاز وCSAT).";

export default function WhatsappHubReport() {
  const [from, setFrom] = useState<string>(defaultFrom);
  const [to, setTo] = useState<string>(() => ymdLocal(new Date()));
  const [branchId, setBranchId] = useState<number | "">("");
  const [tab, setTab] = useState<TabKey>("response");

  const branches = trpc.branches.list.useQuery();
  const input = { from, to, branchId: branchId ? Number(branchId) : undefined };

  const taskResponseQ = trpc.reports.whatsappTaskResponse.useQuery(input, { staleTime: 60_000 });
  const agentVolumeQ = trpc.reports.whatsappAgentVolume.useQuery(input, { staleTime: 60_000 });
  const csatQ = trpc.reports.whatsappCsat.useQuery(input, { staleTime: 60_000 });
  const campaignQ = trpc.reports.whatsappCampaignPerformance.useQuery(input, { staleTime: 60_000 });

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";
  const branchName = (id: number | null): string => {
    if (id == null) return "عام (كل الفروع)";
    return branches.data?.find((b) => b.id === id)?.name ?? String(id);
  };

  const kpis: KpiItem[] = useMemo(() => {
    if (tab === "response") {
      const o = taskResponseQ.data?.overall;
      if (!o) return [];
      return [
        { label: "إجمالي المهام", value: fmtAr(o.totalTasks) },
        { label: "أول ردّ P50", value: fmtMinutes(o.firstResponseP50Minutes), tone: "info" },
        { label: "أول ردّ P90", value: fmtMinutes(o.firstResponseP90Minutes), tone: "info" },
        { label: "زمن الحلّ P50", value: fmtMinutes(o.resolutionP50Minutes), tone: "info" },
        { label: "زمن الحلّ P90", value: fmtMinutes(o.resolutionP90Minutes), tone: "info" },
        {
          label: "الالتزام بـSLA",
          value: fmtPctStr(o.slaCompliancePct),
          tone: pctTone(o.slaCompliancePct),
          hint: `${o.slaMet} من ${o.slaEligible} مؤهَّلة`,
        },
        { label: "الحلّ من أوّل تواصل", value: fmtPctStr(o.firstContactResolutionPct), tone: pctTone(o.firstContactResolutionPct, 80, 50) },
        {
          label: "إعادة الفتح",
          value: fmtPctStr(o.reopenedPct),
          tone: o.reopenedCount > 0 ? "warning" : "default",
          hint: `${o.reopenedCount} مهمّة`,
        },
      ];
    }
    if (tab === "agents") {
      const rows = agentVolumeQ.data?.rows ?? [];
      if (!agentVolumeQ.data) return [];
      const totalAssigned = rows.reduce((s, r) => s + r.assigned, 0);
      const totalResolved = rows.reduce((s, r) => s + r.resolved, 0);
      const totalOpen = rows.reduce((s, r) => s + r.open, 0);
      return [
        { label: "موظفون نشطون", value: fmtAr(rows.length) },
        { label: "إجمالي المُسنَد", value: fmtAr(totalAssigned) },
        { label: "إجمالي المحلول", value: fmtAr(totalResolved), tone: "positive" },
        { label: "مفتوحة الآن", value: fmtAr(totalOpen), tone: totalOpen > 0 ? "warning" : "default" },
      ];
    }
    if (tab === "csat") {
      const d = csatQ.data;
      if (!d) return [];
      return [
        { label: "طُلب تقييمها", value: fmtAr(d.requested) },
        { label: "أُجيبت", value: fmtAr(d.answered), tone: "info" },
        { label: "معدّل الاستجابة", value: fmtPctStr(d.responseRatePct), tone: pctTone(d.responseRatePct, 50, 25) },
        {
          label: "متوسط الدرجة",
          value: d.average ? `${d.average} / ٥` : "—",
          tone: d.average ? (Number(d.average) >= 4 ? "positive" : Number(d.average) >= 3 ? "warning" : "negative") : "default",
        },
      ];
    }
    const s = campaignQ.data?.summary;
    if (!s) return [];
    return [
      { label: "حملات", value: fmtAr(s.campaigns) },
      { label: "مستلمون", value: fmtAr(s.totalRecipients) },
      { label: "معدّل التسليم", value: fmtPctStr(s.deliveryRatePct), tone: pctTone(s.deliveryRatePct, 80, 50) },
      { label: "معدّل القراءة", value: fmtPctStr(s.readRatePct), tone: "info" },
      { label: "معدّل الفشل", value: fmtPctStr(s.failureRatePct), tone: Number(s.failureRatePct) > 10 ? "negative" : "default" },
      { label: "الكلفة الفعلية", value: formatIqd(s.actualCost), tone: "info", hint: `تقديرية ${formatIqd(s.costEstimate)}` },
    ];
  }, [tab, taskResponseQ.data, agentVolumeQ.data, csatQ.data, campaignQ.data]);

  function onExport() {
    const periodMeta = [
      { label: "الفترة", value: `${from} — ${to}` },
      { label: "الفرع", value: branchLabel },
    ];
    if (tab === "response") {
      const rows = taskResponseQ.data?.byKind ?? [];
      exportRows(rows, {
        filename: `تقارير-واتساب-الاستجابة-والحل-${from}-${to}`,
        title: "تقارير مركز واتساب — الاستجابة والحل",
        meta: periodMeta,
        columns: [
          { key: "kind", header: "النوع", map: (r) => KIND_LABEL[r.kind as TaskKind] ?? r.kind },
          { key: "totalTasks", header: "المهام", map: (r) => r.totalTasks },
          { key: "firstResponseAvgMinutes", header: "أول ردّ (متوسط)", map: (r) => fmtMinutes(r.firstResponseAvgMinutes) },
          { key: "firstResponseP50Minutes", header: "أول ردّ P50", map: (r) => fmtMinutes(r.firstResponseP50Minutes) },
          { key: "firstResponseP90Minutes", header: "أول ردّ P90", map: (r) => fmtMinutes(r.firstResponseP90Minutes) },
          { key: "resolutionAvgMinutes", header: "زمن الحلّ (متوسط)", map: (r) => fmtMinutes(r.resolutionAvgMinutes) },
          { key: "slaCompliancePct", header: "التزام SLA %", map: (r) => fmtPctStr(r.slaCompliancePct) },
          { key: "firstContactResolutionPct", header: "الحلّ من أوّل تواصل %", map: (r) => fmtPctStr(r.firstContactResolutionPct) },
          { key: "reopenedPct", header: "إعادة الفتح %", map: (r) => fmtPctStr(r.reopenedPct) },
        ],
      });
    } else if (tab === "agents") {
      const rows = agentVolumeQ.data?.rows ?? [];
      exportRows(rows, {
        filename: `تقارير-واتساب-أحجام-الموظفين-${from}-${to}`,
        title: "تقارير مركز واتساب — أحجام الموظفين",
        meta: periodMeta,
        columns: [
          { key: "userName", header: "الموظف" },
          { key: "assigned", header: "المسنَدة" },
          { key: "resolved", header: "المحلولة" },
          { key: "open", header: "المفتوحة" },
          { key: "avgResolutionMinutes", header: "متوسط زمن الحلّ", map: (r) => fmtMinutes(r.avgResolutionMinutes) },
          { key: "avgCsat", header: "متوسط CSAT", map: (r) => r.avgCsat ?? "" },
          { key: "csatCount", header: "عدد تقييمات CSAT" },
        ],
      });
    } else if (tab === "csat") {
      const rows = csatQ.data?.distribution ?? [];
      exportRows(rows, {
        filename: `تقارير-واتساب-رضا-العملاء-${from}-${to}`,
        title: "تقارير مركز واتساب — رضا العملاء (CSAT)",
        meta: [
          ...periodMeta,
          { label: "طُلب تقييمها", value: String(csatQ.data?.requested ?? 0) },
          { label: "أُجيبت", value: String(csatQ.data?.answered ?? 0) },
          { label: "متوسط الدرجة", value: csatQ.data?.average ?? "—" },
        ],
        columns: [
          { key: "score", header: "الدرجة" },
          { key: "count", header: "عدد التقييمات" },
        ],
      });
    } else {
      const rows = campaignQ.data?.rows ?? [];
      exportRows(rows, {
        filename: `تقارير-واتساب-أداء-الحملات-${from}-${to}`,
        title: "تقارير مركز واتساب — أداء الحملات",
        meta: periodMeta,
        columns: [
          { key: "name", header: "الحملة" },
          { key: "branchId", header: "الفرع", map: (r) => branchName(r.branchId) },
          { key: "broadcastStatus", header: "الحالة", map: (r) => CAMPAIGN_STATUS_META[r.broadcastStatus]?.label ?? r.broadcastStatus },
          { key: "audienceCount", header: "الجمهور" },
          { key: "totalRecipients", header: "المستلمون" },
          { key: "sent", header: "أُرسل" },
          { key: "delivered", header: "سُلّم" },
          { key: "read", header: "قُرئ" },
          { key: "failed", header: "فشل" },
          { key: "skippedOptout", header: "انسحب" },
          { key: "deliveryRatePct", header: "معدّل التسليم %", map: (r) => r.deliveryRatePct },
          { key: "readRatePct", header: "معدّل القراءة %", map: (r) => r.readRatePct },
          { key: "costEstimate", header: "الكلفة التقديرية", money: true, map: (r) => Number(r.costEstimate) },
          { key: "actualCost", header: "الكلفة الفعلية", money: true, map: (r) => Number(r.actualCost) },
        ],
        totalsRow: campaignQ.data?.summary
          ? {
              name: "الإجمالي",
              audienceCount: campaignQ.data.summary.audienceCount,
              totalRecipients: campaignQ.data.summary.totalRecipients,
              sent: campaignQ.data.summary.sent,
              delivered: campaignQ.data.summary.delivered,
              read: campaignQ.data.summary.read,
              failed: campaignQ.data.summary.failed,
              skippedOptout: campaignQ.data.summary.skippedOptout,
              costEstimate: Number(campaignQ.data.summary.costEstimate),
              actualCost: Number(campaignQ.data.summary.actualCost),
            }
          : undefined,
      });
    }
  }

  const exportDisabled =
    (tab === "response" && !(taskResponseQ.data?.byKind.length)) ||
    (tab === "agents" && !(agentVolumeQ.data?.rows.length)) ||
    (tab === "csat" && !(csatQ.data?.requested)) ||
    (tab === "campaigns" && !(campaignQ.data?.rows.length));

  return (
    <ReportShell
      title="تقارير مركز واتساب"
      description="أداء نظام المهام والتذاكر عبر واتساب — استجابة/حلّ، حِمل الموظفين، رضا العملاء، وأداء الحملات التسويقية."
      kpis={kpis}
      onExport={onExport}
      exportDisabled={exportDisabled}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">من</label>
            <input type="date" className={dateCls} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">إلى</label>
            <input type="date" className={dateCls} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
        </div>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
        <TabsList>
          <TabsTrigger value="response">الاستجابة والحل</TabsTrigger>
          <TabsTrigger value="agents">أحجام الموظفين</TabsTrigger>
          <TabsTrigger value="csat">رضا العملاء (CSAT)</TabsTrigger>
          <TabsTrigger value="campaigns">أداء الحملات</TabsTrigger>
        </TabsList>

        <TabsContent value="response" className="mt-3">
          <TaskResponseSection data={taskResponseQ.data} isLoading={taskResponseQ.isLoading} isError={taskResponseQ.isError} errorMessage={taskResponseQ.error?.message} onRetry={() => taskResponseQ.refetch()} />
        </TabsContent>
        <TabsContent value="agents" className="mt-3">
          <AgentVolumeSection data={agentVolumeQ.data} isLoading={agentVolumeQ.isLoading} isError={agentVolumeQ.isError} errorMessage={agentVolumeQ.error?.message} onRetry={() => agentVolumeQ.refetch()} />
        </TabsContent>
        <TabsContent value="csat" className="mt-3">
          <CsatSection data={csatQ.data} isLoading={csatQ.isLoading} isError={csatQ.isError} errorMessage={csatQ.error?.message} onRetry={() => csatQ.refetch()} />
        </TabsContent>
        <TabsContent value="campaigns" className="mt-3">
          <CampaignSection data={campaignQ.data} isLoading={campaignQ.isLoading} isError={campaignQ.isError} errorMessage={campaignQ.error?.message} onRetry={() => campaignQ.refetch()} branchName={branchName} />
        </TabsContent>
      </Tabs>
    </ReportShell>
  );
}

interface SectionProps<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
}

function TaskResponseSection({ data, isLoading, isError, errorMessage, onRetry }: SectionProps<TaskResponseData>) {
  const rows: KindRow[] = data?.byKind ?? [];
  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <p className="text-xs text-muted-foreground">{TASK_RESPONSE_NOTE}</p>
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState message={errorMessage} onRetry={onRetry} />
        ) : (
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-2.5 text-right font-medium">النوع</th>
                  <th className="p-2.5 text-right font-medium">المهام</th>
                  <th className="p-2.5 text-right font-medium">أول ردّ (متوسط)</th>
                  <th className="p-2.5 text-right font-medium">زمن الحلّ (متوسط)</th>
                  <th className="p-2.5 text-right font-medium">التزام SLA</th>
                  <th className="p-2.5 text-right font-medium">الحلّ من أوّل تواصل</th>
                  <th className="p-2.5 text-right font-medium">إعادة الفتح</th>
                </tr>
              </thead>
              <tbody>
                {!rows.length ? (
                  <TableEmptyRow colSpan={7} message="لا مهام في هذا النطاق." />
                ) : (
                  rows.map((k) => (
                    <tr key={k.kind} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right font-medium">{KIND_LABEL[k.kind as TaskKind] ?? k.kind}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(k.totalTasks)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtMinutes(k.firstResponseAvgMinutes)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtMinutes(k.resolutionAvgMinutes)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtPctStr(k.slaCompliancePct)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtPctStr(k.firstContactResolutionPct)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtPctStr(k.reopenedPct)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        )}
      </CardContent>
    </Card>
  );
}

function AgentVolumeSection({ data, isLoading, isError, errorMessage, onRetry }: SectionProps<AgentVolumeData>) {
  const rows: AgentRow[] = data?.rows ?? [];
  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <p className="text-xs text-muted-foreground">{AGENT_VOLUME_NOTE}</p>
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState message={errorMessage} onRetry={onRetry} />
        ) : (
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-2.5 text-right font-medium">الموظف</th>
                  <th className="p-2.5 text-right font-medium">المسنَدة</th>
                  <th className="p-2.5 text-right font-medium">المحلولة</th>
                  <th className="p-2.5 text-right font-medium">المفتوحة</th>
                  <th className="p-2.5 text-right font-medium">متوسط زمن الحلّ</th>
                  <th className="p-2.5 text-right font-medium">متوسط CSAT</th>
                </tr>
              </thead>
              <tbody>
                {!rows.length ? (
                  <TableEmptyRow colSpan={6} message="لا مهام مُسنَدة في هذا النطاق." />
                ) : (
                  rows.map((r) => (
                    <tr key={r.userId} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right font-medium">{r.userName}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.assigned)}</td>
                      <td className="p-2.5 text-right tabular-nums text-money-positive" dir="ltr">{fmtAr(r.resolved)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.open > 0 ? fmtAr(r.open) : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtMinutes(r.avgResolutionMinutes)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">
                        {r.avgCsat != null ? `${r.avgCsat} / ٥ (${fmtAr(r.csatCount)})` : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        )}
      </CardContent>
    </Card>
  );
}

function CsatSection({ data, isLoading, isError, errorMessage, onRetry }: SectionProps<CsatData>) {
  const maxCount = data ? Math.max(1, ...data.distribution.map((d) => d.count)) : 1;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState message={errorMessage} onRetry={onRetry} />
        ) : !data || data.requested === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">لا استطلاعات رضا مطلوبة في هذا النطاق.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {fmtAr(data.answered)} من {fmtAr(data.requested)} طلب تقييم أُجيب ({fmtPctStr(data.responseRatePct)})
              {data.average && <> — متوسط الدرجة {data.average} / ٥</>}
            </p>
            <div className="space-y-2">
              {data.distribution.map((d) => {
                const widthPct = Math.max(2, Math.round((d.count / maxCount) * 100));
                return (
                  <div key={d.score} className="flex items-center gap-2">
                    <span className="flex w-12 shrink-0 items-center gap-0.5 text-xs tabular-nums" dir="ltr">
                      {d.score} <Star aria-hidden className="size-3 fill-current" />
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full rounded bg-primary/70"
                        style={{ width: `${d.count > 0 ? widthPct : 0}%` }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-end text-xs tabular-nums" dir="ltr">{fmtAr(d.count)}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const FUNNEL_STAGES: { key: "sent" | "delivered" | "read"; label: string }[] = [
  { key: "sent", label: "أُرسل" },
  { key: "delivered", label: "سُلّم" },
  { key: "read", label: "قُرئ" },
];

function CampaignSection({
  data,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  branchName,
}: SectionProps<CampaignData> & { branchName: (id: number | null) => string }) {
  const rows: CampaignRow[] = data?.rows ?? [];
  const summary = data?.summary;
  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState message={errorMessage} onRetry={onRetry} />
        ) : (
          <>
            {summary && summary.totalRecipients > 0 && (
              <div className="space-y-1.5 rounded-md border p-2.5">
                {FUNNEL_STAGES.map((stage) => {
                  const val = summary[stage.key];
                  const widthPct = Math.max(2, Math.round((val / summary.totalRecipients) * 100));
                  return (
                    <div key={stage.key} className="flex items-center gap-2 text-xs">
                      <span className="w-10 shrink-0 text-muted-foreground">{stage.label}</span>
                      <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
                        <div
                          className="flex h-full items-center justify-end rounded bg-primary/70 px-1.5 text-[10px] tabular-nums text-primary-foreground"
                          dir="ltr"
                          style={{ width: `${widthPct}%` }}
                        >
                          {fmtAr(val)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <ScrollTableShell bordered={false}>
              <table className="w-full min-w-[980px] text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">الحملة</th>
                    <th className="p-2.5 text-right font-medium">الفرع</th>
                    <th className="p-2.5 text-right font-medium">الحالة</th>
                    <th className="p-2.5 text-right font-medium">الجمهور</th>
                    <th className="p-2.5 text-right font-medium">أُرسل</th>
                    <th className="p-2.5 text-right font-medium">سُلّم</th>
                    <th className="p-2.5 text-right font-medium">قُرئ</th>
                    <th className="p-2.5 text-right font-medium">فشل</th>
                    <th className="p-2.5 text-right font-medium">انسحب</th>
                    <th className="p-2.5 text-right font-medium">معدّل التسليم</th>
                    <th className="p-2.5 text-right font-medium">الكلفة الفعلية</th>
                  </tr>
                </thead>
                <tbody>
                  {!rows.length ? (
                    <TableEmptyRow colSpan={11} message="لا حملات في هذا النطاق." />
                  ) : (
                    rows.map((r) => {
                      const statusMeta = CAMPAIGN_STATUS_META[r.broadcastStatus] ?? { label: r.broadcastStatus, variant: "neutral" as const };
                      return (
                        <tr key={r.broadcastId} className="border-b last:border-0 hover:bg-accent/40">
                          <td className="p-2.5 text-right font-medium">{r.name}</td>
                          <td className="p-2.5 text-right text-muted-foreground">{branchName(r.branchId)}</td>
                          <td className="p-2.5 text-right"><Badge variant={statusMeta.variant}>{statusMeta.label}</Badge></td>
                          <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.audienceCount)}</td>
                          <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.sent)}</td>
                          <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.delivered)}</td>
                          <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.read)}</td>
                          <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">{r.failed > 0 ? fmtAr(r.failed) : "—"}</td>
                          <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{r.skippedOptout > 0 ? fmtAr(r.skippedOptout) : "—"}</td>
                          <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtPctStr(r.deliveryRatePct)}</td>
                          <td className="p-2.5 text-right tabular-nums" dir="ltr">{formatIqd(r.actualCost)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          </>
        )}
      </CardContent>
    </Card>
  );
}
