import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, updatePurchaseOrder } from "../purchaseService";

/**
 * بلاغ المالك (١٧/٨/٢٦): «سعر الشراء لا يمكن أن يكون 1,450.99، وبالدولار لا يقبل 3.4566».
 *
 * سعرُ الوحدة يُدخَل **بعملة الأمر**، ودقّتُه صفةُ تلك العملة (`shared/moneyPrecision`):
 *   • الدينار منزلتان — عمود `purchaseOrderItems.unitPrice decimal(15,2)`.
 *   • الدولار أربع  — عمود `purchaseOrderItems.usdUnitPrice decimal(15,4)`.
 *
 * وكان النظام يقصّ الدولار إلى منزلتين على حدّ الـAPI فيرمي دقّةً **صمّمت قاعدتُه لحفظها**:
 * على ٥٠٠٠ وحدة، الفرق بين 3.4566 و3.46 هو $17 تختفي من ذمّة المورّد ومن تكلفة الصنف (WAVG)
 * فتبقى أرباح كلّ بيعةٍ لاحقة مغلوطة. هذه الحزمة تُثبّت الحفظ بلا فقد، والرفض الصريح عند تجاوز
 * دقّة العملة (لا تقريباً صامتاً)، وترجمةَ الدينار من **إجمالي السطر بالدولار** لا من سعر
 * الوحدة بعد تقريبه.
 */

const actor = { userId: 1, branchId: 1, role: "manager" } as const;

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
  ]) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({
    id: 1, openId: "price-precision", name: "منشئ", role: "manager", loginMethod: "local", branchId: 1,
  });
  await d.insert(s.suppliers).values({ id: 1, name: "مورد" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values({
    id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true,
  });
}

beforeEach(async () => {
  await reset();
  await seed();
});

const readOrder = async (purchaseOrderId: number) => ({
  po: (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, purchaseOrderId)))[0],
  item: (await db().select().from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, purchaseOrderId)))[0],
});

describe("دقّة سعر شراء الوحدة حسب عملة الأمر", () => {
  it("الدينار: 1450.99 تُحفَظ كما هي ويُشتقّ الإجمالي منها (نواة البلاغ)", async () => {
    const created = await createPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "1450.99" }],
    }, actor);

    const { po, item } = await readOrder(created.purchaseOrderId);
    expect(item.unitPrice).toBe("1450.99");
    expect(item.total).toBe("14509.90");
    expect(po.subtotal).toBe("14509.90");
    expect(po.total).toBe("14509.90");
  });

  it("الدولار: 3.4566 تُحفَظ بأربع منازل، والدينار يُترجَم من إجمالي السطر الدولاريّ", async () => {
    const created = await createPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      agreedCurrency: "USD",
      agreedRate: "1480",
      items: [{ variantId: 1, productUnitId: 1, quantity: "5000", unitPrice: "3.4566" }],
    }, actor);

    const { po, item } = await readOrder(created.purchaseOrderId);
    // (١) السعر الدولاريّ محفوظ بلا قصّ — كان يُخزَّن 3.4600.
    expect(item.usdUnitPrice).toBe("3.4566");
    // (٢) إجمالي السطر بالدولار = فاتورة المورد حرفياً: 3.4566 × 5000.
    expect(item.usdTotal).toBe("17283.00");
    expect(po.usdTotal).toBe("17283.00");
    // (٣) الدينار ترجمةُ **إجمالي السطر** لا ضربُ سعر وحدةٍ مقرَّب: 17283 × 1480.
    //     (الضرب بعد التقريب كان يُعطي 5115.77 × 5000 = 25,578,850 ⇒ فرقُ تقريبٍ يكبر بالكمية.)
    expect(item.total).toBe("25578840.00");
    expect(po.subtotal).toBe("25578840.00");
    expect(po.total).toBe("25578840.00");
    // (٤) سعر الوحدة الدينارّي يبقى ٢dp (عمودُه decimal(15,2)) — مرجعُ تكلفةِ الوحدة عند الاستلام.
    expect(item.unitPrice).toBe("5115.77");
    // (٥) القصّ القديم كان يُنقص ذمّة المورّد بـ$17 (≈ ٢٥٬١٦٠ د.ع) على هذا السطر وحده.
    expect(Number(po.total)).toBeLessThan(3.46 * 5000 * 1480);
  });

  it("يرفض صراحةً ما تجاوز دقّة العملة بدل تقريبه صامتاً", async () => {
    // الدينار: ثلاث منازل مرفوضة (العمود decimal(15,2)) — الرسالة تسمّي الصنف والحدّ.
    await expect(createPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1450.999" }],
    }, actor)).rejects.toThrow(/منازل عشرية/);

    // الدولار: خمس منازل مرفوضة (العمود decimal(15,4)).
    await expect(createPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      agreedCurrency: "USD",
      agreedRate: "1480",
      items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "3.45666" }],
    }, actor)).rejects.toThrow(/منازل عشرية/);
  });

  it("تعديلُ أمرٍ دولاريّ لا يقصّ أسعاره (كان كلُّ حفظٍ يُنقص قيمة الفاتورة)", async () => {
    const created = await createPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      agreedCurrency: "USD",
      agreedRate: "1480",
      items: [{ variantId: 1, productUnitId: 1, quantity: "5000", unitPrice: "3.4566" }],
    }, actor);

    await updatePurchaseOrder({
      purchaseOrderId: created.purchaseOrderId,
      supplierId: 1,
      notes: "تعديل ملاحظة فقط",
      agreedCurrency: "USD",
      agreedRate: "1480",
      items: [{ variantId: 1, productUnitId: 1, quantity: "5000", unitPrice: "3.4566" }],
    }, actor);

    const { po, item } = await readOrder(created.purchaseOrderId);
    expect(item.usdUnitPrice).toBe("3.4566");
    expect(po.total).toBe("25578840.00");
  });
});
