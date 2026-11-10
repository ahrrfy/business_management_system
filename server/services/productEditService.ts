/**
 * productEditService.ts — تعديل منتج بنموذج المتغيّرات المستقلة (product-variants).
 *
 * شقيق `catalogService.createProduct` لكن للتعديل: يقرأ المنتج بكامل متغيّراته/وحداته/
 * أسعاره (مع reorderPoint/isActive)، ويحدّثه ضمن معاملة ذرّية واحدة — يحدّث المتغيّرات
 * الموجودة، يضيف الجديدة، ويعطّل (لا يحذف) ما يُلغى حفظاً للمخزون والحركات والتاريخ.
 *
 * الوحدات قالبٌ مشترك (اسم/معامل/سعر) تُطابَق بالاسم لكل متغيّر، **والباركود مستقل لكل
 * (متغيّر×وحدة)**. لا يلمس المخزون — أرصدة الفروع تُدار عبر شاشات الجرد/الحركات.
 */
import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { branchStock, bundleComponents, invoiceItems, inventoryMovements, productImages, productPrices, productUnitBarcodes, productUnits, productVariants, products, suppliers } from "../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import type { PermissionMap } from "@shared/permissions";
import { canCarryStockUsage, isSellableStockUsage, type StockUsage } from "@shared/stockUsage";
import { getDb } from "../db";
import type { Tx } from "../db";
import {
  acquireCatalogBarcodeWriteLock,
  addUnitBarcodeAliasTx,
  findBarcodeClashes,
  migrateAliases,
  removeUnitBarcodeAliasTx,
} from "./catalog/barcodeAliases";
import { barcodeComparisonKey, barcodeIdentityCandidates, barcodesEquivalent, canonicalizeBarcodeInput, canonicalizeBarcodeForStorage } from "@shared/barcodeNormalize";
import { resolveChannelLabelsOnUpdate } from "@shared/productChannelTitles";
import type { VariantKind } from "../../shared/variantDisplay";
import { assertConsignmentValid } from "./catalog/productCreate";
import { assertValidUnitFactors } from "./catalog/unitFactors";
// م٦ (D5): الحرّاس المشتركة مصدرُها الواحد `./catalog/productUpdateGuards`.
import {
  assertBaseUnitStableAndRevalueCost,
  assertBundleEditShape,
  assertHasVariants,
  assertNoActiveStocktakeFactorChange,
  assertNoActiveStocktakeUnitFreeze,
  assertStorefrontPublishReadyTx,
  assertUniqueNormalizedVariantCombos,
  assertUniqueUnitNamesAndTiers,
  assertUnitFactorImmutableIfUsed,
  assertVariantIdentityImmutableIfUsed,
  loadProductForUpdateOrThrow,
  lockUnitsAndAssertNoActiveOnlineOrderChanges,
  lockVariantsForUpdate,
  logUnitPriceChanges,
  snapshotProductBeforeUpdate,
} from "./catalog/productUpdateGuards";
import { toDbMoney } from "./money";
import type { PriceTier } from "./pricing";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { rejectLegacyCatalogMediaWrite } from "./catalog/mediaWriteGuard";
import { PRINT_SERVICE_TYPE } from "./printSaleService";
import type { ProductRecipeChange } from "@shared/productRecipeSave";
import { prepareProductRecipeChangeTx } from "./recipeService";

/* ============================ القراءة (للتعديل) ============================ */
// نُقلت إلى `./catalog/productEditDocument.ts` (م٦ ق٨ — مستندُ التعديل صار مصدرَ اللقطة). يُعاد تصديرها هنا
// كي يبقى كلُّ مستورِدٍ قائم (الراوتر/الاختبارات) على حاله.
export {
  getProductForVariantEdit,
  type ProductForVariantEdit,
  type ProductImageRow,
  type VariantEditRow,
  type VariantEditUnit,
} from "./catalog/productEditDocument";

/* ============================ الكتابة (التعديل) ============================ */

export interface UpdateUnitTemplate {
  unitName: string;
  conversionFactor: string;
  isBaseUnit: boolean;
  isStoreSaleUnit?: boolean;
  prices: Array<{ priceTier: PriceTier; price: string }>;
}

export interface UpdateVariantRow {
  id?: number; // موجود ⇒ تحديث؛ غائب ⇒ إضافة
  sku: string;
  /** نوع المتغيّر (م٣): ALTERNATIVE = بديلٌ مستقلّ يلزمه اسمٌ وباركود. الافتراض VARIANT. */
  variantKind?: VariantKind;
  /** اسم البديل (إلزاميّ وفريدٌ داخل المنتج للبدائل) أو اسمٌ وصفيّ للتنويعة. */
  variantName?: string | null;
  color?: string | null;
  colorHex?: string | null;
  size?: string | null;
  costPrice: string;
  /** سبب تغيير التكلفة (priceSanity L1.7) — إلزاميّ للتغيّرات الكبيرة، يُلتقَط في أثر product.costChange. */
  costChangeReason?: string | null;
  /** سعر خاص لمفرد وحدة الأساس لهذا المتغيّر — فارغ ⇒ يتبع سعر القالب المشترك. */
  baseRetail?: string;
  minStock?: number;
  reorderPoint?: number;
  isActive?: boolean;
  /** صورة هذا اللون — string ⇒ تُعيَّن، null/"" ⇒ تُزال (يُعاد التوفيق في كل حفظ). */
  image?: string | null;
  /** باركود لكل وحدة بمفتاح اسم الوحدة. */
  unitBarcodes: Record<string, string>;
  /** بدائل الباركود المرغوبة لكل وحدة بمفتاح اسم الوحدة — تُوفَّق ذرّياً داخل نفس المعاملة. */
  barcodeAliases?: Record<string, Array<{ barcode: string; note?: string | null }>>;
}

/** صورة منتج عامّة في حمولة التعديل — metadata لصورة مملوكة فقط.
 *  `url` مقبول للتوافق إن طابق المخزَّن حرفياً؛ أي URL جديد/مختلف يُرفض لصالح Product Studio/R2. */
export interface UpdateProductImageInput {
  id?: number;
  url?: string | null;
  isPrimary?: boolean;
  sortOrder?: number;
}

