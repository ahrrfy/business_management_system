// price-waves (٧/٧/٢٦، أُعيد بناؤه ٢٠/٨/٢٦): موجات تحديث الأسعار — معاينة قبل الالتزام + تطبيق ذرّي + سجلّ دائم.
//
// النموذج الذهني:
//   * موجة = تعديل جماعيّ لمجموعة productPrices بمعايير (نطاق + فلاتر) وقاعدة تغيير موحَّدة.
//   * `previewPriceWave` — قراءة فقط، تُرجع الصفوف المتأثّرة + الصفوف الساقطة بأسبابها + بصمة.
//   * `applyPriceWave` — كتابة ذرّية: يعيد حساب الأسعار من نفس النطاق (لا يثق بصفوف العميل).
//
// ثوابت الأمان (W1..W7):
//   W1  إعادة الحساب داخل withTx — لا نعتمد على «صفوف العميل من المعاينة» (سباق: مدير آخر يغيّر سعراً بين المعاينة والتطبيق).
//   W2  السعر الجديد > 0 دائماً (يفرضه CHECK). خفض بنسبة كبيرة قد يهبطه لصفر ⇒ نقصره إلى 0.01.
//   W3  السعر الجديد ≥ **تكلفة الوحدة** (لا تكلفة الأساس) — إلّا لو المدير أذّن صراحةً `allowBelowCost=true`.
//   W4  تنفيذ managerProcedure حصراً — كشف/تعديل التكلفة ينكشف من التصفية.
//   W5  استقرار SORT: نطبّق بترتيب productUnitId → priceTier كي تكون النتيجة حتميّة (تكرار المعاينة = التطبيق).
//   W6  **النطاق قرارٌ صريح**: فلاتر فارغة لا تعني «الكل» — تعني خطأً يُرَدّ (انظر الجذر أدناه).
//   W7  **بصمة المعاينة**: التطبيق يُرفض إن تغيّرت المجموعة منذ ما رآه المدير — وهي نفسها تمنع النقر المزدوج.
//
// ── ثلاثة أعطاب صحّة أُغلقت في ٢٠/٨/٢٦ (لا تُعِد أيّاً منها) ───────────────────────────────
//
// ع١ «البحث لا يفلتر، وسقوطه صامت وخطِر»: كان الشرط `productSearch.trim().length >= 2` يُسقط
//    المصطلح **بصمت** لأقلّ من حرفين ⇒ المعاينة تُرجع **كامل الكتالوج** والمدير يظنّ أنه صفّى.
//    وكان يبحث بـLIKE خامّ على `products.name` بلا تطبيعٍ عربيّ (فـ«ازرق» لا تجد «أزرق») وبلا
//    تهريب LIKE (فـSKU فيه `_` يصير wildcard) وبلا باركود. الآن: `buildCatalogSearchWhere`
//    المشتركة (نفس محرّك بحث الكاشير وشاشة المنتجات)، وبلا أيّ عتبة، والنطاق صريحٌ (W6).
//
// ع٢ «حارس تحت التكلفة معطوب لكل وحدة غير الأساس»: كان يقارن سعر الوحدة بـ
//    `productVariants.costPrice` مباشرةً — وهي تكلفة **وحدة الأساس**. فدرزنٌ بسعر 6,000 وتكلفة
//    قطعةٍ 1,000 (تكلفة الدرزن 12,000) كان يمرّ «رابحاً»، و`SET_MARGIN` كان يحسب سعر الكرتون من
//    تكلفة القطعة ⇒ انهيار أسعار الوحدات الكبيرة بموجةٍ واحدة. الصيغة الحاكمة في المستودع كلّه:
//    `تكلفة الأساس × conversionFactor` (`catalogAnomalies/detectors.ts` L6 و`shared/priceSanity.ts`).
//
// ع٣ «البكجات: هامش ١٠٠٪ كاذب + تخطٍّ صامت»: `costPrice` للبكج صفرٌ بحكم التصميم ⇒ `belowCost`
//    دائماً false، و`SET_MARGIN` كان **يتخطّاه بصمت**. الآن تُشتقّ تكلفته من وصفته عبر
//    `loadBundleUnitCosts` (المصدر الحاكم)، وكل صفٍّ يسقط يعود في `skipped[]` بسببٍ مقروء.
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  categories,
  priceChangeLog,
  priceUpdateWaves,
  productPrices,
  productUnits,
  productVariants,
  products,
  users,
} from "../../drizzle/schema";
import {
  MAX_PERCENT_VALUE,
  applyPriceWaveRule,
  isPercentChange,
  marginPct,
  type PriceChangeType,
  type PriceWaveScope,
  type PriceWaveSkipReason,
} from "../../shared/priceWaveRule";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { loadBundleUnitCosts } from "./bundleService";
import { buildCatalogSearchWhere } from "./catalog/search";
import { money, toDbMoney } from "./money";
import type { PriceTier } from "./pricing";

