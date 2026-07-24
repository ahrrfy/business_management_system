/**
 * اختبارات تقارير مركز واتساب (S6، T6.1) — server/services/reports/whatsappReports.ts.
 *
 * يتحقّق من:
 *  ١) taskResponseReport: P50/P90 لزمن أول رد على بيانات معروفة (nearest-rank) + استبعاد المهام
 *     بلا firstResponseAt + P50/P90 لزمن الحل + نسبة التزام SLA + الحل من أول تواصل + معدّل إعادة
 *     الفتح، إجمالاً وتجميعاً حسب taskKind.
 *  ٢) agentVolumeReport: عدّ صحيح (مُسنَد/محلولة/مفتوحة) لكل موظف + متوسط زمن الحل + متوسط CSAT.
 *  ٣) csatReport: توزيع الدرجات + المتوسط + معدّل الاستجابة + فلترة الفترة على csatRequestedAt.
 *  ٤) campaignPerformanceReport: قمع أُرسل→سُلّم→قُرئ لحملة معروفة + الكلفة التقديرية/الفعلية.
 *  ٥) عزل الفرع في الأربعة (بيانات فرع آخر لا تُحتسب عند تحديد الفرع).
 *
 * البيانات تُدرَج مباشرةً عبر drizzle (لا عبر create/lifecycle الخدمية) للتحكّم الدقيق بالطوابع
 * الزمنية اللازمة لحساب P50/P90 على قيم معروفة سلفاً — نمط عزل الفرع في courierPerformance.test.ts.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  agentVolumeReport,
  campaignPerformanceReport,
  csatReport,
  taskResponseReport,
} from "../reports/whatsappReports";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "waBroadcastRecipients", "waBroadcasts", "waTemplates",
  "taskEvents", "tasks", "users", "branches",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "المدير العام", email: "admin@t61.test", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "mgr", name: "مدير الفرع", email: "mgr@t61.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "agentA", name: "موظف أ", email: "a@t61.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "agentB", name: "موظف ب", email: "b@t61.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.waTemplates).values([
    { id: 1, name: "قالب تسويقي", language: "ar", category: "MARKETING", templateStatus: "APPROVED" },
  ]);
}

const T = new Date("2026-03-10T08:00:00Z");
function addMin(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

let taskAutoId = 1;
/** يُدرِج صفّ مهمّة مباشرةً بحقول تحكّم كاملة (لا عبر خدمة الإنشاء) — يعيد id المهمّة. */
async function insertTask(row: {
  branchId?: number;
  taskKind?: "SERVICE_REQUEST" | "SUPPORT" | "INQUIRY" | "FOLLOW_UP" | "INTERNAL";
  taskStatus?: "NEW" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "RESOLVED" | "CANCELLED";
  createdAt?: Date;
  firstResponseAt?: Date | null;
  resolvedAt?: Date | null;
  dueAt?: Date | null;
  reopenCount?: number;
  assignedTo?: number | null;
  csatScore?: number | null;
  csatRequestedAt?: Date | null;
}): Promise<number> {
  const id = taskAutoId++;
  await db().insert(s.tasks).values({
    id,
    taskNumber: `TSK-T61-${String(id).padStart(4, "0")}`,
    branchId: row.branchId ?? 1,
    taskKind: row.taskKind ?? "INQUIRY",
    taskStatus: row.taskStatus ?? "NEW",
    title: `مهمة ${id}`,
    createdAt: row.createdAt ?? T,
    firstResponseAt: row.firstResponseAt ?? null,
    resolvedAt: row.resolvedAt ?? null,
    dueAt: row.dueAt ?? null,
    reopenCount: row.reopenCount ?? 0,
    assignedTo: row.assignedTo ?? null,
    csatScore: row.csatScore ?? null,
    csatRequestedAt: row.csatRequestedAt ?? null,
  });
  return id;
}

let broadcastAutoId = 1;
async function insertBroadcast(row: {
  branchId?: number | null;
  audienceCount: number;
  costEstimate: string;
  createdAt?: Date;
  broadcastStatus?: string;
}): Promise<number> {
  const id = broadcastAutoId++;
  await db().insert(s.waBroadcasts).values({
    id,
    branchId: row.branchId ?? null,
    name: `حملة ${id}`,
    templateId: 1,
    segmentJson: {},
    broadcastStatus: (row.broadcastStatus as any) ?? "COMPLETED",
    audienceCount: row.audienceCount,
    costEstimate: row.costEstimate,
    createdAt: row.createdAt ?? T,
  });
  return id;
}

