// تحديث منتج قائم: ترويسة + متغيّر(ات) + وحدات + أسعار في معاملة واحدة.
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { barcodeComparisonKey, barcodeIdentityCandidates, canonicalizeBarcodeInput } from "@shared/barcodeNormalize";
import { appErrorMessage } from "@shared/errors";
import { findBarcodeClashes } from "./barcodeAliases";
import { priceChangeLog, productPrices, productUnits, productVariants, products } from "../../../drizzle/schema";
import { assertBaseUnitStable } from "./baseUnitGuard";
import { extractInsertId } from "../../lib/insertId";
import { assertValidUnitFactors } from "./unitFactors";
import { toDbMoney } from "../money";
import { postCostRevaluation } from "../costRevaluation";
import { lockInventoryVariants } from "../inventory/stockLock";
import type { PriceTier } from "../pricing";
import { type Actor, withTx } from "../tx";
import {
  assertNoActiveOnlineOrderUnitChanges,
  lockProductUnitsForOnlineAllocation,
} from "./variantAvailability";

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
  variants: UpdateProductVariantInput[];
}

/** Update a product header + its variant(s) + units + prices in one transaction.
 *  - Existing units (by id) are UPDATEd and their prices replaced.
 *  - New units (no id) are INSERTed with their prices.
 *  - Units present in DB but absent from input are soft-deactivated (isActive=false). */
