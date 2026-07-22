// بند 12أ (٧/٧): اختبارات وحدة الأقساط والشيكات الآجلة.
// النمط: customerDuplicate.test.ts / voucher.test.ts — TRUNCATE + بذر مباشر ثم استدعاء الخدمة.
// السداد يمرّ عبر createVoucher الحقيقية ⇒ نتحقّق من receipts + accountingEntries + AR فعلياً.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  bounceCheck,
  cancelPlan,
  createPlan,
  dueSoon,
  getPlan,
  listPlans,
  payLine,
} from "../installmentService";

const actor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "installmentLines",
  "installmentPlans",
  "invoiceItems",
  "invoices",
  "shifts",
  "voucherCategories",
  "customers",
  "suppliers",
  "branches",
  "users",
  "auditLogs",
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
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.customers).values({
    id: 1,
    name: "عميل أقساط",
    defaultPriceTier: "RETAIL",
    currentBalance: "900000.00", // مدين لنا — الخطة جدولة تحصيل فوق هذه الذمّة
  });
}

const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** خطة قياسية: إجمالي 90000، دفعة أولى 10000، قسطان نقدي (30000) + شيك (50000).
 *  المبالغ دون عتبة المُرفق (250 ألف) عمداً — اختبار المُرفق/الاعتماد له خطة مخصّصة. */
async function seedPlan(over: Partial<Parameters<typeof createPlan>[0]> = {}) {
  return createPlan(
    {
      customerId: 1,
      branchId: 1,
      totalAmount: "90000.00",
      downPayment: "10000.00",
      lines: [
        { dueDate: ymd(10), amount: "30000.00", kind: "CASH" },
        { dueDate: ymd(40), amount: "50000.00", kind: "CHECK", checkNumber: "CHK-777", bankName: "الرافدين" },
      ],
      notes: "خطة اختبار",
      ...over,
    },
    actor,
  );
}

async function customerBalance(id = 1): Promise<string> {
  const c = (await db().select().from(s.customers).where(eq(s.customers.id, id)))[0];
  return String(c.currentBalance);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("createPlan", () => {
  it("إنشاء سليم: خطة ACTIVE + أسطر seq متسلسلة + لا قيد محاسبي عند الإنشاء", async () => {
    const { planId } = await seedPlan();
    const plan = await getPlan(planId);
    expect(plan.status).toBe("ACTIVE");
    expect(plan.totalAmount).toBe("90000.00");
    expect(plan.downPayment).toBe("10000.00");
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines.map((l) => l.seq)).toEqual([1, 2]);
    expect(plan.lines[1].checkNumber).toBe("CHK-777");
    expect(plan.lines.every((l) => l.status === "PENDING")).toBe(true);

    // لا قيد ولا سند — الخطة جدولة تحصيل فقط، والذمّة لم تتحرّك.
    const ents = await db().select().from(s.accountingEntries);
    expect(ents).toHaveLength(0);
    expect(await customerBalance()).toBe("900000.00");
  });

  it("مجموع لا يطابق ⇒ BAD_REQUEST برسالة تُسمّي الفرق", async () => {
    await expect(
      seedPlan({ totalAmount: "90000.00", downPayment: "10000.00", lines: [{ dueDate: ymd(10), amount: "30000.00", kind: "CASH" }] }),
    ).rejects.toThrow(/لا يطابق[\s\S]*الفرق 50000\.00/);
  });

  it("تواريخ غير متصاعدة ⇒ يُرفض", async () => {
    await expect(
      seedPlan({
        lines: [
          { dueDate: ymd(40), amount: "30000.00", kind: "CASH" },
          { dueDate: ymd(10), amount: "50000.00", kind: "CASH" },
        ],
      }),
    ).rejects.toThrow(/متصاعدة/);
  });

  it("قسط شيك بلا رقم شيك ⇒ يُرفض", async () => {
    await expect(
      seedPlan({
        lines: [
          { dueDate: ymd(10), amount: "30000.00", kind: "CASH" },
          { dueDate: ymd(40), amount: "50000.00", kind: "CHECK" },
        ],
      }),
    ).rejects.toThrow(/رقم الشيك إلزامي/);
  });

  it("عميل معطَّل ⇒ يُرفض", async () => {
    await db().update(s.customers).set({ isActive: false }).where(eq(s.customers.id, 1));
    await expect(seedPlan()).rejects.toThrow(/مُعطَّل/);
  });

  it("فاتورة لعميل آخر ⇒ يُرفض؛ فاتورة صحيحة ⇒ تُربط", async () => {
    const d = db();
    await d.insert(s.customers).values({ id: 2, name: "عميل آخر", defaultPriceTier: "RETAIL" });
    await d.insert(s.invoices).values({ id: 5, invoiceNumber: "INV-5", sourceType: "POS", branchId: 1, customerId: 2, subtotal: "10", total: "10" });
    await expect(seedPlan({ invoiceId: 5 })).rejects.toThrow(/لا تخصّ هذا العميل/);

    await d.insert(s.invoices).values({ id: 6, invoiceNumber: "INV-6", sourceType: "POS", branchId: 1, customerId: 1, subtotal: "10", total: "10" });
    const { planId } = await seedPlan({ invoiceId: 6 });
    expect((await getPlan(planId)).invoiceId).toBe(6);
  });
});