export interface UpdateProductVariantsInput {
  productId: number;
  name?: string | null;
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
  allowAutoCartRecommendations?: boolean;
  isService?: boolean;
  /** «يُباع بالطلب» — نمط PATCH: `undefined` ⇒ لا تُمَسّ. */
  allowBackorder?: boolean;
  isActive?: boolean;
  stockUsage?: StockUsage | null;
  showInStore?: boolean;
  // ٢٤/٨ — متابعةُ PR #755: تحرير التوجيه بعد الإنشاء. اختياريّان بلا افتراض — نمط PATCH.
  showInReception?: boolean;
  showInPrintPos?: boolean;
  showInQuotations?: boolean;
  showInAdvancedSales?: boolean;
  isConsignment?: boolean;
  consignorId?: number | null;
  unitTemplate: UpdateUnitTemplate[];
  variants: UpdateVariantRow[];
  /** صور المنتج العامّة (variantId=NULL). `undefined` ⇒ لا تُمَسّ؛ المعرّفات القائمة تُعاد ترتيباتها،
   *  والمُزال يُحذف. الإضافة/الاستبدال المباشر مرفوضان لصالح Product Studio/R2. */
  images?: UpdateProductImageInput[];
  /** سببُ التعديل — يُلحق بلقطة `recordVersions` ويظهر في سجلّ النسخ (م٦ ق٨). اختياريّ. */
  updateReason?: string | null;
  /** Optional recipe draft; saved in the same transaction as the product. */
  recipeChange?: ProductRecipeChange;
}

// الاسم الصريح (input.name) هو المرجع الأول: المنتجات المستوردة تحمل اسماً كاملاً في `name`
// بلا أجزاء (نوع/ماركة/موديل)، وحقل «اسم المنتج» في شاشة التعديل يحرّره مباشرةً. الأجزاء الثلاثة
// تبقى وصفاً اختيارياً (تصنيف/بحث) ولا تَجُبّ الاسم الصريح. عند غياب الاسم الصريح نركّب من الأجزاء.
function composeName(input: UpdateProductVariantsInput, fallback: string): string {
  const explicit = (input.name ?? "").trim();
  const composed = [input.productType, input.brand, input.modelName].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return explicit || composed || fallback;
}

export type UpdateProductVariantsActor = Actor & {
  permissionsOverride?: PermissionMap | null;
};

function assertNonNegativeMoneyDecimal(raw: string, label: string): void {
  const trimmed = (raw ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `قيمة مالية غير صالحة في «${label}»`,
        why: "المبالغ المالية بالدينار العراقي يجب أن تكون غير سالبة وبمنزلتين عشريتين كحدّ أقصى",
        doThis: "صحّح القيمة المالية ثم أعد الحفظ",
      }),
    });
  }
  const dec = new Decimal(trimmed);
  if (!dec.isFinite() || dec.isNegative() || dec.decimalPlaces() > 2) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `قيمة مالية غير صالحة في «${label}»`,
        why: "المبلغ المالي خارج النطاق المسموح",
        doThis: "صحّح القيمة المالية ثم أعد الحفظ",
      }),
    });
  }
}

/** يرفض الباركود المكرّر (أساسياً أو بديلاً) داخل المنتج أو ضدّ منتجات أخرى، ويرفض SKU المكرّر. */
async function assertEditUniqueness(tx: Tx, input: UpdateProductVariantsInput) {
  const unitNames = input.unitTemplate.map((u) => u.unitName.trim());
  const codes: string[] = [];
  for (const v of input.variants) {
    for (const n of unitNames) {
      const b = canonicalizeBarcodeInput(v.unitBarcodes[n] ?? "");
      if (b) codes.push(b);
      for (const alias of v.barcodeAliases?.[n] ?? []) {
        const ab = canonicalizeBarcodeInput(alias.barcode ?? "");
        if (ab) codes.push(ab);
      }
    }
  }
  const seen = new Set<string>();
  for (const c of codes) {
    const identities = barcodeIdentityCandidates(c).map(barcodeComparisonKey);
    if (identities.some((identity) => seen.has(identity))) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `الباركود ${c} مكرّر داخل المنتج — لكل وحدة/لون باركود فريد.`,
      });
    }
    identities.forEach((identity) => seen.add(identity));
  }
  if (seen.size) {
    const taken = await findBarcodeClashes(tx, codes, {
      ignoreProductIds: [input.productId],
      forShare: true,
    });
    if (taken[0]) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `الباركود ${taken[0].code} مُستخدَم في «${taken[0].takenBy}».`,
      });
    }
  }

  const skus = input.variants.map((v) => v.sku.trim()).filter(Boolean);
  const seenSku = new Set<string>();
  for (const s of skus) {
    if (seenSku.has(s)) throw new TRPCError({ code: "CONFLICT", message: `الرمز ${s} (SKU) مكرّر بين المتغيّرات.` });
    seenSku.add(s);
  }
}

/** يُكتب وحدات متغيّر وأسعاره من القالب المشترك + باركوده الخاص (تحديث بالاسم أو إدراج).
 *  `baseRetailOverride` (إن وُجد) يحلّ محلّ سعر مفرد وحدة الأساس لهذا المتغيّر فقط. */
