import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { revertCatalogCostChange } from "../catalogAnomalies/revertCostChange";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "priceAnomalyLog",
  "financialPeriods",
  "branchStock",
  "productVariants",
  "products",
  "branches",
  "users",
];

const actor = { userId: 1, branchId: 1, role: "manager" as const };

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

async function seed(quantity: number): Promise<number> {
  await db().insert(s.branches).values({
    id: 1,
    name: "الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db().insert(s.users).values({
    id: 1,
    openId: "catalog-reverter",
    name: "مدير الكتالوج",
    role: "manager",
    loginMethod: "local",
    branchId: 1,
  });
  await db().insert(s.products).values({ id: 1, name: "قلم" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "PEN-1",
    costPrice: "100.00",
  });
  await db().insert(s.branchStock).values({
    variantId: 1,
    branchId: 1,
    quantity,
  });
  // Trigger priceAnomalyLog يلتقط 100 → 200 ويمنحنا سجلّاً صالحاً للاستعادة.
  await db()
    .update(s.productVariants)
    .set({ costPrice: "200.00" })
    .where(eq(s.productVariants.id, 1));
  const result = await db().execute(sql`
    SELECT id FROM priceAnomalyLog
    WHERE variantId = 1 AND oldValue = 100 AND newValue = 200
    ORDER BY id DESC LIMIT 1
  `);
  const rows = (result as unknown as [Array<{ id: number }>, unknown])[0];
  if (!rows[0]) throw new Error("priceAnomalyLog trigger did not create a test row");
  return Number(rows[0].id);
}

async function cost(): Promise<string> {
  const row = (
    await db()
      .select({ costPrice: s.productVariants.costPrice })
      .from(s.productVariants)
      .where(eq(s.productVariants.id, 1))
  )[0];
  return String(row.costPrice);
}

async function reverted(logId: number): Promise<number> {
  const result = await db().execute(sql`
    SELECT reverted FROM priceAnomalyLog WHERE id = ${logId}
  `);
  return Number(
    (result as unknown as [Array<{ reverted: number }>, unknown])[0][0]?.reverted ?? 0,
  );
}

beforeEach(async () => {
  await truncateTables(TABLES);
});

describe("catalogAnomalies.revertChange — لا منفذ جانبيّ لـcostPrice", () => {
  it("يرفض الاستعادة المباشرة عند وجود مخزون ويُرجع كل الآثار", async () => {
    const logId = await seed(10);

    await expect(revertCatalogCostChange(logId, actor)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(await cost()).toBe("200.00");
    expect(await reverted(logId)).toBe(0);
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(eq(s.auditLogs.action, "product.costChange")),
    ).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("يستعيد تكلفة صنف صفريّ الرصيد مع تدقيق قبل/بعد داخل المعاملة", async () => {
    const logId = await seed(0);

    await expect(revertCatalogCostChange(logId, { ...actor, ipAddress: "203.0.113.7" })).resolves.toEqual({ ok: true });

    expect(await cost()).toBe("100.00");
    expect(await reverted(logId)).toBe(1);
    const audits = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "catalogAnomaly.revertCostChange"));
    expect(audits).toHaveLength(1);
    expect((audits[0].oldValue as { costPrice: string }).costPrice).toBe("200.00");
    expect((audits[0].newValue as { costPrice: string }).costPrice).toBe("100.00");
    expect(audits[0].ipAddress).toBe("203.0.113.7");
  });

  it("يرفض سجلاً قديماً إن تغيّرت التكلفة بعده كي لا يطمس WAVG أحدث", async () => {
    const oldLogId = await seed(0);
    await db()
      .update(s.productVariants)
      .set({ costPrice: "250.00" })
      .where(eq(s.productVariants.id, 1));

    await expect(revertCatalogCostChange(oldLogId, actor)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await cost()).toBe("250.00");
    expect(await reverted(oldLogId)).toBe(0);
  });
});
