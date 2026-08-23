// توزيع مخزون البدائل (وثيقة «الجرد بالباركود» — عرض حصص البدائل ٢٣/٨).
//
// البديل منتجٌ مستقلٌّ بمخزونه وباركوده، يشترك مع الأصل في الاسم والصفات فيُعرَض تحتها كمجموعة. هذه
// الدالّة تجمع لكلّ منتجٍ له بدائل: **الإجماليّ = مجموع مخزون كل ترميزاته** (الأساسيّ + البدائل)،
// وحصّة كلّ ترميزٍ من الإجماليّ (كمية + نسبة). المخزون بوحدة الأساس (صحيح) من branchStock — إمّا
// مجمّعاً عبر الفروع (branchId = null) أو لفرعٍ بعينه.
import { and, eq, inArray, sql } from "drizzle-orm";
import { branchStock, products, productUnits, productVariants } from "../../../drizzle/schema";
import { requireDb } from "../tx";

export interface AlternativeStockVariant {
  variantId: number;
  variantKind: "VARIANT" | "ALTERNATIVE";
  variantName: string | null;
  sku: string;
  baseUnit: string | null;
  quantityBase: number;
  /** حصّة هذا الترميز من إجماليّ المنتج (٠–١٠٠، منزلة واحدة). صفرٌ إن كان الإجماليّ صفراً. */
  sharePct: number;
}

export interface AlternativeStockBreakdown {
  productId: number;
  productName: string;
  /** إجماليّ مخزون المنتج = مجموع مخزون كل متغيّراته (بوحدة الأساس). */
  totalBase: number;
  /** المتغيّرات مرتّبة: الأصل (VARIANT) أولاً ثمّ البدائل (ALTERNATIVE) بترتيب المعرّف. */
  variants: AlternativeStockVariant[];
}

/**
 * توزيع مخزون كل منتجٍ له بديلٌ حقيقيّ منشور (الأصل + بدائله) مع الإجماليّ وحصص الترميزات.
 * @param opts.productId حصر النتيجة بمنتجٍ واحد (لبطاقة المنتج)؛ الحذف = كل المنتجات ذات البدائل (التقرير).
 * @param opts.productIds حصرٌ بمجموعة معرّفات (لتقييد استعلام شاشة المنتجات بصفحتها المرئية لا الكتالوج كلّه).
 * @param opts.branchId مخزون فرعٍ بعينه؛ الحذف = مجموع كل الفروع.
 */
