/**
 * عزل الفرع في وحدة الإجازات (قرار المالك ١٢/٨ — تدقيق ١٧/٨).
 *
 * كانت الوحدة — كأختها الحضور — بلا أيّ حاجز فرع، والإجازة **كتابةٌ ماليّة**: المدفوعة
 * يومُ دوامٍ كامل وغيرُ المدفوعة خصمٌ، وكلتاهما تدخلان `computeAttendancePay` ⇒ إنشاءٌ أو
 * بتٌّ من خارج الفرع يغيّر أجرَ موظفٍ في مسيّرٍ لا يملكه الفاعل ويخصم رصيده.
 *
 * تحرس الاتجاهين: المُقيَّد لا يرى ولا يكتب خارج فرعه، والعابر (null) كما كان — صفر انحدار.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { balances, cancelLeave, createLeave, decideLeave, listLeaves } from "../leaveService";

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

  const a = await createEmployee({ firstName: "زيد", lastName: "الرئيسي", payType: "monthly", salary: "900000", branchId: MAIN });
  const b = await createEmployee({ firstName: "بكر", lastName: "الآخر", payType: "monthly", salary: "900000", branchId: OTHER });
  mainEmp = a!.id;
  otherEmp = b!.id;
});

describe("القراءة — لا تتعدّى الفرع المُسنَد", () => {
  beforeEach(async () => {
    await createLeave({ employeeId: mainEmp, leaveType: "سنوية", fromDate: "2026-07-05", toDate: "2026-07-06", days: 2 });
    await createLeave({ employeeId: otherEmp, leaveType: "سنوية", fromDate: "2026-07-05", toDate: "2026-07-06", days: 2 });
  });

  it("قائمة الطلبات تُظهر موظفي الفرع وحدهم", async () => {
    const scoped = await listLeaves({ scopedBranchId: MAIN });
    expect(scoped.map((l) => l.employeeId)).toEqual([mainEmp]);
  });

  it("العابر (null) يرى الفرعين — صفر انحدار على الأدمن/المالك", async () => {
    const all = await listLeaves({ scopedBranchId: null });
    expect(all.map((l) => l.employeeId).sort()).toEqual([mainEmp, otherEmp].sort());
  });

  it("أرصدة الإجازات لا تُسرّب موظفي الفرع الآخر", async () => {
    expect((await balances(MAIN)).map((e) => e.id)).toEqual([mainEmp]);
    expect((await balances(null)).map((e) => e.id).sort()).toEqual([mainEmp, otherEmp].sort());
  });
});

describe("الكتابة — الإجازة تغيّر أجراً ورصيداً", () => {
  it("إنشاء إجازة لموظف فرعٍ آخر يُرفَض", async () => {
    await expect(
      createLeave({ employeeId: otherEmp, leaveType: "سنوية", fromDate: "2026-07-05", toDate: "2026-07-06", days: 2, scopedBranchId: MAIN }),
    ).rejects.toThrow(/فرعٍ آخر/);
  });

  it("إنشاء إجازة لموظف الفرع نفسه يمرّ", async () => {
    await expect(
      createLeave({ employeeId: mainEmp, leaveType: "سنوية", fromDate: "2026-07-05", toDate: "2026-07-06", days: 2, scopedBranchId: MAIN }),
    ).resolves.toBeTruthy();
  });

  it("البتّ في طلب موظف فرعٍ آخر يُرفَض صراحةً — لا صمتاً", async () => {
    const lv = await createLeave({ employeeId: otherEmp, leaveType: "سنوية", fromDate: "2026-07-05", toDate: "2026-07-06", days: 2 });
    await expect(decideLeave(lv!.id, "approved", { userId: 1, scopedBranchId: MAIN })).rejects.toThrow(/فرعٍ آخر/);
    // والعابر يبتّ فيه.
    await expect(decideLeave(lv!.id, "approved", { userId: 1, scopedBranchId: null })).resolves.toBeTruthy();
  });

  it("إلغاء إجازة معتمَدة لموظف فرعٍ آخر يُرفَض", async () => {
    const lv = await createLeave({ employeeId: otherEmp, leaveType: "سنوية", fromDate: "2026-07-05", toDate: "2026-07-06", days: 2 });
    await decideLeave(lv!.id, "approved", { userId: 1 });
    await expect(cancelLeave(lv!.id, { userId: 1, scopedBranchId: MAIN })).rejects.toThrow(/فرعٍ آخر/);
  });
});
