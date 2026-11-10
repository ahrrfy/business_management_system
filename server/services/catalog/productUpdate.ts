// تحديث منتج قائم: ترويسة + متغيّر(ات) + وحدات + أسعار في معاملة واحدة.
//
// م٦ (D5): الحرّاس السبعة مصدرُها الواحد `./productUpdateGuards` — يتشاركها هذا المسار (الحامل
// لمعرّف الوحدة) ومسارُ القالب المشترك في `productEditService.ts`. لا حارسَ يُكتب هنا بيدٍ بعد اليوم.
import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { barcodeComparisonKey, barcodeIdentityCandidates, canonicalizeBarcodeInput, canonicalizeBarcodeForStorage } from "@shared/barcodeNormalize";
import type { PermissionMap } from "@shared/permissions";
import { resolveChannelLabelsOnUpdate } from "@shared/productChannelTitles";
import { appErrorMessage } from "@shared/errors";
import { canCarryStockUsage, isSellableStockUsage, type StockUsage } from "@shared/stockUsage";
import { acquireCatalogBarcodeWriteLock, findBarcodeClashes } from "./barcodeAliases";
import { productPrices, productUnits, productVariants, products } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { assertValidUnitFactors } from "./unitFactors";
import { toDbMoney } from "../money";
import type { PriceTier } from "../pricing";
import { type Actor, withTx } from "../tx";
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
} from "./productUpdateGuards";

export interface UpdateProductUnitInput {
  id?: number; // existing unit id (omit for new)
  unitName: string;
  conversionFactor: string;
  barcode?: string | null;
  isBaseUnit?: boolean;
  isStoreSaleUnit?: boolean;
  prices?: Array<{ priceTier: PriceTier; price: string }>;
}

export interface UpdateProductVariantInput {
  id: number; // variants are not added/removed via edit for now
  sku: string;
  variantName?: string | null;
  color?: string | null;
  size?: string | null;
  costPrice: string;
  /** سبب تغيير التكلفة (priceSanity L1.7) — يُلتقَط في أثر product.costChange. */
  costChangeReason?: string | null;
  units: UpdateProductUnitInput[];
}

export interface UpdateProductInput {
  productId: number;
  name: string;
  internalName?: string | null;
  storeTitle?: string | null;
  seoTitle?: string | null;
  shortTitle?: string | null;
  posLabel?: string | null;
  invoiceLabel?: string | null;
  marketingCopy?: string | null;
  categoryId?: number | null;
  isCustomizable?: boolean;
  isActive?: boolean;
  stockUsage?: StockUsage | null;
  showInStore?: boolean;
  /** سببُ التعديل — يُلحق بلقطة `recordVersions` (م٦ ق٨). اختياريّ؛ الافتراض في الحرّاس المشتركة. */
  updateReason?: string | null;
  variants: UpdateProductVariantInput[];
}