export async function listAlternativeStockBreakdown(
  opts: { productId?: number | null; productIds?: number[] | null; branchId?: number | null } = {},
): Promise<AlternativeStockBreakdown[]> {
  const db = requireDb();
  const branchId = opts.branchId ?? null;

  // قائمةٌ فارغة صراحةً (صفحةٌ بلا منتجات) ⇒ لا شيء، بلا استعلام كتالوج كامل (Codex P2).
  if (opts.productIds && opts.productIds.length === 0) return [];

  // (١) المنتجات النشطة (السلعية) التي لها متغيّرُ ALTERNATIVE نشطٌ واحد على الأقل.
  const altProductConds = [
    eq(productVariants.variantKind, "ALTERNATIVE"),
    eq(productVariants.isActive, true),
    eq(products.isActive, true),
    eq(products.isService, false),
    eq(products.isBundle, false),
  ];
  if (opts.productId != null) altProductConds.push(eq(products.id, opts.productId));
  if (opts.productIds && opts.productIds.length) altProductConds.push(inArray(products.id, opts.productIds));
  const altProductRows = await db
    .selectDistinct({ productId: productVariants.productId })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(...altProductConds));
  const productIds = altProductRows.map((r) => Number(r.productId));
  if (!productIds.length) return [];

  // (٢) كل متغيّرات تلك المنتجات النشطة + اسم المنتج + وحدة الأساس.
  const variantRows = await db
    .select({
      variantId: productVariants.id,
      productId: productVariants.productId,
      productName: products.name,
      variantKind: productVariants.variantKind,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      baseUnit: productUnits.unitName,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(
      productUnits,
      and(eq(productUnits.variantId, productVariants.id), eq(productUnits.isBaseUnit, true)),
    )
    .where(and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true)));

  // (٣) مخزون الأساس لكل متغيّر (مجمّعاً عبر الفروع أو لفرعٍ بعينه).
  const variantIds = variantRows.map((v) => Number(v.variantId));
  const stockConds = [inArray(branchStock.variantId, variantIds)];
  if (branchId != null) stockConds.push(eq(branchStock.branchId, branchId));
  const stockRows = variantIds.length
    ? await db
        .select({
          variantId: branchStock.variantId,
          qty: sql<string>`COALESCE(SUM(${branchStock.quantity}), 0)`,
        })
        .from(branchStock)
        .where(and(...stockConds))
        .groupBy(branchStock.variantId)
    : [];
  const stockByVariant = new Map(stockRows.map((r) => [Number(r.variantId), Number(r.qty ?? 0)]));

  // عدّة وحدات أساس لمتغيّر (join) ⇒ أوّل صفٍّ يفوز؛ نجمّع المتغيّرات تحت منتجاتها.
  const seenVariant = new Set<number>();
  const byProduct = new Map<
    number,
    { productId: number; productName: string; variants: AlternativeStockVariant[] }
  >();
  for (const v of variantRows) {
    const vid = Number(v.variantId);
    if (seenVariant.has(vid)) continue;
    seenVariant.add(vid);
    const pid = Number(v.productId);
    let group = byProduct.get(pid);
    if (!group) {
      group = { productId: pid, productName: String(v.productName ?? ""), variants: [] };
      byProduct.set(pid, group);
    }
    group.variants.push({
      variantId: vid,
      variantKind: v.variantKind === "ALTERNATIVE" ? "ALTERNATIVE" : "VARIANT",
      variantName: v.variantName ?? null,
      sku: v.sku,
      baseUnit: v.baseUnit ?? null,
      quantityBase: stockByVariant.get(vid) ?? 0,
      sharePct: 0, // يُحسَب بعد معرفة الإجماليّ
    });
  }

  const out: AlternativeStockBreakdown[] = [];
  for (const group of Array.from(byProduct.values())) {
    const totalBase = group.variants.reduce((s, v) => s + v.quantityBase, 0);
    // الحصص تُحسَب من الرصيد **الموجب** فقط: branchStock قد يكون سالباً (وضع الافتتاح/الأوفلاين)،
    // والقسمة على المجموع المُوقَّع تُنتج حصصاً خارج [0,100] (‎−100٪/200٪) أو صفراً مُضلِّلاً (Codex P2).
    // الكمية السالبة عجزٌ لا حصّة ⇒ حصّتها 0، والمقام مجموع الكميات الموجبة. القيمة السالبة تبقى ظاهرةً.
    const positiveTotal = group.variants.reduce((s, v) => s + Math.max(0, v.quantityBase), 0);
    for (const v of group.variants) {
      v.sharePct =
        positiveTotal > 0 && v.quantityBase > 0
          ? Math.round((v.quantityBase / positiveTotal) * 1000) / 10
          : 0;
    }
    // الأصل أولاً ثمّ البدائل، وكلٌّ بترتيب المعرّف — عرضٌ ثابت.
    group.variants.sort(
      (a, b) =>
        Number(a.variantKind === "ALTERNATIVE") - Number(b.variantKind === "ALTERNATIVE") ||
        a.variantId - b.variantId,
    );
    out.push({
      productId: group.productId,
      productName: group.productName,
      totalBase,
      variants: group.variants,
    });
  }
  // المنتجات بترتيب المعرّف (ثابت).
  out.sort((a, b) => a.productId - b.productId);
  return out;
}