async function upsertVariantUnits(
  tx: Tx,
  variantId: number,
  template: UpdateUnitTemplate[],
  unitBarcodes: Record<string, string>,
  barcodeAliases: Record<string, Array<{ barcode: string; note?: string | null }>> | undefined,
  baseRetailOverride: string | undefined,
  actor: Actor,
) {
  const existing = await tx.select().from(productUnits).where(eq(productUnits.variantId, variantId));
  // تجميد هيكل وهوية الوحدات أثناء الجرد النشط (Codex P2)
  await assertNoActiveStocktakeUnitFreeze(
    tx,
    variantId,
    existing,
    template.map((t) => ({
      ...t,
      barcode: (unitBarcodes[t.unitName.trim()] ?? "").trim() || null,
    })),
  );

  // إن أرسل المستدعي بدائل الباركود المرغوبة، نزيل البدائل المُسقطة قبل فحص/كتابة الأساسيات داخل نفس المعاملة
  // حتى تنجح ترقية بديلٍ إلى باركود أساسيّ لنفس الوحدة ذرّياً.
  if (barcodeAliases !== undefined && existing.length > 0) {
    const existingUnitIds = existing.map((u) => Number(u.id));
    const currentAliases = await tx
      .select({
        id: productUnitBarcodes.id,
        productUnitId: productUnitBarcodes.productUnitId,
        barcode: productUnitBarcodes.barcode,
      })
      .from(productUnitBarcodes)
      .where(inArray(productUnitBarcodes.productUnitId, existingUnitIds))
      .for("update");
    const unitNameById = new Map(existing.map((u) => [Number(u.id), u.unitName.trim()]));
    for (const aliasRow of currentAliases) {
      const uName = unitNameById.get(Number(aliasRow.productUnitId));
      if (!uName || !(uName in barcodeAliases)) continue;
      const desiredList = barcodeAliases[uName] ?? [];
      const stillDesired = desiredList.some((d) => barcodesEquivalent(d.barcode ?? "", aliasRow.barcode));
      if (!stillDesired) {
        await removeUnitBarcodeAliasTx(tx, Number(aliasRow.id), { lockAlreadyHeld: true });
      }
    }
  }

  const keep = new Set<number>();
  const codesToWrite = template
    .map((t) => (unitBarcodes[t.unitName.trim()] ?? "").trim())
    .filter(Boolean);
  if (codesToWrite.length) {
    const clashes = await findBarcodeClashes(tx, codesToWrite, {
      ignorePrimaryUnitIds: existing.map((u) => Number(u.id)),
      forShare: true,
    });
    if (clashes[0]) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `الباركود ${clashes[0].code} مُستخدَم في «${clashes[0].takenBy}».`,
      });
    }
  }
  const override = (baseRetailOverride ?? "").trim();
  const priceRows: { productUnitId: number; priceTier: PriceTier; price: string }[] = [];
  const inserted: Array<{ unitId: number; barcode: string | null }> = [];
  const unitIdByName = new Map<string, number>();
  for (const t of template) {
    const name = t.unitName.trim();
    // يُحفَظ حرفيّاً بصيغة المصنع (يُبقي المسافة الداخلية)؛ المطابقة أدناه عبر `barcodesEquivalent`
    // و`findBarcodeClashes` تُطبّع داخليّاً للهوية، فلا يتأثّر حلُّ الملكية ولا كشفُ التعارض.
    const barcode = canonicalizeBarcodeForStorage(unitBarcodes[name] ?? "") || null;
    // مطابقة الوحدة القائمة الذكية (حل ملكية الباركود أولاً مع التطبيع المعياري):
    // ١. بالباركود أولاً إن كان محدداً (حامل الهوية الثابتة للوحدة عند إعادة تسميتها)
    //    نطابق بالتكافؤ المعياري (barcodesEquivalent) ونرفض الالتباس إن تطابقت وحدتان.
    // ٢. بالاسم إن لم تُطابق بالباركود
    // ٣. بوحدة الأساس إن كانت هذه وحدة أساس ولم تُطابق بعد
    let match: (typeof existing)[number] | undefined;
    if (t.isBaseUnit) {
      // حارس مطابقة وحدة الأساس (Codex P1): وحدة الأساس لمتغيّرٍ قائم لا يجوز استبدال صفّها
      // أو مبادلتها مع وحدة فرعية بسبب تشابه باركود — صف الأساس القائم هو الممثل الحصري للأساس.
      match = existing.find((u) => !keep.has(Number(u.id)) && u.isBaseUnit);
    } else {
      // للوحدات الفرعية: نطابق فقط مع صفوف غير أساسية لمنع خطف صف الأساس
      if (barcode) {
        const barcodeMatches = existing.filter(
          (u) => !keep.has(Number(u.id)) && !u.isBaseUnit && u.barcode && barcodesEquivalent(u.barcode, barcode)
        );
        if (barcodeMatches.length > 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "توجد أكثر من وحدة قائمة بنفس هوية الباركود المُدخلة لهذا المتغيّر — يرجى تصحيح الباركودات لمنع التضارب.",
          });
        }
        if (barcodeMatches.length === 1) {
          match = barcodeMatches[0];
        }
      }
      if (!match) {
        // تفضيل الوحدة النشطة أولاً لمنع التقاط وحدة قديمة معطلة بنفس الاسم (Codex P2)
        match = existing.find((u) => !keep.has(Number(u.id)) && !u.isBaseUnit && u.unitName === name && u.isActive)
          ?? existing.find((u) => !keep.has(Number(u.id)) && !u.isBaseUnit && u.unitName === name);
      }
    }

    // تفريغ أي باركود متصادم محجوز في وحدة قديمة غير محتفظ بها لمنع خطأ ER_DUP_ENTRY قبل التحديث أو الإدراج
    if (barcode) {
      const clashingOld = existing.find(
        (u) => (!match || Number(u.id) !== Number(match.id)) && !keep.has(Number(u.id)) && u.barcode && barcodesEquivalent(u.barcode, barcode)
      );
      if (clashingOld) {
        await tx.update(productUnits).set({ barcode: null }).where(eq(productUnits.id, Number(clashingOld.id)));
        clashingOld.barcode = null;
      }
    }

    let unitId: number;
    // أسعارُ الوحدة القائمة **قبل** المسح — لسجلّ تغيّر السعر (Codex INV-05: هذا المسار لم يكن يكتبه).
    let previousByTier: Map<string, string> | null = null;
    if (match) {
      unitId = Number(match.id);
      await assertUnitFactorImmutableIfUsed(
        tx,
        unitId,
        match.conversionFactor,
        t.isBaseUnit ? "1" : t.conversionFactor,
        name,
      );
      if (!t.isBaseUnit) {
        await assertNoActiveStocktakeFactorChange(tx, variantId, [
          { unitName: name, oldFactor: match.conversionFactor, newFactor: t.conversionFactor },
        ]);
      }
      await tx
        .update(productUnits)
        .set({
          unitName: name,
          conversionFactor: t.isBaseUnit ? "1" : t.conversionFactor,
          barcode,
          isBaseUnit: t.isBaseUnit,
          isStoreSaleUnit: t.isStoreSaleUnit ?? t.isBaseUnit,
          isActive: true,
        })
        .where(eq(productUnits.id, unitId));
      match.unitName = name;
      match.conversionFactor = t.isBaseUnit ? "1" : t.conversionFactor;
      match.barcode = barcode;
      match.isBaseUnit = t.isBaseUnit;
      match.isStoreSaleUnit = t.isStoreSaleUnit ?? t.isBaseUnit;
      match.isActive = true;
      const previous = await tx
        .select({ priceTier: productPrices.priceTier, price: productPrices.price })
        .from(productPrices)
        .where(eq(productPrices.productUnitId, unitId));
      previousByTier = new Map(previous.map((row) => [row.priceTier, row.price] as const));
      await tx.delete(productPrices).where(eq(productPrices.productUnitId, unitId));
    } else {
      const res = await tx.insert(productUnits).values({
        variantId,
        unitName: name,
        conversionFactor: t.isBaseUnit ? "1" : t.conversionFactor,
        barcode,
        isBaseUnit: t.isBaseUnit,
        isStoreSaleUnit: t.isStoreSaleUnit ?? t.isBaseUnit,
      });
      unitId = extractInsertId(res);
      inserted.push({ unitId, barcode });
      existing.push({
        id: unitId,
        variantId,
        unitName: name,
        conversionFactor: t.isBaseUnit ? "1" : t.conversionFactor,
        barcode,
        isBaseUnit: t.isBaseUnit,
        isStoreSaleUnit: t.isStoreSaleUnit ?? t.isBaseUnit,
        isActive: true,
      } as (typeof existing)[number]);
    }
    keep.add(unitId);
    unitIdByName.set(name, unitId);
    const nextPrices: Array<{ priceTier: PriceTier; price: string }> = [];
    for (const pr of t.prices) {
      // سعر خاص لمفرد وحدة الأساس يَجُبّ سعر القالب لهذا المتغيّر.
      const price = t.isBaseUnit && pr.priceTier === "RETAIL" && override ? override : pr.price;
      if (price.trim()) {
        priceRows.push({ productUnitId: unitId, priceTier: pr.priceTier, price: toDbMoney(price) });
        nextPrices.push({ priceTier: pr.priceTier, price });
      }
    }
    // الوحدة القائمة وحدها لها «قبل» يُقارَن به (الجديدة بلا سابق — كما في مسار المعرّف).
    if (previousByTier) await logUnitPriceChanges(tx, { productUnitId: unitId, previousByTier, next: nextPrices, actor });
  }
  if (priceRows.length) await tx.insert(productPrices).values(priceRows);
  // وحدات لم تعد في القالب ⇒ تعطيل (حفظ التاريخ، لا حذف).
  // **صيانة هوية الباركود للوحدات المعطلة (Codex P1)**: لا نفرّغ الباركود للوحدة المعطلة
  // إلا إذا نُقل الباركود صراحةً لوحدة جديدة بديلة (خليفة successor)، وذلك لضمان بقاء
  // الباركود محجوزاً للمنتج الأصلي ومنع استيلائه من منتج آخر أو بيع مواد خاطئة عند مسح عبوات قديمة.
  const drop = existing.filter((u) => !keep.has(Number(u.id)));
  const transferredOldUnitIds = new Set<number>();
  for (const oldUnit of drop) {
    const oldBarcode = oldUnit.barcode;
    if (!oldBarcode) continue;
    const successor = inserted.find((i) => i.barcode && barcodesEquivalent(i.barcode, oldBarcode));
    if (successor) {
      await migrateAliases(tx, Number(oldUnit.id), successor.unitId);
      transferredOldUnitIds.add(Number(oldUnit.id));
    }
  }
  if (transferredOldUnitIds.size > 0) {
    await tx.update(productUnits).set({ barcode: null }).where(inArray(productUnits.id, Array.from(transferredOldUnitIds)));
  }
  if (drop.length) {
    await tx.update(productUnits).set({ isActive: false }).where(inArray(productUnits.id, drop.map((u) => Number(u.id))));
  }

  // توفيق بدائل الباركود ذرّياً داخل المعاملة نفسها (أي تعارض باركود يُسقط التعديل كلّه).
  if (barcodeAliases !== undefined) {
    for (const [rawUnitName, desired] of Object.entries(barcodeAliases)) {
      const targetUnitId = unitIdByName.get(rawUnitName.trim());
      if (!targetUnitId) continue;
      const currentRows = await tx
        .select({
          id: productUnitBarcodes.id,
          barcode: productUnitBarcodes.barcode,
        })
        .from(productUnitBarcodes)
        .where(eq(productUnitBarcodes.productUnitId, targetUnitId))
        .for("update");
      for (const cur of currentRows) {
        const stillDesired = desired.some((d) => barcodesEquivalent(d.barcode ?? "", cur.barcode));
        if (!stillDesired) {
          await removeUnitBarcodeAliasTx(tx, Number(cur.id), { lockAlreadyHeld: true });
        }
      }
      const remainingCodes = currentRows
        .filter((cur) => desired.some((d) => barcodesEquivalent(d.barcode ?? "", cur.barcode)))
        .map((cur) => cur.barcode);
      for (const d of desired) {
        const trimmed = (d.barcode ?? "").trim();
        if (!trimmed) continue;
        if (remainingCodes.some((c) => barcodesEquivalent(c, trimmed))) continue;
        await addUnitBarcodeAliasTx(tx, targetUnitId, trimmed, d.note ?? null, actor.userId, {
          lockAlreadyHeld: true,
        });
        remainingCodes.push(trimmed);
      }
    }
  }
}

