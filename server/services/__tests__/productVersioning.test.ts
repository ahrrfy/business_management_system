/**
 * ═══ اللقطة والاستعادة على المنتج (م٦ ق٨) ═══
 *
 * معيارُ خروج الموجة: «استعادةُ منتجٍ تعمل». يثبت هذا الملفّ، على قاعدةٍ حقيقية:
 *   ١) تعديلُ منتج ⇒ لقطةٌ كاملة (مستندُ التعديل) في `recordVersions` **قبل** التعديل وفي نفس المعاملة.
 *   ٢) فشلُ التعديل ⇒ لا لقطة (ROLLBACK كامل — «لا لقطة ⇒ لا تعديل» والعكس).
 *   ٣) الاستعادة تُعيد الحقول (اسم + سعر وحدة) وتكتب لقطةً جديدةً للحالة التي كانت قبلها، والسجلّ يُظهر
 *      «ما الذي تغيّر» بتسميات الشاشة.
 *   ٤) استعادةُ تكلفةٍ قديمة على صنفٍ له رصيد **تُرفض** بحارس التكلفة نفسه — الاستعادة تمرّ بكلّ الحرّاس.
 *   ٥) المسارُ الحامل لمعرّف الوحدة (`updateProduct`) يكتب اللقطة أيضاً (D5: الحرّاس موحَّدة).
 *   ٦) تعديلُ سعرٍ من مسار القالب يكتب `priceChangeLog` (Codex INV-05 — كان يكتبه المسارُ الآخر وحده).
 *   ٧) حارسُ شكل البكج صار على مسار القالب أيضاً.
 *   ٨) لقطةٌ بصيغةٍ غير معروفة تُرفض قبل أيّ كتابة.
 */
import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { PRODUCT_SNAPSHOT_KIND, type ProductSnapshotDocument } from "../../../shared/productSnapshot";
import { getDb } from "../../db";
import { updateProduct } from "../catalog/productUpdate";
import {
  getProductVersionDiff,
  listProductVersions,
  restoreProductVersion,
} from "../catalog/productVersioning";
import { getProductForVariantEdit, updateProductWithVariants } from "../productEditService";

const actor = { userId: 1, branchId: 1, role: "admin", isOwner: true };