describe("payLine — سند قبض حقيقي بالمسار الموحَّد", () => {
  it("سداد قسط نقدي: receipt فعلي + قيد PAYMENT_IN + ذمّة العميل تنقص + القسط PAID", async () => {
    const { planId } = await seedPlan();
    const plan = await getPlan(planId);
    const cashLine = plan.lines[0];

    const res = await payLine({ lineId: cashLine.id }, actor);
    expect(res.status).toBe("PAID");
    expect(res.voucherNumber).toMatch(/^RV-1-/);
    expect(res.planCompleted).toBe(false);

    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, res.receiptId)))[0];
    expect(rc.direction).toBe("IN");
    expect(rc.amount).toBe("30000.00");
    expect(rc.partyType).toBe("CUSTOMER");
    expect(Number(rc.partyId)).toBe(1);
    expect(rc.approvalStatus).toBe("APPROVED");

    const ents = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_IN"));
    expect(ents).toHaveLength(1);
    expect(ents[0].amount).toBe("30000.00");

    expect(await customerBalance()).toBe("870000.00"); // 900000 − 30000

    const after = await getPlan(planId);
    expect(after.lines[0].status).toBe("PAID");
    expect(Number(after.lines[0].receiptId)).toBe(res.receiptId);
    expect(after.lines[0].paidAt).toBeTruthy();
    expect(after.status).toBe("ACTIVE");
  });

  it("سداد كل الأقساط ⇒ الخطة COMPLETED", async () => {
    const { planId } = await seedPlan();
    const plan = await getPlan(planId);
    await payLine({ lineId: plan.lines[0].id }, actor);
    const res2 = await payLine({ lineId: plan.lines[1].id }, actor);
    expect(res2.status).toBe("PAID");
    expect(res2.planCompleted).toBe(true);

    const after = await getPlan(planId);
    expect(after.status).toBe("COMPLETED");
    expect(after.lines.every((l) => l.status === "PAID")).toBe(true);
    expect(await customerBalance()).toBe("820000.00"); // 900000 − 30000 − 50000
  });

  it("قسط مسدَّد لا يُسدَّد مرّتين (لا سند مزدوج)", async () => {
    const { planId } = await seedPlan();
    const plan = await getPlan(planId);
    await payLine({ lineId: plan.lines[0].id }, actor);
    await expect(payLine({ lineId: plan.lines[0].id }, actor)).rejects.toThrow(/مسدَّد بالفعل/);
    const recs = await db().select().from(s.receipts);
    expect(recs).toHaveLength(1);
  });

  it("Maker-Checker: مبلغ ≥ عتبة الاعتماد ⇒ السند PENDING_APPROVAL والقسط يبقى PENDING بلا أثر مالي", async () => {
    const { planId } = await createPlan(
      {
        customerId: 1,
        branchId: 1,
        totalAmount: "1500000.00",
        lines: [{ dueDate: ymd(5), amount: "1500000.00", kind: "CASH" }],
      },
      actor,
    );
    const plan = await getPlan(planId);
    const res = await payLine(
      { lineId: plan.lines[0].id, attachmentUrl: "https://example.com/receipt.jpg" },
      actor,
    );
    expect(res.status).toBe("PENDING_APPROVAL");

    // لا قيد ولا حركة ذمّة — فقط صفّ receipt معلَّق.
    const ents = await db().select().from(s.accountingEntries);
    expect(ents).toHaveLength(0);
    expect(await customerBalance()).toBe("900000.00");

    const after = await getPlan(planId);
    expect(after.lines[0].status).toBe("PENDING");
    expect(after.lines[0].note).toMatch(/بانتظار اعتماد/);
    expect(after.status).toBe("ACTIVE");

    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, res.receiptId)))[0];
    expect(rc.approvalStatus).toBe("PENDING_APPROVAL");
  });
});

