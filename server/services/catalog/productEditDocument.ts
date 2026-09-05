/**
 * مستندُ تعديل المنتج — **القراءة** (كان قسمَ «القراءة» في `productEditService.ts` حرفياً؛ نُقل في م٦).
 *
 * لماذا ملفٌّ مستقلّ: مستندُ التعديل صار **مصدرَ لقطة النسخ** (`recordVersions`، ق٨) فيقرأه
 * `catalog/productSnapshot.ts` وحرّاسُ التعديل المشتركة، وإبقاؤه داخل خدمة الكتابة يصنع دورةَ
 * استيراد (الخدمة ⇒ الحرّاس ⇒ اللقطة ⇒ الخدمة). `productEditService.ts` يُعيد تصديره فلا يتغيّر
 * أيُّ مستورِد.
 *
 * `exec` اختياريّ: داخل `withTx` يُمرَّر `tx` كي تُقرأ اللقطة **داخل المعاملة وبعد الأقفال**.
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { branchStock, productImages, productPrices, productUnits, productVariants, products, suppliers } from "../../../drizzle/schema";
import { getDb, type DB, type Tx } from "../../db";
import type { VariantKind } from "../../../shared/variantDisplay";
import type { PriceTier } from "../pricing";

type ReadDb = DB | Tx;

export interface VariantEditUnit {
  unitName: string;
  conversionFactor: string;
  isBaseUnit: boolean;
  isStoreSaleUnit: boolean;
  retail: string; // سعر المفرد (RETAIL) — فارغ إن لم يُعرَّف
  wholesale: string; // سعر الجملة (WHOLESALE)
  government: string; // سعر الحكومي (GOVERNMENT) — يجب أن يُعاد إرساله عند الحفظ وإلّا حُذف (upsert يمسح ثم يُدرِج)
}

export interface VariantEditRow {
  id: number;
  sku: string;
  /** نوع المتغيّر (م٣): تنويعة لون/قياس أو بديلٌ مستقلّ. */
  variantKind: VariantKind;
  /** اسم البديل (للبدائل) أو الاسم الوصفيّ (اختياريّ للتنويعات). */
  variantName: string | null;
  color: string | null;
  /** لون العرض الحقيقي «#RRGGBB» (اختيار صريح) أو null ⇒ يُستنتَج من الاسم. */
  colorHex: string | null;
  size: string | null;
  costPrice: string;
  /** سعر مفرد وحدة الأساس لهذا المتغيّر — لكشف «السعر الخاص» عند التحميل (يمنع طمسه عند الحفظ). */
  baseRetail: string;
  reorderPoint: number;
  minStock: number;
  isActive: boolean;
  /** باركود مستقل لكل وحدة, مفتاحه اسم الوحدة. */
  unitBarcodes: Record<string, string>;
  /**
   * وحداتُ هذا المتغيّر وأسعارُها كاملةً (الأساس أوّلاً) — مصدرُ اللقطة اللاقِطة لكلّ متغيّرٍ على حدة
   * (Codex #1008 P1). `unitTemplate` أدناه قالبٌ مشترَكٌ من أوّل متغيّر؛ هذا الحقلُ يحفظ ما يخصّ كلَّ
   * متغيّرٍ فعلاً كي لا تُطمَس فروقُ الوحدات/الأسعار عند الاستعادة. لا تستهلكه الشاشةُ (القالبُ المشترك يكفيها).
   */
  units: VariantEditUnit[];
  /** رصيد الفرع الحالي لكل فرع (قراءة فقط في التعديل). */
  stockByBranch: Record<number, number>;
  /** صورة هذا اللون (data URL) أو null. */
  image: string | null;
}

/** صورة على مستوى المنتج (variantId=NULL) — مشتركة لكل المتغيّرات، تُحرَّر في شاشة التعديل. */
export interface ProductImageRow {
  id: number;
  /** data URL مضغوط (نفس ما يُخدَم عبر /api/img/product) — يُعرَض مباشرةً في رافع الصور. */
  url: string;
  isPrimary: boolean;
  sortOrder: number;
}

