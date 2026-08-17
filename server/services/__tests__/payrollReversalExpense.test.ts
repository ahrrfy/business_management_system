import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { buildPayrollLegalPolicyEvidence } from "../payroll/legalSnapshot";
import { PAYROLL_LEGAL_DEFAULTS } from "../payrollLegalService";
import { approveRun, cancelRun } from "../payrollService";
import { plSnapshot } from "../reportsFinancialService";

/**
 * **المسار ب-٢ — معيار القبول الذي طلبته ورقة الإصلاحات نفسها:**
 * «إلغاء مسيّر ⇒ **مصروف الرواتب في قائمة الدخل يعود صفراً** (لا مجرّد تصافر القيود)».
 *
 * الورقة وصفت العلّة بأنّ العكس يكتب `PAYMENT_OUT` بمبلغٍ سالب، وأنّ مُسنِد التقرير يفتاح على
 * `dedupeKey LIKE 'PAYROLL%'` معتمداً على ذلك السالب ليتصافر. **الوصف تجاوزته الشيفرة** (#604):
 *  - العكس صار `ADJUST` بملف `ADJUST_PAYROLL_ACCRUAL_REVERSAL` يقلب أدوار المدين/الدائن،
 *    و`signedPostingLines` يترجم الإشارة إلى قيدٍ سليم (قيمة مطلقة بأدوارٍ معكوسة).
 *  - والتقرير يقرأ `payrollAccountingEvents` لا مفتاحاً نصّياً — يحرس ذلك اختبارٌ قائم في
 *    `reportsFinancialService.test.ts` يمنع عودة `PAYMENT_OUT` أو `dedupeKey LIKE 'PAYROLL%'`.
 *
 * فلا سلوكَ يُغيَّر هنا — **يُثبَّت**: تحوّل هذه الاختبارات معيارَ القبول من ادّعاءٍ في وثيقة إلى
 * حارسٍ دائم، وتوثّق **تأريخ العكس** الذي كان تعليقٌ قديم في تقرير الدخل يصفه بالعكس تماماً.
 */

const MAKER = { userId: 1, branchId: 1, role: "admin" };
const CHECKER = { userId: 2, branchId: 1, role: "manager" };

/** مسيّر فترة ٢٠٢٦-٠٧ ⇒ قيد الاستحقاق يُؤرَّخ بنهايتها (`accrualDate`). */
const PERIOD = "2026-07";
const PERIOD_FROM = "2026-07-01";
const PERIOD_TO = "2026-07-31";

const TABLES = [
  "payrollObligationAllocations", "payrollAccountingEvents", "payrollObligations",
  "payrollRemittanceRequests", "journalLines", "journalEntries", "accountingEntries",
  "receipts", "financialPeriods", "payrollItems", "payrollRuns", "employees",
  "payrollLegalSettings", "branches", "users",
];

function db() {
  const v = getDb();
  if (!v) throw new Error("DATABASE_URL not set for tests");
  return v;
}

async function seedDraft(period = PERIOD) {
  const runner = db();
  const legalPolicy = buildPayrollLegalPolicyEvidence(PAYROLL_LEGAL_DEFAULTS);
  const inserted = await runner.insert(s.payrollRuns).values({
    period, branchId: 1, status: "draft", employeeCount: 1,
    totalGross: "1000.00", totalOvertime: "100.00", totalCommission: "50.00",
    totalDeductions: "150.00", totalNet: "1000.00",
    totalSocialSecurityEmployee: "80.00", totalIncomeTax: "50.00",
    totalSocialSecurityEmployer: "120.00", totalEndOfServiceAccrual: "40.00",
    legalPolicySnapshot: legalPolicy.snapshot, legalPolicyHash: legalPolicy.hash,
    createdBy: MAKER.userId,
  });
  const runId = extractInsertId(inserted);
  await runner.insert(s.payrollItems).values({
    runId, employeeId: 10, branchIdSnapshot: 1, payType: "monthly",
    gross: "1000.00", overtime: "100.00", commission: "50.00", deductions: "150.00",
    wageReduction: "20.00", advanceDeduction: "0.00",
    socialSecurityEmployee: "80.00", incomeTax: "50.00",
    socialSecurityEmployer: "120.00", endOfServiceAccrual: "40.00", net: "1000.00",
  });
  return runId;
}

/** سطر «تكلفة الرواتب المستحقّة» من قائمة الدخل (الأساس القديم — المسار العامل إنتاجياً). */
async function payrollExpense(from: string, to: string): Promise<string> {
  const pl = await plSnapshot(from, to, 1);
  return pl.expenseLines.find((l) => l.key === "PAYROLL")?.amount ?? "0.00";
}

