import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { reconcileCustomerBalances } from "../reconcileService";
import { getARAging } from "../reportsService";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}
const insertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

async function reset() {
  const d = db();
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "0" });
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("schema — عمود invoices.returnedTotal", () => {
  it("returnSale يُحدّث returnedTotal تراكمياً", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "ت", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "10" }] },
      actor,
    );
    const item = (await db().select().from(s.invoiceItems))[0];
    // مرتجع جزئي ١: ٣ قطع.
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 3 }] }, actor);
    let inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.returnedTotal).toBe("30.00");

    // مرتجع جزئي ٢: ٢ قطع إضافية.
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 2 }] }, actor);
    inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.returnedTotal).toBe("50.00");
  });
});

describe("AR aging — يستعمل returnedTotal (لا انحراف بعد مرتجع جزئي)", () => {
  it("getARAging يَطرح returnedTotal من المبلغ المتبقّي", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "10" }] },
      actor,
    );
    const item = (await db().select().from(s.invoiceItems))[0];
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 5 }] }, actor);

    const aging = await getARAging({});
    const row = aging.find((r) => Number(r.customerId) === 1);
    expect(row).toBeTruthy();
    // 100 − 0 − 50 = 50
    expect(row!.unpaidTotal).toBe("50.00");
    expect(row!.d0_30).toBe("50.00");
  });
});

describe("reconcileCustomerBalances — لا انحراف بعد مرتجع جزئي/دفع زائد", () => {
  it("مرتجع جزئي على فاتورة آجلة لا يُنتج انحرافاً (مع returnedTotal)", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "ت", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "10" }] },
      actor,
    );
    const item = (await db().select().from(s.invoiceItems))[0];
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 5 }] }, actor);
    const issues = await reconcileCustomerBalances();
    expect(issues).toHaveLength(0);
  });
});

describe("purchaseService — receivedNet (last-installment correction = صفر انجراف)", () => {
  it("ثلاثة استلامات بـ١ قطعة لمنتج بـ100 IQD ⇒ AP يساوي 100.00 بالضبط", async () => {
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, items: [{ variantId: 1, productUnitId: 1, quantity: "3", unitPrice: "33.34" }] },
      actor,
    );
    const it = (await db().select().from(s.purchaseOrderItems))[0];
    // اضبط total = 100.00 ليكون كسرياً عبر 3.
    await db().update(s.purchaseOrderItems).set({ total: "100.00" }).where(eq(s.purchaseOrderItems.id, Number(it.id)));
    await db().update(s.purchaseOrders).set({ subtotal: "100.00", total: "100.00" }).where(eq(s.purchaseOrders.id, po.purchaseOrderId));

    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(it.id), receivedBaseQuantity: 1 }] }, actor);
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(it.id), receivedBaseQuantity: 1 }] }, actor);
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(it.id), receivedBaseQuantity: 1 }] }, actor);

    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("100.00");

    // المُتراكم في item.receivedNet = item.total بالضبط.
    const finalItem = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.id, Number(it.id))))[0];
    expect(finalItem.receivedNet).toBe("100.00");
  });
});
