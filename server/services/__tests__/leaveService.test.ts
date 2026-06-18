/**
 * اختبارات تكامل (DB) لخدمة الإجازات — وحدة الموارد البشرية.
 * تغطّي: حساب عدد الأيام في الخادم من نطاق التواريخ (تجاهل قيمة العميل)؛ رفض التداخل مع
 * طلب قائم لنفس الموظف؛ خصم رصيد الإجازة السنوية عند الموافقة.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { cancelLeave, createLeave, decideLeave } from "../leaveService";
import { truncateTables } from "./__testUtils__";

const ACTOR = { userId: 1 };

const TABLES = ["leaveRequests", "employees", "auditLogs", "branches", "users"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await truncateTables(TABLES);
}
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([{ id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: 1 }]);
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("leaveService", () => {
  it("يحسب عدد الأيام في الخادم من نطاق التواريخ (شاملاً الطرفين) ويتجاهل قيمة العميل", async () => {
    const emp = await createEmployee({ firstName: "حسن", lastName: "العزاوي", payType: "monthly", salary: "800000", annualLeaveBalance: 30, branchId: 1 });
    // العميل يرسل days=999 خطأً/تلاعباً ⇒ الخادم يحسب 5 (1..5 شاملاً الطرفين).
    const lv = await createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-06-01", toDate: "2026-06-05", days: 999 });
    expect(lv.days).toBe(5);
  });

  it("يرفض إجازة متداخلة مع طلب قائم لنفس الموظف", async () => {
    const emp = await createEmployee({ firstName: "ليلى", lastName: "المالكي", payType: "monthly", salary: "800000", annualLeaveBalance: 30, branchId: 1 });
    await createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-06-01", toDate: "2026-06-05", days: 5 });
    await expect(
      createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-06-04", toDate: "2026-06-08", days: 5 }),
    ).rejects.toThrow();
  });

  it("الموافقة على إجازة سنوية تخصم الأيام من رصيد الموظف", async () => {
    const emp = await createEmployee({ firstName: "عمر", lastName: "الدليمي", payType: "monthly", salary: "800000", annualLeaveBalance: 30, branchId: 1 });
    const lv = await createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-06-01", toDate: "2026-06-03", days: 3 });
    await decideLeave(lv.id, "approved", ACTOR);
    const [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(27);
  });

  it("رفض الطلب لا يمسّ الرصيد", async () => {
    const emp = await createEmployee({ firstName: "زيد", lastName: "الحلفي", payType: "monthly", salary: "800000", annualLeaveBalance: 30, branchId: 1 });
    const lv = await createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-06-10", toDate: "2026-06-12", days: 3 });
    await decideLeave(lv.id, "rejected", ACTOR);
    const [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(30);
  });

  it("تُرفض الموافقة عند عدم كفاية الرصيد (بلا قصّ صامت)", async () => {
    const emp = await createEmployee({ firstName: "مها", lastName: "الربيعي", payType: "monthly", salary: "800000", annualLeaveBalance: 2, branchId: 1 });
    const lv = await createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-06-01", toDate: "2026-06-05", days: 5 });
    await expect(decideLeave(lv.id, "approved", ACTOR)).rejects.toThrow();
    const [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(2); // الرصيد لم يُمَسّ
  });

  it("إلغاء إجازة موافق عليها يستردّ الأيام المخصومة بدقّة", async () => {
    const emp = await createEmployee({ firstName: "بكر", lastName: "النعيمي", payType: "monthly", salary: "800000", annualLeaveBalance: 30, branchId: 1 });
    const lv = await createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-06-01", toDate: "2026-06-04", days: 4 });
    await decideLeave(lv.id, "approved", ACTOR);
    let [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(26); // 30 - 4

    const cancelled = await cancelLeave(lv.id, ACTOR);
    expect(cancelled.status).toBe("rejected");
    [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(30); // استُرِدّ بالكامل
  });
});
