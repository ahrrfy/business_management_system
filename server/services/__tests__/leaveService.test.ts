/**
 * اختبارات تكامل (DB) لخدمة الإجازات — وحدة الموارد البشرية.
 * تغطّي: حساب عدد الأيام في الخادم من نطاق التواريخ (تجاهل قيمة العميل)؛ رفض التداخل مع
 * طلب قائم لنفس الموظف؛ خصم رصيد الإجازة السنوية عند الموافقة.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee, linkEmployeeAccount } from "../employeeService";
import { cancelLeave, createLeave, decideLeave } from "../leaveService";
import { lockPeriod } from "../periodLockService";

const ACTOR = { userId: 1 };

const TABLES = ["leaveRequests", "financialPeriods", "employees", "auditLogs", "branches", "users"];

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

  /*
   * فصل مهام (HR-PAY-03، leaveService.ts:241) — الحاجز موجود منذ فترة لكن بلا اختبارٍ
   * سلوكيّ فعليّ: كل استدعاءات decideLeave القائمة تستعمل فاعلاً لا يطابق موظف الطلب أبداً،
   * فلا شيء يثبت أنّ رفض الذات يعمل فعلياً، ولا أنّ رصيده يبقى سليماً بعد المحاولة المرفوضة.
   * نفس نمط ثغرة العمولات (assertIndependentReviewer) المُصلَحة سابقاً — راجع
   * commissionRunApprovals.test.ts.
   */
  it("لا يبتّ الموظف في إجازته بنفسه، ومُقرِّرٌ آخر يبتّ فيها فيُخصَم الرصيد (فصل مهام HR-PAY-03)", async () => {
    await db().insert(s.users).values({ id: 2, openId: "test-leave-employee-self", name: "الموظف نفسه", role: "cashier", branchId: 1 });
    const emp = await createEmployee({ firstName: "سارة", lastName: "الجبوري", payType: "monthly", salary: "700000", annualLeaveBalance: 30, branchId: 1 });
    await linkEmployeeAccount(emp!.id, 2);
    const lv = await createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-06-01", toDate: "2026-06-03", days: 3 });

    await expect(decideLeave(lv.id, "approved", { userId: 2 })).rejects.toThrow(/لا يجوز البتّ في إجازتك بنفسك/);
    let [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(30); // المحاولة الذاتية المرفوضة لا تمسّ الرصيد

    await decideLeave(lv.id, "approved", ACTOR); // ACTOR (userId 1) مستقلٌّ عن صاحب الطلب
    [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(27);
  });
});

/*
 * حارس إقفال الفترة المالية العامّة (٣/٩ — مرآة اختبار attendanceGuard.test.ts):
 * assertNoLockedPayroll (أعلاه) يحجب فقط حين يوجد مسيّر رواتب معتمد/مدفوع لنفس الشهر — لا
 * يستشير financialPeriods إطلاقاً. فترةٌ أُقفلت محاسبياً بلا أن يُولَّد لها مسيّر رواتب قطّ
 * تبقى قابلةً لاعتماد/إلغاء إجازةٍ بأثرٍ رجعيّ إلى الأبد رغم أنّ بقيّة الدفتر تعاملها مُقفلة.
 */
describe("حارس إقفال الفترة المالية العامّة على الإجازات", () => {
  it("اعتماد إجازة يُحجب بعد إقفال الفترة حتى بلا مسيّر رواتب أصلاً؛ الرفض يبقى مسموحاً؛ الشهر التالي غير محجوب", async () => {
    const emp = await createEmployee({ firstName: "منى", lastName: "التميمي", payType: "monthly", salary: "800000", annualLeaveBalance: 30, branchId: 1 });
    const lv = await createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-06-10", toDate: "2026-06-12", days: 3 });

    // لا مسيّر رواتب لشهر ٢٠٢٦-٠٦ إطلاقاً — assertNoLockedPayroll وحدها كانت تمرّر هذا بلا اعتراض.
    await db().transaction(async (tx) => {
      await lockPeriod(tx as any, { cutoffDate: "2026-06-30", lockedBy: 1 });
    });

    await expect(decideLeave(lv.id, "approved", ACTOR)).rejects.toThrow(/الفترة المالية مُقفَلة/);
    let [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(30); // المحاولة المرفوضة لا تمسّ الرصيد

    // الرفض لا أثر ماليّ له فيمرّ دائماً — حتى بعد الإقفال (فخّ الـif بلا أقواس).
    await expect(decideLeave(lv.id, "rejected", ACTOR)).resolves.toBeTruthy();
    [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(30);

    // شهرٌ بعد القفل (خارج نطاقه) يبقى مسموحاً — لا حجبَ زائداً عن حدود الفترة المُقفَلة.
    const lvJuly = await createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-07-05", toDate: "2026-07-06", days: 2 });
    await expect(decideLeave(lvJuly.id, "approved", ACTOR)).resolves.toBeTruthy();
    [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(28); // 30 - 2
  });

  it("إلغاء إجازة معتمَدة يُحجب بعد إقفال الفترة حتى بلا مسيّر رواتب أصلاً — الرصيد لا يُستردّ", async () => {
    const emp = await createEmployee({ firstName: "رشا", lastName: "الجنابي", payType: "monthly", salary: "800000", annualLeaveBalance: 30, branchId: 1 });
    const lv = await createLeave({ employeeId: emp!.id, leaveType: "سنوية", fromDate: "2026-06-01", toDate: "2026-06-03", days: 3 });
    await decideLeave(lv.id, "approved", ACTOR); // يُعتمَد قبل الإقفال ⇒ ينجح
    let [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(27); // 30 - 3

    // لا مسيّر رواتب لشهر ٢٠٢٦-٠٦ إطلاقاً.
    await db().transaction(async (tx) => {
      await lockPeriod(tx as any, { cutoffDate: "2026-06-30", lockedBy: 1 });
    });

    await expect(cancelLeave(lv.id, ACTOR)).rejects.toThrow(/الفترة المالية مُقفَلة/);
    [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(Number(e2.annualLeaveBalance)).toBe(27); // لم يُستردّ إلى 30
  });
});
