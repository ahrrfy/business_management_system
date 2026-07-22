/**
 * اختبارات المكوّنات القانونية العراقية للرواتب — البند ④ (وحدة مالية حسّاسة).
 *
 * القسم الأول (نقيّ، بلا DB): دوالّ الاحتساب — الضريبة التصاعدية + computeLegalComponents.
 * القسم الثاني (تكامل DB): الإعدادات + توليد المسيّر:
 *   (أ) كل المفاتيح OFF ⇒ **صفر انحدار** (net/deductions كما اليوم، حتى مع نِسَب مضبوطة لكن معطَّلة).
 *   (ب) الضمان مُفعَّل ⇒ خصم حصّة الموظف من net + حصّة رب العمل منفصلة (لا تُخصَم).
 *   (ج) ضريبة بشرائح + إعفاء ⇒ استقطاع صحيح رياضياً (والوعاء يطرح حصّة الموظف من الضمان).
 *   (د) استحقاق نهاية الخدمة يُحسب/يُعرَض ولا يؤثّر على net ولا يُصرَف (لا ازدواج مع تسوية الفصل).
 *   (هـ) سقف السلفة يحترم الاستقطاعات القانونية ⇒ net ≥ 0 (لا خسارة نقدية).
 */
import { and, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { approveRun, generatePayroll, payRun } from "../payrollService";
import {
  computeLegalComponents,
  computeProgressiveTax,
  getPayrollLegalSettings,
  updatePayrollLegalSettings,
  PAYROLL_LEGAL_DEFAULTS,
  type PayrollLegalSettingsView,
  type UpdatePayrollLegalInput,
} from "../payrollLegalService";

const ACTOR = { userId: 1, branchId: 1 };
const APPROVER = { userId: 2, branchId: 1 };

/* ═══════════════════════ القسم الأول: احتساب نقيّ (بلا DB) ═══════════════════════ */

const D = (n: number) => new Decimal(n);
const BRACKETS = [
  { upTo: "250000", rate: "3" },
  { upTo: "500000", rate: "5" },
  { upTo: null, rate: "15" },
];

describe("computeProgressiveTax — تصاعديّ حدّيّ", () => {
  it("وعاء يعبر كل الشرائح: 600,000 ⇒ 7,500 + 12,500 + 15,000 = 35,000", () => {
    expect(computeProgressiveTax(BRACKETS, D(600000)).toNumber()).toBe(35000);
  });
  it("ضمن الشريحة الأولى فقط: 200,000 × ٣٪ = 6,000", () => {
    expect(computeProgressiveTax(BRACKETS, D(200000)).toNumber()).toBe(6000);
  });
  it("عند حدود الشرائح تماماً", () => {
    expect(computeProgressiveTax(BRACKETS, D(250000)).toNumber()).toBe(7500); // 250k×3%
    expect(computeProgressiveTax(BRACKETS, D(500000)).toNumber()).toBe(20000); // 7,500 + 12,500
  });
  it("صفر/سالب أو بلا شرائح ⇒ صفر", () => {
    expect(computeProgressiveTax(BRACKETS, D(0)).toNumber()).toBe(0);
    expect(computeProgressiveTax(BRACKETS, D(-100)).toNumber()).toBe(0);
    expect(computeProgressiveTax([], D(100000)).toNumber()).toBe(0);
  });
  it("لا تتأثّر بترتيب الإدخال (تُرتَّب داخلياً)", () => {
    const shuffled = [BRACKETS[2], BRACKETS[0], BRACKETS[1]];
    expect(computeProgressiveTax(shuffled, D(600000)).toNumber()).toBe(35000);
  });
});

describe("computeLegalComponents — الحتمية والتعطيل", () => {
  const view = (over: Partial<PayrollLegalSettingsView>): PayrollLegalSettingsView => ({
    ...PAYROLL_LEGAL_DEFAULTS,
    ...over,
  });

  it("كل المكوّنات معطَّلة ⇒ أصفار حتى مع نِسَب/شرائح مضبوطة (صفر أثر)", () => {
    const sett = view({
      socialSecurityEmployeeRate: "5",
      socialSecurityEmployerRate: "12",
      socialSecurityBase: "gross",
      incomeTaxBrackets: BRACKETS,
      incomeTaxExemption: "100000",
      endOfServiceDaysPerYear: "21",
    });
    const r = computeLegalComponents(sett, { basic: D(1000000), gross: D(1150000), dailyRate: D(33333.33) });
    expect(r.socialSecurityEmployee.toNumber()).toBe(0);
    expect(r.socialSecurityEmployer.toNumber()).toBe(0);
    expect(r.incomeTax.toNumber()).toBe(0);
    expect(r.endOfServiceAccrual.toNumber()).toBe(0);
  });

  it("الضمان على الوعاء الإجماليّ: ٥٪/١٢٪ من 1,000,000", () => {
    const sett = view({ socialSecurityEnabled: true, socialSecurityEmployeeRate: "5", socialSecurityEmployerRate: "12", socialSecurityBase: "gross" });
    const r = computeLegalComponents(sett, { basic: D(800000), gross: D(1000000), dailyRate: D(0) });
    expect(r.socialSecurityEmployee.toNumber()).toBe(50000);
    expect(r.socialSecurityEmployer.toNumber()).toBe(120000);
  });

  it("الضمان على الوعاء الأساسيّ (يتجاهل المخصّصات): ٥٪ من 800,000", () => {
    const sett = view({ socialSecurityEnabled: true, socialSecurityEmployeeRate: "5", socialSecurityEmployerRate: "12", socialSecurityBase: "basic" });
    const r = computeLegalComponents(sett, { basic: D(800000), gross: D(1000000), dailyRate: D(0) });
    expect(r.socialSecurityEmployee.toNumber()).toBe(40000); // 800k×5%
    expect(r.socialSecurityEmployer.toNumber()).toBe(96000); // 800k×12%
  });

  it("الوعاء الضريبيّ = الإجماليّ − حصّة الموظف من الضمان − الإعفاء", () => {
    const sett = view({
      socialSecurityEnabled: true,
      socialSecurityEmployeeRate: "5",
      socialSecurityBase: "gross",
      incomeTaxEnabled: true,
      incomeTaxBrackets: [{ upTo: null, rate: "10" }],
      incomeTaxExemption: "100000",
    });
    // gross 1,000,000 ⇒ ضمان الموظف 50,000 ⇒ الوعاء = 1,000,000 − 50,000 − 100,000 = 850,000 ⇒ ضريبة 85,000
    const r = computeLegalComponents(sett, { basic: D(1000000), gross: D(1000000), dailyRate: D(0) });
    expect(r.socialSecurityEmployee.toNumber()).toBe(50000);
    expect(r.incomeTax.toNumber()).toBe(85000);
  });

  it("استحقاق نهاية الخدمة = (المعدّل اليوميّ × الأيام) ÷ ١٢", () => {
    const sett = view({ endOfServiceEnabled: true, endOfServiceDaysPerYear: "21" });
    const r = computeLegalComponents(sett, { basic: D(900000), gross: D(900000), dailyRate: D(30000) });
    expect(r.endOfServiceAccrual.toNumber()).toBe(52500); // 30,000 × 21 ÷ 12
  });
});

/* ═══════════════════════ القسم الثاني: تكامل DB ═══════════════════════ */

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "advanceSettlements",
  "employeeAdvances",
  "accountingEntries",
  "receipts",
  "payrollItems",
  "payrollRuns",
  "payrollLegalSettings",
  "attendance",
  "leaveRequests",
  "employees",
  "auditLogs",
  "branches",
  "users",
];

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

