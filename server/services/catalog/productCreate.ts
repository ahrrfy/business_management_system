// إنشاء منتج جديد: التحقّق المسبق من التفرّد وباركودات محجوزة، ثم الإنشاء الذرّي الكامل
// (متغيّرات/وحدات/أسعار/رصيد افتتاحي/صور/وصفة مواد خدمة الطباعة).
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import {
  productImages,
  productPrices,
  productUnits,
  productVariants,
  products,
  productionRecipeLines,
  productionRecipes,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { setStock } from "../inventoryService";
import { toDbMoney } from "../money";
import type { PriceTier } from "../pricing";
import { PRINT_SERVICE_TYPE } from "../printSaleService";
import { type Actor, withTx } from "../tx";

export interface CreateProductInput {
  name: string;
  // v3-add-screens: الاسم المركّب — يُجمَع في `name` تلقائياً إن لم يُمرّر مباشرةً.
  productType?: string | null;
  brand?: string | null;
  modelName?: string | null;
  description?: string | null;
  categoryId?: number | null;
  isCustomizable?: boolean;
  // مُنتج خِدمي (لا مَخزون): البَيع/الشِراء لا يُحرّك branchStock، رَصيد افتتاحي يُتجاهَل.
  isService?: boolean;
  // print-catalog: توجيه البَند لنقطة بَيع الطباعة (productType=PRINT_SERVICE) ⇒ يَظهر في شاشة
  // خدمات الطباعة ويُباع عبر printSaleService (لا مخزون ذاتي؛ يَخصم المواد عبر الوصفة أدناه).
  printService?: boolean;
  // توجيه الخدمة لكاشير خدمة العملاء (الاستقبال) أيضاً — يَظهر هناك ويُباع عبر createPrintSale.
  showInReception?: boolean;
  // print-catalog: وصفة المواد الخام التي تَستهلكها الخدمة (ورق/حبر…). تُربَط بمتغيّر البَند الأوّل
  // (الخدمات أحاديّة المتغيّر). اختيارية: خدمة بلا مواد (إلكترونية/تصميم) تُترَك بلا وصفة.
  recipe?: Array<{ inputVariantId: number; qtyPerOutputBase: string }>;
  variants: Array<{
    sku: string;
    variantName?: string | null;
    color?: string | null;
    size?: string | null;
    costPrice: string;
    minStock?: number;
    openingStock?: number;
    // product-variants: نقطة إعادة الطلب + ظهور المتغيّر في البيع + رصيد افتتاحي لكل فرع.
    reorderPoint?: number;
    isActive?: boolean;
    openingStockByBranch?: Array<{ branchId: number; qty: number }>;
    // product-variants: صورة مستقلّة لهذا اللون (data URL) — تُخزَّن في productImages بـvariantId.
    image?: string | null;
    units: Array<{
      unitName: string;
      conversionFactor: string;
      barcode?: string | null;
      isBaseUnit?: boolean;
      prices?: Array<{ priceTier: PriceTier; price: string }>;
    }>;
  }>;
  // v3-add-screens: صور المنتج. أوّل isPrimary=true يُعتمد، وإلا أوّل صورة.
  images?: Array<{ url: string; isPrimary?: boolean; sortOrder?: number }>;
}

/** يبني الاسم النهائي: الاسم الصريح (name) أولاً، فإن غاب رُكّب من النوع/الماركة/الموديل.
 *  (الأجزاء الثلاثة وصفية اختيارية ولا تَجُبّ الاسم الصريح — مطابقٌ لمنطق التعديل.) */
function composeProductName(input: { name?: string | null; productType?: string | null; brand?: string | null; modelName?: string | null }) {
  const explicit = (input.name ?? "").trim();
  const composed = [input.productType, input.brand, input.modelName].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return explicit || composed;
}

/**
 * product-variants: تحقّق مسبق من تفرّد الباركود والـSKU قبل أي إدراج —
 * يكشف التكرار داخل الحمولة وضدّ القاعدة فيرمي رسالة عربية تسمّي القيمة المخالفة،
 * بدل ترك قيد UNIQUE يفشل برسالة «قيمة مكرّرة» عامّة لا تدلّ على الباركود/الرمز.
 */
async function assertCatalogUniqueness(tx: Tx, input: CreateProductInput) {
  // الباركودات (لكل وحدة من كل متغيّر).
  const codes: string[] = [];
  for (const v of input.variants) for (const u of v.units) {
    const b = (u.barcode ?? "").trim();
    if (b) codes.push(b);
  }
  const seenCode = new Set<string>();
  for (const c of codes) {
    if (seenCode.has(c)) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${c} مكرّر داخل المنتج — لكل وحدة/لون باركود فريد.` });
    seenCode.add(c);
  }
  if (seenCode.size) {
    const taken = await tx
      .select({ code: productUnits.barcode, name: products.name })
      .from(productUnits)
      .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productUnits.barcode, Array.from(seenCode)))
      .limit(1);
    if (taken[0]) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${taken[0].code} مُستخدَم في «${taken[0].name}».` });
  }

  // الرموز (SKU) — واحد لكل متغيّر.
  const seenSku = new Set<string>();
  for (const v of input.variants) {
    const s = v.sku.trim();
    if (!s) continue;
    if (seenSku.has(s)) throw new TRPCError({ code: "CONFLICT", message: `الرمز ${s} (SKU) مكرّر بين المتغيّرات — لكل متغيّر رمز فريد.` });
    seenSku.add(s);
  }
  if (seenSku.size) {
    const takenSku = await tx
      .select({ sku: productVariants.sku })
      .from(productVariants)
      .where(inArray(productVariants.sku, Array.from(seenSku)))
      .limit(1);
    if (takenSku[0]) throw new TRPCError({ code: "CONFLICT", message: `الرمز ${takenSku[0].sku} (SKU) مُستخدَم لمتغيّر آخر — اختر رمزاً مختلفاً.` });
  }
}