export async function updateProduct(input: UpdateProductInput, actor: Actor) {
  return withTx(async (tx) => {
    if (!input.name.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المنتج مطلوب" });
    if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });

    const p = (await tx.select().from(products).where(eq(products.id, input.productId)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });

    // gstack B12 (٧/٧/٢٦): مرآة قيود إنشاء البكج على مسار التعديل — كانت غائبة فيسمح تعديل بكج بإضافة
    // متغيّر ثانٍ (متغيّر «شبح» بلا وصفة، مصنَّف BUNDLE، يفشل عند البيع بـPRECONDITION_FAILED) أو
    // بتعطيل وحدة الأساس. نفرض هنا: بكج = متغيّر واحد فقط + وحدة أساس واحدة فقط.
    if (p.isBundle) {
      if (input.variants.length !== 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "البكج لا يقبل إلّا متغيّراً واحداً — احذف المتغيّرات الإضافية" });
      }
      const baseUnitsCount = input.variants[0].units.filter((u) => u.isBaseUnit).length;
      if (baseUnitsCount !== 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "البكج لا يقبل إلّا وحدة أساس واحدة" });
      }
    }

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
    const lockedUnits = await lockProductUnitsForOnlineAllocation(tx, existingUnitIds);
    const desiredByVariant = new Map(input.variants.map((variant) => [
      variant.id,
      new Map(variant.units.filter((unit) => unit.id != null).map((unit) => [Number(unit.id), unit] as const)),
    ] as const));
    const protectedUnitIds = lockedUnits
      .filter((unit) => {
        const desired = desiredByVariant.get(unit.variantId)?.get(unit.id);
        return !desired || Number(desired.conversionFactor) !== Number(unit.conversionFactor);
      })
      .map((unit) => unit.id);
    await assertNoActiveOnlineOrderUnitChanges(tx, protectedUnitIds);

    await lockInventoryVariants(tx, input.variants.map((variant) => variant.id));
    await tx
      .update(products)
      .set({
        name: input.name.trim(),
        ...(input.internalName !== undefined ? { internalName: input.internalName?.trim() || null } : {}),
        ...(input.storeTitle !== undefined ? { storeTitle: input.storeTitle?.trim() || null } : {}),
        ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle?.trim() || null } : {}),
        ...(input.shortTitle !== undefined ? { shortTitle: input.shortTitle?.trim() || null } : {}),
        ...(input.posLabel !== undefined ? { posLabel: input.posLabel?.trim() || null } : {}),
        ...(input.invoiceLabel !== undefined ? { invoiceLabel: input.invoiceLabel?.trim() || null } : {}),
        ...(input.marketingCopy !== undefined ? { marketingCopy: input.marketingCopy?.trim() || null } : {}),
        categoryId: input.categoryId ?? null,
        isCustomizable: input.isCustomizable ?? !!p.isCustomizable,
        ...(input.isActive != null ? { isActive: input.isActive } : {}),
      })
      .where(eq(products.id, input.productId));

    // (٤/٩، مراجعة Codex P1) فحصُ تفرّد الباركود قبل الكتابة عبر `findBarcodeClashes` المُطبَّع (لا الاعتماد
    // على قيد UNIQUE الخام وحده): القيد يقارن السلاسل حرفياً فيقبل «١٢٣» و«123» معاً، فوحدةٌ تُحفَظ بـ«123»
    // بينما وحدةٌ أخرى تحمل إرثاً «١٢٣» تُنتج مالكَين لباركودٍ واحدٍ منطقياً — والمسحُ اللاحق (مُطبَّعٌ مدخله)
    // يحسمه لأحدهما فيُسعّر/يخصم لغير صاحبه. نتجاهل وحدات هذا المنتج نفسه (تحديثٌ ذاتيّ). نظيرُ ما يفعله
    // `updateProductWithVariants` أصلاً.
    const editCodes: string[] = [];
    const ownUnitIds: number[] = [];
    for (const v of input.variants)
      for (const u of v.units) {
        const b = canonicalizeBarcodeInput(u.barcode ?? "");
        if (b) editCodes.push(b);
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
      const clashes = await findBarcodeClashes(tx, editCodes, { ignorePrimaryUnitIds: ownUnitIds });
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
      const submittedNames = v.units.map((u) => u.unitName.trim());
      if (new Set(submittedNames).size !== submittedNames.length)
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku}: اسم وحدةٍ مكرّرٌ في الطلب` });

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
      const oldV = (await tx.select({ costPrice: productVariants.costPrice }).from(productVariants).where(eq(productVariants.id, v.id)).limit(1))[0];
      // المتغيّرات كلّها مقفولة أعلاه، لذا نحافظ على أولوية تشخيص وحدة الأساس بلا
      // إنشاء ترتيب أقفال موازٍ لمسارات WAVG.
      await assertBaseUnitStable(tx, v.id, { by: "id", unitId: baseU?.id ?? null });
      await postCostRevaluation(tx, v.id, oldV?.costPrice, toDbMoney(v.costPrice), actor, v.costChangeReason);
      await tx
        .update(productVariants)
        .set({
          sku: v.sku,
          variantName: v.variantName ?? null,
          color: v.color ?? null,
          size: v.size ?? null,
          costPrice: toDbMoney(v.costPrice),
        })
        .where(eq(productVariants.id, v.id));
      // تحقّق معامل التحويل خادمياً (تدقيق ١٧/٧): الأساس ١، غير الأساس عدد صحيح > ١.
      assertValidUnitFactors(v.units);

      // Existing units for this variant.
      const existing = await tx.select().from(productUnits).where(eq(productUnits.variantId, v.id));
      const keepIds = new Set<number>();

      for (const u of v.units) {
        let productUnitId: number;
        if (u.id) {
          productUnitId = u.id;
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
              barcode: canonicalizeBarcodeInput(u.barcode ?? "") || null,
              isBaseUnit: !!u.isBaseUnit,
              isStoreSaleUnit: u.isStoreSaleUnit ?? !!u.isBaseUnit,
              isActive: true,
            })
            .where(eq(productUnits.id, u.id));
          // Replace prices for this unit.
          await tx.delete(productPrices).where(eq(productPrices.productUnitId, u.id));
          for (const pr of u.prices ?? []) {
            const oldPrice = previousByTier.get(pr.priceTier) ?? null;
            const newPrice = toDbMoney(pr.price);
            if (oldPrice == null || oldPrice !== newPrice) {
              await tx.insert(priceChangeLog).values({
                productUnitId,
                priceTier: pr.priceTier,
                oldPrice,
                newPrice,
                reason: "تعديل يدوي من شاشة المنتج",
                waveId: null,
                actorUserId: actor.userId,
              });
            }
          }
        } else {
          const uRes = await tx.insert(productUnits).values({
            variantId: v.id,
            unitName: u.unitName,
            conversionFactor: u.conversionFactor,
            barcode: canonicalizeBarcodeInput(u.barcode ?? "") || null,
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
  });
}
