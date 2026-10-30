import { beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as s from "../../../drizzle/schema";
import * as database from "../../db";
import * as productGuards from "../catalog/productUpdateGuards";
import * as stockLock from "../inventory/stockLock";
import { cancelExpense, createExpense } from "../expenseService";
import { updateProductWithVariants } from "../productEditService";

const actor = { userId: 1, branchId: 1, role: "admin" as const };

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          8_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? errorCode(error.cause) : undefined;
}

beforeEach(async () => {
  const db = database.getDb()!;
  await db
    .insert(s.branches)
    .values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await db
    .insert(s.users)
    .values({
      id: 1,
      openId: "expense-lock-order",
      name: "Admin",
      role: "admin",
      branchId: 1,
    });
  await db.insert(s.products).values([
    { id: 1, name: "A" },
    { id: 2, name: "B" },
  ]);
  await db
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "A", costPrice: "1000" });
  await db
    .insert(s.productUnits)
    .values({
      id: 1,
      variantId: 1,
      unitName: "Unit",
      conversionFactor: "1",
      isBaseUnit: true,
    });
  await db
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 10 });
});

async function stockExpense() {
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

it("ordinary product edit and actual expense cancellation complete in product-before-variant order", async () => {
  const db = database.getDb()!;
  const { expenseId } = await stockExpense();
  const editorHasProduct = barrier();
  const allowEditorVariant = barrier();
  const cancelRequestsProduct = barrier();
  // A dedicated one-connection pool bounds the actual cancellation's lock wait.
  const cancelPool = mysql.createPool({
    uri: process.env.DATABASE_URL!,
    connectionLimit: 1,
    connectTimeout: 3_000,
    timezone: "Z",
  });
  const cancelQueries: string[] = [];
  const cancelDb = drizzle(cancelPool, {
    schema: s,
    mode: "default",
    logger: {
      logQuery(query) {
        cancelQueries.push(query);
        if (
          /^select /i.test(query) &&
          query.includes("`products`") &&
          /for share\b/i.test(query)
        ) {
          cancelRequestsProduct.release();
        }
      },
    },
  });
  const originalLoad = productGuards.loadProductForUpdateOrThrow;
  const editorSpy = vi
    .spyOn(productGuards, "loadProductForUpdateOrThrow")
    .mockImplementationOnce(async (tx, productId) => {
      await tx.execute(sql`SET SESSION innodb_lock_wait_timeout = 4`);
      const product = await originalLoad(tx, productId);
      editorHasProduct.release();
      await bounded(
        allowEditorVariant.promise,
        "release editor after cancellation requests product",
      );
      return product;
    });
  let restoreDb = () => {};
  const tasks: Promise<unknown>[] = [];
  try {
    await cancelPool.query("SET SESSION innodb_lock_wait_timeout = 4");
    // This is the real editor, including its product -> unit -> variant guards.
    const edit = updateProductWithVariants(
      {
        productId: 1,
        name: "A edited",
        unitTemplate: [
          {
            unitName: "Unit",
            conversionFactor: "1",
            isBaseUnit: true,
            prices: [],
          },
        ],
        variants: [{ id: 1, sku: "A", costPrice: "1000", unitBarcodes: {} }],
      },
      actor,
    );
    tasks.push(edit);
    // Attach rejection handlers immediately, including on the expected red run.
    const editResult = Promise.allSettled([edit]);
    await bounded(editorHasProduct.promise, "editor product lock");
    const dbSpy = vi.spyOn(database, "getDb").mockReturnValue(cancelDb);
    restoreDb = () => dbSpy.mockRestore();
    const cancel = cancelExpense(expenseId, actor);
    tasks.push(cancel);
    const cancelResult = Promise.allSettled([cancel]);
    await bounded(
      cancelRequestsProduct.promise,
      "cancellation product shared-lock request",
    );
    allowEditorVariant.release();
    const results = (
      await bounded(
        Promise.all([editResult, cancelResult]),
        "both transactions settle",
      )
    ).flat();
    const outcomes = results.map((result) =>
      result.status === "fulfilled"
        ? "fulfilled"
        : `rejected:${errorCode(result.reason) ?? String(result.reason)}`,
    );
    console.info("editor/cancel barrier outcomes", outcomes);
    expect(outcomes).toEqual(["fulfilled", "fulfilled"]);
    // Product locks must name products only; a join can acquire a variant first.
    const firstProductLock = cancelQueries.find(
      (query) => query.includes("`products`") && /for share\b/i.test(query),
    );
    expect(firstProductLock).not.toContain("`productVariants`");
    expect(
      (await db.select().from(s.products).where(eq(s.products.id, 1)))[0].name,
    ).toBe("A edited");
    expect((await db.select().from(s.expenses))[0].status).toBe("CANCELLED");
    expect((await db.select().from(s.branchStock))[0].quantity).toBe(10);
    expect((await db.select().from(s.productVariants))[0].costPrice).toBe(
      "1000.00",
    );
    expect(
      (await db.select().from(s.inventoryMovements)).filter(
        (row) => row.referenceType === "EXPENSE_CANCEL",
      ),
    ).toHaveLength(1);
    expect(
      (await db.select().from(s.accountingEntries)).map((row) => row.amount),
    ).toEqual(["5000.00", "-5000.00"]);
  } finally {
    allowEditorVariant.release();
    try {
      await bounded(Promise.allSettled(tasks), "transaction cleanup");
    } finally {
      restoreDb();
      editorSpy.mockRestore();
      await cancelPool.end();
    }
  }
}, 25_000);

it("rejects a changed variant-to-product identity before any restoration without expanding product locks", async () => {
  const db = database.getDb()!;
  const { expenseId } = await stockExpense();
  const originalLock = stockLock.lockInventoryVariants;
  // Simulate an out-of-band identity change after discovery, before the mutex.
  // Legal product edits preserve historical identity; cancellation must fail closed even here.
  const mutexSpy = vi
    .spyOn(stockLock, "lockInventoryVariants")
    .mockImplementationOnce(async (tx, variantIds) => {
      await db
        .update(s.productVariants)
        .set({ productId: 2 })
        .where(eq(s.productVariants.id, 1));
      return originalLock(tx, variantIds);
    });
  try {
    await expect(cancelExpense(expenseId, actor)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await db.select().from(s.expenses))[0].status).toBe("ACTIVE");
    expect((await db.select().from(s.branchStock))[0].quantity).toBe(5);
    expect((await db.select().from(s.productVariants))[0].costPrice).toBe(
      "1000.00",
    );
    expect(
      (await db.select().from(s.inventoryMovements)).filter(
        (row) => row.referenceType === "EXPENSE_CANCEL",
      ),
    ).toHaveLength(0);
    expect(await db.select().from(s.accountingEntries)).toHaveLength(1);
  } finally {
    mutexSpy.mockRestore();
  }
});