export type { PriceChangeType };

/** سقف صفوف الموجة الواحدة — يحمي المعاملة من الاستطالة، ويجبر المدير على تضييق نطاقٍ أفلت منه. */
export const MAX_WAVE_ROWS = 5000;

/** دفعات الكتابة: بدل 2N استعلاماً داخل معاملة واحدة (كانت الحلقة تُصدر UPDATE+INSERT لكل صفّ). */
const UPDATE_CHUNK = 200;
const INSERT_CHUNK = 500;

export interface PriceWaveFilters {
  /** W6 — النطاق صريح: FILTERED يلزمه فلترٌ واحد على الأقل، وALL يمنع أيّ فلتر. */
  scope: PriceWaveScope;
  categoryId?: number | null;
  productSearch?: string | null;
  priceTier?: PriceTier | null;
  /** لوضع SELECTED حصراً — معرّفات المنتجات المختارة يدوياً. */
  productIds?: number[] | null;
}

export interface PreviewPriceWaveInput {
  filters: PriceWaveFilters;
  changeType: PriceChangeType;
  /** نسبة (0<pct≤1000) أو مبلغ ثابت (>0) أو هامش (0<pct≤1000) */
  changeValue: string;
  /** وحدة تقريب السعر الناتج بالدينار؛ غياب/صفر = بلا تقريب (الواجهة تقترح ٢٥٠). */
  roundToDenom?: number | null;
}

/** زوجٌ يُعرِّف صفّ سعرٍ بعينه — وحدةُ الاستثناء اليدويّ من المعاينة. */
export interface PriceRowKey {
  productUnitId: number;
  priceTier: PriceTier;
}

export interface ApplyPriceWaveInput extends PreviewPriceWaveInput {
  name: string;
  description?: string | null;
  reason?: string | null;
  allowBelowCost?: boolean;
  /** W7 — بصمة المعاينة التي أقرّها المدير؛ غيابها يعني «طبّق بلا مطابقة» (لا تستعمله الشاشة). */
  expectedFingerprint?: string | null;
  /** صفوفٌ استثناها المدير سطراً سطراً في المعاينة (مُعرِّفات فقط — لا أسعار ⇒ W1 محفوظ). */
  excluded?: PriceRowKey[] | null;
}

export interface PriceWaveRow {
  productUnitId: number;
  /** مفتاح صفّ `productPrices` — يُستعمل للتحديث المُجمَّع بـCASE (لا يُعرَض). */
  priceRowId: number;
  productId: number;
  variantId: number;
  productName: string;
  sku: string;
  unitName: string;
  conversionFactor: string;
  priceTier: PriceTier;
  oldPrice: string;
  newPrice: string;
  /** تكلفة **هذه الوحدة** (الأساس × المعامل، أو وصفة البكج)؛ `null` = مجهولة. */
  unitCost: string | null;
  oldMarginPct: number | null;
  newMarginPct: number | null;
  belowCost: boolean;
  rounded: boolean;
  clampedMin: boolean;
  isBundle: boolean;
}

export interface PriceWaveSkippedRow {
  productUnitId: number;
  productName: string;
  sku: string;
  unitName: string;
  priceTier: PriceTier;
  oldPrice: string;
  reason: PriceWaveSkipReason;
}

export interface PriceWaveComputation {
  rows: PriceWaveRow[];
  skipped: PriceWaveSkippedRow[];
  /** W7 — بصمة حتميّة للمجموعة (الترتيب مضمون بـW5). */
  fingerprint: string;
}

/**
 * W7 — بصمة المجموعة: تشمل **الأسعار القديمة والجديدة معاً** كي يلتقط أيُّ تغيّرٍ في السوق أو
 * في الفلاتر. حتميّةٌ لأنّ `computeAffectedRows` تُرتّب بـ(productUnitId, priceTier) دائماً.
 */
export function priceWaveFingerprint(
  rows: Array<
    Pick<PriceWaveRow, "productUnitId" | "priceTier" | "oldPrice" | "newPrice">
  >,
): string {
  const h = createHash("sha256");
  for (const r of rows)
    h.update(`${r.productUnitId}:${r.priceTier}:${r.oldPrice}:${r.newPrice}\n`);
  return h.digest("hex").slice(0, 32);
}

function rowKey(k: PriceRowKey | PriceWaveRow): string {
  return `${k.productUnitId}:${k.priceTier}`;
}

/**
 * W6 — يتحقّق أنّ النطاق قرارٌ واعٍ. الجذر: فلاتر فارغة كانت تعني ضمناً «كل الكتالوج»، فأيّ
 * فلترٍ يسقط (أو يُترك فارغاً سهواً) يتحوّل إلى موجةٍ على الكتالوج كلّه بلا أيّ إشارة.
 */
