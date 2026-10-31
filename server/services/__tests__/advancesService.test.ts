/**
 * اختبارات تكامل (DB) لسلف الموظفين — بند 12ج (server/services/advancesService.ts + دمج payrollService).
 * تغطّي:
 *  - المنح: سند صرف OUT حقيقي في receipts (خزينة) + قيد PAYMENT_OUT + سلفة ACTIVE بـremaining=amount.
 *  - قرار Maker-Checker الموثَّق: مبلغ يبلغ عتبة الاعتماد الثنائي يُرفض قبل إنشاء أي شيء.
 *  - التوليد: advanceDeduction يُملأ ضمن deductions (لا فوقها) وnet ينقص.
 *  - الدفع: يجمع سلف الراتب في شهرها ويستقطعها كاملة بلا ترحيل؛ عكس ثم إعادة دفع
 *    لا يخصم مرّتين، والدين الآخر وحده يحتفظ بعقده المستقل.
 *  - التحرير: الاستقطاع اليدوي لا يهبط دون جزء السلفة المولَّد.
 *  - الإلغاء: قبل أي خصم فقط؛ بعد خصم يُرفض. (السند الأصلي لا يُعكَس آلياً — شأن الخزينة.)
 *  - تعدّد السلف: الأقدم أولاً، واحدة تلو الأخرى.
 * (عزل الفرع: المسيّر مركزي لكل الشركة بلا عزل فرع في payrollService — لا اختبار عزل هنا عمداً.)
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { baghdadToday } from "../businessDay";
import {
  cancelAdvance,
  employeeBalance,
  grantAdvance as grantAdvanceService,
  listAdvances,
  suggestDeductionsForPeriod,
  type GrantAdvanceInput,
} from "../advances";
import { createEmployee } from "../employeeService";
import { approveRun, cancelRun, generatePayroll, getRun, payRun, returnSalaryPayment, updateItem } from "../payrollService";
import { approveVoucher } from "../voucherService";

const ACTOR = { userId: 1, branchId: 1, role: "admin" };
// SOD: المُعتمِد/الدافع يجب أن يختلف عن المُولِّد.
const APPROVER = { userId: 2, branchId: 1, role: "manager" };
const RETURN_APPROVER = { userId: 3, branchId: 1, role: "manager" };
const CURRENT_PERIOD = baghdadToday().slice(0, 7);
const [TEST_YEAR, TEST_MONTH] = CURRENT_PERIOD.split("-").map(Number);
const TEST_MONTH_END = new Date(Date.UTC(TEST_YEAR, TEST_MONTH, 0, 12));
let requestSeq = 0;
async function grantAdvance(
  input: Omit<GrantAdvanceInput, "clientRequestId"> & { clientRequestId?: string },
  actor: typeof ACTOR,
) {
  const requested = await grantAdvanceService(
    { ...input, clientRequestId: input.clientRequestId ?? `advance-test-${++requestSeq}` },
    actor,
  );
  if (requested.status !== "PENDING_APPROVAL") return requested;
  await approveVoucher(Number(requested.receiptId), APPROVER);
  const [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.receiptId, Number(requested.receiptId)));
  return { ...row!, employeeName: requested.employeeName, voucherNumber: requested.voucherNumber };
}

const TABLES = [
  "accountingEntries",
  "receipts",
  "shifts",
  "idempotencyKeys",
  "advanceSettlements",
  "employeeAdvances",
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
    { id: 1, openId: "t-admin", name: "مدير", role: "admin", branchId: 1 },
    { id: 2, openId: "t-approver", name: "مدقّق", role: "manager", branchId: 1, isOwner: true },
    { id: 3, openId: "t-return-approver", name: "مالك مستقل للإعادة", role: "manager", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.shifts).values({ id: 901, branchId: 1, userId: 2, openingBalance: "100000000.00", status: "OPEN", shiftType: "RETAIL", openGuard: "1:2:RETAIL" });
  await d.insert(s.receipts).values({
    branchId: 1, shiftId: null, cashBucket: "TREASURY", direction: "IN",
    amount: "100000000.00", paymentMethod: "CASH", status: "COMPLETED",
    referenceNumber: "ADV-TEST-FUND", createdBy: 2,
  });
}
beforeEach(async () => {
  vi.setSystemTime(TEST_MONTH_END);
  requestSeq = 0;
  await reset();
  await seedBase();
});
afterAll(() => vi.useRealTimers());

async function seedEmployee(salary = "1000000") {
  const e = await createEmployee({ firstName: "علي", lastName: "العبيدي", payType: "monthly", salary, allowances: "0", branchId: 1 });
  return e!;
}

/** دورة توليد→اعتماد→دفع لشهر معيّن، تعيد المسيّر المدفوع. */
async function fullPayCycle(period: string) {
  const run = await generatePayroll(period, ACTOR);
  await approveRun(run!.id, APPROVER);
  return payRun(run!.id, APPROVER);
}

