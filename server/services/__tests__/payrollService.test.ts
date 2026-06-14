/**
 * اختبارات تكامل (DB) لخدمة الرواتب — وحدة الموارد البشرية (وحدة مالية حسّاسة).
 * تغطّي:
 *  - generate: ينشئ مسيّر مسودة بصافٍ صحيح لموظف شهري (أساسي + مخصّصات).
 *  - pay: يقيّد accountingEntries بمفتاح dedupe المتوقّع PAYROLL:<runId>:<employeeId>.
 *  - generate مرّتين لنفس الشهر ⇒ رفض (CONFLICT).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { approveRun, cancelRun, generatePayroll, getRun, payRun } from "../payrollService";

const ACTOR = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries",
  "payrollItems",
  "payrollRuns",
  "attendance",
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
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: 1 },
  ]);
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("payrollService — generate", () => {
  it("ينشئ مسيّر مسودة بصافٍ صحيح لموظف شهري (أساسي + مخصّصات)", async () => {
    await createEmployee({ firstName: "علي", lastName: "العبيدي", payType: "monthly", salary: "1000000", allowances: "150000" });
    await createEmployee({ firstName: "زينب", lastName: "الموسوي", payType: "monthly", salary: "800000", allowances: "50000" });

    const run = await generatePayroll("2026-06", ACTOR);
    expect(run).toBeTruthy();
    expect(run!.status).toBe("draft");
    expect(run!.period).toBe("2026-06");
    expect(run!.employeeCount).toBe(2);
    expect(run!.items.length).toBe(2);

    const ali = run!.items.find((i) => i.employeeName.includes("علي"))!;
    expect(ali.payType).toBe("monthly");
    // gross = 1,000,000 + 150,000 = 1,150,000 ؛ overtime/deductions = 0 ؛ net = gross
    expect(Number(ali.gross)).toBe(1150000);
    expect(Number(ali.allowances)).toBe(150000);
    expect(Number(ali.overtime)).toBe(0);
    expect(Number(ali.deductions)).toBe(0);
    expect(Number(ali.net)).toBe(1150000);

    // مجاميع المسيّر = مجموع البنود (1,150,000 + 850,000 = 2,000,000)
    expect(Number(run!.totalGross)).toBe(2000000);
    expect(Number(run!.totalNet)).toBe(2000000);
    expect(Number(run!.totalOvertime)).toBe(0);
    expect(Number(run!.totalDeductions)).toBe(0);
  });

  it("يحسب أجر موظف الساعة من مجموع حضور ذلك الشهر", async () => {
    const emp = await createEmployee({ firstName: "حيدر", lastName: "الزيدي", payType: "hourly", dayRates: { "الأحد": 5000 } });
    // سجلّان للحضور في 2026-06 + سجل خارج الشهر يجب ألّا يُحتسب.
    await db().insert(s.attendance).values([
      { employeeId: emp!.id, attendanceDate: "2026-06-01", status: "PRESENT", hours: "8.00", hourlyRate: "5000.00", amount: "40000.00", source: "fingerprint" },
      { employeeId: emp!.id, attendanceDate: "2026-06-02", status: "PRESENT", hours: "6.00", hourlyRate: "5000.00", amount: "30000.00", source: "fingerprint" },
      { employeeId: emp!.id, attendanceDate: "2026-05-31", status: "PRESENT", hours: "8.00", hourlyRate: "5000.00", amount: "40000.00", source: "fingerprint" },
    ]);

    const run = await generatePayroll("2026-06", ACTOR);
    const it = run!.items[0];
    expect(it.payType).toBe("hourly");
    expect(Number(it.gross)).toBe(70000); // 40,000 + 30,000 (مايو مستبعَد)
    expect(Number(it.hours)).toBe(14);
    expect(Number(it.net)).toBe(70000);
  });

  it("توليد مرّتين لنفس الشهر يُرفض", async () => {
    await createEmployee({ firstName: "نور", lastName: "الساعدي", payType: "monthly", salary: "900000", allowances: "0" });
    await generatePayroll("2026-06", ACTOR);
    await expect(generatePayroll("2026-06", ACTOR)).rejects.toThrow();
  });
});

describe("payrollService — pay posts ledger entries", () => {
  it("الدفع يقيّد accountingEntries بمفتاح dedupe PAYROLL:<runId>:<employeeId>", async () => {
    const emp = await createEmployee({ firstName: "كرار", lastName: "البديري", payType: "monthly", salary: "1200000", allowances: "100000" });
    const run = await generatePayroll("2026-07", ACTOR);
    await approveRun(run!.id);
    const paid = await payRun(run!.id, ACTOR);
    expect(paid!.status).toBe("paid");
    expect(paid!.paidAt).toBeTruthy();

    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_OUT"), eq(s.accountingEntries.dedupeKey, `PAYROLL:${run!.id}:${emp!.id}`)));
    expect(entries.length).toBe(1);
    const entry = entries[0];
    expect(Number(entry.amount)).toBe(1300000); // 1,200,000 + 100,000
    expect(Number(entry.revenue)).toBe(0);
    expect(Number(entry.branchId)).toBe(1);
    expect(entry.entryType).toBe("PAYMENT_OUT");
  });

  it("لا يُدفع مسيّر غير معتمد", async () => {
    await createEmployee({ firstName: "سارة", lastName: "الحسني", payType: "monthly", salary: "700000", allowances: "0" });
    const run = await generatePayroll("2026-08", ACTOR);
    await expect(payRun(run!.id, ACTOR)).rejects.toThrow();
  });

  it("يُرحّل قيد كل موظف بفرعه هو لا بفرع المُولِّد (إسناد فرعي دقيق)", async () => {
    // المُولِّد بفرع 1، لكن لكل موظف فرعه: ع→1، ب→2 ⇒ يجب أن يُنسَب قيد كلٍّ لفرعه.
    const e1 = await createEmployee({ firstName: "عقيل", lastName: "ت", payType: "monthly", salary: "500000", allowances: "0", branchId: 1 });
    const e2 = await createEmployee({ firstName: "براء", lastName: "ث", payType: "monthly", salary: "600000", allowances: "0", branchId: 2 });
    const run = await generatePayroll("2026-12", ACTOR); // ACTOR.branchId = 1
    await approveRun(run!.id);
    await payRun(run!.id, ACTOR);

    const [ent1] = await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_OUT"), eq(s.accountingEntries.dedupeKey, `PAYROLL:${run!.id}:${e1!.id}`)));
    const [ent2] = await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_OUT"), eq(s.accountingEntries.dedupeKey, `PAYROLL:${run!.id}:${e2!.id}`)));
    expect(Number(ent1.branchId)).toBe(1);
    expect(Number(ent2.branchId)).toBe(2); // فرع الموظف لا فرع المُولِّد
  });

  it("عكس مسيّر مدفوع ثمّ إعادة دفعه يقيّد قيداً جديداً (:r1) بلا اصطدام بالمفتاح الفريد", async () => {
    await createEmployee({ firstName: "مصطفى", lastName: "الكناني", payType: "monthly", salary: "1000000", allowances: "0" });
    const run = await generatePayroll("2026-10", ACTOR);
    await approveRun(run!.id);
    await payRun(run!.id, ACTOR); // الدفع الأول: PAYROLL:<run>:<emp>

    const reversed = await cancelRun(run!.id, ACTOR); // عكس ⇒ approved + قيد PAYROLL-REV
    expect(reversed.status).toBe("approved");

    const repaid = await payRun(run!.id, ACTOR); // إعادة الدفع: PAYROLL:<run>:<emp>:r1
    expect(repaid!.status).toBe("paid");

    // الدفتر يحوي ٣ قيود PAYMENT_OUT: +net (أصلي) + (−net) (عكس) + +net (إعادة) ⇒ المحصّلة الصافية = net.
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(entries.length).toBe(3);
    const sum = entries.reduce((acc, e) => acc + Number(e.amount), 0);
    expect(sum).toBe(1000000);
  });
});
