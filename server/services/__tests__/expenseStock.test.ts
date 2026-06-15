// اختبارات «صرف من المخزون» ضمن المصاريف: نثرية (INTERNAL_USE) وتلف (WASTAGE).
// يُخصَم بالكلفة + قيد محاسبي بلا نقد/receipt؛ CASH يبقى كما هو؛ الإلغاء يعيد المخزون + قيد معكوس.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelExpense, createExpense } from "../expenseService";
import { sumMoney } from "../money";

const actor = { userId: 1, branchId: 1 };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

const TABLES = [
  "accountingEntries", "expenseStockItems", "expenses", "receipts",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "branches", "users", "idempotencyKeys",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN", isActive: true });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values([{ id: 1, name: "رول حراري" }, { id: 2, name: "قلم" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "ROLL", costPrice: "2.50" },
    { id: 2, productId: 2, sku: "PEN", costPrice: "1.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 50 },
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

async function stock(variantId: number): Promise<number> {
  const r = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock)
    .where(sql`${s.branchStock.variantId} = ${variantId} AND ${s.branchStock.branchId} = 1`))[0];
  return Number(r?.q ?? 0);
}
async function entries(type?: string) {
  const rows = await db().select().from(s.accountingEntries);
  return type ? rows.filter((e: any) => e.entryType === type) : rows;
}

describe("صرف المخزون: النثرية (INTERNAL_USE)", () => {
  it("تخصم المخزون وتقيّد مصروفاً بالكلفة بلا receipt/صندوق", async () => {
    const r = await createExpense({
      branchId: 1, category: "SUPPLIES", amount: "0", paymentMethod: "CASH",
      source: "STOCK", stockReason: "INTERNAL_USE",
      items: [{ variantId: 1, baseQuantity: 2 }],
    }, actor);
    expect(await stock(1)).toBe(98);
    const exp = (await db().select().from(s.expenses).where(eq(s.expenses.id, (r as any).expenseId)))[0];
    expect(exp.amount).toBe("5.00"); // 2 × 2.50
    expect(exp.source).toBe("STOCK");
    expect(exp.receiptId).toBeNull();
    // لا أي receipt (لا نقد).
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    const iu = await entries("INTERNAL_USE");
    expect(iu).toHaveLength(1);
    expect(iu[0].cost).toBe("5.00");
    expect(iu[0].amount).toBe("5.00");
    expect(iu[0].revenue).toBe("0.00");
    expect(iu[0].profit).toBe("-5.00");
    expect(iu[0].dedupeKey).toBe(`INTERNAL_USE:${(r as any).expenseId}`);
  });

  it("amount = مجموع كلفة الأصناف (متعدّد)", async () => {
    const r = await createExpense({
      branchId: 1, category: "SUPPLIES", amount: "0", paymentMethod: "CASH",
      source: "STOCK", stockReason: "INTERNAL_USE",
      items: [{ variantId: 1, baseQuantity: 2 }, { variantId: 2, baseQuantity: 3 }], // 5.00 + 3.00
    }, actor);
    const exp = (await db().select().from(s.expenses).where(eq(s.expenses.id, (r as any).expenseId)))[0];
    expect(exp.amount).toBe("8.00");
    expect(await stock(2)).toBe(47);
  });
});

describe("صرف المخزون: التلف (WASTAGE)", () => {
  it("يقيّد خسارةً بالكلفة (WASTAGE)", async () => {
    await createExpense({
      branchId: 1, category: "OTHER", amount: "0", paymentMethod: "CASH",
      source: "STOCK", stockReason: "WASTAGE", description: "انحشار",
      items: [{ variantId: 1, baseQuantity: 4 }],
    }, actor);
    expect(await stock(1)).toBe(96);
    const w = await entries("WASTAGE");
    expect(w).toHaveLength(1);
    expect(w[0].cost).toBe("10.00"); // 4 × 2.50
    expect(w[0].profit).toBe("-10.00");
  });
});

describe("صرف المخزون: الذرّية و CASH", () => {
  it("نقص مخزون ⇒ ROLLBACK (لا مصروف/حركة/قيد)", async () => {
    await expect(createExpense({
      branchId: 1, category: "SUPPLIES", amount: "0", paymentMethod: "CASH",
      source: "STOCK", stockReason: "INTERNAL_USE",
      items: [{ variantId: 1, baseQuantity: 1000 }],
    }, actor)).rejects.toThrow();
    expect(await stock(1)).toBe(100);
    expect(await db().select().from(s.expenses)).toHaveLength(0);
    expect(await entries()).toHaveLength(0);
  });

  it("المصروف النقدي (CASH) يبقى كما هو: receipt OUT + PAYMENT_OUT بلا لمس المخزون", async () => {
    await createExpense({
      branchId: 1, category: "RENT", amount: "100", paymentMethod: "CASH",
    }, actor);
    expect(await stock(1)).toBe(100); // لا تأثير على المخزون
    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].direction).toBe("OUT");
    const po = await entries("PAYMENT_OUT");
    expect(po).toHaveLength(1);
    expect(await db().select().from(s.expenseStockItems)).toHaveLength(0);
  });
});

describe("صرف المخزون: الإلغاء", () => {
  it("إلغاء النثرية يعيد المخزون ويعكس القيد (صافي 0)", async () => {
    const r = await createExpense({
      branchId: 1, category: "SUPPLIES", amount: "0", paymentMethod: "CASH",
      source: "STOCK", stockReason: "INTERNAL_USE",
      items: [{ variantId: 1, baseQuantity: 4 }],
    }, actor);
    expect(await stock(1)).toBe(96);
    await cancelExpense((r as any).expenseId, actor);
    expect(await stock(1)).toBe(100); // عاد
    const exp = (await db().select().from(s.expenses).where(eq(s.expenses.id, (r as any).expenseId)))[0];
    expect(exp.status).toBe("CANCELLED");
    // قيدان INTERNAL_USE (تقدّم + عكس) صافي amount = 0.
    const iu = await entries("INTERNAL_USE");
    expect(iu).toHaveLength(2);
    // المجموع على decimal أصيل (لا floats) — يجب أن يكون صفراً بالضبط لا «قريباً منه».
    expect(sumMoney(iu.map((e: any) => e.amount)).isZero()).toBe(true);
    // الإلغاء لا ينشئ أي receipt (لا نقد).
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });
});