async function returnPaidSalary(runId: number) {
  const [payment] = await db()
    .select({ id: s.payrollAccountingEvents.id })
    .from(s.payrollAccountingEvents)
    .where(
      and(
        eq(s.payrollAccountingEvents.runId, runId),
        eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
      ),
    );
  if (!payment) throw new Error("salary payment fixture was not materialized");
  await returnSalaryPayment(
    {
      accountingEventId: Number(payment.id),
      returnedAt: baghdadToday(),
      reason: "إعادة راتب مثبتة لاختبار دورة السلفة",
    },
    RETURN_APPROVER,
  );
}

describe("advancesService — المنح", () => {
  it("منح سلفة يُصدر سند صرف OUT حقيقياً (خزينة) بقيد PAYMENT_OUT وسلفة ACTIVE بكامل الرصيد", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "300000", monthlyDeduction: "100000", note: "زواج", attachmentUrl: "https://files.example/receipt-1.jpg" }, ACTOR);

    expect(adv.status).toBe("ACTIVE");
    expect(Number(adv.amount)).toBe(300000);
    expect(Number(adv.remaining)).toBe(300000);
    expect(adv.receiptId).toBeTruthy();
    expect(adv.voucherNumber).toMatch(/^PV-1-/);

    // سند الصرف الحقيقي: OUT من الخزينة (المانح admin بلا وردية مفتوحة ⇒ TREASURY).
    const [r] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(adv.receiptId)));
    expect(r.direction).toBe("OUT");
    expect(Number(r.amount)).toBe(300000);
    expect(r.cashBucket).toBe("DRAWER");
    expect(r.status).toBe("COMPLETED");
    expect(r.description).toContain("سلفة موظف");

    // قيد الدفتر PAYMENT_OUT مربوط بالسند.
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_OUT"), eq(s.accountingEntries.receiptId, Number(adv.receiptId))));
    expect(entries.length).toBe(1);
    expect(Number(entries[0].amount)).toBe(300000);

    const bal = await employeeBalance(emp.id);
    expect(Number(bal.balance)).toBe(300000);
    expect(bal.activeCount).toBe(1);
  });

  it("idempotency (تدقيق ١٧/٧): نفس clientRequestId لا يُصدر سنداً/سلفةً ثانية — منع صرف نقدي مزدوج", async () => {
    const emp = await seedEmployee();
    const inp = { employeeId: emp.id, branchId: 1, amount: "200000", note: "سلفة", attachmentUrl: "https://files.example/r.jpg", clientRequestId: "adv-req-1" };
    const first = await grantAdvance(inp, ACTOR);
    const replay = await grantAdvance(inp, ACTOR); // إعادة إرسال بنفس المفتاح

    expect(replay.id).toBe(first.id); // نفس السلفة تعود
    expect(Number(replay.receiptId)).toBe(Number(first.receiptId)); // نفس السند

    // لا ازدواج: سلفة واحدة + سند صرف واحد + قيد PAYMENT_OUT واحد + الرصيد لم يتضاعف.
    const advs = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.employeeId, emp.id));
    expect(advs.length).toBe(1);
    const payOut = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(payOut.length).toBe(1);
    const bal = await employeeBalance(emp.id);
    expect(Number(bal.balance)).toBe(200000);
  });

  it("طلب السلفة يبقى معلّقاً بلا سلفة/صرف حتى اعتماد المالك مهما بلغ المبلغ", async () => {
    const emp = await seedEmployee();
    const pending = await grantAdvanceService({
      employeeId: emp.id, branchId: 1, amount: "1000000", clientRequestId: "large-advance-pending",
    }, ACTOR);
    expect(pending.status).toBe("PENDING_APPROVAL");
    const [receipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(pending.receiptId)));
    expect(receipt.approvalStatus).toBe("PENDING_APPROVAL");
    expect(receipt.cashBucket).toBeNull();
    expect((await db().select().from(s.employeeAdvances)).length).toBe(0);
    expect((await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"))).length).toBe(0);

    await approveVoucher(Number(pending.receiptId), APPROVER);
    expect((await db().select().from(s.employeeAdvances)).length).toBe(1);
    expect((await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"))).length).toBe(1);
  });

  it("لا مُرفق إلزامي: سلفة بمبلغ كبير بلا مُرفق تُمنَح (٣١/٧ — أُلغيت عتبة المُرفق)", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "250000" }, ACTOR);
    expect(adv.voucherNumber).toMatch(/^PV-/);
    expect((await db().select().from(s.employeeAdvances)).length).toBe(1);
  });

  it("لا سلفة لموظف منتهي الخدمة، والخصم الشهري لا يتجاوز المبلغ", async () => {
    const emp = await seedEmployee();
    await db().update(s.employees).set({ employmentStatus: "terminated" }).where(eq(s.employees.id, emp.id));
    await expect(grantAdvance({ employeeId: emp.id, branchId: 1, amount: "100000" }, ACTOR)).rejects.toThrow();

    const emp2 = await createEmployee({ firstName: "زينب", lastName: "الموسوي", payType: "monthly", salary: "800000", allowances: "0", branchId: 1 });
    await expect(grantAdvance({ employeeId: emp2!.id, branchId: 1, amount: "100000", monthlyDeduction: "150000" }, ACTOR)).rejects.toThrow(/لا يتجاوز/);
  });
});

