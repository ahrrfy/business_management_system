/**
 * اختبارات تكامل (DB) لمحرّك تشغيلات العمولة — القلب المالي للوحدة (S3).
 *
 * الثوابت المُختبرة:
 *  I1: مجاميع الرأس = Σ الأسطر.
 *  I2: carryIn(P) = carryOut(آخر معتمد < P)، ولا ترحيل من مسودة (حارس التسلسل يمنع القفز).
 *  I3: effectiveBase = max(0, مبيعات − مرتجعات + carryIn) وcarryOut = min(0, نفسه).
 *  I4: شريحة كامل-الأساس بأعلى عتبة ≤ المقياس + مكافأة، round2 HALF_UP.
 *  I5: SOD (المعتمِد ≠ المحتسِب) + حارس مسيّر الرواتب.
 *  I6: المعتمدة محصَّنة (لا إعادة احتساب/حذف) وإلغاء الاعتماد محكوم بالسلسلة والالتقاط.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeCommissionRun } from "../commissions/engine";
import { approveRun, deleteDraft, getRun, unapproveRun } from "../commissions/runs";
import { assignPlan, createPlan } from "../commissions/plans";
import { saveTargets } from "../commissions/targets";

const COMPUTER = { userId: 1, branchId: 1 };
const APPROVER = { userId: 2, branchId: 1 };

const TABLES = [
  "commissionRunLines",
  "commissionRuns",
  "commissionAssignments",
  "commissionPlanTiers",
  "commissionPlans",
  "salesTargets",
  "payrollItems",
  "payrollRuns",
  "accountingEntries",
  "workOrders",
  "invoices",
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

/** U3 (موظف 11) وU5 (موظف 15) بائعان؛ U4 مُسلِّم بلا إسناد. */
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "t-admin", name: "محتسِب", role: "admin", branchId: 1 },
    { id: 2, openId: "t-manager", name: "معتمِد", role: "manager", branchId: 1 },
    { id: 3, openId: "t-seller", name: "بائع أول", role: "cashier", branchId: 1 },
    { id: 4, openId: "t-deliverer", name: "مُسلِّم", role: "cashier", branchId: 1 },
    { id: 5, openId: "t-seller2", name: "بائع ثانٍ", role: "cashier", branchId: 1 },
  ]);
  await d.insert(s.employees).values([
    { id: 11, userId: 3, branchId: 1, firstName: "علي", lastName: "الأول", payType: "monthly", salary: "1000000" },
    { id: 15, userId: 5, branchId: 1, firstName: "حسن", lastName: "الثاني", payType: "monthly", salary: "900000" },
  ]);
}

const TIERS = [
  { threshold: "70", ratePct: "1", fixedBonus: "0" },
  { threshold: "100", ratePct: "2", fixedBonus: "50000" },
];

async function makeTargetPlanAssigned(employees: number[], from = "2026-01") {
  const { planId } = await createPlan({ name: "خطة الهدف", tierMode: "TARGET_PCT", tiers: TIERS }, COMPUTER);
  for (const employeeId of employees) await assignPlan({ employeeId, planId, effectiveFrom: from }, COMPUTER);
  return planId;
}

let invoiceSeq = 100;
async function seedSale(opts: { sellerId: number; revenue: string; date: string; viaWorkOrderDeliveredBy?: number }) {
  const d = db();
  const id = ++invoiceSeq;
  const viaWO = opts.viaWorkOrderDeliveredBy != null;
  await d.insert(s.invoices).values({
    id,
    invoiceNumber: `INV-${id}`,
    sourceType: viaWO ? "WORKORDER" : "POS",
    sourceId: viaWO ? `WO-${id}` : `t-${id}`,
    branchId: 1,
    subtotal: opts.revenue,
    total: opts.revenue,
    paidAmount: opts.revenue,
    status: "PAID",
    createdBy: viaWO ? opts.viaWorkOrderDeliveredBy! : opts.sellerId,
  });
  if (viaWO) {
    await d.insert(s.workOrders).values({
      id,
      orderNumber: `WO-${id}`,
      branchId: 1,
      title: "أمر شغل",
      salePrice: opts.revenue,
      status: "DELIVERED",
      invoiceId: id,
      createdBy: opts.sellerId,
    });
  }
  await d.insert(s.accountingEntries).values({
    entryType: "SALE", branchId: 1, invoiceId: id,
    revenue: opts.revenue, cost: "0", profit: opts.revenue, amount: opts.revenue,
    entryDate: new Date(`${opts.date}T00:00:00Z`),
  });
  return id;
}

