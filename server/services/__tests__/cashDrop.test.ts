/**
 * اختبارات cashDropService.createCashDrop — السحب النقديّ أثناء الوردية (drawer → treasury).
 * يغطّي: المسار السعيد (إيصالان + قيد CASH_HANDOVER بمفتاح CASH_DROP + حساب الدرج)، حدّ الدرج،
 * الوردية المغلقة، غير المالك، المبلغ غير الموجب، السحوب المتعدّدة + التسلسل، المستلِم الاختياريّ،
 * والتكامل مع تقرير إقفال اليوم (دلو cashDrops + المتوقَّع/الفرق).
 */
import { and, eq, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createCashDrop } from "../cashDropService";
import { closeShift, openShift } from "../shiftService";
import { getDayCloseReconciliation } from "../reportsDayCloseService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const ADMIN = 1;
const MANAGER1 = 2;
const CASHIER1 = 3;
const CASHIER2 = 4;
const MANAGER2 = 5;
const DISABLED_MANAGER = 6;

const DATE = new Date().toISOString().slice(0, 10);

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: ADMIN, openId: "local_admin", name: "المدير العام", role: "admin", loginMethod: "local" },
    { id: MANAGER1, openId: "local_mgr1", name: "مدير الفرع١", role: "manager", loginMethod: "local", branchId: 1 },
    { id: CASHIER1, openId: "local_c1", name: "كاشير١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: CASHIER2, openId: "local_c2", name: "كاشير٢", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: MANAGER2, openId: "local_mgr2", name: "مدير الفرع٢", role: "manager", loginMethod: "local", branchId: 2 },
    { id: DISABLED_MANAGER, openId: "local_mgr_off", name: "مدير معطَّل", role: "manager", loginMethod: "local", branchId: 1, isActive: false },
  ]);
}

/** إيصال درجٍ نقديّ (لتغذية رصيد الدرج) — بلا فاتورة (رصيد الدرج لا يبالي بالتصنيف). */
async function drawerReceipt(shiftId: number, direction: "IN" | "OUT", amount: string, createdBy = CASHIER1) {
  await db().insert(s.receipts).values({
    branchId: 1, shiftId, direction, amount, paymentMethod: "CASH", cashBucket: "DRAWER",
    status: "COMPLETED", createdBy,
  });
}

async function receiptsByRef(ref: string) {
  return db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, ref));
}

beforeEach(async () => {
  await seedBase();
});

describe("createCashDrop — المسار السعيد والأثر", () => {
  it("إيصالان (OUT درج / IN خزينة) + قيد CASH_HANDOVER بمفتاح CASH_DROP + حساب الدرج", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await drawerReceipt(shiftId, "IN", "80000.00"); // بيع نقديّ ⇒ الدرج 180000

    const res = await createCashDrop(
      { shiftId, amount: "120000", dropTo: MANAGER1, notes: "تقليل نقد الدرج" },
      { userId: CASHIER1, branchId: 1, role: "cashier" },
    );

    expect(res.dropNumber).toMatch(/^CD-1-\d{8}-0001$/);
    expect(res.drawerBefore).toBe("180000.00");
    expect(res.drawerAfter).toBe("60000.00");

    const rows = await receiptsByRef(res.dropNumber);
    expect(rows).toHaveLength(2);
    const out = rows.find((r) => r.direction === "OUT")!;
    expect(out.shiftId).toBe(shiftId);
    expect(out.cashBucket).toBe("DRAWER");
    expect(out.amount).toBe("120000.00");
    expect(out.createdBy).toBe(CASHIER1);
    const inn = rows.find((r) => r.direction === "IN")!;
    expect(inn.shiftId).toBeNull();
    expect(inn.cashBucket).toBe("TREASURY");
    expect(inn.createdBy).toBe(MANAGER1); // يُنسَب الاستلام للمستلِم

    const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "CASH_HANDOVER" as any));
    expect(entries).toHaveLength(1);
    expect(entries[0].dedupeKey).toBe(`CASH_DROP:${res.dropNumber}`);
    expect(entries[0].amount).toBe("120000.00");
    expect(entries[0].receiptId).toBe(out.id);
  });

  it("السحب يُنقِص المتوقَّع، والمعدود يُنقِص بالمثل ⇒ الفرق صفر (لا عجز وهميّ)", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await drawerReceipt(shiftId, "IN", "80000.00"); // الدرج 180000
    await createCashDrop({ shiftId, amount: "120000", dropTo: MANAGER1 }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    // بعد السحب الدرج فيه 60000؛ العدّ يطابقه.
    const r = await closeShift({ shiftId, countedCash: "60000" }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    expect(r.expectedCash).toBe("60000.00"); // 100000 + 80000 − 120000
    expect(r.variance).toBe("0.00");
  });
});

