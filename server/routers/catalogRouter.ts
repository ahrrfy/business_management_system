import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { asc, eq, sql } from "drizzle-orm";
import { categories, productVariants } from "../../drizzle/schema";
import { getDb } from "../db";
import { assignBarcode, checkBarcodesTaken, createProduct, deleteProduct, getProductForEdit, listByProductIds, listByUnitIds, listForPos, listForPurchase, listMaterialsForRecipe, listProductImages, listProductsAdmin, listStockByUnitIds, lookupByBarcode, setProductActive, updateProduct } from "../services/catalogService";
import { getProductForVariantEdit, updateProductWithVariants } from "../services/productEditService";
import { addUnitBarcodeAlias, listUnitBarcodes, listUnitBarcodesMany, removeUnitBarcodeAlias, resolveProductUnitId } from "../services/catalog/barcodeAliases";
import { findSimilarProductNames } from "../services/catalog/similarNames";
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
import { syncActiveFullStocktakeScopes } from "../services/stocktakeService";
import { canSeeCostForUser, productsManagerProcedure, productsPurchaseProcedure, productsReadProcedure, router } from "../trpc";
import { assertValidImageDataUrl } from "../lib/imageValidation";
import { checkVariantSanity, classifySeverity, type UnitPricing } from "../../shared/priceSanity";
import {
  getProductCustomizationTemplate,
  saveProductCustomizationTemplate,
  setProductCustomizationTemplateActive,
} from "../services/productCustomizationService";

const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).default("RETAIL");

// IDOR (تدقيق ٢/٧): posList/adminList/byBarcode كانت تثق بـbranchId العميل ⇒ أي مستخدم مصادَق
// يقرأ مخزون أي فرع بتمرير معرّفه. عزل مدير الفرع (قرار المالك ١٢/٨): غير العابر (كاشير/مخزن/مدير)
// يُقيَّد بفرعه المُسنَد؛ المالك/الأدمن وحدهما يعبُران. المنتجات/الأسعار مشتركة؛ المحجوب كمية مخزون الفرع.
function scopeBranch(ctx: { user: { role: string; branchId?: number | null } }, requested: number): number {
  const elevated = ctx.user.role === "admin";
  if (elevated) return requested;
  // عزل صارم (تدقيق ١٧/٧): غير المرتفع بلا فرع مُسنَد كان يقرأ مخزون الفرع المطلوب من العميل ⇒ تسريب
  // كميات أي فرع عبر posList/adminList/byBarcode. نرفض بدل الوثوق بمدخل العميل (اتفاقية scopedBranch).
  if (ctx.user.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
  }
  return Number(ctx.user.branchId);
}

/**
 * حجب `costPriceBase` من صفوف نتائج POS (بحث/باركود/معرّفات) لغير المخوَّلين برؤية التكلفة.
 * التكلفة تُحمَل دائماً في الاستعلام كي تصل لشاشات المبيعات المتقدّمة (مدير/أدمن) عبر شريط
 * البحث الموحَّد؛ الحجب هنا في نقطة الخروج (نمط `redact.ts`) فلا تتسرّب عبر شبكة tRPC إلى
 * الكاشير. `canSeeCostForUser` يحترم القوالب والمنح الصريحة على السواء (`server/trpc.ts:190`).
 */
function redactPosCost<T extends { costPriceBase?: string | null }>(rows: T[], user: { role: string; permissionsOverride?: unknown }): T[] {
  if (canSeeCostForUser(user)) return rows;
  return rows.map((r) => ({ ...r, costPriceBase: null }));
}
function redactPosCostOne<T extends { costPriceBase?: string | null }>(row: T | null, user: { role: string; permissionsOverride?: unknown }): T | null {
  if (row == null) return row;
  if (canSeeCostForUser(user)) return row;
  return { ...row, costPriceBase: null };
}