describe("bounceCheck", () => {
  it("شيك معلَّق ⇒ BOUNCED بلا أي حركة مالية، ثم يُسدَّد لاحقاً", async () => {
    const { planId } = await seedPlan();
    const plan = await getPlan(planId);
    const checkLine = plan.lines[1];

    await bounceCheck({ lineId: checkLine.id, note: "أُعيد من المصرف — رصيد غير كافٍ" }, actor);
    const after = await getPlan(planId);
    expect(after.lines[1].status).toBe("BOUNCED");
    expect(after.lines[1].note).toMatch(/رصيد غير كافٍ/);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await customerBalance()).toBe("900000.00");

    // BOUNCED يقبل السداد (تحصيل بديل).
    const res = await payLine({ lineId: checkLine.id, paymentMethod: "CASH" }, actor);
    expect(res.status).toBe("PAID");
    expect(await customerBalance()).toBe("850000.00"); // 900000 − 50000
  });

  it("قسط نقدي أو شيك غير معلَّق ⇒ يُرفض", async () => {
    const { planId } = await seedPlan();
    const plan = await getPlan(planId);
    await expect(bounceCheck({ lineId: plan.lines[0].id }, actor)).rejects.toThrow(/نقدي/);
    await bounceCheck({ lineId: plan.lines[1].id }, actor);
    await expect(bounceCheck({ lineId: plan.lines[1].id }, actor)).rejects.toThrow(/معلَّق/);
  });

  it("شيك محصَّل (PAID) يرتدّ ⇒ إيصال عكسٍ OUT مكتمل شيفت-محايد + استعادة ذمّة العميل، بلا إبطال رجعيّ لإيصال الأصل", async () => {
    const { planId } = await seedPlan();
    const plan = await getPlan(planId);
    const checkLine = plan.lines[1]; // شيك 50000
    const pay = await payLine({ lineId: checkLine.id }, actor);
    expect(pay.status).toBe("PAID");
    expect(await customerBalance()).toBe("850000.00"); // 900000 − 50000

    const res = await bounceCheck({ lineId: checkLine.id, note: "ارتدّ من المصرف" }, actor);
    expect(res.reversed).toBe(true);

    // AR-BOUNCE: إيصال الأصل يبقى مكتملاً (لا إبطال رجعيّ يشوّه Z-report وردية سابقة).
    const orig = (await db().select().from(s.receipts).where(eq(s.receipts.id, pay.receiptId)))[0];
    expect(orig.status).toBe("COMPLETED");
    expect(orig.direction).toBe("IN");

    // إيصال عكسٍ OUT مكتمل جديد بمرجع BOUNCE-CHK، على الخزينة، بلا وردية (شيفت-محايد).
    const comp = (
      await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `BOUNCE-CHK-${checkLine.id}`))
    )[0];
    expect(comp).toBeTruthy();
    expect(comp.direction).toBe("OUT");
    expect(comp.status).toBe("COMPLETED");
    expect(comp.amount).toBe("50000.00");
    expect(comp.cashBucket).toBe("TREASURY");
    expect(comp.shiftId).toBeNull();
    expect(comp.approvalStatus).toBe("APPROVED");

    // قيد PAYMENT_OUT مربوط بالإيصال التعويضي الجديد لا بالأصل.
    const outEnt = (
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.receiptId, Number(comp.id)))
    )[0];
    expect(outEnt.entryType).toBe("PAYMENT_OUT");
    expect(outEnt.amount).toBe("50000.00");

    // ذمّة العميل استُعيدت (+50000 ⇒ عادت 900000)، والقسط BOUNCED.
    expect(await customerBalance()).toBe("900000.00");
    expect((await getPlan(planId)).lines[1].status).toBe("BOUNCED");
  });

  // الثابت الحرِج (تعارُض إصلاحين): بدون حذف مفتاح idempotency في bounceCheck، إعادة السداد تُعيد
  // الإيصال الأصل صامتاً (replay) فيُوسم القسط PAID بلا سند/قيد/خفض ذمّة — النقد يتبخّر والذمّة تبقى.
  it("شيك مُحصَّل يرتدّ ثم يُعاد سداده ⇒ سند + قيد PAYMENT_IN جديدان فعليّاً وتنخفض الذمّة (لا replay صامت للإيصال الأصل)", async () => {
    const { planId } = await seedPlan();
    const checkLine = (await getPlan(planId)).lines[1]; // شيك 50000

    // 1) تحصيل أول (شيك) ⇒ الذمّة تنخفض.
    const pay1 = await payLine({ lineId: checkLine.id }, actor);
    expect(pay1.status).toBe("PAID");
    expect(await customerBalance()).toBe("850000.00"); // 900000 − 50000

    // 2) ارتداد الشيك ⇒ استعادة الذمّة، القسط BOUNCED، ومفتاح idempotency يُحرَّر.
    const b1 = await bounceCheck({ lineId: checkLine.id, note: "ارتدّ من المصرف" }, actor);
    expect(b1.reversed).toBe(true);
    expect(await customerBalance()).toBe("900000.00");
    expect((await getPlan(planId)).lines[1].status).toBe("BOUNCED");

    // 3) إعادة السداد نقداً ⇒ يجب أن يُنشئ تحصيلاً حقيقياً جديداً (لا يُعيد الإيصال الأصل).
    const pay2 = await payLine({ lineId: checkLine.id, paymentMethod: "CASH" }, actor);
    expect(pay2.status).toBe("PAID");

    // (أ) الإيصال الجديد مغايرٌ للأصل، والقسط يحمله.
    expect(pay2.receiptId).not.toBe(pay1.receiptId);
    expect(Number((await getPlan(planId)).lines[1].receiptId)).toBe(pay2.receiptId);

    // (ب) الذمّة انخفضت فعلاً بالتحصيل الجديد — لا نقدَ متبخّراً.
    expect(await customerBalance()).toBe("850000.00");

    // (ج) قيدا PAYMENT_IN منفصلان بإيصالين مختلفين (الأصل + إعادة السداد).
    const paymentIns = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_IN"));
    expect(paymentIns).toHaveLength(2);
    const inReceiptIds = new Set(paymentIns.map((e) => Number(e.receiptId)));
    expect(inReceiptIds.has(pay1.receiptId)).toBe(true);
    expect(inReceiptIds.has(pay2.receiptId)).toBe(true);

    // (د) مفتاح idempotency الجديد يشير للإيصال الثاني لا الأول.
    const key = (
      await db().select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.clientRequestId, `instpay-${checkLine.id}`))
    )[0];
    expect(key).toBeTruthy();
    expect(Number(key.refId)).toBe(pay2.receiptId);
  });

  it("دورات ارتداد متعدّدة لا تُراكم خطأً: كل (سداد↔ارتداد) يُبقي الذمّة متّسقة، وكل تحصيلٍ سندٌ مستقل", async () => {
    const { planId } = await seedPlan();
    const checkLine = (await getPlan(planId)).lines[1]; // شيك 50000

    for (let i = 0; i < 3; i++) {
      const pay = await payLine({ lineId: checkLine.id }, actor);
      expect(pay.status).toBe("PAID");
      expect(await customerBalance()).toBe("850000.00"); // سُدِّد ⇒ 900000 − 50000
      await bounceCheck({ lineId: checkLine.id }, actor);
      expect(await customerBalance()).toBe("900000.00"); // ارتدّ ⇒ استُعيدت
    }
    // سدادٌ نهائيّ يستقرّ عند 850000 (لا تضخّمَ ذمّةٍ ولا نقدَ متبخّراً).
    const finalPay = await payLine({ lineId: checkLine.id }, actor);
    expect(finalPay.status).toBe("PAID");
    expect(await customerBalance()).toBe("850000.00");

    // ٤ تحصيلات ناجحة ⇒ ٤ قيود PAYMENT_IN بإيصالاتٍ مختلفة، و٣ قيود PAYMENT_OUT للارتدادات.
    const ins = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_IN"));
    const outs = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(ins).toHaveLength(4);
    expect(outs).toHaveLength(3);
    expect(new Set(ins.map((e) => Number(e.receiptId))).size).toBe(4);
  });

  it("تماثُل paidAmount: ارتداد قسطٍ مرتبطٍ بفاتورة لا يمسّ invoices.paidAmount ولا حالتها (لا يمحو سداداً مباشراً)", async () => {
    const d = db();
    // فاتورة بيع للعميل ١، سُدِّد منها مباشرةً 40000 (عربون/سداد مباشر) ⇒ PARTIALLY_PAID.
    await d.insert(s.invoices).values({
      id: 10,
      invoiceNumber: "INV-10",
      sourceType: "POS",
      branchId: 1,
      customerId: 1,
      subtotal: "100000.00",
      total: "100000.00",
      paidAmount: "40000.00",
      status: "PARTIALLY_PAID",
    });
    // خطة أقساط مرتبطة بالفاتورة، قسط شيك 50000.
    const { planId } = await createPlan(
      {
        customerId: 1,
        branchId: 1,
        invoiceId: 10,
        totalAmount: "60000.00",
        downPayment: "10000.00",
        lines: [{ dueDate: ymd(30), amount: "50000.00", kind: "CHECK", checkNumber: "CHK-INV", bankName: "الرشيد" }],
      },
      actor,
    );
    const checkLine = (await getPlan(planId)).lines[0];

    // تحصيل القسط عبر السند — يخفّض ذمّة العميل فقط ولا يمسّ paidAmount الفاتورة.
    await payLine({ lineId: checkLine.id }, actor);
    let inv = (await d.select().from(s.invoices).where(eq(s.invoices.id, 10)))[0];
    expect(inv.paidAmount).toBe("40000.00");
    expect(inv.status).toBe("PARTIALLY_PAID");
    expect(await customerBalance()).toBe("850000.00"); // 900000 − 50000

    // الارتداد — الإصلاح: لا يطرح 50000 من paidAmount (لم يَزِدها التحصيل قطّ) فيمحو الـ40000 المشروعة.
    await bounceCheck({ lineId: checkLine.id, note: "ارتدّ" }, actor);
    inv = (await d.select().from(s.invoices).where(eq(s.invoices.id, 10)))[0];
    expect(inv.paidAmount).toBe("40000.00"); // ثابتة — لم تُمحَ الدفعة المباشرة
    expect(inv.status).toBe("PARTIALLY_PAID");
    expect(await customerBalance()).toBe("900000.00"); // استُعيدت ذمّة العميل فقط
    expect((await getPlan(planId)).lines[0].status).toBe("BOUNCED");
  });

  // اختبار مُستلَم من جلسة epic-moser (تسليم شريحة «paidAmount غير متماثل») — فِخِّرة seedPlan({invoiceId})
  // بدفعة مقدّمة مسجّلة، مكمِّلة للاختبار السابق بمسار إعدادٍ مختلف.
  it("ارتداد شيك لفاتورة عليها دفعة مقدّمة مسجّلة ⇒ لا يمسّ invoice.paidAmount (عكسٌ متماثل مع مسار السداد)", async () => {
    const d = db();
    // فاتورة مرتبطة بالخطة عليها دفعة مقدّمة نقدية مسجّلة (paidAmount=20000) من مصدرٍ آخر.
    await d.insert(s.invoices).values({
      id: 7, invoiceNumber: "INV-7", sourceType: "POS", branchId: 1, customerId: 1,
      subtotal: "50000.00", total: "50000.00", paidAmount: "20000.00", status: "PARTIALLY_PAID",
    });
    const { planId } = await seedPlan({ invoiceId: 7 });
    const checkLine = (await getPlan(planId)).lines[1]; // شيك 50000

    // تحصيل الشيك عبر المسار الحقيقي (createVoucher لا يمسّ paidAmount).
    const pay = await payLine({ lineId: checkLine.id }, actor);
    expect(pay.status).toBe("PAID");
    expect((await d.select().from(s.invoices).where(eq(s.invoices.id, 7)))[0].paidAmount).toBe("20000.00");

    // الارتداد يجب ألّا يمسّ الدفعة المقدّمة المسجّلة.
    const res = await bounceCheck({ lineId: checkLine.id, note: "ارتدّ من المصرف" }, actor);
    expect(res.reversed).toBe(true);

    const inv = (await d.select().from(s.invoices).where(eq(s.invoices.id, 7)))[0];
    expect(inv.paidAmount).toBe("20000.00");     // ثابت — الدفعة سليمة (كان يصير "0.00")
    expect(inv.status).toBe("PARTIALLY_PAID");   // بلا إعادة حساب مضلِّلة (كان يصير "PENDING")
    expect(await customerBalance()).toBe("900000.00"); // الذمّة استُعيدت بالكامل (عكس متماثل)
  });

  // الثابت (Codex P1): ارتداد قسطٍ سنده ما يزال PENDING_APPROVAL (Maker-Checker، فوق العتبة) يجب ألّا
  // يُيتّم مفتاح idempotency — وإلّا لو اعتُمد السند لاحقاً + أُعيد السداد ⇒ تحصيلٌ مزدوج. حذف المفتاح
  // مشروطٌ بعكسِ تحصيلٍ نافذ (reversed) فقط؛ هنا reversed=false فيبقى المفتاح ويُعيد السداد السندَ نفسه.
  it("ارتداد قسطٍ سنده PENDING_APPROVAL (فوق العتبة) يُبقي مفتاح idempotency ⇒ لا سند ثانٍ ولا تحصيل مزدوج", async () => {
    // قسط شيك فوق عتبة الاعتماد ⇒ السند PENDING_APPROVAL والقسط يبقى PENDING (لا أثر ماليّ بعد).
    const { planId } = await createPlan(
      {
        customerId: 1,
        branchId: 1,
        totalAmount: "1500000.00",
        lines: [{ dueDate: ymd(20), amount: "1500000.00", kind: "CHECK", checkNumber: "CHK-BIG", bankName: "الرافدين" }],
      },
      actor,
    );
    const checkLine = (await getPlan(planId)).lines[0];

    const pay = await payLine({ lineId: checkLine.id, attachmentUrl: "https://example.com/r.jpg" }, actor);
    expect(pay.status).toBe("PENDING_APPROVAL");
    expect(await customerBalance()).toBe("900000.00"); // لا أثر ماليّ حتى الاعتماد

    // المفتاح سُجِّل مشيراً للسند المعلَّق (createVoucher يسجّله حتى للسند PENDING_APPROVAL).
    const keyBefore = (
      await db().select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.clientRequestId, `instpay-${checkLine.id}`))
    )[0];
    expect(keyBefore).toBeTruthy();
    expect(Number(keyBefore.refId)).toBe(pay.receiptId);

    // ارتداد القسط PENDING (لا عكس ماليّ — reversed=false).
    const b = await bounceCheck({ lineId: checkLine.id, note: "ارتدّ قبل الاعتماد" }, actor);
    expect(b.reversed).toBe(false);
    expect((await getPlan(planId)).lines[0].status).toBe("BOUNCED");
    expect(await customerBalance()).toBe("900000.00");

    // ✅ الثابت: المفتاح ما يزال موجوداً ويشير لنفس السند المعلَّق (لم يُيتَّم).
    const keyAfter = (
      await db().select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.clientRequestId, `instpay-${checkLine.id}`))
    )[0];
    expect(keyAfter).toBeTruthy();
    expect(Number(keyAfter.refId)).toBe(pay.receiptId);

    // إعادة السداد تُعيد السند المعلَّق نفسه (replay) لا سنداً ثانياً ⇒ لا ازدواج.
    const pay2 = await payLine({ lineId: checkLine.id, attachmentUrl: "https://example.com/r.jpg" }, actor);
    expect(pay2.status).toBe("PENDING_APPROVAL");
    expect(pay2.receiptId).toBe(pay.receiptId); // نفس السند — لا جديد
    expect(await db().select().from(s.receipts)).toHaveLength(1); // سند واحد فقط في النظام
  });
});