function assertScope(f: PriceWaveFilters): void {
  const hasSearch = !!f.productSearch?.trim();
  const hasCategory = f.categoryId != null && f.categoryId > 0;
  const hasTier = !!f.priceTier;
  const hasIds = Array.isArray(f.productIds) && f.productIds.length > 0;

  if (f.scope === "FILTERED") {
    if (!hasSearch && !hasCategory && !hasTier) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "لم تحدّد أيّ فلتر. اختر «كل الكتالوج» صراحةً إن كنت تقصد إعادة تسعير الكتالوج كلّه.",
      });
    }
    if (hasIds) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "منتجات محدَّدة مع نطاق «بالفلاتر» — اختر أحد الوضعين.",
      });
    }
    return;
  }
  if (f.scope === "SELECTED") {
    if (!hasIds) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "نطاق «منتجات محدَّدة» بلا أيّ منتج مختار.",
      });
    }
    if (f.productIds!.length > 500) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الحدّ الأقصى ٥٠٠ منتجٍ في الاختيار اليدويّ.",
      });
    }
    return;
  }
  // ALL: أيّ فلترٍ مصاحب تناقضٌ يُربك القراءة لاحقاً («الكل» في الرأس وفلترٌ في filtersJson).
  if (hasSearch || hasCategory || hasIds) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "نطاق «كل الكتالوج» لا يقبل فلتر فئةٍ أو بحثٍ أو اختيارٍ يدويّ — أزِلها أو بدّل النطاق.",
    });
  }
}

function assertRule(input: PreviewPriceWaveInput): void {
  const changeVal = money(input.changeValue);
  if (!changeVal.gt(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "قيمة التغيير يجب أن تكون أكبر من صفر",
    });
  }
  if (isPercentChange(input.changeType) && changeVal.gt(MAX_PERCENT_VALUE)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `النسبة تتجاوز الحدّ الأقصى المسموح (${MAX_PERCENT_VALUE})`,
    });
  }
  if (input.changeType === "DECREASE_PERCENT" && changeVal.gte(100)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "تخفيضٌ بنسبة ١٠٠٪ أو أكثر يُفرّغ السعر — استعمل سعراً صريحاً بدلها.",
    });
  }
}

/** فئة + فئاتها الفرعية المباشرة — نفس سلوك شاشة المنتجات (`catalog/adminList.ts`). */
async function categoryIdsWithChildren(
  tx: Tx,
  categoryId: number,
): Promise<number[]> {
  const children = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.parentId, categoryId));
  return [categoryId, ...children.map((c) => Number(c.id))];
}