export interface ProductForVariantEdit {
  id: number;
  name: string;
  productType: string | null;
  brand: string | null;
  modelName: string | null;
  description: string | null;
  internalName: string | null;
  storeTitle: string | null;
  seoTitle: string | null;
  shortTitle: string | null;
  posLabel: string | null;
  invoiceLabel: string | null;
  marketingCopy: string | null;
  categoryId: number | null;
  isCustomizable: boolean;
  allowAutoCartRecommendations: boolean;
  isService: boolean;
  /** «يُباع بالطلب» (0318): يُسمح ببيعه قبل توريده؛ يُغذَّى بشراءٍ من مورّد أو إنتاجٍ داخليّ. */
  allowBackorder: boolean;
  /** gstack B12 (٧/٧/٢٦): علم البكج — يُشغّل تبويب وصفة المكوّنات في ProductEdit. */
  isBundle: boolean;
  isActive: boolean;
  // ٢٤/٨ — متابعةُ PR #755 (هجرة 0262): توجيهُ العرض في نقاط البيع قابلٌ للتحرير بعد الإنشاء.
  // كان مُقتصراً على ServiceForm ⇒ لا وسيلةَ لإخفاء خدمةٍ عن كاشير معيّن دون تعطيلها كلياً.
  // ProductEdit يعرضهما تبديلَين مماثلَين لتبديلَي ServiceForm للاتساق.
  showInReception: boolean;
  showInPrintPos: boolean;
  // بضاعة الأمانة (٢٠/٧): الوسم + المودِع (اسمه للعرض) — للبانر العلوي وإعادة تسمية «التكلفة»→«حصة المودِع».
  isConsignment: boolean;
  consignorId: number | null;
  consignorName: string | null;
  /** قالب الوحدات المشترك — مُشتقّ من وحدات أوّل متغيّر فعّال (النموذج يصنعها موحّدة). */
  unitTemplate: VariantEditUnit[];
  variants: VariantEditRow[];
  /** صور المنتج العامّة (variantId=NULL) — مشتركة، تُحرَّر بشاشة التعديل (منفصلة عن صورة كل لون). */
  images: ProductImageRow[];
}

/**
 * يُطبّع معامل التحويل المخزَّن (`decimal(15,4)` ⇒ «12.0000») إلى عددٍ صحيحٍ نصّيّ نظيف («12»).
 *
 * **لماذا (إصلاح حاصر لتعديل متعدّد الوحدات):** العمود عشريّ، فالقراءة تُعيد «12.0000»، والنموذج يُبقيها
 * في الحالة إلى أن يُركِّز المستخدم حقل المعامل ويغادره (NumberInput يُطبّع عند blur فقط) ⇒ حفظٌ بلا لمس
 * الحقل يُرسل «12.0000» فيرفضها `assertValidUnitFactors` (`/^[1-9]\d*$/`) برسالة «معامل التحويل… عدد صحيح
 * موجب» — أي تعذّرُ تعديل أيّ منتجٍ بوحدةٍ أكبر (درزن/كرتون) بلا سببٍ يخصّ ما عُدِّل. التطبيع هنا يجعل
 * الحالة تبدأ نظيفةً «12». (المعاملات كلّها صحيحةٌ بحكم الحارس، فالتطبيع بلا فقدِ معنى.)
 */
function normalizeFactor(f: string): string {
  const s = (f ?? "").trim();
  if (!s.includes(".")) return s;
  const trimmed = s.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed || "0";
}

