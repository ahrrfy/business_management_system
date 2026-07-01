// usd-po-reconcile: مطابقة سعر الشراء بالدولار — إعلامي بحت (لا يمسّ total/paidAmount الديناريَين
// ولا محرّك الحسابات). agreedCurrency=USD ⇒ usdTotal (فاتورة المورد الفعلية) + agreedRate (= total/usdTotal
// الضمني) يُخزَّنان للمطابقة البصرية لاحقاً بسعر التسديد الفعلي عبر الصيرفة.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder } from "../purchaseService";

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

describe("usd-po-reconcile: أمر شراء بمرجع دولاري", () => {
  it("افتراضياً (بلا agreedCurrency) ⇒ IQD، وusdTotal/agreedRate يبقيان NULL", async () => {
    const res = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, taxRatePercent: "0", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5.00" }] },
      actor,
    );
    const po = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, res.purchaseOrderId)))[0];
    expect(po.agreedCurrency).toBe("IQD");
    expect(po.usdTotal).toBeNull();
    expect(po.agreedRate).toBeNull();
    expect(po.total).toBe("50.00");
  });

  it("USD: يُخزَّن usdTotal والسعر الضمني = total/usdTotal، بلا أثر على total/paidAmount", async () => {
    // إجمالي ديناري = 10×5000 = 50,000. فاتورة المورد الفعلية = 33.33$ ⇒ سعر ضمني = 50000/33.33 ≈ 1500.15.
    const res = await createPurchaseOrder(
      {
        supplierId: 1, branchId: 1, taxRatePercent: "0",
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5000" }],
        agreedCurrency: "USD", usdTotal: "33.33",
      },
      actor,
    );
    const po = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, res.purchaseOrderId)))[0];
    expect(po.total).toBe("50000.00"); // الإجمالي الديناري لم يتغيّر إطلاقاً
    expect(po.agreedCurrency).toBe("USD");
    expect(po.usdTotal).toBe("33.33");
    expect(po.agreedRate).toBe("1500.1500"); // 50000/33.33 مقرّب ٤ منازل HALF_UP
  });

  it("USD بلا usdTotal (أو صفر/سالب) ⇒ BAD_REQUEST، ولا يُنشأ الأمر", async () => {
    await expect(
      createPurchaseOrder(
        { supplierId: 1, branchId: 1, taxRatePercent: "0", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5000" }], agreedCurrency: "USD" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      createPurchaseOrder(
        { supplierId: 1, branchId: 1, taxRatePercent: "0", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5000" }], agreedCurrency: "USD", usdTotal: "0" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const rows = await db().select().from(s.purchaseOrders);
    expect(rows.length).toBe(0);
  });
});
