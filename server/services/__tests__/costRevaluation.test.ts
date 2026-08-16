import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { updateProduct } from "../catalog/productUpdate";
import { postCostRevaluation } from "../costRevaluation";
import { truncateTables } from "./__testUtils__";
import { withTx } from "../tx";

const TABLES = [
  "auditLogs",
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
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

const actor = { userId: 1, branchId: 1, role: "manager" } as const;

async function seed() {
  await db().insert(s.branches).values([
    { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
    { id: 2, name: "Sales", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "u1", name: "Manager", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.products).values([{ id: 1, name: "Pen" }]);
  await db().insert(s.productVariants).values([{ id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" }]);
  await db().insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 10 }]);
}

async function revaluationEntries() {
  return db()
    .select({ id: s.accountingEntries.id })
    .from(s.accountingEntries)
    .where(and(eq(s.accountingEntries.entryType, "ADJUST"), like(s.accountingEntries.dedupeKey, "REVAL:%")));
}

async function costAudits() {
  return db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "product.costChange"));
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("postCostRevaluation — classified accounting policy", () => {
  it.each([
    ["150.00", "upward"],
    ["70.00", "downward"],
  ])("rejects an unclassified %s manual revaluation while owned stock exists", async (newCost) => {
    await expect(
      withTx((tx) => postCostRevaluation(tx, 1, "100.00", newCost, actor, "free-text reason")),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(await revaluationEntries()).toHaveLength(0);
    expect(await costAudits()).toHaveLength(0);
  });

  it("rejects atomically when owned stock exists in more than one branch", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 2, quantity: 5 });

    await expect(
      withTx((tx) => postCostRevaluation(tx, 1, "100.00", "120.00", actor)),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(await revaluationEntries()).toHaveLength(0);
    expect(await costAudits()).toHaveLength(0);
  });

  it("does nothing when cost did not change", async () => {
    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "100.00", actor));
    expect(await revaluationEntries()).toHaveLength(0);
    expect(await costAudits()).toHaveLength(0);
  });

  it("allows and audits a cost edit when the owned item has zero stock", async () => {
    await db().update(s.branchStock).set({ quantity: 0 }).where(eq(s.branchStock.variantId, 1));

    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "200.00", actor, "catalog correction"));

    expect(await revaluationEntries()).toHaveLength(0);
    const audits = await costAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].entityType).toBe("productVariant");
    expect(audits[0].entityId).toBe("1");
    expect(Number(audits[0].userId)).toBe(1);
    expect(Number(audits[0].branchId)).toBe(1);
    expect((audits[0].oldValue as { costPrice: string }).costPrice).toBe("100.00");
    expect((audits[0].newValue as { costPrice: string; reason: string | null }).costPrice).toBe("200.00");
    expect((audits[0].newValue as { reason: string | null }).reason).toBe("catalog correction");
  });

  it("audits a consignment share edit without recognizing an owned-inventory gain or loss", async () => {
    await db().update(s.products).set({ isConsignment: true }).where(eq(s.products.id, 1));

    await withTx((tx) => postCostRevaluation(tx, 1, "100.00", "160.00", actor, "consignor agreement"));

    expect(await revaluationEntries()).toHaveLength(0);
    expect(await costAudits()).toHaveLength(1);
  });
});

describe("updateProduct cost-change hook", () => {
  beforeEach(async () => {
    await db().insert(s.productUnits).values([
      { id: 1, variantId: 1, unitName: "Piece", conversionFactor: "1", isBaseUnit: true },
    ]);
    await db().insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "250.00" }]);
  });

  it("rolls back an unclassified cost edit while owned stock exists", async () => {
    await expect(
      updateProduct(
        {
          productId: 1,
          name: "Pen",
          variants: [
            {
              id: 1,
              sku: "PEN-1",
              costPrice: "130.00",
              units: [
                { id: 1, unitName: "Piece", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "250.00" }] },
              ],
            },
          ],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const variant = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(String(variant.costPrice)).toBe("100.00");
    expect(await revaluationEntries()).toHaveLength(0);
    expect(await costAudits()).toHaveLength(0);
  });
});