describe("advancesService — دمج الرواتب (توليد → دفع → تسوية)", () => {
  it("التوليد يملأ advanceDeduction ضمن deductions وnet ينقص", async () => {
    const emp = await seedEmployee("1000000");
    await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "300000", monthlyDeduction: "100000", attachmentUrl: "https://files.example/receipt.jpg" }, ACTOR);

    const run = await generatePayroll(CURRENT_PERIOD, ACTOR);
    const item = run!.items[0];
    expect(Number(item.advanceDeduction)).toBe(300000);
    expect(Number(item.deductions)).toBe(300000); // ضمنها لا فوقها
    expect(Number(item.net)).toBe(700000);
    expect(Number(run!.totalDeductions)).toBe(300000);
    expect(Number(run!.totalNet)).toBe(700000);
  });

  it("الدفع يصفّر سلفة الراتب كاملة في شهرها ويحوّلها إلى SETTLED", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance(
      {
        employeeId: emp.id,
        branchId: 1,
        amount: "200000",
        monthlyDeduction: "100000",
      },
      ACTOR,
    );

    const paid = await fullPayCycle(CURRENT_PERIOD);
    expect(Number(paid!.items[0].advanceDeduction)).toBe(200000);
    const [row] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(0);
    expect(row.status).toBe("SETTLED");
  });

  it("سقف الخصم = remaining (الشهر الأخير يخصم البقية فقط)", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "150000", monthlyDeduction: "100000" }, ACTOR);

    await db()
      .update(s.employeeAdvances)
      .set({ remaining: "50000.00" })
      .where(eq(s.employeeAdvances.id, Number(adv.id)));
    const run = await generatePayroll(CURRENT_PERIOD, ACTOR);
    expect(Number(run!.items[0].advanceDeduction)).toBe(50000);
    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER);

    const [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(0);
    expect(row.status).toBe("SETTLED");
  });

  it("بلا monthlyDeduction ⇒ يُخصم كامل المتبقّي دفعة واحدة", async () => {
    const emp = await seedEmployee();
    await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "250000", attachmentUrl: "https://files.example/receipt.jpg" }, ACTOR);
    const suggestion = await suggestDeductionsForPeriod([emp.id]);
    expect(Number(suggestion[emp.id]?.suggested)).toBe(250000);

    const paid = await fullPayCycle(CURRENT_PERIOD);
    expect(Number(paid!.items[0].advanceDeduction)).toBe(250000);
    expect(Number(paid!.items[0].net)).toBe(750000);
    const [row] = await db().select().from(s.employeeAdvances);
    expect(row.status).toBe("SETTLED");
  });

  it("قيد الدفع PAYMENT_OUT بصافي البند بعد خصم السلفة (النقد الخارج فعلاً)", async () => {
    const emp = await seedEmployee();
    await grantAdvance(
      {
        employeeId: emp.id,
        branchId: 1,
        amount: "300000",
        monthlyDeduction: "100000",
        attachmentUrl: "https://files.example/receipt.jpg",
      },
      ACTOR,
    );
    const run = await generatePayroll(CURRENT_PERIOD, ACTOR);
    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER);

    const [entry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `PAYROLL:${run!.id}:${emp.id}`));
    expect(Number(entry.amount)).toBe(700000); // 1,000,000 − 300,000
  });

  it("عكس مسيّر مدفوع ثم إعادة دفعه لا يخصم السلفة مرّتين (تسوية أول دفع فقط)", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance(
      {
        employeeId: emp.id,
        branchId: 1,
        amount: "300000",
        monthlyDeduction: "100000",
        attachmentUrl: "https://files.example/receipt.jpg",
      },
      ACTOR,
    );
    const run = await generatePayroll(CURRENT_PERIOD, ACTOR);
    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER);

    let [row] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(0);

    await returnPaidSalary(run!.id);
    await cancelRun(run!.id, APPROVER); // إعادة الفتح تعكس استحقاق السلفة append-only.
    [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(300000);

    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER, {
      paymentMethod: "CASH",
      paymentDate: baghdadToday(),
    });
    [row] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(0);
    expect(row.status).toBe("SETTLED");
    const salaryPaymentKeys = await db()
      .select({ dedupeKey: s.accountingEntries.dedupeKey })
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(
      salaryPaymentKeys
        .map((entry) => entry.dedupeKey)
        .filter((key): key is string => key?.startsWith(`PAYROLL:${run!.id}:${emp.id}`) === true)
        .sort(),
    ).toEqual([
      `PAYROLL:${run!.id}:${emp.id}`,
      `PAYROLL:${run!.id}:${emp.id}:r1`,
    ]);
  });

  it("إعادة فتح مسيّر مدفوع تستعيد رصيد السلفة وتحفظ تاريخ التسوية append-only", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance(
      {
        employeeId: emp.id,
        branchId: 1,
        amount: "300000",
        monthlyDeduction: "100000",
        attachmentUrl: "https://files.example/receipt.jpg",
      },
      ACTOR,
    );
    // دفع مسيّر الشهر ⇒ خُصمت السلفة كاملة، وسُجِّلت تسوية مربوطة بالمسيّر.
    const run1 = await generatePayroll(CURRENT_PERIOD, ACTOR);
    await approveRun(run1!.id, APPROVER);
    await payRun(run1!.id, APPROVER);
    let [row] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(0);
    expect(await db().select().from(s.advanceSettlements)).toHaveLength(1);

    await returnPaidSalary(run1!.id);
    await cancelRun(run1!.id, APPROVER); // approved → draft مع عكس الاستحقاق والتسوية.
    [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(300000); // استُعيد كاملاً
    expect(row.status).toBe("ACTIVE");
    expect(await db().select().from(s.advanceSettlements)).toHaveLength(2); // APPLY + REVERSE بلا حذف تاريخي.
    await expect(cancelRun(run1!.id, APPROVER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // إعادة اعتماد المسيّر نفسه تخصم مرةً واحدة في المراجعة الجديدة، بلا مضاعفة.
    await approveRun(run1!.id, APPROVER);
    await payRun(run1!.id, APPROVER, {
      paymentMethod: "CASH",
      paymentDate: baghdadToday(),
    });
    [row] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(0);
  });

  it("تحرير البند لا يُهبط الاستقطاع دون جزء السلفة المولَّد، ويقبل الزيادة فوقه", async () => {
    const emp = await seedEmployee();
    await grantAdvance(
      {
        employeeId: emp.id,
        branchId: 1,
        amount: "300000",
        monthlyDeduction: "100000",
        attachmentUrl: "https://files.example/receipt.jpg",
      },
      ACTOR,
    );
    const run = await generatePayroll(CURRENT_PERIOD, ACTOR);
    const item = run!.items[0];

    await expect(
      updateItem(Number(item.id), { deductions: "250000" }),
    ).rejects.toThrow(/لا يقلّ/);

    // زيادة فوق جزء السلفة (غياب/جزاء إضافي) تُقبل وnet يعاد حسابه.
    const updated = await updateItem(Number(item.id), { deductions: "320000" });
    const uItem = updated!.items[0];
    expect(Number(uItem.deductions)).toBe(320000);
    expect(Number(uItem.advanceDeduction)).toBe(300000); // ثابت كما وُلّد
    expect(Number(uItem.net)).toBe(680000);
  });

  it("يرفض اعتماد مسيّر لا يستطيع تصفير سلفة راتب شهره ولا يسويها جزئياً", async () => {
    const emp = await seedEmployee("300000");
    const [advance] = await db()
      .insert(s.employeeAdvances)
      .values({
        employeeId: emp.id,
        branchId: 1,
        amount: "600000.00",
        remaining: "600000.00",
        monthlyDeduction: "600000.00",
        sourceType: "SALARY_ADVANCE",
        payrollPeriod: CURRENT_PERIOD,
        status: "ACTIVE",
        createdBy: ACTOR.userId,
      })
      .$returningId();
    const run = await generatePayroll(CURRENT_PERIOD, ACTOR);
    await expect(approveRun(run!.id, APPROVER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    const [row] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(advance.id)));
    expect(row.remaining).toBe("600000.00");
    expect(row.status).toBe("ACTIVE");
  });

  it("لا يحمل سلفة راتب مؤرخة لشهر سابق إلى مسيّر الشهر الجاري", async () => {
    const emp = await seedEmployee();
    const [year, month] = CURRENT_PERIOD.split("-").map(Number);
    const previous = new Date(Date.UTC(year, month - 2, 1))
      .toISOString()
      .slice(0, 7);
    await db().insert(s.employeeAdvances).values({
      employeeId: emp.id,
      branchId: 1,
      amount: "100000.00",
      remaining: "100000.00",
      monthlyDeduction: "100000.00",
      sourceType: "SALARY_ADVANCE",
      payrollPeriod: previous,
      status: "ACTIVE",
      createdBy: ACTOR.userId,
    });
    const run = await generatePayroll(CURRENT_PERIOD, ACTOR);
    expect(Number(run!.items[0].advanceDeduction)).toBe(0);
    expect(Number(run!.items[0].net)).toBe(1000000);
  });
});

