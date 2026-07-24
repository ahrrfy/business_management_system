// تقارير مركز واتساب (S6، T6.1) — قراءة تجميعية بحتة خلف بوّابة التقارير الحمراء
// (`reportViewerProcedure` في الراوتر — بيانات أداء موظفين + كلفة حملات، خط §٦ من CLAUDE.md).
//
// أربع دوال (راجع docs/whatsapp-hub-design-2026-07-23.md §١٠ «مؤشرات النجاح وبوابات قبول الطيار»):
//   ١) taskResponseReport — زمن أول رد P50/P90 + زمن الحل P50/P90 + التزام SLA + الحل من أول
//      تواصل + معدّل إعادة الفتح، إجمالاً وتجميعاً اختيارياً حسب taskKind.
//   ٢) agentVolumeReport — أحجام العمل لكل موظف: **حِمل عمل لا مراقبة أداء** (مبدأ حاكم صريح في
//      وثيقة التصميم §١٠ — لا قياس بعدد الرسائل ولا بزمن الاتصال/الأونلاين إطلاقاً؛ فقط
//      الإسناد/الإنجاز/الجودة عبر CSAT).
//   ٣) csatReport — توزيع الدرجات ١-٥ + المتوسط + معدّل الاستجابة (المُجاب ÷ المطلوب).
//   ٤) campaignPerformanceReport — قمع البثّ التسويقي (أُرسل→سُلّم→قُرئ) لكل حملة + الكلفة
//      التقديرية (لقطة الإنشاء) مقابل الكلفة الفعلية (المُحتسَبة من الرسائل التي أُرسلت فعلاً).
//
// معيار الفترة زمنياً: تقارير المهام الثلاثة الأولى (١+٢) تُصفّى على `tasks.createdAt` — يوحّد
// تعريف «الفترة» عبر تقارير المهام (نفس مجموعة المهام تُقاس من زوايا مختلفة). تقرير CSAT (٣) يُصفّى
// على `tasks.csatRequestedAt` عمداً (مختلف): السؤال التجاري هو «كم استطلاعاً أُرسل هذه الفترة وكم
// أُجيب؟» لا «كم مهمّة أُنشئت هذه الفترة وما درجتها لاحقاً؟» — مهمّة أُنشئت في الفترة قد تُغلَق
// وتُستطلَع رضاها لاحقاً خارجها، والعكس. تقرير الحملات (٤) يُصفّى على `waBroadcasts.createdAt`.
//
// حسابات الأزمنة (فروق دقائق) تُبنى من فروق Date.getTime() بين طابعين زمنيين مُخزَّنين — حتميّة
// ومستقلّة عن منطقة تشغيل العملية (لا صلة بحارس check:date-boundaries، الذي يرصد فقط بناء *حدود*
// الفترة بمكوّناتٍ محلية). حدود الفترة from/to تُبنى حصراً عبر localDayStart/localNextDayStart
// (توكيل UTC-حتمي إلى businessDay.ts).
//
// SLA: `tasks.dueAt` يُشتَقّ فعلاً من `serviceTypes.slaHours` وقت إنشاء المهمّة (راجع
// server/services/tasks/create.ts) فيحمل أثر الـSLA المضبوط بالفعل — لا حاجة لإعادة JOIN مع
// serviceTypes هنا. effectiveDueAt (dueAt + تراكم الانتظار) يُعاد استعمال منطقه من
// server/services/tasks/list.ts (computeEffectiveDueAt) بلا تكرار.
//
// كل الأموال (كلفة الحملات) عبر decimal.js + money.ts — ممنوع parseFloat/Number على المال.
// النِسَب المئوية (SLA/الحل من أوّل تواصل/إعادة الفتح/قمع الحملة) عبر decimal.js أيضاً (نمط
// `pct` في courierPerformance.ts) تفادياً لانحراف الفاصلة العائمة.
import Decimal from "decimal.js";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { tasks, users, waBroadcastRecipients, waBroadcasts } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { localDayStart, localNextDayStart } from "../dateRange";
import { money, toDbMoney } from "../money";
import { MARKETING_MSG_COST } from "../whatsapp/broadcastService";
import { computeEffectiveDueAt } from "../tasks/list";

export interface WhatsappReportInput {
  /** YYYY-MM-DD — بداية الفترة (شاملة). */
  from: string;
  /** YYYY-MM-DD — نهاية الفترة (شاملة). */
  to: string;
  /** عزل الفرع — يُمرَّر من scopedBranchId في الراوتر (undefined = كل الفروع للأدمن). */
  branchId?: number;
}