/**
 * يوفّق صور المنتج العامّة (variantId=NULL) بمطابقة المعرّف — دون مسّ صور الألوان (variantId مضبوط):
 *   • id مملوك ⇒ تحديث metadata فقط (isPrimary/sortOrder)، و`url` لا بد أن يطابق المخزَّن.
 *   • بلا id (أو id غير مملوك) + `url` ⇒ رفض؛ النشر الوحيد عبر Product Studio/R2.
 *   • صورة قائمة لم تُذكَر في الحمولة ⇒ حذف (المستخدم أزالها).
 * الرئيسية: تُحترَم `isPrimary` المُرسَلة، وإلّا فالأولى رئيسيّة ضمن الصور القائمة.
 */
async function reconcileProductImages(tx: Tx, productId: number, desired: UpdateProductImageInput[]) {
  const items = desired.slice(0, 10); // نفس سقف الإنشاء (١٠ صور)
  const existing = await tx
    .select({ id: productImages.id, url: productImages.url })
    .from(productImages)
    .where(and(eq(productImages.productId, productId), isNull(productImages.variantId)));
  const existingIds = new Set(existing.map((r) => Number(r.id)));
  const anyPrimary = items.some((it) => it.isPrimary);
  const keep = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const isPrimary = anyPrimary ? !!it.isPrimary : i === 0;
    const sortOrder = it.sortOrder ?? i;
    const url = (it.url ?? "").trim();
    if (it.id != null && existingIds.has(it.id)) {
      // صورة قائمة مملوكة ⇒ metadata فقط. أيّ URL مختلف يعني محاولة نشر بايتات خارج
      // Product Studio/R2، فنرفض المعاملة كاملةً ولا نعيد وسمها MANUAL+APPROVED.
      keep.add(it.id);
      const current = existing.find((row) => Number(row.id) === it.id)!;
      const replacesBytes = Boolean(url && url !== current.url);
      if (replacesBytes) rejectLegacyCatalogMediaWrite();
      await tx.update(productImages).set({
        isPrimary,
        sortOrder,
      }).where(eq(productImages.id, it.id));
    } else if (url) {
      // جديدة أو id لا يخصّ المنتج: لا إدراج مباشر؛ المهمة المعتمدة في Product Studio هي
      // منفذ النشر الوحيد، كما يمنع هذا تحويل id أجنبي إلى صورة محلية جديدة.
      rejectLegacyCatalogMediaWrite();
    }
    // id مذكور بلا url ولا ملكية ⇒ تجاهُلٌ آمن (لا إدراج بلا بايتات).
  }
  const toDelete = existing.map((r) => Number(r.id)).filter((id) => !keep.has(id));
  if (toDelete.length) await tx.delete(productImages).where(inArray(productImages.id, toDelete));
}

/** تعديل منتج بنموذج المتغيّرات ضمن معاملة ذرّية. لا يحذف متغيّراً (تعطيل فقط) حفظاً للمخزون. */
export async function updateProductWithVariants(input: UpdateProductVariantsInput, actor: UpdateProductVariantsActor) {
  return withTx((tx) => updateProductWithVariantsTx(tx, input, actor),
    input.recipeChange ? { isolationLevel: "read committed" } : undefined);
}

/**
 * الجسم داخل معاملةٍ يملكها المستدعي — كي يضمّه مسارُ **الاستعادة** (`catalog/productVersioning.ts`) إلى
 * معاملته فتمرّ الاستعادةُ بالحرّاس نفسها وتكتب لقطتها في نفس المعاملة. لا تستدعِه من راوترٍ مباشرةً.
 */