describe("advancesService — الإلغاء وتعدّد السلف", () => {
  it("الإلغاء يشترط عكس سند الصرف أولاً، ويُرفض بعد أي خصم", async () => {
    const emp = await seedEmployee();
    const a1 = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "100000" }, ACTOR);

    // النقد خرج فعلاً ⇒ إلغاء السلفة وحده يمحو التزام السداد ويُبقي النقد بلا دَين.
    await expect(cancelAdvance({ advanceId: Number(a1.id), reason: "خطأ إدخال" }, ACTOR)).rejects.toThrow(/سند صرفها ما زال سارياً/);
    let [still] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(a1.id)));
    expect(still.status).toBe("ACTIVE");

    // بعد عكس السند (من شاشة السندات، بفصل مهامها) يُقبل الإلغاء.
    await db().update(s.receipts).set({ status: "REVERSED" }).where(eq(s.receipts.id, Number(a1.receiptId)));
    const res = await cancelAdvance({ advanceId: Number(a1.id), reason: "خطأ إدخال" }, ACTOR);
    expect(res.status).toBe("CANCELLED");

    // سلفة خُصم منها ⇒ الإلغاء مرفوض حتى لو عُكس سندها.
    const a2 = await grantAdvance(
      {
        employeeId: emp.id,
        branchId: 1,
        amount: "200000",
        monthlyDeduction: "100000",
      },
      ACTOR,
    );
    await fullPayCycle(CURRENT_PERIOD);
    await db()
      .update(s.receipts)
      .set({ status: "REVERSED" })
      .where(eq(s.receipts.id, Number(a2.receiptId)));
    await expect(
      cancelAdvance({ advanceId: Number(a2.id), reason: "متأخر" }, ACTOR),
    ).rejects.toThrow(/نشطة|خُصم/);
  });

  it("السلفة الملغاة قبل الاعتماد تُزامن إلى خصم صفر ولا تنتقل إلى الراتب", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance(
      { employeeId: emp.id, branchId: 1, amount: "100000" },
      ACTOR,
    );
    const run = await generatePayroll(CURRENT_PERIOD, ACTOR); // advanceDeduction=100000
    // الإلغاء يشترط عكس السند أولاً (النقد يعود ثم يسقط الالتزام).
    await db().update(s.receipts).set({ status: "REVERSED" }).where(eq(s.receipts.id, Number(adv.receiptId)));
    await cancelAdvance({ advanceId: Number(adv.id) }, ACTOR);
    const approved = await approveRun(Number(run!.id), APPROVER);
    expect(approved.status).toBe("approved");
    expect(Number(approved.items?.[0]?.advanceDeduction)).toBe(0);
  });

  it("تعدّد السلف: يجمع كل سلف الشهر ويصفّرها معاً بلا إغفال", async () => {
    const emp = await seedEmployee();
    const a1 = await grantAdvance(
      { employeeId: emp.id, branchId: 1, amount: "100000" },
      ACTOR,
    );
    const a2 = await grantAdvance(
      {
        employeeId: emp.id,
        branchId: 1,
        amount: "200000",
        monthlyDeduction: "50000",
      },
      ACTOR,
    );

    const paidRun = await fullPayCycle(CURRENT_PERIOD);
    expect(Number(paidRun!.items[0].advanceDeduction)).toBe(300000);
    const [r1] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(a1.id)));
    const [r2] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(a2.id)));
    expect(r1.status).toBe("SETTLED");
    expect(r2.status).toBe("SETTLED");
    expect(Number(r2.remaining)).toBe(0);
    expect(
      await listAdvances({ employeeId: emp.id, status: "ACTIVE" }),
    ).toHaveLength(0);
  });

  it("تعدّد السلف القصيرة (4 سلف نقدية لموظف واحد): تُستقطع وتُسوّى كلّها دفعة واحدة بلا إغفال", async () => {
    const emp = await seedEmployee();
    // 4 سلف نقدية كالسحب المتكرر: 50,000 + 25,000 + 10,000 + 15,000 = 100,000 د.ع
    const a1 = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "50000" }, ACTOR);
    const a2 = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "25000" }, ACTOR);
    const a3 = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "10000" }, ACTOR);
    const a4 = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "15000" }, ACTOR);

    const paidRun = await fullPayCycle(CURRENT_PERIOD);
    expect(Number(paidRun!.items[0].advanceDeduction)).toBe(100000);
    expect(Number(paidRun!.items[0].net)).toBe(900000); // راتب 1,000,000 - 100,000 سلف

    const advRows = await db().select().from(s.employeeAdvances).where(inArray(s.employeeAdvances.id, [
      Number(a1.id), Number(a2.id), Number(a3.id), Number(a4.id),
    ]));
    expect(advRows).toHaveLength(4);
    for (const r of advRows) {
      expect(r.status).toBe("SETTLED");
      expect(Number(r.remaining)).toBe(0);
    }
  });

  it("السلفة الممنوحة بعد توليد مسودة المسيّر تُزامن تلقائياً وتُستقطع بالكامل عند الاعتماد", async () => {
    const emp = await seedEmployee();
    // 1. توليد مسودة مسيّر قبل منح السلفة
    const draftRun = await generatePayroll(CURRENT_PERIOD, ACTOR);
    expect(Number(draftRun!.items[0].advanceDeduction)).toBe(0);
    expect(Number(draftRun!.items[0].net)).toBe(1000000);

    // 2. منح سلفة للموظف أثناء وجود المسودة
    const adv = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "80000" }, ACTOR);

    // 3. اعتماد المسيّر — المزامنة التلقائية تلتقط السلفة فوراً دون الحاجة لحذف المسودة أو إعادة التوليد
    await approveRun(draftRun!.id, APPROVER);
    const runAfterApproval = await getRun(draftRun!.id);
    expect(Number(runAfterApproval!.items[0].advanceDeduction)).toBe(80000);
    expect(Number(runAfterApproval!.items[0].net)).toBe(920000);
    expect(Number(runAfterApproval!.totalDeductions)).toBe(80000);
    expect(Number(runAfterApproval!.totalNet)).toBe(920000);

    // 4. دفع المسيّر وتسوية السلفة
    await payRun(draftRun!.id, APPROVER);
    const [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(row.status).toBe("SETTLED");
    expect(Number(row.remaining)).toBe(0);
  });

  it("يمنع اعتماد المسيّر إذا لم يعد صافي الشهر يكفي لتصفير سلفته ولا يرحّل الباقي", async () => {
    const emp = await seedEmployee("1000000");
    const period = baghdadToday().slice(0, 7);
    const [advance] = await db()
      .insert(s.employeeAdvances)
      .values({
        employeeId: emp.id,
        branchId: 1,
        amount: "2000000.00",
        remaining: "2000000.00",
        monthlyDeduction: "2000000.00",
        sourceType: "SALARY_ADVANCE",
        payrollPeriod: period,
        status: "ACTIVE",
        createdBy: ACTOR.userId,
      })
      .$returningId();
    const draft = await generatePayroll(period, ACTOR);
    const draftRunId = Number(draft!.id);
    const draftAdvanceDeduction = Number(draft!.items?.[0]?.advanceDeduction);
    expect(draftAdvanceDeduction).toBeGreaterThan(0);
    expect(draftAdvanceDeduction).toBeLessThan(2000000);

    await expect(approveRun(draftRunId, APPROVER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    const [storedAdvance] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(advance.id)));
    const [storedRun] = await db()
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, draftRunId));
    expect(storedAdvance.status).toBe("ACTIVE");
    expect(storedAdvance.remaining).toBe("2000000.00");
    expect(storedRun.status).toBe("draft");
  });

  it("يسوّي كل سلف الشهر وحدها ويعيد أرصدة الشهر والتاريخ عند عكس المسيّر", async () => {
    const employee = await seedEmployee();
    const [year, month] = CURRENT_PERIOD.split("-").map(Number);
    const previous = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
    const inserts = await db().insert(s.employeeAdvances).values([
      { employeeId: employee.id, branchId: 1, amount: "50000.00", remaining: "50000.00", monthlyDeduction: "5000.00", sourceType: "SALARY_ADVANCE", payrollPeriod: CURRENT_PERIOD, createdBy: 1 },
      { employeeId: employee.id, branchId: 1, amount: "25000.00", remaining: "25000.00", monthlyDeduction: "5000.00", sourceType: "SALARY_ADVANCE", payrollPeriod: CURRENT_PERIOD, createdBy: 1 },
      { employeeId: employee.id, branchId: 1, amount: "40000.00", remaining: "40000.00", monthlyDeduction: "5000.00", sourceType: "SALARY_ADVANCE", payrollPeriod: previous, createdBy: 1 },
      { employeeId: employee.id, branchId: 1, amount: "30000.00", remaining: "30000.00", monthlyDeduction: "10000.00", sourceType: "OTHER_DEDUCTION", payrollPeriod: null, createdBy: 1 },
      { employeeId: employee.id, branchId: 1, amount: "20000.00", remaining: "20000.00", monthlyDeduction: "5000.00", sourceType: "LEGACY_UNCLASSIFIED", payrollPeriod: null, createdBy: 1 },
    ]).$returningId();
    const ids = inserts.map((row) => Number(row.id));
    const balances = async () => (await db().select().from(s.employeeAdvances)
      .where(inArray(s.employeeAdvances.id, ids)).orderBy(s.employeeAdvances.id))
      .map((row) => [row.remaining, row.status]);
    const run = await generatePayroll(CURRENT_PERIOD, ACTOR);
    expect(run!.items[0].advanceDeduction).toBe("90000.00");
    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER);
    expect(await balances()).toEqual([
      ["0.00", "SETTLED"], ["0.00", "SETTLED"], ["40000.00", "ACTIVE"],
      ["20000.00", "ACTIVE"], ["15000.00", "ACTIVE"],
    ]);
    const applied = await db().select().from(s.advanceSettlements)
      .where(eq(s.advanceSettlements.runId, run!.id));
    expect(applied).toHaveLength(4);
    expect(applied.some((row) => Number(row.advanceId) === ids[2])).toBe(false);
    await returnPaidSalary(run!.id);
    await cancelRun(run!.id, APPROVER);
    expect(await balances()).toEqual([
      ["50000.00", "ACTIVE"], ["25000.00", "ACTIVE"], ["40000.00", "ACTIVE"],
      ["30000.00", "ACTIVE"], ["20000.00", "ACTIVE"],
    ]);
    const reversed = await db().select().from(s.advanceSettlements)
      .where(eq(s.advanceSettlements.runId, run!.id));
    expect(reversed.filter((row) => row.direction === "REVERSE")).toHaveLength(4);
  });

  it("سندات الطلب القديمة غير المصنفة تظهر صراحة ولا تختفي أو تُنسب إلى شهر مفترض", async () => {
    const emp = await seedEmployee();
    // إنشاء طلب سلفة مباشرة دون اعتماد السند ليبقى في PENDING_APPROVAL
    const requested = await grantAdvanceService(
      { employeeId: emp.id, branchId: 1, amount: "60000", note: "سلفة نقدية طارئة", clientRequestId: "test-pending-1" },
      ACTOR,
    );
    expect(requested.status).toBe("PENDING_APPROVAL");

    const list = await listAdvances({ employeeId: emp.id });
    expect(list.length).toBeGreaterThanOrEqual(1);
    const pending = list.find((item) => item.status === "LEGACY_UNCLASSIFIED");
    expect(pending).toBeDefined();
    expect(Number(pending!.amount)).toBe(60000);
    expect(pending!.employeeId).toBe(emp.id);
    expect(pending!.voucherNumber).toMatch(/^PV-/);
    expect(pending!.workflowStatus).toBe("LEGACY_VOUCHER_PENDING");
    expect(pending!.financiallyDisbursed).toBe(false);
  });
});