const priceSchema = z.object({ priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]), price: z.string() });
const customizationOptionSchema = z.object({ value: z.string().min(1).max(120), label: z.string().min(1).max(160), priceDelta: z.string().max(32).optional() });
const customizationDependencySchema = z.object({
  fieldKey: z.string().min(1).max(80),
  operator: z.enum(["equals", "notEquals"]),
  value: z.union([z.string().min(1).max(120), z.array(z.string().min(1).max(120)).min(1).max(50)]),
});
const customizationFieldSchema = z.object({
  id: z.number().int().positive().optional(),
  fieldKey: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{1,79}$/),
  label: z.string().min(1).max(160),
  fieldType: z.enum(["TEXT", "TEXTAREA", "SELECT", "FILE", "NUMBER", "SWATCH"]),
  isRequired: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  maxLength: z.number().int().min(1).max(10_000).nullish(),
  options: z.array(customizationOptionSchema).max(100).optional(),
  dependency: customizationDependencySchema.nullish(),
  priceDelta: z.string().max(32).optional(),
  isActive: z.boolean().optional(),
});
const customizationTemplateSchema = z.object({
  productId: z.number().int().positive(),
  kind: z.enum(["PRINT", "GIFT", "GENERAL"]),
  title: z.string().min(1).max(160),
  description: z.string().max(2000).nullish(),
  isActive: z.boolean().optional(),
  fields: z.array(customizationFieldSchema).max(50),
});
const barcodeAliasSchema = z.object({
  barcode: z.string().min(1).max(64),
  note: z.string().max(255).optional().nullable(),
});
const unitSchema = z.object({
  unitName: z.string().min(1),
  conversionFactor: z.string(),
  barcode: z.string().optional(),
  isBaseUnit: z.boolean().optional(),
  isStoreSaleUnit: z.boolean().optional(),
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
  // توافق قديم فقط: الخدمة ترفض قيمةً جديدة؛ الصور تُنشَر عبر Product Studio/R2.
  image: z.string().max(5_000_000).optional(),
  units: z.array(unitSchema).min(1),
});

// product-variants: تعديل منتج بنموذج المتغيّرات (قالب وحدات مشترك + باركود لكل متغيّر بالاسم).
const updateUnitTemplateSchema = z.object({
  unitName: z.string().min(1),
  conversionFactor: z.string(),
  isBaseUnit: z.boolean(),
  isStoreSaleUnit: z.boolean().optional(),
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
  // priceSanity L1.7: سبب تغيير التكلفة (يُفرَض إن الشذوذ blocker/catastrophic خادمياً).
  costChangeReason: z.string().max(500).nullish(),
  baseRetail: z.string().optional(),
  minStock: z.number().int().min(0).max(1_000_000).optional(),
  reorderPoint: z.number().int().min(0).max(1_000_000).optional(),
  isActive: z.boolean().optional(),
  // صورة اللون: string مطابق للمخزَّن ⇒ بلا تغيير، null/"" ⇒ إزالة، وقيمة جديدة ⇒ رفض.
  image: z.string().max(5_000_000).nullish(),
  unitBarcodes: z.record(z.string(), z.string()),
  // توسعة بدائل الباركود من شاشة التعديل (٣/٨): بمفتاح اسم الوحدة، القائمة الكاملة المرغوبة لكل
  // وحدة — تُوفَّق بعد نجاح الحفظ الرئيسي (انظر reconcileEditBarcodeAliases). اختياري تماماً؛
  // غيابه = لا مسّ للبدائل القائمة (توافق عكسي كامل مع الحمولة الحالية).
  barcodeAliases: z.record(z.string(), z.array(barcodeAliasSchema).max(20)).optional(),
});

// توافق حمولة الإنشاء القديمة: url يبقى في العقد لإرجاع خطأ واضح، لكن الخدمة ترفض النشر المباشر.
const imageSchema = z.object({
  // v3-add-screens(100%): TEXT في DB ⇒ نسمح بـdata URLs الكبيرة (5MB كحد عملي).
  url: z.string().min(1).max(5_000_000),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

// صور التعديل: id مملوك ⇒ metadata/إزالة؛ url جديد أو مستبدَل ترفضه الخدمة لصالح Product Studio.
const editImageSchema = z.object({
  id: z.number().int().positive().optional(),
  url: z.string().min(1).max(5_000_000).nullish(),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

/**
 * حرّاس عقلانية على تكلفة/سعر/معامل — دفاعٌ في العمق ضدّ أيّ عميل يتجاوز حرّاس الواجهة
 * (حادثة SINARLINE ٣٠/٧: تكلفة 16162 vs بيع 2000 ⇒ توقّف كاشير ساعات). يُطبَّق قبل استدعاء
 * الخدمة في المسارات الثلاثة (createProduct/updateProduct/updateProductVariants) — يرمي
 * TRPCError بـBAD_REQUEST بلا تعديل الحالة. المصدر مشترك: shared/priceSanity.ts.
 *
 * الاستعمال:
 *   assertVariantSanityOrThrow(variantLabel, costPriceStr, unitsForCheck);
 *   حيث unitsForCheck: صفيف {unitName, conversionFactor:number, retail?, wholesale?, government?}
 */
function assertVariantSanityOrThrow(variantLabel: string, costPrice: string, units: UnitPricing[]): void {
  const issues = checkVariantSanity(costPrice, units);
  const blocker = issues.find((i) => i.level === "blocker");
  if (blocker) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `[${variantLabel}] ${blocker.message}` });
  }
}

/**
 * **priceSanity L1.7 (٣٠/٧):** حارس السبب الإلزاميّ. عند تغيير التكلفة بنسبة ≥ ٥× مقارنةً بالقيمة
 * السابقة (blocker حسب `classifySeverity`)، يجب أن يمرَّر `costChangeReason` بمحارف ≥ ١٠.
 * يمنع تغييرات صامتة كارثيّة (حالة SINARLINE) من الاستيراد أو استعادات المسودّات.
 */
function assertCostChangeReasonOrThrow(variantLabel: string, oldCost: string | number | null | undefined, newCost: string | number, reason: string | null | undefined): void {
  const sev = classifySeverity(newCost, { oldCost: oldCost ?? null });
  if (sev === "blocker" || sev === "catastrophic") {
    const r = (reason ?? "").trim();
    if (r.length < 10) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `[${variantLabel}] تغيير التكلفة كبير جداً (من ${oldCost ?? "؟"} إلى ${newCost}). يرجى إضافة سبب مكتوب (≥ ١٠ محارف) في حقل «سبب تغيير التكلفة».`,
      });
    }
  }
}

