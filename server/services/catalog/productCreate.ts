// إنشاء منتج جديد: التحقّق المسبق من التفرّد وباركودات محجوزة، ثم الإنشاء الذرّي الكامل
// (متغيّرات/وحدات/أسعار/رصيد افتتاحي/صور/وصفة مواد خدمة الطباعة).
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import {
  productImages,
  productPrices,
  productUnits,
  productUnitBarcodes,
  productVariants,
  products,
  productionRecipeLines,
  productionRecipes,
} from "../../../drizzle/schema";
import { replaceBundleComponents, type BundleComponentInput } from "../bundleService";
import { checkBarcodesTakenAcrossBoth, findBarcodeClashes } from "./barcodeAliases";
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
  // bundles (٧/٧/٢٦): منتج مركّب (بكج). عند true يجب: متغيّر واحد، وحدة أساس واحدة، ومكوّنات في `bundleComponents`.
  // التكلفة لن تُقرأ من costPrice (تُحسب لحظة البيع من مجموع مكوّناته)، والمخزون الافتتاحي يُتجاهَل (لا branchStock للبكج).
  isBundle?: boolean;
  // bundles: وصفة البكج — قائمة المكوّنات (متغيّر أساس + كميّة صحيحة بالوحدة الأساس). إلزامية عند isBundle=true.
  bundleComponents?: BundleComponentInput[];
  // print-catalog: وصفة المواد الخام التي تَستهلكها الخدمة (ورق/حبر…). تُربَط بمتغيّر البَند الأوّل
  // (الخدمات أحاديّة المتغيّر). اختيارية: خدمة بلا مواد (إلكترونية/تصميم) تُترَك بلا وصفة.
  recipe?: Array<{ inputVariantId: number; qtyPerOutputBase: string }>;
  variants: Array<{
    sku: string;
    variantName?: string | null;
    color?: string | null;
    colorHex?: string | null;
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
      // باركودات بديلة تُدرَج مع الوحدة في نفس المعاملة الذرّية.
      barcodeAliases?: Array<{ barcode: string; note?: string | null }>;
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
 * product-variants: تحقّق مسبق من تفرّد الباركود وتكرار الـSKU داخل المنتج قبل أي إدراج —
 * يكشف التكرار داخل الحمولة، ويفحص الباركود ضدّ القاعدة، فيرمي رسالة عربية تسمّي القيمة المخالفة،
 * بدل ترك قيد UNIQUE يفشل برسالة «قيمة مكرّرة» عامّة لا تدلّ على الباركود/الرمز.
 */
async function assertCatalogUniqueness(tx: Tx, input: CreateProductInput) {
  // الباركودات: الأساسيّ + البديل معاً — نفس فضاء التفرّد.
  const codes: string[] = [];
  for (const v of input.variants) for (const u of v.units) {
    const b = (u.barcode ?? "").trim();
    if (b) codes.push(b);
    for (const a of u.barcodeAliases ?? []) {
      const ab = (a.barcode ?? "").trim();
      if (ab) codes.push(ab);
    }
  }
  const seenCode = new Set<string>();
  for (const c of codes) {
    if (seenCode.has(c)) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${c} مكرّر داخل المنتج — لكل وحدة/لون/بديل باركود فريد.` });
    seenCode.add(c);
  }
  if (seenCode.size) {
    // مرَّتان: على `productUnits.barcode` (الأساسيّ) وعلى `productUnitBarcodes.barcode` (البديل).
    // بدون فحص البدائل يمكن كتابة أساسيّ لسلعة يطابق بديلاً لسلعة أخرى ⇒ resolveBarcodeOwner
    // يرجع لسلعتين مختلفتين حسب أيّهما مُسجَّل أولاً (سيناريو Codex P1).
    const clashes = await findBarcodeClashes(tx, Array.from(seenCode));
    if (clashes[0]) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `الباركود ${clashes[0].code} مُستخدَم في «${clashes[0].takenBy}».`,
      });
    }
  }

  // الرموز (SKU) — فريدة داخل المنتج فقط؛ يجوز أن يتكرر "أزرق"/PR-BLU في منتج آخر.
  const seenSku = new Set<string>();
  for (const v of input.variants) {
    const s = v.sku.trim();
    if (!s) continue;
    if (seenSku.has(s)) throw new TRPCError({ code: "CONFLICT", message: `الرمز ${s} (SKU) مكرّر بين المتغيّرات — لكل متغيّر رمز فريد.` });
    seenSku.add(s);
  }
}

/**
 * product-variants: أيُّ باركودات من القائمة محجوزة مسبقاً (وفي أي منتج)؟
 * يغذّي التحقّق اللحظي في شاشة الإضافة قبل الحفظ.
 *
 * ملاحظة: يمرّ على الأساسيّ (`productUnits.barcode`) والبديل (`productUnitBarcodes.barcode`) معاً
 * عبر `checkBarcodesTakenAcrossBoth` — كي لا يمرّ باركود بديلٍ بلا اصطدام بأساسيٍّ لسلعةٍ أخرى.
 */
export async function checkBarcodesTaken(codes: string[]): Promise<Array<{ code: string; takenBy: string }>> {
  return checkBarcodesTakenAcrossBoth(codes);
}

/** Create a product with its variants, units and prices in one transaction. */
export async function createProduct(input: CreateProductInput, actor: Actor) {
  if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });
  // bundles: قيود إنشاء البكج تُفرض قبل فتح المعاملة كي تعطي رسائل واضحة قبل أي إدراج.
  const isBundle = !!input.isBundle;
  if (isBundle) {
    if (input.isService || input.printService) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن أن يكون المنتج بكجاً وخدمةً في آنٍ معاً" });
    }
    if (input.variants.length !== 1) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "البكج يحوي متغيّراً واحداً — احذف المتغيّرات الإضافية" });
    }
    const baseUnits = input.variants[0].units.filter((u) => u.isBaseUnit).length;
    if (baseUnits !== 1) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "البكج يحوي وحدة أساس واحدة" });
    }
    if (!input.bundleComponents || input.bundleComponents.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "البكج يحتاج مكوّناً واحداً على الأقلّ" });
    }
    // رصيد افتتاحي على بكج غير معنيّ (لا branchStock له) — نجرّده احترازياً.
    if (input.variants[0].openingStock || (input.variants[0].openingStockByBranch && input.variants[0].openingStockByBranch.length)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُسمَح برصيد افتتاحي على البكج — مخزونه هو مخزون مكوّناته" });
    }
    if (input.recipe && input.recipe.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "وصفة الإنتاج لا تُدار على البكج — استعمل bundleComponents" });
    }
  }
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
      isBundle,
    });
    const productId = extractInsertId(pRes);

    // print-catalog: نَلتقط متغيّر البَند الأوّل ووحدته الأساس لِربط الوصفة (الخدمات أحاديّة المتغيّر).
    let recipeOutputVariantId: number | null = null;
    let recipeOutputUnitId: number | null = null;
    // bundles: نَلتقط متغيّر البكج الوحيد لِربط وصفة المكوّنات به بعد الحلقة.
    let bundleParentVariantId: number | null = null;

    for (const v of input.variants) {
      if (!v.units.some((u) => u.isBaseUnit)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة (isBaseUnit)` });
      }
      const vRes = await tx.insert(productVariants).values({
        productId,
        sku: v.sku.trim(),
        variantName: v.variantName ?? null,
        color: v.color ?? null,
        colorHex: v.colorHex?.trim() || null,
        size: v.size ?? null,
        costPrice: toDbMoney(v.costPrice),
        minStock: v.minStock != null ? Math.max(0, Math.trunc(v.minStock)) : 0,
        // product-variants: نقطة إعادة الطلب + ظهور مستقل لكل متغيّر.
        reorderPoint: v.reorderPoint != null ? Math.max(0, Math.trunc(v.reorderPoint)) : 0,
        isActive: v.isActive ?? true,
      });
      const variantId = extractInsertId(vRes);
      if (recipeOutputVariantId == null) recipeOutputVariantId = variantId;
      // bundles: البكج أحاديّ المتغيّر (فُرض قبل المعاملة) — نلتقطه هنا لِحفظ وصفته لاحقاً.
      if (isBundle && bundleParentVariantId == null) bundleParentVariantId = variantId;

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
        // باركودات بديلة تُدرَج ذرّياً في نفس المعاملة — تفرّدها تم التحقّق منه في assertCatalogUniqueness.
        for (const a of u.barcodeAliases ?? []) {
          const code = (a.barcode ?? "").trim();
          if (!code) continue;
          await tx.insert(productUnitBarcodes).values({
            productUnitId,
            barcode: code,
            note: (a.note ?? "").trim() || null,
            createdBy: actor.userId,
          });
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

    // bundles: حفظ وصفة المكوّنات بعد إنشاء متغيّر البكج (متغيّر واحد بحكم القيود أعلاه).
    // replaceBundleComponents يفرض B1..B6 داخلياً (نَست ممنوع، تفعيل، كميّة صحيحة موجبة، فرادة).
    if (isBundle) {
      if (bundleParentVariantId == null) {
        // احترازي — لن يحصل بحكم قيد variants.length===1، لكن نُفصح عن السبب صراحةً بدل NULL خفيّ.
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تحديد متغيّر البكج بعد الإنشاء" });
      }
      await replaceBundleComponents(tx, bundleParentVariantId, input.bundleComponents ?? []);
    }

    return { productId };
  });
}
