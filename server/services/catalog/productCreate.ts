// إنشاء منتج جديد: التحقّق المسبق من التفرّد وباركودات محجوزة، ثم الإنشاء الذرّي الكامل
// (متغيّرات/وحدات/أسعار/وصفة مواد/مفتاح الإعادة وسجلّ التدقيق برصيد صفري إلزامي).
import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  branches,
  productPrices,
  productUnits,
  productUnitBarcodes,
  productVariants,
  products,
  suppliers,
  users,
} from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { barcodeComparisonKey, barcodeIdentityCandidates, canonicalizeBarcodeInput, canonicalizeBarcodeForStorage } from "@shared/barcodeNormalize";
import type { PermissionMap } from "@shared/permissions";
import type { UnitPricing } from "@shared/priceSanity";
import {
  canCarryStockUsage,
  resolveCreateStockUsage,
  type StockUsage,
} from "@shared/stockUsage";
import { logAuditTx, noteIdempotentAuditReplay, type AuditMetadata } from "../auditService";
import { replaceBundleComponents, type BundleComponentInput } from "../bundleService";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { acquireCatalogBarcodeWriteLock, checkBarcodesTakenAcrossBoth, findBarcodeClashes } from "./barcodeAliases";
import {
  assertStorefrontPublishReadyTx,
  assertUniqueNormalizedVariantCombos,
  assertUniqueUnitNamesAndTiers,
  assertVariantSanityOrThrow,
} from "./productUpdateGuards";
import { assertValidUnitFactors } from "./unitFactors";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { toDbMoney } from "../money";
import type { PriceTier } from "../pricing";
import { PRINT_SERVICE_TYPE } from "../printSaleService";
import { createRecipeInTx } from "../recipeService";
import { type Actor, withTx } from "../tx";
import { assertCreateHasNoLegacyMedia } from "./mediaWriteGuard";

