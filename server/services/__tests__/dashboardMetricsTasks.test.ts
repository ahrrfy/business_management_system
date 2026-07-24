// اختبار خفيف لعدّادَي المهام الجديدين في morningBrief (نظام المهام الموحّد، T2.3):
//  - myOpenTasks: مهام المستخدم المفتوحة (لا RESOLVED/CANCELLED)، صفر حين لا userId.
//  - overdueTasks: مهام متأخّرة ضمن نطاق الفرع، تستثني المغلقة.
// لا يكسر dashboardMetrics.test.ts القائم (حقول جديدة فقط، لا تعديل على الحقول الموجودة).
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getDashboardMetrics, getMyOpenTasksCount } from "../reports/dashboard";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = ["taskEvents", "tasks", "users", "branches"];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_dmt1", name: "كاشير أ", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_dmt2", name: "كاشير ب", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("getDashboardMetrics — morningBrief.myOpenTasks (T2.3)", () => {
  it("يعدّ مهام المستخدم المفتوحة فقط — يستثني RESOLVED/CANCELLED ومهام غيره", async () => {
    const d = db();
    await d.insert(s.tasks).values([
      { taskNumber: "TSK-T-1", branchId: 1, taskKind: "INQUIRY", taskStatus: "NEW", priority: "NORMAL", title: "١", assignedTo: 1 },
      { taskNumber: "TSK-T-2", branchId: 1, taskKind: "INQUIRY", taskStatus: "IN_PROGRESS", priority: "NORMAL", title: "٢", assignedTo: 1 },
      { taskNumber: "TSK-T-3", branchId: 1, taskKind: "INQUIRY", taskStatus: "RESOLVED", priority: "NORMAL", title: "٣", assignedTo: 1 },
      { taskNumber: "TSK-T-4", branchId: 1, taskKind: "INQUIRY", taskStatus: "CANCELLED", priority: "NORMAL", title: "٤", assignedTo: 1 },
      { taskNumber: "TSK-T-5", branchId: 2, taskKind: "INQUIRY", taskStatus: "NEW", priority: "NORMAL", title: "٥", assignedTo: 2 },
    ]);
    expect(await getMyOpenTasksCount(1)).toBe(2);
    expect(await getMyOpenTasksCount(2)).toBe(1);
    expect(await getMyOpenTasksCount(999)).toBe(0);

    // وصل getDashboardMetrics: userId يُحسب، غيابه يبقيه صفراً (لا يكسر مستدعياً لا يمرّره).
    const withUser = await getDashboardMetrics({ branchId: 1, userId: 1 });
    expect(withUser.morningBrief.myOpenTasks).toBe(2);
    const withoutUser = await getDashboardMetrics({ branchId: 1 });
    expect(withoutUser.morningBrief.myOpenTasks).toBe(0);
  });
});

describe("getDashboardMetrics — morningBrief.overdueTasks (T2.3)", () => {
  it("يعدّ المهام المتأخّرة ضمن نطاق الفرع فقط، ويستثني المغلقة والمستقبلية", async () => {
    const d = db();
    const past = new Date(Date.now() - 3 * 3600_000);
    const future = new Date(Date.now() + 3 * 3600_000);
    await d.insert(s.tasks).values([
      { taskNumber: "TSK-O-1", branchId: 1, taskKind: "INQUIRY", taskStatus: "IN_PROGRESS", priority: "NORMAL", title: "متأخّرة", dueAt: past },
      { taskNumber: "TSK-O-2", branchId: 1, taskKind: "INQUIRY", taskStatus: "NEW", priority: "NORMAL", title: "مستقبلية", dueAt: future },
      { taskNumber: "TSK-O-3", branchId: 1, taskKind: "INQUIRY", taskStatus: "RESOLVED", priority: "NORMAL", title: "محلولة متأخّرة", dueAt: past, resolvedAt: new Date() },
      { taskNumber: "TSK-O-4", branchId: 2, taskKind: "INQUIRY", taskStatus: "IN_PROGRESS", priority: "NORMAL", title: "فرع آخر متأخّر", dueAt: past },
    ]);
    const m1 = await getDashboardMetrics({ branchId: 1 });
    expect(m1.morningBrief.overdueTasks).toBe(1);
    const m2 = await getDashboardMetrics({ branchId: 2 });
    expect(m2.morningBrief.overdueTasks).toBe(1);
    const mAll = await getDashboardMetrics({});
    expect(mAll.morningBrief.overdueTasks).toBe(2);
  });

  it("قاعدة فارغة ⇒ عدّادا المهام صفر ولا انهيار (لا يكسر dashboardMetrics.test.ts القائم)", async () => {
    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.morningBrief.myOpenTasks).toBe(0);
    expect(m.morningBrief.overdueTasks).toBe(0);
  });
});
