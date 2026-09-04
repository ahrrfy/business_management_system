// فصل البدائل المدمجة تاريخياً (وثيقة «الجرد بالباركود» ٢٢/٨، م٤).
//
// «باركود بديل» (productUnitBarcodes) صُمّم لنفس السلعة بترميزٍ آخر (دفعة استيراد). لكنّ بعضها
// أُدخل تاريخياً ليُخفي **منتجاً حقيقياً مختلفاً** (ماركة/منشأ آخر) تحت وحدةٍ واحدة برصيدٍ وتكلفةٍ
// موحّدين — نقيض الجرد المنفصل. هذه الأداة تُخرج ذلك الباركود إلى **متغيّرٍ مستقلّ (ALTERNATIVE)**
// بوحدته وباركوده وسعره، ثم يُفصَل الرصيد المدمج ميدانياً بجردٍ يدويّ على الصنفين (لا تعرف القاعدة
// توزيعه). قرار المالك #4: تكلفة البديل = المُمرَّرة (آخر شراء معروف) وإلا تكلفة الوحدة المدمجة.
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  products,
  productPrices,
  productUnitBarcodes,
  productUnits,
  productVariants,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { canonicalizeBarcodeInput } from "@shared/barcodeNormalize";
import { toDbMoney } from "../money";
import { requireDb, withTx } from "../tx";

export interface SplitCandidate {
  productUnitId: number;
  variantId: number;
  productId: number;
  productName: string;
  unitName: string;
  sku: string;
  aliases: { id: number; barcode: string; note: string | null }[];
}

/** الوحدات التي تحمل باركوداً بديلاً واحداً على الأقل — مرشّحات الفصل (كتالوج عامّ، لا فرعيّ). */
export async function listSplitCandidates(): Promise<SplitCandidate[]> {
  const db = requireDb();
  const aliasRows = await db
    .select({
      id: productUnitBarcodes.id,
      productUnitId: productUnitBarcodes.productUnitId,
      barcode: productUnitBarcodes.barcode,
      note: productUnitBarcodes.note,
    })
    .from(productUnitBarcodes)
    .orderBy(asc(productUnitBarcodes.productUnitId), asc(productUnitBarcodes.id));
  if (!aliasRows.length) return [];

  const unitIds = Array.from(new Set(aliasRows.map((r) => Number(r.productUnitId))));
  const unitRows = await db
    .select({
      unitId: productUnits.id,
      unitName: productUnits.unitName,
      variantId: productUnits.variantId,
      isActive: productUnits.isActive,
      isBaseUnit: productUnits.isBaseUnit,
      productId: products.id,
      productName: products.name,
      isBundle: products.isBundle,
      isService: products.isService,
      sku: productVariants.sku,
      variantKind: productVariants.variantKind,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.id, unitIds));
  const unitById = new Map(unitRows.map((u) => [Number(u.unitId), u]));

  const byUnit = new Map<number, SplitCandidate>();
  for (const a of aliasRows) {
    const uid = Number(a.productUnitId);
    const u = unitById.get(uid);
    if (!u || u.isActive === false) continue; // وحدةٌ متقاعدة لا تُفصَل
    // فصلُ وحدةٍ غير أساس يُنتج بديلاً بوحدةِ أساسٍ معاملُها 1 وتكلفةٍ للقطعة على «كرتون» ⇒ يفسد
    // التقييم وCOGS (مراجعة Codex P1). نقصر الفصل على باركود **وحدة الأساس** فقط.
    if (u.isBaseUnit !== true) continue;
    // البديل الأصليّ (ALTERNATIVE) لا يُعاد فصله؛ الأداة للوحدات المدمجة (VARIANT) فقط.
    if (u.variantKind === "ALTERNATIVE") continue;
    // البكج بلا تكلفة شراء ووصفتُه لا تُنسخ هنا، والخدمة لا تُجرَد ⇒ يُستبعدان (مراجعة Codex P2).
    if (u.isBundle === true || u.isService === true) continue;
    let c = byUnit.get(uid);
    if (!c) {
      c = {
        productUnitId: uid,
        variantId: Number(u.variantId),
        productId: Number(u.productId),
        productName: u.productName,
        unitName: u.unitName,
        sku: u.sku,
        aliases: [],
      };
      byUnit.set(uid, c);
    }
    c.aliases.push({ id: Number(a.id), barcode: a.barcode, note: a.note });
  }
  return Array.from(byUnit.values());
}

/**
 * سقفُ نطاق التحقّق = حدّ `stocktakes.barcodeCoverage` (`z.array().max(10_000)`) الذي يستدعيه محرّر
 * الجرد بالنطاق المُعبّأ؛ تجاوزُه يرفضه الراوتر فيَعمى فحصُ جاهزية الباركود (مراجعة Codex P2). نقتطع
 * هنا **معلنين** الاقتطاع لا صامتين.
 */
const RECON_SCOPE_LIMIT = 10_000;