/**
 * توفيق بدائل الباركود (productUnitBarcodes) بعد نجاح `updateProductWithVariants` — عمداً
 * **خارج** معاملة الخدمة نفسها: `productEditService.ts` مملوكٌ لجلسةٍ أخرى تعمل عليه اليوم (لا
 * يجوز لمسه)، والدوال المستوردة أعلاه (add/removeUnitBarcodeAlias) مستقلّة الذرّية أصلاً — نفس
 * ما تستعمله `addUnitBarcodeAlias`/`removeUnitBarcodeAlias` كإجراءين منفصلين قائمين في هذا
 * الراوتر. المطابقة بـsku (فريد داخل المنتج — `assertEditUniqueness` في الخدمة يضمنه) لا بـid
 * الوارد في الحمولة، كي تعمل مع متغيّرٍ جديدٍ أُضيف في نفس الحفظة (لا id معروف مسبقاً له).
 * الأخطاء (باركود متعارض إلخ) تُجمَع كتحذيراتٍ لا تُفشل الحفظ الرئيسي الذي نجح فعلاً.
 */
async function reconcileEditBarcodeAliases(
  productId: number,
  variants: Array<{ sku: string; barcodeAliases?: Record<string, Array<{ barcode: string; note?: string | null }>> }>,
  actorUserId: number,
): Promise<string[]> {
  const withAliases = variants.filter((v) => v.barcodeAliases && Object.keys(v.barcodeAliases).length > 0);
  if (!withAliases.length) return [];
  const db = getDb();
  if (!db) return [];
  const warnings: string[] = [];
  const current = await db
    .select({ id: productVariants.id, sku: productVariants.sku })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
  for (const v of withAliases) {
    const variantRow = current.find((c) => c.sku === v.sku.trim());
    if (!variantRow) {
      warnings.push(`تعذّر تحديد المتغيّر «${v.sku}» لتوفيق بدائله — لم يُعثر عليه بعد الحفظ.`);
      continue;
    }
    for (const [unitName, desired] of Object.entries(v.barcodeAliases ?? {})) {
      const productUnitId = await resolveProductUnitId(Number(variantRow.id), unitName);
      if (!productUnitId) continue; // وحدة غير موجودة (اسمٌ لم يعد في القالب) — لا بدائل لها أصلاً.
      const { aliases: existing } = await listUnitBarcodes(productUnitId);
      const desiredCodes = new Set(desired.map((d) => d.barcode.trim()).filter(Boolean));
      for (const ex of existing) {
        if (desiredCodes.has(ex.barcode)) continue;
        try {
          await removeUnitBarcodeAlias(ex.id);
        } catch (e) {
          warnings.push(e instanceof TRPCError ? e.message : `تعذّر حذف البديل ${ex.barcode}`);
        }
      }
      const existingCodes = new Set(existing.map((e) => e.barcode));
      for (const d of desired) {
        const code = d.barcode.trim();
        if (!code || existingCodes.has(code)) continue;
        try {
          await addUnitBarcodeAlias(productUnitId, code, d.note ?? null, actorUserId);
        } catch (e) {
          warnings.push(e instanceof TRPCError ? e.message : `تعذّر إضافة البديل ${code}`);
        }
      }
    }
  }
  return warnings;
}