export interface CreateProductInput {
  name: string;
  // v3-add-screens: الاسم المركّب — يُجمَع في `name` تلقائياً إن لم يُمرّر مباشرةً.
  productType?: string | null;
  brand?: string | null;
  modelName?: string | null;
  description?: string | null;
  internalName?: string | null;
  storeTitle?: string | null;
  seoTitle?: string | null;
  shortTitle?: string | null;
  posLabel?: string | null;
  invoiceLabel?: string | null;
  marketingCopy?: string | null;
  categoryId?: number | null;
  isCustomizable?: boolean;
  // بند بلا مخزون: البيع لا يُحرّك branchStock، ورصيد افتتاحي يُتجاهَل.
  // false صريحة تعني ناتجاً مخزنياً يمكن شراؤه أو إنتاجه حتى لو عُرض في نقطة الطباعة.
  isService?: boolean;
  /** «يُباع بالطلب» (0318): صنفٌ مخزنيّ يُسمح ببيعه قبل توريده (شراءً من مورّد أو إنتاجاً داخلياً). */
  allowBackorder?: boolean;
  // print-catalog: توجيه البَند لنقطة بَيع الطباعة (productType=PRINT_SERVICE).
  // هذه راية عرض ومسار بيع، ولا تفرض كونه بلا مخزون عند تمرير isService=false صراحةً.
  printService?: boolean;
  // توجيه الخدمة لكاشير خدمة العملاء (الاستقبال) أيضاً — يَظهر هناك ويُباع عبر createPrintSale.
  showInReception?: boolean;
  /**
   * م٦ (تناظر الإنشاء/التعديل — قرار المالك «شاشةُ التعديل تُظهر شاشة الإنشاء مطابقة»): الظهورُ في شبكة
   * الطباعة قرارٌ مستقلّ عن `printService` كما في مسار التعديل — يُزامن `productType='PRINT_SERVICE'`
   * (Codex P1 على #757) ولا يجعل البند خدمةً بلا مخزون. و«التوصيات الآلية» و«حالة المنتج» كانتا في
   * شاشة التعديل وحدها فيُولَد المنتج بقيمٍ لا يستطيع إعلانها عند ولادته.
   */
  showInPrintPos?: boolean;
  showInQuotations?: boolean;
  showInAdvancedSales?: boolean;
  allowAutoCartRecommendations?: boolean;
  isActive?: boolean;
  /** تصنيف الاستخدام للصنف المخزني المملوك (`SALE_ONLY` | `MATERIAL_ONLY` | `SALE_AND_MATERIAL` | `OPERATING_SUPPLY`). */
  stockUsage?: StockUsage | null;
  /** إعداد «مادة خام» في شاشة الإضافة — يجعل الافتراضي `MATERIAL_ONLY` و`isService=false`. */
  rawMaterial?: boolean;
  /** النشر الصريح في المتجر الإلكتروني؛ الافتراضي عند الإضافة اليدوية `false` (مخفي حتى يُنشَر). */
  showInStore?: boolean;
  /** نموذج الجاهزية للمفرد يطلب سعر مفرد أكبر من صفر لوحدة الأساس. */
  requireRetailReady?: boolean;
  /** مفتاح عدم التكرار الذرّي (يرتبط بالفاعل وبصمة الحمولة). */
  clientRequestId?: string | null;
  // bundles (٧/٧/٢٦): منتج مركّب (بكج). عند true يجب: متغيّر واحد، وحدة أساس واحدة، ومكوّنات في `bundleComponents`.
  // التكلفة لن تُقرأ من costPrice (تُحسب لحظة البيع من مجموع مكوّناته)، والمخزون الافتتاحي يُتجاهَل (لا branchStock للبكج).
  isBundle?: boolean;
  // bundles: وصفة البكج — قائمة المكوّنات (متغيّر أساس + كميّة صحيحة بالوحدة الأساس). إلزامية عند isBundle=true.
  bundleComponents?: BundleComponentInput[];
  // بضاعة الأمانة (٢٠/٧): وسم المنتج + مودِعه. الحصة تسكن variants[].costPrice (قرار المالك).
  // تلازم إلزاميّ isConsignment ⇔ consignorId (يُتحقَّق supplierKind='CONSIGNOR')، وحصة > 0،
  // ولا خدمة/بكج. راجع docs/consignment-design-2026-07-20.md §٥-ط.
  isConsignment?: boolean;
  consignorId?: number | null;
  // print-catalog: وصفة المواد الخام المرتبطة بمتغيّر البَند الأوّل.
  // للبند بلا مخزون تُستهلك عند البيع؛ وللناتج المخزني تُستهلك عند أمر الإنتاج فقط.
  recipe?: Array<{ inputVariantId: number; qtyPerOutputBase: string }>;
  variants: Array<{
    sku: string;
    variantKind?: "VARIANT" | "ALTERNATIVE";
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
    // حقل توافق قديم فقط: أي قيمة غير فارغة تُرفض؛ النشر الجديد عبر Product Studio/R2.
    image?: string | null;
    units: Array<{
      unitName: string;
      conversionFactor: string;
      barcode?: string | null;
      isBaseUnit?: boolean;
      isStoreSaleUnit?: boolean;
      prices?: Array<{ priceTier: PriceTier; price: string }>;
      // باركودات بديلة تُدرَج مع الوحدة في نفس المعاملة الذرّية.
      barcodeAliases?: Array<{ barcode: string; note?: string | null }>;
    }>;
  }>;
  // حقل توافق قديم فقط: أي URL غير فارغ يُرفض؛ النشر الجديد عبر Product Studio/R2.
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
  // التطبيع هنا هو **نفسه** الذي يُكتب به أدناه — كان الفحص يقلّم بينما الإدراج يكتب المُدخل خاماً،
  // فيمرّ «10095 » بمسافةٍ من فحص التفرّد ثم يُحفَظ بها ولا يُمسَح أبداً (الجذر، ٤/٩).
  const codes: string[] = [];
  for (const v of input.variants) for (const u of v.units) {
    const b = canonicalizeBarcodeInput(u.barcode ?? "");
    if (b) codes.push(b);
    for (const a of u.barcodeAliases ?? []) {
      const ab = canonicalizeBarcodeInput(a.barcode ?? "");
      if (ab) codes.push(ab);
    }
  }
  const seenCode = new Set<string>();
  for (const c of codes) {
    const identities = barcodeIdentityCandidates(c).map(barcodeComparisonKey);
    if (identities.some((identity) => seenCode.has(identity))) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${c} مكرّر داخل المنتج — لكل وحدة/لون/بديل باركود فريد.` });
    identities.forEach((identity) => seenCode.add(identity));
  }
  if (seenCode.size) {
    // مرَّتان: على `productUnits.barcode` (الأساسيّ) وعلى `productUnitBarcodes.barcode` (البديل).
    // بدون فحص البدائل يمكن كتابة أساسيّ لسلعة يطابق بديلاً لسلعة أخرى ⇒ resolveBarcodeOwner
    // يرجع لسلعتين مختلفتين حسب أيّهما مُسجَّل أولاً (سيناريو Codex P1).
    const clashes = await findBarcodeClashes(tx, Array.from(seenCode), { forShare: true });
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

/**
 * بضاعة الأمانة — الحراس (§٥-ط): تلازم أمانة⇔مودِع، المودِع نوعه CONSIGNOR ونشِط، الحصة (costPrice)
 * لكل متغيّر > 0، ولا خدمة/بكج. يُستدعى داخل المعاملة قبل أي إدراج. مشترك مفهومياً مع مسار التعديل.
 */
export async function assertConsignmentValid(
  tx: Tx,
  input: { isConsignment?: boolean; consignorId?: number | null; isService?: boolean; printService?: boolean; isBundle?: boolean },
  variantCosts: string[],
) {
  const isConsign = !!input.isConsignment;
  const consignorId = input.consignorId ?? null;
  // تلازم إلزاميّ في الاتجاهين.
  if (isConsign && !consignorId)
    throw new TRPCError({ code: "BAD_REQUEST", message: "صنف الأمانة يلزمه مودِع — اختر المودِع" });
  if (!isConsign && consignorId)
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُربط مودِع بصنف غير موسوم أمانة" });
  if (!isConsign) return;
  if (input.isService || input.printService)
    throw new TRPCError({ code: "BAD_REQUEST", message: "الخدمة لا تكون بضاعة أمانة" });
  if (input.isBundle)
    throw new TRPCError({ code: "BAD_REQUEST", message: "البكج لا يكون بضاعة أمانة" });
  const [sup] = await tx
    .select({ id: suppliers.id, kind: suppliers.supplierKind, active: suppliers.isActive })
    .from(suppliers).where(eq(suppliers.id, consignorId!)).limit(1);
  if (!sup) throw new TRPCError({ code: "BAD_REQUEST", message: "المودِع غير موجود" });
  if (sup.kind !== "CONSIGNOR")
    throw new TRPCError({ code: "BAD_REQUEST", message: "الطرف المختار ليس مودِع أمانة" });
  if (!sup.active) throw new TRPCError({ code: "BAD_REQUEST", message: "المودِع معطَّل — لا يُربط به صنف جديد" });
  // الحصة تسكن costPrice ويجب أن تكون موجبة (هي المبلغ المستحق للمودِع عند البيع).
  for (const c of variantCosts) {
    if (!(Number(c) > 0))
      throw new TRPCError({ code: "BAD_REQUEST", message: "حصة المودِع إلزامية وأكبر من صفر لكل متغيّر" });
  }
}

export type CreateProductActor = Actor & {
  permissionsOverride?: PermissionMap | null;
};

export interface CreateProductOptions {
  audit?: AuditMetadata;
}

function assertNonNegativeMoneyDecimal(raw: string, fieldLabel: string): void {
  const trimmed = (raw ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `قيمة مالية غير صالحة في «${fieldLabel}»`,
        why: "المبالغ المالية بالدينار العراقي يجب أن تكون غير سالبة وبمنزلتين عشريتين كحدّ أقصى",
        doThis: "أدخل مبلغاً رقمياً صالحاً غير سالب (مثل 0 أو 1500 أو 1250.50) ثم أعد الحفظ",
      }),
    });
  }
  const dec = new Decimal(trimmed);
  if (!dec.isFinite() || dec.isNegative() || dec.decimalPlaces() > 2) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `قيمة مالية غير صالحة في «${fieldLabel}»`,
        why: "المبلغ المالي خارج النطاق المسموح أو يتجاوز منزلتين عشريتين",
        doThis: "صحّح المبلغ ثم أعد الحفظ",
      }),
    });
  }
}

function isIdempotencyDupError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const code = e?.code ?? e?.cause?.code;
  if (code !== "ER_DUP_ENTRY") return false;
  const msg = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
  return msg.includes("uq_idempotency_op_key") || msg.includes("idempotencyKeys");
}

/** Create a product with its variants, units and prices in one transaction (zero opening stock). */
export async function createProduct(
  input: CreateProductInput,
  actor: CreateProductActor,
  options?: CreateProductOptions,
): Promise<{ productId: number; replayed?: boolean }> {
  // لا ينشر كاتب الكتالوج القديم صوراً MANUAL+APPROVED. الصور الجديدة تمر حصراً بمهمة
  // Product Studio ثم R2 والمراجعة؛ الحارس في الخدمة كي يشمل الراوتر وكل مستدعٍ داخلي.
  assertCreateHasNoLegacyMedia(input);
  if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });
  // bundles: قيود إنشاء البكج تُفرض قبل فتح المعاملة كي تعطي رسائل واضحة قبل أي إدراج.
  const isBundle = !!input.isBundle;
  if (isBundle) {
    if (input.isService || input.printService) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن أن يكون المنتج بكجاً وخدمةً في آنٍ معاً" });
    }
    // Codex #1008 P2: البكج المُوجَّه لشبكة الطباعة (`showInPrintPos`) يُسمَّى `productType='PRINT_SERVICE'`
    // (السطر أدناه) فيظهر في `listPrintServices`، ثمّ يسقط `createPrintSale` على `applyMovement` — البكج
    // بلا مخزونٍ ذاتيّ (رصيدُه رصيدُ مكوّناته) فلا يقبل حركةً مباشرة. نرفض التركيبة عند الإنشاء كـ`printService`
    // (المرفوض أعلاه) بدل ولادة بندٍ يَعِد بمخرَجٍ عاجزٍ عنه. الإصلاح النظير في مسار التعديل عبر حارس شكل البكج.
    if (input.showInPrintPos) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "البكج لا يُعرَض في شبكة الطباعة",
          why: "شبكةُ الطباعة تبيع خدماتٍ تُركَّب من وصفة، والبكج بلا مخزونٍ ذاتيّ يفشل بيعُه هناك عند تسجيل الحركة",
          doThis: "أزل «العرض في شبكة الطباعة» عن البكج، أو أنشئه خدمةً بدل بكجٍ إن كان يُباع بالطباعة",
        }),
      });
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
  // CATALOG-SURGICAL-20261107 (الدفعة ١): يبدأ تعريف الصنف برصيد صفري. نرفض الافتتاح الموجب/السالب
  // في الحقلين القديم (`openingStock`) وقائمة الفروع (`openingStockByBranch`)، ونقبل الصفر والإغفال للتوافق.
  for (const v of input.variants) {
    const hasNonZeroLegacy =
      v.openingStock !== undefined &&
      (!Number.isFinite(v.openingStock) || v.openingStock !== 0);
    const hasNonZeroBranch = (v.openingStockByBranch ?? []).some(
      (ob) => !Number.isFinite(ob.qty) || ob.qty !== 0,
    );
    if (hasNonZeroLegacy || hasNonZeroBranch) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يُسمح بإدخال رصيد افتتاحي غير صفري عند تعريف الصنف",
          why: "تعريف الصنف يبدأ دائماً برصيد صفري لفصل بيانات الكتالوج عن الحركات المخزنية والمالية الموثّقة",
          doThis: "احفظ الصنف برصيد صفر ثم أدخل الكمية عبر فاتورة شراء أو جرد افتتاحي معتمد أو تسوية مخزون أو أمر إنتاج أو إيداع أمانة",
        }),
      });
    }
  }

  const isService = input.isService ?? (!input.rawMaterial && !!input.printService);
  if (input.rawMaterial && (isService || isBundle || input.isConsignment)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "المادة الخام يجب أن تكون صنفاً مخزنياً مملوكاً",
        why: "لا يجوز جمع إعداد المادة الخام مع الخدمة أو البكج أو بضاعة الأمانة",
        doThis: "أنشئ المادة الخام كصنف مخزني مملوك، أو اختر نوع السجلّ المناسب",
      }),
    });
  }
  const canHaveStockUsage = canCarryStockUsage({
    isService,
    isBundle,
    isConsignment: !!input.isConsignment,
  });
  if (!canHaveStockUsage && input.stockUsage != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تصنيف الاستخدام المخزني يخصّ الأصناف المخزنية المملوكة فقط",
        why: "الخدمات والبكجات وبضاعة الأمانة تتبع مساراتها المستقلة ولا تحمل تصنيف stockUsage",
        doThis: "اترك حقل الاستخدام المخزني فارغاً لهذا النوع ثم أعد الحفظ",
      }),
    });
  }
  const effectiveStockUsage = resolveCreateStockUsage({
    isService,
    isBundle,
    isConsignment: !!input.isConsignment,
    stockUsage: input.stockUsage,
    isRawMaterialPreset: !!input.rawMaterial,
  });

  // التحقّق من فريدية التركيبات العادية بعد التطبيع + صحة المبالغ ومعاملات الوحدات وفئات التسعير.
  assertUniqueNormalizedVariantCombos(input.variants);
  for (const v of input.variants) {
    const variantLabel = [v.color?.trim(), v.size?.trim()].filter(Boolean).join(" / ") || v.sku;
    assertNonNegativeMoneyDecimal(v.costPrice, `تكلفة المتغيّر ${variantLabel}`);
    const baseCount = v.units.filter((u) => u.isBaseUnit).length;
    if (baseCount !== 1) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر حفظ المتغيّر «${v.sku}»`,
          why: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة (isBaseUnit) بمعامل تحويل 1`,
          doThis: "حدّد وحدة أساس واحدة فقط لهذا المتغيّر ثم أعد الحفظ",
        }),
      });
    }
    assertValidUnitFactors(v.units);
    assertUniqueUnitNamesAndTiers(variantLabel, v.units);
    for (const u of v.units) {
      for (const p of u.prices ?? []) {
        assertNonNegativeMoneyDecimal(p.price, `سعر ${p.priceTier} للوحدة ${u.unitName}`);
      }
    }
    const pricings: UnitPricing[] = v.units.map((u) => ({
      unitName: u.unitName,
      conversionFactor: u.isBaseUnit ? "1" : u.conversionFactor,
      isBaseUnit: !!u.isBaseUnit,
      retail: u.prices?.find((p) => p.priceTier === "RETAIL")?.price ?? null,
      wholesale: u.prices?.find((p) => p.priceTier === "WHOLESALE")?.price ?? null,
      government: u.prices?.find((p) => p.priceTier === "GOVERNMENT")?.price ?? null,
    }));
    assertVariantSanityOrThrow(variantLabel, v.costPrice, pricings);
    if (input.requireRetailReady === true && (v.isActive ?? true)) {
      const baseUnit = v.units.find((u) => u.isBaseUnit);
      const retailRaw = baseUnit?.prices?.find((p) => p.priceTier === "RETAIL")?.price?.trim() ?? "";
      if (!retailRaw || !new Decimal(retailRaw).gt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: `سعر المفرد لوحدة الأساس مطلوب للمتغيّر «${variantLabel}»`,
            why: "اخترتَ وضع الجاهزية للبيع المفرد دون إدخال سعر مفرد أكبر من صفر",
            doThis: "أدخل سعر البيع المفرد لوحدة الأساس، أو فعّل خيار التسعير المؤجّل الصريح قبل الحفظ",
          }),
        });
      }
    }
  }

  const trimmedClientRequestId = input.clientRequestId?.trim() || null;
  if (trimmedClientRequestId && trimmedClientRequestId.length > 128) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "معرّف الطلب غير صالح",
        why: "طول clientRequestId يتجاوز الحدّ الأقصى (128 محرفاً)",
        doThis: "أعد المحاولة من شاشة إضافة الصنف بمعرّف طلب قياسي",
      }),
    });
  }
  const idempotencyOp = `catalog.createProduct:${actor.userId}`;
  const { clientRequestId: _ignoredReqId, ...payloadWithoutReqId } = input;
  const payloadHash = trimmedClientRequestId ? idempotencyHash(payloadWithoutReqId) : null;

  try {
    return await withTx(async (tx) => {
      // قفل صف كتابة الكتالوج الواحد يُسلسِل فحص/كتابة ملكية الباركود وتزامن الإعادة معاً.
      await acquireCatalogBarcodeWriteLock(tx);

      if (trimmedClientRequestId) {
        const existingProductId = await checkIdempotency(
          tx,
          idempotencyOp,
          trimmedClientRequestId,
          payloadHash,
          { requireStoredHash: true, forUpdate: true },
        );
        if (existingProductId != null) {
          noteIdempotentAuditReplay();
          return { productId: existingProductId, replayed: true };
        }
      }

      const composedName = composeProductName(input);
      if (!composedName) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر حفظ المنتج الجديد",
            why: "اسم المنتج مطلوب ولم يُكتَب مباشرةً أو عبر حقول النوع والماركة والموديل",
            doThis: "اكتب اسم المنتج أو املأ النوع/الماركة/الموديل ثم أعد الحفظ",
          }),
        });
      }
      await assertCatalogUniqueness(tx, input);
      await assertConsignmentValid(
        tx,
        { ...input, isService, printService: isService && !!input.printService },
        input.variants.map((v) => v.costPrice),
      );

      const allowBackorder = input.allowBackorder === true;
      if (allowBackorder) {
        if (isService)
          throw new TRPCError({ code: "BAD_REQUEST", message: "«يُباع بالطلب» لا ينطبق على الخدمة — الخدمة بلا رصيد أصلاً فهي تُباع دائماً بلا فحص مخزون" });
        if (isBundle)
          throw new TRPCError({ code: "BAD_REQUEST", message: "«يُباع بالطلب» لا ينطبق على البكج — رصيده رصيد مكوّناته، فعِّله على المكوّن الناقص" });
        if (input.isConsignment)
          throw new TRPCError({ code: "BAD_REQUEST", message: "«يُباع بالطلب» ممنوع على بضاعة الأمانة — بيعُ ما لم يُودَع يُنشئ التزاماً كاذباً للمودِع" });
      }

      // اتّساق نشاط الصنف البسيط مع متغيّره الوحيد عديم الأبعاد.
      const isSingleSimpleVariant =
        input.variants.length === 1 &&
        (input.variants[0].variantKind ?? "VARIANT") !== "ALTERNATIVE" &&
        !input.variants[0].color?.trim() &&
        !input.variants[0].size?.trim();
      const resolvedSimpleActive = isSingleSimpleVariant
        ? input.isActive !== undefined && input.variants[0].isActive !== undefined
          ? input.isActive && input.variants[0].isActive
          : (input.isActive ?? input.variants[0].isActive ?? true)
        : undefined;
      const effectiveProductIsActive = resolvedSimpleActive ?? (input.isActive ?? true);

      // تمييز خدمة الطباعة الفورية عن الناتج المجهّز المخزني: `PRINT_SERVICE` للخدمات غير المخزنية فقط.
      const showInPrintPos = !!input.printService || !!input.showInPrintPos;
      const isPrintServiceProduct =
        isService &&
        (!!input.printService ||
          input.productType === PRINT_SERVICE_TYPE ||
          showInPrintPos ||
          !!input.showInReception ||
          !!input.showInQuotations ||
          !!input.showInAdvancedSales);

      // الإضافة اليدوية تبدأ مخفية عن المتجر (`false`)، والنشر الصريح يخضع لبوابة الصلاحية والجاهزية.
      const effectiveShowInStore = input.showInStore === true;
      if (effectiveShowInStore) {
        await assertStorefrontPublishReadyTx(tx, {
          actor,
          requirePermission: Boolean(actor.role),
          isActive: effectiveProductIsActive,
          isService,
          stockUsage: effectiveStockUsage,
          categoryId: input.categoryId ?? null,
          variants: input.variants.map((v, idx) => ({
            isActive: idx === 0 && resolvedSimpleActive !== undefined ? resolvedSimpleActive : (v.isActive ?? true),
            units: v.units.map((u) => ({
              isActive: true,
              isStoreSaleUnit: u.isStoreSaleUnit ?? u.isBaseUnit ?? false,
              conversionFactor: u.isBaseUnit ? "1" : u.conversionFactor,
              retailPrice: u.prices?.find((p) => p.priceTier === "RETAIL")?.price ?? null,
            })),
          })),
        });
      }

      const pRes = await tx.insert(products).values({
        name: composedName,
        productType: isPrintServiceProduct ? PRINT_SERVICE_TYPE : input.productType?.trim() || null,
        brand: input.brand?.trim() || null,
        modelName: input.modelName?.trim() || null,
        description: input.description?.trim() || null,
        internalName: input.internalName?.trim() || composedName,
        storeTitle: input.storeTitle?.trim() || composedName,
        seoTitle: input.seoTitle?.trim() || composedName,
        shortTitle: input.shortTitle?.trim() || composedName.slice(0, 160),
        posLabel: input.posLabel?.trim() || composedName.slice(0, 120),
        invoiceLabel: input.invoiceLabel?.trim() || composedName,
        marketingCopy: input.marketingCopy?.trim() || null,
        categoryId: input.categoryId ?? null,
        isCustomizable: input.isCustomizable ?? false,
        isService,
        stockUsage: effectiveStockUsage,
        allowBackorder,
        showInReception: !!input.showInReception,
        showInPrintPos,
        showInQuotations: !!input.showInQuotations,
        showInAdvancedSales: !!input.showInAdvancedSales,
        showInStore: effectiveShowInStore,
        ...(input.allowAutoCartRecommendations !== undefined ? { allowAutoCartRecommendations: input.allowAutoCartRecommendations } : {}),
        isActive: effectiveProductIsActive,
        isBundle,
        isConsignment: !!input.isConsignment,
        consignorId: input.isConsignment ? (input.consignorId ?? null) : null,
      });
      const productId = extractInsertId(pRes);

      let recipeOutputVariantId: number | null = null;
      let recipeOutputUnitId: number | null = null;
      let bundleParentVariantId: number | null = null;

      for (let vIdx = 0; vIdx < input.variants.length; vIdx++) {
        const v = input.variants[vIdx];
        const variantKind = v.variantKind === "ALTERNATIVE" ? "ALTERNATIVE" : "VARIANT";
        const variantName = v.variantName?.trim() || null;
        if (variantKind === "ALTERNATIVE") {
          if (!variantName) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `البديل «${v.sku}» يلزمه اسمٌ مميّز (الماركة/المنشأ).` });
          }
          const hasBc = v.units.some((u) => Boolean(canonicalizeBarcodeInput(u.barcode ?? "")));
          if (!hasBc) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `لا بديلَ بلا باركود: «${variantName}» — أسنِد باركوداً لوحدةٍ منه قبل الحفظ.` });
          }
        }
        const vRes = await tx.insert(productVariants).values({
          productId,
          sku: v.sku.trim(),
          variantKind,
          variantName,
          color: v.color?.trim() || null,
          colorHex: v.colorHex?.trim() || null,
          size: v.size?.trim() || null,
          costPrice: toDbMoney(v.costPrice),
          minStock: v.minStock != null ? Math.max(0, Math.trunc(v.minStock)) : 0,
          reorderPoint: v.reorderPoint != null ? Math.max(0, Math.trunc(v.reorderPoint)) : 0,
          isActive: vIdx === 0 && resolvedSimpleActive !== undefined ? resolvedSimpleActive : (v.isActive ?? true),
        });
        const variantId = extractInsertId(vRes);
        if (recipeOutputVariantId == null) recipeOutputVariantId = variantId;
        if (isBundle && bundleParentVariantId == null) bundleParentVariantId = variantId;

        for (const u of v.units) {
          const uRes = await tx.insert(productUnits).values({
            variantId,
            unitName: u.unitName.trim(),
            conversionFactor: u.isBaseUnit ? "1" : u.conversionFactor.trim(),
            barcode: canonicalizeBarcodeForStorage(u.barcode ?? "") || null,
            isBaseUnit: u.isBaseUnit ?? false,
            isStoreSaleUnit: u.isStoreSaleUnit ?? u.isBaseUnit ?? false,
          });
          const productUnitId = extractInsertId(uRes);
          if (recipeOutputVariantId === variantId && (u.isBaseUnit ?? false) && recipeOutputUnitId == null) {
            recipeOutputUnitId = productUnitId;
          }
          for (const p of u.prices ?? []) {
            await tx.insert(productPrices).values({ productUnitId, priceTier: p.priceTier, price: toDbMoney(p.price) });
          }
          for (const a of u.barcodeAliases ?? []) {
            const identity = canonicalizeBarcodeInput(a.barcode ?? "");
            if (!identity) continue;
            await tx.insert(productUnitBarcodes).values({
              productUnitId,
              barcode: canonicalizeBarcodeForStorage(a.barcode ?? ""),
              note: (a.note ?? "").trim() || null,
              createdBy: actor.userId,
            });
          }
        }
      }

      const recipe = input.recipe ?? [];
      if (recipe.length) {
        if (recipeOutputVariantId == null || recipeOutputUnitId == null) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "تَعذّر ربط وصفة المواد: لا متغيّر/وحدة أساس للبَند" });
        }
        await createRecipeInTx(
          tx,
          {
            name: `[طباعة] ${composedName} #${productId}`,
            outputVariantId: recipeOutputVariantId,
            outputProductUnitId: recipeOutputUnitId,
            laborPerOutputBase: "0",
            wasteStdPct: "0",
            lines: recipe,
          },
          actor,
        );
      }

      if (isBundle) {
        if (bundleParentVariantId == null) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تحديد متغيّر البكج بعد الإنشاء" });
        }
        await replaceBundleComponents(tx, bundleParentVariantId, input.bundleComponents ?? []);
      }

      if (trimmedClientRequestId) {
        await recordIdempotencyKey(tx, idempotencyOp, trimmedClientRequestId, productId, payloadHash);
      }

      // حفظ سجلّ التدقيق ذرّياً داخل نفس المعاملة (مع فحص وجود المرجع للتوافق مع اختبارات الوحدات التركيبية).
      const [existingUser] =
        actor.userId > 0
          ? await tx.select({ id: users.id }).from(users).where(eq(users.id, actor.userId)).limit(1)
          : [];
      const rawBranchId = options?.audit?.branchId ?? (actor.branchId > 0 ? actor.branchId : null);
      const [existingBranch] =
        rawBranchId != null && rawBranchId > 0
          ? await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, rawBranchId)).limit(1)
          : [];
      await logAuditTx(
        tx,
        {
          userId: existingUser ? actor.userId : null,
          branchId: existingBranch ? rawBranchId : null,
          ipAddress: options?.audit?.ipAddress ?? null,
          screenPath: options?.audit?.screenPath ?? null,
          actor: existingUser
            ? options?.audit?.actor
            : { source: "user", label: `user#${actor.userId}` },
        },
        {
          action: "product.create",
          entityType: "product",
          entityId: productId,
          newValue: {
            name: composedName,
            brand: input.brand ?? null,
            modelName: input.modelName ?? null,
            stockUsage: effectiveStockUsage,
            isService,
            isBundle,
            isConsignment: !!input.isConsignment,
            showInStore: effectiveShowInStore,
          },
        },
      );

      return { productId };
    });
  } catch (err) {
    if (trimmedClientRequestId && isIdempotencyDupError(err)) {
      const winnerId = await withTx(
        (tx2) =>
          checkIdempotency(tx2, idempotencyOp, trimmedClientRequestId, payloadHash, {
            requireStoredHash: true,
            forUpdate: true,
          }),
        { gate: "NONE" },
      );
      if (winnerId != null) {
        noteIdempotentAuditReplay();
        return { productId: winnerId, replayed: true };
      }
    }
    throw err;
  }
}
