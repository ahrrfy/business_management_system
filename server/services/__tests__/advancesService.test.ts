/**
 * اختبارات تكامل (DB) لسلف الموظفين — بند 12ج (server/services/advancesService.ts + دمج payrollService).
 * تغطّي:
 *  - المنح: سند صرف OUT حقيقي في receipts (خزينة) + قيد PAYMENT_OUT + سلفة ACTIVE بـremaining=amount.
 *  - قرار Maker-Checker الموثَّق: مبلغ يبلغ عتبة الاعتماد الثنائي يُرفض قبل إنشاء أي شيء.
 *  - التوليد: advanceDeduction يُملأ ضمن deductions (لا فوقها) وnet ينقص.
 *  - الدفع: يُنقص remaining، وSETTLED عند الصفر؛ monthlyDeduction يقسّط عبر شهرين؛
 *    سقف الخصم = remaining؛ عكس ثم إعادة دفع لا يخصم مرّتين (تسوية أول دفع فقط).
 *  - التحرير: الاستقطاع اليدوي لا يهبط دون جزء السلفة المولَّد.
 *  - الإلغاء: قبل أي خصم فقط؛ بعد خصم يُرفض. (السند الأصلي لا يُعكَس آلياً — شأن الخزينة.)
 *  - تعدّد السلف: الأقدم أولاً، واحدة تلو الأخرى.
 * (عزل الفرع: المسيّر مركزي لكل الشركة بلا عزل فرع في payrollService — لا اختبار عزل هنا عمداً.)
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelAdvance, employeeBalance, grantAdvance, listAdvances, suggestDeductionsForPeriod } from "../advancesService";
import { createEmployee } from "../employeeService";
import { approveRun, cancelRun, generatePayroll, payRun, updateItem } from "../payrollService";

const ACTOR = { userId: 1, branchId: 1, role: "admin" };
// SOD: المُعتمِد/الدافع يجب أن يختلف عن المُولِّد.
const APPROVER = { userId: 2, branchId: 1, role: "manager" };

const TABLES = [
  "accountingEntries",
  "receipts",
  "shifts",
  "idempotencyKeys",
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
    { id: 2, openId: "t-approver", name: "مدقّق", role: "manager", branchId: 1 },
  ]);
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

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
    expect(r.cashBucket).toBe("TREASURY");
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

  it("قرار Maker-Checker: مبلغ يبلغ عتبة الاعتماد الثنائي يُرفض قبل إنشاء أي سند أو سلفة", async () => {
    const emp = await seedEmployee();
    await expect(grantAdvance({ employeeId: emp.id, branchId: 1, amount: "1000000" }, ACTOR)).rejects.toThrow(/عتبة الاعتماد/);
    expect((await db().select().from(s.receipts)).length).toBe(0);
    expect((await db().select().from(s.employeeAdvances)).length).toBe(0);
  });

  it("عتبة المُرفق (vouchers-pro) تسري على سند السلفة: مبلغ ≥ العتبة بلا مُرفق يُرفض", async () => {
    const emp = await seedEmployee();
    await expect(grantAdvance({ employeeId: emp.id, branchId: 1, amount: "250000" }, ACTOR)).rejects.toThrow(/المُرفق إلزامي/);
    expect((await db().select().from(s.employeeAdvances)).length).toBe(0);
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

    const run = await generatePayroll("2026-06", ACTOR);
    const item = run!.items[0];
    expect(Number(item.advanceDeduction)).toBe(100000);
    expect(Number(item.deductions)).toBe(100000); // ضمنها لا فوقها
    expect(Number(item.net)).toBe(900000);
    expect(Number(run!.totalDeductions)).toBe(100000);
    expect(Number(run!.totalNet)).toBe(900000);
  });

  it("الدفع يُنقص remaining؛ التقسيط الشهري عبر شهرين حتى SETTLED عند الصفر", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "200000", monthlyDeduction: "100000" }, ACTOR);

    await fullPayCycle("2026-06");
    let [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(100000);
    expect(row.status).toBe("ACTIVE");

    await fullPayCycle("2026-07");
    [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(0);
    expect(row.status).toBe("SETTLED");

    // الشهر الثالث: لا استقطاع سلفة بعد التسوية.
    const run3 = await generatePayroll("2026-08", ACTOR);
    expect(Number(run3!.items[0].advanceDeduction)).toBe(0);
    expect(Number(run3!.items[0].net)).toBe(1000000);
  });

  it("سقف الخصم = remaining (الشهر الأخير يخصم البقية فقط)", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "150000", monthlyDeduction: "100000" }, ACTOR);

    await fullPayCycle("2026-06"); // خصم 100,000 ⇒ بقي 50,000
    const run2 = await generatePayroll("2026-07", ACTOR);
    expect(Number(run2!.items[0].advanceDeduction)).toBe(50000); // min(100000, 50000)
    await approveRun(run2!.id, APPROVER);
    await payRun(run2!.id, APPROVER);

    const [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(0);
    expect(row.status).toBe("SETTLED");
  });

  it("بلا monthlyDeduction ⇒ يُخصم كامل المتبقّي دفعة واحدة", async () => {
    const emp = await seedEmployee();
    await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "250000", attachmentUrl: "https://files.example/receipt.jpg" }, ACTOR);
    const suggestion = await suggestDeductionsForPeriod([emp.id]);
    expect(Number(suggestion[emp.id]?.suggested)).toBe(250000);

    const paid = await fullPayCycle("2026-06");
    expect(Number(paid!.items[0].advanceDeduction)).toBe(250000);
    expect(Number(paid!.items[0].net)).toBe(750000);
    const [row] = await db().select().from(s.employeeAdvances);
    expect(row.status).toBe("SETTLED");
  });

  it("قيد الدفع PAYMENT_OUT بصافي البند بعد خصم السلفة (النقد الخارج فعلاً)", async () => {
    const emp = await seedEmployee();
    await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "300000", monthlyDeduction: "100000", attachmentUrl: "https://files.example/receipt.jpg" }, ACTOR);
    const run = await generatePayroll("2026-06", ACTOR);
    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER);

    const [entry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `PAYROLL:${run!.id}:${emp.id}`));
    expect(Number(entry.amount)).toBe(900000); // 1,000,000 − 100,000
  });

  it("عكس مسيّر مدفوع ثم إعادة دفعه لا يخصم السلفة مرّتين (تسوية أول دفع فقط)", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "300000", monthlyDeduction: "100000", attachmentUrl: "https://files.example/receipt.jpg" }, ACTOR);
    const run = await generatePayroll("2026-06", ACTOR);
    await approveRun(run!.id, APPROVER);
    await payRun(run!.id, APPROVER);

    let [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(200000);

    await cancelRun(run!.id, ACTOR); // عكس الدفع ⇒ approved (لا إرجاع لأرصدة السلف — قرار موثَّق)
    [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(200000);

    await payRun(run!.id, APPROVER); // إعادة الدفع (:r1) — لا تسوية ثانية
    [row] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(Number(row.remaining)).toBe(200000);
    expect(row.status).toBe("ACTIVE");
  });

  it("تحرير البند لا يُهبط الاستقطاع دون جزء السلفة المولَّد، ويقبل الزيادة فوقه", async () => {
    const emp = await seedEmployee();
    await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "300000", monthlyDeduction: "100000", attachmentUrl: "https://files.example/receipt.jpg" }, ACTOR);
    const run = await generatePayroll("2026-06", ACTOR);
    const item = run!.items[0];

    await expect(updateItem(Number(item.id), { deductions: "50000" })).rejects.toThrow(/لا يقلّ/);

    // زيادة فوق جزء السلفة (غياب/جزاء إضافي) تُقبل وnet يعاد حسابه.
    const updated = await updateItem(Number(item.id), { deductions: "120000" });
    const uItem = updated!.items[0];
    expect(Number(uItem.deductions)).toBe(120000);
    expect(Number(uItem.advanceDeduction)).toBe(100000); // ثابت كما وُلّد
    expect(Number(uItem.net)).toBe(880000);
  });
});

describe("advancesService — الإلغاء وتعدّد السلف", () => {
  it("الإلغاء متاح قبل أي خصم فقط ويُرفض بعده (والسند الأصلي لا يُعكَس آلياً)", async () => {
    const emp = await seedEmployee();
    const a1 = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "100000" }, ACTOR);
    const res = await cancelAdvance({ advanceId: Number(a1.id), reason: "خطأ إدخال" }, ACTOR);
    expect(res.status).toBe("CANCELLED");
    expect(res.voucherNotice).toContain("لم يُعكَس");
    // السند الأصلي باقٍ COMPLETED (شأن الخزينة).
    const [r] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(a1.receiptId)));
    expect(r.status).toBe("COMPLETED");

    // سلفة خُصم منها ⇒ الإلغاء مرفوض.
    const a2 = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "200000", monthlyDeduction: "100000" }, ACTOR);
    await fullPayCycle("2026-06");
    await expect(cancelAdvance({ advanceId: Number(a2.id), reason: "متأخر" }, ACTOR)).rejects.toThrow(/خُصم/);
  });

  it("السلفة الملغاة قبل الدفع لا تُخصم، ودفعُ مسيّرٍ وُلّد قبل إلغائها يُرفض باتّساق (CONFLICT)", async () => {
    const emp = await seedEmployee();
    const adv = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "100000" }, ACTOR);
    const run = await generatePayroll("2026-06", ACTOR); // advanceDeduction=100000
    await cancelAdvance({ advanceId: Number(adv.id) }, ACTOR);
    await approveRun(run!.id, APPROVER);
    await expect(payRun(run!.id, APPROVER)).rejects.toThrow(/أرصدة السلف/);
  });

  it("تعدّد السلف: الأقدم أولاً واحدة تلو الأخرى", async () => {
    const emp = await seedEmployee();
    const a1 = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "100000" }, ACTOR);
    const a2 = await grantAdvance({ employeeId: emp.id, branchId: 1, amount: "200000", monthlyDeduction: "50000" }, ACTOR);

    // الشهر الأول: من الأقدم (a1، بلا خصم شهري ⇒ كامل رصيدها).
    await fullPayCycle("2026-06");
    const [r1] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(a1.id)));
    const [r2] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(a2.id)));
    expect(r1.status).toBe("SETTLED");
    expect(Number(r2.remaining)).toBe(200000); // لم تُمسّ

    // الشهر الثاني: الاقتراح ينتقل للسلفة التالية (a2 بخصمها الشهري).
    const run2 = await generatePayroll("2026-07", ACTOR);
    expect(Number(run2!.items[0].advanceDeduction)).toBe(50000);

    const list = await listAdvances({ employeeId: emp.id, status: "ACTIVE" });
    expect(list.length).toBe(1);
    expect(Number(list[0].id)).toBe(Number(a2.id));
    expect(list[0].voucherNumber).toMatch(/^PV-/);
  });
});