/** W1: إعادة الحساب المشتركة (كي تعمل نفس المنطق للمعاينة والتطبيق داخل نفس المعاملة). */
async function computeAffectedRows(
  tx: Tx,
  input: PreviewPriceWaveInput,
): Promise<PriceWaveComputation> {
  assertRule(input);
  assertScope(input.filters);

  const conditions: any[] = [
    eq(products.isActive, true),
    eq(productUnits.isActive, true),
    eq(productVariants.isActive, true),
  ];

  if (input.filters.categoryId != null && input.filters.categoryId > 0) {
    const ids = await categoryIdsWithChildren(tx, input.filters.categoryId);
    conditions.push(
      ids.length > 1
        ? inArray(products.categoryId, ids)
        : eq(products.categoryId, input.filters.categoryId),
    );
  }
  // ع١: محرّك بحث الكتالوج المشترك — تطبيعٌ عربيّ + تهريب LIKE + باركود + مطابقة كلمةً كلمة،
  // وبلا أيّ عتبة طول (حرفٌ واحد يفلتر فعلاً بدل أن يُسقَط بصمت فيُعيد الكتالوج كلّه).
  const search = buildCatalogSearchWhere(
    input.filters.productSearch ?? undefined,
  );
  if (search) conditions.push(search);
  if (input.filters.priceTier) {
    conditions.push(eq(productPrices.priceTier, input.filters.priceTier));
  }
  if (input.filters.scope === "SELECTED" && input.filters.productIds?.length) {
    conditions.push(inArray(products.id, input.filters.productIds.map(Number)));
  }

  const raw = await tx
    .select({
      priceRowId: productPrices.id,
      productUnitId: productPrices.productUnitId,
      priceTier: productPrices.priceTier,
      oldPrice: productPrices.price,
      productId: products.id,
      productName: products.name,
      isBundle: products.isBundle,
      variantId: productVariants.id,
      sku: productVariants.sku,
      baseCost: productVariants.costPrice,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
    })
    .from(productPrices)
    .innerJoin(productUnits, eq(productPrices.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(...conditions))
    .orderBy(asc(productPrices.productUnitId), asc(productPrices.priceTier));

  // ع٣: تكلفة البكج من وصفته لا من عموده (صفرٌ بحكم التصميم) — قراءةٌ واحدة لكل البكجات.
  const bundleVariantIds = Array.from(
    new Set(raw.filter((r) => !!r.isBundle).map((r) => Number(r.variantId))),
  );
  const bundleBaseCosts = bundleVariantIds.length
    ? await loadBundleUnitCosts(tx, bundleVariantIds)
    : new Map<number, string>();

  const rows: PriceWaveRow[] = [];
  const skipped: PriceWaveSkippedRow[] = [];

  for (const r of raw) {
    const isBundle = !!r.isBundle;
    const factor = money(r.conversionFactor ?? "1");
    // ع٢: تكلفة **الوحدة** = تكلفة الأساس × معامل التحويل. القطعة معاملها ١ فلا فرق،
    // والدرزن/الكرتون كان يُقارَن سعرُه بتكلفة قطعةٍ واحدة ⇒ الحارس لا يشتعل أبداً.
    const baseCostRaw = isBundle
      ? (bundleBaseCosts.get(Number(r.variantId)) ?? null)
      : r.baseCost;
    const baseCost = baseCostRaw == null ? null : money(baseCostRaw);
    const unitCostD: Decimal | null =
      baseCost == null || baseCost.lte(0) || factor.lte(0)
        ? null
        : baseCost.mul(factor);
    const unitCost = unitCostD == null ? null : toDbMoney(unitCostD);

    const outcome = applyPriceWaveRule(r.oldPrice, unitCost, input, isBundle);
    if (outcome.newPrice == null) {
      skipped.push({
        productUnitId: Number(r.productUnitId),
        productName: r.productName,
        sku: r.sku,
        unitName: r.unitName,
        priceTier: r.priceTier as PriceTier,
        oldPrice: toDbMoney(money(r.oldPrice)),
        reason: outcome.skipReason!,
      });
      continue;
    }

    rows.push({
      productUnitId: Number(r.productUnitId),
      priceRowId: Number(r.priceRowId),
      productId: Number(r.productId),
      variantId: Number(r.variantId),
      productName: r.productName,
      sku: r.sku,
      unitName: r.unitName,
      conversionFactor: String(r.conversionFactor ?? "1"),
      priceTier: r.priceTier as PriceTier,
      oldPrice: toDbMoney(money(r.oldPrice)),
      newPrice: outcome.newPrice,
      unitCost,
      oldMarginPct: marginPct(r.oldPrice, unitCost),
      newMarginPct: marginPct(outcome.newPrice, unitCost),
      // W3 بالتكلفة المصحَّحة — تكلفةٌ مجهولة لا تُعَدّ «تحت التكلفة» (لا نُنذر بما لا نعلمه).
      belowCost:
        unitCostD != null && new Decimal(outcome.newPrice).lt(unitCostD),
      rounded: outcome.rounded,
      clampedMin: outcome.clampedMin,
      isBundle,
    });
  }

  return { rows, skipped, fingerprint: priceWaveFingerprint(rows) };
}

/** معاينة الموجة — قراءة فقط، بدون كتابة. */
export async function previewPriceWave(
  tx: Tx,
  input: PreviewPriceWaveInput,
): Promise<PriceWaveComputation> {
  return computeAffectedRows(tx, input);
}

/** ما يُخزَّن في `priceUpdateWaves.filtersJson` — مستندُ الموجة الكامل للتدقيق ولإعادة القراءة. */
interface StoredWaveScope {
  v: 2;
  scope: PriceWaveScope;
  categoryId: number | null;
  productSearch: string | null;
  priceTier: PriceTier | null;
  productIds: number[] | null;
  roundToDenom: number;
  excludedCount: number;
  skippedCount: number;
}

/**
 * تطبيق الموجة ذرّياً: يعيد حساب الصفوف داخل نفس المعاملة (W1)، يطابق البصمة (W7)، يطرح
 * الصفوف المستثناة، ثم يكتب رأس الموجة + يحدّث `productPrices` + يُدرج `priceChangeLog`.
 * إن سقط صفٌّ واحد ⇒ ROLLBACK كامل (withTx). المستدعي يفتح `withTx`.
 */
export async function applyPriceWave(
  tx: Tx,
  input: ApplyPriceWaveInput,
  actorUserId: number,
): Promise<{
  waveId: number;
  totalRows: number;
  skippedRows: number;
  excludedRows: number;
}> {
  if (!input.name.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الموجة مطلوب" });
  }

  const computed = await computeAffectedRows(tx, input);

  // W7 — بصمة المعاينة. الاختلاف يعني أنّ ما سيُطبَّق ليس ما أقرّه المدير: إمّا غيّر مديرٌ آخر
  // سعراً، أو أنّ هذه **نقرةٌ ثانية** على زرّ التطبيق (النقرة الأولى غيّرت الأسعار فتغيّرت البصمة).
  // ⇒ هذا الحارس وحده يمنع «+١٠٪ مرّتين = +٢١٪» بلا أيّ مفتاح تكرارٍ ولا عمودٍ له.
  if (
    input.expectedFingerprint &&
    input.expectedFingerprint !== computed.fingerprint
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "تغيّرت الأسعار أو نتيجة الفلاتر منذ معاينتك (مدير آخر عدّل سعراً، أو أنّ الموجة طُبِّقت بالفعل). " +
        "أعِد المعاينة لترى الوضع الحاليّ قبل التطبيق.",
    });
  }

  const excluded = input.excluded ?? [];
  const excludedSet = new Set(excluded.map(rowKey));
  const rows = excludedSet.size
    ? computed.rows.filter((r) => !excludedSet.has(rowKey(r)))
    : computed.rows;
  // القياس على المجموعة المُزالة التكرار لا على طول المصفوفة: زوجٌ مكرّر في حمولة العميل
  // يُنقص صفّاً واحداً فقط، فمقارنتُه بالطول تُنتج «تعارضاً» كاذباً يمنع موجةً سليمة.
  const unknownExcluded =
    excludedSet.size - (computed.rows.length - rows.length);
  if (unknownExcluded > 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `${unknownExcluded} صفّاً استثنيتَه لم يعد ضمن نتيجة الموجة — أعِد المعاينة.`,
    });
  }

  if (!rows.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا صفوف تُطابق فلاتر الموجة — لا شيء لتحديثه",
    });
  }
  if (rows.length > MAX_WAVE_ROWS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `الموجة تشمل ${rows.length.toLocaleString("en-US")} صفّاً وهو فوق السقف (${MAX_WAVE_ROWS.toLocaleString("en-US")}). ضيّق النطاق ونفّذها على دفعات.`,
    });
  }

  // W3: لا نسمح ببيعٍ تحت التكلفة إلّا بإذن صريح.
  const belowCostRows = rows.filter((r) => r.belowCost);
  if (belowCostRows.length && !input.allowBelowCost) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${belowCostRows.length} صفّ سعرها الجديد تحت تكلفة وحدتها — أذّن allowBelowCost أو راجع الفلاتر`,
    });
  }

  const storedScope: StoredWaveScope = {
    v: 2,
    scope: input.filters.scope,
    categoryId: input.filters.categoryId ?? null,
    productSearch: input.filters.productSearch?.trim() || null,
    priceTier: input.filters.priceTier ?? null,
    productIds: input.filters.productIds?.length
      ? input.filters.productIds.map(Number)
      : null,
    roundToDenom: Number(input.roundToDenom ?? 0),
    excludedCount: excludedSet.size,
    skippedCount: computed.skipped.length,
  };

  const waveRes = await tx.insert(priceUpdateWaves).values({
    name: input.name.trim(),
    description: input.description?.trim() || null,
    changeType: input.changeType,
    changeValue: toDbMoney(input.changeValue),
    filtersJson: JSON.stringify(storedScope),
    totalRows: rows.length,
    appliedBy: actorUserId,
  });
  const waveId = extractInsertId(waveRes);

  await writePriceRows(tx, rows, {
    waveId,
    actorUserId,
    reason: input.reason?.trim() || null,
  });

  return {
    waveId,
    totalRows: rows.length,
    skippedRows: computed.skipped.length,
    excludedRows: excludedSet.size,
  };
}

/**
 * الكتابة المُجمَّعة: تحديث `productPrices` بـCASE على المفتاح الأساسيّ (آمنٌ لأنّه عمودٌ واحد)،
 * وإدراج `priceChangeLog` بدفعات. كانت الحلقة السابقة تُصدر UPDATE+INSERT لكل صفّ ⇒ ١٠٠٠٠
 * استعلامٍ لموجة ٥٠٠٠ صفّ داخل معاملةٍ واحدة. الترتيب الحتميّ (W5) محفوظ.
 */
async function writePriceRows(
  tx: Tx,
  rows: Array<{
    priceRowId: number;
    productUnitId: number;
    priceTier: PriceTier;
    oldPrice: string;
    newPrice: string;
  }>,
  meta: { waveId: number | null; actorUserId: number; reason: string | null },
): Promise<void> {
  for (let i = 0; i < rows.length; i += UPDATE_CHUNK) {
    const chunk = rows.slice(i, i + UPDATE_CHUNK);
    const branches = sql.join(
      chunk.map((r) => sql`WHEN ${r.priceRowId} THEN ${r.newPrice}`),
      sql` `,
    );
    await tx
      .update(productPrices)
      .set({
        price: sql`CASE ${productPrices.id} ${branches} ELSE ${productPrices.price} END`,
      })
      .where(
        inArray(
          productPrices.id,
          chunk.map((r) => r.priceRowId),
        ),
      );
  }

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    await tx.insert(priceChangeLog).values(
      chunk.map((r) => ({
        productUnitId: r.productUnitId,
        priceTier: r.priceTier,
        oldPrice: r.oldPrice,
        newPrice: r.newPrice,
        reason: meta.reason,
        waveId: meta.waveId,
        actorUserId: meta.actorUserId,
      })),
    );
  }
}

/** قائمة الموجات المطبَّقة (للتاريخ في الشاشة). */
export async function listPriceWaves(tx: Tx, limit = 50) {
  // تدقيق ١٧/٧: كان asc + limit + reverse يقتطع **أقدم** ٥٠ موجةً ثم يعكس ترتيب عرضها ⇒ الموجات
  // الجديدة تختفي بعد تجاوز ٥٠. الصحيح: desc + limit ⇒ أحدث ٥٠ موجةً فعلاً. desc(id) يكسر تعادل
  // appliedAt (موجتان في الثانية نفسها) حتمياً ⇒ الأحدث إدراجاً أوّلاً.
  return tx
    .select()
    .from(priceUpdateWaves)
    .orderBy(desc(priceUpdateWaves.appliedAt), desc(priceUpdateWaves.id))
    .limit(limit);
}

/** سجلّ تغييرات سعرٍ محدَّد (لعرض «تاريخ السعر» على شاشة تعديل المنتج). */
export async function getPriceUnitHistory(
  tx: Tx,
  productUnitId: number,
  limit = 50,
) {
  // تدقيق ١٧/٧: كان asc ⇒ أقدم ٥٠ تغييراً؛ الصحيح desc ⇒ أحدث التغييرات أولاً (desc(id) لكسر تعادل الوقت).
  return tx
    .select()
    .from(priceChangeLog)
    .where(eq(priceChangeLog.productUnitId, productUnitId))
    .orderBy(desc(priceChangeLog.createdAt), desc(priceChangeLog.id))
    .limit(limit);
}

/** أسماء منفّذ التغيير وموجة التسعير اللازمة لعرض سجلّ الوحدة بلا كشف بيانات حساب إضافية. */
export async function enrichPriceHistoryMetadata(
  tx: Tx,
  rows: Array<{ actorUserId: number; waveId: number | null }>,
) {
  const actorIds = Array.from(new Set(rows.map((r) => Number(r.actorUserId))));
  const waveIds = Array.from(
    new Set(
      rows
        .map((r) => (r.waveId == null ? null : Number(r.waveId)))
        .filter((id): id is number => id != null),
    ),
  );

  const actorRows = actorIds.length
    ? await tx
        .select({ id: users.id, name: users.name, username: users.username })
        .from(users)
        .where(inArray(users.id, actorIds))
    : [];
  const waveRows = waveIds.length
    ? await tx
        .select({ id: priceUpdateWaves.id, name: priceUpdateWaves.name })
        .from(priceUpdateWaves)
        .where(inArray(priceUpdateWaves.id, waveIds))
    : [];

  return {
    actors: new Map(
      actorRows.map((r) => [
        Number(r.id),
        r.name?.trim() || r.username?.trim() || null,
      ]),
    ),
    waves: new Map(waveRows.map((r) => [Number(r.id), r.name])),
  };
}

/** ملء أسماء الوحدات لصفوف السجلّ (لعرض friendly في التقارير). */
export async function enrichLogRows(
  tx: Tx,
  rows: Array<{ productUnitId: number }>,
) {
  const ids = Array.from(new Set(rows.map((r) => Number(r.productUnitId))));
  if (!ids.length)
    return new Map<
      number,
      { productName: string; unitName: string; sku: string }
    >();
  const found = await tx
    .select({
      id: productUnits.id,
      unitName: productUnits.unitName,
      productName: products.name,
      sku: productVariants.sku,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.id, ids));
  const map = new Map<
    number,
    { productName: string; unitName: string; sku: string }
  >();
  for (const r of found)
    map.set(Number(r.id), {
      productName: r.productName,
      unitName: r.unitName,
      sku: r.sku,
    });
  return map;
}

/** عدّاد النطاق الحيّ — يُغذّي شارة «كم سيتأثّر» في خطوة اختيار النطاق قبل أيّ حساب. */
export async function countPriceWaveScope(
  tx: Tx,
  filters: PriceWaveFilters,
): Promise<{
  products: number;
  priceRows: number;
  sample: {
    productName: string;
    unitName: string;
    priceTier: PriceTier;
    price: string;
    unitCost: string | null;
  } | null;
}> {
  assertScope(filters);

  const conditions: any[] = [
    eq(products.isActive, true),
    eq(productUnits.isActive, true),
    eq(productVariants.isActive, true),
  ];
  if (filters.categoryId != null && filters.categoryId > 0) {
    const ids = await categoryIdsWithChildren(tx, filters.categoryId);
    conditions.push(
      ids.length > 1
        ? inArray(products.categoryId, ids)
        : eq(products.categoryId, filters.categoryId),
    );
  }
  const search = buildCatalogSearchWhere(filters.productSearch ?? undefined);
  if (search) conditions.push(search);
  if (filters.priceTier)
    conditions.push(eq(productPrices.priceTier, filters.priceTier));
  if (filters.scope === "SELECTED" && filters.productIds?.length) {
    conditions.push(inArray(products.id, filters.productIds.map(Number)));
  }
  const where = and(...conditions);

  const [agg] = await tx
    .select({
      priceRows: sql<number>`count(*)`,
      products: sql<number>`count(distinct ${products.id})`,
    })
    .from(productPrices)
    .innerJoin(productUnits, eq(productPrices.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(where);

  // عيّنةٌ حقيقية من نطاق المدير نفسه ⇒ «المثال الحيّ» في خطوة القاعدة يتحدّث ببياناته لا بأرقامٍ مخترعة.
  const sampleRows = await tx
    .select({
      productName: products.name,
      unitName: productUnits.unitName,
      priceTier: productPrices.priceTier,
      price: productPrices.price,
      baseCost: productVariants.costPrice,
      conversionFactor: productUnits.conversionFactor,
      isBundle: products.isBundle,
    })
    .from(productPrices)
    .innerJoin(productUnits, eq(productPrices.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(where)
    .orderBy(asc(productPrices.productUnitId), asc(productPrices.priceTier))
    .limit(1);

  const s = sampleRows[0];
  const sample = s
    ? {
        productName: s.productName,
        unitName: s.unitName,
        priceTier: s.priceTier as PriceTier,
        price: toDbMoney(money(s.price)),
        unitCost:
          s.isBundle || s.baseCost == null || money(s.baseCost).lte(0)
            ? null
            : toDbMoney(
                money(s.baseCost).mul(money(s.conversionFactor ?? "1")),
              ),
      }
    : null;

  return {
    products: Number(agg?.products ?? 0),
    priceRows: Number(agg?.priceRows ?? 0),
    sample,
  };
}

/** الموجات المُتراجَع عنها ضمن قائمةٍ معروضة — لعرض شارة «مُتراجَعٌ عنها» بلا استعلامٍ لكل صفّ. */
export async function findRevertedWaveIds(
  tx: Tx,
  waveIds: number[],
): Promise<Set<number>> {
  const ids = Array.from(
    new Set(
      waveIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0),
    ),
  );
  if (!ids.length) return new Set<number>();
  const rows = await tx
    .select({ revertsWaveId: priceUpdateWaves.revertsWaveId })
    .from(priceUpdateWaves)
    .where(inArray(priceUpdateWaves.revertsWaveId, ids));
  return new Set(rows.map((r) => Number(r.revertsWaveId)));
}

export interface RevertConflict {
  productUnitId: number;
  productName: string;
  unitName: string;
  priceTier: PriceTier;
  /** ما تركته الموجة. */
  waveNewPrice: string;
  /** ما هو عليه الآن (تغيّر بعد الموجة). */
  currentPrice: string;
}

/**
 * التراجع عن موجة — استعادةُ `oldPrice` المسجَّل لكل صفّ.
 *
 * لماذا لا «موجة عكسية»: عكسُ رفعٍ ‎10٪ ليس تخفيضاً ‎10٪ (‎100 → ‎110 → ‎99). الاستعادة الوحيدة
 * الصحيحة هي القيمة المحفوظة نفسها، وهي موجودةٌ كاملةً في `priceChangeLog.oldPrice`.
 *
 * **لا استعادةَ صامتة:** صفٌّ تغيّر بعد الموجة (موجةٌ لاحقة أو تعديلٌ يدويّ) لا يُلمَس، ويُردّ
 * ضمن `conflicts`. المدير وحده يقرّر بـ`force` أن يستعيد الباقي ويترك المتعارض كما هو.
 *
 * والتراجع **حدثٌ موثَّق** لا محوٌ للتاريخ: يُكتب رأس موجةٍ من نوع `REVERT` مربوطٌ بالأصل عبر
 * `revertsWaveId` (وفهرسٌ فريد يمنع التراجع مرّتين)، وسجلٌّ لكل صفٍّ مُستعاد.
 */
export async function revertPriceWave(
  tx: Tx,
  waveId: number,
  actorUserId: number,
  opts: { force?: boolean; reason?: string | null } = {},
): Promise<{
  waveId: number;
  restoredRows: number;
  conflicts: RevertConflict[];
}> {
  const [wave] = await tx
    .select()
    .from(priceUpdateWaves)
    .where(eq(priceUpdateWaves.id, waveId))
    .limit(1);
  if (!wave) {
    throw new TRPCError({ code: "NOT_FOUND", message: "الموجة غير موجودة" });
  }
  if (wave.changeType === "REVERT") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "لا يُتراجَع عن موجة تراجعٍ — تراجعْ عن الموجة الأصلية أو أنشئ موجةً جديدة.",
    });
  }
  const [already] = await tx
    .select({ id: priceUpdateWaves.id })
    .from(priceUpdateWaves)
    .where(eq(priceUpdateWaves.revertsWaveId, waveId))
    .limit(1);
  if (already) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `سبق التراجع عن هذه الموجة (موجة التراجع #${Number(already.id)}).`,
    });
  }

  const logRows = await tx
    .select()
    .from(priceChangeLog)
    .where(eq(priceChangeLog.waveId, waveId))
    .orderBy(asc(priceChangeLog.productUnitId), asc(priceChangeLog.priceTier));
  if (!logRows.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا صفوف مسجَّلة لهذه الموجة — لا شيء لاستعادته.",
    });
  }

  const unitIds = Array.from(
    new Set(logRows.map((l) => Number(l.productUnitId))),
  );
  // قفلٌ على صفوف الأسعار المعنيّة قبل المقارنة والكتابة (لا يقرأ أحدٌ حالةً نستبدلها تحته).
  const current = await tx
    .select({
      id: productPrices.id,
      productUnitId: productPrices.productUnitId,
      priceTier: productPrices.priceTier,
      price: productPrices.price,
    })
    .from(productPrices)
    .where(inArray(productPrices.productUnitId, unitIds))
    .for("update");
  const currentMap = new Map(
    current.map((c) => [`${Number(c.productUnitId)}:${c.priceTier}`, c]),
  );
  const names = await enrichLogRows(
    tx,
    logRows.map((l) => ({ productUnitId: Number(l.productUnitId) })),
  );

  const restorable: Array<{
    priceRowId: number;
    productUnitId: number;
    priceTier: PriceTier;
    oldPrice: string;
    newPrice: string;
  }> = [];
  const conflicts: RevertConflict[] = [];

  for (const l of logRows) {
    const key = `${Number(l.productUnitId)}:${l.priceTier}`;
    const cur = currentMap.get(key);
    const meta = names.get(Number(l.productUnitId));
    if (!cur) continue; // حُذف صفّ السعر منذ الموجة — لا شيء لاستعادته.
    if (l.oldPrice == null) continue; // سعرٌ أُنشئ لا عُدِّل ⇒ التراجع عنه حذفٌ، وليس مسار هذه الدالّة.
    if (!money(cur.price).equals(money(l.newPrice))) {
      conflicts.push({
        productUnitId: Number(l.productUnitId),
        productName: meta?.productName ?? "—",
        unitName: meta?.unitName ?? "—",
        priceTier: l.priceTier as PriceTier,
        waveNewPrice: toDbMoney(money(l.newPrice)),
        currentPrice: toDbMoney(money(cur.price)),
      });
      continue;
    }
    restorable.push({
      priceRowId: Number(cur.id),
      productUnitId: Number(l.productUnitId),
      priceTier: l.priceTier as PriceTier,
      // الاستعادة تقلب الاتجاه: القديم يصير الجديد، وسجلُّ التراجع يوثّق ذلك صراحةً.
      oldPrice: toDbMoney(money(l.newPrice)),
      newPrice: toDbMoney(money(l.oldPrice)),
    });
  }

  if (conflicts.length && !opts.force) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        `${conflicts.length} صفّاً تغيّر سعره بعد هذه الموجة (موجةٌ لاحقة أو تعديلٌ يدويّ) — استعادتُه ` +
        `تمحو تغييراً أحدث. أكّد «استعِد الباقي» لتطبيق الاستعادة على ${restorable.length} صفّاً فقط.`,
    });
  }
  if (!restorable.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا صفّ قابلٌ للاستعادة — كل صفوف الموجة تغيّرت بعدها.",
    });
  }

  const revertRes = await tx.insert(priceUpdateWaves).values({
    name: `تراجع عن: ${wave.name}`.slice(0, 255),
    description:
      `استعادة أسعار ما قبل الموجة #${waveId}` +
      (conflicts.length ? ` (تُرك ${conflicts.length} صفّاً تغيّر بعدها)` : ""),
    changeType: "REVERT",
    changeValue: "0",
    filtersJson: JSON.stringify({
      v: 2,
      revertsWaveId: waveId,
      conflicts: conflicts.length,
      forced: !!opts.force,
    }),
    totalRows: restorable.length,
    appliedBy: actorUserId,
    revertsWaveId: waveId,
  });
  const revertWaveId = extractInsertId(revertRes);

  await writePriceRows(tx, restorable, {
    waveId: revertWaveId,
    actorUserId,
    reason: opts.reason?.trim() || `تراجع عن موجة #${waveId}`,
  });

  return { waveId: revertWaveId, restoredRows: restorable.length, conflicts };
}

/** استعلامٌ مساعد للتقارير: صفوف موجةٍ بلا موجة (تعديلات يدوية) — يبقى للاتّساق مع القرّاء الحاليين. */
export async function listManualPriceChanges(tx: Tx, limit = 100) {
  return tx
    .select()
    .from(priceChangeLog)
    .where(isNull(priceChangeLog.waveId))
    .orderBy(desc(priceChangeLog.createdAt), desc(priceChangeLog.id))
    .limit(limit);
}
