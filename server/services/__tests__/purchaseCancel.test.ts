// إلغاء أمر شراء — قلب حالة خالص: createPurchaseOrder لا يكتب قيداً/AP/مخزوناً/إيصالاً،
// فالإلغاء قبل أي استلام لا يحتاج عكساً مالياً. أمرٌ استُلم منه شيء ⇒ مرتجع شراء لا إلغاء.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelPurchaseOrder, createPurchaseOrder, receivePurchase } from "../purchaseService";

const actor = { userId: 1, branchId: 1 };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
    "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices",
    "productUnits", "productVariants", "products", "suppliers", "branches", "users",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "P-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
}

beforeEach(async () => {
  await reset();
  await seed();
});

async function makeConfirmedPO(qty = 10, unitPrice = "5.00"): Promise<{ purchaseOrderId: number; itemId: number }> {
  const po = await createPurchaseOrder(
    { supplierId: 1, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId: 1, productUnitId: 1, quantity: String(qty), unitPrice }] },
    actor,
  );
  const item = (
    await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId))
  )[0];
  return { purchaseOrderId: po.purchaseOrderId, itemId: Number(item.id) };
}

const countRows = async (table: any): Promise<number> => {
  const r = await db().select({ n: sql<number>`COUNT(*)` }).from(table);
  return Number(r[0]?.n ?? 0);
};

describe("إلغاء أمر شراء لم يُستلم", () => {
  it("CONFIRMED بلا استلام ⇒ CANCELLED، وصفر صفوف جديدة في الدفتر/الحركات/الإيصالات", async () => {
    const { purchaseOrderId } = await makeConfirmedPO();

    const res = await cancelPurchaseOrder(purchaseOrderId, actor);
    expect(res.status).toBe("CANCELLED");
    expect(res.purchaseOrderId).toBe(purchaseOrderId);

    const po = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, purchaseOrderId)))[0];
    expect(po.status).toBe("CANCELLED");

    // قلب حالة خالص — لا أثر مالي/مخزني.
    expect(await countRows(s.accountingEntries)).toBe(0);
    expect(await countRows(s.inventoryMovements)).toBe(0);
    expect(await countRows(s.receipts)).toBe(0);
    // AP لم يتحرّك.
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("0.00");
  });
});

describe("حواجز الإلغاء", () => {
  it("أمر استُلم منه جزئياً ⇒ الإلغاء يُرفض BAD_REQUEST", async () => {
    const { purchaseOrderId, itemId } = await makeConfirmedPO(10);
    await receivePurchase(
      { purchaseOrderId, lines: [{ purchaseOrderItemId: itemId, receivedBaseQuantity: 4 }] },
      actor,
    );
    await expect(cancelPurchaseOrder(purchaseOrderId, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // الحالة بقيت CONFIRMED (استلام جزئي).
    const po = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, purchaseOrderId)))[0];
    expect(po.status).toBe("CONFIRMED");
  });

  it("إلغاء مزدوج ⇒ الثاني يُرفض BAD_REQUEST", async () => {
    const { purchaseOrderId } = await makeConfirmedPO();
    await cancelPurchaseOrder(purchaseOrderId, actor);
    await expect(cancelPurchaseOrder(purchaseOrderId, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("أمر غير موجود ⇒ NOT_FOUND", async () => {
    await expect(cancelPurchaseOrder(99999, actor)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("استلام على أمر CANCELLED يبقى مرفوضاً (انحدار)", async () => {
    const { purchaseOrderId, itemId } = await makeConfirmedPO();
    await cancelPurchaseOrder(purchaseOrderId, actor);
    await expect(
      receivePurchase({ purchaseOrderId, lines: [{ purchaseOrderItemId: itemId, receivedBaseQuantity: 1 }] }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // لا أثر: لا حركة مخزون ولا قيد.
    expect(await countRows(s.inventoryMovements)).toBe(0);
    expect(await countRows(s.accountingEntries)).toBe(0);
  });
});
