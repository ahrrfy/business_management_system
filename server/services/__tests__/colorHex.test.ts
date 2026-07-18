/**
 * colorHex — دوام «لون العرض الحقيقي» عبر الإنشاء/التعديل (بنك الألوان).
 * يقفل خيط colorHex end-to-end: يُخزَّن الاختيار الصريح، يُقرأ للتعبئة، ويبقى عند إعادة الإرسال.
 * دلالة التعديل (كالصورة): `undefined` (غائب عن الحمولة، كشاشة السلعة البسيطة) ⇒ **يُصان المخزَّن**؛
 * `null` صريح ⇒ يُمحى (المستخدم أعاده للتلقائي، يُستنتَج لاحقاً من الاسم عبر @shared/colorBank).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getProductForVariantEdit, updateProductWithVariants } from "../productEditService";

const actor = { userId: 1, branchId: 1 };
const TABLES = ["branchStock", "productPrices", "productUnits", "productImages", "productVariants", "products", "branches", "users"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_admin", name: "المدير", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "دفتر", productType: "قرطاسية" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", color: "أزرق", costPrice: "500" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-1" });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
}

const tmpl = () => [
  { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: "1000.00" }] },
];

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("colorHex — الدوام عبر التعديل/الإضافة", () => {
  it("يخزّن اللون الصريح على متغيّر موجود ويقرأه للتعبئة", async () => {
    await updateProductWithVariants(
      { productId: 1, unitTemplate: tmpl(), variants: [{ id: 1, sku: "NB-1", color: "أزرق", colorHex: "#123456", costPrice: "500", unitBarcodes: { قطعة: "BC-1" } }] },
      actor,
    );
    const row = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(row.colorHex).toBe("#123456");
    const p = await getProductForVariantEdit(1);
    expect(p!.variants[0].colorHex).toBe("#123456");
  });

  it("متغيّر بلا لون صريح ⇒ colorHex = null (يُستنتَج لاحقاً من الاسم)", async () => {
    await updateProductWithVariants(
      { productId: 1, unitTemplate: tmpl(), variants: [{ id: 1, sku: "NB-1", color: "أزرق", costPrice: "500", unitBarcodes: { قطعة: "BC-1" } }] },
      actor,
    );
    const row = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(row.colorHex).toBeNull();
    const p = await getProductForVariantEdit(1);
    expect(p!.variants[0].colorHex).toBeNull();
  });

  it("متغيّر جديد (بلا id) يخزّن اللون الصريح", async () => {
    await updateProductWithVariants(
      {
        productId: 1,
        unitTemplate: tmpl(),
        variants: [
          { id: 1, sku: "NB-1", color: "أزرق", colorHex: "#0000FF", costPrice: "500", unitBarcodes: { قطعة: "BC-1" } },
          { sku: "NB-1-RED", color: "أحمر", colorHex: "#FF0000", costPrice: "500", unitBarcodes: { قطعة: "BC-RED" } },
        ],
      },
      actor,
    );
    const rows = await db().select().from(s.productVariants).where(eq(s.productVariants.productId, 1));
    expect(rows.find((r) => r.sku === "NB-1-RED")!.colorHex).toBe("#FF0000");
  });

  it("إعادة إرسال اللون الصريح عند تعديل لا يمسّه ⇒ يبقى (لا يُمحى)", async () => {
    await updateProductWithVariants(
      { productId: 1, unitTemplate: tmpl(), variants: [{ id: 1, sku: "NB-1", color: "أزرق", colorHex: "#ABCDEF", costPrice: "500", unitBarcodes: { قطعة: "BC-1" } }] },
      actor,
    );
    await updateProductWithVariants(
      { productId: 1, unitTemplate: tmpl(), variants: [{ id: 1, sku: "NB-1", color: "أزرق", colorHex: "#ABCDEF", costPrice: "600", unitBarcodes: { قطعة: "BC-1" } }] },
      actor,
    );
    const row = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(row.colorHex).toBe("#ABCDEF");
    expect(row.costPrice).toBe("600.00");
  });

  it("تعديلٌ لا يُرسل colorHex إطلاقاً (نمط السلعة البسيطة) ⇒ يُصان اللون الصريح المخزَّن — لا يُمحى", async () => {
    // اضبط لوناً صريحاً على المتغيّر.
    await updateProductWithVariants(
      { productId: 1, unitTemplate: tmpl(), variants: [{ id: 1, sku: "NB-1", color: "أزرق", colorHex: "#ABCDEF", costPrice: "500", unitBarcodes: { قطعة: "BC-1" } }] },
      actor,
    );
    // عدّل بحمولةٍ بلا colorHex إطلاقاً (color=null كما ترسله SimpleProductEditForm) ⇒ يجب أن يبقى اللون.
    await updateProductWithVariants(
      { productId: 1, unitTemplate: tmpl(), variants: [{ id: 1, sku: "NB-1", color: null, costPrice: "700", unitBarcodes: { قطعة: "BC-1" } }] },
      actor,
    );
    const row = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(row.colorHex).toBe("#ABCDEF"); // مصونٌ رغم غيابه من الحمولة (كان يُمحى صامتاً قبل الإصلاح)
    expect(row.costPrice).toBe("700.00"); // بقيّة الحقول تُحدَّث طبيعياً
  });

  it("colorHex = null صريحاً ⇒ يُمحى (المستخدم أعاده للتلقائي)", async () => {
    await updateProductWithVariants(
      { productId: 1, unitTemplate: tmpl(), variants: [{ id: 1, sku: "NB-1", color: "أزرق", colorHex: "#ABCDEF", costPrice: "500", unitBarcodes: { قطعة: "BC-1" } }] },
      actor,
    );
    await updateProductWithVariants(
      { productId: 1, unitTemplate: tmpl(), variants: [{ id: 1, sku: "NB-1", color: "أزرق", colorHex: null, costPrice: "500", unitBarcodes: { قطعة: "BC-1" } }] },
      actor,
    );
    const row = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(row.colorHex).toBeNull(); // null صريح ⇒ مسحٌ متعمَّد (لا صيانة)
  });
});
