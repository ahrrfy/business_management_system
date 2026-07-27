/**
 * إعادة تقييم المخزون عند تعديل التكلفة يدوياً (تدقيق ٢٧/٧ — H3).
 *
 * الثابت المحاسبيّ: أصل المخزون في الميزانية = SUM(qty × costPrice) حيّاً، وحقوق الملكية مشتقّة
 * (أصول − خصوم). فتعديل التكلفة يُحرّك الحقوق بمقدار Δ×كمية، ويجب أن يُفسَّر بسطرٍ في قائمة الدخل
 * (قيد ADJUST/REVAL في profit) وإلا انفصلت القائمتان بلا أثر.
 */
import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { updateProduct } from "../catalog/productUpdate";
import { postCostRevaluation } from "../costRevaluation";
import { plSnapshot } from "../reportsFinancialService";
import { truncateTables } from "./__testUtils__";
import { withTx } from "../tx";

const TABLES = [
  "accountingEntries",
  "productPrices",
  "productUnits",
  "branchStock",
  "productVariants",
  "products",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const actor = { userId: 1, branchId: 1, role: "manager" } as const;

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "u1", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "قلم" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 10 }]);
}

async function revalEntries() {
  return db()
    .select()
    .from(s.accountingEntries)
    .where(and(eq(s.accountingEntries.entryType, "ADJUST"), like(s.accountingEntries.dedupeKey, "REVAL:%")));
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("postCostRevaluation — قيد إعادة تقييم عند تغيّر التكلفة", () => {
  it("ارتفاع التكلفة على رصيدٍ قائم ⇒ قيد مكسب = Δ×كمية", async () => {
    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "150.00", actor));
    const rows = await revalEntries();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].profit)).toBe("500.00"); // (150−100)×10
    expect(Number(rows[0].branchId)).toBe(1);
    expect(String(rows[0].dedupeKey)).toMatch(/^REVAL:1:1:/);
    // revenue/cost صفر — إعادة التقييم أثرٌ في الربح فقط، لا إيراد/تكلفة بيع.
    expect(String(rows[0].revenue)).toBe("0.00");
    expect(String(rows[0].cost)).toBe("0.00");
  });

  it("انخفاض التكلفة ⇒ قيد خسارة (profit سالب)", async () => {
    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "70.00", actor));
    const rows = await revalEntries();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].profit)).toBe("-300.00"); // (70−100)×10
  });

  it("لا فرق في التكلفة ⇒ لا قيد", async () => {
    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "100.00", actor));
    expect(await revalEntries()).toHaveLength(0);
  });

  it("رصيد صفر ⇒ لا قيد (لا أثر ميزانيّ)", async () => {
    await db().update(s.branchStock).set({ quantity: 0 }).where(eq(s.branchStock.variantId, 1));
    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "200.00", actor));
    expect(await revalEntries()).toHaveLength(0);
  });

  it("رصيدٌ في فرعين ⇒ قيدٌ لكلّ فرعٍ بكميّته", async () => {
    await db().insert(s.branchStock).values([{ variantId: 1, branchId: 2, quantity: 5 }]);
    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "120.00", actor)); // Δ=20
    const rows = await revalEntries();
    expect(rows).toHaveLength(2);
    const byBranch = new Map(rows.map((r) => [Number(r.branchId), String(r.profit)]));
    expect(byBranch.get(1)).toBe("200.00"); // 20×10
    expect(byBranch.get(2)).toBe("100.00"); // 20×5
  });

  it("idempotent طبيعياً: إعادة النداء بالتكلفة الجديدة نفسها ⇒ Δ=0 ⇒ لا قيد إضافيّ", async () => {
    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "150.00", actor));
    await withTx((tx) => postCostRevaluation(tx, 1, "150.00", "150.00", actor));
    expect(await revalEntries()).toHaveLength(1);
  });
});

describe("plSnapshot — إعادة التقييم تظهر في قائمة الدخل (لا تختفي من الربح)", () => {
  it("مكسب إعادة تقييم يرفع صافي الربح بسطرٍ INVENTORY_REVALUATION", async () => {
    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "150.00", actor)); // +500
    const pl = await plSnapshot("2020-01-01", "2099-12-31");
    const line = pl.expenseLines.find((l) => l.key === "INVENTORY_REVALUATION");
    expect(line).toBeDefined();
    expect(String(line!.amount)).toBe("-500.00"); // مصروف سالب = مكسب
    expect(String(pl.netProfit)).toBe("500.00"); // بلا مبيعات: صافي الربح = مكسب إعادة التقييم
  });

  it("خسارة إعادة تقييم تخفض صافي الربح", async () => {
    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "60.00", actor)); // −400
    const pl = await plSnapshot("2020-01-01", "2099-12-31");
    expect(String(pl.netProfit)).toBe("-400.00");
  });
});

describe("hook — updateProduct يُصدر قيد إعادة تقييم عند تغيّر التكلفة", () => {
  beforeEach(async () => {
    await db().insert(s.productUnits).values([
      { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    ]);
    await db().insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "250.00" }]);
  });

  it("تعديل تكلفة المتغيّر عبر updateProduct ⇒ قيد REVAL بالفرق×الرصيد", async () => {
    await updateProduct(
      {
        productId: 1,
        name: "قلم",
        variants: [
          {
            id: 1,
            sku: "PEN-1",
            costPrice: "130.00", // كانت 100 ⇒ Δ=30
            units: [
              { id: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "250.00" }] },
            ],
          },
        ],
      },
      actor,
    );
    const rows = await revalEntries();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].profit)).toBe("300.00"); // 30×10
    // التكلفة المخزَّنة صارت الجديدة.
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(String(v.costPrice)).toBe("130.00");
  });
});