export async function updateProductWithVariantsTx(tx: Tx, input: UpdateProductVariantsInput, actor: UpdateProductVariantsActor) {
    await acquireCatalogBarcodeWriteLock(tx);
    // Lock the union before the product's own row: recipe writers use products→variants.
    const saveRecipe = input.recipeChange
      ? await prepareProductRecipeChangeTx(tx, input.productId, input.recipeChange, actor)
      : null;
    const p = await loadProductForUpdateOrThrow(tx, input.productId);
    assertHasVariants(input.variants.length);
    const baseUnits = input.unitTemplate.filter((u) => u.isBaseUnit).length;
    if (baseUnits !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد وحدة أساس واحدة فقط في قالب الوحدات" });
    assertBundleEditShape(p, input.variants.length, baseUnits, {
      isService: input.isService,
      showInPrintPos: input.showInPrintPos,
    });
    if (input.unitTemplate.some((u) => !u.unitName.trim())) throw new TRPCError({ code: "BAD_REQUEST", message: "كل وحدة في القالب تحتاج اسماً" });
    assertUniqueUnitNamesAndTiers("قالب الوحدات", input.unitTemplate);
    assertValidUnitFactors(input.unitTemplate);
    for (const tplUnit of input.unitTemplate) {
      for (const pr of tplUnit.prices) {
        assertNonNegativeMoneyDecimal(pr.price, `سعر ${pr.priceTier} للوحدة ${tplUnit.unitName}`);
      }
    }
    if (input.variants.some((v) => !v.sku.trim())) throw new TRPCError({ code: "BAD_REQUEST", message: "كل متغيّر يحتاج SKU" });
    for (const v of input.variants) {
      assertNonNegativeMoneyDecimal(v.costPrice, `تكلفة المتغيّر ${v.sku}`);
      if (v.baseRetail && v.baseRetail.trim()) {
        assertNonNegativeMoneyDecimal(v.baseRetail, `السعر الخاص للمتغيّر ${v.sku}`);
      }
    }

    await assertEditUniqueness(tx, input);

    // تغيير وسم الأمانة أو المودِع: يشترط رصيداً صفرياً عبر كل الفروع.
    const wantConsign = input.isConsignment;
    const wantConsignor = input.consignorId;
    const wasConsign = !!p.isConsignment;
    const wasConsignor = p.consignorId != null ? Number(p.consignorId) : null;
    const consignmentChanged = wantConsign !== undefined && !!wantConsign !== wasConsign;
    const consignorChanged = wantConsignor !== undefined && (wantConsignor ?? null) !== wasConsignor;
    const serviceChanged = input.isService !== undefined && !!input.isService !== !!p.isService;
    const willBeService = input.isService ?? !!p.isService;
    // هذه هي القيمة التي سيكتبها UPDATE أدناه فعلاً: إظهار شبكة الطباعة أو التوجيه يفرض نوعها التشغيلي.
    const effectiveShowInPrintPos = input.showInPrintPos ?? !!p.showInPrintPos;
    const effectiveShowInReception = input.showInReception ?? !!p.showInReception;
    const effectiveShowInQuotations = input.showInQuotations ?? !!p.showInQuotations;
    const effectiveShowInAdvancedSales = input.showInAdvancedSales ?? !!p.showInAdvancedSales;
    // productType اختياري (PATCH): غيابه لا يمسح النوع التاريخي إلى NULL.
    const requestedProductType = input.productType === undefined ? (p.productType ?? null) : input.productType?.trim() || null;

    // توجيه خدمات الطباعة (م٦ + م٩): فرض productType='PRINT_SERVICE' ينطبق حصراً على الخدمات (willBeService=true)
    // عند تفعيل شبكة الطباعة أو توجيهات الخدمات أو كونها خدمة طباعة أصلاً.
    // السلع المخزنية (willBeService=false) لا تُحوَّل قط إلى PRINT_SERVICE بمجرد تفعيل توجيهات البيع،
    // حتى لا ينقلب تصنيفها المالي ولا تختفي من كاشير الباركود العادي.
    const hasServiceRouting = willBeService && (
      effectiveShowInPrintPos ||
      effectiveShowInReception ||
      effectiveShowInQuotations ||
      effectiveShowInAdvancedSales ||
      p.productType === PRINT_SERVICE_TYPE ||
      requestedProductType === PRINT_SERVICE_TYPE
    );
    const routingChanged =
      effectiveShowInPrintPos !== !!p.showInPrintPos ||
      effectiveShowInReception !== !!p.showInReception ||
      effectiveShowInQuotations !== !!p.showInQuotations ||
      effectiveShowInAdvancedSales !== !!p.showInAdvancedSales;
    // An unchanged legacy service must keep its historical route on a round-trip save.
    const shouldPromoteService = hasServiceRouting && (
      p.productType === PRINT_SERVICE_TYPE || requestedProductType === PRINT_SERVICE_TYPE ||
      serviceChanged || routingChanged
    );
    const effectiveProductType = shouldPromoteService ? PRINT_SERVICE_TYPE : requestedProductType;

    const operationalProductRoute = (type: string | null | undefined, isSvc: boolean): "PRINT_SERVICE" | "DIGITAL_CARD" | "STANDARD" => {
      if (type === "DIGITAL_CARD") return "DIGITAL_CARD";
      if (isSvc && type === PRINT_SERVICE_TYPE) return "PRINT_SERVICE";
      return "STANDARD";
    };
    const productRouteChanged = operationalProductRoute(effectiveProductType, willBeService) !== operationalProductRoute(p.productType, !!p.isService);

    // مكوّن البكج هو عقدٌ مخزني: تغيير المنتج لاحقاً إلى خدمة/أمانة يجعل بيع البكج
    // يخصم no-op أو أصلاً غير مملوك. امنع تغيير المعنى عند المصدر بدلاً من ترك كل بكج
    // مرتبط يتعطل وقت البيع. فك الارتباط من تعريفات البكجات أولاً ثم غيّر التصنيف.
    const willBeConsignment =
      wantConsign !== undefined ? !!wantConsign : !!p.isConsignment;
    if (
      (serviceChanged && willBeService) ||
      (consignmentChanged && willBeConsignment)
    ) {
      const [bundleReference] = await tx
        .select({
          bundleVariantId: bundleComponents.bundleVariantId,
          componentVariantId: bundleComponents.componentVariantId,
        })
        .from(bundleComponents)
        .innerJoin(
          productVariants,
          eq(bundleComponents.componentVariantId, productVariants.id),
        )
        .where(eq(productVariants.productId, input.productId))
        .limit(1);
      if (bundleReference) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "لا يمكن تغيير تصنيف منتج مستخدم كمكوّن بكج",
            why: `المتغيّر #${Number(bundleReference.componentVariantId)} مرتبط بالبكج #${Number(bundleReference.bundleVariantId)} كمادة مخزنية مملوكة`,
            doThis: "أزل المنتج من جميع تعريفات البكجات أولاً، ثم أعد تغيير التصنيف",
          }),
        });
      }
    }

    // تصنيفُ السطر التاريخي يُستدلّ اليوم من المنتج الحيّ عند البيع والمرتجع والإلغاء. لذلك تغيير
    // معناه بعد بيعه (نوع المسار، مخزني↔خدمة، مملوك↔أمانة، أو تبديل المودِع) يجعل نفس invoiceItem
    // يُعالج بقواعد مختلفة عن قواعد إنشائه. لا يكفي تصفير الرصيد: التاريخ المالي نفسه باقٍ. المنتج
    // الجديد هو حدّ النسخة الصحيح، والقديم يبقى مرجعاً ثابتاً للمستندات السابقة.
    if (productRouteChanged || serviceChanged || consignmentChanged || consignorChanged) {
      const [historicalLine] = await tx
        .select({ id: invoiceItems.id })
        .from(invoiceItems)
        .innerJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
        .where(eq(productVariants.productId, input.productId))
        .limit(1);
      let historicalMovement: { id: number } | undefined;
      if (!historicalLine) {
        [historicalMovement] = await tx
          .select({ id: inventoryMovements.id })
          .from(inventoryMovements)
          .innerJoin(productVariants, eq(inventoryMovements.variantId, productVariants.id))
          .where(eq(productVariants.productId, input.productId))
          .limit(1);
      }
      if (historicalLine || historicalMovement) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "لا يمكن تغيير التصنيف المالي لمنتج له تاريخ تشغيلي",
            why: "تغيير نوع المنتج أو الخدمة أو الأمانة أو المودِع سيجعل حركات المخزون أو المبيعات والمرتجعات والإلغاءات القديمة تُفسَّر بقواعد غير التي أُنشئت بها",
            doThis: "أنشئ منتجاً جديداً بالتصنيف المطلوب، ثم عطّل المنتج القديم للمبيعات الجديدة",
          }),
        });
      }
    }

    if (consignmentChanged || consignorChanged) {
      const stockRows = await tx
        .select({ qty: branchStock.quantity })
        .from(branchStock)
        .innerJoin(productVariants, eq(branchStock.variantId, productVariants.id))
        .where(eq(productVariants.productId, input.productId));
      const totalStock = stockRows.reduce((s, r) => s + (r.qty || 0), 0);
      if (totalStock !== 0)
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تغيير وسم الأمانة أو المودِع والرصيد غير صفري — صفِّر المخزون أولاً" });
      if (wantConsign) {
        await assertConsignmentValid(
          tx,
          { isConsignment: true, consignorId: wantConsignor, isService: input.isService ?? !!p.isService, isBundle: !!p.isBundle },
          input.variants.map((v) => v.costPrice),
        );
      }
    }

    // تصحيح التصنيف (٣١/٨): تحويلُ صنفٍ مخزنيّ إلى خدمة يُجمّد رصيده إلى الأبد — `applyMovement`
    // يتخطّى الخدمة، فالكمّية تبقى في `branchStock` تُحتسَب في تقييم المخزون ولا تتحرّك أبداً.
    // ولذلك يُشترط رصيدٌ صفريّ عبر كل الفروع (نظير حارس وسم الأمانة أعلاه). الاتجاه المعاكس
    // (خدمة ⇒ سلعة) آمنٌ بذاته: الرصيد صفرٌ حكماً ويبدأ التتبّع من الآن.
    if (input.isService !== undefined && !!input.isService !== !!p.isService && input.isService) {
      const rows = await tx
        .select({ qty: branchStock.quantity })
        .from(branchStock)
        .innerJoin(productVariants, eq(branchStock.variantId, productVariants.id))
        .where(eq(productVariants.productId, input.productId));
      if (rows.reduce((sum, r) => sum + (r.qty || 0), 0) !== 0)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن تحويل الصنف إلى «خِدمة» ورصيده غير صفريّ — الخدمة بلا مخزون، فالرصيد الباقي سيتجمّد بلا حركة. صفِّر الرصيد (بيعاً أو تسويةً معتمَدة) أولاً",
        });
    }

    // «يُباع بالطلب» (0318): CHECK القاعدة يمنع التركيبة المحرَّمة، لكنّه يرتدّ برسالة SQL خامّة
    // لا يفهمها المستعمل. الحارس هنا يقولها بلغته وبسببها قبل أن تصل المعاملة للقاعدة.
    if (input.allowBackorder === true) {
      if (willBeService)
        throw new TRPCError({ code: "BAD_REQUEST", message: "«يُباع بالطلب» لا ينطبق على الخدمة — الخدمة بلا رصيد أصلاً فهي تُباع دائماً بلا فحص مخزون" });
      if (p.isBundle)
        throw new TRPCError({ code: "BAD_REQUEST", message: "«يُباع بالطلب» لا ينطبق على البكج — رصيده رصيد مكوّناته، فعِّله على المكوّن الناقص" });
      if (willBeConsignment)
        throw new TRPCError({ code: "BAD_REQUEST", message: "«يُباع بالطلب» ممنوع على بضاعة الأمانة — بيعُ ما لم يُودَع يُنشئ التزاماً كاذباً للمودِع" });
    }

    const name = composeName(input, p.name);
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المنتج مطلوب" });

    const canHaveStockUsage = canCarryStockUsage({
      isService: willBeService,
      isBundle: !!p.isBundle,
      isConsignment: willBeConsignment,
    });
    if (!canHaveStockUsage && input.stockUsage != null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تصنيف الاستخدام المخزني يخصّ الأصناف المخزنية المملوكة فقط",
          why: "الخدمات والبكجات وبضاعة الأمانة لا تحمل تصنيف stockUsage",
          doThis: "أزل تصنيف الاستخدام المخزني لهذا الصنف ثم أعد الحفظ",
        }),
      });
    }
    const effectiveStockUsage: StockUsage | null = !canHaveStockUsage
      ? null
      : input.stockUsage !== undefined
        ? input.stockUsage
        : ((p.stockUsage as StockUsage | null) ?? null);

    // نقفل جميع وحدات ومتغيّرات المنتج بترتيب الأقفال الحاكم: units → variants.
    const allDbVariants = await tx
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, input.productId));
    const dbVariantById = new Map(allDbVariants.map((row) => [Number(row.id), row]));
    for (const v of input.variants) {
      if (v.id != null && !dbVariantById.has(Number(v.id))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} لا يخصّ هذا المنتج` });
      }
    }
    const allVariantIds = allDbVariants.map((variant) => Number(variant.id));
    const existingUnitIds = allVariantIds.length
      ? (await tx
          .select({ id: productUnits.id })
          .from(productUnits)
          .where(inArray(productUnits.variantId, allVariantIds)))
          .map((unit) => Number(unit.id))
      : [];
    const desiredTemplateByName = new Map(input.unitTemplate.map((unit) => [unit.unitName.trim(), unit] as const));
    await lockUnitsAndAssertNoActiveOnlineOrderChanges(tx, existingUnitIds, (unit) => {
      const desired = desiredTemplateByName.get(unit.unitName);
      if (!desired) return true;
      const desiredFactor = desired.isBaseUnit ? 1 : Number(desired.conversionFactor);
      return desiredFactor !== Number(unit.conversionFactor);
    });
    await lockVariantsForUpdate(tx, allVariantIds);

    // دمج حقول الهوية مع الموجود (نمط PATCH) وفحص فريدية التركيبات + ثبات الهوية المستخدمة.
    const sentVariantIds = new Set(
      input.variants.filter((v) => v.id != null).map((v) => Number(v.id)),
    );
    const resolvedComboCandidates = [
      ...input.variants.map((v) => {
        const existingRow = v.id != null ? dbVariantById.get(Number(v.id)) : undefined;
        const kind: VariantKind =
          v.variantKind !== undefined
            ? v.variantKind
            : ((existingRow?.variantKind as VariantKind | undefined) ?? "VARIANT");
        const vName =
          v.variantName !== undefined ? (v.variantName?.trim() || null) : (existingRow?.variantName ?? null);
        const color = v.color !== undefined ? (v.color?.trim() || null) : (existingRow?.color ?? null);
        const size = v.size !== undefined ? (v.size?.trim() || null) : (existingRow?.size ?? null);
        return { id: v.id, sku: v.sku, variantKind: kind, variantName: vName, color, size };
      }),
      ...allDbVariants
        .filter((row) => !sentVariantIds.has(Number(row.id)))
        .map((row) => ({
          id: Number(row.id),
          sku: row.sku,
          variantKind: (row.variantKind as VariantKind) ?? "VARIANT",
          variantName: row.variantName ?? null,
          color: row.color ?? null,
          size: row.size ?? null,
        })),
    ];
    assertUniqueNormalizedVariantCombos(resolvedComboCandidates, dbVariantById);

    // اتّساق التفعيل للصنف البسيط أحاديّ المتغيّر عديم الأبعاد.
    const firstCombo = resolvedComboCandidates[0];
    const isSingleSimpleProduct =
      allDbVariants.length <= 1 &&
      input.variants.length === 1 &&
      firstCombo?.variantKind !== "ALTERNATIVE" &&
      !firstCombo?.color &&
      !firstCombo?.size;

    for (const v of input.variants) {
      if (v.id == null) continue;
      const existingRow = dbVariantById.get(Number(v.id))!;
      const kind: VariantKind =
        v.variantKind !== undefined
          ? v.variantKind
          : ((existingRow.variantKind as VariantKind | undefined) ?? "VARIANT");
      const vName =
        v.variantName !== undefined ? (v.variantName?.trim() || null) : (existingRow.variantName ?? null);
      const color = v.color !== undefined ? (v.color?.trim() || null) : (existingRow.color ?? null);
      const size = v.size !== undefined ? (v.size?.trim() || null) : (existingRow.size ?? null);
      await assertVariantIdentityImmutableIfUsed(
        tx,
        Number(existingRow.id),
        {
          variantKind: existingRow.variantKind,
          variantName: existingRow.variantName,
          color: existingRow.color,
          size: existingRow.size,
        },
        { variantKind: kind, variantName: vName, color, size },
        existingRow.sku || vName || `#${existingRow.id}`,
        { allowClearingSoleRegularVariantDimensions: isSingleSimpleProduct },
      );
    }
    let syncedSimpleActive: boolean | undefined;
    if (isSingleSimpleProduct) {
      const v0 = input.variants[0];
      if (input.isActive !== undefined && v0.isActive !== undefined && input.isActive !== v0.isActive) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعارض في حالة تفعيل الصنف البسيط ومتغيّره الوحيد",
            why: "لا يجوز تفعيل أحدهما وتعطيل الآخر في صنف بسيط ذي متغيّر واحد بلا أبعاد",
            doThis: "وحّد حالة التفعيل للصنف ومتغيّره ثم أعد الحفظ",
          }),
        });
      }
      if (input.isActive !== undefined) syncedSimpleActive = input.isActive;
      else if (v0.isActive !== undefined) syncedSimpleActive = v0.isActive;
    }
    const effectiveProductIsActive = syncedSimpleActive ?? (input.isActive ?? !!p.isActive);

    const effectiveCategoryId =
      input.categoryId !== undefined
        ? (input.categoryId ?? null)
        : (p.categoryId != null ? Number(p.categoryId) : null);
    const eligibleForStore =
      !willBeService && isSellableStockUsage(effectiveStockUsage) && effectiveProductIsActive;
    let nextShowInStore: boolean | undefined;
    if (input.showInStore !== undefined) {
      if (input.showInStore) {
        await assertStorefrontPublishReadyTx(tx, {
          actor,
          requirePermission: Boolean(actor.role),
          previouslyPublished: {
            showInStore: Boolean(p.showInStore),
            categoryId: p.categoryId != null ? Number(p.categoryId) : null,
          },
          isActive: effectiveProductIsActive,
          isService: willBeService,
          stockUsage: effectiveStockUsage,
          categoryId: effectiveCategoryId,
          variants: input.variants.map((v, idx) => {
            const existingRow = v.id != null ? dbVariantById.get(Number(v.id)) : undefined;
            const vActive =
              idx === 0 && syncedSimpleActive !== undefined
                ? syncedSimpleActive
                : (v.isActive ?? existingRow?.isActive ?? true);
            return {
              isActive: !!vActive,
              units: input.unitTemplate.map((u) => {
                const tplRetail = u.prices.find((pr) => pr.priceTier === "RETAIL")?.price ?? null;
                const retailPrice =
                  u.isBaseUnit && v.baseRetail && v.baseRetail.trim() ? v.baseRetail : tplRetail;
                return {
                  isActive: true,
                  isStoreSaleUnit: u.isStoreSaleUnit ?? u.isBaseUnit,
                  conversionFactor: u.isBaseUnit ? "1" : u.conversionFactor,
                  retailPrice,
                };
              }),
            };
          }),
        });
      }
      nextShowInStore = input.showInStore;
    } else if (!eligibleForStore && p.showInStore) {
      nextShowInStore = false;
    }

    // م٦ ق٨: «لا لقطة ⇒ لا تعديل» — تُقرأ الحالة بعد الأقفال وقبل أوّل كتابة، في نفس المعاملة.
    await snapshotProductBeforeUpdate(tx, input.productId, input.updateReason, actor);

    const channelLabels = resolveChannelLabelsOnUpdate(
      {
        name,
        posLabel: input.posLabel,
        invoiceLabel: input.invoiceLabel,
        storeTitle: input.storeTitle,
        shortTitle: input.shortTitle,
      },
      p,
    );

    await tx
      .update(products)
      .set({
        name,
        productType: effectiveProductType,
        brand: input.brand?.trim() || null,
        modelName: input.modelName?.trim() || null,
        description: input.description?.trim() || null,
        ...(input.internalName !== undefined ? { internalName: input.internalName?.trim() || null } : {}),
        ...channelLabels.patch,
        ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle?.trim() || null } : {}),
        ...(input.marketingCopy !== undefined ? { marketingCopy: input.marketingCopy?.trim() || null } : {}),
        categoryId: effectiveCategoryId,
        isCustomizable: input.isCustomizable ?? !!p.isCustomizable,
        allowAutoCartRecommendations: input.allowAutoCartRecommendations ?? p.allowAutoCartRecommendations !== false,
        isService: willBeService,
        ...(!canHaveStockUsage
          ? { stockUsage: null }
          : input.stockUsage !== undefined
            ? { stockUsage: input.stockUsage }
            : {}),
        ...(nextShowInStore !== undefined ? { showInStore: nextShowInStore } : {}),
        ...(input.allowBackorder !== undefined ? { allowBackorder: input.allowBackorder } : {}),
        isActive: effectiveProductIsActive,
        ...(input.showInReception !== undefined ? { showInReception: input.showInReception } : {}),
        ...(input.showInPrintPos !== undefined ? { showInPrintPos: input.showInPrintPos } : {}),
        ...(input.showInQuotations !== undefined ? { showInQuotations: input.showInQuotations } : {}),
        ...(input.showInAdvancedSales !== undefined ? { showInAdvancedSales: input.showInAdvancedSales } : {}),
        ...(wantConsign !== undefined ? { isConsignment: wantConsign } : {}),
        ...(wantConsignor !== undefined ? { consignorId: wantConsignor ?? null } : {}),
      })
      .where(eq(products.id, input.productId));

    let added = 0;
    // تدقيق ١١/٨ (#2): اسم وحدة الأساس الجديدة (القالب مشترك) — الحارس يفحص كل متغيّرٍ قائمٍ به رصيد/حركة.
    const newBaseName = input.unitTemplate.find((u) => u.isBaseUnit)!.unitName;

    const variantsInLockOrder = [...input.variants].sort((a, b) => {
      if (a.id != null && b.id != null) return Number(a.id) - Number(b.id);
      if (a.id != null) return -1;
      if (b.id != null) return 1;
      return a.sku.localeCompare(b.sku);
    });
    for (const v of variantsInLockOrder) {
      const existingRow = v.id != null ? dbVariantById.get(Number(v.id)) : undefined;
      const variantKind: VariantKind =
        v.variantKind !== undefined
          ? v.variantKind
          : ((existingRow?.variantKind as VariantKind | undefined) ?? "VARIANT");
      const variantName =
        v.variantName !== undefined ? (v.variantName?.trim() || null) : (existingRow?.variantName ?? null);
      const resolvedColor = v.color !== undefined ? (v.color?.trim() || null) : (existingRow?.color ?? null);
      const resolvedSize = v.size !== undefined ? (v.size?.trim() || null) : (existingRow?.size ?? null);
      if (variantKind === "ALTERNATIVE") {
        if (!variantName) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `البديل «${v.sku}» يلزمه اسمٌ مميّز (الماركة/المنشأ).` });
        }
        const hasBarcode = Object.values(v.unitBarcodes ?? {}).some((b) => (b ?? "").trim());
        if (!hasBarcode) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `لا بديلَ بلا باركود: «${variantName}» — أسنِد باركوداً لوحدةٍ منه قبل الحفظ (يُطبَع من شاشة الملصقات).`,
          });
        }
      }
      const resolvedVariantActive =
        syncedSimpleActive !== undefined
          ? syncedSimpleActive
          : (v.isActive ?? existingRow?.isActive ?? true);
      const vals = {
        sku: v.sku.trim(),
        variantKind,
        variantName,
        color: resolvedColor,
        size: resolvedSize,
        costPrice: toDbMoney(v.costPrice),
        minStock: v.minStock != null ? Math.max(0, Math.trunc(v.minStock)) : 0,
        reorderPoint: v.reorderPoint != null ? Math.max(0, Math.trunc(v.reorderPoint)) : 0,
        isActive: !!resolvedVariantActive,
      };
      const colorHexPatch = v.colorHex !== undefined ? { colorHex: v.colorHex?.trim() || null } : {};
      let variantId: number;
      if (v.id) {
        const owned = (await tx.select({ id: productVariants.id, costPrice: productVariants.costPrice }).from(productVariants).where(and(eq(productVariants.id, v.id), eq(productVariants.productId, input.productId))).limit(1))[0];
        if (!owned) throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} لا يخصّ هذا المنتج` });
        variantId = v.id;
        await assertBaseUnitStableAndRevalueCost(
          tx, variantId, { by: "name", unitName: newBaseName }, owned.costPrice, vals.costPrice, actor, v.costChangeReason,
        );
        await tx.update(productVariants).set({ ...vals, ...colorHexPatch }).where(eq(productVariants.id, variantId));
      } else {
        const res = await tx.insert(productVariants).values({ productId: input.productId, ...vals, colorHex: v.colorHex?.trim() || null });
        variantId = extractInsertId(res);
        added++;
      }
      await upsertVariantUnits(tx, variantId, input.unitTemplate, v.unitBarcodes, v.barcodeAliases, v.baseRetail, actor);

      // product-variants: توفيق صورة اللون. image=undefined ⇒ لا نلمسها؛ string ⇒ تُعيَّن؛ null/"" ⇒ تُزال.
      if (v.image !== undefined) {
        const img = (v.image ?? "").trim();
        const existing = await tx
          .select({ id: productImages.id, url: productImages.url })
          .from(productImages)
          .where(eq(productImages.variantId, variantId))
          .orderBy(productImages.id);
        if (img) {
          if (existing.length > 0) {
            // تكرار URL القائم يعني «لا تغيير» ويحافظ توافق النماذج القديمة؛ أيّ قيمة
            // مختلفة محاولة استبدال مباشر خارج مسار المهمة والمراجعة فتُرفض fail-closed.
            if (img !== existing[0].url) rejectLegacyCatalogMediaWrite();
            if (existing.length > 1)
              await tx.delete(productImages).where(inArray(productImages.id, existing.slice(1).map((r) => r.id)));
          } else {
            rejectLegacyCatalogMediaWrite();
          }
        } else if (existing.length > 0) {
          await tx.delete(productImages).where(eq(productImages.variantId, variantId));
        }
      }
    }

    // صور المنتج العامّة (variantId=NULL): undefined ⇒ لا تُمَسّ؛ مصفوفة ⇒ يُعاد التوفيق بالمعرّف.
    if (input.images !== undefined) {
      await reconcileProductImages(tx, input.productId, input.images);
    }

    const recipeResult = saveRecipe ? await saveRecipe() : undefined;
    return { productId: input.productId, added, ...recipeResult };
}
