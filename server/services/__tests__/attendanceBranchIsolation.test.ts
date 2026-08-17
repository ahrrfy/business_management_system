/**
 * عزل الفرع في وحدة الحضور (قرار المالك ١٢/٨ — تدقيق ١٧/٨).
 *
 * كانت الوحدة كلُّها بلا أيّ حاجز فرع: صفر إشارة إلى `branchId` في `attendanceService.ts`،
 * فمدير فرعٍ يقرأ رواتب موظفي الفرع الآخر و**يكتب لهم حضوراً** (وساعاتُ الحضور تتحوّل أجراً).
 *
 * تحرس هذه الحزمة الاتجاهين معاً:
 *   • المُقيَّد بفرعه (scopedBranchId = رقم) لا يرى ولا يكتب خارجه.
 *   • العابر (scopedBranchId = null ⇒ أدمن/مالك) يرى الجميع كما كان — صفر انحدار.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { formOptions, listAttendance, monthSummary, recordAttendance } from "../attendanceService";
import { getEmployeeStatement } from "../hr/employeeStatement";

const TABLES = ["accountingEntries", "payrollItems", "payrollRuns", "attendance", "leaveRequests", "employees", "auditLogs", "branches", "users"];
const MAIN = 1;
const OTHER = 2;

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

let mainEmp = 0;
let otherEmp = 0;

beforeEach(async () => {
  await reset();
  const d = db();
  await d.insert(s.branches).values([
    { id: MAIN, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: OTHER, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([{ id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: MAIN }]);

  const a = await createEmployee({ firstName: "علي", lastName: "الرئيسي", payType: "hourly", branchId: MAIN, dayRates: { الأحد: 5000 } as never });
  const b = await createEmployee({ firstName: "عمر", lastName: "الآخر", payType: "hourly", branchId: OTHER, dayRates: { الأحد: 5000 } as never });
  mainEmp = a!.id;
  otherEmp = b!.id;

  // يومُ أحدٍ لكلٍّ منهما (2026-07-05 أحد).
  await recordAttendance({ employeeId: mainEmp, attendanceDate: "2026-07-05", hours: "8", status: "PRESENT" });
  await recordAttendance({ employeeId: otherEmp, attendanceDate: "2026-07-05", hours: "8", status: "PRESENT" });
});

describe("القراءة — لا تتعدّى الفرع المُسنَد", () => {
  it("سجلّ الحضور يُظهر موظفي الفرع وحدهم", async () => {
    const scoped = await listAttendance({ period: "2026-07", scopedBranchId: MAIN });
    expect(scoped.rows.map((r) => r.employeeId)).toEqual([mainEmp]);
    expect(scoped.total).toBe(1);
  });

  it("العابر (null) يرى الفرعين — صفر انحدار على الأدمن/المالك", async () => {
    const all = await listAttendance({ period: "2026-07", scopedBranchId: null });
    expect(all.rows.map((r) => r.employeeId).sort()).toEqual([mainEmp, otherEmp].sort());
    expect(all.total).toBe(2);
  });

  it("قائمة الموظفين (تغذّي نموذج التسجيل) لا تُسرّب معرّفات الفرع الآخر", async () => {
    const scoped = await formOptions(MAIN);
    expect(scoped.map((e) => e.id)).toEqual([mainEmp]);
    const all = await formOptions(null);
    expect(all.map((e) => e.id).sort()).toEqual([mainEmp, otherEmp].sort());
  });

  it("ملخّص الشهر يقتصر على الفرع", async () => {
    const scoped = await monthSummary("2026-07", MAIN);
    expect(scoped.map((e) => e.employeeId)).toEqual([mainEmp]);
  });

  it("كشف موظف الفرع الآخر يُرفَض صراحةً — لا يُعاد null فتُقرأ «غير موجود»", async () => {
    await expect(getEmployeeStatement({ employeeId: otherEmp, period: "2026-07", scopedBranchId: MAIN })).rejects.toThrow(/فرعٍ آخر/);
    // وموظف الفرع نفسه يمرّ، والعابر يقرأ الاثنين.
    await expect(getEmployeeStatement({ employeeId: mainEmp, period: "2026-07", scopedBranchId: MAIN })).resolves.toBeTruthy();
    await expect(getEmployeeStatement({ employeeId: otherEmp, period: "2026-07", scopedBranchId: null })).resolves.toBeTruthy();
  });
});

describe("الكتابة — أخطر من القراءة (الساعات تتحوّل أجراً)", () => {
  it("تسجيل حضورٍ لموظف فرعٍ آخر يُرفَض", async () => {
    await expect(
      recordAttendance({ employeeId: otherEmp, attendanceDate: "2026-07-06", hours: "8", status: "PRESENT", scopedBranchId: MAIN }),
    ).rejects.toThrow(/فرعٍ آخر/);
  });

  it("تسجيل حضورٍ لموظف الفرع نفسه يمرّ", async () => {
    await expect(
      recordAttendance({ employeeId: mainEmp, attendanceDate: "2026-07-06", hours: "8", status: "PRESENT", scopedBranchId: MAIN }),
    ).resolves.toBeTruthy();
  });

  it("الطيّ التلقائي من الجهاز لا يمرّر عزلاً ⇒ يبقى يكتب للفرعين (لا فاعل بشريّ)", async () => {
    await expect(
      recordAttendance({ employeeId: otherEmp, attendanceDate: "2026-07-07", hours: "8", status: "PRESENT", source: "fingerprint" }),
    ).resolves.toBeTruthy();
  });
});
