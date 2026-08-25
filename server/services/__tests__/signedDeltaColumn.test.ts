/**
 * P1-#3-أ: عمود `signedDelta` على `inventoryMovements` (تقرير المراجعة ٢٥/٨).
 *
 * قبل الإصلاح: `applyMovement` يكتب `quantity` مطلقة، و`setStock` يكتب `Math.abs(delta)` — الاتجاه
 * يُستخرَج من `movementType` أو من وسم «(فرق ±D)» في notes. إعادةُ بناء الرصيد من الحركات
 * تتطلّب Parsing نصّيّاً (JS) لا SQL خاماً ⇒ يُغلق باب تقرير المطابقة (`opening + Σ signed = closing`).
 *
 * الإصلاح: عمودٌ int nullable يُعبَّأ على كل كتابة. Backfill 0265 يُعبّئ الصفوف القائمة.
 * `signedMoveQty` يفضّله ويبقى fallback نصّياً للـ NULL.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { applyMovement, setStock, signedMoveQty } from "../inventoryService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "inventoryMovements",
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

async function seed() {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values({
    id: 1,
    openId: "u-admin",
    name: "أدمن",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await db().insert(s.products).values({ id: 1, name: "قلم" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" });
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
}

async function readLastMovement() {
  const r = await db()
    .select()
    .from(s.inventoryMovements)
    .orderBy(sql`${s.inventoryMovements.id} DESC`)
    .limit(1);
  return r[0];
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("signedDelta writes (P1-#3-أ)", () => {
  it("applyMovement IN ⇒ signedDelta = +qty", async () => {
    await withTx((tx) =>
      applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        movementType: "IN",
        baseQuantity: 5,
        referenceType: "TEST",
        createdBy: 1,
      }),
    );
    const m = await readLastMovement();
    expect(m.movementType).toBe("IN");
    expect(m.quantity).toBe(5);
    expect(m.signedDelta).toBe(5);
  });

  it("applyMovement OUT ⇒ signedDelta = -qty", async () => {
    await withTx((tx) =>
      applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        movementType: "OUT",
        baseQuantity: 3,
        referenceType: "TEST",
        createdBy: 1,
      }),
    );
    const m = await readLastMovement();
    expect(m.movementType).toBe("OUT");
    expect(m.quantity).toBe(3);
    expect(m.signedDelta).toBe(-3);
  });

  it("setStock رفع الرصيد (10→15) ⇒ ADJUST بـsignedDelta=+5 وquantity=5", async () => {
    await withTx((tx) =>
      setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 15, createdBy: 1 }),
    );
    const m = await readLastMovement();
    expect(m.movementType).toBe("ADJUST");
    expect(m.quantity).toBe(5);
    expect(m.signedDelta).toBe(5);
    // النصّ لا يزال يحمل «(فرق +5)» — التوافق البصريّ محفوظ.
    expect(m.notes ?? "").toMatch(/فرق\s*\+?5\)/);
  });

  it("setStock خفض الرصيد (10→7) ⇒ ADJUST بـsignedDelta=-3 وquantity=3", async () => {
    await withTx((tx) =>
      setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 7, createdBy: 1 }),
    );
    const m = await readLastMovement();
    expect(m.movementType).toBe("ADJUST");
    expect(m.quantity).toBe(3);
    expect(m.signedDelta).toBe(-3);
    expect(m.notes ?? "").toMatch(/فرق\s*-3\)/);
  });

  it("signedMoveQty يفضّل signedDelta عند توفّره — لا اعتماد على النصّ", async () => {
    // نموذجُ صفٍّ ADJUST بلا وسم نصّيّ (كسر مستقبليّ للـpattern)، لكنّ signedDelta محفوظ.
    expect(signedMoveQty("ADJUST", 5, null, -5)).toBe(-5);
    expect(signedMoveQty("ADJUST", 5, "بلا وسم", 3)).toBe(3);
  });

  it("signedMoveQty يسقط إلى fallback عند غياب signedDelta", async () => {
    // صفٌّ قديم قبل الهجرة — signedDelta = null. fallback يعمل بلا انحدار.
    expect(signedMoveQty("IN", 4, null, null)).toBe(4);
    expect(signedMoveQty("OUT", 4, null)).toBe(-4);
    expect(signedMoveQty("ADJUST", 3, "تسوية (فرق -3)")).toBe(-3);
    expect(signedMoveQty("ADJUST", 3, "بلا وسم")).toBe(0);
  });

  it("مجموع signedDelta لكل حركات المتغيّر = الرصيد الحاليّ (يُثبت جدوى تقرير المطابقة القادم)", async () => {
    // نبدأ بـ10، نُخرج 3 بـOUT، ثمّ نُدخل 5 بـIN، ثمّ نضبط إلى 20 بـsetStock.
    await withTx((tx) => applyMovement(tx, {
      variantId: 1, branchId: 1, movementType: "OUT", baseQuantity: 3, referenceType: "TEST", createdBy: 1,
    }));
    await withTx((tx) => applyMovement(tx, {
      variantId: 1, branchId: 1, movementType: "IN", baseQuantity: 5, referenceType: "TEST", createdBy: 1,
    }));
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 20, createdBy: 1 }));
    const stockRow = (await db()
      .select({ q: s.branchStock.quantity })
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)))
      .limit(1))[0];
    const sumRow = (await db().execute(sql`
      SELECT COALESCE(SUM(signedDelta), 0) AS s FROM inventoryMovements WHERE variantId = 1 AND branchId = 1
    `))[0] as unknown as Array<{ s: string | number }>;
    const summed = Number(sumRow[0]?.s ?? 0);
    // الرصيد الابتدائيّ 10 (من seed) + الحركات (-3 +5 +8) = 20؛ مجموع signedDelta = -3+5+8 = 10.
    // ⇒ opening (10) + Σ signed (10) = closing (20). الأساس البنيويّ لتقرير المطابقة (البند ٧).
    expect(summed).toBe(10);
    expect(Number(stockRow?.q ?? 0)).toBe(20);
  });
});