describe("cancelPlan", () => {
  it("خطة بلا سداد ⇒ CANCELLED وأقساطها CANCELLED", async () => {
    const { planId } = await seedPlan();
    await cancelPlan({ planId, reason: "اتفاق جديد مع العميل" }, actor);
    const after = await getPlan(planId);
    expect(after.status).toBe("CANCELLED");
    expect(after.lines.every((l) => l.status === "CANCELLED")).toBe(true);
    expect(after.notes).toMatch(/اتفاق جديد/);
  });

  it("خطة سُدِّد منها قسط ⇒ الإلغاء يُرفض", async () => {
    const { planId } = await seedPlan();
    const plan = await getPlan(planId);
    await payLine({ lineId: plan.lines[0].id }, actor);
    await expect(cancelPlan({ planId }, actor)).rejects.toThrow(/سُدِّد منها قسط/);
    expect((await getPlan(planId)).status).toBe("ACTIVE");
  });
});

describe("dueSoon — طابور التحصيل", () => {
  it("يُرتّب الأشد تأخّراً أولاً ويستثني المسدَّد وخطط غير ACTIVE وخارج النافذة", async () => {
    // متأخّر 20 يوماً + متأخّر 5 أيام + مستحقّ بعد 3 أيام + خارج النافذة (بعد 30 يوماً).
    const { planId } = await createPlan(
      {
        customerId: 1,
        branchId: 1,
        totalAmount: "400.00",
        lines: [
          { dueDate: ymd(-20), amount: "100.00", kind: "CASH" },
          { dueDate: ymd(-5), amount: "100.00", kind: "CHECK", checkNumber: "C1" },
          { dueDate: ymd(3), amount: "100.00", kind: "CASH" },
          { dueDate: ymd(30), amount: "100.00", kind: "CASH" },
        ],
      },
      actor,
    );

    const rows = await dueSoon({ days: 7 });
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0].daysOverdue).toBe(20);
    expect(rows[1].daysOverdue).toBe(5);
    expect(rows[2].daysOverdue).toBe(0);

    // سداد المتأخّر الأول يُخرجه من الطابور.
    const plan = await getPlan(planId);
    await payLine({ lineId: plan.lines[0].id }, actor);
    const rows2 = await dueSoon({ days: 7 });
    expect(rows2.map((r) => r.seq)).toEqual([2, 3]);

    // إلغاء خطة (طازجة بلا سداد) يُخرج أقساطها من الطابور.
    const fresh = await createPlan(
      {
        customerId: 1,
        branchId: 1,
        totalAmount: "50.00",
        lines: [{ dueDate: ymd(-2), amount: "50.00", kind: "CASH" }],
      },
      actor,
    );
    expect((await dueSoon({ days: 7 })).some((r) => r.planId === fresh.planId)).toBe(true);
    await cancelPlan({ planId: fresh.planId }, actor);
    expect((await dueSoon({ days: 7 })).some((r) => r.planId === fresh.planId)).toBe(false);
  });
});