const TABLES = [
  "recordVersions",
  "priceChangeLog",
  "auditLogs",
  "inventoryMovements",
  "accountingEntries",
  "branchStock",
  "productPrices",
  "productUnits",
  "productImages",
  "productVariants",
  "products",
  "branches",
  "users",
];

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
  // منتج ١: متغيّر واحد بوحدتين (قطعة أساس + درزن) وأسعار — **له رصيد ٤٠**.
  await d.insert(s.products).values({ id: 1, name: "دفتر 100 ورقة", productType: "قرطاسية" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-100", color: "أزرق", costPrice: "500" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, barcode: "BC-PIECE-1" },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, barcode: "BC-DOZEN-1" },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 1, priceTier: "WHOLESALE", price: "900.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "11000.00" },
  ]);
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 40 });
  // منتج ٢: قلم بلا رصيد — لاختبار تغيّر التكلفة ثمّ رفضِ استعادتها بعد دخول رصيد.
  await d.insert(s.products).values({ id: 2, name: "قلم حبر" });
  await d.insert(s.productVariants).values({ id: 2, productId: 2, sku: "PEN-2", costPrice: "250" });
  await d.insert(s.productUnits).values({ id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-PEN-2" });
  await d.insert(s.productPrices).values({ productUnitId: 3, priceTier: "RETAIL", price: "500.00" });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

// القالبُ كما ترسله الشاشة: الأساس يُباع بالمتجر، والحقولُ الوصفية (النوع…) تُعاد كلَّ حفظ (مسار الكتابة يستبدلها لا يرقّعها).
const template = (retail = "1000.00") => [
  { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, prices: [{ priceTier: "RETAIL" as const, price: retail }, { priceTier: "WHOLESALE" as const, price: "900.00" }] },
  { unitName: "درزن", conversionFactor: "12", isBaseUnit: false, isStoreSaleUnit: false, prices: [{ priceTier: "RETAIL" as const, price: "11000.00" }] },
];
const header1 = { productId: 1, productType: "قرطاسية" };
const variant1 = { id: 1, sku: "NB-100", color: "أزرق", costPrice: "500", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } };

async function versionsOf(productId: number) {
  return db()
    .select()
    .from(s.recordVersions)
    .where(eq(s.recordVersions.entityId, productId))
    .orderBy(asc(s.recordVersions.versionNumber));
}

describe("تعديل المنتج ⇒ لقطة قبل التعديل (ق٨)", () => {
  it("١) مسار القالب يكتب لقطةً كاملةً بالحالة القديمة، بمستند التعديل ووسمِه", async () => {
    await updateProductWithVariants(
      { ...header1, name: "دفتر 100 ورقة — طبعة 2026", unitTemplate: template("1250.00"), variants: [variant1], updateReason: "تصحيح الاسم والسعر" },
      actor,
    );
    const rows = await versionsOf(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "product", entityId: 1, versionNumber: 1, reason: "تصحيح الاسم والسعر", actorUserId: 1 });
    const payload = rows[0].payloadJson as ProductSnapshotDocument;
    expect(payload.kind).toBe(PRODUCT_SNAPSHOT_KIND);
    expect(payload.name).toBe("دفتر 100 ورقة"); // الحالة **قبل** التعديل
    expect(payload.unitTemplate.find((u) => u.unitName === "قطعة")?.retail).toBe("1000.00");
    expect(payload.variants[0]).toMatchObject({ id: 1, sku: "NB-100", costPrice: "500.00", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } });
    // والتعديلُ نفسُه طُبِّق
    const prod = (await db().select().from(s.products).where(eq(s.products.id, 1)))[0];
    expect(prod.name).toBe("دفتر 100 ورقة — طبعة 2026");
  });

  it("٢) فشلُ التعديل يُرجع اللقطة معه — ROLLBACK كامل", async () => {
    // اسمُ وحدةٍ مكرّر في القالب (أساسٌ واحد + وحدةٌ ثانية بالاسم نفسه) ⇒ يُرفض قبل الكتابة، ولو كُتبت اللقطة قبله لبقيت يتيمة.
    const dup = [template()[0], { ...template()[1], unitName: "قطعة" }];
    await expect(
      updateProductWithVariants({ ...header1, name: "x", unitTemplate: dup, variants: [variant1] }, actor),
    ).rejects.toThrow(/مكرّر/);
    // وتعديلٌ يسقط **بعد** اللقطة (تبديل وحدة الأساس يُرفض بحارس #549 بعد الأقفال) ⇒ اللقطة تسقط معه.
    await expect(
      updateProductWithVariants(
        { ...header1, unitTemplate: [{ unitName: "درزن", conversionFactor: "1", isBaseUnit: true, prices: [] }], variants: [{ ...variant1, unitBarcodes: { درزن: "BC-DOZEN-1" } }] },
        actor,
      ),
    ).rejects.toThrow(/تبديل وحدة الأساس/);
    expect(await versionsOf(1)).toHaveLength(0);
  });

  it("٥) المسارُ الحامل لمعرّف الوحدة (updateProduct) يكتب اللقطة أيضاً", async () => {
    await updateProduct(
      {
        productId: 1,
        name: "دفتر (مسار المعرّف)",
        variants: [{ id: 1, sku: "NB-100", costPrice: "500", units: [
          { id: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "1000.00" }] },
          { id: 2, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, prices: [{ priceTier: "RETAIL", price: "11000.00" }] },
        ] }],
      },
      actor,
    );
    const rows = await versionsOf(1);
    expect(rows).toHaveLength(1);
    expect((rows[0].payloadJson as ProductSnapshotDocument).name).toBe("دفتر 100 ورقة");
    expect(rows[0].reason).toBe("تعديل بيانات المنتج"); // الافتراض المشترك
  });

  it("٦) تعديلُ سعر وحدةٍ من مسار القالب يكتب priceChangeLog (INV-05)", async () => {
    await updateProductWithVariants({ ...header1, unitTemplate: template("1250.00"), variants: [variant1] }, actor);
    const log = await db().select().from(s.priceChangeLog).where(eq(s.priceChangeLog.productUnitId, 1));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ priceTier: "RETAIL", oldPrice: "1000.00", newPrice: "1250.00", reason: "تعديل يدوي من شاشة المنتج", actorUserId: 1, waveId: null });
    // إعادةُ الحفظ بلا تغيير ⇒ لا صفّ جديد (المقارنة بعد التطبيع «1000» ≡ «1000.00»).
    await updateProductWithVariants({ ...header1, unitTemplate: template("1250"), variants: [variant1] }, actor);
    expect(await db().select().from(s.priceChangeLog).where(eq(s.priceChangeLog.productUnitId, 1))).toHaveLength(1);
  });

  it("٧) البكج من مسار القالب يرفض متغيّراً ثانياً (B12 صار حارساً مشتركاً)", async () => {
    await db().update(s.products).set({ isBundle: true }).where(eq(s.products.id, 2));
    await expect(
      updateProductWithVariants(
        {
          productId: 2,
          unitTemplate: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "500.00" }] }],
          variants: [
            { id: 2, sku: "PEN-2", costPrice: "250", unitBarcodes: { قطعة: "BC-PEN-2" } },
            { sku: "PEN-2-B", costPrice: "250", unitBarcodes: {} },
          ],
        },
        actor,
      ),
    ).rejects.toThrow(/البكج لا يقبل إلّا متغيّراً واحداً/);
    expect(await versionsOf(2)).toHaveLength(0);
  });
});

