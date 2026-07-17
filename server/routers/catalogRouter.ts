import { z } from "zod";
import { asc } from "drizzle-orm";
import { categories } from "../../drizzle/schema";
import { getDb } from "../db";
import { assignBarcode, checkBarcodesTaken, createProduct, deleteProduct, getProductForEdit, listByProductIds, listByUnitIds, listForPos, listForPurchase, listMaterialsForRecipe, listProductImages, listProductsAdmin, lookupByBarcode, setProductActive, updateProduct } from "../services/catalogService";
import { getProductForVariantEdit, updateProductWithVariants } from "../services/productEditService";
import { addUnitBarcodeAlias, listUnitBarcodes, listUnitBarcodesMany, removeUnitBarcodeAlias, resolveProductUnitId } from "../services/catalog/barcodeAliases";
import {
  createCategory,
  deleteCategory,
  listCategoriesAdmin,
  mergeCategories,
  reassignProducts,
  updateCategory,
} from "../services/categoryService";
import { logAudit } from "../services/auditService";
import { getProductUsage } from "../services/entityUsage";
import { productsManagerProcedure, productsPurchaseProcedure, productsReadProcedure, router } from "../trpc";
import { assertValidImageDataUrl } from "../lib/imageValidation";

const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).default("RETAIL");

// IDOR (تدقيق ٢/٧): posList/adminList/byBarcode كانت تثق بـbranchId العميل ⇒ أي مستخدم مصادَق
// يقرأ مخزون أي فرع بتمرير معرّفه. نُقيّد غير المرتفعين (كاشير/مخزن/…) بفرعهم المُسنَد؛ المدير/الأدمن
// يعبُران الفروع (شرعيّ). المنتجات/الأسعار مشتركة على مستوى الشركة؛ المحجوب هو كمية مخزون الفرع.
function scopeBranch(ctx: { user: { role: string; branchId?: number | null } }, requested: number): number {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  if (elevated) return requested;
  return ctx.user.branchId != null ? Number(ctx.user.branchId) : requested;
}

const priceSchema = z.object({ priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]), price: z.string() });
const barcodeAliasSchema = z.object({
  barcode: z.string().min(1).max(64),
  note: z.string().max(255).optional().nullable(),
});
const unitSchema = z.object({
  unitName: z.string().min(1),
  conversionFactor: z.string(),
  barcode: z.string().optional(),
  isBaseUnit: z.boolean().optional(),
  prices: z.array(priceSchema).optional(),
  // باركودات بديلة تُضاف مع إنشاء الوحدة — نفس السلعة/التكلفة/السعر/المخزون، عدّة باركودات.
  barcodeAliases: z.array(barcodeAliasSchema).max(20).optional(),
});
const variantSchema = z.object({
  sku: z.string().min(1),
  variantName: z.string().optional(),
  color: z.string().optional(),
  // بنك الألوان: لون العرض الحقيقي «#RRGGBB» (اختيار صريح؛ إن غاب يُستنتَج من الاسم).
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/, "لون غير صالح").nullish(),
  size: z.string().optional(),
  costPrice: z.string(),
  // v3-add-screens.
  minStock: z.number().int().min(0).max(1_000_000).optional(),
  openingStock: z.number().int().min(0).optional(),
  // product-variants: نقطة إعادة الطلب + الظهور المستقل لكل متغيّر (الأعمدة موجودة في المخطّط).
  reorderPoint: z.number().int().min(0).max(1_000_000).optional(),
  isActive: z.boolean().optional(),
  // product-variants: رصيد افتتاحي مستقل لكل فرع (يحلّ محلّ openingStock أحاديّ الفرع حين يُمرَّر).
  openingStockByBranch: z
    .array(z.object({ branchId: z.number().int().positive(), qty: z.number().int().min(0).max(100_000_000) }))
    .optional(),
  // product-variants: صورة مستقلّة لهذا اللون (data URL مضغوط) — تُخزَّن في productImages بـvariantId.
  image: z.string().max(5_000_000).optional(),
  units: z.array(unitSchema).min(1),
});

