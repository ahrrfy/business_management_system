import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { accrueMonthlyLeave } from "../hr/leaveAccrual";
import { TRPCError } from "@trpc/server";

describe("Leave Accrual Service (Article 67 Iraqi Labor Law)", () => {
  it("accrues 1.67 days for active employees hired on or before month end", async () => {
    const db = getDb();
    if (!db) return;
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

    const actor = { userId: 1, role: "admin", branchId: 101 } as any;

    // تهيئة فرع
    await db
      .insert(s.branches)
      .values({
        id: 101,
        name: "فرع المنصور",
        code: "MN101",
      })
      .onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });

    // تنظيف أي سجلات سابقة للموظفين والتدقيق
    await db.delete(s.employees).where(sql`id IN (881, 882, 883, 884)`);
    await db.delete(s.auditLogs).where(eq(s.auditLogs.entityId, "2026-09"));

    // موظف نشط 1: مستحق
    await db.insert(s.employees).values({
      id: 881,
      firstName: "أحمد",
      lastName: "علي",
      branchId: 101,
      hireDate: "2026-01-01",
      isActive: true,
      employmentStatus: "active",
      annualLeaveBalance: 10,
    });

    // موظف نشط 2: مستحق (عُين في 15 آب)
    await db.insert(s.employees).values({
      id: 882,
      firstName: "سارة",
      lastName: "حسن",
      branchId: 101,
      hireDate: "2026-08-15",
      isActive: true,
      employmentStatus: "active",
      annualLeaveBalance: 0,
    });

    // موظف غير نشط: مفصول (لا يستحق)
    await db.insert(s.employees).values({
      id: 883,
      firstName: "محمود",
      lastName: "عمر",
      branchId: 101,
      hireDate: "2025-01-01",
      isActive: false,
      employmentStatus: "terminated",
      annualLeaveBalance: 5,
    });

    // موظف تعيين مستقبلي: بعد نهاية شهر أيلول (لا يستحق لشهر 9)
    await db.insert(s.employees).values({
      id: 884,
      firstName: "فاطمة",
      lastName: "حسين",
      branchId: 101,
      hireDate: "2026-10-01",
      isActive: true,
      employmentStatus: "active",
      annualLeaveBalance: 0,
    });

    // تنفيذ التدوير لشهر 2026-09
    const res = await accrueMonthlyLeave("2026-09", actor);

    expect(res.month).toBe("2026-09");
    expect(res.employeesAccrued).toBe(2);
    expect(res.daysPerEmployee).toBe("1.67");
    expect(res.totalDaysAccrued).toBe("3.34");

    // التحقق من قاعدة البيانات
    const [emp1] = await db.select().from(s.employees).where(eq(s.employees.id, 881));
    const [emp2] = await db.select().from(s.employees).where(eq(s.employees.id, 882));
    const [emp3] = await db.select().from(s.employees).where(eq(s.employees.id, 883));
    const [emp4] = await db.select().from(s.employees).where(eq(s.employees.id, 884));

    // تم زيادة رصيد الموظف 1 و 2
    expect(Number(emp1.annualLeaveBalance)).toBeGreaterThan(10);
    expect(Number(emp2.annualLeaveBalance)).toBeGreaterThan(0);

    // لم يتغير رصيد الموظف المفصول 3 وموظف التعيين المستقبلي 4
    expect(Number(emp3.annualLeaveBalance)).toBe(5);
    expect(Number(emp4.annualLeaveBalance)).toBe(0);

    // التحقق من توثيق سجل التدقيق auditLogs
    const [audit] = await db
      .select()
      .from(s.auditLogs)
      .where(
        and(
          eq(s.auditLogs.action, "leave.accrueMonth"),
          eq(s.auditLogs.entityId, "2026-09"),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit.entityType).toBe("leaveAccrual");
  });

  it("rejects re-accruing the same month with PRECONDITION_FAILED (idempotency guard)", async () => {
    const db = getDb();
    if (!db) return;
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

    const actor = { userId: 1, role: "admin", branchId: 101 } as any;

    await db
      .insert(s.users)
      .values({
        id: 1,
        openId: "test-user-admin-1",
        name: "Admin User",
        role: "admin",
      })
      .onDuplicateKeyUpdate({ set: { name: "Admin User" } });

    await db
      .insert(s.branches)
      .values({
        id: 101,
        name: "فرع المنصور",
        code: "MN101",
      })
      .onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });

    // تشغيل التدوير للمرة الأولى (ينجح ويوثّق في auditLogs)
    await accrueMonthlyLeave("2026-09", actor);

    // محاولة التدوير لنفس الشهر مرة ثانية يجب أن تفشل بحارس عدم التكرار
    await expect(accrueMonthlyLeave("2026-09", actor)).rejects.toThrow(
      TRPCError,
    );

    try {
      await accrueMonthlyLeave("2026-09", actor);
    } catch (err: any) {
      expect(err.code).toBe("PRECONDITION_FAILED");
    }
  });

  it("rejects invalid month format with BAD_REQUEST", async () => {
    const actor = { userId: 1, role: "admin" } as any;

    try {
      await accrueMonthlyLeave("2026-13", actor);
      expect.fail("Should have thrown BAD_REQUEST");
    } catch (err: any) {
      expect(err.code).toBe("BAD_REQUEST");
    }

    try {
      await accrueMonthlyLeave("invalid", actor);
      expect.fail("Should have thrown BAD_REQUEST");
    } catch (err: any) {
      expect(err.code).toBe("BAD_REQUEST");
    }
  });
});