export interface AlternativeReconciliationScope {
  /** متغيّرات المنتجات التي لها بديلٌ حقيقيّ (الأصل + البدائل)، مقتطعةٌ عند الحدّ — نطاق جرد التحقّق. */
  variantIds: number[];
  productCount: number;
  /** عدد المتغيّرات المُعادة (= طول variantIds بعد الاقتطاع). */
  variantCount: number;
  alternativeCount: number;
  /** true إذا تجاوز النطاق الكامل الحدّ فاقتُطع (يُنشأ الجرد لأوّل RECON_SCOPE_LIMIT؛ كرّر للباقي). */
  truncated: boolean;
}

/**
 * نطاق «جرد تحقّق فصل الرصيد»: بعد فصل بديلٍ يبدأ رصيدُه صفراً بينما يبقى الرصيد الماديّ المدمج على
 * الأصل. لتوزيعه ميدانياً يجب عدُّ **كل متغيّرات المنتج** (الأصل + بدائله) معاً في جلسةٍ واحدة. تُرجع
 * هذه الدالّة معرّفات تلك المتغيّرات لكل منتجٍ نشطٍ له بديلٌ حقيقيّ منشور (غير الخدمات والبكجات).
 */
export async function listAlternativeReconciliationScope(): Promise<AlternativeReconciliationScope> {
  const db = requireDb();
  const empty: AlternativeReconciliationScope = {
    variantIds: [],
    productCount: 0,
    variantCount: 0,
    alternativeCount: 0,
    truncated: false,
  };

  // منتجاتٌ نشطة (سلعية) لها متغيّرُ ALTERNATIVE نشطٌ واحد على الأقل.
  const altProductRows = await db
    .selectDistinct({ productId: productVariants.productId })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(productVariants.variantKind, "ALTERNATIVE"),
        eq(productVariants.isActive, true),
        eq(products.isActive, true),
        eq(products.isService, false),
        eq(products.isBundle, false),
      ),
    );
  const productIds = altProductRows.map((r) => Number(r.productId));
  if (!productIds.length) return empty;

  // كل متغيّرات تلك المنتجات النشطة (الأصل VARIANT + البدائل ALTERNATIVE) — نطاق العدّ.
  const variants = await db
    .select({ id: productVariants.id, kind: productVariants.variantKind })
    .from(productVariants)
    .where(and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true)));

  const allVariantIds = variants.map((v) => Number(v.id));
  const alternativeCount = variants.filter((v) => v.kind === "ALTERNATIVE").length;
  const variantIds = allVariantIds.slice(0, RECON_SCOPE_LIMIT);
  return {
    variantIds,
    productCount: productIds.length,
    variantCount: variantIds.length,
    alternativeCount,
    truncated: allVariantIds.length > RECON_SCOPE_LIMIT,
  };
}

export interface SplitResult {
  newVariantId: number;
  newUnitId: number;
  sourceVariantId: number;
  sku: string;
}

/**
 * يفصل باركوداً بديلاً إلى متغيّرٍ مستقلّ (ALTERNATIVE): متغيّرٌ جديد + وحدة أساسٍ تحمل الباركود
 * المنقول + نسخ أسعار الوحدة المصدر (ليُباع فوراً). الرصيد الجديد يبدأ صفراً؛ يُفصَل المدمج بجردٍ
 * يدويّ لاحق على الصنفين. ذرّيّ داخل withTx.
 */