// product-variants: تعديل منتج بنموذج المتغيّرات (قالب وحدات مشترك + باركود لكل متغيّر بالاسم).
const updateUnitTemplateSchema = z.object({
  unitName: z.string().min(1),
  conversionFactor: z.string(),
  isBaseUnit: z.boolean(),
  prices: z.array(priceSchema),
});
const editVariantSchema = z.object({
  id: z.number().int().positive().optional(),
  sku: z.string().min(1),
  color: z.string().nullish(),
  // بنك الألوان: لون العرض الحقيقي «#RRGGBB» (اختيار صريح؛ إن غاب يُستنتَج من الاسم).
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/, "لون غير صالح").nullish(),
  size: z.string().nullish(),
  costPrice: z.string(),
  baseRetail: z.string().optional(),
  minStock: z.number().int().min(0).max(1_000_000).optional(),
  reorderPoint: z.number().int().min(0).max(1_000_000).optional(),
  isActive: z.boolean().optional(),
  // product-variants: صورة هذا اللون — string ⇒ تُعيَّن، null/"" ⇒ تُزال (يُعاد التوفيق دائماً).
  image: z.string().max(5_000_000).nullish(),
  unitBarcodes: z.record(z.string(), z.string()),
});

// v3-add-screens: صور المنتج.
const imageSchema = z.object({
  // v3-add-screens(100%): TEXT في DB ⇒ نسمح بـdata URLs الكبيرة (5MB كحد عملي).
  url: z.string().min(1).max(5_000_000),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const catalogRouter = router({
  posList: productsReadProcedure
    // بند 12ب (٧/٧): customerId اختياري — عميل بسعر تعاقدي نشط يرى سعره بدل سعر الفئة (isContractPrice).
    .input(z.object({ branchId: z.number().int().positive(), tier, query: z.string().optional(), limit: z.number().default(200), includeReceptionServices: z.boolean().optional(), customerId: z.number().int().positive().nullish() }))
    .query(({ input, ctx }) => listForPos(scopeBranch(ctx, input.branchId), input.tier, input.query, input.limit, { includeReceptionServices: input.includeReceptionServices, customerId: input.customerId ?? undefined })),

  // شاشة الملصقات (١٦/٧): إعادة تسعير قائمة الطباعة عند تبديل فئة السعر — استعلامٌ واحد
  // على نفس خطّ الكاشير (فئة/تعاقديّ/بكج/عروض) ⇒ سعر الملصق = سعر الكاشير دائماً.
  byUnitIds: productsReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        tier,
        productUnitIds: z.array(z.number().int().positive()).max(500),
      })
    )
    .query(({ input, ctx }) => listByUnitIds(input.productUnitIds, scopeBranch(ctx, input.branchId), input.tier)),

  // شاشة الملصقات: «أضِف كلّ ألوان/وحدات المنتج» — كلّ صفوف (متغيّر × وحدة) لمنتجٍ واحد.
  byProductIds: productsReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        tier,
        productIds: z.array(z.number().int().positive()).max(50),
      })
    )
    .query(({ input, ctx }) => listByProductIds(input.productIds, scopeBranch(ctx, input.branchId), input.tier)),

  // قائمة إدارة المنتجات: LEFT JOIN يُظهر حتى المنتجات الناقصة (بلا متغيّرات/وحدات) +
  // تقسيم صفحات خادمي. protectedProcedure لأن /products متاحة لكل الأدوار والمخرَج بلا تكلفة.
  adminList: productsReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        q: z.string().optional(),
        includeInactive: z.boolean().default(false),
        // فلترة بالفئة: رقم = فئة محدّدة، 0 = «بلا فئة» (categoryId NULL)، غياب = الكل.
        categoryId: z.number().int().min(0).optional(),
        limit: z.number().int().positive().max(500).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(({ input, ctx }) => listProductsAdmin({ ...input, branchId: scopeBranch(ctx, input.branchId) })),

  // تفعيل/تعطيل منتج — مدير فأعلى (يغيّر ما يراه الكاشير في البيع).
  setProductActive: productsManagerProcedure
    .input(z.object({ productId: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setProductActive(input.productId, input.isActive, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: input.isActive ? "product.activate" : "product.deactivate",
        entityType: "product",
        entityId: input.productId,
        newValue: { isActive: input.isActive },
      });
      return res;
    }),

  // ملخّص ارتباطات المنتج (نشاط + سبب منع الحذف النهائي إن وُجد ارتباط).
  usage: productsReadProcedure.input(z.object({ productId: z.number().int().positive() })).query(({ input }) => getProductUsage(input.productId)),

  // حذف نهائي — للمنتج «النظيف» فقط (يُمنع مع رسالة عربية تسرد الارتباطات إن وُجدت). مدير فأعلى —
  // نفس مستوى setProductActive (تغيير جذري في الكتالوج).
  delete: productsManagerProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await deleteProduct(input.productId);
      await logAudit(ctx, { action: "product.delete", entityType: "product", entityId: input.productId });
      return res;
    }),

  byBarcode: productsReadProcedure
    .input(z.object({ barcode: z.string().min(1), branchId: z.number().int().positive(), tier, customerId: z.number().int().positive().nullish() }))
    .query(({ input, ctx }) => lookupByBarcode(input.barcode, scopeBranch(ctx, input.branchId), input.tier, input.customerId ?? undefined)),

  // product-variants: تحقّق مسبق من تكرار الباركود قبل الحفظ — `productUnits.barcode` فريد (UNIQUE)
  // فالحفظ يفشل عند التكرار؛ هذا يُظهر تحذيراً لحظياً بأي منتج يحجز الباركود (بدل رحلة حفظ فاشلة).
  // مدير فأعلى (شاشة الإضافة/التعديل manager) ولا يكشف تكلفة.
  checkBarcodes: productsManagerProcedure
    .input(z.object({ codes: z.array(z.string().min(1)).max(2000) }))
    .query(({ input }) => checkBarcodesTaken(input.codes)),

  // Purchase-side product search: carries COST (not a sell price). أدوار الشراء (مدير/أمين
  // مخزن/مسؤول مشتريات) — تحتاجه لإضافة سطور أمر الشراء الذي تُخوَّل إنشاءه؛ محصور بها فلا
  // تتسرّب التكلفة للكاشير/المندوب.
  forPurchase: productsPurchaseProcedure
    .input(z.object({ branchId: z.number().int().positive(), query: z.string().optional(), limit: z.number().default(50) }))
    .query(({ input }) => listForPurchase(input.branchId, input.query, input.limit)),

  createProduct: productsManagerProcedure
    .input(
      z.object({
        // v3-add-screens: نسمح بـname قديم أو أجزاء جديدة. الخدمة تركّب الاسم النهائي.
        name: z.string().max(255).optional(),
        productType: z.string().max(80).nullish(),
        brand: z.string().max(80).nullish(),
        modelName: z.string().max(80).nullish(),
        description: z.string().nullish(),
        categoryId: z.number().int().positive().optional(),
        isCustomizable: z.boolean().optional(),
        // print-catalog: بَند خِدمي (لا مخزون) + توجيهه لنقطة بيع الطباعة + وصفة موادّه الخام.
        isService: z.boolean().optional(),
        printService: z.boolean().optional(),
        showInReception: z.boolean().optional(),
        recipe: z
          .array(z.object({ inputVariantId: z.number().int().positive(), qtyPerOutputBase: z.string() }))
          .max(50)
          .optional(),
        // bundles (٧/٧/٢٦): منتج مركّب (بكج). عند true يجب variants.length=1 + وحدة أساس واحدة + bundleComponents ≥1.
        isBundle: z.boolean().optional(),
        bundleComponents: z
          .array(
            z.object({
              componentVariantId: z.number().int().positive(),
              componentBaseQuantity: z.number().int().positive(),
              componentUnitId: z.number().int().positive().nullish(),
              sortOrder: z.number().int().min(0).max(999).optional(),
              notes: z.string().max(500).nullish(),
            }),
          )
          .max(50)
          .optional(),
        variants: z.array(variantSchema).min(1),
        images: z.array(imageSchema).max(10).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (const v of input.variants) assertValidImageDataUrl(v.image);
      for (const img of input.images ?? []) assertValidImageDataUrl(img.url);
      const res = await createProduct({ ...input, name: input.name ?? "" } as any, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "product.create", entityType: "product", entityId: (res as { productId?: number })?.productId, newValue: { name: input.name, brand: input.brand ?? null, modelName: input.modelName ?? null } });
      return res;
    }),

  // print-catalog: مواد خام لمنتقي وصفة الخدمة (يكشف الكلفة ⇒ مدير فأعلى).
  materialsForRecipe: productsManagerProcedure
    .input(z.object({ query: z.string().optional(), limit: z.number().int().positive().max(200).default(100) }))
    .query(({ input }) => listMaterialsForRecipe(input.query, input.limit)),

  /** v3-add-screens: صور منتج للعرض. */
  productImages: productsReadProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => listProductImages(input.productId)),

  // شاشة التعديل تكشف costPrice ⇒ مدير فأعلى.
  getForEdit: productsManagerProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => getProductForEdit(input.productId)),

  // §٧ (RBAC): updateProduct يكشف costPrice ويعدّل أسعاراً ⇒ مدير فأعلى (كان protectedProcedure
  // وسمح للكاشير بتعديل التكاليف).
  updateProduct: productsManagerProcedure
    .input(
      z.object({
        productId: z.number().int().positive(),
        name: z.string().min(1),
        categoryId: z.number().int().positive().nullish(),
        isCustomizable: z.boolean().optional(),
        isActive: z.boolean().optional(),
        variants: z
          .array(
            z.object({
              id: z.number().int().positive(),
              sku: z.string().min(1),
              variantName: z.string().nullish(),
              color: z.string().nullish(),
              size: z.string().nullish(),
              costPrice: z.string(),
              units: z
                .array(
                  z.object({
                    id: z.number().int().positive().optional(),
                    unitName: z.string().min(1),
                    conversionFactor: z.string(),
                    barcode: z.string().nullish(),
                    isBaseUnit: z.boolean().optional(),
                    prices: z.array(priceSchema).optional(),
                  })
                )
                .min(1),
            })
          )
          .min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // §٧ audit oldValue: لقطة سريعة قبل التحديث (للتدقيق الفروقات).
      // H6 (تدقيق ٢٣/٦/٢٦): كان السجلّ يَلتقط sku/costPrice فقط — أسعار البيع (priceTier × unit)
      // كانت تَتغيّر بلا أَثر تاريخي. سيناريو: موظّف يَخفض سعر صنف لزبون-شريك، يَبيع كميات، ثمّ
      // يُعيد السعر — كل البيوع تَبدو طبيعية وسجلّ التعديل لا يُظهر تَلاعب الأسعار. الآن نَلتقط
      // units (مع barcode + isBaseUnit) و prices (priceTier+price) في القبل والبعد ⇒ كَشف فروقي.
      const before = await getProductForEdit(input.productId);
      const oldVariantsSummary = before?.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        costPrice: v.costPrice,
        units: v.units.map((u) => ({
          id: u.id,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          isBaseUnit: u.isBaseUnit,
          barcode: u.barcode,
          prices: u.prices, // priceTier+price لكل وحدة (RETAIL/WHOLESALE/GOVERNMENT)
        })),
      })) ?? [];
      const res = await updateProduct(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "product.update",
        entityType: "product",
        entityId: input.productId,
        oldValue: { name: before?.name, isActive: before?.isActive, variants: oldVariantsSummary },
        newValue: {
          name: input.name,
          isActive: input.isActive,
          variants: input.variants.map((v) => ({
            id: v.id,
            sku: v.sku,
            costPrice: v.costPrice,
            units: v.units.map((u) => ({
              id: u.id ?? null,
              unitName: u.unitName,
              conversionFactor: u.conversionFactor,
              isBaseUnit: u.isBaseUnit,
              barcode: u.barcode,
              prices: u.prices, // تَلتقط أيّ تَغيير في أسعار البيع — الحارس الفعلي ضدّ تلاعب الأسعار.
            })),
          })),
        },
      });
      return res;
    }),

  // product-variants: قراءة منتج بكامل متغيّراته للتعديل (يكشف costPrice ⇒ مدير فأعلى).
  getForVariantEdit: productsManagerProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => getProductForVariantEdit(input.productId)),

  // product-variants: تعديل منتج بنموذج المتغيّرات (تحديث/إضافة/تعطيل) ⇒ مدير فأعلى.
  updateProductVariants: productsManagerProcedure
    .input(
      z.object({
        productId: z.number().int().positive(),
        name: z.string().max(255).nullish(),
        productType: z.string().max(80).nullish(),
        brand: z.string().max(80).nullish(),
        modelName: z.string().max(80).nullish(),
        description: z.string().nullish(),
        categoryId: z.number().int().positive().nullish(),
        isCustomizable: z.boolean().optional(),
        isActive: z.boolean().optional(),
        unitTemplate: z.array(updateUnitTemplateSchema).min(1),
        variants: z.array(editVariantSchema).min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (const v of input.variants) assertValidImageDataUrl(v.image);
      const before = await getProductForVariantEdit(input.productId);
      const res = await updateProductWithVariants(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "product.update",
        entityType: "product",
        entityId: input.productId,
        oldValue: { name: before?.name, variants: before?.variants.map((v) => ({ id: v.id, sku: v.sku, isActive: v.isActive })) ?? [] },
        newValue: {
          name: input.name,
          added: (res as { added?: number }).added ?? 0,
          variants: input.variants.map((v) => ({ id: v.id ?? null, sku: v.sku, isActive: v.isActive })),
        },
      });
      return res;
    }),

  assignBarcode: productsManagerProcedure
    .input(z.object({ productUnitId: z.number().int().positive(), barcode: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const res = await assignBarcode(input.productUnitId, input.barcode);
      await logAudit(ctx, { action: "product.assignBarcode", entityType: "productUnit", entityId: input.productUnitId, newValue: { barcode: input.barcode } });
      return res;
    }),

  /** الباركودات البديلة لوحدة المنتج (aliases): نفس السلعة/التكلفة/السعر/المخزون بعدّة باركودات. */
  listUnitBarcodes: productsReadProcedure
    .input(z.object({ productUnitId: z.number().int().positive() }))
    .query(({ input }) => listUnitBarcodes(input.productUnitId)),

  /** بدائل عدّة وحدات دفعةً واحدة — منتقي «أيّ باركود يُطبع؟» في شاشة الملصقات (بلا N+1). */
  listUnitBarcodesMany: productsReadProcedure
    .input(z.object({ productUnitIds: z.array(z.number().int().positive()).max(500) }))
    .query(({ input }) => listUnitBarcodesMany(input.productUnitIds)),

  /** يحلّ (variantId + unitName) إلى productUnitId — يُستعمَل من الواجهة لفتح شاشة البدائل. */
  resolveProductUnitId: productsReadProcedure
    .input(z.object({ variantId: z.number().int().positive(), unitName: z.string().min(1).max(40) }))
    .query(({ input }) => resolveProductUnitId(input.variantId, input.unitName)),

  addUnitBarcodeAlias: productsManagerProcedure
    .input(
      z.object({
        productUnitId: z.number().int().positive(),
        barcode: z.string().min(1).max(64),
        note: z.string().max(255).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await addUnitBarcodeAlias(
        input.productUnitId,
        input.barcode,
        input.note ?? null,
        ctx.user.id,
      );
      await logAudit(ctx, {
        action: "productUnit.addBarcodeAlias",
        entityType: "productUnit",
        entityId: input.productUnitId,
        newValue: { barcode: input.barcode.trim(), note: input.note ?? null },
      });
      return res;
    }),

  removeUnitBarcodeAlias: productsManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await removeUnitBarcodeAlias(input.id);
      await logAudit(ctx, {
        action: "productUnit.removeBarcodeAlias",
        entityType: "productUnitBarcode",
        entityId: input.id,
      });
      return res;
    }),

  /** قائمة الفئات (لمنتقي الفئة في شاشات المنتج ونطاق الجرد «حسب الفئة»). */
  categories: productsReadProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .orderBy(asc(categories.name));
  }),

  /* ============================ إدارة الفئات (categories CRUD + دمج + نقل) ============================ */

  /** قائمة الفئات بعدد منتجاتها لشاشة الإدارة (يكشف عدّاً فقط ⇒ مدير فأعلى). */
  categoriesAdmin: productsManagerProcedure.query(() => listCategoriesAdmin()),

  createCategory: productsManagerProcedure
    .input(z.object({ name: z.string().min(1).max(255), description: z.string().max(1000).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const res = await createCategory(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "category.create", entityType: "category", entityId: res.id, newValue: { name: res.name } });
      return res;
    }),

  updateCategory: productsManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().max(1000).nullish(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateCategory(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "category.update",
        entityType: "category",
        entityId: input.id,
        newValue: { name: input.name, description: input.description, isActive: input.isActive },
      });
      return res;
    }),

  deleteCategory: productsManagerProcedure
    .input(z.object({ id: z.number().int().positive(), reassignToId: z.number().int().positive().nullish() }))
    .mutation(async ({ input, ctx }) => {
      const res = await deleteCategory(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "category.delete",
        entityType: "category",
        entityId: input.id,
        newValue: { reassigned: res.reassigned, reassignedTo: res.reassignedTo },
      });
      return res;
    }),

  mergeCategories: productsManagerProcedure
    .input(z.object({ sourceIds: z.array(z.number().int().positive()).min(1), targetId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await mergeCategories(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "category.merge",
        entityType: "category",
        entityId: input.targetId,
        oldValue: { sourceIds: input.sourceIds },
        newValue: { moved: res.moved, deleted: res.deleted, targetId: res.targetId },
      });
      return res;
    }),

  /** نقل منتجات محدّدة إلى فئة (categoryId=null ⇒ بلا فئة) — للنقل الجماعي من قائمة المنتجات. */
  reassignProducts: productsManagerProcedure
    .input(z.object({ productIds: z.array(z.number().int().positive()).min(1).max(2000), categoryId: z.number().int().positive().nullable() }))
    .mutation(async ({ input, ctx }) => {
      const res = await reassignProducts(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "product.reassignCategory",
        entityType: "product",
        entityId: input.productIds[0] ?? null,
        newValue: { productIds: input.productIds, categoryId: input.categoryId, moved: res.moved },
      });
      return res;
    }),
});
