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
      productId: products.id,
      productName: products.name,
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
    // البديل الأصليّ (ALTERNATIVE) لا يُعاد فصله؛ الأداة للوحدات المدمجة (VARIANT) فقط.
    if (u.variantKind === "ALTERNATIVE") continue;
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
  const aliasBarcode = input.aliasBarcode?.trim();
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
          variantId: productUnits.variantId,
        })
        .from(productUnits)
        .where(eq(productUnits.id, input.productUnitId))
        .for("update")
        .limit(1)
    )[0];
    if (!srcUnit) throw new TRPCError({ code: "NOT_FOUND", message: "وحدة المنتج غير موجودة." });

    const srcVariant = (
      await tx
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          sku: productVariants.sku,
          costPrice: productVariants.costPrice,
        })
        .from(productVariants)
        .where(eq(productVariants.id, srcUnit.variantId))
        .limit(1)
    )[0];
    if (!srcVariant) throw new TRPCError({ code: "NOT_FOUND", message: "المتغيّر المصدر غير موجود." });

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

    // (٤) SKU مشتقّ فريدٌ عملياً: sku المصدر + ALT + ترتيب البديل.
    const altCount = siblings.length + 1;
    const newSku = `${srcVariant.sku}-ALT${altCount}`;

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
