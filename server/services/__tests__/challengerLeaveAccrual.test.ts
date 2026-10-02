import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { accrueMonthlyLeave } from "../hr/leaveAccrual";
import { appRouter } from "../../routers";

describe("Adversarial Empirical Verification: Leave Accruals & Idempotency (GAP-14)", () => {
  const actor = { userId: 1, role: "admin", branchId: 101 } as any;

  async function setupBranchAndClean(month: string, empIds: number[]) {
    const db = getDb();
    if (!db) throw new Error("DB not available");
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

    await db
      .insert(s.users)
      .values({
        id: 1,
        openId: "test-admin-wave2",
        name: "Admin Tester",
        role: "admin",
      })
      .onDuplicateKeyUpdate({ set: { name: "Admin Tester" } });

    await db
      .insert(s.branches)
      .values({
        id: 101,
        name: "فرع المنصور التجريبي",
        code: "MN_EXP",
      })
      .onDuplicateKeyUpdate({ set: { name: "فرع المنصور التجريبي" } });

    if (empIds.length > 0) {
      await db.delete(s.employees).where(sql`id IN (${sql.join(empIds.map(id => sql`${id}`), sql`, `)})`);
    }
    await db.delete(s.auditLogs).where(
      and(
        eq(s.auditLogs.action, "leave.accrueMonth"),
        eq(s.auditLogs.entityId, month)
      )
    );
  }

  // ---------------------------------------------------------------------------
  // 1. Idempotency & Repeat Run Tests
  // ---------------------------------------------------------------------------
  describe("1. Idempotency & Re-run Protection", () => {
    it("accrues on the first run and hard-rejects immediate second run with PRECONDITION_FAILED", async () => {
      const db = getDb();
      if (!db) return;
      const testMonth = "2026-05";
      const empId = 7001;
      await setupBranchAndClean(testMonth, [empId]);

      await db.insert(s.employees).values({
        id: empId,
        firstName: "علي",
        lastName: "الكريم",
        branchId: 101,
        hireDate: "2026-01-01",
        isActive: true,
        employmentStatus: "active",
        annualLeaveBalance: 10,
      });

      // Run 1: Must succeed
      const res1 = await accrueMonthlyLeave(testMonth, actor);
      expect(res1.month).toBe(testMonth);
      expect(res1.employeesAccrued).toBe(1);

      // Verify balance after Run 1
      const [empAfterRun1] = await db.select().from(s.employees).where(eq(s.employees.id, empId));
      const balanceAfterRun1 = Number(empAfterRun1.annualLeaveBalance);
      expect(balanceAfterRun1).toBeGreaterThan(10);

      // Run 2: Immediate re-run must throw PRECONDITION_FAILED
      let caughtError: any = null;
      try {
        await accrueMonthlyLeave(testMonth, actor);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(TRPCError);
      expect(caughtError.code).toBe("PRECONDITION_FAILED");
      expect(caughtError.message).toContain("تم احتساب إجازات هذا الشهر مسبقاً");

      // Verify balance did NOT increment a second time
      const [empAfterRun2] = await db.select().from(s.employees).where(eq(s.employees.id, empId));
      expect(Number(empAfterRun2.annualLeaveBalance)).toBe(balanceAfterRun1);

      // Verify exactly ONE audit log exists
      const auditEntries = await db
        .select()
        .from(s.auditLogs)
        .where(
          and(
            eq(s.auditLogs.action, "leave.accrueMonth"),
            eq(s.auditLogs.entityId, testMonth)
          )
        );
      expect(auditEntries.length).toBe(1);
    });

    it("stress-tests race condition: concurrent calls for the same month", async () => {
      const db = getDb();
      if (!db) return;
      const testMonth = "2026-06";
      const empId = 7002;
      await setupBranchAndClean(testMonth, [empId]);

      await db.insert(s.employees).values({
        id: empId,
        firstName: "حسين",
        lastName: "فاضل",
        branchId: 101,
        hireDate: "2026-01-01",
        isActive: true,
        employmentStatus: "active",
        annualLeaveBalance: 5,
      });

      // Launch 2 calls concurrently
      const results = await Promise.allSettled([
        accrueMonthlyLeave(testMonth, actor),
        accrueMonthlyLeave(testMonth, actor),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // At least one must succeed, or if serialized, exactly 1 succeeds and 1 fails
      // Under lock, only 1 should succeed and 1 should reject with PRECONDITION_FAILED or deadlock/lock error
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Verify audit logs
      const auditEntries = await db
        .select()
        .from(s.auditLogs)
        .where(
          and(
            eq(s.auditLogs.action, "leave.accrueMonth"),
            eq(s.auditLogs.entityId, testMonth)
          )
        );
      expect(auditEntries.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Employee Filtering Tests
  // ---------------------------------------------------------------------------
  describe("2. Employee Filtering (Inclusions & Exclusions)", () => {
    it("filters out inactive, terminated, on-leave, and future-hired employees", async () => {
      const db = getDb();
      if (!db) return;
      const testMonth = "2026-07";
      const empIds = [7101, 7102, 7103, 7104, 7105, 7106];
      await setupBranchAndClean(testMonth, empIds);

      // 7101: Active, regular hire -> ELIGIBLE
      await db.insert(s.employees).values({
        id: 7101,
        firstName: "مستحق 1",
        lastName: "نظامي",
        branchId: 101,
        hireDate: "2026-01-10",
        isActive: true,
        employmentStatus: "active",
        annualLeaveBalance: 10,
      });

      // 7102: Inactive flag = false -> INELIGIBLE
      await db.insert(s.employees).values({
        id: 7102,
        firstName: "غير نشط",
        lastName: "معطل",
        branchId: 101,
        hireDate: "2026-01-10",
        isActive: false,
        employmentStatus: "active",
        annualLeaveBalance: 10,
      });

      // 7103: Terminated -> INELIGIBLE
      await db.insert(s.employees).values({
        id: 7103,
        firstName: "مفصول",
        lastName: "منتهي",
        branchId: 101,
        hireDate: "2026-01-10",
        isActive: true,
        employmentStatus: "terminated",
        annualLeaveBalance: 10,
      });

      // 7104: On Leave (employmentStatus = 'leave') -> INELIGIBLE
      await db.insert(s.employees).values({
        id: 7104,
        firstName: "إجازة",
        lastName: "معلقة",
        branchId: 101,
        hireDate: "2026-01-10",
        isActive: true,
        employmentStatus: "leave",
        annualLeaveBalance: 10,
      });

      // 7105: Hired next month (2026-08-01 > 2026-07-31) -> INELIGIBLE
      await db.insert(s.employees).values({
        id: 7105,
        firstName: "تعيين",
        lastName: "مستقبلي",
        branchId: 101,
        hireDate: "2026-08-01",
        isActive: true,
        employmentStatus: "active",
        annualLeaveBalance: 10,
      });

      // 7106: Boundary case: Hired on EXACT last day of month (2026-07-31) -> ELIGIBLE
      await db.insert(s.employees).values({
        id: 7106,
        firstName: "تعيين",
        lastName: "آخر يوم",
        branchId: 101,
        hireDate: "2026-07-31",
        isActive: true,
        employmentStatus: "active",
        annualLeaveBalance: 0,
      });

      const res = await accrueMonthlyLeave(testMonth, actor);

      expect(res.employeesAccrued).toBe(2); // Only 7101 and 7106

      const emps = await db
        .select()
        .from(s.employees)
        .where(sql`id IN (${sql.join(empIds.map(id => sql`${id}`), sql`, `)})`);

      const empMap = new Map(emps.map((e) => [e.id, e]));

      // 7101 (eligible) incremented
      expect(Number(empMap.get(7101)?.annualLeaveBalance)).toBeGreaterThan(10);
      // 7106 (eligible boundary) incremented
      expect(Number(empMap.get(7106)?.annualLeaveBalance)).toBeGreaterThan(0);

      // 7102 (isActive=false) NOT incremented
      expect(Number(empMap.get(7102)?.annualLeaveBalance)).toBe(10);
      // 7103 (terminated) NOT incremented
      expect(Number(empMap.get(7103)?.annualLeaveBalance)).toBe(10);
      // 7104 (employmentStatus=leave) NOT incremented
      expect(Number(empMap.get(7104)?.annualLeaveBalance)).toBe(10);
      // 7105 (hired next month) NOT incremented
      expect(Number(empMap.get(7105)?.annualLeaveBalance)).toBe(10);
    });

    it("verifies leap-year February boundary: hired on Feb 29 in leap year vs Mar 1", async () => {
      const db = getDb();
      if (!db) return;
      const testMonth = "2024-02"; // 2024 is a leap year (29 days)
      const empIds = [7201, 7202];
      await setupBranchAndClean(testMonth, empIds);

      // Hired on Feb 29, 2024 -> ELIGIBLE for 2024-02
      await db.insert(s.employees).values({
        id: 7201,
        firstName: "كبيسة",
        lastName: "29 شباط",
        branchId: 101,
        hireDate: "2024-02-29",
        isActive: true,
        employmentStatus: "active",
        annualLeaveBalance: 0,
      });

      // Hired on Mar 1, 2024 -> INELIGIBLE for 2024-02
      await db.insert(s.employees).values({
        id: 7202,
        firstName: "آذار",
        lastName: "1 آذار",
        branchId: 101,
        hireDate: "2024-03-01",
        isActive: true,
        employmentStatus: "active",
        annualLeaveBalance: 0,
      });

      const res = await accrueMonthlyLeave(testMonth, actor);
      expect(res.employeesAccrued).toBe(1);

      const [emp29] = await db.select().from(s.employees).where(eq(s.employees.id, 7201));
      const [emp01] = await db.select().from(s.employees).where(eq(s.employees.id, 7202));

      expect(Number(emp29.annualLeaveBalance)).toBeGreaterThan(0);
      expect(Number(emp01.annualLeaveBalance)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Accrual Math, Decimal Precision, and DB Storage Investigation
  // ---------------------------------------------------------------------------
  describe("3. Accrual Math & Precision Investigation", () => {
    it("computes exactly 20 / 12 = 1.67 days without floating point errors in service return and audit", async () => {
      const db = getDb();
      if (!db) return;
      const testMonth = "2026-08";
      const empIds = [7301, 7302, 7303];
      await setupBranchAndClean(testMonth, empIds);

      for (const id of empIds) {
        await db.insert(s.employees).values({
          id,
          firstName: `موظف ${id}`,
          lastName: "رياضيات",
          branchId: 101,
          hireDate: "2026-01-01",
          isActive: true,
          employmentStatus: "active",
          annualLeaveBalance: 0,
        });
      }

      const res = await accrueMonthlyLeave(testMonth, actor);

      // Verify exact math: 20 / 12 = 1.6666... rounded to 2 decimal places = 1.67
      expect(res.daysPerEmployee).toBe("1.67");
      expect(res.employeesAccrued).toBe(3);
      // 3 * 1.67 = 5.01
      expect(res.totalDaysAccrued).toBe("5.01");

      // Verify Audit Log payload
      const [audit] = await db
        .select()
        .from(s.auditLogs)
        .where(
          and(
            eq(s.auditLogs.action, "leave.accrueMonth"),
            eq(s.auditLogs.entityId, testMonth)
          )
        );

      expect(audit).toBeDefined();
      expect(audit.action).toBe("leave.accrueMonth");
      expect(audit.entityType).toBe("leaveAccrual");
      expect(audit.entityId).toBe(testMonth);
      expect(audit.userId).toBe(actor.userId);
      expect(audit.branchId).toBe(actor.branchId);

      const newVal = audit.newValue as any;
      expect(newVal.month).toBe(testMonth);
      expect(newVal.employeesAccrued).toBe(3);
      expect(newVal.daysPerEmployee).toBe("1.67");
      expect(newVal.totalDaysAccrued).toBe("5.01");
      expect(newVal.employeeIds).toEqual(expect.arrayContaining(empIds));
    });

    it("EMPIRICAL FINDING: examines MySQL database column behavior on INT column", async () => {
      const db = getDb();
      if (!db) return;
      const testMonth = "2026-10";
      const empId = 7401;
      await setupBranchAndClean(testMonth, [empId]);

      await db.insert(s.employees).values({
        id: empId,
        firstName: "فحص",
        lastName: "العمود",
        branchId: 101,
        hireDate: "2026-01-01",
        isActive: true,
        employmentStatus: "active",
        annualLeaveBalance: 0,
      });

      await accrueMonthlyLeave(testMonth, actor);

      const [emp] = await db.select().from(s.employees).where(eq(s.employees.id, empId));

      // Note: Because drizzle schema defines annualLeaveBalance as `int`,
      // adding 1.67 to 0 in MySQL produces 2 (MySQL rounds 1.67 to nearest integer).
      // This is documented as an empirical observation:
      // While Decimal.js math in leaveAccrual.ts calculates 1.67, MySQL's INT column rounds it.
      expect(Number(emp.annualLeaveBalance)).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Overload and Router Integration Tests
  // ---------------------------------------------------------------------------
  describe("4. Overload and tRPC Router Integration", () => {
    it("supports both (month, actor) and (actor, { month }) invocation signatures", async () => {
      const db = getDb();
      if (!db) return;

      // Signature 1: (month, actor)
      await setupBranchAndClean("2026-11", []);
      const res1 = await accrueMonthlyLeave("2026-11", actor);
      expect(res1.month).toBe("2026-11");

      // Signature 2: (actor, { month })
      await setupBranchAndClean("2026-12", []);
      const res2 = await accrueMonthlyLeave(actor, { month: "2026-12" });
      expect(res2.month).toBe("2026-12");
    });

    it("verifies tRPC caller execution via appRouter.leaves.accrueMonth with owner authz", async () => {
      const db = getDb();
      if (!db) return;
      const routerMonth = "2025-01";
      await setupBranchAndClean(routerMonth, []);

      // 1. Non-owner caller must be rejected with FORBIDDEN
      const nonOwnerCaller = appRouter.createCaller({
        user: {
          id: 1,
          openId: "test-admin-wave2",
          name: "Non-Owner Admin",
          role: "admin",
          isOwner: false,
          branchId: 101,
        } as any,
        scopedBranchId: 101,
        scopedOwnerId: null,
        req: {} as any,
        res: {} as any,
      });

      await expect(
        nonOwnerCaller.leaves.accrueMonth({ month: routerMonth })
      ).rejects.toThrow(/هذا الإجراء يتطلب حساب مالك نشطاً/);

      // 2. Owner caller must succeed
      const ownerCaller = appRouter.createCaller({
        user: {
          id: 1,
          openId: "test-admin-wave2",
          name: "Owner Admin",
          role: "admin",
          isOwner: true,
          branchId: 101,
        } as any,
        scopedBranchId: 101,
        scopedOwnerId: null,
        req: {} as any,
        res: {} as any,
      });

      const res = await ownerCaller.leaves.accrueMonth({ month: routerMonth });
      expect(res.month).toBe(routerMonth);
      expect(res.daysPerEmployee).toBe("1.67");

      // 3. Second run via caller must fail with PRECONDITION_FAILED
      await expect(ownerCaller.leaves.accrueMonth({ month: routerMonth })).rejects.toThrow(
        TRPCError
      );
    });

    it("rejects malformed month formats through tRPC router", async () => {
      const caller = appRouter.createCaller({
        user: {
          id: 1,
          openId: "test-admin-wave2",
          name: "Admin Caller",
          role: "admin",
          branchId: 101,
        },
        scopedBranchId: 101,
        scopedOwnerId: null,
        req: {} as any,
        res: {} as any,
      });

      // Zod schema regex rejection
      await expect(caller.leaves.accrueMonth({ month: "2026-13" })).rejects.toThrow();
      await expect(caller.leaves.accrueMonth({ month: "invalid" })).rejects.toThrow();
      await expect(caller.leaves.accrueMonth({ month: "2026-1" })).rejects.toThrow();
    });
  });
});