export async function splitAliasToAlternative(
  input: { productUnitId: number; aliasBarcode: string; name: string; cost?: string | null },
): Promise<SplitResult> {
  const name = input.name?.trim();
  const aliasBarcode = canonicalizeBarcodeInput(input.aliasBarcode ?? "");
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم البديل مطلوب." });
  if (!aliasBarcode) throw new TRPCError({ code: "BAD_REQUEST", message: "الباركود المُفصَل مطلوب." });

  return withTx(async (tx) => {
    // (١) الوحدة المصدر + متغيّرها + منتجها، تحت قفل الصفّ.
    const srcUnit = (
      await tx
        .select({
          id: productUnits.id,
          unitName: productUnits.unitName,
          isStoreSaleUnit: productUnits.isStoreSaleUnit,
          isBaseUnit: productUnits.isBaseUnit,
          isActive: productUnits.isActive,
          variantId: productUnits.variantId,
        })
        .from(productUnits)
        .where(eq(productUnits.id, input.productUnitId))
        .for("update")
        .limit(1)
    )[0];
    if (!srcUnit) throw new TRPCError({ code: "NOT_FOUND", message: "وحدة المنتج غير موجودة." });
    // فصلُ غير وحدة الأساس يُفسد التقييم/COGS (Codex P1) ⇒ يُرفض؛ والوحدة المتقاعدة لا تُفصَل.
    if (srcUnit.isBaseUnit !== true)
      throw new TRPCError({ code: "BAD_REQUEST", message: "الفصل مقصورٌ على باركود وحدة الأساس." });
    if (srcUnit.isActive === false)
      throw new TRPCError({ code: "BAD_REQUEST", message: "وحدةٌ متقاعدة لا تُفصَل." });

    const srcVariant = (
      await tx
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          sku: productVariants.sku,
          costPrice: productVariants.costPrice,
          variantKind: productVariants.variantKind,
          isActive: productVariants.isActive,
        })
        .from(productVariants)
        .where(eq(productVariants.id, srcUnit.variantId))
        .limit(1)
    )[0];
    if (!srcVariant) throw new TRPCError({ code: "NOT_FOUND", message: "المتغيّر المصدر غير موجود." });
    // المصدر يجب أن يكون متغيّراً مدمجاً فعّالاً (VARIANT) — لا يُبنى بديلٌ فوق بديل (Codex P2).
    if (srcVariant.variantKind === "ALTERNATIVE")
      throw new TRPCError({ code: "BAD_REQUEST", message: "المصدر بديلٌ أصليّ — لا يُعاد فصله." });
    if (srcVariant.isActive === false)
      throw new TRPCError({ code: "BAD_REQUEST", message: "متغيّرٌ متقاعد لا يُفصَل." });

    // قفلُ صفّ المنتج الأمّ **قبل** فحص تفرّد الاسم يُسلسِل الفصول المتزامنة على وحداتٍ مختلفة من
    // المنتج نفسه (Codex P2: بلا قفلٍ يقرأ الطلبان نفس البدائل فيُنشئان اسماً/SKU مكرّراً). ويستبعد
    // البكج (بلا وصفةٍ تُنسخ) والخدمة (لا تُجرَد).
    const srcProduct = (
      await tx
        .select({ id: products.id, isBundle: products.isBundle, isService: products.isService })
        .from(products)
        .where(eq(products.id, srcVariant.productId))
        .for("update")
        .limit(1)
    )[0];
    if (!srcProduct) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج الأمّ غير موجود." });
    if (srcProduct.isBundle === true || srcProduct.isService === true)
      throw new TRPCError({ code: "BAD_REQUEST", message: "البكج والخدمة لا يُفصَل منهما بديل." });

    // (٢) الباركود بديلٌ فعليّ لهذه الوحدة.
    const aliasRow = (
      await tx
        .select({ id: productUnitBarcodes.id })
        .from(productUnitBarcodes)
        .where(
          and(
            eq(productUnitBarcodes.productUnitId, input.productUnitId),
            eq(productUnitBarcodes.barcode, aliasBarcode),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    if (!aliasRow) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "هذا الباركود ليس بديلاً لهذه الوحدة — حدّث القائمة.",
      });
    }

    // (٣) اسم البديل فريدٌ ضمن المنتج (بدائله القائمة).
    const siblings = await tx
      .select({ variantName: productVariants.variantName })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.productId, srcVariant.productId),
          eq(productVariants.variantKind, "ALTERNATIVE"),
        ),
      );
    if (siblings.some((s) => (s.variantName ?? "").trim().toLowerCase() === name.toLowerCase())) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `يوجد بديلٌ بالاسم «${name}» لهذا المنتج.` });
    }

    // (٤) SKU مشتقّ فريدٌ عملياً: sku المصدر + ALT + ترتيب البديل، **مقيَّدٌ بحدّ العمود ٦٠ محرفاً**
    // (Codex P2: sku مصدرٍ طويلٍ + اللاحقة يتجاوز العمود فيسقط الإدراج بخطأ اقتطاع). قفلُ المنتج
    // أعلاه يُسلسِل الترقيم فيبقى altCount فريداً ضمن المنتج.
    const SKU_MAX = 60;
    const altCount = siblings.length + 1;
    const suffix = `-ALT${altCount}`;
    const newSku = `${srcVariant.sku.slice(0, SKU_MAX - suffix.length)}${suffix}`;

    // (٥) المتغيّر الجديد (بديل مستقلّ).
    const vRes = await tx.insert(productVariants).values({
      productId: srcVariant.productId,
      sku: newSku,
      variantKind: "ALTERNATIVE",
      variantName: name,
      costPrice: toDbMoney(input.cost?.trim() || String(srcVariant.costPrice ?? "0")),
    });
    const newVariantId = extractInsertId(vRes);

    // (٦) وحدة الأساس للبديل تحمل الباركود المنقول.
    const uRes = await tx.insert(productUnits).values({
      variantId: newVariantId,
      unitName: srcUnit.unitName,
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: srcUnit.isStoreSaleUnit,
      barcode: aliasBarcode,
    });
    const newUnitId = extractInsertId(uRes);

    // (٧) نقل الباركود: يُحذف من البدائل (صار الباركود الأساسيّ للبديل الجديد).
    await tx.delete(productUnitBarcodes).where(eq(productUnitBarcodes.id, aliasRow.id));

    // (٨) نسخ أسعار الوحدة المصدر (كل الفئات) كي يُباع البديل فوراً بسعرٍ افتراضيّ يعدّله المدير.
    const srcPrices = await tx
      .select({ priceTier: productPrices.priceTier, price: productPrices.price })
      .from(productPrices)
      .where(eq(productPrices.productUnitId, input.productUnitId));
    if (srcPrices.length) {
      await tx.insert(productPrices).values(
        srcPrices.map((p) => ({ productUnitId: newUnitId, priceTier: p.priceTier, price: p.price })),
      );
    }

    return {
      newVariantId,
      newUnitId,
      sourceVariantId: Number(srcVariant.id),
      sku: newSku,
    };
  });
}