describe("الاستعادة = تعديلٌ جديد بحمولةٍ قديمة يمرّ بكلّ الحرّاس", () => {
  it("٣) استعادةُ منتجٍ تعمل: الاسم وسعر الوحدة يعودان، وتُكتب لقطةٌ للحالة قبل الاستعادة، والسجلّ يقول ما تغيّر", async () => {
    await updateProductWithVariants(
      { ...header1, name: "دفتر 100 ورقة — طبعة 2026", unitTemplate: template("1250.00"), variants: [variant1], updateReason: "رفع السعر" },
      actor,
    );
    const before = await getProductForVariantEdit(1);
    expect(before?.name).toBe("دفتر 100 ورقة — طبعة 2026");
    expect(before?.unitTemplate[0].retail).toBe("1250.00");

    const res = await restoreProductVersion({ productId: 1, versionNumber: 1 }, actor);
    expect(res).toEqual({ productId: 1, restoredFromVersion: 1, versionNumber: 2 });

    const after = await getProductForVariantEdit(1);
    expect(after?.name).toBe("دفتر 100 ورقة");
    expect(after?.unitTemplate.find((u) => u.unitName === "قطعة")?.retail).toBe("1000.00");
    expect(after?.unitTemplate.find((u) => u.unitName === "قطعة")?.wholesale).toBe("900.00");
    expect(after?.variants[0].unitBarcodes).toEqual({ قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" });
    // الرصيدُ لا يُمسّ — الاستعادة لا تُحرّك مخزوناً.
    const [bs] = await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1));
    expect(bs.quantity).toBe(40);

    // لقطةٌ ثانية = الحالةُ التي كانت قبل الاستعادة (فالاستعادةُ نفسُها قابلةٌ للتراجع).
    const rows = await versionsOf(1);
    expect(rows).toHaveLength(2);
    expect((rows[1].payloadJson as ProductSnapshotDocument).name).toBe("دفتر 100 ورقة — طبعة 2026");
    expect(rows[1].reason).toBe("استعادة إلى الإصدار 1");

    // السجلّ: الأحدث أوّلاً، وكلّ نسخةٍ بحقولها المتغيّرة بتسميات الشاشة.
    const list = await listProductVersions(1);
    expect(list.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(list[1]).toMatchObject({ reason: "رفع السعر", actorName: "المدير", comparedTo: "next" });
    expect(list[1].changedFields).toEqual(["اسم المنتج", "الوحدة «قطعة» — سعر المفرد"]);
    expect(list[0]).toMatchObject({ comparedTo: "current" });
    expect(list[0].changedFields).toEqual(["اسم المنتج", "الوحدة «قطعة» — سعر المفرد"]);

    const diff = await getProductVersionDiff(1, 1);
    expect(diff.comparedToVersion).toBe(2);
    expect(diff.changes).toEqual([
      { path: "name", label: "اسم المنتج", before: "دفتر 100 ورقة", after: "دفتر 100 ورقة — طبعة 2026" },
      { path: "unit:قطعة.retail", label: "الوحدة «قطعة» — سعر المفرد", before: "1000.00", after: "1250.00" },
    ]);
  });

  it("٤) استعادةُ تكلفةٍ قديمة على صنفٍ صار له رصيد تُرفض بحارس التكلفة — ولا تكتب شيئاً", async () => {
    const penTemplate = [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: "500.00" }] }];
    // بلا رصيد: تغييرُ التكلفة مسموح ⇒ نسخة ١ بتكلفة 250.
    await updateProductWithVariants(
      { productId: 2, unitTemplate: penTemplate, variants: [{ id: 2, sku: "PEN-2", costPrice: "300", unitBarcodes: { قطعة: "BC-PEN-2" } }] },
      actor,
    );
    expect((await db().select().from(s.productVariants).where(eq(s.productVariants.id, 2)))[0].costPrice).toBe("300.00");
    // دخل رصيد ⇒ الاستعادةُ إلى 250 تُغيّر تقييم مخزونٍ مملوك بلا قيدٍ مقابل ⇒ يرفضها الحارس نفسُه.
    await db().insert(s.branchStock).values({ variantId: 2, branchId: 1, quantity: 5 });
    await expect(restoreProductVersion({ productId: 2, versionNumber: 1 }, actor)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(restoreProductVersion({ productId: 2, versionNumber: 1 }, actor)).rejects.toThrow(/لا تُعدَّل تكلفة صنفٍ مملوك له رصيد/);
    // لا أثر: التكلفة كما هي، ولا لقطة جديدة (ROLLBACK).
    expect((await db().select().from(s.productVariants).where(eq(s.productVariants.id, 2)))[0].costPrice).toBe("300.00");
    expect(await versionsOf(2)).toHaveLength(1);
  });

  it("٩) تعديلان متزامنان على المنتج نفسه يتسلسلان: نسختان 1 و2، والثانيةُ تحمل ما التزمه الأوّل (لا لقطةً بائتة ولا ER_DUP_ENTRY)", async () => {
    // أمسكته الجولة البصريّة: ضغطةُ Ctrl+S أطلقت حفظَين في دفعةٍ واحدة ⇒ الثاني كان يسقط على UNIQUE النسخ.
    const [a, b] = await Promise.allSettled([
      updateProductWithVariants({ ...header1, name: "دفتر — أ", unitTemplate: template(), variants: [variant1] }, actor),
      updateProductWithVariants({ ...header1, name: "دفتر — ب", unitTemplate: template(), variants: [variant1] }, actor),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    const rows = await versionsOf(1);
    expect(rows.map((r) => r.versionNumber)).toEqual([1, 2]);
    const names = rows.map((r) => (r.payloadJson as ProductSnapshotDocument).name);
    expect(names[0]).toBe("دفتر 100 ورقة");
    const finalName = (await db().select().from(s.products).where(eq(s.products.id, 1)))[0].name;
    // اللقطةُ الثانية = حالةُ المنتج بعد التعديل الأوّل (لا الأصل) — فالاستعادةُ إليها تُعيد ما كتبه الأوّل فعلاً.
    expect(["دفتر — أ", "دفتر — ب"]).toContain(names[1]);
    expect(["دفتر — أ", "دفتر — ب"]).toContain(finalName);
    expect(names[1]).not.toBe(finalName);
  });

  it("٨) لقطةٌ بصيغةٍ غير معروفة أو لمنتجٍ آخر تُرفض قبل أيّ كتابة", async () => {
    await db().insert(s.recordVersions).values({ entityType: "product", entityId: 1, versionNumber: 1, payloadJson: { foo: 1 }, reason: "x", actorUserId: 1 });
    await expect(restoreProductVersion({ productId: 1, versionNumber: 1 }, actor)).rejects.toThrow(/الصيغة المعروفة/);
    await expect(restoreProductVersion({ productId: 1, versionNumber: 9 }, actor)).rejects.toThrow(/غير موجود/);
    const prod = (await db().select().from(s.products).where(eq(s.products.id, 1)))[0];
    expect(prod.name).toBe("دفتر 100 ورقة");
    expect(await versionsOf(1)).toHaveLength(1);
  });
});
