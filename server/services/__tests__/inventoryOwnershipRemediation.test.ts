import { beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createExpense, cancelExpense } from "../expenseService";
import { applyValuedInboundMovement } from "../inventoryService";
import { listBackorderShortfall } from "../inventory/backorderShortfall";
import { withTx } from "../tx";
import * as ledger from "../ledgerService";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const db = () => getDb()!;
beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS=0`);
  for (const table of [
    "accountingEntries",
    "expenseStockItems",
    "expenses",
    "receipts",
    "inventoryMovements",
    "branchStock",
    "purchaseOrderItems",
    "purchaseOrders",
    "productUnits",
    "productVariants",
    "products",
    "suppliers",
    "users",
    "branches",
    "auditLogs",
    "idempotencyKeys",
  ])
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS=1`);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
      { id: 2, name: "Other", code: "OTHER", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values({
      id: 1,
      openId: "inventory-remediation",
      name: "Admin",
      role: "admin",
      branchId: 1,
    });
  await db().insert(s.suppliers).values({ id: 1, name: "Supplier" });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "A", allowBackorder: true },
      { id: 2, name: "B", allowBackorder: true },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "A", costPrice: "1000" },
      { id: 2, productId: 2, sku: "B", costPrice: "1000" },
    ]);
  await db()
    .insert(s.productUnits)
    .values(
      [1, 2].map((id) => ({
        id,
        variantId: id,
        unitName: "Unit",
        conversionFactor: "1",
        isBaseUnit: true,
      })),
    );
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 10 });
});

async function expense() {
  return createExpense(
    {
      branchId: 1,
      category: "SUPPLIES",
      amount: "0",
      paymentMethod: "CASH",
      source: "STOCK",
      stockReason: "INTERNAL_USE",
      items: [{ variantId: 1, baseQuantity: 5 }],
    },
    actor,
  );
}
async function inbound() {
  await withTx((tx) =>
    applyValuedInboundMovement(tx, {
      variantId: 1,
      branchId: 1,
      baseQuantity: 10,
      historicalValue: "25000",
      referenceType: "TEST_IN",
      referenceId: 1,
      createdBy: 1,
    }),
  );
}
it("A03 returns saved expense value after WAVG drift, with no second reversal", async () => {
  const result = await expense();
  await inbound();
  await cancelExpense(result.expenseId, actor);
  expect(
    (
      await db()
        .select()
        .from(s.productVariants)
        .where(eq(s.productVariants.id, 1))
    )[0].costPrice,
  ).toBe("1750.00");
  expect((await db().select().from(s.branchStock))[0].quantity).toBe(20);
  await expect(cancelExpense(result.expenseId, actor)).rejects.toThrow();
  expect(
    (await db().select().from(s.inventoryMovements)).filter(
      (r) => r.referenceType === "EXPENSE_CANCEL",
    ),
  ).toHaveLength(1);
  expect(
    (await db().select().from(s.accountingEntries)).map((r) => r.amount),
  ).toEqual(["5000.00", "-5000.00"]);
});
it("A09 caps aggregated PO coverage per variant and branch across pages", async () => {
  await db().update(s.branchStock).set({ quantity: -10 });
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 2, branchId: 1, quantity: -10 },
      { variantId: 2, branchId: 2, quantity: -7 },
    ]);
  for (const id of [1, 2, 3]) {
    await db()
      .insert(s.purchaseOrders)
      .values({
        id,
        supplierId: 1,
        branchId: id === 3 ? 2 : 1,
        status: "DRAFT",
        poNumber: `PO-${id}`,
        subtotal: "0",
        total: "0",
        createdBy: 1,
      });
    await db()
      .insert(s.purchaseOrderItems)
      .values({
        purchaseOrderId: id,
        variantId: id === 3 ? 2 : 1,
        productUnitId: id === 3 ? 2 : 1,
        quantity: "10",
        baseQuantity: 10,
        unitPrice: "1000",
        total: "10000",
      });
  }
  const all = await listBackorderShortfall({ includeCost: true });
  expect(all.totalNetNeededBase).toBe(10);
  expect(all.rows.reduce((sum, row) => sum + row.netNeededBase, 0)).toBe(10);
  for (const offset of [0, 1, 99]) {
    const page = await listBackorderShortfall({
      branchId: 1,
      limit: 1,
      offset,
      includeCost: true,
    });
    expect(page.totalNetNeededBase).toBe(10);
    expect(page.total).toBe(2);
    expect(page.totalShortfallValue).toBe("20000.00");
  }
  expect(
    (await listBackorderShortfall({ branchId: 2 })).totalNetNeededBase,
  ).toBe(0);
});
it("A03 rolls back quantity, WAVG, status and reversal when posting fails", async () => {
  const result = await expense();
  await inbound();
  const fail = vi
    .spyOn(ledger, "postEntry")
    .mockRejectedValueOnce(new Error("injected reversal failure"));
  try {
    await expect(cancelExpense(result.expenseId, actor)).rejects.toThrow(
      "injected reversal failure",
    );
  } finally {
    fail.mockRestore();
  }
  expect(
    (
      await db()
        .select()
        .from(s.productVariants)
        .where(eq(s.productVariants.id, 1))
    )[0].costPrice,
  ).toBe("2000.00");
  expect((await db().select().from(s.branchStock))[0].quantity).toBe(15);
  expect((await db().select().from(s.expenses))[0].status).toBe("ACTIVE");
  expect(
    (await db().select().from(s.inventoryMovements)).filter(
      (r) => r.referenceType === "EXPENSE_CANCEL",
    ),
  ).toHaveLength(0);
  expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
});
it("A03 preserves consignment share instead of diluting it as owned WAVG", async () => {
  await db()
    .update(s.products)
    .set({ allowBackorder: false, isConsignment: true })
    .where(eq(s.products.id, 1));
  const result = await expense();
  await db()
    .update(s.productVariants)
    .set({ costPrice: "2000" })
    .where(eq(s.productVariants.id, 1));
  await cancelExpense(result.expenseId, actor);
  expect(
    (
      await db()
        .select()
        .from(s.productVariants)
        .where(eq(s.productVariants.id, 1))
    )[0].costPrice,
  ).toBe("2000.00");
  expect((await db().select().from(s.branchStock))[0].quantity).toBe(10);
});
