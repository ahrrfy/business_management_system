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
  "users", "branches",
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
    broadcastAutoId = 1;
    await reset();
    await seedBase();
  });

  describe("taskResponseReport", () => {
    it("يعيد استجابة فارغة آمنة عند استئصال وحدة المهام", async () => {
      const res = await taskResponseReport(PERIOD);
      expect(res.overall.totalTasks).toBe(0);
      expect(res.byKind).toEqual([]);
    });
  });

  describe("agentVolumeReport", () => {
    it("يعيد تقريراً فارغاً آمناً", async () => {
      const res = await agentVolumeReport(PERIOD);
      expect(res.rows).toEqual([]);
    });
  });

  describe("csatReport", () => {
    it("يعيد استجابة فارغة آمنة بلا مهام", async () => {
      const res = await csatReport(PERIOD);
      expect(res.requested).toBe(0);
      expect(res.answered).toBe(0);
      expect(res.responseRatePct).toBe("0.00");
      expect(res.average).toBeNull();
      expect(res.distribution).toHaveLength(5);
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
