/**
 * اختبارات تكامل (DB) للأداء الحيّ — لوحة الإنجاز و«أدائي» (S5).
 *
 * الضمانات:
 *  - «أدائي» ذاتي بحت: مشتق من userId حصراً؛ لا وجود لمدخل employeeId أصلاً؛
 *    أرقام A لا تتأثر ببيانات B؛ null لغير المرتبط/بلا خطة وهدف.
 *  - اللوحة الحيّة تطابق المحرّك رقماً برقم (مصدر حقيقة واحد) وترتّب بالقاعدة تنازلياً.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeCommissionRun } from "../commissions/engine";
import { approveRun } from "../commissions/runs";
import { getLeaderboard, getMyStatus } from "../commissions/performance";
import { assignPlan, createPlan } from "../commissions/plans";
import { saveTargets } from "../commissions/targets";

const COMPUTER = { userId: 1, branchId: 1 };
const APPROVER = { userId: 2, branchId: 1 };

const TABLES = [
  "accountingEntries",
  "workOrders",
  "invoices",
  "commissionRunLines",
  "commissionRuns",
  "commissionAssignments",
  "commissionPlanTiers",
  "commissionPlans",
  "salesTargets",
  "payrollItems",
  "payrollRuns",
  "employees",
  "auditLogs",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "t-admin", name: "محتسِب", role: "admin", branchId: 1 },
    { id: 2, openId: "t-manager", name: "معتمِد", role: "manager", branchId: 1 },
    { id: 3, openId: "t-a", name: "بائع أ", role: "cashier", branchId: 1 },
    { id: 5, openId: "t-b", name: "بائع ب", role: "cashier", branchId: 1 },
    { id: 7, openId: "t-none", name: "بلا موظف", role: "cashier", branchId: 1 },
  ]);
  await d.insert(s.employees).values([
    { id: 11, userId: 3, branchId: 1, firstName: "أحمد", lastName: "الأول", payType: "monthly", salary: "1000000" },
    { id: 15, userId: 5, branchId: 1, firstName: "باسم", lastName: "الثاني", payType: "monthly", salary: "900000" },
  ]);
}

let seq = 400;
async function sale(sellerId: number, revenue: string, date: string) {
  const d = db();
  const id = ++seq;
  await d.insert(s.invoices).values({
    id, invoiceNumber: `INV-${id}`, sourceType: "POS", sourceId: `t-${id}`, branchId: 1,
    subtotal: revenue, total: revenue, paidAmount: revenue, status: "PAID", createdBy: sellerId,
  });
  await d.insert(s.accountingEntries).values({
    entryType: "SALE", branchId: 1, invoiceId: id,
    revenue, cost: "0", profit: revenue, amount: revenue,
    entryDate: new Date(`${date}T00:00:00Z`),
  });
}

async function planFor(employees: number[]) {
  const { planId } = await createPlan(
    { name: "خطة", tierMode: "TARGET_PCT", tiers: [{ threshold: "100", ratePct: "2", fixedBonus: "0" }] },
    COMPUTER,
  );
  for (const employeeId of employees) await assignPlan({ employeeId, planId, effectiveFrom: "2026-01" }, COMPUTER);
  return planId;
}

beforeEach(async () => {
  await reset();
  await seedBase();
  seq = 400;
});

describe("commissionPerformance — أدائي (ذاتي بحت)", () => {
  it("يعيد أرقام صاحب الجلسة فقط، وأرقام الزميل لا تتسرّب", async () => {
    await planFor([11, 15]);
    await saveTargets(
      { period: "2026-06", rows: [{ employeeId: 11, target: "1000000" }, { employeeId: 15, target: "1000000" }] },
      COMPUTER,
    );
    await sale(3, "1200000", "2026-06-05"); // أ
    await sale(5, "700000", "2026-06-06"); // ب

    const a = await getMyStatus(3, "2026-06");
    expect(a).not.toBeNull();
    expect(Number(a!.effectiveBase)).toBe(1200000);
    expect(Number(a!.achievementPct)).toBe(120);
    expect(Number(a!.projectedCommission)).toBe(24000); // 2% × 1,200,000

    const b = await getMyStatus(5, "2026-06");
    expect(Number(b!.effectiveBase)).toBe(700000);
    expect(Number(b!.projectedCommission)).toBe(0); // 70% < عتبة 100
  });

  it("null لغير المرتبط بموظف، وnull لموظف بلا خطة وبلا هدف، ويظهر بهدفٍ بلا خطة", async () => {
    expect(await getMyStatus(7, "2026-06")).toBeNull(); // مستخدم بلا موظف.
    expect(await getMyStatus(3, "2026-06")).toBeNull(); // موظف بلا خطة ولا هدف.

    await saveTargets({ period: "2026-06", rows: [{ employeeId: 11, target: "500000" }] }, COMPUTER);
    await sale(3, "600000", "2026-06-10");
    const st = await getMyStatus(3, "2026-06");
    expect(st).not.toBeNull();
    expect(st!.planName).toBeNull();
    expect(Number(st!.achievementPct)).toBe(120);
    expect(Number(st!.projectedCommission)).toBe(0); // بلا خطة ⇒ لا عمولة متوقّعة.
  });

  it("settled يعكس سطر تشغيلة الشهر بحالتها، وhistory يعيد الأشهر السابقة", async () => {
    await planFor([11]);
    await saveTargets({ period: "2026-06", rows: [{ employeeId: 11, target: "1000000" }] }, COMPUTER);
    await sale(3, "1500000", "2026-06-05");
    const june = await computeCommissionRun("2026-06", COMPUTER);

    let st = await getMyStatus(3, "2026-06");
    expect(st!.settled).toEqual({ commissionAmount: "30000.00", status: "draft" });

    await approveRun(june.runId, APPROVER);
    await sale(3, "800000", "2026-07-03");
    st = await getMyStatus(3, "2026-07");
    expect(st!.settled).toBeNull(); // لا تشغيلة ليوليو بعد.
    expect(st!.history.length).toBe(1);
    expect(st!.history[0]).toMatchObject({ period: "2026-06", commissionAmount: "30000.00", status: "approved" });
  });
});

describe("commissionPerformance — لوحة الإنجاز الحيّة", () => {
  it("تطابق المحرّك رقماً برقم وترتّب بالقاعدة تنازلياً مع إجماليات صحيحة", async () => {
    await planFor([11, 15]);
    await saveTargets(
      { period: "2026-06", rows: [{ employeeId: 11, target: "1000000" }, { employeeId: 15, target: "2000000" }] },
      COMPUTER,
    );
    await sale(3, "1200000", "2026-06-05");
    await sale(5, "2600000", "2026-06-06");

    const board = await getLeaderboard("2026-06");
    expect(board.rows.length).toBe(2);
    expect(board.rows[0].employeeId).toBe(15); // الأعلى قاعدةً أولاً.
    expect(board.rows[0].rank).toBe(1);

    // مقارنة مع المحرّك (مصدر حقيقة واحد): نفس القاعدة ونفس العمولة.
    const run = await computeCommissionRun("2026-06", COMPUTER);
    const lines = await db().select().from(s.commissionRunLines).where(eq(s.commissionRunLines.runId, run.runId));
    for (const row of board.rows) {
      const line = lines.find((l) => Number(l.employeeId) === row.employeeId)!;
      expect(row.effectiveBase).toBe(line.effectiveBase);
      expect(row.projectedCommission).toBe(line.commissionAmount);
    }

    expect(Number(board.totals.effectiveBase)).toBe(3800000);
    expect(Number(board.totals.target)).toBe(3000000);
    expect(board.totals.withTarget).toBe(2);
    expect(board.totals.reached).toBe(2); // 120% و130%.
    expect(board.totals.below50).toBe(0);
  });

  it("شهر بلا إسنادات ⇒ لوحة فارغة بإجماليات صفرية (لا فشل)", async () => {
    const board = await getLeaderboard("2026-06");
    expect(board.rows).toEqual([]);
    expect(board.totals.withTarget).toBe(0);
  });
});
