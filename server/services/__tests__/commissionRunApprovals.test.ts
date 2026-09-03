import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveCommissionRunRequest,
  rejectCommissionRunRequest,
  requestCommissionRunApproval,
} from "../commissions/runApprovals";

const service = readFileSync("server/services/commissions/runApprovals.ts", "utf8");
const runs = readFileSync("server/services/commissions/runs.ts", "utf8");
const router = readFileSync("server/routers/commissionsRouter.ts", "utf8");
const migration = readFileSync("drizzle/migrations/0310_commission_branch_runs.sql", "utf8");
const payrollReadiness = readFileSync("server/services/commissions/payrollReadiness.ts", "utf8");
const payrollLifecycle = readFileSync("server/services/payroll/lifecycle.ts", "utf8");
const payrollSettlement = readFileSync("server/services/payroll/settlement.ts", "utf8");
const monthCloseReadiness = readFileSync("server/services/reports/monthCloseReadiness.ts", "utf8");

describe("طلبات اعتماد تشغيلات العمولات", () => {
  it("يحفظ طلب الشركة/الفرع كلقطة صفر الأثر", () => {
    const requestSlice = service.slice(
      service.indexOf("export async function requestCommissionRunApproval"),
      service.indexOf("class StaleCommissionRunApproval"),
    );
    expect(requestSlice).toContain("scopeBranchId");
    expect(requestSlice).toContain("baseRunVersion");
    expect(requestSlice).toContain("payloadHash");
    expect(requestSlice).not.toContain("approveRunInTx");
    expect(requestSlice).not.toContain("status: \"approved\"");
  });

  it("لا يقفل تشغيل الشركة إلا من اعتماد طلب الشركة داخل نفس المعاملة", () => {
    const approval = service.slice(service.indexOf("export async function approveCommissionRunRequest"));
    expect(approval).toContain("if (preview.scopeBranchId == null)");
    expect(approval).toContain("approveRunInTx");
    expect(approval).toContain("beforeApply");
    expect(approval).toContain("assertIndependentReviewer");
    expect(approval).toContain("baseRunVersion) !== input.expectedVersion");
    expect(approval).toContain("idempotencyHash(request.payload)");
    expect(approval).toContain('eq(commissionRunApprovalRequests.status, "PENDING")');
    expect(runs).toContain("export async function approveRunInTx");
    expect(router).not.toContain("runsSvc.approveRun(");
  });

  it("يفرض idempotency وmaker-checker ونسخة التشغيل في قاعدة البيانات", () => {
    expect(migration).toContain("uq_commission_run_approval_request_key");
    expect(migration).toContain("uq_commission_run_approval_pending");
    expect(migration).toContain("uq_commission_run_approval_decision");
    expect(migration).toContain("chk_commission_run_approval_maker_checker");
    expect(migration).toContain("trg_commission_runs_version_bu");
    expect(migration).toContain("ON DELETE RESTRICT");
    expect(migration).not.toContain("ON DELETE CASCADE");
    expect(router).toContain("approveRequest: commissionsWriteProcedure");
    expect(router).toContain("assertCompanyCommissionAuthority(ctx.user)");
  });

  it("يحفظ دليل الاعتماد ولا يسمح بإرجاع التشغيل أو حذفه بعد وجود أي طلب", () => {
    expect(runs).toContain("اعتماد تشغيلة العمولات سجل نهائي غير قابل للإلغاء");
    expect(runs).toContain("commissionRunApprovalRequests.runId");
    expect(runs).toContain("دليل الحوكمة دائم وغير قابل للمحو");
    expect(router).not.toContain("unapprove: commissionsWriteProcedure");
  });

  it("يمنع اعتماد/دفع الرواتب قبل أثر عمولة شهري معتمد عند وجود إسنادات فعالة", () => {
    expect(payrollReadiness).toContain("loadEligible(runner, period)");
    expect(payrollReadiness).toContain('run?.status === "approved"');
    expect(payrollReadiness).toContain('.for("update")');
    expect(payrollLifecycle).toContain("assertCommissionArtifactReadyForPayrollTx(tx, run.period)");
    expect(payrollSettlement).toContain("assertCommissionArtifactReadyForPayrollTx(tx, run.period)");
    expect(monthCloseReadiness).toContain("getCommissionPayrollReadiness(db, input.month)");
    expect(monthCloseReadiness).toContain("commissionArtifactReadiness.ready");
    expect(monthCloseReadiness).toContain("موظف ذي خطة فعالة؛ احتسبها واعتمدها قبل إقفال الشركة");
  });
});

const MAKER = { userId: 91, branchId: 1, role: "admin" };
const REVIEWER = { userId: 92, branchId: 1, role: "admin" };

function safeCommissionTestDatabaseUrl(): string | null {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const host = parsed.hostname.toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) ||
    Number(parsed.port || "3306") !== 3310 ||
    !/test/i.test(databaseName)
  ) {
    return null;
  }
  return raw;
}