/**
 * product-variants: أيُّ باركودات من القائمة محجوزة مسبقاً (وفي أي منتج)؟
 * يغذّي التحقّق اللحظي في شاشة الإضافة قبل الحفظ.
 */
export async function checkBarcodesTaken(codes: string[]): Promise<Array<{ code: string; takenBy: string }>> {
  const db = getDb();
  if (!db) return [];
  const clean = Array.from(new Set(codes.map((c) => c.trim()).filter(Boolean)));
  if (!clean.length) return [];
  const rows = await db
    .select({ code: productUnits.barcode, productName: products.name, sku: productVariants.sku })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.barcode, clean));
  return rows
    .filter((r) => r.code)
    .map((r) => ({ code: r.code as string, takenBy: `${r.productName} (${r.sku})` }));
}

/** Create a product with its variants, units and prices in one transaction. */
export async function createProduct(input: CreateProductInput, actor: Actor) {
  if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });
  return withTx(async (tx) => {
    const composedName = composeProductName(input);
    if (!composedName) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المنتج مطلوب (اكتبه مباشرةً أو املأ النوع/الماركة/الموديل)" });
    await assertCatalogUniqueness(tx, input);
    // print-catalog: التَوجيه لنقطة الطباعة يَفرض الراية PRINT_SERVICE (تَجُبّ «النوع» الوصفي)
    // ويُلزم isService (خدمة بلا مخزون). غير ذلك ⇒ النوع الوصفي كَما هو.
    const isService = !!(input.isService || input.printService);
    const pRes = await tx.insert(products).values({
      name: composedName,
      productType: input.printService ? PRINT_SERVICE_TYPE : input.productType?.trim() || null,
      brand: input.brand?.trim() || null,
      modelName: input.modelName?.trim() || null,
      description: input.description?.trim() || null,
      categoryId: input.categoryId ?? null,
      isCustomizable: input.isCustomizable ?? false,
      isService,
      showInReception: !!input.showInReception,
    });
    const productId = extractInsertId(pRes);

    // print-catalog: نَلتقط متغيّر البَند الأوّل ووحدته الأساس لِربط الوصفة (الخدمات أحاديّة المتغيّر).
    let recipeOutputVariantId: number | null = null;
    let recipeOutputUnitId: number | null = null;

    for (const v of input.variants) {
      if (!v.units.some((u) => u.isBaseUnit)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة (isBaseUnit)` });
      }
      const vRes = await tx.insert(productVariants).values({
        productId,
        sku: v.sku,
        variantName: v.variantName ?? null,
        color: v.color ?? null,
        size: v.size ?? null,
        costPrice: toDbMoney(v.costPrice),
        minStock: v.minStock != null ? Math.max(0, Math.trunc(v.minStock)) : 0,
        // product-variants: نقطة إعادة الطلب + ظهور مستقل لكل متغيّر.
        reorderPoint: v.reorderPoint != null ? Math.max(0, Math.trunc(v.reorderPoint)) : 0,
        isActive: v.isActive ?? true,
      });
      const variantId = extractInsertId(vRes);
      if (recipeOutputVariantId == null) recipeOutputVariantId = variantId;

      for (const u of v.units) {
        const uRes = await tx.insert(productUnits).values({
          variantId,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          barcode: u.barcode ?? null,
          isBaseUnit: u.isBaseUnit ?? false,
        });
        const productUnitId = extractInsertId(uRes);
        // print-catalog: وحدة أساس متغيّر البَند الأوّل = مخرَج الوصفة.
        if (recipeOutputVariantId === variantId && (u.isBaseUnit ?? false) && recipeOutputUnitId == null) {
          recipeOutputUnitId = productUnitId;
        }
        for (const p of u.prices ?? []) {
          await tx.insert(productPrices).values({ productUnitId, priceTier: p.priceTier, price: toDbMoney(p.price) });
        }
      }

      // المخزون الافتتاحي كحركة OPENING مُسجَّلة. product-variants: رصيد مستقل لكل فرع
      // (`openingStockByBranch`)؛ وإلا fallback لرقم أحاديّ في فرع الموظف (توافق خلفي).
      const perBranch =
        v.openingStockByBranch && v.openingStockByBranch.length
          ? v.openingStockByBranch
          : v.openingStock && v.openingStock > 0
            ? [{ branchId: actor.branchId, qty: v.openingStock }]
            : [];
      for (const ob of perBranch) {
        const qty = Math.max(0, Math.trunc(ob.qty));
        if (qty > 0) {
          await setStock(tx, {
            variantId,
            branchId: ob.branchId,
            targetQuantity: qty,
            referenceType: "OPENING",
            notes: "رصيد افتتاحي",
            createdBy: actor.userId,
          });
        }
      }

      // product-variants: صورة هذا اللون — تُخزَّن في productImages موسومة بـvariantId.
      const vImage = (v.image ?? "").trim();
      if (vImage) {
        await tx.insert(productImages).values({ productId, variantId, url: vImage, isPrimary: false, sortOrder: 0 });
      }
    }

    // v3-add-screens: صور المنتج. الأولى = الرئيسية إن لم يحدّد أيٌّ منها ذلك.
    if (input.images && input.images.length) {
      const imgs = input.images.filter((i) => i.url?.trim()).slice(0, 10);
      const anyPrimary = imgs.some((i) => i.isPrimary);
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        await tx.insert(productImages).values({
          productId,
          url: img.url.trim(),
          isPrimary: anyPrimary ? !!img.isPrimary : i === 0,
          sortOrder: img.sortOrder ?? i,
        });
      }
    }

    // print-catalog: وصفة المواد الخام للخدمة — تُربَط بمتغيّر البَند الأوّل ووحدته الأساس.
    // يَخصمها printSaleService عند البيع (snapshot كلفة المواد = COGS). idempotent بالاسم.
    const recipe = (input.recipe ?? []).filter((r) => r.inputVariantId > 0 && Number(r.qtyPerOutputBase) > 0);
    if (recipe.length) {
      if (recipeOutputVariantId == null || recipeOutputUnitId == null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "تَعذّر ربط وصفة المواد: لا متغيّر/وحدة أساس للبَند" });
      }
      const rRes = await tx.insert(productionRecipes).values({
        name: `[طباعة] ${composedName} #${productId}`,
        outputVariantId: recipeOutputVariantId,
        outputProductUnitId: recipeOutputUnitId,
        laborPerOutputBase: "0",
        wasteStdPct: "0",
        isActive: true,
        createdBy: actor.userId,
      });
      const recipeId = extractInsertId(rRes);
      for (const rl of recipe) {
        await tx.insert(productionRecipeLines).values({
          recipeId,
          inputVariantId: rl.inputVariantId,
          qtyPerOutputBase: toDbMoney(rl.qtyPerOutputBase),
        });
      }
    }

    return { productId };
  });
}
