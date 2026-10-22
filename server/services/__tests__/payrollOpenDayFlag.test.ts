/**
 * حارس الأيام المفتوحة (دخولٌ بلا انصراف) عند توليد واعتماد مسيّر الرواتب — قرار المالك (٢٢/١٠/٢٠٢٦: «٣- نمنع التوليد»).
 *
 * الثوابت المحروسة هنا:
 *   ي١) يومٌ مفتوح غير محسوم ⇒ يُمنع توليد المسيّر (`PRECONDITION_FAILED`) برسالة تسمّي الموظف والتواريخ المفتوحة،
 *       ولا يُنشأ مسيّرٌ جزئيّ في القاعدة (ذرّيّة المعاملة).
 *   ي٢) قائمة تواريخ طويلة (> ٦ أيام) ⇒ تُقصّ بإفصاح (`+N أخرى`) في رسالة المنع.
 *   ي٣) البصمات العابرة لمنتصف الليل (مثل دخول 15:07 وانصراف 00:02 فجر اليوم التالي) تُطوى وتُغلق تلقائياً
 *       قبل التوليد (`healAndRefoldMonthAttendance`)، فيُولَّد المسيّر كاملاً دون توقّف زائف.
 *   ي٤) بعد تصحيح البصمة المفتوحة (أو بلا أيام مفتوحة) ⇒ يُولَّد المسيّر بنجاح بكامل الساعات والعمولات.
 *   ي٥) حارس الاعتماد (`approveRun`): يرفض اعتماد أي مسودة تحمل بنداً موسوماً بـ`PAYROLL_ITEM_ATTENTION_PREFIX`.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { PAYROLL_ITEM_ATTENTION_PREFIX } from "@shared/hr";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { recordAttendance } from "../attendanceService";
import { approveRun, generatePayroll } from "../payrollService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const ADMIN = { userId: 1, branchId: 1, role: "admin" };
const CHECKER = { userId: 2, branchId: 1, role: "admin", isOwner: true };
const PERIOD = "2026-06"; // حزيران ٢٠٢٦: ٢٦ يوم دوام (الجمعة راحة) × ٨ = ٢٠٨ ساعة
const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

async function enableAttendancePay() {
  await db()
    .insert(s.hrAttendanceSettings)
    .values({ id: 1, attendancePayEnabled: true, attendancePayFrom: "2026-06-01" })
    .onDuplicateKeyUpdate({ set: { attendancePayEnabled: true, attendancePayFrom: "2026-06-01" } });
}

/** حضور ٨ ساعات لكل أيام دوام حزيران؛ التواريخ في `openOn` تُترك **مفتوحة** (دخولٌ بلا انصراف). */
async function seedJune(employeeId: number, openOn: string[] = []) {
  const rows: Array<typeof s.attendance.$inferInsert> = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, "0")}`;
    if (DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()] === "الجمعة") continue;
    const open = openOn.includes(date);
    rows.push({
      employeeId, attendanceDate: date, status: "PRESENT",
      checkIn: new Date(`${date}T08:00:00Z`),
      checkOut: open ? null : new Date(`${date}T16:00:00Z`),
      hours: open ? "0.00" : "8.00", hourlyRate: "0.00", amount: "0.00", source: "fingerprint",
    });
  }
  await db().insert(s.attendance).values(rows);
}

async function itemsOf(runId: number) {
  return db().select().from(s.payrollItems).where(eq(s.payrollItems.runId, runId));
}

beforeEach(async () => {
  await truncateTables([
    "payrollItems", "payrollRuns", "commissionRunLines", "commissionRuns",
    "commissionPlanTiers", "commissionPlans", "leaveRequests", "hrAttendancePunches",
    "attendance", "hrFingerprintDevices", "hrAttendanceSettings", "employees", "branches", "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "b", name: "owner", role: "admin", loginMethod: "local", isOwner: true },
  ]);
  await d.insert(s.employees).values([
    { id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "0",
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01" },
    { id: 2, firstName: "سارة", lastName: "العبيدي", payType: "monthly", salary: "900000", allowances: "0",
      employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01" },
  ]);
  await enableAttendancePay();
});

describe("منع توليد واعتماد المسيّر عند وجود بصمات مفتوحة غير محسومة (قرار المالك ٢٢/١٠)", () => {
  it("ي١) يومان مفتوحان لموظف ⇒ يمنع توليد المسيّر برسالة تسمّي الموظف والتواريخ، ولا يُنشأ مسيّر جزئي", async () => {
    await seedJune(1, ["2026-06-08", "2026-06-09"]);
    await seedJune(2);

    await expect(generatePayroll(PERIOD, ADMIN as never)).rejects.toThrow(
      /أحمد الجبوري.*2 يوم بلا انصراف: 2026-06-08، 2026-06-09/,
    );
    const runs = await db().select().from(s.payrollRuns);
    expect(runs).toHaveLength(0);
  });

  it("ي٢) تواريخ مفتوحة كثيرة ⇒ رسالة المنع تُفصح عن القصّ (+N أخرى)", async () => {
    const open = ["06", "07", "08", "09", "10", "11", "13", "14", "15"].map((d) => `2026-06-${d}`);
    await seedJune(1, open);
    await seedJune(2);

    await expect(generatePayroll(PERIOD, ADMIN as never)).rejects.toThrow(
      new RegExp(`\\+${open.length - 6} أخرى`),
    );
  });

  it("ي٣) بصمة انصراف بعد منتصف الليل (00:02 فجر اليوم التالي) تُطوى تلقائياً قبل التوليد فلا تمنع المسيّر", async () => {
    await seedJune(1, ["2026-06-08"]);
    await seedJune(2);

    const d = db();
    await d.insert(s.hrFingerprintDevices).values({
      id: 1, name: "جهاز الرئيسي", branchId: 1, serialNumber: "SN-MAIN-1", enabled: true,
    });
    // بصمات خام ليوم 2026-06-08 (دخول 16:02 وانصراف 00:02 فجر 2026-06-09 = 8 ساعات + دوام 2026-06-09 من 14:00 إلى 22:00)
    await d.insert(s.hrAttendancePunches).values([
      { deviceId: 1, serialNumber: "SN-MAIN-1", enrollId: 1, employeeId: 1, punchAt: "2026-06-08 16:02:00", processedAt: new Date() },
      { deviceId: 1, serialNumber: "SN-MAIN-1", enrollId: 1, employeeId: 1, punchAt: "2026-06-09 00:02:00", processedAt: new Date() },
      { deviceId: 1, serialNumber: "SN-MAIN-1", enrollId: 1, employeeId: 1, punchAt: "2026-06-09 14:00:00", processedAt: new Date() },
      { deviceId: 1, serialNumber: "SN-MAIN-1", enrollId: 1, employeeId: 1, punchAt: "2026-06-09 22:00:00", processedAt: new Date() },
    ]);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    const items = await itemsOf(Number(run.id));
    expect(items).toHaveLength(2);
    const emp1 = items.find((i) => Number(i.employeeId) === 1)!;
    expect(Number(emp1.hours)).toBe(208);
    expect(Number(emp1.gross)).toBeCloseTo(900000, 0);
  });

  it("ي٤) بعد تصحيح اليوم المفتوح يدوياً ⇒ يُولَّد المسيّر بنجاح بكامل الساعات والعمولات", async () => {
    await seedJune(1, ["2026-06-08"]);
    await seedJune(2);
    const d = db();
    await d.insert(s.commissionPlans).values({ id: 1, name: "خطة", basis: "NET_SALES", tierMode: "TARGET_PCT" });
    await d.insert(s.commissionRuns).values({
      id: 1, period: PERIOD, status: "approved", employeeCount: 1, totalCommission: "104000.00",
    });
    await d.insert(s.commissionRunLines).values({
      runId: 1, employeeId: 1, userId: 1, branchId: 1, planId: 1, commissionAmount: "104000.00",
    });

    // قبل التصحيح: يُمنع التوليد
    await expect(generatePayroll(PERIOD, ADMIN as never)).rejects.toThrow(/2026-06-08/);

    // تصحيح اليوم المفتوح
    await recordAttendance({
      employeeId: 1,
      attendanceDate: "2026-06-08",
      checkIn: "08:00",
      checkOut: "16:00",
      hours: "8",
      source: "manual",
    });

    // بعد التصحيح: يُولَّد بنجاح
    const run = await generatePayroll(PERIOD, ADMIN as never);
    const emp1 = (await itemsOf(Number(run.id))).find((i) => Number(i.employeeId) === 1)!;
    expect(Number(emp1.hours)).toBe(208);
    expect(Number(emp1.commission)).toBe(104000);
    expect(Number(emp1.net)).toBeCloseTo(900000 + 104000, 0);
  });

  it("ي٥) حارس الاعتماد يمنع اعتماد مسودة تحتوي على بند موسوم بـPAYROLL_ITEM_ATTENTION_PREFIX", async () => {
    await seedJune(1);
    await seedJune(2);

    const run = await generatePayroll(PERIOD, ADMIN as never);
    await db()
      .update(s.payrollItems)
      .set({ note: `${PAYROLL_ITEM_ATTENTION_PREFIX} 1 يوم بلا انصراف (2026-06-08) — غير محتسَبة` })
      .where(eq(s.payrollItems.runId, Number(run.id)));

    await expect(approveRun(Number(run.id), CHECKER as never)).rejects.toThrow(/بصمات حضور مفتوحة/);
  });
});
