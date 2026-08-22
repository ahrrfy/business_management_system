import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder } from "../purchase/order";
import { ensureAndLockBranchStock } from "../gifts/helpers";
import { withTx } from "../tx";

/**
 * مساران من ورقة الإصلاحات (١٧/٨):
 *  - **ج-٥** مفتاح idempotency لإنشاء أمر الشراء كان يُطابَق **وحده** ⇒ نفس المفتاح بحمولةٍ
 *    مختلفة يتلقّى «نجاحاً» ويُعاد له الأمر الأوّل بلا تنفيذ: أمرٌ يظنّه المستخدم محفوظاً وهو
 *    غير موجود.
 *  - **هـ-١** قفل `branchStock` في مسار الهدايا كان بلا شرط الفرع وبلا ترتيب ⇒ يقفل صفوف كلّ
 *    الفروع (يُسلسل مبيعات فرعٍ آخر) ويفتح باب deadlock بين مسارين بترتيبين متعاكسين.
 */

function db() {
  const v = getDb();
  if (!v) throw new Error("DATABASE_URL not set for tests");
  return v;
}

const actor = { userId: 1, branchId: 1, role: "admin" as const };

async function seed() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "purchaseOrderItems", "purchaseOrders", "idempotencyKeys", "branchStock",
    "productUnits", "productVariants", "products", "categories", "suppliers", "users", "branches",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({
    id: 1, openId: "u-1", name: "مدير", email: "admin@test.local", passwordHash: "x", role: "admin", branchId: 1,
  });
  await d.insert(s.suppliers).values([
    { id: 1, name: "مورّد أ" },
    { id: 2, name: "مورّد ب" },
  ]);
  await d.insert(s.categories).values({ id: 1, name: "قرطاسية" });
  await d.insert(s.products).values([
    { id: 1, name: "قلم", categoryId: 1 },
    { id: 2, name: "دفتر", categoryId: 1 },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "500.00" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "1000.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true },
  ]);
}

beforeEach(seed);

const baseOrder = {
  supplierId: 1,
  branchId: 1,
  items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "500" }],
  clientRequestId: "po-key-1",
};

describe("ج-٥ — بصمة حمولة أمر الشراء", () => {
  it("نفس المفتاح بنفس الحمولة ⇒ إعادة الأمر الأوّل بلا تنفيذٍ ثانٍ", async () => {
    const first = await createPurchaseOrder({ ...baseOrder }, actor);
    const again = await createPurchaseOrder({ ...baseOrder }, actor);
    expect(Number((again as { purchaseOrderId: number }).purchaseOrderId)).toBe(
      Number(first.purchaseOrderId),
    );
    const rows = await db().select({ id: s.purchaseOrders.id }).from(s.purchaseOrders);
    expect(rows).toHaveLength(1); // لا أمرَ ثانياً
  });

  it("نفس المفتاح بمورّدٍ مختلف ⇒ يُرفض صراحةً (CONFLICT) لا «نجاحاً» كاذباً", async () => {
    await createPurchaseOrder({ ...baseOrder }, actor);
    await expect(
      createPurchaseOrder({ ...baseOrder, supplierId: 2 }, actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("نفس المفتاح بمبلغٍ مختلف ⇒ يُرفض (وإلّا ضاع أمرٌ ظنّه المستخدم محفوظاً)", async () => {
    await createPurchaseOrder({ ...baseOrder }, actor);
    await expect(
      createPurchaseOrder(
        { ...baseOrder, items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "900" }] },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("ترتيب الأسطر لا يغيّر البصمة (إعادة إرسالٍ بريئة تبقى replay)", async () => {
    const two = {
      ...baseOrder,
      clientRequestId: "po-key-2",
      items: [
        { variantId: 2, productUnitId: 2, quantity: "3", unitPrice: "1000" },
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "500" },
      ],
    };
    const first = await createPurchaseOrder(two, actor);
    const reordered = await createPurchaseOrder(
      { ...two, items: [two.items[1], two.items[0]] },
      actor,
    );
    expect(Number((reordered as { purchaseOrderId: number }).purchaseOrderId)).toBe(
      Number(first.purchaseOrderId),
    );
  });
});

describe("هـ-١ — نطاق قفل مخزون الهدايا", () => {
  it("القفل محصورٌ بالفرع: صفّ الفرع الآخر يبقى قابلاً للتعديل بمعاملةٍ متزامنة", async () => {
    // صفّان لنفس المتغيّر في فرعين.
    await db().insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: 100 },
      { variantId: 1, branchId: 2, quantity: 100 },
    ]);

    let blocked = false;
    await withTx(async (tx) => {
      await ensureAndLockBranchStock(tx, [1], 1); // يقفل الفرع ١ فقط

      // معاملة مستقلّة تحاول قفل صفّ الفرع ٢ بمهلة قصيرة: لو كان القفل يشمل كل الفروع لتعطّلت.
      const other = await db()
        .transaction(async (t2) => {
          await t2.execute(sql`SET innodb_lock_wait_timeout = 2`);
          await t2
            .select({ id: s.branchStock.id })
            .from(s.branchStock)
            .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 2)))
            .for("update");
          return "ok" as const;
        })
        .catch(() => {
          blocked = true;
          return "blocked" as const;
        });
      expect(other).toBe("ok");
    });
    expect(blocked).toBe(false);
  });

  it("ينشئ الصفوف الناقصة ويقفلها (لا يتسرّب متغيّرٌ جديد بلا صفّ)", async () => {
    await withTx((tx) => ensureAndLockBranchStock(tx, [2, 1], 2));
    const rows = await db()
      .select({ variantId: s.branchStock.variantId, branchId: s.branchStock.branchId })
      .from(s.branchStock)
      .where(eq(s.branchStock.branchId, 2));
    expect(rows.map((r) => Number(r.variantId)).sort()).toEqual([1, 2]);
  });
});
