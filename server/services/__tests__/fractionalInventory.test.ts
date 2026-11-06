import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { applyMovement, applyValuedInboundMovement, convertToBaseQuantity, setStock, signedMoveQty } from "../inventoryService";
import { withTx } from "../tx";

const db = () => getDb()!;
const movement = (baseQuantity: number) => ({ variantId: 1, branchId: 1, baseQuantity, movementType: "OUT" as const, createdBy: 1 });
const stock = async () => (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity;

beforeEach(async () => {
  await db().insert(s.branches).values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "fractional-inventory", role: "admin", branchId: 1 });
  await db().insert(s.products).values({ id: 1, name: "Material" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "FRACTION-MAT", costPrice: "10.00" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "m", isBaseUnit: true, conversionFactor: "1" });
  await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 10, referenceType: "OPENING", createdBy: 1 }));
});

describe("persisted fractional inventory", () => {
  it("writes exact fractional quantities and signed deltas through repeated movements", async () => {
    await withTx(async (tx) => {
      for (let index = 0; index < 10; index++) await applyMovement(tx, movement(0.1));
      await applyMovement(tx, movement(0.0001));
    });
    expect(await stock()).toBe(8.9999);
    const [row] = await db().select({ balance: sql<string>`SUM(${s.inventoryMovements.signedDelta})` }).from(s.inventoryMovements);
    expect(row.balance).toBe("8.9999");
  });

  it("rolls back all deductions when a later fractional deduction lacks stock", async () => {
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 0.4 }));
    const before = await db().select().from(s.inventoryMovements);
    await expect(withTx(async (tx) => {
      await applyMovement(tx, movement(0.3));
      await applyMovement(tx, movement(0.3));
    })).rejects.toThrow(/المخزون غير كاف/);
    expect(await stock()).toBe(0.4);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(before.length);
  });

  it("serializes concurrent fractional deductions without overselling", async () => {
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 1 }));
    const results = await Promise.allSettled([withTx((tx) => applyMovement(tx, movement(0.6))), withTx((tx) => applyMovement(tx, movement(0.6)))]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await stock()).toBe(0.4);
  });

  it("preserves fractional adjustment history including legacy note fallback", async () => {
    const result = await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 8.25 }));
    const [row] = await db().select().from(s.inventoryMovements).where(eq(s.inventoryMovements.id, result.movementId));
    expect(result.delta).toBe(-1.75);
    expect(row.quantity).toBe(1.75);
    expect(signedMoveQty(row.movementType, row.quantity, row.notes)).toBe(-1.75);
  });

  it("allows fractional conversion for materials while retaining final sale validation", async () => {
    await expect(withTx((tx) => convertToBaseQuantity(tx, 1, "0.5", 1))).rejects.toThrow(/ليس عدداً صحيحاً/);
    expect(await withTx((tx) => convertToBaseQuantity(tx, 1, "0.5", 1, { allowFractionalBase: true }))).toMatchObject({ baseQuantity: 0.5 });
  });

  it("restores historical fractional quantity and value with exact WAVG", async () => {
    await withTx((tx) => applyValuedInboundMovement(tx, { variantId: 1, branchId: 1, baseQuantity: 1.5, historicalValue: "30.00", createdBy: 1 }));
    expect(await stock()).toBe(11.5);
    expect((await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0].costPrice).toBe("11.30");
  });
});