async function payrollEntries() {
  return db()
    .select({
      kind: s.payrollAccountingEvents.eventKind,
      entryType: s.accountingEntries.entryType,
      amount: s.accountingEntries.amount,
      entryDate: s.accountingEntries.entryDate,
    })
    .from(s.payrollAccountingEvents)
    .innerJoin(
      s.accountingEntries,
      eq(s.accountingEntries.id, s.payrollAccountingEvents.accountingEntryId),
    );
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "pr-maker", role: "admin", branchId: 1, isOwner: true },
    { id: 2, openId: "pr-checker", role: "manager", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.employees).values({
    id: 10, branchId: 1, firstName: "موظف", lastName: "اختبار",
    payType: "monthly", salary: "1000.00",
  });
});

describe("ب-٢ — عكس مسيّر الرواتب يُصفّر مصروف قائمة الدخل", () => {
  it("اعتمادٌ ثمّ إلغاء ⇒ مصروف الرواتب في فترة المسيّر صفر (معيار الورقة)", async () => {
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);

    const accrued = Number(await payrollExpense(PERIOD_FROM, PERIOD_TO));
    // الاستحقاق موجبٌ فعلاً قبل العكس — وإلّا فالاختبار يقيس فراغاً ويمرّ كذباً.
    expect(accrued).toBeGreaterThan(0);

    await cancelRun(runId, CHECKER, "إعادة تدقيق");

    // **صفر** لا مجرّد «القيود تتصافر»: السطر يختفي من قائمة الدخل.
    expect(await payrollExpense(PERIOD_FROM, PERIOD_TO)).toBe("0.00");
  });

  it("العكس قيدُ ADJUST سالبٌ بالمقدار نفسه — لا PAYMENT_OUT سالب (النمط الذي حذّرت منه الورقة)", async () => {
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);
    await cancelRun(runId, CHECKER, "إعادة تدقيق");

    const rows = await payrollEntries();
    const accrual = rows.find((r) => r.kind === "ACCRUAL");
    const reversal = rows.find((r) => r.kind === "ACCRUAL_REVERSAL");
    expect(accrual).toBeTruthy();
    expect(reversal).toBeTruthy();
    expect(accrual!.entryType).toBe("ADJUST");
    expect(reversal!.entryType).toBe("ADJUST");
    expect(Number(reversal!.amount)).toBe(-Number(accrual!.amount));

    // لا قيدَ دفعٍ سالبٍ في مسار الرواتب إطلاقاً.
    expect(rows.filter((r) => r.entryType === "PAYMENT_OUT" && Number(r.amount) < 0)).toHaveLength(0);
  });

  it("العكس يُؤرَّخ بفترة الخدمة لا بيوم الضغط (قرارٌ متعمَّد في obligations.ts)", async () => {
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);
    await cancelRun(runId, CHECKER, "إعادة تدقيق");

    const rows = await payrollEntries();
    const accrual = rows.find((r) => r.kind === "ACCRUAL")!;
    const reversal = rows.find((r) => r.kind === "ACCRUAL_REVERSAL")!;
    const day = (d: unknown) => new Date(d as string).toISOString().slice(0, 10);
    // «العكس يصحّح فترة الخدمة نفسها لا يوم ضغط الزرّ» ⇒ الفترة التي حملت التكلفة هي التي
    // تتخلّص منها، فلا تبقى مُحمَّلةً بمصروفٍ سُحب. وأمانُ هذه السياسة من قفل الفترة (أدناه).
    expect(day(reversal.entryDate)).toBe(day(accrual.entryDate));
    expect(day(accrual.entryDate)).toBe(PERIOD_TO);
  });

  it("قفل فترة الاستحقاق يمنع العكس (لا كتابةَ رجعيةً في شهرٍ مُقفَل)", async () => {
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);

    // إقفال يوليو: الحارس الذي يجعل «تصحيح الفترة نفسها» سياسةً آمنة لا باباً خلفياً.
    await db().insert(s.financialPeriods).values({
      cutoffDate: PERIOD_TO, status: "LOCKED", lockedBy: 1,
    });

    await expect(cancelRun(runId, CHECKER, "إعادة تدقيق")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // ولا عكسَ نصفيّ: المصروف كما هو وصفر قيود عكس.
    expect(Number(await payrollExpense(PERIOD_FROM, PERIOD_TO))).toBeGreaterThan(0);
    expect((await payrollEntries()).filter((r) => r.kind === "ACCRUAL_REVERSAL")).toHaveLength(0);
  });
});