const SAFE_TEST_DATABASE_URL = safeCommissionTestDatabaseUrl();

function db() {
  if (!SAFE_TEST_DATABASE_URL || process.env.DATABASE_URL !== SAFE_TEST_DATABASE_URL) {
    throw new Error(
      "commission approval DB tests require TEST_DATABASE_URL on loopback:3310 with a test database name",
    );
  }
  const value = getDb();
  if (!value) throw new Error("safe TEST_DATABASE_URL not initialized for commission approval tests");
  return value;
}

async function resetApprovalFixtures() {
  const runner = db();
  await runner.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "commissionRunApprovalRequests",
    "commissionRunLines",
    "commissionRuns",
    "users",
    "branches",
  ]) {
    await runner.execute(sql.raw(`DELETE FROM \`${table}\``));
  }
  await runner.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await runner.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await runner.insert(s.users).values([
    { id: MAKER.userId, openId: "commission-maker", name: "محتسب", role: "admin", branchId: 1 },
    { id: REVIEWER.userId, openId: "commission-reviewer", name: "مراجع", role: "admin", branchId: 1 },
  ]);
}

async function seedDraftRun(period: string) {
  const result = await db().insert(s.commissionRuns).values({
    period,
    status: "draft",
    createdBy: MAKER.userId,
  });
  const insertId = Number((result as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
  if (insertId <= 0) throw new Error("failed to seed commission run");
  return insertId;
}

describe.skipIf(!SAFE_TEST_DATABASE_URL)("طلبات اعتماد العمولات — سباقات قاعدة البيانات", () => {
  beforeEach(resetApprovalFixtures);

  it("يعيد exact replay لطلبين متزامنين بنفس المفتاح والحمولة", async () => {
    const runId = await seedDraftRun("2097-01");
    const runner = db();
    let releaseRunLock!: () => void;
    let announceRunLock!: () => void;
    const runLockHeld = new Promise<void>((resolve) => { announceRunLock = resolve; });
    const keepRunLocked = new Promise<void>((resolve) => { releaseRunLock = resolve; });
    const blocker = runner.transaction(async (tx) => {
      await tx.select({ id: s.commissionRuns.id })
        .from(s.commissionRuns)
        .where(eq(s.commissionRuns.id, runId))
        .for("update");
      announceRunLock();
      await keepRunLocked;
    });
    await runLockHeld;

    const input = {
      requestKey: "commission-concurrent-exact-replay",
      runId,
      reason: "مراجعة شهرية متزامنة",
      scopeBranchId: null,
    } as const;
    const attempts = [
      requestCommissionRunApproval(input, MAKER, null),
      requestCommissionRunApproval(input, MAKER, null),
    ];
    // Both transactions establish their request-key read before the run lock is released.
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseRunLock();
    await blocker;

    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(0);
    const fulfilled = settled
      .filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof requestCommissionRunApproval>>> => item.status === "fulfilled")
      .map((item) => item.value);
    expect(fulfilled).toHaveLength(2);
    expect(new Set(fulfilled.map((item) => Number(item.id))).size).toBe(1);
    expect(fulfilled.filter((item) => item.replayed)).toHaveLength(1);
    expect(fulfilled.filter((item) => !item.replayed)).toHaveLength(1);
    expect(await runner.select().from(s.commissionRunApprovalRequests)).toHaveLength(1);
  });

  it("يوسم رفض طلب نسخته تغيرت STALE ولا يسجله REJECTED", async () => {
    const runId = await seedDraftRun("2097-02");
    const request = await requestCommissionRunApproval({
      requestKey: "commission-stale-rejection-request",
      runId,
      reason: "مراجعة عمولات الشهر",
      scopeBranchId: null,
    }, MAKER, null);

    await db().update(s.commissionRuns)
      .set({
        employeeCount: 1,
        version: sql`${s.commissionRuns.version} + 1`,
      })
      .where(eq(s.commissionRuns.id, runId));

    await expect(rejectCommissionRunRequest({
      id: Number(request.id),
      expectedVersion: Number(request.baseRunVersion),
      decisionKey: "commission-stale-rejection-decision",
      reason: "اللقطة المرسلة لا تصلح للاعتماد",
    }, REVIEWER, null)).rejects.toMatchObject({ code: "CONFLICT" });

    const [stored] = await db().select().from(s.commissionRunApprovalRequests)
      .where(eq(s.commissionRunApprovalRequests.id, Number(request.id)));
    expect(stored).toMatchObject({
      status: "STALE",
      pendingGuard: null,
      reviewedBy: REVIEWER.userId,
      decisionKey: "commission-stale-rejection-decision",
      appliedAt: null,
    });
    expect(stored.decisionHash).toHaveLength(64);
  });

  /*
   * فصل المهام (SOD) — هذا هو الحاجز الذي يعلق فيه المالك الوحيد فعلياً على الإنتاج:
   * من يحتسب التشغيلة أو يطلب اعتمادها لا يستطيع اعتماد الطلب بنفسه. كانت التغطية السابقة
   * نصّيةً فقط (expect(approval).toContain(...)) بلا اختبارٍ سلوكيّ فعليّ يستدعي
   * approveCommissionRunRequest بنفس الفاعل. الثلاثة أدناه يغطّون الحالتين المرفوضتين
   * والحالة الناجحة، كي لا يبقى المسار الحرج مُختبَراً بالنصّ وحده.
   *
   * ⚠️ حاجزان لا حاجزٌ واحد على نطاق الشركة (scopeBranchId=null، وهو نطاق مسيّر الرواتب):
   * approveRunInTx في commissions/runs.ts يفحص `run.createdBy === actor` **قبل** استدعاء
   * beforeApply (حيث يعيش assertIndependentReviewer في runApprovals.ts) فيسبقه برسالته
   * الخاصة كلّما كان المعتمِد هو نفسه محتسب التشغيلة — بصرف النظر عمّن طلب الاعتماد فعلياً.
   * فرسالة "محتسب التشغيلة لا يراجع اعتمادها" في assertIndependentReviewer غيرُ قابلة للوصول
   * على نطاق الشركة تحديداً (تصل فقط عبر طلبات نطاق الفرع، التي لا تمرّ بـapproveRunInTx).
   */
  describe("فصل المهام (SOD) — من يملك اعتماد الطلب", () => {
    it("يمنع منشئ التشغيلة من اعتماد طلب اعتمادها — حتى لو طلبه هو نفسه (حالة المالك الوحيد)", async () => {
      const runId = await seedDraftRun("2097-03"); // createdBy = MAKER
      const request = await requestCommissionRunApproval({
        requestKey: "commission-sod-self-request",
        runId,
        reason: "طلب اعتماد شهري",
        scopeBranchId: null,
      }, MAKER, null); // نفس محتسب التشغيلة يطلب اعتمادها — يطابق مالكاً وحيداً يشغّل النظام.

      await expect(approveCommissionRunRequest({
        id: Number(request.id),
        expectedVersion: Number(request.baseRunVersion),
        decisionKey: "commission-sod-self-decision",
      }, MAKER, null)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("المعتمِد يجب أن يختلف عن مَن احتسب التشغيلة"),
      });

      const [stillPending] = await db().select().from(s.commissionRunApprovalRequests)
        .where(eq(s.commissionRunApprovalRequests.id, Number(request.id)));
      expect(stillPending.status).toBe("PENDING");
      const [run] = await db().select().from(s.commissionRuns).where(eq(s.commissionRuns.id, runId));
      expect(run.status).toBe("draft");
    });

    it("يمنع طالب الاعتماد من مراجعة طلبه بنفسه حتى لو لم يحتسب هو التشغيلة", async () => {
      const runId = await seedDraftRun("2097-04"); // createdBy = MAKER
      const request = await requestCommissionRunApproval({
        requestKey: "commission-sod-requester-request",
        runId,
        reason: "طلب اعتماد شهري",
        scopeBranchId: null,
      }, REVIEWER, null); // REVIEWER يطلب (لا يحتسب) — ثم يحاول اعتماد طلبه هو بنفسه.

      await expect(approveCommissionRunRequest({
        id: Number(request.id),
        expectedVersion: Number(request.baseRunVersion),
        decisionKey: "commission-sod-requester-decision",
      }, REVIEWER, null)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("لا يراجع منشئ طلب الاعتماد طلبه بنفسه"),
      });

      const [stillPending] = await db().select().from(s.commissionRunApprovalRequests)
        .where(eq(s.commissionRunApprovalRequests.id, Number(request.id)));
      expect(stillPending.status).toBe("PENDING");
    });

    it("يعتمد مراجعٌ مستقلٌّ فعلاً الطلب فتُقفل التشغيلة", async () => {
      const runId = await seedDraftRun("2097-05");
      const request = await requestCommissionRunApproval({
        requestKey: "commission-sod-independent-request",
        runId,
        reason: "طلب اعتماد شهري",
        scopeBranchId: null,
      }, MAKER, null);

      const result = await approveCommissionRunRequest({
        id: Number(request.id),
        expectedVersion: Number(request.baseRunVersion),
        decisionKey: "commission-sod-independent-decision",
      }, REVIEWER, null);
      expect(result.replayed).toBe(false);
      expect(result.request.status).toBe("APPROVED");
      expect(result.runApproval?.status).toBe("approved");

      const [run] = await db().select().from(s.commissionRuns).where(eq(s.commissionRuns.id, runId));
      expect(run.status).toBe("approved");
      expect(Number(run.approvedBy)).toBe(REVIEWER.userId);
    });
  });
});
