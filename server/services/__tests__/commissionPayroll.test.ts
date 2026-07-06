/**
 * اختبارات تكامل (DB) لالتقاط الرواتب لتشغيلة العمولات — وحدة الأهداف والعمولات (S4).
 *
 * الثابت الحاكم (I5): التشغيلة المعتمدة تُلتقط في مسيّر شهرها **مرّة واحدة بالضبط**:
 *  - بند «commission» لكل موظف + net يشملها + totalCommission في الرأس + ربط payrollRunId.
 *  - حذف مسودة المسيّر يفكّ الربط تلقائياً (ON DELETE SET NULL) فيلتقطها التوليد التالي — لا ازدواج.
 *  - لا تشغيلة معتمدة (مسودة أو غياب) ⇒ commission=0 بلا فشل ولا ربط.
 *  - مفصول بعد البيع وله عمولة ⇒ بند أجرٍ صفري يصرفها (تسوية نهائية).
 *  - الدفع يقيّد PAYMENT_OUT بصافي البند (شاملاً العمولة) — انحدار مسار الدفع.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeCommissionRun } from "../commissions/engine";
import { approveRun as approveCommission } from "../commissions/runs";
import { assignPlan, createPlan } from "../commissions/plans";
import { saveTargets } from "../commissions/targets";
import { approveRun as approvePayroll, cancelRun, generatePayroll, payRun } from "../payrollService";

const COMPUTER = { userId: 1, branchId: 1 };
const APPROVER = { userId: 2, branchId: 1 };

const TABLES = [
  "accountingEntries",
  "receipts",
  "payrollItems",
  "payrollRuns",
  "commissionRunLines",
  "commissionRuns",
  "commissionAssignments",
  "commissionPlanTiers",
  "commissionPlans",
  "salesTargets",
  "workOrders",
  "invoices",
  "attendance",
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
    { id: 3, openId: "t-seller", name: "بائع", role: "cashier", branchId: 1 },
  ]);
  await d.insert(s.employees).values([
    { id: 11, userId: 3, branchId: 1, firstName: "علي", lastName: "البائع", payType: "monthly", salary: "1000000", allowances: "0" },
  ]);
}

/** خطة 2% فوق 100% + هدف 5,000,000 + بيع 5,200,000 في يونيو ⇒ عمولة 104,000. */
async function approvedJuneCommission() {
  const { planId } = await createPlan(
    { name: "خطة", tierMode: "TARGET_PCT", tiers: [{ threshold: "100", ratePct: "2", fixedBonus: "0" }] },
    COMPUTER,
  );
  await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-01" }, COMPUTER);
  await saveTargets({ period: "2026-06", rows: [{ employeeId: 11, target: "5000000" }] }, COMPUTER);
  const d = db();
  await d.insert(s.invoices).values({
    id: 300, invoiceNumber: "INV-300", sourceType: "POS", sourceId: "t-300", branchId: 1,
    subtotal: "5200000", total: "5200000", paidAmount: "5200000", status: "PAID", createdBy: 3,
  });
  await d.insert(s.accountingEntries).values({
    entryType: "SALE", branchId: 1, invoiceId: 300,
    revenue: "5200000", cost: "0", profit: "5200000", amount: "5200000",
    entryDate: new Date("2026-06-10T00:00:00Z"),
  });
  const run = await computeCommissionRun("2026-06", COMPUTER);
  await approveCommission(run.runId, APPROVER);
  return run.runId;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("commissionPayroll — الالتقاط مرّة واحدة بالضبط (I5)", () => {
  it("توليد المسيّر يلتقط التشغيلة المعتمدة: بند + صافٍ شامل + مجاميع + ربط ثنائي", async () => {
    const commissionRunId = await approvedJuneCommission();
    const run = await generatePayroll("2026-06", COMPUTER);

    const item = run!.items.find((i) => Number(i.employeeId) === 11)!;
    expect(Number(item.gross)).toBe(1000000);
    expect(Number(item.commission)).toBe(104000);
    expect(Number(item.net)).toBe(1104000); // gross + commission

    expect(Number(run!.totalCommission)).toBe(104000);
    expect(Number(run!.totalNet)).toBe(1104000);

    const [cRun] = await db().select().from(s.commissionRuns).where(eq(s.commissionRuns.id, commissionRunId));
    expect(Number(cRun.payrollRunId)).toBe(Number(run!.id));
  });

  it("حذف مسودة المسيّر يفكّ الربط تلقائياً وإعادة التوليد تلتقط مجدداً بلا ازدواج", async () => {
    const commissionRunId = await approvedJuneCommission();
    const first = await generatePayroll("2026-06", COMPUTER);
    await cancelRun(Number(first!.id), COMPUTER); // مسودة ⇒ حذف كامل ⇒ SET NULL على الربط.

    const [afterDelete] = await db().select().from(s.commissionRuns).where(eq(s.commissionRuns.id, commissionRunId));
    expect(afterDelete.payrollRunId).toBeNull();

    const second = await generatePayroll("2026-06", COMPUTER);
    const item = second!.items.find((i) => Number(i.employeeId) === 11)!;
    expect(Number(item.commission)).toBe(104000); // التُقطت مرّة أخرى — في المسيّر الوحيد القائم.

    const allRuns = await db().select().from(s.payrollRuns).where(eq(s.payrollRuns.period, "2026-06"));
    expect(allRuns.length).toBe(1);
    const [relinked] = await db().select().from(s.commissionRuns).where(eq(s.commissionRuns.id, commissionRunId));
    expect(Number(relinked.payrollRunId)).toBe(Number(second!.id));
  });

  it("تشغيلة مسودة (غير معتمدة) لا تُلتقط: commission=0 وبلا ربط وبلا فشل", async () => {
    const { planId } = await createPlan(
      { name: "خطة", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "0", ratePct: "1", fixedBonus: "0" }] },
      COMPUTER,
    );
    await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-01" }, COMPUTER);
    const d = db();
    await d.insert(s.invoices).values({
      id: 301, invoiceNumber: "INV-301", sourceType: "POS", sourceId: "t-301", branchId: 1,
      subtotal: "1000000", total: "1000000", paidAmount: "1000000", status: "PAID", createdBy: 3,
    });
    await d.insert(s.accountingEntries).values({
      entryType: "SALE", branchId: 1, invoiceId: 301,
      revenue: "1000000", cost: "0", profit: "1000000", amount: "1000000",
      entryDate: new Date("2026-06-10T00:00:00Z"),
    });
    const cRun = await computeCommissionRun("2026-06", COMPUTER); // تبقى مسودة.

    const run = await generatePayroll("2026-06", COMPUTER);
    const item = run!.items.find((i) => Number(i.employeeId) === 11)!;
    expect(Number(item.commission)).toBe(0);
    expect(Number(item.net)).toBe(1000000);
    const [c] = await db().select().from(s.commissionRuns).where(eq(s.commissionRuns.id, cRun.runId));
    expect(c.payrollRunId).toBeNull();
  });

  it("مفصول بعد البيع وله عمولة ⇒ بند أجرٍ صفري يصرف عمولته (تسوية نهائية)", async () => {
    await approvedJuneCommission();
    // فُصل قبل توليد المسيّر — التوليد الاعتيادي كان سيتجاهله.
    await db().update(s.employees).set({ employmentStatus: "terminated" }).where(eq(s.employees.id, 11));

    const run = await generatePayroll("2026-06", COMPUTER);
    const item = run!.items.find((i) => Number(i.employeeId) === 11)!;
    expect(Number(item.gross)).toBe(0);
    expect(Number(item.commission)).toBe(104000);
    expect(Number(item.net)).toBe(104000);
  });

  it("الدفع يقيّد PAYMENT_OUT بصافي البند شاملاً العمولة (انحدار مسار الدفع)", async () => {
    await approvedJuneCommission();
    const run = await generatePayroll("2026-06", COMPUTER);
    await approvePayroll(Number(run!.id), APPROVER);
    await payRun(Number(run!.id), APPROVER);

    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_OUT"), eq(s.accountingEntries.dedupeKey, `PAYROLL:${run!.id}:11`)));
    expect(entries.length).toBe(1);
    expect(Number(entries[0].amount)).toBe(1104000);
  });
});
