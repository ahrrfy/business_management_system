// حساب البطاقة/البنك — رصيدٌ مشتقّ من receipts (paymentMethod='CARD', approvalStatus='APPROVED')
// + لقطات مطابقة. الثوابت الحرجة:
//   • دخل البطاقة يرفع رصيد البطاقة، والنقد لا يمسّه (والعكس: البطاقة لا تمسّ الدرج).
//   • سند صرف بطاقة PENDING_APPROVAL لا يَخصم شيئاً حتى الاعتماد.
//   • الإلغاء (REVERSED + تعويضيّ معاكس) يتصافى إلى صفر.
//   • عزل الفرع: كل فرع رصيده، وغير-الأدمن محبوسٌ بفرعه.
//   • المطابقة: رصيد النظام حتى asOfDate مقابل كشف البنك ⇒ الفرق صحيح.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createCardReconciliation,
  getCardMovements,
  getCardSummary,
  listCardReconciliations,
  type CardScope,
} from "../cardAccountService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const insertId = (r: any): number => Number(r?.[0]?.insertId ?? r?.insertId);

const ADMIN: CardScope = { role: "admin", branchId: null };
const MGR1: CardScope = { role: "manager", branchId: 1 };
const MGR2: CardScope = { role: "manager", branchId: 2 };

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["cardReconciliations", "accountingEntries", "receipts", "customers", "suppliers", "users", "branches"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

beforeEach(async () => {
  await reset();
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "m1", name: "مدير ١", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "acc", name: "محاسب", role: "accountant", loginMethod: "local", branchId: 1 },
    { id: 9, openId: "adm", name: "أدمن", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
});

interface SeedReceipt {
  branchId?: number;
  direction?: "IN" | "OUT";
  amount: string;
  paymentMethod?: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
  status?: "PENDING" | "COMPLETED" | "FAILED" | "REVERSED";
  approvalStatus?: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
  cashBucket?: "DRAWER" | "TREASURY" | null;
  partyType?: "CUSTOMER" | "SUPPLIER" | "OTHER" | null;
  partyId?: number | null;
  voucherNumber?: string | null;
  invoiceId?: number | null;
  cardLastFour?: string | null;
  createdAt?: Date;
  createdBy?: number;
}

async function seedReceipt(r: SeedReceipt): Promise<number> {
  const res = await db()
    .insert(s.receipts)
    .values({
      branchId: r.branchId ?? 1,
      direction: r.direction ?? "IN",
      amount: r.amount,
      paymentMethod: r.paymentMethod ?? "CARD",
      status: r.status ?? "COMPLETED",
      approvalStatus: r.approvalStatus ?? "APPROVED",
      cashBucket: r.cashBucket ?? (r.paymentMethod === "CASH" ? "DRAWER" : null),
      partyType: r.partyType ?? "OTHER",
      partyId: r.partyId ?? null,
      voucherNumber: r.voucherNumber ?? null,
      invoiceId: r.invoiceId ?? null,
      cardLastFour: r.cardLastFour ?? null,
      createdBy: r.createdBy ?? 1,
      ...(r.createdAt ? { createdAt: r.createdAt } : {}),
    });
  return insertId(res);
}

describe("حساب البطاقة — الرصيد المشتقّ", () => {
  it("رصيد البطاقة = دخل − صرف البطاقة، والنقد لا يُحتَسب فيه (البطاقة منفصلة عن الدرج)", async () => {
    await seedReceipt({ direction: "IN", amount: "500.00", paymentMethod: "CARD" });
    await seedReceipt({ direction: "OUT", amount: "200.00", paymentMethod: "CARD" });
    await seedReceipt({ direction: "IN", amount: "1000.00", paymentMethod: "CASH" }); // درج — يجب ألّا يظهر
    await seedReceipt({ direction: "IN", amount: "50.00", paymentMethod: "CHECK" }); // صك — ليس بطاقة

    const sum = await getCardSummary({}, MGR1);
    expect(sum.balance).toBe("300.00"); // 500 − 200 (النقد والصك مُستبعَدان)
    expect(sum.totalIn).toBe("500.00");
    expect(sum.totalOut).toBe("200.00");
    expect(sum.movementCount).toBe(2); // البطاقتان فقط
  });

  it("سند صرف بطاقة PENDING_APPROVAL لا يَخصم من رصيد البطاقة حتى الاعتماد", async () => {
    await seedReceipt({ direction: "IN", amount: "500.00", paymentMethod: "CARD" });
    // صرف بطاقة معلَّق (فوق العتبة، بلا قيد دفتر) — يجب ألّا يُنقص الرصيد.
    await seedReceipt({ direction: "OUT", amount: "400.00", paymentMethod: "CARD", approvalStatus: "PENDING_APPROVAL" });

    const before = await getCardSummary({}, MGR1);
    expect(before.balance).toBe("500.00"); // المعلَّق غير محتسَب

    // بعد الاعتماد (approvalStatus=APPROVED) يُحتسَب.
    await db().update(s.receipts).set({ approvalStatus: "APPROVED" }).where(sql`paymentMethod='CARD' AND direction='OUT'`);
    const after = await getCardSummary({}, MGR1);
    expect(after.balance).toBe("100.00"); // 500 − 400
  });

  it("الإلغاء (REVERSED + إيصال تعويضيّ معاكس) يتصافى إلى صفر", async () => {
    await seedReceipt({ direction: "IN", amount: "700.00", paymentMethod: "CARD" }); // رصيد أساس
    // سند صرف بطاقة 200 اعتُمِد ثم أُلغِي: الأصل REVERSED (يبقى APPROVED) + تعويضيّ IN 200 COMPLETED.
    await seedReceipt({ direction: "OUT", amount: "200.00", paymentMethod: "CARD", status: "REVERSED", voucherNumber: "PV-1" });
    await seedReceipt({ direction: "IN", amount: "200.00", paymentMethod: "CARD", status: "COMPLETED" }); // التعويضيّ

    const sum = await getCardSummary({}, MGR1);
    // 700 − 200 (الأصل REVERSED محتسَب) + 200 (التعويضيّ) = 700 ⇒ صافي الإلغاء صفر.
    expect(sum.balance).toBe("700.00");
  });

  it("عزل الفرع: كل فرع رصيده، والأدمن يرى المجموع عبر الفروع", async () => {
    await seedReceipt({ branchId: 1, direction: "IN", amount: "300.00", paymentMethod: "CARD" });
    await seedReceipt({ branchId: 2, direction: "IN", amount: "800.00", paymentMethod: "CARD" });

    const b1 = await getCardSummary({}, MGR1);
    expect(b1.balance).toBe("300.00"); // فرع ١ فقط

    const b2 = await getCardSummary({}, MGR2);
    expect(b2.balance).toBe("800.00"); // فرع ٢ فقط

    // مدير فرع ١ يطلب فرع ٢ صراحةً ⇒ يُتجاهَل الطلب ويُحبَس بفرعه (البوّابة ترفض upstream؛ الخدمة تُثبّت فرعه).
    const b1forced = await getCardSummary({ branchId: 2 }, MGR1);
    expect(b1forced.balance).toBe("300.00");

    // الأدمن: كل الفروع (null) أو فرعٌ محدَّد.
    const all = await getCardSummary({}, ADMIN);
    expect(all.balance).toBe("1100.00");
    const adminB2 = await getCardSummary({ branchId: 2 }, ADMIN);
    expect(adminB2.balance).toBe("800.00");
  });

  it("دخل/صرف اليوم يُميَّز عن الرصيد التراكميّ", async () => {
    const old = new Date("2026-01-05T09:00:00Z");
    await seedReceipt({ direction: "IN", amount: "1000.00", paymentMethod: "CARD", createdAt: old }); // قديم
    await seedReceipt({ direction: "IN", amount: "250.00", paymentMethod: "CARD" }); // اليوم
    await seedReceipt({ direction: "OUT", amount: "40.00", paymentMethod: "CARD" }); // اليوم

    const sum = await getCardSummary({}, MGR1);
    expect(sum.balance).toBe("1210.00"); // 1000 + 250 − 40
    expect(sum.todayIn).toBe("250.00");
    expect(sum.todayOut).toBe("40.00");
  });
});

describe("حساب البطاقة — الحركات", () => {
  it("تُعيد الحركات برصيدٍ جارٍ تصاعديّ صحيح (للفرع المحدَّد) وإجماليات النطاق", async () => {
    await seedReceipt({ direction: "IN", amount: "100.00", paymentMethod: "CARD", createdAt: new Date("2026-06-01T10:00:00Z") });
    await seedReceipt({ direction: "IN", amount: "50.00", paymentMethod: "CARD", createdAt: new Date("2026-06-02T10:00:00Z") });
    await seedReceipt({ direction: "OUT", amount: "30.00", paymentMethod: "CARD", createdAt: new Date("2026-06-03T10:00:00Z") });

    const res = await getCardMovements({}, MGR1);
    expect(res.count).toBe(3);
    expect(res.totalIn).toBe("150.00");
    expect(res.totalOut).toBe("30.00");
    expect(res.net).toBe("120.00");
    // مرتَّبة تنازلياً (الأحدث أولاً) — الرصيد الجاري لكل صفّ = الرصيد بعد تلك الحركة.
    expect(res.rows[0].runningBalance).toBe("120.00"); // بعد OUT 30
    expect(res.rows[1].runningBalance).toBe("150.00"); // بعد IN 50
    expect(res.rows[2].runningBalance).toBe("100.00"); // بعد IN 100
  });

  it("النقد لا يظهر في حركات البطاقة، والعميل/المورد يُربَط اسمه", async () => {
    await db().insert(s.customers).values({ id: 5, name: "عميل بطاقة", type: "INDIVIDUAL", branchId: 1 });
    await seedReceipt({ direction: "IN", amount: "75.00", paymentMethod: "CARD", partyType: "CUSTOMER", partyId: 5, invoiceId: null });
    await seedReceipt({ direction: "IN", amount: "999.00", paymentMethod: "CASH" }); // نقد — مُستبعَد

    const res = await getCardMovements({}, MGR1);
    expect(res.count).toBe(1);
    expect(res.rows[0].partyName).toBe("عميل بطاقة");
    expect(res.rows[0].amount).toBe("75.00");
  });
});

describe("حساب البطاقة — المطابقة", () => {
  it("لقطة المطابقة تحسب رصيد النظام حتى asOfDate وتقارنه بكشف البنك", async () => {
    await seedReceipt({ direction: "IN", amount: "500.00", paymentMethod: "CARD", createdAt: new Date("2026-01-10T10:00:00Z") });
    await seedReceipt({ direction: "IN", amount: "300.00", paymentMethod: "CARD", createdAt: new Date("2026-06-20T10:00:00Z") }); // بعد asOf

    // asOfDate = 2026-03-01 ⇒ رصيد النظام = 500 فقط (يونيو مُستبعَد).
    const rec = await createCardReconciliation(
      { branchId: 1, asOfDate: "2026-03-01", statementBalance: "480.00", statementLabel: "كشف فبراير" },
      { userId: 1, role: "manager", branchId: 1 },
    );
    expect(rec.systemBalance).toBe("500.00");
    expect(rec.difference).toBe("20.00"); // 500 − 480 (رسوم/غير مُسوَّى)

    const list = await listCardReconciliations({}, MGR1);
    expect(list.length).toBe(1);
    expect(list[0].statementLabel).toBe("كشف فبراير");
    expect(list[0].systemBalance).toBe("500.00");

    // آخر لقطة تظهر في الملخّص.
    const sum = await getCardSummary({}, MGR1);
    expect(sum.lastReconciliation?.difference).toBe("20.00");
  });

  it("عزل الفرع في المطابقة: المدير يُثبَّت بفرعه ولا يطابق فرعاً آخر", async () => {
    await seedReceipt({ branchId: 2, direction: "IN", amount: "600.00", paymentMethod: "CARD", createdAt: new Date("2026-01-10T10:00:00Z") });

    // مدير فرع ١ يطلب مطابقة فرع ٢ ⇒ الخدمة تُثبّته على فرعه (١) لا فرع ٢.
    const rec = await createCardReconciliation(
      { branchId: 2, asOfDate: "2026-06-01", statementBalance: "0.00" },
      { userId: 1, role: "manager", branchId: 1 },
    );
    expect(rec.branchId).toBe(1);
    expect(rec.systemBalance).toBe("0.00"); // فرع ١ بلا حركات بطاقة

    // لقطات فرع ٢ لا تظهر لمدير فرع ١.
    const listB1 = await listCardReconciliations({}, MGR1);
    expect(listB1.every((r) => r.branchId === 1)).toBe(true);
  });
});