export const catalogRouter = router({
  posList: productsReadProcedure
    // بند 12ب (٧/٧): customerId اختياري — عميل بسعر تعاقدي نشط يرى سعره بدل سعر الفئة (isContractPrice).
    // includeAllServices (١٢/٨/٢٦): شاشة فاتورة البيع المتقدّمة تحتاج كل خدمات الطباعة (بلا شرط
    // showInReception). createSale يتعامل مع الخدمة بتوسيع وصفتها لخصم المواد وحساب COGS.
    .input(z.object({ branchId: z.number().int().positive(), tier, query: z.string().optional(), limit: z.number().int().positive().max(1000).default(200), includeReceptionServices: z.boolean().optional(), includeAllServices: z.boolean().optional(), customerId: z.number().int().positive().nullish() }))
    .query(async ({ input, ctx }) => {
      const rows = await listForPos(scopeBranch(ctx, input.branchId), input.tier, input.query, input.limit, { includeReceptionServices: input.includeReceptionServices, includeAllServices: input.includeAllServices, customerId: input.customerId ?? undefined });
      return redactPosCost(rows, ctx.user);
    }),

  // تحديث خفيف وموثوق للرصيد داخل السلال المفتوحة/المستعادة. يعيد الفرع الفعلي بعد العزل
  // حتى لا تعرض الواجهة اسم فرعٍ بينما الخادم قرأ فرع حساب المستخدم.
  stockByUnitIds: productsReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        productUnitIds: z.array(z.number().int().positive()).max(500),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopeBranch(ctx, input.branchId);
      return { branchId, rows: await listStockByUnitIds(input.productUnitIds, branchId) };
    }),

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
    .query(async ({ input, ctx }) => {
      const rows = await listByUnitIds(input.productUnitIds, scopeBranch(ctx, input.branchId), input.tier);
      return redactPosCost(rows, ctx.user);
    }),

  // شاشة الملصقات: «أضِف كلّ ألوان/وحدات المنتج» — كلّ صفوف (متغيّر × وحدة) لمنتجٍ واحد.
  byProductIds: productsReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        tier,
        productIds: z.array(z.number().int().positive()).max(50),
      })
    )
    .query(async ({ input, ctx }) => {
      const rows = await listByProductIds(input.productIds, scopeBranch(ctx, input.branchId), input.tier);
      return redactPosCost(rows, ctx.user);
    }),

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
    .query(({ input, ctx }) =>
      listProductsAdmin(
        { ...input, branchId: scopeBranch(ctx, input.branchId) },
        // قرار المالك: هذان الحقلان لهذه القائمة حصراً للمالك (admin) ومدير الفرع.
        // لا نعتمد على إخفاء الواجهة؛ الخدمة تعيد null لكل دور آخر.
        { includeSensitivePrices: ctx.user.role === "admin" || ctx.user.role === "manager" },
      )
    ),

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
    .query(async ({ input, ctx }) => {
      const row = await lookupByBarcode(input.barcode, scopeBranch(ctx, input.branchId), input.tier, input.customerId ?? undefined);
      return redactPosCostOne(row, ctx.user);
    }),

  // product-variants: تحقّق مسبق من تكرار الباركود قبل الحفظ — `productUnits.barcode` فريد (UNIQUE)
  // فالحفظ يفشل عند التكرار؛ هذا يُظهر تحذيراً لحظياً بأي منتج يحجز الباركود (بدل رحلة حفظ فاشلة).
  // مدير فأعلى (شاشة الإضافة/التعديل manager) ولا يكشف تكلفة.
  checkBarcodes: productsManagerProcedure
    .input(z.object({ codes: z.array(z.string().min(1)).max(2000) }))
    .query(({ input }) => checkBarcodesTaken(input.codes)),

  // name-assistant: مشابهات اسم حيّة أثناء إضافة/تعديل منتج — تمنع ازدواج الكتالوج عند المصدر
  // (٩٤٠٠+ صنف مستورد بأسماء غير منضبطة). نفس بوّابة الشاشة (مدير فأعلى)، لا تكشف تكلفة.
  similarNames: productsManagerProcedure
    .input(
      z.object({
        name: z.string().min(2).max(255),
        excludeProductId: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(20).default(8),
      })
    )
    .query(({ input }) => findSimilarProductNames(input.name, { excludeProductId: input.excludeProductId, limit: input.limit })),

  // Purchase-side product search: carries COST (not a sell price). أدوار الشراء (مدير/أمين
  // مخزن/مسؤول مشتريات) — تحتاجه لإضافة سطور أمر الشراء الذي تُخوَّل إنشاءه؛ محصور بها فلا
  // تتسرّب التكلفة للكاشير/المندوب.
  forPurchase: productsPurchaseProcedure
    .input(z.object({ branchId: z.number().int().positive(), query: z.string().optional(), limit: z.number().int().positive().max(500).default(50) }))
    .query(({ input, ctx }) => listForPurchase(scopeBranch(ctx, input.branchId), input.query, input.limit)),

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
        // بضاعة الأمانة (٢٠/٧): وسم المنتج + مودِعه (الحصة في variants[].costPrice). التحقّق خادمياً.
        isConsignment: z.boolean().optional(),
        consignorId: z.number().int().positive().nullish(),
        variants: z.array(variantSchema).min(1),
        images: z.array(imageSchema).max(10).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (const v of input.variants) assertValidImageDataUrl(v.image, 2_000_000, true);
      for (const img of input.images ?? []) assertValidImageDataUrl(img.url, 2_000_000, true);
      // priceSanity (٣٠/٧): كل متغيّر يمرّ بحرّاس التكلفة/السعر/المعامل — يمنع القيم الفلكية (تكلفة
      // > سعر البيع بـ٥×) خادمياً حتى لو تجاوزها العميل. البكج/الأمانة لا يُستثنيان (نفس البوّابة).
      for (const v of input.variants) {
        const pricings: UnitPricing[] = v.units.map((u) => ({
          unitName: u.unitName,
          conversionFactor: u.isBaseUnit ? 1 : Number(u.conversionFactor) || 0,
          retail: u.prices?.find((p) => p.priceTier === "RETAIL")?.price ?? null,
          wholesale: u.prices?.find((p) => p.priceTier === "WHOLESALE")?.price ?? null,
          government: u.prices?.find((p) => p.priceTier === "GOVERNMENT")?.price ?? null,
        }));
        assertVariantSanityOrThrow(v.color || v.sku, v.costPrice, pricings);
      }
      const res = await createProduct({ ...input, name: input.name ?? "" } as any, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      // الجرد الشامل الحي: ألحق الصنف الجديد بأي جلسة FULL ما زالت قيد العد.
      await syncActiveFullStocktakeScopes();
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
              // priceSanity L1.7: سبب تغيير التكلفة (إلزاميّ خادمياً إن الشذوذ blocker/catastrophic).
              costChangeReason: z.string().max(500).nullish(),
              units: z
                .array(
                  z.object({
                    id: z.number().int().positive().optional(),
                    unitName: z.string().min(1),
                    conversionFactor: z.string(),
                    barcode: z.string().nullish(),
                    isBaseUnit: z.boolean().optional(),
                    isStoreSaleUnit: z.boolean().optional(),
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
      // priceSanity (٣٠/٧): حرّاس تكلفة/سعر/معامل قبل الحفظ — انظر تعريف assertVariantSanityOrThrow.
      for (const v of input.variants) {
        const pricings: UnitPricing[] = v.units.map((u) => ({
          unitName: u.unitName,
          conversionFactor: u.isBaseUnit ? 1 : Number(u.conversionFactor) || 0,
          retail: u.prices?.find((p) => p.priceTier === "RETAIL")?.price ?? null,
          wholesale: u.prices?.find((p) => p.priceTier === "WHOLESALE")?.price ?? null,
          government: u.prices?.find((p) => p.priceTier === "GOVERNMENT")?.price ?? null,
        }));
        assertVariantSanityOrThrow(v.color || v.sku, v.costPrice, pricings);
      }
      // §٧ audit oldValue: لقطة سريعة قبل التحديث (للتدقيق الفروقات).
      // H6 (تدقيق ٢٣/٦/٢٦): كان السجلّ يَلتقط sku/costPrice فقط — أسعار البيع (priceTier × unit)
      // كانت تَتغيّر بلا أَثر تاريخي. سيناريو: موظّف يَخفض سعر صنف لزبون-شريك، يَبيع كميات، ثمّ
      // يُعيد السعر — كل البيوع تَبدو طبيعية وسجلّ التعديل لا يُظهر تَلاعب الأسعار. الآن نَلتقط
      // units (مع barcode + isBaseUnit) و prices (priceTier+price) في القبل والبعد ⇒ كَشف فروقي.
      const before = await getProductForEdit(input.productId);
      // priceSanity L1.7: حارس السبب — إن تغيّرت التكلفة بنسبة ≥ ٥×، السبب المكتوب إلزاميّ.
      for (const v of input.variants) {
        const oldVariant = before?.variants.find((ov) => ov.id === v.id);
        if (oldVariant) {
          assertCostChangeReasonOrThrow(v.color || v.sku, oldVariant.costPrice, v.costPrice, v.costChangeReason);
        }
      }
      const oldVariantsSummary = before?.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        costPrice: v.costPrice,
        units: v.units.map((u) => ({
          id: u.id,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          isBaseUnit: u.isBaseUnit,
          isStoreSaleUnit: u.isStoreSaleUnit,
          barcode: u.barcode,
          prices: u.prices, // priceTier+price لكل وحدة (RETAIL/WHOLESALE/GOVERNMENT)
        })),
      })) ?? [];
      const res = await updateProduct(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await syncActiveFullStocktakeScopes();
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
            // priceSanity L1.7: نلتقط سبب تغيير التكلفة في الأثر التدقيقي إن أُرسل.
            costChangeReason: v.costChangeReason ?? null,
            units: v.units.map((u) => ({
              id: u.id ?? null,
              unitName: u.unitName,
              conversionFactor: u.conversionFactor,
              isBaseUnit: u.isBaseUnit,
              isStoreSaleUnit: u.isStoreSaleUnit,
              barcode: u.barcode,
              prices: u.prices, // تَلتقط أيّ تَغيير في أسعار البيع — الحارس الفعلي ضدّ تلاعب الأسعار.
            })),
          })),
        },
      });
      return res;
    }),

  /** قالب التخصيص المنظم لصفحة إدارة المنتج — يقرأه المدير فقط. */
  customizationTemplate: productsManagerProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => getProductCustomizationTemplate(input.productId)),

  /** حفظ قالب التخصيص وحقوله وتبعياته بشكل ذري. */
  saveCustomizationTemplate: productsManagerProcedure
    .input(customizationTemplateSchema)
    .mutation(async ({ input, ctx }) => {
      const result = await saveProductCustomizationTemplate(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "product.customizationTemplate.save",
        entityType: "productCustomizationTemplate",
        entityId: result.id,
        newValue: { productId: input.productId, kind: input.kind, fieldCount: input.fields.length },
      });
      return result;
    }),

  /** إيقاف/تفعيل قالب التخصيص دون حذف تاريخه. */
  setCustomizationTemplateActive: productsManagerProcedure
    .input(z.object({ productId: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const result = await setProductCustomizationTemplateActive(input.productId, input.isActive, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: input.isActive ? "product.customizationTemplate.activate" : "product.customizationTemplate.deactivate",
        entityType: "productCustomizationTemplate",
        entityId: input.productId,
        newValue: { isActive: input.isActive },
      });
      return result;
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
        isConsignment: z.boolean().optional(),
        consignorId: z.number().int().positive().nullish(),
        unitTemplate: z.array(updateUnitTemplateSchema).min(1),
        variants: z.array(editVariantSchema).min(1),
        // product-image-edit: صور المنتج العامّة (variantId=NULL). غياب الحقل ⇒ لا تُمَسّ؛ مصفوفة ⇒ توفيق.
        images: z.array(editImageSchema).max(10).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (const v of input.variants) if (v.image?.startsWith("data:")) assertValidImageDataUrl(v.image, 2_000_000, true);
      // URL قديم مطابق للمخزَّن يمر لتعديل metadata؛ الخدمة ترفض أيّ إضافة/استبدال خارج Product Studio.
      // Data URL وحدها تحتاج فحص البايتات هنا قبل وصولها إلى حارس الخدمة fail-closed.
      for (const img of input.images ?? []) if (img.url?.startsWith("data:")) assertValidImageDataUrl(img.url, 2_000_000, true);
      // priceSanity (٣٠/٧): كل متغيّر يمرّ بحرّاس التكلفة/السعر/المعامل من قالب الوحدات المشترك
      // (baseRetail يمرَّر عبر السطر ⇒ يتقدّم على المشترك للوحدة الأساس). المصدر: shared/priceSanity.
      for (const v of input.variants) {
        const pricings: UnitPricing[] = input.unitTemplate.map((u) => {
          const priceOf = (tier: "RETAIL" | "WHOLESALE" | "GOVERNMENT") =>
            u.prices.find((p) => p.priceTier === tier)?.price ?? null;
          const retail = u.isBaseUnit && v.baseRetail ? v.baseRetail : priceOf("RETAIL");
          return {
            unitName: u.unitName,
            conversionFactor: u.isBaseUnit ? 1 : Number(u.conversionFactor) || 0,
            retail,
            wholesale: priceOf("WHOLESALE"),
            government: priceOf("GOVERNMENT"),
          };
        });
        assertVariantSanityOrThrow(v.color || v.sku, v.costPrice, pricings);
      }
      const before = await getProductForVariantEdit(input.productId);
      // priceSanity L1.7: حارس السبب — إن تغيّرت التكلفة بنسبة ≥ ٥×، السبب المكتوب إلزاميّ.
      for (const v of input.variants) {
        const oldVariant = before?.variants.find((ov) => ov.id === v.id);
        if (oldVariant) {
          assertCostChangeReasonOrThrow(v.color || v.sku, oldVariant.costPrice, v.costPrice, v.costChangeReason);
        }
      }
      const res = await updateProductWithVariants(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      // يغطي إضافة متغيّر جديد إلى منتج قائم أيضاً.
      await syncActiveFullStocktakeScopes();
      // بدائل الباركود (توسعة ٣/٨): بعد نجاح الحفظ الرئيسي — انظر تعليق reconcileEditBarcodeAliases.
      const aliasWarnings = await reconcileEditBarcodeAliases(input.productId, input.variants, ctx.user.id);
      await logAudit(ctx, {
        action: "product.update",
        entityType: "product",
        entityId: input.productId,
        // المسار د-١ (١٧/٨): لقطة التدقيق كانت `{id, sku, isActive}` فقط ⇒ **تعديل سعرٍ أو تكلفةٍ
        // لا يترك أيّ أثرٍ رقميّ**: يبقى «مَن ومتى» بلا «مِن كم إلى كم»، فلا يمكن مراجعة تسعيرٍ
        // بأثرٍ رجعيّ ولا ردّ اعتراضِ زبونٍ على سعر. أُضيفت التكلفة وسعر وحدة الأساس لكل متغيّر
        // وشرائح أسعار الوحدات على الطرفين. (لا آلية إعادة تقييمٍ جديدة — `postCostRevaluation`
        // قائمةٌ وتُرحّل قيد ADJUST؛ إضافة طبقةٍ ثانية كانت ستُنتج قيوداً مزدوجة.)
        oldValue: {
          name: before?.name,
          variants:
            before?.variants.map((v) => ({
              id: v.id, sku: v.sku, isActive: v.isActive,
              costPrice: v.costPrice, baseRetail: v.baseRetail,
            })) ?? [],
          unitPrices:
            before?.unitTemplate.map((u) => ({
              unitName: u.unitName, retail: u.retail, wholesale: u.wholesale, government: u.government,
            })) ?? [],
        },
        newValue: {
          name: input.name,
          added: (res as { added?: number }).added ?? 0,
          variants: input.variants.map((v) => ({
            id: v.id ?? null, sku: v.sku, isActive: v.isActive,
            costPrice: v.costPrice, baseRetail: v.baseRetail ?? null,
          })),
          unitPrices: input.unitTemplate.map((u) => ({
            unitName: u.unitName,
            retail: u.prices.find((p) => p.priceTier === "RETAIL")?.price ?? null,
            wholesale: u.prices.find((p) => p.priceTier === "WHOLESALE")?.price ?? null,
            government: u.prices.find((p) => p.priceTier === "GOVERNMENT")?.price ?? null,
          })),
        },
      });
      return { ...res, aliasWarnings };
    }),

  assignBarcode: productsManagerProcedure
    .input(z.object({ productUnitId: z.number().int().positive(), barcode: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const res = await assignBarcode(input.productUnitId, input.barcode);
      await logAudit(ctx, { action: "product.assignBarcode", entityType: "productUnit", entityId: input.productUnitId, newValue: { barcode: input.barcode } });
      return res;
    }),

  /**
   * **priceSanity L1.4 (٣٠/٧):** إحصاءات فئة/ماركة/نوع منتج — للمرافق الحيّ في `MoneyInput`.
   * تعيد min/max/median للتكلفة على مستوى الفئة (والاختياريّ ماركة+نوع) للمقارنة البصريّة أثناء
   * الكتابة. تحسب على المتغيّرات النشطة غير الأمانة فقط بتكلفة > 0.
   */
  categoryStats: productsManagerProcedure
    .input(
      z.object({
        categoryId: z.number().int().positive().nullable(),
        brand: z.string().max(80).nullish(),
        productType: z.string().max(80).nullish(),
        excludeProductId: z.number().int().positive().optional(),
      })
    )
    .query(async ({ input }) => {
      const d = getDb();
      if (!d) return { n: 0, minCost: null, maxCost: null, medianCost: null };
      // فلترة اختيارية: brand أو productType يضيفان دقّةً حين تكون الفئة عريضة.
      const cats = [
        input.categoryId != null ? sql`p.categoryId = ${input.categoryId}` : sql`p.categoryId IS NULL`,
        sql`COALESCE(p.isActive, TRUE) = TRUE`,
        sql`COALESCE(p.isConsignment, FALSE) = FALSE`,
        sql`COALESCE(v.isActive, TRUE) = TRUE`,
        sql`v.costPrice > 0`,
      ];
      if (input.excludeProductId) cats.push(sql`p.id <> ${input.excludeProductId}`);
      if (input.brand && input.brand.trim()) cats.push(sql`p.brand = ${input.brand.trim()}`);
      if (input.productType && input.productType.trim()) cats.push(sql`p.productType = ${input.productType.trim()}`);
      const whereClause = sql.join(cats, sql` AND `);
      // MySQL 8: نستعمل SUBSTRING_INDEX + GROUP_CONCAT للوسيط الرياضي، أو نأخذ العدد ونحسبه بـTS.
      const rows = await d.execute(sql`
        SELECT v.costPrice AS c
        FROM productVariants v
        JOIN products p ON p.id = v.productId
        WHERE ${whereClause}
        ORDER BY v.costPrice ASC
      `);
      // rows = [[{c: '150.00'}, ...], fields]
      const list = (rows as unknown as [Array<{ c: string | number }>, unknown])[0]
        .map((r) => Number(r.c))
        .filter((n) => Number.isFinite(n) && n > 0);
      const n = list.length;
      if (n === 0) return { n: 0, minCost: null, maxCost: null, medianCost: null };
      const minCost = list[0];
      const maxCost = list[n - 1];
      const mid = Math.floor(n / 2);
      const medianCost = n % 2 === 0 ? (list[mid - 1] + list[mid]) / 2 : list[mid];
      return { n, minCost, maxCost, medianCost };
    }),

  /**
   * **priceSanity L1.6 (٣٠/٧):** آخر تكلفة شراء لمتغيّر (من `purchaseOrderItems`). تُستعمَل لعرض
   * زرّ «استعمل آخر شراء» في محرِّر المنتج ⇒ يُغلق دورة الخطأ اليدوي (الملاك يحفظون آخر تكلفة
   * على الورقة/الذاكرة، والاستعمال هنا مباشرٌ من فاتورة موثَّقة). التكلفة **لكل وحدة الأساس**
   * (total / baseQuantity) — كي تتّسق مع `productVariants.costPrice`.
   */
  lastPurchaseCost: productsManagerProcedure
    .input(z.object({ variantId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const d = getDb();
      if (!d) return null;
      const rows = await d.execute(sql`
        SELECT poi.total AS total, poi.baseQuantity AS baseQty, poi.createdAt AS at, poi.purchaseOrderId AS poId
        FROM purchaseOrderItems poi
        WHERE poi.variantId = ${input.variantId} AND poi.baseQuantity > 0
        ORDER BY poi.createdAt DESC
        LIMIT 1
      `);
      const row = (rows as unknown as [Array<{ total: string | number; baseQty: number; at: Date; poId: number }>, unknown])[0][0];
      if (!row) return null;
      const total = Number(row.total);
      const baseQty = Number(row.baseQty);
      if (!Number.isFinite(total) || !Number.isFinite(baseQty) || baseQty <= 0) return null;
      const unitCost = Math.round((total / baseQty) * 100) / 100;
      return {
        unitCost: String(unitCost),
        receivedAt: row.at instanceof Date ? row.at.toISOString() : String(row.at),
        purchaseOrderId: Number(row.poId),
      };
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

  /** قائمة الفئات (لمنتقي الفئة في شاشات المنتج ونطاق الجرد «حسب الفئة»). parentId لتجميعها شجرياً في الواجهة. */
  categories: productsReadProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db
      .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
      .from(categories)
      .orderBy(asc(categories.sortOrder), asc(categories.name));
  }),

  /* ============================ إدارة الفئات (categories CRUD + دمج + نقل) ============================ */

  /** قائمة الفئات بعدد منتجاتها لشاشة الإدارة (يكشف عدّاً فقط ⇒ مدير فأعلى). */
  categoriesAdmin: productsManagerProcedure.query(() => listCategoriesAdmin()),

  createCategory: productsManagerProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().max(1000).nullish(),
        // أقسام فرعية (٢٩/٧): parentId اختياري — إن حُدِّد يجب أن يكون فئة رئيسية (لا فئة فرعية أخرى).
        parentId: z.number().int().positive().nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createCategory(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "category.create", entityType: "category", entityId: res.id, newValue: { name: res.name, parentId: input.parentId ?? null } });
      return res;
    }),

  updateCategory: productsManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().max(1000).nullish(),
        isActive: z.boolean().optional(),
        // أقسام فرعية: undefined=بلا تغيير، null=ترقية لفئة رئيسية، رقم=نقل تحت تلك الفئة الرئيسية.
        parentId: z.number().int().positive().nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateCategory(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "category.update",
        entityType: "category",
        entityId: input.id,
        newValue: { name: input.name, description: input.description, isActive: input.isActive, parentId: input.parentId },
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
