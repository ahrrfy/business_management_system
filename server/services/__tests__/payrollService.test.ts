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
// SOD-01/02 (فصل المهام): المُعتمِد/الدافع يجب أن يختلف عن المُولِّد ⇒ مستخدم ٢ يُعتمِد ويَدفع.
const APPROVER = { userId: 2, branchId: 1 };

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
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: 1 },
    { id: 2, openId: "test-approver", name: "مدقّق", role: "manager", branchId: 1 },
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

  it("خصم إجازة بلا راتب للموظف الشهريّ = الراتب÷٣٠ × الأيام، مع ملاحظة توضيحيّة (تدقيق ١٧/٧)", async () => {
    const emp = await createEmployee({ firstName: "سعد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "0" });
    // إجازة بلا راتب معتمدة ٣ أيام داخل الشهر (٢٠٢٦-٠٦).
    await db().insert(s.leaveRequests).values({
      employeeId: emp!.id, leaveType: "بدون راتب", paid: false,
      fromDate: "2026-06-10", toDate: "2026-06-12", days: 3, status: "approved",
    });
    const run = await generatePayroll("2026-06", ACTOR);
    const item = run!.items[0];
    // الراتب÷٣٠ = 30,000/يوم × ٣ = 90,000 خصم ⇒ net = 900,000 − 90,000 = 810,000
    expect(Number(item.deductions)).toBe(90000);
    expect(Number(item.net)).toBe(810000);
    expect(item.note ?? "").toContain("إجازة بلا راتب");
    expect(item.note ?? "").toContain("3");
  });

  it("إجازة بلا راتب عابرة للشهور تُخصَم أيامها داخل الشهر فقط (تداخل مقصوص)", async () => {
    const emp = await createEmployee({ firstName: "نور", lastName: "الحسن", payType: "monthly", salary: "900000", allowances: "0" });
    // ٢٨ مايو ← ٣ يونيو: يخصّ يونيو منها ٣ أيام فقط (١،٢،٣) رغم أنّ days=7.
    await db().insert(s.leaveRequests).values({
      employeeId: emp!.id, leaveType: "بدون راتب", paid: false,
      fromDate: "2026-05-28", toDate: "2026-06-03", days: 7, status: "approved",
    });
    const run = await generatePayroll("2026-06", ACTOR);
    const item = run!.items[0];
    expect(Number(item.deductions)).toBe(90000); // ٣ أيام × 30,000 لا ٧
    expect(Number(item.net)).toBe(810000);
  });

  it("الإجازة المدفوعة أو غير المعتمدة لا تُخصَم", async () => {
    const emp = await createEmployee({ firstName: "هدى", lastName: "الكناني", payType: "monthly", salary: "900000", allowances: "0" });
    await db().insert(s.leaveRequests).values([
      { employeeId: emp!.id, leaveType: "سنوية", paid: true, fromDate: "2026-06-05", toDate: "2026-06-07", days: 3, status: "approved" },
      { employeeId: emp!.id, leaveType: "بدون راتب", paid: false, fromDate: "2026-06-15", toDate: "2026-06-17", days: 3, status: "pending" },
    ]);
    const run = await generatePayroll("2026-06", ACTOR);
    const item = run!.items[0];
    expect(Number(item.deductions)).toBe(0);
    expect(Number(item.net)).toBe(900000);
    expect(item.note ?? "").not.toContain("إجازة");
  });

  it("الموظف الساعيّ لا يُطبَّق عليه خصم الإجازة (يُخصَم بغياب الحضور تلقائياً)", async () => {
    const emp = await createEmployee({ firstName: "كرار", lastName: "الساعدي", payType: "hourly", dayRates: { "الاثنين": 5000 } });
    await db().insert(s.attendance).values({
      employeeId: emp!.id, attendanceDate: "2026-06-01", status: "PRESENT", hours: "8.00", hourlyRate: "5000.00", amount: "40000.00", source: "manual",
    });
    await db().insert(s.leaveRequests).values({
      employeeId: emp!.id, leaveType: "بدون راتب", paid: false, fromDate: "2026-06-10", toDate: "2026-06-12", days: 3, status: "approved",
    });
    const run = await generatePayroll("2026-06", ACTOR);
    const item = run!.items[0];
    expect(Number(item.deductions)).toBe(0); // لا خصم إجازة على الساعيّ
    expect(Number(item.net)).toBe(40000);
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

  it("HR-PAY-01: توليد متزامن لنفس الشهر (فرعان) ⇒ مسيّر واحد فقط (لا دفع مزدوج)", async () => {
    await createEmployee({ firstName: "كاظم", lastName: "الجبوري", payType: "monthly", salary: "500000", allowances: "0" });
    // نموذج «مسيّر واحد شهريّاً لكل الشركة»: فرعان يولّدان نفس الشهر بالتزامن، وUNIQUE(period)
    // يَضمن نجاح واحدٍ فقط ⇒ يَستحيل وجود مسيّرَين يدفعان لكل موظّف (سدّ سباق الدفع المزدوج).
    const results = await Promise.allSettled([
      generatePayroll("2026-03", { userId: 1, branchId: 1 }),
      generatePayroll("2026-03", { userId: 1, branchId: 2 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(1); // الآخر يَفشل (ER_DUP_ENTRY/CONFLICT)
    const runs = await db().select().from(s.payrollRuns).where(eq(s.payrollRuns.period, "2026-03"));
    expect(runs.length).toBe(1);
  });
});

describe("payrollService — pay posts ledger entries", () => {
  it("الدفع يقيّد accountingEntries بمفتاح dedupe PAYROLL:<runId>:<employeeId>", async () => {
    const emp = await createEmployee({ firstName: "كرار", lastName: "البديري", payType: "monthly", salary: "1200000", allowances: "100000" });
    const run = await generatePayroll("2026-07", ACTOR);
    await approveRun(run!.id, APPROVER);
    const paid = await payRun(run!.id, APPROVER);
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
    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER);

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
    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER); // الدفع الأول: PAYROLL:<run>:<emp>

    const reversed = await cancelRun(run!.id, ACTOR); // عكس ⇒ approved + قيد PAYROLL-REV
    expect(reversed.status).toBe("approved");

    const repaid = await payRun(run!.id, APPROVER); // إعادة الدفع: PAYROLL:<run>:<emp>:r1
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

describe("payrollService — فصل المهام (SOD-01/02)", () => {
  it("لا يجوز اعتماد مسيّر أنشأته بنفسك (مُعتمِد ≠ مُولِّد)", async () => {
    await createEmployee({ firstName: "حسن", lastName: "العامري", payType: "monthly", salary: "500000", allowances: "0" });
    const run = await generatePayroll("2026-09", ACTOR); // أنشأه ACTOR (id 1)
    await expect(approveRun(run!.id, ACTOR)).rejects.toThrow(); // اعتماد ذاتي مرفوض
    const approved = await approveRun(run!.id, APPROVER); // مُعتمِد آخر ينجح
    expect(approved!.status).toBe("approved");
    expect(Number(approved!.approvedBy)).toBe(2);
  });

  it("لا يجوز صرف مسيّر أنشأته بنفسك (دافع ≠ مُولِّد)", async () => {
    await createEmployee({ firstName: "عمّار", lastName: "الطائي", payType: "monthly", salary: "500000", allowances: "0" });
    const run = await generatePayroll("2026-11", ACTOR);
    await approveRun(run!.id, APPROVER);
    await expect(payRun(run!.id, ACTOR)).rejects.toThrow(); // صرف ذاتي مرفوض
    const paid = await payRun(run!.id, APPROVER);
    expect(paid!.status).toBe("paid");
    expect(Number(paid!.paidBy)).toBe(2);
  });
});