const BASE_INPUT: UpdatePayrollLegalInput = {
  socialSecurityEnabled: false,
  socialSecurityEmployeeRate: "0",
  socialSecurityEmployerRate: "0",
  socialSecurityBase: "basic",
  incomeTaxEnabled: false,
  incomeTaxBrackets: [],
  incomeTaxExemption: "0",
  endOfServiceEnabled: false,
  endOfServiceDaysPerYear: "0",
};
async function setLegal(over: Partial<UpdatePayrollLegalInput>) {
  await updatePayrollLegalSettings({ ...BASE_INPUT, ...over }, ACTOR);
}

describe("payrollLegalService — الإعدادات (DB)", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("get-or-default: بلا صفّ ⇒ كل شيء معطَّل وصفريّ", async () => {
    const v = await getPayrollLegalSettings();
    expect(v.socialSecurityEnabled).toBe(false);
    expect(v.incomeTaxEnabled).toBe(false);
    expect(v.endOfServiceEnabled).toBe(false);
    expect(v.incomeTaxBrackets).toEqual([]);
  });

  it("التحديث يُثبِّت الإعدادات ويُرتّب الشرائح تصاعدياً", async () => {
    await setLegal({
      socialSecurityEnabled: true,
      socialSecurityEmployeeRate: "5",
      socialSecurityBase: "gross",
      incomeTaxEnabled: true,
      incomeTaxBrackets: [{ upTo: null, rate: "15" }, { upTo: "250000", rate: "3" }],
      incomeTaxExemption: "100000",
    });
    const v = await getPayrollLegalSettings();
    expect(v.socialSecurityEnabled).toBe(true);
    expect(v.socialSecurityEmployeeRate).toBe("5.00");
    expect(v.incomeTaxBrackets[0].upTo).toBe("250000"); // الرقميّ أولاً
    expect(v.incomeTaxBrackets[v.incomeTaxBrackets.length - 1].upTo).toBeNull(); // المفتوح آخراً
  });

  it("تفعيل الضريبة بلا شرائح مرفوض", async () => {
    await expect(setLegal({ incomeTaxEnabled: true, incomeTaxBrackets: [] })).rejects.toThrow();
  });

  it("حدود شرائح مكرّرة (متساوية) مرفوضة", async () => {
    await expect(
      setLegal({ incomeTaxEnabled: true, incomeTaxBrackets: [{ upTo: "250000", rate: "3" }, { upTo: "250000", rate: "5" }] }),
    ).rejects.toThrow();
  });

  it("حدود شرائح غير مرتّبة تُقبَل وتُرتَّب تصاعدياً (لا رفض — تسهيلٌ للإدخال)", async () => {
    await setLegal({ incomeTaxEnabled: true, incomeTaxBrackets: [{ upTo: "500000", rate: "3" }, { upTo: "250000", rate: "5" }] });
    const v = await getPayrollLegalSettings();
    expect(v.incomeTaxBrackets.map((b) => b.upTo)).toEqual(["250000", "500000"]);
  });

  it("نسبة تتجاوز ١٠٠٪ مرفوضة", async () => {
    await expect(setLegal({ socialSecurityEnabled: true, socialSecurityEmployeeRate: "150" })).rejects.toThrow();
  });
});

