// تغطية الباركود لنطاق الجرد (وثيقة «الجرد بالباركود» ٢٢/٨، م٢).
//
// المسح الإلزاميّ ينجح بقدر ما تكون البضاعة ملصَّقة. هذه الوحدة تحسب — لمجموعة متغيّرات —
// كم منها يملك باركوداً قابلاً للمسح (باركود وحدةٍ نشطة أو باركود بديل)، وكم ينقصه، وتُعيد
// وحدات الأساس الناقصة كي يُسلَّمها معالجُ الجرد لشاشة الملصقات دفعةً. قراءةٌ صرفة بلا آثار.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  products,
  productUnitBarcodes,
  productUnits,
  productVariants,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { chunk } from "./internal";

export interface BarcodeCoverage {
  /** عدد المتغيّرات في النطاق. */
  total: number;
  /** المتغيّرات التي تملك باركوداً قابلاً للمسح (وحدة نشطة بباركود أو بديل). */
  withBarcode: number;
  /** total − withBarcode. */
  missing: number;
  /** نسبة التغطية % (عدد صحيح 0..100؛ 100 حين total=0). */
  coveragePct: number;
  /** معرّفات وحدات الأساس (أو أوّل وحدة نشطة) للمتغيّرات الناقصة — لتسليم شاشة الملصقات. */
  missingUnitIds: number[];
  /** عيّنة للعرض (حتى 30) من المتغيّرات الناقصة بأسمائها. */
  missingSample: { variantId: number; productName: string; sku: string }[];
}

const SAMPLE_LIMIT = 30;

/**
 * يحسب تغطية الباركود لمجموعة متغيّرات (مستقلّة عن الفرع — الباركود على الوحدة لا الرصيد).
 * «مغطّى» = للمتغيّر وحدةٌ نشطة تحمل باركوداً أساسياً، أو باركوداً بديلاً على وحدةٍ نشطة.
 */
export async function computeBarcodeCoverage(
  variantIds: number[],
): Promise<BarcodeCoverage> {
  const unique = Array.from(new Set(variantIds.filter((v) => Number.isInteger(v) && v > 0)));
  if (!unique.length) {
    return {
      total: 0,
      withBarcode: 0,
      missing: 0,
      coveragePct: 100,
      missingUnitIds: [],
      missingSample: [],
    };
  }
  const db = requireDb();
  const covered = new Set<number>();

  for (const part of chunk(unique)) {
    // (١) وحدةٌ نشطة تحمل باركوداً أساسياً.
    const withUnit = await db
      .selectDistinct({ variantId: productUnits.variantId })
      .from(productUnits)
      .where(
        and(
          inArray(productUnits.variantId, part),
          eq(productUnits.isActive, true),
          isNotNull(productUnits.barcode),
        ),
      );
    for (const r of withUnit) covered.add(Number(r.variantId));

    // (٢) باركودٌ بديل على وحدةٍ نشطة لنفس المتغيّر.
    const withAlias = await db
      .selectDistinct({ variantId: productUnits.variantId })
      .from(productUnitBarcodes)
      .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
      .where(and(inArray(productUnits.variantId, part), eq(productUnits.isActive, true)));
    for (const r of withAlias) covered.add(Number(r.variantId));
  }

  const missingIds = unique.filter((v) => !covered.has(v));
  const withBarcode = unique.length - missingIds.length;

  // وحدة الأساس (أو أوّل وحدة نشطة) لكلّ متغيّر ناقص — لتسليم شاشة الملصقات.
  const missingUnitIds: number[] = [];
  if (missingIds.length) {
    for (const part of chunk(missingIds)) {
      const unitRows = await db
        .select({
          id: productUnits.id,
          variantId: productUnits.variantId,
          isBaseUnit: productUnits.isBaseUnit,
        })
        .from(productUnits)
        .where(and(inArray(productUnits.variantId, part), eq(productUnits.isActive, true)));
      // اختر وحدة الأساس إن وُجدت، وإلا أصغر معرّف وحدةٍ نشطة لكلّ متغيّر.
      const byVariant = new Map<number, { id: number; base: boolean }>();
      for (const u of unitRows) {
        const vid = Number(u.variantId);
        const cur = byVariant.get(vid);
        const cand = { id: Number(u.id), base: !!u.isBaseUnit };
        if (!cur || (cand.base && !cur.base) || (cand.base === cur.base && cand.id < cur.id)) {
          byVariant.set(vid, cand);
        }
      }
      for (const v of Array.from(byVariant.values())) missingUnitIds.push(v.id);
    }
  }

  // عيّنة العرض بأسماء المنتجات (حتى SAMPLE_LIMIT).
  const missingSample: BarcodeCoverage["missingSample"] = [];
  if (missingIds.length) {
    const sampleIds = missingIds.slice(0, SAMPLE_LIMIT);
    const rows = await db
      .select({
        variantId: productVariants.id,
        productName: products.name,
        sku: productVariants.sku,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, sampleIds));
    const byId = new Map(rows.map((r) => [Number(r.variantId), r]));
    for (const vid of sampleIds) {
      const r = byId.get(vid);
      if (r) missingSample.push({ variantId: vid, productName: r.productName, sku: r.sku });
    }
  }

  return {
    total: unique.length,
    withBarcode,
    missing: missingIds.length,
    coveragePct: unique.length ? Math.floor((withBarcode / unique.length) * 100) : 100,
    missingUnitIds,
    missingSample,
  };
}