/** يقرأ منتجاً بكامل متغيّراته/وحداته/أسعاره/أرصدته لتعبئة شاشة التعديل. */
export async function getProductForVariantEdit(productId: number, exec?: ReadDb): Promise<ProductForVariantEdit | null> {
  const db = exec ?? getDb();
  if (!db) return null;
  const p = (await db.select().from(products).where(eq(products.id, productId)).limit(1))[0];
  if (!p) return null;

  // بضاعة الأمانة: اسم المودِع للعرض (قراءة واحدة عند وجود ربط فقط).
  let consignorName: string | null = null;
  if (p.consignorId != null) {
    const [c] = await db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, Number(p.consignorId))).limit(1);
    consignorName = c?.name ?? null;
  }
  const consignFields = {
    isConsignment: !!p.isConsignment,
    consignorId: p.consignorId != null ? Number(p.consignorId) : null,
    consignorName,
  };

  // صور المنتج العامّة (variantId=NULL) — مشتركة لكل المتغيّرات؛ منفصلة عن صور الألوان (variantId مضبوط).
  // تُقرأ هنا لكلا مسارَي الإرجاع (بمتغيّرات أو بلا) بترتيب العرض (الرئيسية أولاً).
  const productImageRows = await db
    .select({ id: productImages.id, url: productImages.url, isPrimary: productImages.isPrimary, sortOrder: productImages.sortOrder })
    .from(productImages)
    .where(and(eq(productImages.productId, productId), isNull(productImages.variantId)))
    .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder), asc(productImages.id));
  const images: ProductImageRow[] = productImageRows.map((r) => ({
    id: Number(r.id),
    url: r.url,
    isPrimary: !!r.isPrimary,
    sortOrder: r.sortOrder ?? 0,
  }));

  const variants = await db.select().from(productVariants).where(eq(productVariants.productId, productId));
  if (!variants.length) {
    return {
      id: Number(p.id),
      name: p.name,
      productType: p.productType,
      brand: p.brand,
      modelName: p.modelName,
      description: p.description,
      internalName: p.internalName ?? null,
      storeTitle: p.storeTitle ?? null,
      seoTitle: p.seoTitle ?? null,
      shortTitle: p.shortTitle ?? null,
      posLabel: p.posLabel ?? null,
      invoiceLabel: p.invoiceLabel ?? null,
      marketingCopy: p.marketingCopy ?? null,
      categoryId: p.categoryId != null ? Number(p.categoryId) : null,
      isCustomizable: !!p.isCustomizable,
      allowAutoCartRecommendations: p.allowAutoCartRecommendations !== false,
      isService: !!p.isService,
      allowBackorder: !!p.allowBackorder,
      isBundle: !!p.isBundle,
      isActive: !!p.isActive,
      showInReception: !!p.showInReception,
      showInPrintPos: !!p.showInPrintPos,
      ...consignFields,
      unitTemplate: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, retail: "", wholesale: "", government: "" }],
      variants: [],
      images,
    } satisfies ProductForVariantEdit;
  }
  const variantIds = variants.map((v) => Number(v.id));
  const units = (await db.select().from(productUnits).where(inArray(productUnits.variantId, variantIds))).filter(
    (u) => u.isActive
  );
  const unitIds = units.map((u) => Number(u.id));
  const prices = unitIds.length ? await db.select().from(productPrices).where(inArray(productPrices.productUnitId, unitIds)) : [];
  const stocks = await db.select().from(branchStock).where(inArray(branchStock.variantId, variantIds));
  // product-variants: صور المتغيّرات (variantId مضبوط) — صور المنتج العامّة (variantId=NULL) تُستثنى.
  const vImages = await db.select().from(productImages).where(inArray(productImages.variantId, variantIds));

  const priceOf = (unitId: number, tier: PriceTier) =>
    prices.find((pr) => Number(pr.productUnitId) === unitId && pr.priceTier === tier)?.price ?? "";

  const variantRows: VariantEditRow[] = variants.map((v) => {
    const myUnits = units.filter((u) => Number(u.variantId) === Number(v.id));
    const unitBarcodes: Record<string, string> = {};
    for (const u of myUnits) if (u.barcode) unitBarcodes[u.unitName] = u.barcode;
    const baseUnit = myUnits.find((u) => u.isBaseUnit);
    const baseRetail = baseUnit ? priceOf(Number(baseUnit.id), "RETAIL") : "";
    // وحداتُ هذا المتغيّر كاملةً (الأساس أوّلاً) — لقطةٌ لا تفقد وحداتٍ/أسعاراً خاصّةً بمتغيّر (Codex #1008 P1).
    const ownUnits: VariantEditUnit[] = [...myUnits]
      .sort((a, b) => Number(b.isBaseUnit) - Number(a.isBaseUnit))
      .map((u) => ({
        unitName: u.unitName,
        conversionFactor: normalizeFactor(u.conversionFactor),
        isBaseUnit: !!u.isBaseUnit,
        isStoreSaleUnit: !!u.isStoreSaleUnit,
        retail: priceOf(Number(u.id), "RETAIL"),
        wholesale: priceOf(Number(u.id), "WHOLESALE"),
        government: priceOf(Number(u.id), "GOVERNMENT"),
      }));
    const stockByBranch: Record<number, number> = {};
    for (const s of stocks.filter((s) => Number(s.variantId) === Number(v.id))) stockByBranch[Number(s.branchId)] = s.quantity;
    const image = vImages.find((im) => Number(im.variantId) === Number(v.id))?.url ?? null;
    return {
      id: Number(v.id),
      sku: v.sku,
      variantKind: (v.variantKind as VariantKind) ?? "VARIANT",
      variantName: v.variantName ?? null,
      color: v.color,
      colorHex: v.colorHex ?? null,
      size: v.size,
      costPrice: v.costPrice,
      baseRetail,
      reorderPoint: v.reorderPoint ?? 0,
      minStock: v.minStock ?? 0,
      isActive: !!v.isActive,
      unitBarcodes,
      units: ownUnits,
      stockByBranch,
      image,
    };
  });

  // القالب المشترك = وحدات أوّل متغيّر (مرتّبة: الأساس أولاً) — النموذج يصنع وحدات موحّدة عبر المتغيّرات.
  const firstUnits = units
    .filter((u) => Number(u.variantId) === variantIds[0])
    .sort((a, b) => Number(b.isBaseUnit) - Number(a.isBaseUnit));
  const unitTemplate: VariantEditUnit[] = (firstUnits.length ? firstUnits : []).map((u) => ({
    unitName: u.unitName,
    // «12.0000» ⇒ «12»: يمنع رفض assertValidUnitFactors عند حفظٍ لا يلمس حقل المعامل (إصلاح حاصر).
    conversionFactor: normalizeFactor(u.conversionFactor),
    isBaseUnit: !!u.isBaseUnit,
    isStoreSaleUnit: !!u.isStoreSaleUnit,
    retail: priceOf(Number(u.id), "RETAIL"),
    wholesale: priceOf(Number(u.id), "WHOLESALE"),
    government: priceOf(Number(u.id), "GOVERNMENT"),
  }));

  return {
    id: Number(p.id),
    name: p.name,
    productType: p.productType,
    brand: p.brand,
    modelName: p.modelName,
    description: p.description,
    internalName: p.internalName ?? null,
    storeTitle: p.storeTitle ?? null,
    seoTitle: p.seoTitle ?? null,
    shortTitle: p.shortTitle ?? null,
    posLabel: p.posLabel ?? null,
    invoiceLabel: p.invoiceLabel ?? null,
    marketingCopy: p.marketingCopy ?? null,
    categoryId: p.categoryId != null ? Number(p.categoryId) : null,
    isCustomizable: !!p.isCustomizable,
    allowAutoCartRecommendations: p.allowAutoCartRecommendations !== false,
    isService: !!p.isService,
    allowBackorder: !!p.allowBackorder,
    isBundle: !!p.isBundle,
    isActive: !!p.isActive,
    showInReception: !!p.showInReception,
    showInPrintPos: !!p.showInPrintPos,
    ...consignFields,
    unitTemplate: unitTemplate.length ? unitTemplate : [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, retail: "", wholesale: "", government: "" }],
    variants: variantRows,
    images,
  };
}