async function seedReturn(invoiceId: number, revenue: string, date: string) {
  await db().insert(s.accountingEntries).values({
    entryType: "RETURN", branchId: 1, invoiceId,
    revenue: `-${revenue}`, cost: "0", profit: `-${revenue}`, amount: `-${revenue}`,
    entryDate: new Date(`${date}T00:00:00Z`),
  });
}

async function lineOf(runId: number, employeeId: number) {
  const run = await getRun(runId);
  return run!.lines.find((l) => Number(l.employeeId) === employeeId)!;
}

beforeEach(async () => {
  await reset();
  await seedBase();
  invoiceSeq = 100;
});

describe("commissionEngine — الوعاء والشرائح", () => {
  it("TARGET_PCT: قاعدة صافية بعد المرتجع + أعلى عتبة ≤ الإنجاز + النسبة على كامل الأساس + المكافأة (I3+I4)", async () => {
    await makeTargetPlanAssigned([11]);
    await saveTargets({ period: "2026-06", rows: [{ employeeId: 11, target: "5000000" }] }, COMPUTER);
    const inv = await seedSale({ sellerId: 3, revenue: "5400000", date: "2026-06-10" });
    await seedReturn(inv, "200000", "2026-06-20");

    const res = await computeCommissionRun("2026-06", COMPUTER);
    const line = await lineOf(res.runId, 11);
    // القاعدة الفعلية = 5,400,000 − 200,000 = 5,200,000 ⇒ إنجاز 104% ⇒ شريحة 100 ⇒
    // 2% × 5,200,000 = 104,000 + مكافأة 50,000 = 154,000.
    expect(Number(line.effectiveBase)).toBe(5200000);
    expect(Number(line.achievementPct)).toBe(104);
    expect(line.tierIndex).toBe(1);
    expect(Number(line.commissionAmount)).toBe(154000);
    expect(Number(line.carryOut)).toBe(0);
  });

  it("إسناد WORKORDER لمنشئ أمر الشغل لا لمُسلِّم الفاتورة", async () => {
    await makeTargetPlanAssigned([11]);
    await saveTargets({ period: "2026-06", rows: [{ employeeId: 11, target: "1000000" }] }, COMPUTER);
    // U4 يكتب فاتورة التسليم لكن أمر الشغل أنشأه U3 (الموظف 11).
    await seedSale({ sellerId: 3, revenue: "2000000", date: "2026-06-12", viaWorkOrderDeliveredBy: 4 });

    const res = await computeCommissionRun("2026-06", COMPUTER);
    const line = await lineOf(res.runId, 11);
    expect(Number(line.baseSales)).toBe(2000000);
  });

  it("دون العتبة الأولى ⇒ لا شريحة وعمولة صفر", async () => {
    await makeTargetPlanAssigned([11]);
    await saveTargets({ period: "2026-06", rows: [{ employeeId: 11, target: "5000000" }] }, COMPUTER);
    await seedSale({ sellerId: 3, revenue: "3000000", date: "2026-06-05" }); // 60% < 70%

    const res = await computeCommissionRun("2026-06", COMPUTER);
    const line = await lineOf(res.runId, 11);
    expect(line.tierIndex).toBeNull();
    expect(Number(line.commissionAmount)).toBe(0);
  });

  it("TARGET_PCT بلا هدف ⇒ سطر صفري مكتوب بعلامة noTarget", async () => {
    await makeTargetPlanAssigned([11]);
    await seedSale({ sellerId: 3, revenue: "9000000", date: "2026-06-05" });

    const res = await computeCommissionRun("2026-06", COMPUTER);
    const line = await lineOf(res.runId, 11);
    expect(line.achievementPct).toBeNull();
    expect(Number(line.commissionAmount)).toBe(0);
    expect((line.detail as { noTarget?: boolean }).noTarget).toBe(true);
  });

  it("AMOUNT_SLAB يقيس بمبلغ القاعدة بلا حاجة لهدف", async () => {
    const { planId } = await createPlan(
      { name: "شرائح مبلغ", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "1000000", ratePct: "1", fixedBonus: "0" }] },
      COMPUTER,
    );
    await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-01" }, COMPUTER);
    await seedSale({ sellerId: 3, revenue: "1500000", date: "2026-06-08" });

    const res = await computeCommissionRun("2026-06", COMPUTER);
    const line = await lineOf(res.runId, 11);
    expect(Number(line.commissionAmount)).toBe(15000); // 1% × 1,500,000
    expect(line.achievementPct).toBeNull();
  });

  it("موظف مؤهَّل بصفر نشاط يحصل على سطر (سلسلة الترحيل واكتمال الالتقاط)", async () => {
    await makeTargetPlanAssigned([11, 15]);
    await seedSale({ sellerId: 3, revenue: "1000000", date: "2026-06-05" });

    const res = await computeCommissionRun("2026-06", COMPUTER);
    expect(res.employeeCount).toBe(2);
    const idle = await lineOf(res.runId, 15);
    expect(Number(idle.baseSales)).toBe(0);
    expect(Number(idle.commissionAmount)).toBe(0);
  });

  it("مرتجعات الشراء وقيود ADJUST خارج الوعاء بنيوياً", async () => {
    await makeTargetPlanAssigned([11]);
    await saveTargets({ period: "2026-06", rows: [{ employeeId: 11, target: "1000000" }] }, COMPUTER);
    const inv = await seedSale({ sellerId: 3, revenue: "1000000", date: "2026-06-05" });
    const d = db();
    // مرتجع شراء: supplierId مضبوط وinvoiceId فارغ — يجب ألّا يمسّ الوعاء.
    await d.insert(s.suppliers).values({ id: 900, name: "مورد اختبار" });
    await d.insert(s.accountingEntries).values({
      entryType: "RETURN", branchId: 1, supplierId: 900,
      revenue: "0", cost: "0", profit: "0", amount: "-500000",
      entryDate: new Date("2026-06-10T00:00:00Z"),
    });
    // تقريب نقدي ADJUST على نفس الفاتورة — مستبعد بفلتر entryType.
    await d.insert(s.accountingEntries).values({
      entryType: "ADJUST", branchId: 1, invoiceId: inv,
      revenue: "-250", cost: "0", profit: "-250", amount: "-250",
      entryDate: new Date("2026-06-05T00:00:00Z"),
    });

    const res = await computeCommissionRun("2026-06", COMPUTER);
    const line = await lineOf(res.runId, 11);
    expect(Number(line.baseSales)).toBe(1000000);
    expect(Number(line.baseReturns)).toBe(0);
  });
});

