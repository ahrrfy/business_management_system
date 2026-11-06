import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { updateProductWithVariants, type UpdateProductVariantsInput } from "../productEditService";
import { withTx } from "../tx";

const db = () => getDb()!;
const actor = { userId: 1, branchId: 1, role: "admin" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}

beforeEach(async () => {
  await db().insert(s.branches).values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "recipe-concurrency", name: "Admin", role: "admin", branchId: 1 });
  await db().insert(s.products).values([{ id: 1, name: "Original service", isService: true, productType: "PRINT_SERVICE" }, { id: 2, name: "Material" }]);
  await db().insert(s.productVariants).values([{ id: 1, productId: 1, sku: "SERVICE", costPrice: "0" }, { id: 2, productId: 2, sku: "MATERIAL", costPrice: "10" }]);
  await db().insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "service", conversionFactor: "1", isBaseUnit: true }, { id: 2, variantId: 2, unitName: "m", conversionFactor: "1", isBaseUnit: true }]);
  await db().insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "100.00" });
});

function change(): UpdateProductVariantsInput {
  return {
    productId: 1, name: "Saved B", isService: true, productType: "PRINT_SERVICE",
    unitTemplate: [{ unitName: "service", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "200.00" }] }],
    variants: [{ id: 1, sku: "SERVICE", costPrice: "0", unitBarcodes: {} }],
    recipeChange: { recipeId: null, expectedFingerprint: "NONE", name: "Service materials", outputVariantId: 1, outputProductUnitId: 1, lines: [{ inputVariantId: 2, qtyPerOutputBase: "1.5" }] },
  };
}

async function waitUntilBlockedBy(connectionId: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await db().execute(sql`SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.BLOCKING_THREAD_ID WHERE t.PROCESSLIST_ID=${connectionId}`);
    const rows = result[0] as unknown as Array<{ waiting: number }>;
    if (Number(rows[0].waiting) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Composite save never reached the expected product lock wait");
}

describe("compound recipe editor lock waits", () => {
  it("captures the committed product and prices after waiting for another editor", async () => {
    const locked = deferred<number>();
    const release = deferred<void>();
    const first = withTx(async (tx) => {
      const result = await tx.execute(sql`SELECT CONNECTION_ID() AS connectionId`);
      await tx.select().from(s.products).where(eq(s.products.id, 1)).for("update");
      await tx.update(s.products).set({ name: "Committed A" }).where(eq(s.products.id, 1));
      await tx.update(s.productPrices).set({ price: "150.00" }).where(eq(s.productPrices.productUnitId, 1));
      locked.resolve(Number((result[0] as unknown as Array<{ connectionId: number }>)[0].connectionId));
      await release.promise;
    });
    const connectionId = await locked.promise;
    const second = updateProductWithVariants(change(), actor);
    // Attach immediately so a failed assertion cannot leave a rejected promise unobserved.
    const settledSecond = second.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitUntilBlockedBy(connectionId);
    } finally { release.resolve(); }
    await first;
    const result = await settledSecond;
    if ("error" in result) throw result.error;
    const [version] = await db().select().from(s.recordVersions).where(eq(s.recordVersions.entityId, 1));
    expect(JSON.stringify(version.payloadJson)).toContain("Committed A");
    expect(JSON.stringify(version.payloadJson)).toContain("150.00");
    expect((await db().select().from(s.products).where(eq(s.products.id, 1)))[0].name).toBe("Saved B");
  });

  it("sees an invoice committed during its lock wait and rejects reclassification", async () => {
    const locked = deferred<number>();
    const release = deferred<void>();
    const first = withTx(async (tx) => {
      const result = await tx.execute(sql`SELECT CONNECTION_ID() AS connectionId`);
      await tx.select().from(s.products).where(eq(s.products.id, 1)).for("update");
      await tx.insert(s.invoices).values({ id: 1, invoiceNumber: "CONCURRENT-INVOICE", sourceType: "POS", branchId: 1, subtotal: "100", total: "100", status: "PAID" });
      await tx.insert(s.invoiceItems).values({ invoiceId: 1, variantId: 1, productUnitId: 1, quantity: "1", baseQuantity: 1, unitPrice: "100", unitCost: "0", total: "100" });
      locked.resolve(Number((result[0] as unknown as Array<{ connectionId: number }>)[0].connectionId));
      await release.promise;
    });
    const connectionId = await locked.promise;
    const second = updateProductWithVariants({ ...change(), isService: false, productType: "catalog-item" }, actor);
    const settledSecond = second.then(() => null, (error: unknown) => error);
    try { await waitUntilBlockedBy(connectionId); } finally { release.resolve(); }
    await first;
    expect(await settledSecond).toMatchObject({ code: "BAD_REQUEST" });
    expect((await db().select().from(s.products).where(eq(s.products.id, 1)))[0].isService).toBe(true);
    expect(await db().select().from(s.productionRecipes)).toHaveLength(0);
  });
});