describe("عزل الفروع", () => {
  it("listPlans/dueSoon يفلتران بالفرع، والكتابة على خطة فرع آخر FORBIDDEN", async () => {
    const p1 = await seedPlan(); // فرع 1
    const p2 = await createPlan(
      {
        customerId: 1,
        branchId: 2,
        totalAmount: "200.00",
        lines: [{ dueDate: ymd(-3), amount: "200.00", kind: "CASH" }],
      },
      actor,
    );

    const b1 = await listPlans({ branchId: 1 });
    expect(b1.rows.map((r) => r.id)).toEqual([p1.planId]);
    const b2 = await listPlans({ branchId: 2 });
    expect(b2.rows.map((r) => r.id)).toEqual([p2.planId]);
    const all = await listPlans({});
    expect(all.rows).toHaveLength(2);
    expect(all.hasMore).toBe(false);

    const due1 = await dueSoon({ branchId: 1, days: 7 });
    expect(due1.every((r) => r.branchId === 1)).toBe(true);
    const due2 = await dueSoon({ branchId: 2, days: 7 });
    expect(due2.map((r) => r.planId)).toEqual([p2.planId]);

    // مدير مُقيَّد بالفرع 1 لا يلمس خطة الفرع 2 (restrictToBranchId).
    const plan2 = await getPlan(p2.planId);
    await expect(payLine({ lineId: plan2.lines[0].id }, actor, 1)).rejects.toThrow(/فرعاً آخر/);
    await expect(cancelPlan({ planId: p2.planId }, actor, 1)).rejects.toThrow(/فرعاً آخر/);
    await expect(getPlan(p2.planId, 1)).rejects.toThrow(/فرعاً آخر/);
  });

  it("شارة التقدّم في listPlans: مدفوع س من ص + المبلغ المُحصَّل", async () => {
    const { planId } = await seedPlan();
    const plan = await getPlan(planId);
    await payLine({ lineId: plan.lines[0].id }, actor);
    const list = await listPlans({ branchId: 1 });
    const row = list.rows.find((r) => r.id === planId)!;
    expect(row.totalLines).toBe(2);
    expect(row.paidLines).toBe(1);
    expect(row.paidAmount).toBe("30000.00");
    expect(row.nextDueDate).toBe(ymd(40));
  });
});
