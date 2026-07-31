// حوكمة الإجازات + صدق تقارير الموارد البشرية.
//
// الثوابت المحروسة:
//   ن١) لا يُعتمد طلب إجازة يتداخل مع شهرٍ مسيّرُه معتمد/مدفوع — كان يُعتمَد بأثرٍ رجعيّ
//       فلا يُخصم أبداً: لا في مسيّره (مقفل) ولا في التالي (شهرٌ آخر).
//   ن٢) والرفض يمرّ دائماً (لا أثر ماليّ له).
//   ن٣) لا يُلغي المستخدم إجازته بنفسه — كان يأخذها ثم يستردّ رصيدها ويُسقط خصمها.
//   ن٤) ولا تُلغى إجازةٌ في شهرٍ مقفل.
//   ن٥) «صافي المدفوع» في تقرير الرواتب يجمع المسيّرات المدفوعة وحدها لا المسودّات.
//   ن٦) «إجمالي الأجر» في تقرير الحضور يجمع الساعيّين وحدهم — الشهريّ لا يُدفَع بالساعة.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelLeave, createLeave, decideLeave } from "../leaveService";
import { getAttendanceReport, getPayrollSummary } from "../reportsHrService";
import { recordAttendance } from "../attendanceService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const HR = { userId: 3 };
const SELF = { userId: 2 };

beforeEach(async () => {
  await truncateTables([
    "payrollItems", "payrollRuns", "leaveRequests", "attendance", "employees", "branches", "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 2, openId: "a", name: "الموظف", role: "cashier", loginMethod: "local" },
    { id: 3, openId: "b", name: "الموارد البشرية", role: "manager", loginMethod: "local" },
  ]);
  await d.insert(s.employees).values([
    { id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "0", annualLeaveBalance: 30, employmentStatus: "active", isActive: true, branchId: 1, userId: 2, hireDate: "2025-01-01" },
    { id: 2, firstName: "زينب", lastName: "الربيعي", payType: "hourly", dayRates: { الأحد: 5000, الاثنين: 5000, الثلاثاء: 5000, الأربعاء: 5000, الخميس: 5000, الجمعة: 7500, السبت: 5000 }, employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01" },
  ]);
});

describe("حارس المسيّر المُقفَل على الإجازات (ن١–ن٢، ن٤)", () => {
  async function lockedRun(period: string, status: "approved" | "paid" = "paid") {
    await db().insert(s.payrollRuns).values({
      id: 100, period, branchId: 1, status, employeeCount: 1,
      totalGross: "900000", totalOvertime: "0", totalDeductions: "0", totalNet: "900000", createdBy: 3,
    });
  }

  it("ن١) لا يُعتمد طلب إجازة يتداخل مع شهرٍ مسيّرُه مدفوع", async () => {
    const lv = await createLeave({ employeeId: 1, leaveType: "بدون راتب", fromDate: "2026-07-20", toDate: "2026-07-25", days: 6 });
    await lockedRun("2026-07", "paid");
    await expect(decideLeave(Number(lv!.id), "approved", HR)).rejects.toThrow(/مدفوع/);
    const [after] = await db().select().from(s.leaveRequests).where(eq(s.leaveRequests.id, Number(lv!.id)));
    expect(after.status).toBe("pending");
  });

  it("ن٢) والرفض يمرّ رغم القفل (لا أثر ماليّ)", async () => {
    const lv = await createLeave({ employeeId: 1, leaveType: "بدون راتب", fromDate: "2026-07-20", toDate: "2026-07-25", days: 6 });
    await lockedRun("2026-07", "paid");
    const r = await decideLeave(Number(lv!.id), "rejected", HR);
    expect(r!.status).toBe("rejected");
  });

  it("شهرٌ غير مقفل يمرّ عادياً (صفر انحدار)", async () => {
    const lv = await createLeave({ employeeId: 1, leaveType: "سنوية", fromDate: "2026-09-01", toDate: "2026-09-05", days: 5 });
    const r = await decideLeave(Number(lv!.id), "approved", HR);
    expect(r!.status).toBe("approved");
    const [emp] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(emp.annualLeaveBalance).toBe(25);
  });

  it("ن٤) ولا تُلغى إجازةٌ في شهرٍ صار مقفلاً بعد اعتمادها", async () => {
    const lv = await createLeave({ employeeId: 1, leaveType: "سنوية", fromDate: "2026-08-01", toDate: "2026-08-05", days: 5 });
    await decideLeave(Number(lv!.id), "approved", HR);
    await lockedRun("2026-08", "approved");
    await expect(cancelLeave(Number(lv!.id), HR)).rejects.toThrow(/معتمَد/);
  });
});

describe("فصل المهام على إلغاء الإجازة (ن٣)", () => {
  it("لا يُلغي المستخدم إجازته بنفسه فيستردّ رصيدها", async () => {
    const lv = await createLeave({ employeeId: 1, leaveType: "سنوية", fromDate: "2026-09-10", toDate: "2026-09-19", days: 10 });
    await decideLeave(Number(lv!.id), "approved", HR);
    const [before] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(before.annualLeaveBalance).toBe(20);

    await expect(cancelLeave(Number(lv!.id), SELF)).rejects.toThrow(/إجازتك بنفسك/);
    const [after] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(after.annualLeaveBalance).toBe(20); // الرصيد لم يُستردّ
  });

  it("ومُقرِّرٌ آخر يُلغيها فيستردّ الرصيد", async () => {
    const lv = await createLeave({ employeeId: 1, leaveType: "سنوية", fromDate: "2026-09-10", toDate: "2026-09-19", days: 10 });
    await decideLeave(Number(lv!.id), "approved", HR);
    await cancelLeave(Number(lv!.id), HR);
    const [after] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(after.annualLeaveBalance).toBe(30);
  });
});

describe("صدق تقارير الموارد البشرية (ن٥–ن٦)", () => {
  it("ن٥) «صافي المدفوع» يجمع المدفوعة وحدها", async () => {
    await db().insert(s.payrollRuns).values([
      { id: 1, period: "2026-06", branchId: 1, status: "paid", employeeCount: 1, totalGross: "10000000", totalOvertime: "0", totalDeductions: "0", totalNet: "10000000", createdBy: 3 },
      { id: 2, period: "2026-07", branchId: 1, status: "draft", employeeCount: 1, totalGross: "10200000", totalOvertime: "0", totalDeductions: "0", totalNet: "10200000", createdBy: 3 },
    ]);
    const r = await getPayrollSummary();
    expect(Number(r.totals.net)).toBe(20200000); // كل المعروض
    expect(Number(r.totals.netPaid)).toBe(10000000); // ما خرج فعلاً
    expect(r.totals.paidRuns).toBe(1);
  });

  it("ن٦) «إجمالي الأجر» في تقرير الحضور يستبعد الشهريّين", async () => {
    // الشهريّ يبصم أيضاً فيُحسب له amount من سعر الساعة — لكنه لا يُدفَع بالساعة إطلاقاً.
    await recordAttendance({ employeeId: 1, attendanceDate: "2026-07-15", hours: "8", source: "fingerprint" });
    await recordAttendance({ employeeId: 2, attendanceDate: "2026-07-15", hours: "8", source: "fingerprint" });

    const rep = await getAttendanceReport({ from: "2026-07-01", to: "2026-07-31" });
    expect(rep.totals.days).toBe(2); // الصفّان معروضان
    expect(Number(rep.totals.hours)).toBe(16); // والساعات كلّها
    expect(Number(rep.totals.amount)).toBe(40000); // الأجر للساعيّ وحده (٨×٥٠٠٠)
  });
});