/** سقف مسحٍ وقائي — حجم مركز واتساب لمكتبة واحدة لا يبلغ عشرات الآلاف شهرياً؛ نطاقٌ يبلغ السقف
 *  يعني تضييق الفترة المطلوبة. */
const MAX_SCAN = 20_000;

// ─────────────────────────────── أدوات مساعدة عامة (زمن/نسبة) ───────────────────────────────

/** فرق دقائق بين طابعين زمنيين (to − from) — عدد عشري غير سالب افتراضاً غير مضمون (لا يُقصّ هنا،
 *  المستدعي يتحقّق من ترتيب الطابعين منطقياً قبل الاستدعاء). */
function diffMinutes(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60000;
}

/** المتوسط الحسابي البسيط بمنزلة عشرية واحدة؛ null لقائمة فارغة. */
function avgMinutes(values: number[]): string | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return (sum / values.length).toFixed(1);
}

/** نسبة مئوية p (0-100) بطريقة nearest-rank على مصفوفة مرتّبة تصاعدياً (طريقة قياسية شائعة
 *  لمؤشّرات P50/P90 في تقارير الأداء) — rank = ⌈(p/100) × n⌉، ثم index = rank − 1 مقصوصاً لحدود
 *  المصفوفة. فارغة ⇒ null. */
