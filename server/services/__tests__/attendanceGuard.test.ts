/**
 * حارس المسيّر المُقفَل على تسجيل الحضور (تدقيق ١٧/٧):
 * تثبّت المسودة أساس الأجر وحد السلفة؛ تعديل الحضور يستلزم حذف المسودة أولاً.
 * يبقى شهر المسيّر المعتمد/المدفوع محمياً من تعديل أساس الالتزام المالي.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { recordAttendance, recomputeMonthRates } from "../attendanceService";
import { approveRun, cancelRun, generatePayroll, payRun } from "../payrollService";
import { lockPeriod } from "../periodLockService";

const ACTOR = { userId: 1, branchId: 1 };
const APPROVER = { userId: 2, branchId: 1 }; // فصل مهام: المعتمِد ≠ المولِّد

const TABLES = [
  "accountingEntries",
  "receipts",
  "payrollItems",
  "payrollRuns",
  "financialPeriods",
  "attendance",
  "leaveRequests",
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
    { id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: 1 },
    { id: 2, openId: "test-approver", name: "مدقّق", role: "manager", branchId: 1, isOwner: true, isActive: true },
  ]);
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("حارس المسيّر المُقفَل على الحضور", () => {
  it("يثبت الحضور مع المسودة؛ حذفها يسمح بالتصحيح؛ الاعتماد يحجب الشهر وحده", async () => {
    const emp = await createEmployee({ firstName: "علي", lastName: "العبيدي", payType: "monthly", salary: "900000", allowances: "0", branchId: 1 });

    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-01", hours: "8", status: "PRESENT" }),
    ).resolves.toBeTruthy();
    const run = await generatePayroll("2026-06", ACTOR);
    if (run?.id == null) throw new Error("Expected a generated draft payroll");
    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-02", hours: "8", status: "PRESENT" }),
    ).rejects.toThrow(/مسيّر رواتب مسودّة/);
    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-01", hours: "6", status: "PRESENT" }),
    ).rejects.toThrow(/مسيّر رواتب مسودّة/);
    await expect(cancelRun(run.id, APPROVER)).resolves.toMatchObject({ deleted: true });
    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-02", hours: "8", status: "PRESENT" }),
    ).resolves.toBeTruthy();
    const regenerated = await generatePayroll("2026-06", ACTOR);
    if (regenerated?.id == null) throw new Error("Expected a regenerated draft payroll");

    // بعد الاعتماد ⇒ يُرفَض تسجيل/تعديل حضور نفس الشهر.
    await approveRun(regenerated.id, APPROVER);
    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-02", hours: "8", status: "PRESENT" }),
    ).rejects.toThrow(/مسيّر رواتب/);
    // حتى تعديل صفٍّ موجود في الشهر المُقفَل يُرفَض.
    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-01", hours: "6", status: "PRESENT" }),
    ).rejects.toThrow(/مسيّر رواتب/);

    // شهرٌ آخر (٢٠٢٦-٠٧) بلا مسيّر معتمد ⇒ مسموح.
    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-07-01", hours: "8", status: "PRESENT" }),
    ).resolves.toBeTruthy();
  });

  /*
   * الاختبار أعلاه يغطي "approved" فقط — طرف "paid" (المال فعلياً خرج) لم يُختبَر رغم أنه
   * الحالة الأكثر حساسية: تعديل حضورٍ بعد الدفع يُفسد أساساً مُصرَفاً فعلياً لا مجرّد مُلتزَم.
   */
  it("المسيّر المدفوع يبقى حاجزاً على تعديل حضور شهره", async () => {
    const emp = await createEmployee({ firstName: "زينب", lastName: "الحيدري", payType: "monthly", salary: "900000", allowances: "0", branchId: 1 });
    await db().insert(s.receipts).values({
      branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "5000000.00",
      paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "TEST-ATTENDANCE-GUARD-FUND", createdBy: 2,
    });

    await recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-01", hours: "8", status: "PRESENT" });
    const run = await generatePayroll("2026-06", ACTOR);
    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER);

    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-02", hours: "8", status: "PRESENT" }),
    ).rejects.toThrow(/مسيّر رواتب/);
    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-01", hours: "6", status: "PRESENT" }),
    ).rejects.toThrow(/مسيّر رواتب/);
  });

  /*
   * حارس المسيّر أعلاه يمنع فقط حين يوجد مسيّر رواتب معتمد/مدفوع لنفس الشهر — لا يستشير
   * الفترة المالية العامّة (financialPeriods) إطلاقاً. فإن أُقفلت فترةٌ محاسبياً بلا أن يُولَّد
   * لها مسيّر رواتب قطّ، يبقى الحضور فيها قابلاً للتعديل/التأريخ الرجعيّ إلى الأبد رغم أنّ بقيّة
   * الدفتر (المبيعات/المشتريات/السندات…) تعامله مُقفلاً نهائياً — يُفسد أساس تقاريرَ سابقة بصمت.
   */
  it("إقفال الفترة المالية العامّة يحجب الحضور حتى بلا مسيّر رواتب أصلاً لذلك الشهر", async () => {
    const emp = await createEmployee({ firstName: "هدى", lastName: "السامرائي", payType: "monthly", salary: "900000", allowances: "0", branchId: 1 });

    // لا مسيّر رواتب لشهر ٢٠٢٦-٠٦ إطلاقاً — الحارس القديم كان يمرّر هذا بلا اعتراض.
    await db().transaction(async (tx) => {
      await lockPeriod(tx as any, { cutoffDate: "2026-06-30", lockedBy: 1 });
    });

    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-15", hours: "8", status: "PRESENT" }),
    ).rejects.toThrow(/الفترة المالية مُقفَلة/);
    await expect(
      recomputeMonthRates({ period: "2026-06" }),
    ).rejects.toThrow(/الفترة المالية مُقفَلة/);

    // شهرٌ بعد القفل (خارج نطاقه) يبقى مسموحاً — لا حجبَ زائداً عن حدود الفترة المُقفَلة.
    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-07-01", hours: "8", status: "PRESENT" }),
    ).resolves.toBeTruthy();
  });
});