export type UpdateProductActor = Actor & {
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

/** Update a product header + its variant(s) + units + prices in one transaction.
 *  - Existing units (by id) are UPDATEd and their prices replaced.
 *  - New units (no id) are INSERTed with their prices.
 *  - Units present in DB but absent from input are soft-deactivated (isActive=false). */
export async function updateProduct(input: UpdateProductInput, actor: UpdateProductActor) {
  return withTx((tx) => updateProductTx(tx, input, actor));
}

/** الجسم داخل معاملةٍ يملكها المستدعي — كي يستطيع مسارٌ أعلى (الاستعادة) ضمّه إلى معاملته. */
export async function updateProductTx(tx: Tx, input: UpdateProductInput, actor: UpdateProductActor) {
    if (!input.name.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المنتج مطلوب" });
    assertHasVariants(input.variants.length);

    await acquireCatalogBarcodeWriteLock(tx);
    const p = await loadProductForUpdateOrThrow(tx, input.productId);

    // gstack B12 (٧/٧/٢٦): بكج = متغيّر واحد فقط + وحدة أساس واحدة فقط (حارسٌ مشترك — كان هنا وحده).
    assertBundleEditShape(p, input.variants.length, input.variants[0].units.filter((u) => u.isBaseUnit).length);

    // productUnit هو mutex معنى الكمية: نقفل كل وحدات المتغيّرات القائمة قبل أي
    // قفل variant/كتابة، ثم نحدد التغييرات من القراءة المقفلة ونفحص الطلبات النشطة.
    // هكذا لا يمر تعديل بعامل «غير متغير» من لقطة قديمة بعد أن غيّره محرر متزامن.
    const existingUnitIds = input.variants.length
      ? (await tx
          .select({ id: productUnits.id })
          .from(productUnits)
          .where(inArray(productUnits.variantId, input.variants.map((variant) => variant.id))))
          .map((unit) => Number(unit.id))
      : [];
    const desiredByVariant = new Map(input.variants.map((variant) => [
      variant.id,
      new Map(variant.units.filter((unit) => unit.id != null).map((unit) => [Number(unit.id), unit] as const)),
    ] as const));
    await lockUnitsAndAssertNoActiveOnlineOrderChanges(tx, existingUnitIds, (unit) => {
      const desired = desiredByVariant.get(unit.variantId)?.get(unit.id);
      return !desired || Number(desired.conversionFactor) !== Number(unit.conversionFactor);
    });

    const allProductVariantRows = await tx
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, input.productId));
    const allVariantIdsToLock = Array.from(
      new Set([
        ...allProductVariantRows.map((row) => Number(row.id)),
        ...input.variants.map((variant) => variant.id),
      ]),
    );
    await lockVariantsForUpdate(tx, allVariantIdsToLock);
    const existingVariantById = new Map(
      allProductVariantRows.map((row) => [Number(row.id), row] as const),
    );
    for (const v of input.variants) {
      if (!existingVariantById.has(v.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} لا يخصّ هذا المنتج` });
      }
      assertNonNegativeMoneyDecimal(v.costPrice, `تكلفة المتغيّر ${v.sku}`);
      for (const u of v.units) {
        for (const pr of u.prices ?? []) {
          assertNonNegativeMoneyDecimal(pr.price, `سعر ${pr.priceTier} للوحدة ${u.unitName}`);
        }
      }
    }

    const canHaveStockUsage = canCarryStockUsage(p);
    if (!canHaveStockUsage && input.stockUsage != null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تصنيف الاستخدام المخزني يخصّ الأصناف المخزنية المملوكة فقط",
          why: "الخدمات والبكجات وبضاعة الأمانة لا تحمل تصنيف stockUsage",
          doThis: "اترك حقل الاستخدام المخزني فارغاً لهذا الصنف ثم احفظ",
        }),
      });
    }
    const effectiveStockUsage = canHaveStockUsage
      ? input.stockUsage !== undefined
        ? input.stockUsage
        : (p.stockUsage ?? null)
      : null;

    const submittedById = new Map(input.variants.map((v) => [v.id, v] as const));
    const mergedVariantsForComboCheck = allProductVariantRows.map((owned) => {
      const sub = submittedById.get(Number(owned.id));
      if (!sub) return owned;
      return {
        id: Number(owned.id),
        sku: sub.sku.trim(),
        variantKind: owned.variantKind,
        color: sub.color !== undefined ? (sub.color?.trim() || null) : owned.color,
        size: sub.size !== undefined ? (sub.size?.trim() || null) : owned.size,
        isActive: owned.isActive,
      };
    });
    assertUniqueNormalizedVariantCombos(mergedVariantsForComboCheck, existingVariantById);

    const effectiveProductIsActive = input.isActive !== undefined ? input.isActive : !!p.isActive;
    const isSingleSimpleProduct =
      allProductVariantRows.length === 1 &&
      input.variants.length === 1 &&
      mergedVariantsForComboCheck[0].variantKind !== "ALTERNATIVE" &&
      !mergedVariantsForComboCheck[0].color &&
      !mergedVariantsForComboCheck[0].size;
    const eligibleForStore =
      effectiveProductIsActive && !p.isService && isSellableStockUsage(effectiveStockUsage);
    const effectiveCategoryId =
      input.categoryId !== undefined ? (input.categoryId ?? null) : (p.categoryId ?? null);

    if (input.showInStore === true) {
      await assertStorefrontPublishReadyTx(tx, {
        actor,
        requirePermission: Boolean(actor.role),
        previouslyPublished: {
          showInStore: Boolean(p.showInStore),
          categoryId: p.categoryId != null ? Number(p.categoryId) : null,
        },
        isActive: effectiveProductIsActive,
        isService: !!p.isService,
        stockUsage: effectiveStockUsage,
        categoryId: effectiveCategoryId,
        variants: input.variants.map((v) => {
          const owned = existingVariantById.get(v.id)!;
          const vActive = isSingleSimpleProduct ? effectiveProductIsActive : !!owned.isActive;
          return {
            isActive: vActive,
            units: v.units.map((u) => ({
              isActive: true,
              isStoreSaleUnit: u.isStoreSaleUnit ?? !!u.isBaseUnit,
              conversionFactor: u.isBaseUnit ? "1" : u.conversionFactor,
              retailPrice: u.prices?.find((pr) => pr.priceTier === "RETAIL")?.price ?? null,
            })),
          };
        }),
      });
    }
    const effectiveShowInStore =
      input.showInStore !== undefined
        ? input.showInStore
        : eligibleForStore
          ? !!p.showInStore
          : false;

    // م٦ ق٨: «لا لقطة ⇒ لا تعديل» — تُقرأ الحالة بعد الأقفال وقبل أوّل كتابة، في نفس المعاملة.
    await snapshotProductBeforeUpdate(tx, input.productId, input.updateReason, actor);

    const channelLabels = resolveChannelLabelsOnUpdate(
      {
        name: input.name,
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
        name: channelLabels.name,
        ...(input.internalName !== undefined ? { internalName: input.internalName?.trim() || null } : {}),
        ...channelLabels.patch,
        ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle?.trim() || null } : {}),
        ...(input.marketingCopy !== undefined ? { marketingCopy: input.marketingCopy?.trim() || null } : {}),
        categoryId: effectiveCategoryId,
        isCustomizable: input.isCustomizable ?? !!p.isCustomizable,
        stockUsage: effectiveStockUsage,
        showInStore: effectiveShowInStore,
        ...(input.isActive != null ? { isActive: effectiveProductIsActive } : {}),
      })
      .where(eq(products.id, input.productId));

    // (٤/٩، مراجعة Codex P1) فحصُ تفرّد الباركود قبل الكتابة عبر `findBarcodeClashes` المُطبَّع (لا الاعتماد
    // على قيد UNIQUE الخام وحده): القيد يقارن السلاسل حرفياً فيقبل «١٢٣» و«123» معاً، فوحدةٌ تُحفَظ بـ«123»
    // بينما وحدةٌ أخرى تحمل إرثاً «١٢٣» تُنتج مالكَين لباركودٍ واحدٍ منطقياً — والمسحُ اللاحق (مُطبَّعٌ مدخله)
    // يحسمه لأحدهما فيُسعّر/يخصم لغير صاحبه. نتجاهل وحدات هذا المنتج نفسه (تحديثٌ ذاتيّ). نظيرُ ما يفعله
    // `updateProductWithVariants` أصلاً.
    const editCodes: string[] = [];
    const ownUnitIds: number[] = [];
    const ignoreAliasByCodeUnitId = new Map<string, number>();
    for (const v of input.variants)
      for (const u of v.units) {
        const b = canonicalizeBarcodeInput(u.barcode ?? "");
        if (b) {
          editCodes.push(b);
          if (u.id != null) {
            const targetUnitId = Number(u.id);
            for (const cand of barcodeIdentityCandidates(b)) {
              ignoreAliasByCodeUnitId.set(barcodeComparisonKey(cand), targetUnitId);
            }
          }
        }
        if (u.id != null) ownUnitIds.push(Number(u.id));
      }
    const seenEditCodes = new Set<string>();
    for (const code of editCodes) {
      const identities = barcodeIdentityCandidates(code).map(barcodeComparisonKey);
      if (identities.some((identity) => seenEditCodes.has(identity)))
        throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
          what: `تعذّر حفظ الباركود ${code}`,
          why: "الباركود مكرّر بين وحدات المنتج أو يمثّل UPC-A وEAN-13 للسلعة نفسها",
          doThis: "اترك الباركود على وحدة واحدة واحذفه من الوحدة الأخرى، ثم احفظ المنتج",
        }) });
      identities.forEach((identity) => seenEditCodes.add(identity));
    }
    if (editCodes.length) {
      const clashes = await findBarcodeClashes(tx, editCodes, {
        ignorePrimaryUnitIds: ownUnitIds,
        ignoreAliasByCodeUnitId,
        forShare: true,
      });
      if (clashes[0])
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `الباركود ${clashes[0].code} مُستعمَلٌ في منتجٍ آخر`,
            why: `«${clashes[0].takenBy}» يحمل هذا الباركود أصلاً، ولا يخصّ باركودٌ واحدٌ سلعتين`,
            doThis: "غيّر الباركود لهذه الوحدة، أو احذفه من المنتج الآخر أوّلاً، ثمّ احفظ",
          }),
        });
    }

    // أقفال التكلفة متعددة المتغيّرات بترتيب المعرّف نفسه في الشراء/WAVG؛ ترتيب الطلب
    // واجهيّ ولا يجوز أن يصنع دورة أقفال مع طلب آخر معكوس.
    const variantsInLockOrder = [...input.variants].sort((a, b) => a.id - b.id);
    for (const v of variantsInLockOrder) {
      // Codex جولة٧ P1: ارفض معرّفَ/اسمَ وحدةٍ مكرّراً في الطلب **قبل** أيّ فحص — وإلّا كتب المُحدِّث الصفّ
      // نفسه مرّتين (الثانية تَجُبّ الأولى) فيُفقَد الأساس رغم اجتياز فحص «أساسٍ واحد» والحارس.
      const submittedIds = v.units.filter((u) => u.id != null).map((u) => Number(u.id));
      if (new Set(submittedIds).size !== submittedIds.length)
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku}: معرّف وحدةٍ مكرّرٌ في الطلب` });
      assertUniqueUnitNamesAndTiers(v.sku, v.units);

      // Codex جولة٨ P1: كلّ معرّف وحدةٍ مُرسَلٍ يجب أن يخصّ **هذا** المتغيّر — وإلّا فمعرّفٌ أجنبيٌّ (أو معرّف
      // أساس متغيّرٍ آخر في طلبٍ متعدّد) تُحدِّثه الحلقةُ بالمعرّف فتُعطّل أساسَ ذاك بعد اجتياز حارسه. نفحص
      // الملكيّة **قبل** الحارس والكتابة.
      const ownedUnitIds = new Set(
        (await tx.select({ id: productUnits.id }).from(productUnits).where(eq(productUnits.variantId, v.id))).map((u) => Number(u.id)),
      );
      for (const u of v.units) {
        if (u.id != null && !ownedUnitIds.has(Number(u.id)))
          throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku}: الوحدة (${u.id}) لا تخصّه` });
      }

      if (!v.units.some((u) => u.isBaseUnit))
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة` });
      if (v.units.filter((u) => u.isBaseUnit).length > 1)
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة فقط` });

      // تدقيق ١١/٨ (#2 — بعد ٣ جولات مراجعة Codex): نفس حارس المسار الحديث — وحدة الأساس ثابتةٌ لمتغيّرٍ
      // قائم. الهويّة بمعرّف الصفّ المُرسَل: نفس الصفّ (ولو أُعيدت تسميته **في مكانه** هنا) آمنٌ، وترقية
      // صفٍّ قائمٍ آخر (أو صفٍّ جديد) إلى الأساس تبديلٌ يُرفَض. مقارنةٌ ساكنةٌ بلا قفل.
      // by:"id" — هذا المسار يُحدِّث بالمعرّف (إعادة تسميةٍ في مكانها آمنة)؛ فغيابُ المعرّف (صفٌّ جديد)
      // استبدالٌ يُرفَض، ولا نرجع لمقارنة الاسم (Codex جولة٥ P1).
      const baseU = v.units.find((u) => u.isBaseUnit);
      // H3 (تدقيق ٢٧/٧): الحارس يملك ترتيب القفل الحاكم variant→branchStock، ويتحقّق
      // ذرّياً أن لقطة «قبل» ما زالت حيّة قبل أن يسمح بالكتابة. استدعاؤه قبل UPDATE يمنع
      // طمس WAVG متزامن ولا يعكس ترتيب أقفال الشراء/الإنتاج.
      const ownedV = existingVariantById.get(v.id)!;
      const nextVariantName = v.variantName !== undefined ? (v.variantName?.trim() || null) : ownedV.variantName;
      const nextColor = v.color !== undefined ? (v.color?.trim() || null) : ownedV.color;
      const nextSize = v.size !== undefined ? (v.size?.trim() || null) : ownedV.size;
      await assertVariantIdentityImmutableIfUsed(
        tx,
        v.id,
        ownedV,
        { variantKind: ownedV.variantKind, variantName: nextVariantName, color: nextColor, size: nextSize },
        nextColor || nextSize || v.sku,
      );
      await assertBaseUnitStableAndRevalueCost(
        tx, v.id, { by: "id", unitId: baseU?.id ?? null }, ownedV.costPrice, toDbMoney(v.costPrice), actor, v.costChangeReason,
      );
      await tx
        .update(productVariants)
        .set({
          sku: v.sku.trim(),
          variantName: nextVariantName,
          color: nextColor,
          size: nextSize,
          costPrice: toDbMoney(v.costPrice),
          ...(isSingleSimpleProduct && input.isActive !== undefined ? { isActive: effectiveProductIsActive } : {}),
        })
        .where(eq(productVariants.id, v.id));
      // تحقّق معامل التحويل خادمياً (تدقيق ١٧/٧): الأساس ١، غير الأساس عدد صحيح > ١.
      assertValidUnitFactors(v.units);

      // Existing units for this variant.
      const existing = await tx.select().from(productUnits).where(eq(productUnits.variantId, v.id));
      // تجميد هيكل وهوية الوحدات أثناء الجرد النشط (Codex P2)
      await assertNoActiveStocktakeUnitFreeze(tx, v.id, existing, v.units);
      const keepIds = new Set<number>();

      for (const u of v.units) {
        let productUnitId: number;
        if (u.id) {
          productUnitId = u.id;
          const existingUnit = existing.find((e) => Number(e.id) === Number(u.id));
          if (existingUnit) {
            await assertUnitFactorImmutableIfUsed(
              tx,
              u.id,
              existingUnit.conversionFactor,
              u.isBaseUnit ? "1" : u.conversionFactor,
              u.unitName,
            );
            if (!u.isBaseUnit) {
              await assertNoActiveStocktakeFactorChange(tx, v.id, [
                { unitName: u.unitName, oldFactor: existingUnit.conversionFactor, newFactor: u.conversionFactor },
              ]);
            }
          }
          const previousPrices = await tx
            .select({ priceTier: productPrices.priceTier, price: productPrices.price })
            .from(productPrices)
            .where(eq(productPrices.productUnitId, u.id));
          const previousByTier = new Map(previousPrices.map((row) => [row.priceTier, row.price] as const));
          await tx
            .update(productUnits)
            .set({
              unitName: u.unitName,
              conversionFactor: u.conversionFactor,
              barcode: canonicalizeBarcodeForStorage(u.barcode ?? "") || null, // حرفيّاً بصيغة المصنع
              isBaseUnit: !!u.isBaseUnit,
              isStoreSaleUnit: u.isStoreSaleUnit ?? !!u.isBaseUnit,
              isActive: true,
            })
            .where(eq(productUnits.id, u.id));
          // Replace prices for this unit.
          await tx.delete(productPrices).where(eq(productPrices.productUnitId, u.id));
          // سجلّ تغيّر السعر (حارسٌ مشترك — صار يُكتب في مسار القالب أيضاً، Codex INV-05).
          await logUnitPriceChanges(tx, { productUnitId, previousByTier, next: u.prices ?? [], actor });
        } else {
          const uRes = await tx.insert(productUnits).values({
            variantId: v.id,
            unitName: u.unitName,
            conversionFactor: u.conversionFactor,
            barcode: canonicalizeBarcodeForStorage(u.barcode ?? "") || null, // حرفيّاً بصيغة المصنع
            isBaseUnit: !!u.isBaseUnit,
            isStoreSaleUnit: u.isStoreSaleUnit ?? !!u.isBaseUnit,
          });
          productUnitId = extractInsertId(uRes);
        }
        keepIds.add(productUnitId);
        for (const pr of u.prices ?? []) {
          await tx
            .insert(productPrices)
            .values({ productUnitId, priceTier: pr.priceTier, price: toDbMoney(pr.price) });
        }
      }

      // Soft-deactivate units that are no longer present (preserve history).
      for (const existing0 of existing) {
        if (!keepIds.has(Number(existing0.id))) {
          await tx.update(productUnits).set({ isActive: false }).where(eq(productUnits.id, Number(existing0.id)));
        }
      }
    }

    return { productId: input.productId };
}