describe("generatePayroll — المكوّنات القانونية (DB)", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("(أ) كل المفاتيح OFF ⇒ صفر انحدار — net/deductions كما اليوم والأعمدة صفر (حتى مع نِسَب مضبوطة معطَّلة)", async () => {
    // صفّ إعدادات مضبوط بالكامل لكن **كل المفاتيح OFF** ⇒ يجب ألّا يتغيّر شيء.
    await setLegal({
      socialSecurityEmployeeRate: "5",
      socialSecurityEmployerRate: "12",
      socialSecurityBase: "gross",
      incomeTaxBrackets: [{ upTo: null, rate: "15" }],
      incomeTaxExemption: "100000",
      endOfServiceDaysPerYear: "21",
    });
    await createEmployee({ firstName: "علي", lastName: "العبيدي", payType: "monthly", salary: "1000000", allowances: "150000" });

    const run = await generatePayroll("2026-06", ACTOR);
    const it = run!.items[0];
    expect(Number(it.gross)).toBe(1150000);
    expect(Number(it.deductions)).toBe(0);
    expect(Number(it.net)).toBe(1150000);
    expect(Number(it.socialSecurityEmployee)).toBe(0);
    expect(Number(it.incomeTax)).toBe(0);
    expect(Number(it.socialSecurityEmployer)).toBe(0);
    expect(Number(it.endOfServiceAccrual)).toBe(0);
    expect(Number(run!.totalDeductions)).toBe(0);
    expect(Number(run!.totalNet)).toBe(1150000);
    expect(Number(run!.totalSocialSecurityEmployee)).toBe(0);
    expect(Number(run!.totalIncomeTax)).toBe(0);
    expect(Number(run!.totalSocialSecurityEmployer)).toBe(0);
    expect(Number(run!.totalEndOfServiceAccrual)).toBe(0);
  });

  it("(ب) الضمان مُفعَّل (٥٪/١٢٪ على الإجماليّ) ⇒ حصّة الموظف تُخصَم من net، وحصّة رب العمل منفصلة", async () => {
    await setLegal({ socialSecurityEnabled: true, socialSecurityEmployeeRate: "5", socialSecurityEmployerRate: "12", socialSecurityBase: "gross" });
    await createEmployee({ firstName: "زينب", lastName: "الموسوي", payType: "monthly", salary: "1000000", allowances: "0" });

    const run = await generatePayroll("2026-06", ACTOR);
    const it = run!.items[0];
    expect(Number(it.socialSecurityEmployee)).toBe(50000);
    expect(Number(it.socialSecurityEmployer)).toBe(120000);
    expect(Number(it.deductions)).toBe(50000); // حصّة الموظف فقط ضمن الاستقطاع
    expect(Number(it.net)).toBe(950000); // 1,000,000 − 50,000
    expect(Number(run!.totalDeductions)).toBe(50000);
    expect(Number(run!.totalSocialSecurityEmployee)).toBe(50000);
    expect(Number(run!.totalSocialSecurityEmployer)).toBe(120000); // خارج net
    expect(Number(run!.totalNet)).toBe(950000);
  });

  it("(ج) ضريبة بشريحتين + إعفاء ⇒ استقطاع صحيح رياضياً (35,000)", async () => {
    await setLegal({
      incomeTaxEnabled: true,
      incomeTaxExemption: "100000",
      incomeTaxBrackets: [{ upTo: "250000", rate: "3" }, { upTo: "500000", rate: "5" }, { upTo: null, rate: "15" }],
    });
    await createEmployee({ firstName: "سعد", lastName: "الجبوري", payType: "monthly", salary: "700000", allowances: "0" });

    const run = await generatePayroll("2026-06", ACTOR);
    const it = run!.items[0];
    // الوعاء = 700,000 − 0 − 100,000 = 600,000 ⇒ 7,500 + 12,500 + 15,000 = 35,000
    expect(Number(it.incomeTax)).toBe(35000);
    expect(Number(it.deductions)).toBe(35000);
    expect(Number(it.net)).toBe(665000);
    expect(Number(run!.totalIncomeTax)).toBe(35000);
  });

  it("(ج٢) الوعاء الضريبيّ يطرح حصّة الموظف من الضمان (ضمان + ضريبة معاً)", async () => {
    await setLegal({
      socialSecurityEnabled: true,
      socialSecurityEmployeeRate: "5",
      socialSecurityBase: "gross",
      incomeTaxEnabled: true,
      incomeTaxExemption: "0",
      incomeTaxBrackets: [{ upTo: null, rate: "10" }],
    });
    await createEmployee({ firstName: "نور", lastName: "الحسن", payType: "monthly", salary: "1000000", allowances: "0" });

    const run = await generatePayroll("2026-06", ACTOR);
    const it = run!.items[0];
    // ضمان الموظف = 50,000 ⇒ الوعاء = 1,000,000 − 50,000 = 950,000 ⇒ ضريبة 95,000
    expect(Number(it.socialSecurityEmployee)).toBe(50000);
    expect(Number(it.incomeTax)).toBe(95000);
    expect(Number(it.deductions)).toBe(145000); // 50,000 + 95,000
    expect(Number(it.net)).toBe(855000);
  });

  it("(د) استحقاق نهاية الخدمة يُحسب/يُعرَض، لا يُخصَم من net، ولا يُصرَف (لا ازدواج مع تسوية الفصل)", async () => {
    await setLegal({ endOfServiceEnabled: true, endOfServiceDaysPerYear: "21" });
    const emp = await createEmployee({ firstName: "هدى", lastName: "الكناني", payType: "monthly", salary: "900000", allowances: "0" });

    const run = await generatePayroll("2026-06", ACTOR);
    const it = run!.items[0];
    expect(Number(it.endOfServiceAccrual)).toBe(52500); // 30,000 × 21 ÷ 12
    expect(Number(it.deductions)).toBe(0); // لا يُخصَم
    expect(Number(it.net)).toBe(900000); // لا يؤثّر على الصافي
    expect(Number(run!.totalEndOfServiceAccrual)).toBe(52500);
    // التوليد لا يُنشئ أيّ قيد محاسبيّ للاستحقاق (عرضٌ فقط).
    expect((await db().select().from(s.accountingEntries)).length).toBe(0);

    // الدفع يصرف net (900,000) لا net + الاستحقاق ⇒ الاستحقاق لا يُدفع عبر الرواتب (يُصرَف عند الفصل).
    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER);
    const [entry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_OUT"), eq(s.accountingEntries.dedupeKey, `PAYROLL:${run!.id}:${emp!.id}`)));
    expect(Number(entry.amount)).toBe(900000);
  });

  it("(هـ) سقف السلفة يحترم الاستقطاعات القانونية الإلزامية ⇒ net ≥ 0 (لا خسارة نقدية)", async () => {
    await setLegal({ socialSecurityEnabled: true, socialSecurityEmployeeRate: "5", socialSecurityBase: "gross" });
    const emp = await createEmployee({ firstName: "كرار", lastName: "البديري", payType: "monthly", salary: "500000", allowances: "0", branchId: 1 });
    // سلفة نشطة برصيدٍ يفوق الأجر، بلا monthlyDeduction ⇒ يُقترَح كامل المتبقّي (600,000).
    await db().insert(s.employeeAdvances).values({
      employeeId: emp!.id, branchId: 1, amount: "600000", remaining: "600000", monthlyDeduction: null, status: "ACTIVE", createdBy: 1,
    });

    const run = await generatePayroll("2026-06", ACTOR);
    const it = run!.items[0];
    // ضمان الموظف = 25,000 ⇒ الأجر المتاح للسلفة = 500,000 − 25,000 = 475,000 ⇒ السلفة تُقصّ عنده.
    expect(Number(it.socialSecurityEmployee)).toBe(25000);
    expect(Number(it.advanceDeduction)).toBe(475000);
    expect(Number(it.deductions)).toBe(500000); // 475,000 سلفة + 25,000 ضمان
    expect(Number(it.net)).toBe(0);
    expect(Number(it.net)).toBeGreaterThanOrEqual(0);
  });

  it("(و) نهاية الخدمة للساعيّ تُحسب من أجره المكتسَب لا صفراً (Codex P2)", async () => {
    await setLegal({ endOfServiceEnabled: true, endOfServiceDaysPerYear: "21" });
    const emp = await createEmployee({ firstName: "حيدر", lastName: "الزيدي", payType: "hourly", dayRates: { "الأحد": 5000 } });
    await db().insert(s.attendance).values({
      employeeId: emp!.id, attendanceDate: "2026-06-01", status: "PRESENT", hours: "8.00", hourlyRate: "5000.00", amount: "300000.00", source: "manual",
    });
    const run = await generatePayroll("2026-06", ACTOR);
    const it = run!.items[0];
    expect(it.payType).toBe("hourly");
    expect(Number(it.gross)).toBe(300000);
    // المعدّل اليوميّ = gross ÷ ٣٠ = 10,000 ⇒ الاستحقاق = 10,000 × 21 ÷ 12 = 17,500 (لا صفر)
    expect(Number(it.endOfServiceAccrual)).toBe(17500);
    expect(Number(it.net)).toBe(300000); // لا يؤثّر على net
  });

  it("(ز) الضمان يُحسب على الأجر بعد الإجازة بلا راتب ⇒ خصمٌ أصغر وnet ≥ 0 (Codex P2)", async () => {
    await setLegal({ socialSecurityEnabled: true, socialSecurityEmployeeRate: "5", socialSecurityBase: "gross" });
    const emp = await createEmployee({ firstName: "سجاد", lastName: "الربيعي", payType: "monthly", salary: "900000", allowances: "0" });
    // إجازة بلا راتب ١٥ يوماً ⇒ خصم = 900,000÷٣٠ × ١٥ = 450,000 ⇒ الأجر المكتسَب = 450,000.
    await db().insert(s.leaveRequests).values({
      employeeId: emp!.id, leaveType: "بدون راتب", paid: false, fromDate: "2026-06-01", toDate: "2026-06-15", days: 15, status: "approved",
    });
    const run = await generatePayroll("2026-06", ACTOR);
    const it = run!.items[0];
    // الضمان على 450,000 (لا 900,000) = 22,500 ⇒ deductions = 450,000 إجازة + 22,500 ضمان = 472,500 ⇒ net = 427,500
    expect(Number(it.socialSecurityEmployee)).toBe(22500);
    expect(Number(it.deductions)).toBe(472500);
    expect(Number(it.net)).toBe(427500);
    expect(Number(it.net)).toBeGreaterThanOrEqual(0);
  });

  it("(ح) إجازة تستهلك كامل الشهر + ضمان ⇒ net = 0 لا سالب (يُعتمد مسيّر متعدّد)", async () => {
    await setLegal({ socialSecurityEnabled: true, socialSecurityEmployeeRate: "5", socialSecurityBase: "gross" });
    const emp = await createEmployee({ firstName: "عباس", lastName: "الخفاجي", payType: "monthly", salary: "900000", allowances: "0" });
    // إجازة ٣٠ يوماً ⇒ الخصم مقصوص عند gross ⇒ الأجر المكتسَب 0 ⇒ لا ضمان ⇒ net = 0 (لا سالب).
    await db().insert(s.leaveRequests).values({
      employeeId: emp!.id, leaveType: "بدون راتب", paid: false, fromDate: "2026-06-01", toDate: "2026-06-30", days: 30, status: "approved",
    });
    const run = await generatePayroll("2026-06", ACTOR);
    const it = run!.items[0];
    expect(Number(it.socialSecurityEmployee)).toBe(0); // لا ضمان على أجرٍ لم يُكتسَب
    expect(Number(it.net)).toBe(0);
    expect(Number(it.net)).toBeGreaterThanOrEqual(0); // ليس سالباً ⇒ لا يعطّل اعتماد مسيّرٍ متعدّد
  });
});
