/**
 * اختبارات تكامل (DB) لخطط العمولات وإسناداتها — وحدة الأهداف والعمولات (S1).
 * تغطّي:
 *  - إنشاء خطة بشرائح + رفض العتبات غير التصاعدية ورفض النِّسَب/المكافآت المتناقصة (منع
 *    «بِع أكثر تربح أقل» بنيوياً).
 *  - الإسناد: يشترط ربط الموظف بمستخدم؛ الإسناد الجديد يُغلق المفتوح السابق آلياً عند
 *    prevPeriod(from)؛ التداخل مع إسناد مُقفَل يُرفض CONFLICT؛ الخطة المعطَّلة لا تُسنَد.
 *  - endAssignment: يقفل المفتوح ويرفض شهراً قبل البداية.
 *  - updatePlan: يستبدل الشرائح كاملاً.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  assignPlan,
  createPlan,
  endAssignment,
  listAssignmentBoard,
  listPlans,
  setPlanActive,
  updatePlan,
} from "../commissions/plans";

const ACTOR = { userId: 1, branchId: 1 };

const TABLES = [
  "commissionRunLines",
  "commissionRuns",
  "commissionAssignments",
  "commissionPlanTiers",
  "commissionPlans",
  "salesTargets",
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

/** موظفان: E1 مرتبط بمستخدم (٣)، E2 بلا حساب — لاختبار شرط الإسناد. */
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "test-admin", name: "مدير النظام", role: "admin", branchId: 1 },
    { id: 2, openId: "test-manager", name: "مدير", role: "manager", branchId: 1 },
    { id: 3, openId: "test-cashier", name: "كاشير", role: "cashier", branchId: 1 },
  ]);
  await d.insert(s.employees).values([
    { id: 11, userId: 3, branchId: 1, firstName: "علي", lastName: "العبيدي", payType: "monthly", salary: "1000000" },
    { id: 12, userId: null, branchId: 1, firstName: "أرشيفي", lastName: "بلا حساب", payType: "monthly", salary: "500000" },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

const TIERS_OK = [
  { threshold: "70", ratePct: "1", fixedBonus: "0" },
  { threshold: "100", ratePct: "2", fixedBonus: "50000" },
];

describe("commissionPlans — الخطط والشرائح", () => {
  it("ينشئ خطة بشرائح مرتّبة ويعيدها في القائمة", async () => {
    const { planId } = await createPlan({ name: "خطة الكاشير", tierMode: "TARGET_PCT", tiers: TIERS_OK }, ACTOR);
    const plans = await listPlans();
    expect(plans.length).toBe(1);
    const p = plans[0];
    expect(p.id).toBe(planId);
    expect(p.basis).toBe("NET_SALES");
    expect(p.tierMode).toBe("TARGET_PCT");
    expect(p.isActive).toBe(true);
    expect(p.tiers.map((t) => t.sort)).toEqual([0, 1]);
    expect(Number(p.tiers[0].threshold)).toBe(70);
    expect(Number(p.tiers[1].ratePct)).toBe(2);
    expect(Number(p.tiers[1].fixedBonus)).toBe(50000);
    expect(p.openAssignments).toBe(0);
  });

  it("يرفض عتبات غير تصاعدية أو مكرّرة", async () => {
    await expect(
      createPlan(
        { name: "خطأ", tierMode: "TARGET_PCT", tiers: [{ threshold: "100", ratePct: "2", fixedBonus: "0" }, { threshold: "70", ratePct: "1", fixedBonus: "0" }] },
        ACTOR,
      ),
    ).rejects.toThrow(/تصاعدية/);
    await expect(
      createPlan(
        { name: "مكرّر", tierMode: "TARGET_PCT", tiers: [{ threshold: "70", ratePct: "1", fixedBonus: "0" }, { threshold: "70", ratePct: "2", fixedBonus: "0" }] },
        ACTOR,
      ),
    ).rejects.toThrow(/تصاعدية/);
  });

  it("يرفض نسبة أو مكافأة تتناقص مع صعود العتبة (منع «بِع أكثر تربح أقل»)", async () => {
    await expect(
      createPlan(
        { name: "نسبة هابطة", tierMode: "TARGET_PCT", tiers: [{ threshold: "70", ratePct: "2", fixedBonus: "0" }, { threshold: "100", ratePct: "1", fixedBonus: "0" }] },
        ACTOR,
      ),
    ).rejects.toThrow(/لا يجوز أن تتناقص/);
    await expect(
      createPlan(
        { name: "مكافأة هابطة", tierMode: "TARGET_PCT", tiers: [{ threshold: "70", ratePct: "1", fixedBonus: "100000" }, { threshold: "100", ratePct: "2", fixedBonus: "0" }] },
        ACTOR,
      ),
    ).rejects.toThrow(/لا يجوز أن تتناقص/);
  });

  it("updatePlan يستبدل الشرائح كاملاً ويحفظ الاسم الجديد", async () => {
    const { planId } = await createPlan({ name: "قديمة", tierMode: "TARGET_PCT", tiers: TIERS_OK }, ACTOR);
    await updatePlan(
      {
        planId,
        name: "محدَّثة",
        tierMode: "AMOUNT_SLAB",
        tiers: [{ threshold: "5000000", ratePct: "1.5", fixedBonus: "0" }],
      },
      ACTOR,
    );
    const [p] = await listPlans();
    expect(p.name).toBe("محدَّثة");
    expect(p.tierMode).toBe("AMOUNT_SLAB");
    expect(p.tiers.length).toBe(1);
    expect(Number(p.tiers[0].threshold)).toBe(5000000);
    expect(p.tiers[0].ratePct).toBe("1.5000");
  });
});

describe("commissionPlans — الإسنادات", () => {
  it("الإسناد يشترط ربط الموظف بحساب مستخدم", async () => {
    const { planId } = await createPlan({ name: "خطة", tierMode: "TARGET_PCT", tiers: TIERS_OK }, ACTOR);
    await expect(assignPlan({ employeeId: 12, planId, effectiveFrom: "2026-07" }, ACTOR)).rejects.toThrow(/حساب مستخدم/);
  });

  it("الإسناد الجديد يُغلق المفتوح السابق آلياً عند الشهر الذي قبله", async () => {
    const a = await createPlan({ name: "أ", tierMode: "TARGET_PCT", tiers: TIERS_OK }, ACTOR);
    const b = await createPlan({ name: "ب", tierMode: "TARGET_PCT", tiers: TIERS_OK }, ACTOR);
    const first = await assignPlan({ employeeId: 11, planId: a.planId, effectiveFrom: "2026-01" }, ACTOR);
    expect(first.closedPrevious).toBeNull();

    const second = await assignPlan({ employeeId: 11, planId: b.planId, effectiveFrom: "2026-03" }, ACTOR);
    expect(second.closedPrevious?.assignmentId).toBe(first.assignmentId);
    expect(second.closedPrevious?.closedAt).toBe("2026-02");

    const rows = await db().select().from(s.commissionAssignments).where(eq(s.commissionAssignments.employeeId, 11));
    const closed = rows.find((r) => r.id === first.assignmentId)!;
    const open = rows.find((r) => r.id === second.assignmentId)!;
    expect(closed.effectiveTo).toBe("2026-02");
    expect(open.effectiveTo).toBeNull();

    const board = await listAssignmentBoard();
    const ali = board.find((r) => r.employeeId === 11)!;
    expect(ali.assignment?.planId).toBe(b.planId);
    // الموظف بلا حساب لا يظهر في لوحة الإسناد إطلاقاً.
    expect(board.find((r) => r.employeeId === 12)).toBeUndefined();

    const plans = await listPlans();
    expect(plans.find((p) => p.id === a.planId)?.openAssignments).toBe(0);
    expect(plans.find((p) => p.id === b.planId)?.openAssignments).toBe(1);
  });

  it("يرفض التداخل مع إسناد مُقفَل سابق (CONFLICT) ولا يقبل بدءاً قبل مفتوح قائم", async () => {
    const a = await createPlan({ name: "أ", tierMode: "TARGET_PCT", tiers: TIERS_OK }, ACTOR);
    const b = await createPlan({ name: "ب", tierMode: "TARGET_PCT", tiers: TIERS_OK }, ACTOR);
    const first = await assignPlan({ employeeId: 11, planId: a.planId, effectiveFrom: "2026-01" }, ACTOR);
    await endAssignment({ assignmentId: first.assignmentId, effectiveTo: "2026-04" });

    // يتقاطع مع [2026-01..2026-04] المُقفَل.
    await expect(assignPlan({ employeeId: 11, planId: b.planId, effectiveFrom: "2026-03" }, ACTOR)).rejects.toThrow(/يتقاطع/);
    // بعده مباشرة يصحّ.
    const ok = await assignPlan({ employeeId: 11, planId: b.planId, effectiveFrom: "2026-05" }, ACTOR);
    expect(ok.assignmentId).toBeGreaterThan(0);

    // إسناد جديد يبدأ في بداية المفتوح القائم نفسها (2026-05) ⇒ فرع «إسناد مفتوح يبدأ في…»
    // (البدء الأسبق من ذلك يصطدم أولاً بالمُقفَل [01..04] — مُغطّى أعلاه).
    await expect(assignPlan({ employeeId: 11, planId: a.planId, effectiveFrom: "2026-05" }, ACTOR)).rejects.toThrow(/مفتوح/);
  });

  it("الخطة المعطَّلة لا تُسنَد، وتعطيلها لا يمسّ الإسنادات القائمة", async () => {
    const a = await createPlan({ name: "أ", tierMode: "TARGET_PCT", tiers: TIERS_OK }, ACTOR);
    await assignPlan({ employeeId: 11, planId: a.planId, effectiveFrom: "2026-01" }, ACTOR);
    await setPlanActive(a.planId, false);

    const plans = await listPlans();
    expect(plans[0].isActive).toBe(false);
    expect(plans[0].openAssignments).toBe(1); // الإسناد باقٍ.

    const b = await createPlan({ name: "ب", tierMode: "TARGET_PCT", tiers: TIERS_OK }, ACTOR);
    await setPlanActive(b.planId, false);
    await expect(assignPlan({ employeeId: 11, planId: b.planId, effectiveFrom: "2026-06" }, ACTOR)).rejects.toThrow(/غير فعّالة/);
  });

  it("endAssignment يرفض شهراً قبل البداية ويرفض إنهاء المُنهى", async () => {
    const a = await createPlan({ name: "أ", tierMode: "TARGET_PCT", tiers: TIERS_OK }, ACTOR);
    const first = await assignPlan({ employeeId: 11, planId: a.planId, effectiveFrom: "2026-03" }, ACTOR);
    await expect(endAssignment({ assignmentId: first.assignmentId, effectiveTo: "2026-02" })).rejects.toThrow(/قبل شهر البدء/);
    await endAssignment({ assignmentId: first.assignmentId, effectiveTo: "2026-03" });
    await expect(endAssignment({ assignmentId: first.assignmentId, effectiveTo: "2026-04" })).rejects.toThrow(/مُنهى/);
  });
});
