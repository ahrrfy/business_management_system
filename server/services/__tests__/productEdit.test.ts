/**
 * اختبارات productEditService (قراءة+تعديل منتج بنموذج المتغيّرات المستقلة) — فجوة موثَّقة:
 * شقيق catalogService.createProduct المُغطّى جيّداً، لكن مسار التعديل (updateProductVariants،
 * managerProcedure) كان بصفر تغطية رغم تعقيده الذرّي (متغيّرات/وحدات/أسعار/باركود/صور).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getProductForVariantEdit, updateProductWithVariants } from "../productEditService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
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
  // منتج ١: متغيّر واحد بوحدتين (قطعة أساس + درزن) وأسعار مفرد/جملة لكل وحدة.
  await d.insert(s.products).values({ id: 1, name: "دفتر ١٠٠ ورقة", productType: "قرطاسية" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-100", color: "أزرق", costPrice: "500" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-PIECE-1" },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, barcode: "BC-DOZEN-1" },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 1, priceTier: "WHOLESALE", price: "900.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "11000.00" },
  ]);
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 40 });
  // منتج ٢ منفصل — لاختبار تعارض الباركود/SKU عبر المنتجات.
  await d.insert(s.products).values({ id: 2, name: "قلم حبر" });
  await d.insert(s.productVariants).values({ id: 2, productId: 2, sku: "PEN-2", costPrice: "250" });
  await d.insert(s.productUnits).values({ id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-PEN-2" });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

const baseTemplate = () => [
  { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: "1000.00" }, { priceTier: "WHOLESALE" as const, price: "900.00" }] },
  { unitName: "درزن", conversionFactor: "12", isBaseUnit: false, prices: [{ priceTier: "RETAIL" as const, price: "11000.00" }] },
];

describe("getProductForVariantEdit — القراءة", () => {
  it("منتج غير موجود ⇒ null", async () => {
    expect(await getProductForVariantEdit(999999)).toBeNull();
  });

  it("منتج بمتغيّرات: يقرأ الوحدات/الأسعار/الباركود/الرصيد بشكل صحيح", async () => {
    const p = await getProductForVariantEdit(1);
    expect(p).toBeTruthy();
    expect(p!.name).toBe("دفتر ١٠٠ ورقة");
    expect(p!.variants).toHaveLength(1);
    const v = p!.variants[0];
    expect(v.sku).toBe("NB-100");
    expect(v.baseRetail).toBe("1000.00");
    expect(v.unitBarcodes).toEqual({ قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" });
    expect(v.stockByBranch).toEqual({ 1: 40 });
    expect(p!.unitTemplate).toHaveLength(2);
    expect(p!.unitTemplate[0].unitName).toBe("قطعة");
    expect(p!.unitTemplate[0].retail).toBe("1000.00");
    expect(p!.unitTemplate[0].wholesale).toBe("900.00");
  });

  it("منتج بلا متغيّرات: يُعيد قالب افتراضي (قطعة) ومتغيّرات فارغة", async () => {
    await db().insert(s.products).values({ id: 3, name: "منتج فارغ" });
    const p = await getProductForVariantEdit(3);
    expect(p).toBeTruthy();
    expect(p!.variants).toEqual([]);
    expect(p!.unitTemplate).toEqual([{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, retail: "", wholesale: "", government: "" }]);
  });
});

describe("updateProductWithVariants — الكتابة", () => {
  it("تحديث متغيّر موجود: يغيّر الاسم/السعر/التكلفة في نفس الصفّ (لا صفّاً جديداً)", async () => {
    const r = await updateProductWithVariants(
      {
        productId: 1,
        name: "دفتر ١٠٠ ورقة (مُحدَّث)",
        unitTemplate: baseTemplate(),
        variants: [{ id: 1, sku: "NB-100", costPrice: "550", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }],
      },
      actor,
    );
    expect(r.added).toBe(0);

    const rows = await db().select().from(s.productVariants).where(eq(s.productVariants.productId, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0].costPrice).toBe("550.00");
    const prod = (await db().select().from(s.products).where(eq(s.products.id, 1)))[0];
    expect(prod.name).toBe("دفتر ١٠٠ ورقة (مُحدَّث)");
  });

  it("إضافة متغيّر جديد (بلا id) ⇒ صفّ جديد + added=1، والقديم يبقى كما هو", async () => {
    const r = await updateProductWithVariants(
      {
        productId: 1,
        unitTemplate: baseTemplate(),
        variants: [
          { id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } },
          { sku: "NB-100-RED", color: "أحمر", costPrice: "520", unitBarcodes: { قطعة: "BC-PIECE-RED", درزن: "BC-DOZEN-RED" } },
        ],
      },
      actor,
    );
    expect(r.added).toBe(1);
    const rows = await db().select().from(s.productVariants).where(eq(s.productVariants.productId, 1));
    expect(rows).toHaveLength(2);
    const redVariant = rows.find((v) => v.sku === "NB-100-RED")!;
    expect(redVariant.color).toBe("أحمر");
    const units = await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(redVariant.id)));
    expect(units).toHaveLength(2);
  });

  it("سعر خاص (baseRetail) لمتغيّر واحد يَجُبّ سعر مفرد وحدة الأساس فقط، والجملة تتبع القالب", async () => {
    await updateProductWithVariants(
      {
        productId: 1,
        unitTemplate: baseTemplate(),
        variants: [{ id: 1, sku: "NB-100", costPrice: "500", baseRetail: "1200.00", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }],
      },
      actor,
    );
    const baseUnit = (await db().select().from(s.productUnits).where(and(eq(s.productUnits.variantId, 1), eq(s.productUnits.isBaseUnit, true))))[0];
    const prices = await db().select().from(s.productPrices).where(eq(s.productPrices.productUnitId, Number(baseUnit.id)));
    const retail = prices.find((p) => p.priceTier === "RETAIL")!;
    const wholesale = prices.find((p) => p.priceTier === "WHOLESALE")!;
    expect(retail.price).toBe("1200.00");
    expect(wholesale.price).toBe("900.00"); // من القالب — غير مُتأثّر بـbaseRetail override
  });

  it("سعر الحكومي (GOVERNMENT) يُقرأ في القالب ويبقى بعد جولة حفظ تُعيد إرساله (تصحيح فقد صامت)", async () => {
    // أضِف سعراً حكوميّاً لوحدة الأساس (قطعة) لمنتج ١.
    await db().insert(s.productPrices).values({ productUnitId: 1, priceTier: "GOVERNMENT", price: "800.00" });

    // (١) القراءة تُظهره في القالب (كان محجوباً قبل التصحيح ⇒ يُمحى صامتاً عند الحفظ).
    const p = await getProductForVariantEdit(1);
    const baseTmpl = p!.unitTemplate.find((u) => u.isBaseUnit)!;
    expect(baseTmpl.government).toBe("800.00");

    // (٢) جولة حفظ تُعيد إرسال الأسعار الثلاثة (كما يفعل نموذج التحرير المبسّط) ⇒ الحكومي يبقى.
    await updateProductWithVariants(
      {
        productId: 1,
        unitTemplate: [
          {
            unitName: "قطعة", conversionFactor: "1", isBaseUnit: true,
            prices: [
              { priceTier: "RETAIL" as const, price: baseTmpl.retail },
              { priceTier: "WHOLESALE" as const, price: baseTmpl.wholesale },
              { priceTier: "GOVERNMENT" as const, price: baseTmpl.government },
            ],
          },
          { unitName: "درزن", conversionFactor: "12", isBaseUnit: false, prices: [{ priceTier: "RETAIL" as const, price: "11000.00" }] },
        ],
        variants: [{ id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }],
      },
      actor,
    );
    const baseUnit = (await db().select().from(s.productUnits).where(and(eq(s.productUnits.variantId, 1), eq(s.productUnits.isBaseUnit, true))))[0];
    const prices = await db().select().from(s.productPrices).where(eq(s.productPrices.productUnitId, Number(baseUnit.id)));
    expect(prices.find((pr) => pr.priceTier === "GOVERNMENT")?.price).toBe("800.00");
  });

  it("وحدة تُحذَف من القالب ⇒ تُعطَّل (isActive=false) لا تُحذَف فعلياً", async () => {
    await updateProductWithVariants(
      {
        productId: 1,
        // القالب الجديد بلا «درزن» — يجب أن تبقى الوحدة موجودة لكن معطّلة.
        unitTemplate: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "1000.00" }] }],
        variants: [{ id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: { قطعة: "BC-PIECE-1" } }],
      },
      actor,
    );
    const dozenUnit = (await db().select().from(s.productUnits).where(eq(s.productUnits.id, 2)))[0];
    expect(dozenUnit).toBeTruthy(); // لم يُحذَف
    expect(dozenUnit.isActive).toBe(false);
  });

  it("تعطيل متغيّر (isActive:false) يُحفَظ في DB", async () => {
    await updateProductWithVariants(
      {
        productId: 1,
        isActive: true,
        unitTemplate: baseTemplate(),
        variants: [{ id: 1, sku: "NB-100", costPrice: "500", isActive: false, unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }],
      },
      actor,
    );
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(v.isActive).toBe(false);
  });

  it("صورة اللون: تعيين ثم إزالة، وتُترَك بلا مساس عند image=undefined", async () => {
    await updateProductWithVariants(
      {
        productId: 1,
        unitTemplate: baseTemplate(),
        variants: [{ id: 1, sku: "NB-100", costPrice: "500", image: "data:image/png;base64,AAA", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }],
      },
      actor,
    );
    let imgs = await db().select().from(s.productImages).where(eq(s.productImages.variantId, 1));
    expect(imgs).toHaveLength(1);
    expect(imgs[0].url).toBe("data:image/png;base64,AAA");

    // image=undefined (الحقل غائب) ⇒ لا يُمَسّ.
    await updateProductWithVariants(
      { productId: 1, unitTemplate: baseTemplate(), variants: [{ id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }] },
      actor,
    );
    imgs = await db().select().from(s.productImages).where(eq(s.productImages.variantId, 1));
    expect(imgs).toHaveLength(1);

    // image=null ⇒ تُزال.
    await updateProductWithVariants(
      { productId: 1, unitTemplate: baseTemplate(), variants: [{ id: 1, sku: "NB-100", costPrice: "500", image: null, unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }] },
      actor,
    );
    imgs = await db().select().from(s.productImages).where(eq(s.productImages.variantId, 1));
    expect(imgs).toHaveLength(0);
  });

  it("صورة اللون: إعادة الحفظ بصورة جديدة تصون productImages.id (لا تتدلّى روابط /api/img)", async () => {
    await updateProductWithVariants(
      { productId: 1, unitTemplate: baseTemplate(), variants: [{ id: 1, sku: "NB-100", costPrice: "500", image: "data:image/png;base64,AAA", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }] },
      actor,
    );
    const before = await db().select().from(s.productImages).where(eq(s.productImages.variantId, 1));
    expect(before).toHaveLength(1);
    const id0 = before[0].id;

    // إعادة حفظ بصورة مختلفة ⇒ يُحدَّث الصفّ نفسه في مكانه (id ثابت)، لا حذف+إدراج (كان يبدّل الـid).
    await updateProductWithVariants(
      { productId: 1, unitTemplate: baseTemplate(), variants: [{ id: 1, sku: "NB-100", costPrice: "500", image: "data:image/png;base64,BBB", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }] },
      actor,
    );
    const after = await db().select().from(s.productImages).where(eq(s.productImages.variantId, 1));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(id0); // ← يفشل مع delete+insert القديم
    expect(after[0].url).toBe("data:image/png;base64,BBB");
  });

  it("رفض: باركود مكرّر بين متغيّرين داخل نفس الحمولة ⇒ CONFLICT، ولا شيء يتغيّر (rollback)", async () => {
    await expect(
      updateProductWithVariants(
        {
          productId: 1,
          unitTemplate: baseTemplate(),
          variants: [
            { id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: { قطعة: "DUPE", درزن: "BC-DOZEN-1" } },
            { sku: "NB-100-RED", costPrice: "520", unitBarcodes: { قطعة: "DUPE", درزن: "X" } },
          ],
        },
        actor,
      ),
    ).rejects.toThrow(/مكرّر داخل المنتج/);
    const rows = await db().select().from(s.productVariants).where(eq(s.productVariants.productId, 1));
    expect(rows).toHaveLength(1); // لم يُضَف المتغيّر الثاني
  });

  it("رفض: باركود مُستخدَم في منتج آخر ⇒ CONFLICT", async () => {
    await expect(
      updateProductWithVariants(
        {
          productId: 1,
          unitTemplate: baseTemplate(),
          variants: [{ id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: { قطعة: "BC-PEN-2", درزن: "BC-DOZEN-1" } }],
        },
        actor,
      ),
    ).rejects.toThrow(/مُستخدَم في/);
  });

  it("رفض: SKU مكرّر داخل نفس الحمولة ⇒ CONFLICT", async () => {
    await expect(
      updateProductWithVariants(
        {
          productId: 1,
          unitTemplate: baseTemplate(),
          variants: [
            { id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } },
            { sku: "NB-100", costPrice: "520", unitBarcodes: { قطعة: "Y1", درزن: "Y2" } },
          ],
        },
        actor,
      ),
    ).rejects.toThrow(/مكرّر بين المتغيّرات/);
  });

  it("يسمح بتكرار SKU بين منتجات مختلفة لأن اللون/القياس ليسا هوية عالمية", async () => {
    await updateProductWithVariants(
      { productId: 1, unitTemplate: baseTemplate(), variants: [{ id: 1, sku: "PEN-2", costPrice: "500", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }] },
      actor,
    );
    const rows = await db().select().from(s.productVariants).where(eq(s.productVariants.sku, "PEN-2"));
    expect(rows.map((r) => Number(r.productId)).sort()).toEqual([1, 2]);
  });

  it("رفض: منتج غير موجود ⇒ NOT_FOUND", async () => {
    await expect(
      updateProductWithVariants({ productId: 999999, unitTemplate: baseTemplate(), variants: [{ sku: "X-1", costPrice: "1", unitBarcodes: {} }] }, actor),
    ).rejects.toThrow(/المنتج غير موجود/);
  });

  it("رفض: بلا متغيّرات ⇒ BAD_REQUEST", async () => {
    await expect(updateProductWithVariants({ productId: 1, unitTemplate: baseTemplate(), variants: [] }, actor)).rejects.toThrow(
      /متغيّراً واحداً على الأقل/,
    );
  });

  it("رفض: صفر أو أكثر من وحدة أساس في القالب ⇒ BAD_REQUEST", async () => {
    const noBase = [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: false, prices: [] }];
    await expect(
      updateProductWithVariants({ productId: 1, unitTemplate: noBase, variants: [{ id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: {} }] }, actor),
    ).rejects.toThrow(/وحدة أساس واحدة فقط/);

    const twoBase = [
      { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [] },
      { unitName: "علبة", conversionFactor: "10", isBaseUnit: true, prices: [] },
    ];
    await expect(
      updateProductWithVariants({ productId: 1, unitTemplate: twoBase, variants: [{ id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: {} }] }, actor),
    ).rejects.toThrow(/وحدة أساس واحدة فقط/);
  });

  it("رفض: اسم وحدة فارغ في القالب ⇒ BAD_REQUEST", async () => {
    const badTemplate = [{ unitName: "  ", conversionFactor: "1", isBaseUnit: true, prices: [] }];
    await expect(
      updateProductWithVariants({ productId: 1, unitTemplate: badTemplate, variants: [{ id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: {} }] }, actor),
    ).rejects.toThrow(/كل وحدة في القالب تحتاج اسماً/);
  });

  it("رفض: SKU فارغ لمتغيّر ⇒ BAD_REQUEST", async () => {
    await expect(
      updateProductWithVariants({ productId: 1, unitTemplate: baseTemplate(), variants: [{ id: 1, sku: "  ", costPrice: "500", unitBarcodes: {} }] }, actor),
    ).rejects.toThrow(/كل متغيّر يحتاج SKU/);
  });

  it("رفض: معرّف متغيّر لا يخصّ هذا المنتج ⇒ BAD_REQUEST", async () => {
    // sku مغاير كي لا يتقدّم فحص تكرار SKU على فحص الملكية (assertEditUniqueness يُنفَّذ أولاً).
    await expect(
      updateProductWithVariants(
        { productId: 1, unitTemplate: baseTemplate(), variants: [{ id: 2, sku: "NB-100-OWNCHECK", costPrice: "500", unitBarcodes: {} }] },
        actor,
      ),
    ).rejects.toThrow(/لا يخصّ هذا المنتج/);
  });

  it("الاسم الصريح (name) يَجُبّ تركيب productType/brand/modelName", async () => {
    await updateProductWithVariants(
      {
        productId: 1,
        name: "الاسم الصريح",
        productType: "نوع",
        brand: "ماركة",
        modelName: "موديل",
        unitTemplate: baseTemplate(),
        variants: [{ id: 1, sku: "NB-100", costPrice: "500", unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" } }],
      },
      actor,
    );
    const prod = (await db().select().from(s.products).where(eq(s.products.id, 1)))[0];
    expect(prod.name).toBe("الاسم الصريح");
  });
});