function percentileOf(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

function fmtMin(n: number | null): string | null {
  return n == null ? null : n.toFixed(1);
}

/** نسبة part/total% بمنزلتين — "0.00" حين total=0 (نمط `pct` في courierPerformance.ts). */
function pct(part: number, total: number): string {
  if (total <= 0) return "0.00";
  return new Decimal(part).div(total).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

// ═══════════════════════════ ١) زمن الاستجابة/الحل + SLA + إعادة الفتح ═══════════════════════════

export interface TaskResponseMetrics {
  /** "ALL" للإجمالي، أو قيمة taskKind لصفّ التجميع الفرعي. */
  kind: string;
  totalTasks: number;
  /** المهام التي التُقط لها أول ردّ فعلياً (firstResponseAt IS NOT NULL) — البقية استُبعدت من
   *  حسابات هذا القسم (لم تُلتقط بعد، لا زمن استجابة سلبياً وهمياً). */
  firstResponseCount: number;
  firstResponseAvgMinutes: string | null;
  firstResponseP50Minutes: string | null;
  firstResponseP90Minutes: string | null;
  /** المهام المحلولة (resolvedAt IS NOT NULL). */
  resolvedCount: number;
  resolutionAvgMinutes: string | null;
  resolutionP50Minutes: string | null;
  resolutionP90Minutes: string | null;
  /** مهام محلولة **ولها موعد استحقاق مضبوط** (dueAt) — وحدها القابلة للحكم على التزام SLA. */
  slaEligible: number;
  /** منها ما حُلّ ضمن الموعد الفعلي (effectiveDueAt يشمل تراكم انتظار العميل). */
  slaMet: number;
  /** slaMet ÷ slaEligible × ١٠٠ — null بلا مهام مؤهَّلة (لا SLA مضبوط على أيٍّ منها). */
  slaCompliancePct: string | null;
  /** الحل من أول تواصل (First Contact Resolution) — محلولة بلا أي إعادة فتح (reopenCount=0). */
  firstContactResolutionCount: number;
  /** من بين المحلولة فقط؛ null بلا مهام محلولة. */
  firstContactResolutionPct: string | null;
  /** إجمالي مهام أُعيد فتحها مرّة واحدة على الأقل (reopenCount > 0) — بغضّ النظر عن حالتها الحالية. */
  reopenedCount: number;
  /** reopenedCount ÷ totalTasks × ١٠٠. */
  reopenedPct: string;
}

export interface TaskResponseReportResult {
  from: string;
  to: string;
  overall: TaskResponseMetrics;
  byKind: TaskResponseMetrics[];
}

interface TaskAccBucket {
  totalTasks: number;
  firstResponseMinutes: number[];
  resolutionMinutes: number[];
  slaEligible: number;
  slaMet: number;
  resolvedCount: number;
  firstContactResolutionCount: number;
  reopenedCount: number;
}

function newBucket(): TaskAccBucket {
  return {
    totalTasks: 0,
    firstResponseMinutes: [],
    resolutionMinutes: [],
    slaEligible: 0,
    slaMet: 0,
    resolvedCount: 0,
    firstContactResolutionCount: 0,
    reopenedCount: 0,
  };
}

function finalizeBucket(kind: string, b: TaskAccBucket): TaskResponseMetrics {
  const frSorted = [...b.firstResponseMinutes].sort((x, y) => x - y);
  const resSorted = [...b.resolutionMinutes].sort((x, y) => x - y);
  return {
    kind,
    totalTasks: b.totalTasks,
    firstResponseCount: b.firstResponseMinutes.length,
    firstResponseAvgMinutes: avgMinutes(b.firstResponseMinutes),
    firstResponseP50Minutes: fmtMin(percentileOf(frSorted, 50)),
    firstResponseP90Minutes: fmtMin(percentileOf(frSorted, 90)),
    resolvedCount: b.resolvedCount,
    resolutionAvgMinutes: avgMinutes(b.resolutionMinutes),
    resolutionP50Minutes: fmtMin(percentileOf(resSorted, 50)),
    resolutionP90Minutes: fmtMin(percentileOf(resSorted, 90)),
    slaEligible: b.slaEligible,
    slaMet: b.slaMet,
    slaCompliancePct: b.slaEligible > 0 ? pct(b.slaMet, b.slaEligible) : null,
    firstContactResolutionCount: b.firstContactResolutionCount,
    firstContactResolutionPct: b.resolvedCount > 0 ? pct(b.firstContactResolutionCount, b.resolvedCount) : null,
    reopenedCount: b.reopenedCount,
    reopenedPct: pct(b.reopenedCount, b.totalTasks),
  };
}

export async function taskResponseReport(input: WhatsappReportInput): Promise<TaskResponseReportResult> {
  const emptyOverall = finalizeBucket("ALL", newBucket());
  const empty: TaskResponseReportResult = { from: input.from, to: input.to, overall: emptyOverall, byKind: [] };
  const db = getDb();
  if (!db) return empty;

  const conds = [
    sql`${tasks.createdAt} >= ${localDayStart(input.from)}`,
    sql`${tasks.createdAt} < ${localNextDayStart(input.to)}`,
  ];
  if (input.branchId) conds.push(eq(tasks.branchId, input.branchId));

  const rows = await db
    .select({
      taskKind: tasks.taskKind,
      taskStatus: tasks.taskStatus,
      createdAt: tasks.createdAt,
      firstResponseAt: tasks.firstResponseAt,
      resolvedAt: tasks.resolvedAt,
      dueAt: tasks.dueAt,
      waitingAccumMs: tasks.waitingAccumMs,
      waitingSince: tasks.waitingSince,
      reopenCount: tasks.reopenCount,
    })
    .from(tasks)
    .where(and(...conds))
    .limit(MAX_SCAN);

  const overallBucket = newBucket();
  const kindBuckets = new Map<string, TaskAccBucket>();

  for (const r of rows) {
    const bucket = kindBuckets.get(r.taskKind) ?? newBucket();
    kindBuckets.set(r.taskKind, bucket);

    for (const b of [overallBucket, bucket]) {
      b.totalTasks += 1;
      if (r.firstResponseAt) b.firstResponseMinutes.push(diffMinutes(r.createdAt, r.firstResponseAt));
      if (r.resolvedAt) {
        b.resolvedCount += 1;
        b.resolutionMinutes.push(diffMinutes(r.createdAt, r.resolvedAt));
        const effectiveDueAt = computeEffectiveDueAt(r);
        if (effectiveDueAt) {
          b.slaEligible += 1;
          if (r.resolvedAt.getTime() <= effectiveDueAt.getTime()) b.slaMet += 1;
        }
        if (Number(r.reopenCount) === 0) b.firstContactResolutionCount += 1;
      }
      if (Number(r.reopenCount) > 0) b.reopenedCount += 1;
    }
  }

  const byKind = Array.from(kindBuckets.entries())
    .map(([kind, b]) => finalizeBucket(kind, b))
    .sort((a, c) => a.kind.localeCompare(c.kind));

  return { from: input.from, to: input.to, overall: finalizeBucket("ALL", overallBucket), byKind };
}

// ═══════════════════════════════════ ٢) أحجام العمل لكل موظف ═══════════════════════════════════

export interface AgentVolumeRow {
  userId: number;
  userName: string;
  /** إجمالي المهام المُسنَدة له خلال الفترة (بغضّ النظر عن حالتها الحالية). */
  assigned: number;
  resolved: number;
  /** مفتوحة الآن (ليست RESOLVED ولا CANCELLED). */
  open: number;
  avgResolutionMinutes: string | null;
  /** متوسط CSAT (١-٥) لمهامه التي أُجيب تقييمها ضمن الفترة؛ null بلا تقييمات. */
  avgCsat: string | null;
  csatCount: number;
}

export interface AgentVolumeReportResult {
  from: string;
  to: string;
  rows: AgentVolumeRow[];
}

const CLOSED_TASK_STATUSES = new Set(["RESOLVED", "CANCELLED"]);

export async function agentVolumeReport(input: WhatsappReportInput): Promise<AgentVolumeReportResult> {
  const empty: AgentVolumeReportResult = { from: input.from, to: input.to, rows: [] };
  const db = getDb();
  if (!db) return empty;

  const conds = [
    sql`${tasks.createdAt} >= ${localDayStart(input.from)}`,
    sql`${tasks.createdAt} < ${localNextDayStart(input.to)}`,
    sql`${tasks.assignedTo} IS NOT NULL`,
  ];
  if (input.branchId) conds.push(eq(tasks.branchId, input.branchId));

  const rows = await db
    .select({
      assignedTo: tasks.assignedTo,
      userName: users.name,
      taskStatus: tasks.taskStatus,
      createdAt: tasks.createdAt,
      resolvedAt: tasks.resolvedAt,
      csatScore: tasks.csatScore,
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assignedTo, users.id))
    .where(and(...conds))
    .limit(MAX_SCAN);

  interface Acc {
    userName: string;
    assigned: number;
    resolved: number;
    open: number;
    resolutionMinutes: number[];
    csatScores: number[];
  }
  const byAgent = new Map<number, Acc>();

  for (const r of rows) {
    const userId = Number(r.assignedTo);
    const acc = byAgent.get(userId) ?? {
      userName: r.userName ?? `#${userId}`,
      assigned: 0, resolved: 0, open: 0, resolutionMinutes: [], csatScores: [],
    };
    byAgent.set(userId, acc);

    acc.assigned += 1;
    if (r.taskStatus === "RESOLVED") {
      acc.resolved += 1;
      if (r.resolvedAt) acc.resolutionMinutes.push(diffMinutes(r.createdAt, r.resolvedAt));
    }
    if (!CLOSED_TASK_STATUSES.has(r.taskStatus)) acc.open += 1;
    if (r.csatScore != null) acc.csatScores.push(Number(r.csatScore));
  }

  const result: AgentVolumeRow[] = Array.from(byAgent.entries()).map(([userId, acc]) => ({
    userId,
    userName: acc.userName,
    assigned: acc.assigned,
    resolved: acc.resolved,
    open: acc.open,
    avgResolutionMinutes: avgMinutes(acc.resolutionMinutes),
    avgCsat: acc.csatScores.length > 0
      ? (acc.csatScores.reduce((a, v) => a + v, 0) / acc.csatScores.length).toFixed(2)
      : null,
    csatCount: acc.csatScores.length,
  }));

  // الأكثر حملاً أولاً (نمط الترتيب في courierPerformance).
  result.sort((a, c) => c.assigned - a.assigned);

  return { from: input.from, to: input.to, rows: result };
}

// ══════════════════════════════════════ ٣) تقرير CSAT ══════════════════════════════════════

export interface CsatDistributionEntry {
  score: number;
  count: number;
}

export interface CsatReportResult {
  from: string;
  to: string;
  /** عدد المهام المطلوب تقييمها (csatRequestedAt ضمن الفترة). */
  requested: number;
  /** منها ما أُجيب فعلياً (csatScore محدَّد). */
  answered: number;
  responseRatePct: string;
  /** متوسط الدرجات المُجابة (١-٥)؛ null بلا إجابات. */
  average: string | null;
  /** توزيع الدرجات ١..٥ — كل درجة تظهر دائماً ولو بعدّاد صفر. */
  distribution: CsatDistributionEntry[];
}

export async function csatReport(input: WhatsappReportInput): Promise<CsatReportResult> {
  const emptyDist: CsatDistributionEntry[] = [1, 2, 3, 4, 5].map((score) => ({ score, count: 0 }));
  const empty: CsatReportResult = {
    from: input.from, to: input.to, requested: 0, answered: 0, responseRatePct: "0.00", average: null, distribution: emptyDist,
  };
  const db = getDb();
  if (!db) return empty;

  const conds = [
    sql`${tasks.csatRequestedAt} IS NOT NULL`,
    sql`${tasks.csatRequestedAt} >= ${localDayStart(input.from)}`,
    sql`${tasks.csatRequestedAt} < ${localNextDayStart(input.to)}`,
  ];
  if (input.branchId) conds.push(eq(tasks.branchId, input.branchId));

  const rows = await db
    .select({ csatScore: tasks.csatScore })
    .from(tasks)
    .where(and(...conds))
    .limit(MAX_SCAN);

  const distMap = new Map<number, number>([[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
  let answeredSum = 0;
  let answeredCount = 0;
  for (const r of rows) {
    if (r.csatScore == null) continue;
    const score = Number(r.csatScore);
    answeredCount += 1;
    answeredSum += score;
    distMap.set(score, (distMap.get(score) ?? 0) + 1);
  }

  return {
    from: input.from,
    to: input.to,
    requested: rows.length,
    answered: answeredCount,
    responseRatePct: pct(answeredCount, rows.length),
    average: answeredCount > 0 ? (answeredSum / answeredCount).toFixed(2) : null,
    distribution: Array.from(distMap.entries()).sort((a, c) => a[0] - c[0]).map(([score, count]) => ({ score, count })),
  };
}

// ═══════════════════════════════ ٤) قمع أداء الحملات التسويقية ═══════════════════════════════

export interface CampaignPerformanceRow {
  broadcastId: number;
  name: string;
  branchId: number | null;
  broadcastStatus: string;
  /** لقطة العدد المُقدَّر وقت الإنشاء/آخر إعادة حساب. */
  audienceCount: number;
  /** عدد صفوف waBroadcastRecipients الفعلية (قد يقلّ عن audienceCount قبل اكتمال التقطير). */
  totalRecipients: number;
  /** بلغت SENT أو تجاوزتها (SENT+DELIVERED+READ) — recipientStatus عمود حالةٍ حاليّة لا تراكميّة. */
  sent: number;
  /** بلغت DELIVERED أو تجاوزتها (DELIVERED+READ). */
  delivered: number;
  read: number;
  failed: number;
  skippedOptout: number;
  /** ما زال في الطابور (PENDING/QUEUED). */
  pending: number;
  /** delivered ÷ totalRecipients. */
  deliveryRatePct: string;
  /** read ÷ totalRecipients. */
  readRatePct: string;
  /** failed ÷ totalRecipients. */
  failureRatePct: string;
  /** لقطة الكلفة التقديرية وقت الإنشاء (waBroadcasts.costEstimate). */
  costEstimate: string;
  /** الكلفة الفعلية = sent × MARKETING_MSG_COST (ما أُرسل فعلاً لا ما استُهدف). */
  actualCost: string;
  createdAt: Date;
}

export interface CampaignPerformanceSummary {
  campaigns: number;
  audienceCount: number;
  totalRecipients: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skippedOptout: number;
  deliveryRatePct: string;
  readRatePct: string;
  failureRatePct: string;
  costEstimate: string;
  actualCost: string;
}

export interface CampaignPerformanceReportResult {
  from: string;
  to: string;
  rows: CampaignPerformanceRow[];
  summary: CampaignPerformanceSummary;
}

const RECIPIENT_STATUSES = ["PENDING", "QUEUED", "SENT", "DELIVERED", "READ", "FAILED", "SKIPPED_OPTOUT"] as const;

export async function campaignPerformanceReport(input: WhatsappReportInput): Promise<CampaignPerformanceReportResult> {
  const emptySummary: CampaignPerformanceSummary = {
    campaigns: 0, audienceCount: 0, totalRecipients: 0, sent: 0, delivered: 0, read: 0, failed: 0, skippedOptout: 0,
    deliveryRatePct: "0.00", readRatePct: "0.00", failureRatePct: "0.00", costEstimate: "0.00", actualCost: "0.00",
  };
  const empty: CampaignPerformanceReportResult = { from: input.from, to: input.to, rows: [], summary: emptySummary };
  const db = getDb();
  if (!db) return empty;

  // نمط عزل فرع الحملات (broadcastsRouter/listBroadcasts): بثّ عامّ (branchId=null) مرئيٌّ ضمن أي
  // فرع — ليس مقصوراً على الأدمن هنا (تقرير قراءة، لا تحكّم)، فيظهر أثره في أرقام كل الفروع.
  const conds = [
    sql`${waBroadcasts.createdAt} >= ${localDayStart(input.from)}`,
    sql`${waBroadcasts.createdAt} < ${localNextDayStart(input.to)}`,
  ];
  if (input.branchId) conds.push(or(isNull(waBroadcasts.branchId), eq(waBroadcasts.branchId, input.branchId))!);

  const broadcastRows = await db
    .select({
      id: waBroadcasts.id,
      name: waBroadcasts.name,
      branchId: waBroadcasts.branchId,
      broadcastStatus: waBroadcasts.broadcastStatus,
      audienceCount: waBroadcasts.audienceCount,
      costEstimate: waBroadcasts.costEstimate,
      createdAt: waBroadcasts.createdAt,
    })
    .from(waBroadcasts)
    .where(and(...conds))
    .limit(MAX_SCAN);

  if (broadcastRows.length === 0) return empty;

  const broadcastIds = broadcastRows.map((b) => Number(b.id));
  const recipCounts = await db
    .select({
      broadcastId: waBroadcastRecipients.broadcastId,
      status: waBroadcastRecipients.recipientStatus,
      cnt: sql<number>`COUNT(*)`,
    })
    .from(waBroadcastRecipients)
    .where(sql`${waBroadcastRecipients.broadcastId} IN (${sql.join(broadcastIds, sql`, `)})`)
    .groupBy(waBroadcastRecipients.broadcastId, waBroadcastRecipients.recipientStatus);

  const countsByBroadcast = new Map<number, Record<string, number>>();
  for (const c of recipCounts) {
    const bId = Number(c.broadcastId);
    const rec = countsByBroadcast.get(bId) ?? Object.fromEntries(RECIPIENT_STATUSES.map((s) => [s, 0]));
    countsByBroadcast.set(bId, rec);
    rec[String(c.status)] = Number(c.cnt);
  }

  const rows: CampaignPerformanceRow[] = broadcastRows.map((b) => {
    const bId = Number(b.id);
    const counts = countsByBroadcast.get(bId) ?? Object.fromEntries(RECIPIENT_STATUSES.map((s) => [s, 0]));
    const totalRecipients = RECIPIENT_STATUSES.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
    const read = counts.READ ?? 0;
    const delivered = (counts.DELIVERED ?? 0) + read;
    const sent = (counts.SENT ?? 0) + delivered;
    const failed = counts.FAILED ?? 0;
    const skippedOptout = counts.SKIPPED_OPTOUT ?? 0;
    const pending = (counts.PENDING ?? 0) + (counts.QUEUED ?? 0);

    return {
      broadcastId: bId,
      name: b.name,
      branchId: b.branchId == null ? null : Number(b.branchId),
      broadcastStatus: b.broadcastStatus,
      audienceCount: Number(b.audienceCount),
      totalRecipients,
      sent,
      delivered,
      read,
      failed,
      skippedOptout,
      pending,
      deliveryRatePct: pct(delivered, totalRecipients),
      readRatePct: pct(read, totalRecipients),
      failureRatePct: pct(failed, totalRecipients),
      costEstimate: toDbMoney(money(b.costEstimate ?? "0")),
      actualCost: toDbMoney(money(MARKETING_MSG_COST).times(sent)),
      createdAt: b.createdAt,
    };
  });

  rows.sort((a, c) => c.createdAt.getTime() - a.createdAt.getTime());

  const totals = rows.reduce(
    (acc, r) => {
      acc.audienceCount += r.audienceCount;
      acc.totalRecipients += r.totalRecipients;
      acc.sent += r.sent;
      acc.delivered += r.delivered;
      acc.read += r.read;
      acc.failed += r.failed;
      acc.skippedOptout += r.skippedOptout;
      acc.costEstimate = acc.costEstimate.plus(money(r.costEstimate));
      acc.actualCost = acc.actualCost.plus(money(r.actualCost));
      return acc;
    },
    {
      audienceCount: 0, totalRecipients: 0, sent: 0, delivered: 0, read: 0, failed: 0, skippedOptout: 0,
      costEstimate: new Decimal(0), actualCost: new Decimal(0),
    },
  );

  return {
    from: input.from,
    to: input.to,
    rows,
    summary: {
      campaigns: rows.length,
      audienceCount: totals.audienceCount,
      totalRecipients: totals.totalRecipients,
      sent: totals.sent,
      delivered: totals.delivered,
      read: totals.read,
      failed: totals.failed,
      skippedOptout: totals.skippedOptout,
      deliveryRatePct: pct(totals.delivered, totals.totalRecipients),
      readRatePct: pct(totals.read, totals.totalRecipients),
      failureRatePct: pct(totals.failed, totals.totalRecipients),
      costEstimate: toDbMoney(totals.costEstimate),
      actualCost: toDbMoney(totals.actualCost),
    },
  };
}