describe("commissionEngine — الترحيل والتسلسل (I2)", () => {
  it("مرتجع شهرٍ لاحق يُخصم في شهره من البائع الأصلي ويرحَّل سالبه ثم يُستهلك", async () => {
    await makeTargetPlanAssigned([11]);
    // يونيو: بيع واعتماد.
    const inv = await seedSale({ sellerId: 3, revenue: "1000000", date: "2026-06-10" });
    const june = await computeCommissionRun("2026-06", COMPUTER);
    await approveRun(june.runId, APPROVER);

    // يوليو: لا مبيعات، مرتجع 300,000 من فاتورة يونيو ⇒ قاعدة يوليو سالبة تُرحَّل.
    await seedReturn(inv, "300000", "2026-07-05");
    const july = await computeCommissionRun("2026-07", COMPUTER);
    const julyLine = await lineOf(july.runId, 11);
    expect(Number(julyLine.baseReturns)).toBe(300000);
    expect(Number(julyLine.effectiveBase)).toBe(0);
    expect(Number(julyLine.carryOut)).toBe(-300000);
    await approveRun(july.runId, APPROVER);

    // آب: بيع 500,000 ⇒ يبدأ بمرحَّل −300,000 فالقاعدة الفعلية 200,000 (I2: carryIn=carryOut السابق).
    await seedSale({ sellerId: 3, revenue: "500000", date: "2026-08-03" });
    const aug = await computeCommissionRun("2026-08", COMPUTER);
    const augLine = await lineOf(aug.runId, 11);
    expect(Number(augLine.carryIn)).toBe(-300000);
    expect(Number(augLine.effectiveBase)).toBe(200000);
  });

  it("حارس التسلسل: لا احتساب لشهر وثمة مسودة أقدم", async () => {
    await makeTargetPlanAssigned([11]);
    await seedSale({ sellerId: 3, revenue: "100000", date: "2026-06-01" });
    await computeCommissionRun("2026-06", COMPUTER); // تبقى مسودة.
    await expect(computeCommissionRun("2026-07", COMPUTER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("إعادة احتساب المسودة idempotent: سطر واحد لكل موظف ومجاميع مطابقة (I1)", async () => {
    await makeTargetPlanAssigned([11, 15]);
    await saveTargets({ period: "2026-06", rows: [{ employeeId: 11, target: "1000000" }, { employeeId: 15, target: "1000000" }] }, COMPUTER);
    await seedSale({ sellerId: 3, revenue: "1200000", date: "2026-06-04" });
    await seedSale({ sellerId: 5, revenue: "800000", date: "2026-06-06" });

    const first = await computeCommissionRun("2026-06", COMPUTER);
    const second = await computeCommissionRun("2026-06", COMPUTER);
    expect(second.recomputed).toBe(true);
    expect(second.runId).toBe(first.runId);

    const run = (await getRun(second.runId))!;
    expect(run.lines.length).toBe(2);
    const sumLines = run.lines.reduce((acc, l) => acc + Number(l.commissionAmount), 0);
    expect(Number(run.totalCommission)).toBe(sumLines);
    const sumSales = run.lines.reduce((acc, l) => acc + Number(l.baseSales), 0);
    expect(Number(run.totalBaseSales)).toBe(sumSales);
  });

  it("سباق احتساب متزامن لنفس الشهر ⇒ تشغيلة واحدة فقط (uq_commission_period)", async () => {
    await makeTargetPlanAssigned([11]);
    await seedSale({ sellerId: 3, revenue: "100000", date: "2026-06-01" });
    const results = await Promise.allSettled([
      computeCommissionRun("2026-06", COMPUTER),
      computeCommissionRun("2026-06", COMPUTER),
    ]);
    const runs = await db().select().from(s.commissionRuns).where(eq(s.commissionRuns.period, "2026-06"));
    expect(runs.length).toBe(1);
    // إمّا فشل أحدهما بالسباق، أو تسلسلا (الثاني أعاد الاحتساب) — كلاهما سليم مالياً.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("commissionEngine — دورة الحياة (I5+I6)", () => {
  async function draftJune() {
    await makeTargetPlanAssigned([11]);
    await seedSale({ sellerId: 3, revenue: "1000000", date: "2026-06-01" });
    return computeCommissionRun("2026-06", COMPUTER);
  }

  it("SOD: المعتمِد = المحتسِب يُرفض FORBIDDEN، وغيره يمرّ", async () => {
    const run = await draftJune();
    await expect(approveRun(run.runId, COMPUTER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok = await approveRun(run.runId, APPROVER);
    expect(ok.status).toBe("approved");
  });

  it("المعتمدة محصَّنة: لا إعادة احتساب ولا حذف (I6)", async () => {
    const run = await draftJune();
    await approveRun(run.runId, APPROVER);
    await expect(computeCommissionRun("2026-06", COMPUTER)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(deleteDraft(run.runId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("حارس الرواتب: مسيّر معتمد للشهر يمنع الاعتماد، ومسودة تمرّره بعلم إعادة التوليد", async () => {
    const run = await draftJune();
    const d = db();
    await d.insert(s.payrollRuns).values({ id: 700, period: "2026-06", status: "approved", createdBy: 1 });
    await expect(approveRun(run.runId, APPROVER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await d.update(s.payrollRuns).set({ status: "draft" }).where(eq(s.payrollRuns.id, 700));
    const ok = await approveRun(run.runId, APPROVER);
    expect(ok.requiresPayrollRegeneration).toBe(true);
  });

  it("إلغاء الاعتماد: ممنوع بعد الالتقاط أو بوجود شهر أحدث، ويعود مسودةً في الحالة السليمة", async () => {
    const run = await draftJune();
    await approveRun(run.runId, APPROVER);

    // شهر أحدث ⇒ ممنوع.
    await seedSale({ sellerId: 3, revenue: "50000", date: "2026-07-01" });
    const july = await computeCommissionRun("2026-07", COMPUTER);
    await expect(unapproveRun(run.runId, APPROVER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await deleteDraft(july.runId);

    // مُلتقَط ⇒ ممنوع.
    const d = db();
    await d.insert(s.payrollRuns).values({ id: 701, period: "2026-06", status: "draft", createdBy: 1 });
    await d.update(s.commissionRuns).set({ payrollRunId: 701 }).where(eq(s.commissionRuns.id, run.runId));
    await expect(unapproveRun(run.runId, APPROVER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // فكّ الربط ⇒ يمرّ.
    await d.update(s.commissionRuns).set({ payrollRunId: null }).where(eq(s.commissionRuns.id, run.runId));
    const res = await unapproveRun(run.runId, APPROVER);
    expect(res.status).toBe("draft");
  });

  it("لا موظفين مؤهَّلين ⇒ رفض واضح بلا تشغيلة يتيمة", async () => {
    await expect(computeCommissionRun("2026-06", COMPUTER)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const runs = await db().select().from(s.commissionRuns).where(and(eq(s.commissionRuns.period, "2026-06")));
    expect(runs.length).toBe(0);
  });
});