/** يُدرِج N صفّاً من waBroadcastRecipients بحالة مُعطاة لحملة، بأرقام هاتف فريدة تصاعدية. */
async function insertRecipients(broadcastId: number, status: string, count: number, phoneOffset: number) {
  if (count <= 0) return;
  const rows = Array.from({ length: count }, (_, i) => ({
    broadcastId,
    phoneE164: `+96479${String(broadcastId).padStart(2, "0")}${String(phoneOffset + i).padStart(5, "0")}`,
    recipientStatus: status as any,
  }));
  await db().insert(s.waBroadcastRecipients).values(rows);
}

const PERIOD = { from: "2026-03-10", to: "2026-03-10" };

describe("تقارير مركز واتساب", () => {
  beforeEach(async () => {
    taskAutoId = 1;
    broadcastAutoId = 1;
    await reset();
    await seedBase();
  });

  describe("taskResponseReport", () => {
    it("P50/P90 لزمن أول رد + استبعاد بلا firstResponseAt + P50/P90 للحل + SLA + FCR + إعادة الفتح", async () => {
      // A/B: بلا حل — أول ردّ فقط (10 و20 دقيقة). INQUIRY.
      await insertTask({ taskKind: "INQUIRY", firstResponseAt: addMin(T, 10) });
      await insertTask({ taskKind: "INQUIRY", firstResponseAt: addMin(T, 20) });
      // C: أول ردّ 30 + حُلّت خلال 30 دقيقة + SLA=60 دقيقة (ضمن الموعد) + لم تُعَد فتحها. INQUIRY.
      await insertTask({
        taskKind: "INQUIRY", taskStatus: "RESOLVED",
        firstResponseAt: addMin(T, 30), resolvedAt: addMin(T, 30), dueAt: addMin(T, 60),
      });
      // D: أول ردّ 40 + حُلّت خلال 90 دقيقة + SLA=60 دقيقة (تجاوزت الموعد) + أُعيد فتحها مرّة. SUPPORT.
      await insertTask({
        taskKind: "SUPPORT", taskStatus: "RESOLVED",
        firstResponseAt: addMin(T, 40), resolvedAt: addMin(T, 90), dueAt: addMin(T, 60), reopenCount: 1,
      });
      // E: بلا أول ردّ مُلتقَط (تُستبعَد من حسابات أول ردّ) لكنها حُلّت خلال 60 دقيقة بلا SLA مضبوط
      // وبلا إعادة فتح. SUPPORT.
      await insertTask({
        taskKind: "SUPPORT", taskStatus: "RESOLVED",
        firstResponseAt: null, resolvedAt: addMin(T, 60), dueAt: null,
      });

      const res = await taskResponseReport(PERIOD);

      // ── الإجمالي ──
      expect(res.overall.totalTasks).toBe(5);
      // أول ردّ: [10,20,30,40] — استُبعدت E.
      expect(res.overall.firstResponseCount).toBe(4);
      expect(res.overall.firstResponseAvgMinutes).toBe("25.0");
      expect(res.overall.firstResponseP50Minutes).toBe("20.0");
      expect(res.overall.firstResponseP90Minutes).toBe("40.0");
      // الحل: [30,60,90] (C,E,D بالترتيب الزمني، مرتّبة تصاعدياً [30,60,90]).
      expect(res.overall.resolvedCount).toBe(3);
      expect(res.overall.resolutionAvgMinutes).toBe("60.0");
      expect(res.overall.resolutionP50Minutes).toBe("60.0");
      expect(res.overall.resolutionP90Minutes).toBe("90.0");
      // SLA: C(مضبوطة،مُلتزَمة) + D(مضبوطة،متجاوَزة) = مؤهَّلتان، واحدة ملتزمة.
      expect(res.overall.slaEligible).toBe(2);
      expect(res.overall.slaMet).toBe(1);
      expect(res.overall.slaCompliancePct).toBe("50.00");
      // الحل من أول تواصل: من المحلولة الثلاث (C,D,E)، D أُعيد فتحها ⇒ 2/3.
      expect(res.overall.firstContactResolutionCount).toBe(2);
      expect(res.overall.firstContactResolutionPct).toBe("66.67");
      // إعادة الفتح: D فقط من أصل 5.
      expect(res.overall.reopenedCount).toBe(1);
      expect(res.overall.reopenedPct).toBe("20.00");

      // ── تجميع حسب النوع ──
      expect(res.byKind.map((k) => k.kind)).toEqual(["INQUIRY", "SUPPORT"]);
      const inquiry = res.byKind.find((k) => k.kind === "INQUIRY")!;
      expect(inquiry.totalTasks).toBe(3);
      expect(inquiry.firstResponseP50Minutes).toBe("20.0");
      expect(inquiry.slaEligible).toBe(1);
      expect(inquiry.slaMet).toBe(1);
      expect(inquiry.slaCompliancePct).toBe("100.00");
      expect(inquiry.reopenedCount).toBe(0);

      const support = res.byKind.find((k) => k.kind === "SUPPORT")!;
      expect(support.totalTasks).toBe(2);
      expect(support.resolvedCount).toBe(2);
      expect(support.resolutionAvgMinutes).toBe("75.0");
      expect(support.slaEligible).toBe(1);
      expect(support.slaMet).toBe(0);
      expect(support.slaCompliancePct).toBe("0.00");
      expect(support.firstContactResolutionPct).toBe("50.00");
      expect(support.reopenedPct).toBe("50.00");
    });

    it("لا مهام في الفترة ⇒ نتيجة فارغة نظيفة (لا انفجار على قسمة صفر)", async () => {
      const res = await taskResponseReport(PERIOD);
      expect(res.overall.totalTasks).toBe(0);
      expect(res.overall.firstResponseAvgMinutes).toBeNull();
      expect(res.overall.slaCompliancePct).toBeNull();
      expect(res.overall.firstContactResolutionPct).toBeNull();
      expect(res.overall.reopenedPct).toBe("0.00");
      expect(res.byKind).toHaveLength(0);
    });

    it("فلترة الفترة: مهمّة خارج النطاق لا تُحتسب", async () => {
      await insertTask({ createdAt: T, firstResponseAt: addMin(T, 10) });
      await insertTask({ createdAt: new Date("2020-01-05T08:00:00Z"), firstResponseAt: addMin(new Date("2020-01-05T08:00:00Z"), 10) });

      const inRange = await taskResponseReport(PERIOD);
      expect(inRange.overall.totalTasks).toBe(1);

      const outRange = await taskResponseReport({ from: "2019-01-01", to: "2019-12-31" });
      expect(outRange.overall.totalTasks).toBe(0);
    });

    it("عزل الفرع: مهمّة فرعٍ آخر لا تُحتسب عند تحديد الفرع", async () => {
      await insertTask({ branchId: 1, firstResponseAt: addMin(T, 10) });
      await insertTask({ branchId: 2, firstResponseAt: addMin(T, 20) });

      const b1 = await taskResponseReport({ ...PERIOD, branchId: 1 });
      expect(b1.overall.totalTasks).toBe(1);
      const b2 = await taskResponseReport({ ...PERIOD, branchId: 2 });
      expect(b2.overall.totalTasks).toBe(1);
      const all = await taskResponseReport(PERIOD);
      expect(all.overall.totalTasks).toBe(2);
    });
  });

  describe("agentVolumeReport", () => {
    it("عدّ صحيح للمُسنَد/المحلولة/المفتوحة لكل موظف + متوسط زمن الحل + متوسط CSAT", async () => {
      // موظف أ (id 3): محلولتان (20 و40 دقيقة، csat 5 و3) + واحدة قيد التنفيذ (مفتوحة).
      await insertTask({ assignedTo: 3, taskStatus: "RESOLVED", resolvedAt: addMin(T, 20), csatScore: 5 });
      await insertTask({ assignedTo: 3, taskStatus: "RESOLVED", resolvedAt: addMin(T, 40), csatScore: 3 });
      await insertTask({ assignedTo: 3, taskStatus: "IN_PROGRESS" });
      // موظف ب (id 4): ملغاة (مغلقة، ليست محلولة، وليست "مفتوحة") + جديدة (مفتوحة).
      await insertTask({ assignedTo: 4, taskStatus: "CANCELLED" });
      await insertTask({ assignedTo: 4, taskStatus: "NEW" });
      // بلا إسناد ⇒ لا تُحتسب لأي أحد.
      await insertTask({ assignedTo: null, taskStatus: "NEW" });

      const res = await agentVolumeReport(PERIOD);
      expect(res.rows).toHaveLength(2);

      // الأكثر حملاً أولاً (موظف أ: 3 مهام).
      const A = res.rows.find((r) => r.userId === 3)!;
      expect(A.userName).toBe("موظف أ");
      expect(A.assigned).toBe(3);
      expect(A.resolved).toBe(2);
      expect(A.open).toBe(1);
      expect(A.avgResolutionMinutes).toBe("30.0");
      expect(A.avgCsat).toBe("4.00");
      expect(A.csatCount).toBe(2);

      const B = res.rows.find((r) => r.userId === 4)!;
      expect(B.assigned).toBe(2);
      expect(B.resolved).toBe(0);
      expect(B.open).toBe(1); // CANCELLED مغلقة ولا تُحتسب "مفتوحة"، NEW مفتوحة.
      expect(B.avgResolutionMinutes).toBeNull();
      expect(B.avgCsat).toBeNull();

      expect(res.rows[0].userId).toBe(3);
    });

    it("عزل الفرع: مهامّ موظف بفرعٍ آخر لا تُحتسب عند تحديد الفرع", async () => {
      await insertTask({ branchId: 1, assignedTo: 3, taskStatus: "NEW" });
      await insertTask({ branchId: 2, assignedTo: 3, taskStatus: "NEW" });

      const b1 = await agentVolumeReport({ ...PERIOD, branchId: 1 });
      expect(b1.rows.find((r) => r.userId === 3)?.assigned).toBe(1);
      const all = await agentVolumeReport(PERIOD);
      expect(all.rows.find((r) => r.userId === 3)?.assigned).toBe(2);
    });
  });

  describe("csatReport", () => {
    it("توزيع الدرجات + المتوسط + معدّل الاستجابة + فلترة الفترة على csatRequestedAt", async () => {
      // ثلاث مُجابة (5, 5, 4) واثنتان مطلوبتان بلا إجابة — كلّها طُلبت داخل الفترة.
      await insertTask({ csatRequestedAt: addMin(T, 5), csatScore: 5 });
      await insertTask({ csatRequestedAt: addMin(T, 10), csatScore: 5 });
      await insertTask({ csatRequestedAt: addMin(T, 15), csatScore: 4 });
      await insertTask({ csatRequestedAt: addMin(T, 20), csatScore: null });
      await insertTask({ csatRequestedAt: addMin(T, 25), csatScore: null });
      // لم يُطلَب لها تقييم إطلاقاً — لا تُحتسب في requested.
      await insertTask({ csatRequestedAt: null, csatScore: null });
      // طُلبت خارج الفترة (يوم سابق) — تُستبعَد رغم إجابتها.
      await insertTask({ csatRequestedAt: new Date("2026-03-09T08:00:00Z"), csatScore: 5 });

      const res = await csatReport(PERIOD);
      expect(res.requested).toBe(5);
      expect(res.answered).toBe(3);
      expect(res.responseRatePct).toBe("60.00");
      expect(res.average).toBe("4.67");
      expect(res.distribution).toEqual([
        { score: 1, count: 0 },
        { score: 2, count: 0 },
        { score: 3, count: 0 },
        { score: 4, count: 1 },
        { score: 5, count: 2 },
      ]);
    });

    it("لا استطلاعات مطلوبة ⇒ نتيجة فارغة نظيفة", async () => {
      const res = await csatReport(PERIOD);
      expect(res.requested).toBe(0);
      expect(res.answered).toBe(0);
      expect(res.responseRatePct).toBe("0.00");
      expect(res.average).toBeNull();
    });

    it("عزل الفرع: طلب تقييم بفرعٍ آخر لا يُحتسب عند تحديد الفرع", async () => {
      await insertTask({ branchId: 1, csatRequestedAt: addMin(T, 5), csatScore: 5 });
      await insertTask({ branchId: 2, csatRequestedAt: addMin(T, 5), csatScore: 4 });

      const b1 = await csatReport({ ...PERIOD, branchId: 1 });
      expect(b1.requested).toBe(1);
      const all = await csatReport(PERIOD);
      expect(all.requested).toBe(2);
    });
  });

  describe("campaignPerformanceReport", () => {
    it("معدّلات التسليم/القراءة/الفشل لحملة معروفة + الكلفة التقديرية/الفعلية", async () => {
      const b1 = await insertBroadcast({ branchId: 1, audienceCount: 10, costEstimate: "1000.00" });
      // 10 مستلمين: read=2, delivered(إضافي)=3, sent(إضافي)=2, failed=2, skipped=1.
      await insertRecipients(b1, "READ", 2, 1);
      await insertRecipients(b1, "DELIVERED", 3, 100);
      await insertRecipients(b1, "SENT", 2, 200);
      await insertRecipients(b1, "FAILED", 2, 300);
      await insertRecipients(b1, "SKIPPED_OPTOUT", 1, 400);

      const res = await campaignPerformanceReport(PERIOD);
      expect(res.rows).toHaveLength(1);
      const row = res.rows[0];
      expect(row.broadcastId).toBe(b1);
      expect(row.totalRecipients).toBe(10);
      // قمع تراكميّ: read=2، delivered=DELIVERED+READ=5، sent=SENT+delivered=7.
      expect(row.read).toBe(2);
      expect(row.delivered).toBe(5);
      expect(row.sent).toBe(7);
      expect(row.failed).toBe(2);
      expect(row.skippedOptout).toBe(1);
      expect(row.deliveryRatePct).toBe("50.00");
      expect(row.readRatePct).toBe("20.00");
      expect(row.failureRatePct).toBe("20.00");
      expect(row.costEstimate).toBe("1000.00");
      expect(row.actualCost).toBe("700.00"); // sent(7) × 100

      expect(res.summary).toMatchObject({
        campaigns: 1, totalRecipients: 10, delivered: 5, read: 2, failed: 2,
        deliveryRatePct: "50.00", readRatePct: "20.00", failureRatePct: "20.00",
        costEstimate: "1000.00", actualCost: "700.00",
      });
    });

    it("إجماليات مُرجَّحة عبر أكثر من حملة (لا متوسط بسيط للنسب)", async () => {
      const b1 = await insertBroadcast({ branchId: 1, audienceCount: 10, costEstimate: "1000.00" });
      await insertRecipients(b1, "READ", 2, 1);
      await insertRecipients(b1, "DELIVERED", 3, 100);
      await insertRecipients(b1, "SENT", 2, 200);
      await insertRecipients(b1, "FAILED", 2, 300);
      await insertRecipients(b1, "SKIPPED_OPTOUT", 1, 400);

      const b2 = await insertBroadcast({ branchId: 1, audienceCount: 4, costEstimate: "400.00" });
      await insertRecipients(b2, "READ", 1, 1);
      await insertRecipients(b2, "DELIVERED", 1, 100);
      await insertRecipients(b2, "SENT", 1, 200);
      await insertRecipients(b2, "FAILED", 1, 300);

      const res = await campaignPerformanceReport({ ...PERIOD, branchId: 1 });
      expect(res.rows).toHaveLength(2);
      // مجموع: totalRecipients=14, delivered=5+2=7, read=2+1=3, failed=2+1=3.
      expect(res.summary.campaigns).toBe(2);
      expect(res.summary.totalRecipients).toBe(14);
      expect(res.summary.delivered).toBe(7);
      expect(res.summary.read).toBe(3);
      expect(res.summary.failed).toBe(3);
      expect(res.summary.deliveryRatePct).toBe("50.00"); // 7/14
      expect(res.summary.readRatePct).toBe("21.43"); // 3/14
      expect(res.summary.costEstimate).toBe("1400.00");
      expect(res.summary.actualCost).toBe("1000.00"); // (7+3)×100
    });

    it("حملة بلا مستلمين مُدرَجين بعد ⇒ صفّ صفريّ نظيف بلا انفجار على قسمة صفر", async () => {
      await insertBroadcast({ branchId: 1, audienceCount: 5, costEstimate: "500.00" });
      const res = await campaignPerformanceReport(PERIOD);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].totalRecipients).toBe(0);
      expect(res.rows[0].deliveryRatePct).toBe("0.00");
      expect(res.rows[0].actualCost).toBe("0.00");
    });

    it("فلترة الفترة: حملة خارج النطاق لا تُحتسب", async () => {
      await insertBroadcast({ branchId: 1, audienceCount: 1, costEstimate: "100.00", createdAt: new Date("2020-01-05T08:00:00Z") });
      const res = await campaignPerformanceReport(PERIOD);
      expect(res.rows).toHaveLength(0);
      expect(res.summary.campaigns).toBe(0);
    });

    it("عزل الفرع: حملة فرعٍ آخر مخفيّة عند تحديد فرع؛ الحملة العامّة (بلا فرع) ظاهرة للجميع", async () => {
      const b1 = await insertBroadcast({ branchId: 1, audienceCount: 1, costEstimate: "100.00" });
      const b2 = await insertBroadcast({ branchId: 2, audienceCount: 1, costEstimate: "100.00" });
      const global = await insertBroadcast({ branchId: null, audienceCount: 1, costEstimate: "100.00" });

      const branch1View = await campaignPerformanceReport({ ...PERIOD, branchId: 1 });
      const ids1 = branch1View.rows.map((r) => r.broadcastId).sort();
      expect(ids1).toEqual([b1, global].sort());

      const branch2View = await campaignPerformanceReport({ ...PERIOD, branchId: 2 });
      const ids2 = branch2View.rows.map((r) => r.broadcastId).sort();
      expect(ids2).toEqual([b2, global].sort());

      const allView = await campaignPerformanceReport(PERIOD);
      expect(allView.rows).toHaveLength(3);
    });
  });
});
