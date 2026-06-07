import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";

const actor = { userId: 1, branchId: 1 };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["accountingEntries", "receipts", "inventoryMovements", "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices", "productUnits", "productVariants", "products", "suppliers", "branches", "users"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }, { id: 2, name: "SALES", code: "SALES", type: "SALES" }]);
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "P-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
}
beforeEach(async () => { await reset(); await seed(); });

async function cost(): Promise<string> {
  const r = (await db().select({ c: s.productVariants.costPrice }).from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
  return String(r?.c);
}
async function receiveAt(qty: number, unitPrice: string) {
  const po = await createPurchaseOrder(
    { supplierId: 1, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId: 1, productUnitId: 1, quantity: String(qty), unitPrice }] },
    actor,
  );
  const item = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
  await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: qty }] }, actor);
}

describe("WAVG — المتوسّط المرجّح للتكلفة (من الآن فصاعداً)", () => {
  it("أول استلام (بلا مخزون قائم) ⇒ التكلفة = تكلفة الشراء", async () => {
    await receiveAt(100, "5.00");
    expect(await cost()).toBe("5.00");
  });

  it("استلام ثانٍ بكمية مساوية ⇒ متوسّط بسيط", async () => {
    await receiveAt(100, "5.00"); // 100 @ 5
    await receiveAt(100, "7.00"); // +100 @ 7 ⇒ (500+700)/200 = 6.00
    expect(await cost()).toBe("6.00");
  });

  it("استلام ثالث بكمية مختلفة ⇒ ترجيح صحيح", async () => {
    await receiveAt(100, "5.00"); // 100 @ 5
    await receiveAt(100, "7.00"); // ⇒ 200 @ 6.00
    await receiveAt(100, "9.00"); // (1200+900)/300 = 7.00
    expect(await cost()).toBe("7.00");
  });

  it("ترجيح بكميات غير متساوية", async () => {
    await receiveAt(300, "10.00"); // 300 @ 10
    await receiveAt(100, "2.00");  // (3000+200)/400 = 8.00
    expect(await cost()).toBe("8.00");
  });

  it("لا انحراف تقريب على قيم تنتج كسوراً (round2 HALF_UP)", async () => {
    await receiveAt(3, "10.00");  // 3 @ 10
    await receiveAt(1, "1.00");   // (30+1)/4 = 7.75
    expect(await cost()).toBe("7.75");
  });
});