describe("createCashDrop — الحراسات", () => {
  it("حدّ الدرج: سحبٌ أكثر من النقد المتاح ⇒ BAD_REQUEST بلا إيصالات", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "50000" }, { userId: CASHIER1, branchId: 1 });
    await drawerReceipt(shiftId, "IN", "10000.00"); // الدرج 60000
    await expect(
      createCashDrop({ shiftId, amount: "70000" }, { userId: CASHIER1, branchId: 1, role: "cashier" }),
    ).rejects.toThrow(/أكثر من النقد في الدرج/);
    const all = await db().select().from(s.receipts).where(and(eq(s.receipts.shiftId, shiftId), like(s.receipts.referenceNumber, "CD-%")));
    expect(all).toHaveLength(0);
  });

  it("وردية مغلقة ⇒ BAD_REQUEST", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await closeShift({ shiftId, countedCash: "100000" }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    await expect(
      createCashDrop({ shiftId, amount: "1000" }, { userId: CASHIER1, branchId: 1, role: "cashier" }),
    ).rejects.toThrow(/مغلقة/);
  });

  it("كاشير آخر يسحب من وردية زميله ⇒ FORBIDDEN", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await expect(
      createCashDrop({ shiftId, amount: "1000" }, { userId: CASHIER2, branchId: 1, role: "cashier" }),
    ).rejects.toThrow(/وردية موظّف آخر/);
  });

  it("مبلغ صفري/سالب ⇒ BAD_REQUEST", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await expect(createCashDrop({ shiftId, amount: "0" }, { userId: CASHIER1, branchId: 1, role: "cashier" })).rejects.toThrow(/موجباً/);
    await expect(createCashDrop({ shiftId, amount: "-5" }, { userId: CASHIER1, branchId: 1, role: "cashier" })).rejects.toThrow(/موجباً/);
  });

  it("المستلِم يجب أن يكون مديراً/إدارياً نشطاً", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await expect(createCashDrop({ shiftId, amount: "1000", dropTo: CASHIER2 }, { userId: CASHIER1, branchId: 1, role: "cashier" })).rejects.toThrow(/مديراً أو إدارياً/);
    await expect(createCashDrop({ shiftId, amount: "1000", dropTo: DISABLED_MANAGER }, { userId: CASHIER1, branchId: 1, role: "cashier" })).rejects.toThrow(/غير موجود أو معطّل/);
    // بلا مستلِم ⇒ مقبول (درج أمانٍ)، ويُنسَب الاستلام للفاعل.
    const res = await createCashDrop({ shiftId, amount: "1000" }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    const inn = (await receiptsByRef(res.dropNumber)).find((r) => r.direction === "IN")!;
    expect(inn.createdBy).toBe(CASHIER1);
  });
});

describe("createCashDrop — التسلسل والتراكم", () => {
  it("سحبان في نفس الفرع/اليوم ⇒ 0001 ثم 0002، والدرج يتناقص تراكمياً", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    const d1 = await createCashDrop({ shiftId, amount: "20000", dropTo: MANAGER1 }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    expect(d1.dropNumber).toMatch(/-0001$/);
    expect(d1.drawerAfter).toBe("80000.00");
    const d2 = await createCashDrop({ shiftId, amount: "30000", dropTo: MANAGER1 }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    expect(d2.dropNumber).toMatch(/-0002$/);
    expect(d2.drawerBefore).toBe("80000.00");
    expect(d2.drawerAfter).toBe("50000.00");
  });

  it("admin يسحب من أي فرع (مرور حرّ)", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    const res = await createCashDrop({ shiftId, amount: "5000", dropTo: MANAGER1 }, { userId: ADMIN, branchId: 2, role: "admin" });
    expect(res.dropNumber).toMatch(/^CD-1-/);
  });
});

describe("createCashDrop — تكامل تقرير إقفال اليوم", () => {
  it("السحب يظهر في دلو cashDrops ويُنقِص المتوقَّع، والفرق صفر", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await drawerReceipt(shiftId, "IN", "50000.00"); // مقبوضات ⇒ الدرج 150000
    await createCashDrop({ shiftId, amount: "40000", dropTo: MANAGER1 }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    await closeShift({ shiftId, countedCash: "110000" }, { userId: CASHIER1, branchId: 1, role: "cashier" });

    const res = await getDayCloseReconciliation({ date: DATE, branchId: 1 });
    const line = res.shifts.find((x) => x.shiftId === shiftId)!;
    expect(line.cashDrops).toBe("40000.00");
    expect(line.handoversCash).toBe("0.00"); // ليس تسليم إغلاق
    expect(line.expected).toBe("110000.00"); // 100000 + 50000 − 40000
    expect(line.counted).toBe("110000.00");
    expect(line.drift).toBe("0.00");
    // cashDrops جزءٌ من الخارج التشغيليّ (يُنقِص المتوقَّع)، لا يُطرَح من العدّ (النقد غادر قبله)
    expect(line.operatingOut).toBe("40000.00");
    expect(res.totals.cashDrops).toBe("40000.00");
  });
});
