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
