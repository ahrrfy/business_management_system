/**
 * حارس اتّساق الساعات مع أوقات الدخول/الانصراف (تدقيق ١٧/٨).
 *
 * كان الحقلان يُخزَّنان مستقلَّين بلا ربط، فيمرّ يومٌ أوقاته صحيحة وساعاته صفر ⇒ أجرٌ صفر
 * **ويُرفع عنه وسم المراجعة** فلا يعود أحدٌ ينتبه له. وهذه الحزمة تُثبّت الاتجاهين معاً:
 * المنع حيث يجب، و**المرور حيث يجب** — فمسار الطيّ التلقائي يُنتج ساعاتٍ أقلّ من المدى
 * مشروعةً (الاستراحات مطروحة بالمزاوجة)، وكسرُه يوقف ingest الأجهزة كلَّه.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { recordAttendance } from "../attendanceService";

const TABLES = ["accountingEntries", "payrollItems", "payrollRuns", "attendance", "leaveRequests", "employees", "auditLogs", "branches", "users"];

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

async function emp() {
  const e = await createEmployee({ firstName: "سعد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "0" });
  return e!.id;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("اتّساق الساعات مع أوقات الدخول والانصراف", () => {
  it("يرفض ساعاتٍ تتجاوز المدى بين الدخول والانصراف", async () => {
    const id = await emp();
    // 08:00 ← 17:00 مدىً تسع ساعات؛ ١٥ ساعة أجرُ وقتٍ لم يقع.
    await expect(
      recordAttendance({ employeeId: id, attendanceDate: "2026-08-03", hours: "15", checkIn: "08:00", checkOut: "17:00", status: "PRESENT" }),
    ).rejects.toThrow(/تتجاوز المدى/);
  });

  it("يرفض يوماً بوقتَي دخولٍ وانصراف وساعاته صفر — الفخّ الذي يُصفّر الأجر", async () => {
    const id = await emp();
    await expect(
      recordAttendance({ employeeId: id, attendanceDate: "2026-08-03", hours: "0", checkIn: "07:58", checkOut: "17:00", status: "PRESENT" }),
    ).rejects.toThrow(/صفراً/);
  });

  it("يرفض انصرافاً قبل الدخول", async () => {
    const id = await emp();
    await expect(
      recordAttendance({ employeeId: id, attendanceDate: "2026-08-03", hours: "5", checkIn: "17:00", checkOut: "08:00", status: "PRESENT" }),
    ).rejects.toThrow(/بعد وقت الدخول/);
  });

  it("يقبل ساعاتٍ أقلّ من المدى — الاستراحة المطروحة بمزاوجة البصمات (مسار الطيّ)", async () => {
    const id = await emp();
    // 08:00 ← 20:00 مدىً اثنتا عشرة ساعة، والمزاوجة تُنتج ثمانياً بعد طرح استراحة الغداء.
    const row = await recordAttendance({
      employeeId: id, attendanceDate: "2026-08-03", hours: "8", checkIn: "08:00", checkOut: "20:00", status: "PRESENT", source: "fingerprint",
    });
    expect(row).toBeTruthy();
  });

  it("يقبل تجاوزاً دون التسامح — قصّ الثواني في عرض HH:MM لا يكسر الطيّ", async () => {
    const id = await emp();
    // 08:00 ← 17:00 مدىً 9.00؛ والساعات المحسوبة من طوابع فيها ثوانٍ قد تبلغ 9.02.
    const row = await recordAttendance({
      employeeId: id, attendanceDate: "2026-08-03", hours: "9.02", checkIn: "08:00", checkOut: "17:00", status: "PRESENT", source: "fingerprint",
    });
    expect(row).toBeTruthy();
  });

  it("يقبل صفر ساعات حين لا انصراف — البصمة الفردية لا تُخمَّن ولا تُحجب", async () => {
    const id = await emp();
    const row = await recordAttendance({
      employeeId: id, attendanceDate: "2026-08-03", hours: "0", checkIn: "07:58", checkOut: null,
      status: "PRESENT", source: "fingerprint", needsReview: true, reviewReason: "بصمة واحدة فقط — ينقص تسجيل الخروج",
    });
    expect(row).toBeTruthy();
  });

  it("يقبل صفر ساعات مع حالة غياب رغم وجود الوقتين — الغياب المعلَن ليس فخّاً", async () => {
    const id = await emp();
    const row = await recordAttendance({
      employeeId: id, attendanceDate: "2026-08-03", hours: "0", checkIn: "08:00", checkOut: "17:00", status: "ABSENT",
    });
    expect(row).toBeTruthy();
  });
});
