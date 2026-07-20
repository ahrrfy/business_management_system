/**
 * حارس المسيّر المُقفَل على تسجيل الحضور (تدقيق ١٧/٧):
 * لا يُسجَّل/يُعدَّل حضور لشهرٍ مسيّرُه معتمد/مدفوع (يُفسد أساس مسيّر مُلتزَم مالياً). المسودة لا تحجب.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { recordAttendance } from "../attendanceService";
import { approveRun, generatePayroll } from "../payrollService";

const ACTOR = { userId: 1, branchId: 1 };
const APPROVER = { userId: 2, branchId: 1 }; // فصل مهام: المعتمِد ≠ المولِّد

const TABLES = [
  "accountingEntries",
  "payrollItems",
  "payrollRuns",
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
    { id: 2, openId: "test-approver", name: "مدقّق", role: "manager", branchId: 1 },
  ]);
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("حارس المسيّر المُقفَل على الحضور", () => {
  it("المسودة لا تحجب الحضور؛ الاعتماد يحجبه لنفس الشهر؛ الشهر الآخر يبقى مسموحاً", async () => {
    const emp = await createEmployee({ firstName: "علي", lastName: "العبيدي", payType: "monthly", salary: "900000", allowances: "0" });

    // مسيّر مسودة لشهر ٢٠٢٦-٠٦ ⇒ تسجيل الحضور ما زال مسموحاً.
    const run = await generatePayroll("2026-06", ACTOR);
    await expect(
      recordAttendance({ employeeId: emp!.id, attendanceDate: "2026-06-01", hours: "8", status: "PRESENT" }),
    ).resolves.toBeTruthy();

    // بعد الاعتماد ⇒ يُرفَض تسجيل/تعديل حضور نفس الشهر.
    await approveRun(run!.id, APPROVER);
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
});
