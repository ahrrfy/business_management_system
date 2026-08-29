/**
 * كاشفُ فجوات الصور — يُصنِّف كل منتجٍ نشطٍ في حالةٍ صحيّة، ويُعيد عدّاداتٍ وقوائم
 * قابلةً للتصفية والفعل.
 *
 * الحاجة (المالك ٢٦/٨): «منظومة ذكيّة تقترح وتبحث عن المنتجات التي لا تحتوي على صور، أو
 * بدائل لم يُضَف لها صور، أو بكج، أو نحو ذلك — لتقليل هدر الوقت والجهد».
 *
 * التصميم: بدلاً من «مسحٍ عامّ» يُنتج قائمةً بلا معنًى، نُصنّف كل منتجٍ في **حالةٍ محدّدة**
 * لها إجراءٌ واضح. ستّ حالات (٥ فعليّة + HEALTHY):
 *
 *   NO_IMAGES              — لا صورةٌ معتمَدةٌ إطلاقاً. أولويّةٌ قصوى.
 *   BUNDLE_NO_IMAGE         — مثل NO_IMAGES لكن `isBundle=1`. يُبرَز لأنّ البكج يظهر
 *                             في الفواتير/الكاشير بلا صورة ⇒ ضربةٌ مباشرة للعرض.
 *   SINGLE_IMAGE           — صورةٌ واحدة فقط. مرشّحٌ لإضافة زوايا/بدائل.
 *   PARENT_ONLY_HAS_VARIANTS — صور مستوى-الأمّ موجودة لكن للمنتج بدائل بلا صور خاصّة.
 *                             (يعني: البدائل تعرض صورة الأمّ المشتركة، ليس صورتها.)
 *   VARIANTS_INCOMPLETE     — للمنتج بدائل، بعضها لا صور له. أوسع من السابق.
 *   HEALTHY                — كل شيء مغطًّى (يُستَبعد من القوائم الافتراضيّة).
 *
 * الاستعلامات مصمَّمة لتعمل على كتالوجٍ بآلاف المنتجات: subqueries scalar تُحسَب مرّةً في
 * SQL بدل جولاتٍ متعدّدة، والفلاتر تُطبَّق قبل التصنيف — لا نمسح الكتالوج ثمّ نُصفّي.
 *
 * الأمان: manager فقط + `productStudio: READ`. تُطبَّق الحدود الفرعية عبر categoryIds
 * وحقولٍ صريحة — لا لقطاتٍ مالية ولا تكلفة ولا مخزون.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { categories, productImages, productVariants, products } from "../../drizzle/schema";
import { requireDb } from "./tx";
import type { ProductStudioActor } from "./productStudioService";

/** كل الحالات الممكنة لصحّة صور المنتج. */
export const IMAGE_HEALTH_STATES = [
  "NO_IMAGES",
  "BUNDLE_NO_IMAGE",
  "SINGLE_IMAGE",
  "PARENT_ONLY_HAS_VARIANTS",
  "VARIANTS_INCOMPLETE",
  "HEALTHY",
] as const;
export type ImageHealthState = (typeof IMAGE_HEALTH_STATES)[number];

function isManager(actor: ProductStudioActor): boolean {
  return actor.role === "admin" || actor.role === "manager" || actor.isOwner === true;
}

/**
 * تعبيرُ SQL يحسب حالةَ صحّة الصور لكل منتج داخل الاستعلام مباشرةً. يُغني عن جولةٍ في
 * Node لتصنيف الصفوف. ترتيبُ CASE مهمّ: الأكثرُ خطورةً أوّلاً.
 */
function healthCaseSql() {
  return sql<ImageHealthState>`(
    case
      when (
        (select count(*) from ${productImages} where ${productImages.productId} = ${products.id} and ${productImages.reviewStatus} = 'APPROVED') = 0
      ) then (
        case when ${products.isBundle} = 1 then 'BUNDLE_NO_IMAGE' else 'NO_IMAGES' end
      )
      when (
        (select count(*) from ${productImages} where ${productImages.productId} = ${products.id} and ${productImages.reviewStatus} = 'APPROVED') = 1
      ) then 'SINGLE_IMAGE'
      when (
        (select count(*) from ${productVariants} where ${productVariants.productId} = ${products.id} and ${productVariants.isActive} = 1) > 0
        and (
          select count(distinct ${productVariants.id})
          from ${productVariants}
          where ${productVariants.productId} = ${products.id}
            and ${productVariants.isActive} = 1
            and not exists (
              select 1 from ${productImages}
              where ${productImages.productId} = ${products.id}
                and ${productImages.variantId} = ${productVariants.id}
                and ${productImages.reviewStatus} = 'APPROVED'
            )
        ) > 0
        and (
          select count(*) from ${productImages}
          where ${productImages.productId} = ${products.id}
            and ${productImages.variantId} is null
            and ${productImages.reviewStatus} = 'APPROVED'
        ) > 0
      ) then 'PARENT_ONLY_HAS_VARIANTS'
      when (
        (select count(*) from ${productVariants} where ${productVariants.productId} = ${products.id} and ${productVariants.isActive} = 1) > 0
        and (
          select count(distinct ${productVariants.id})
          from ${productVariants}
          where ${productVariants.productId} = ${products.id}
            and ${productVariants.isActive} = 1
            and not exists (
              select 1 from ${productImages}
              where ${productImages.productId} = ${products.id}
                and ${productImages.variantId} = ${productVariants.id}
                and ${productImages.reviewStatus} = 'APPROVED'
            )
        ) > 0
      ) then 'VARIANTS_INCOMPLETE'
      else 'HEALTHY'
    end
  )`;
}

/**
 * عدّاداتُ الحالات لكامل الكتالوج المرئيّ للفاعل — أساسٌ لبطاقات KPI في اللوحة.
 * استعلامٌ واحد يُنتج كل الأعداد دفعةً بلا جولاتٍ متعدّدة.
 */
export async function getImageHealthCounts(actor: ProductStudioActor) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const db = requireDb();
  const health = healthCaseSql();
  const rows = await db
    .select({
      health,
      n: sql<number>`count(*)`,
    })
    .from(products)
    .where(and(eq(products.isActive, true), eq(products.isService, false)))
    .groupBy(health);
  const counts: Record<ImageHealthState, number> = {
    NO_IMAGES: 0,
    BUNDLE_NO_IMAGE: 0,
    SINGLE_IMAGE: 0,
    PARENT_ONLY_HAS_VARIANTS: 0,
    VARIANTS_INCOMPLETE: 0,
    HEALTHY: 0,
  };
  for (const row of rows) {
    const state = row.health as ImageHealthState;
    if (state in counts) counts[state] = Number(row.n ?? 0);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    total,
    counts,
    // نسبةُ الصحّة العامّة — للوحةٍ رئيسيّة يفهمها المدير في لحظة.
    healthyPercent: total > 0 ? Math.round((counts.HEALTHY / total) * 100) : 0,
  };
}

/** خياراتُ فرزٍ للكاشف — تُطبَّق داخل الاستعلام قبل التقطيع كي لا يُقصَّ الأولويّ. */
export type DiscoverySort = "MISSING_MOST" | "NAME_ASC" | "APPROVED_ASC" | "VARIANTS_MISSING_MOST";

/** فلاترُ اكتشاف الفجوات. */
export interface DiscoveryFilters {
  states?: ImageHealthState[];
  categoryIds?: number[];
  isBundle?: boolean;
  search?: string;
  limit?: number;
  cursor?: number;
  /** ترتيب النتائج قبل التقطيع (Codex P2): بدونه الفرز على الواجهة يُقصّ الأولويّ. */
  sort?: DiscoverySort;
}

/**
 * قائمةُ منتجاتٍ مصنَّفةٍ بحالتها، قابلة للتصفية والاختيار الجماعيّ. الترتيب افتراضياً
 * بالحالة الأخطر أوّلاً ثمّ باسم المنتج — كي يبدأ المدير من «الحرِج» طبيعياً.
 */
export async function discoverImageGaps(actor: ProductStudioActor, input: DiscoveryFilters) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const db = requireDb();
  const health = healthCaseSql();
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const cursor = input.cursor && Number.isSafeInteger(input.cursor) ? Number(input.cursor) : null;

  const conditions = [eq(products.isActive, true), eq(products.isService, false)];
  if (input.categoryIds && input.categoryIds.length > 0) {
    // فئاتٌ متعدّدة، كلٌّ بشجرتها الفرعيّة — نفس منطق CAMPAIGN CATEGORIES.
    conditions.push(
      sql`${products.categoryId} in (
        with recursive category_tree (id) as (
          select unnested.id from (select id from ${categories} where id in (${sql.join(input.categoryIds.map((n) => sql`${Number(n)}`), sql`, `)})) as unnested
          union all
          select ${categories.id} from ${categories}
          inner join category_tree on ${categories.parentId} = category_tree.id
        )
        select id from category_tree
      )`,
    );
  }
  if (input.isBundle === true) conditions.push(eq(products.isBundle, true));
  if (input.isBundle === false) conditions.push(eq(products.isBundle, false));
  if (input.search && input.search.trim()) {
    const like = `%${input.search.trim()}%`;
    conditions.push(sql`(${products.name} like ${like} or ${products.searchNorm} like ${like})`);
  }

  // حسبَ الحالة: نجرِّبُ إخفاء HEALTHY افتراضياً — لا فائدةَ من إظهار السليم في «كشف الفجوات».
  const stateFilter = input.states && input.states.length > 0
    ? input.states
    : (["NO_IMAGES", "BUNDLE_NO_IMAGE", "SINGLE_IMAGE", "PARENT_ONLY_HAS_VARIANTS", "VARIANTS_INCOMPLETE"] as ImageHealthState[]);
  // نُنفّذ التصفية بالحالة على subquery الخارجيّ كي لا نضيف CASE في WHERE (يتكرّر
  // الحساب في MySQL). النمط: SELECT ... FROM (SELECT ..., CASE ... FROM products WHERE ...)
  // AS x WHERE x.health IN (...)
  //
  // ⚠️ الفرز يُطبَّق على الاستعلام **الخارجيّ** (Codex P2 على PR #865): الفرز على الواجهة
  // كان يمسّ ١٠٠ صفٍّ فقط، فيُقصّ الأولويّ إن كان معرّفه فوق المائة. `variantCount` و
  // `variantsWithImages` محسوبان في subquery داخليّ فيسهل الوصول إليهما بالاسم في الخارج.
  // بدائلُ الحسابات كأعمدةٍ مستقلّةٍ في الـsubquery الداخليّ. الحسابُ الحسابيّ داخل `sql``
  // على `inner.variantCount` كان يُدخل الـsubquery الصلبيّ الخام (يشير إلى `products.id`
  // خارج نطاقه) في ORDER BY الخارجيّ ⇒ Unknown column على الإنتاج (بلاغ ٢٩/٨).
  // الحسابُ هنا في السطر يضمن أن يظهر كعمودٍ مسمّى في alias `d`، فالمرجع من الخارج آمن.
  const approvedImagesSql = sql<number>`(select count(*) from ${productImages} where ${productImages.productId} = ${products.id} and ${productImages.reviewStatus} = 'APPROVED')`;
  const variantCountSql = sql<number>`(select count(*) from ${productVariants} where ${productVariants.productId} = ${products.id} and ${productVariants.isActive} = 1)`;
  const variantsWithImagesSql = sql<number>`(
    select count(distinct ${productVariants.id})
    from ${productVariants}
    where ${productVariants.productId} = ${products.id}
      and ${productVariants.isActive} = 1
      and exists (
        select 1 from ${productImages}
        where ${productImages.productId} = ${products.id}
          and ${productImages.variantId} = ${productVariants.id}
          and ${productImages.reviewStatus} = 'APPROVED'
      )
  )`;
  const inner = db
    .select({
      id: products.id,
      name: products.name,
      categoryId: products.categoryId,
      isBundle: products.isBundle,
      // ⚠️ `.as('name')` صريحٌ على كلّ حقلٍ من `sql<number>` (Codex/بلاغ إنتاج ٢٩/٨):
      // درizzle 0.45 يرفض الإشارة إلى raw SQL field من subquery خارج نطاقه بلا alias
      // معلَن. مفتاح الكائن وحده لا يكفي — كان الاستدعاء `desc(inner.variantsMissing)`
      // يرمي: «You tried to reference X field from a subquery, which is a raw SQL field,
      // but it doesn't have an alias declared». الحلّ: `.as('name')` على كلٍّ منها.
      approvedImages: approvedImagesSql.as("approvedImages"),
      variantCount: variantCountSql.as("variantCount"),
      variantsWithImages: variantsWithImagesSql.as("variantsWithImages"),
      // عمودٌ مستقلّ للفرز — الحسابُ داخل الـsubquery حيث الـcorrelated subqueries صالحةٌ.
      variantsMissing: sql<number>`greatest(0, (${variantCountSql}) - (${variantsWithImagesSql}))`.as("variantsMissing"),
      // نفس القاعدة على `health` — يُستهلَك بـ`inner.health` في `inArray`، فيلزمه alias
      // معلَن وإلّا رمى Drizzle 0.45 نفس رسالة raw-SQL-field-without-alias (بلاغ ٢٩/٨).
      health: health.as("health"),
    })
    .from(products)
    .where(and(...conditions, cursor != null ? sql`${products.id} > ${cursor}` : undefined))
    // نطاقُ الترشيح الداخليّ يبقى بمعرّف المنتج (يتحدّد بالـcursor)، والفرز الحقيقيّ
    // يقع على الخارجيّ بعد الترشيح بالحالة. `limit + 1` هنا كافٍ لأنّ التقطيع خارجيّ.
    .orderBy(asc(products.id))
    .limit(limit + 1)
    .as("d");
  const sort: DiscoverySort = input.sort ?? "MISSING_MOST";
  // نستهلك `inner.variantsMissing` كعمودٍ مسمّى على alias `d` — درizzle helpers (asc/desc)
  // يعرفون توليدَ `d.variantsMissing` بأمانٍ، بلا توسيع النصّ الأصليّ.
  const orderBy = sort === "NAME_ASC"
    ? [asc(inner.name), asc(inner.id)]
    : sort === "APPROVED_ASC"
      ? [asc(inner.approvedImages), asc(inner.name), asc(inner.id)]
      : sort === "VARIANTS_MISSING_MOST"
        ? [desc(inner.variantsMissing), asc(inner.name), asc(inner.id)]
        // MISSING_MOST (افتراضيّ): «الأحوج» = بدائل ناقصة أوّلاً ثمّ الأقلّ صوراً معتمَدة ثمّ الاسم.
        : [desc(inner.variantsMissing), asc(inner.approvedImages), asc(inner.name), asc(inner.id)];
  const rows = await db
    .select()
    .from(inner)
    .where(inArray(inner.health, stateFilter))
    .orderBy(...orderBy);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: items.map((r) => ({
      productId: Number(r.id),
      name: r.name,
      categoryId: r.categoryId == null ? null : Number(r.categoryId),
      isBundle: Boolean(r.isBundle),
      approvedImages: Number(r.approvedImages ?? 0),
      variantCount: Number(r.variantCount ?? 0),
      variantsWithImages: Number(r.variantsWithImages ?? 0),
      variantsMissing: Math.max(0, Number(r.variantCount ?? 0) - Number(r.variantsWithImages ?? 0)),
      state: r.health as ImageHealthState,
    })),
    nextCursor: hasMore ? Number(items[items.length - 1]?.id ?? 0) : null,
  };
}

/**
 * أعلى الفئات فيها فجوات — أساسٌ لاقتراحاتٍ استباقيّة («٣٥ منتج في «قرطاسية» بلا صور»).
 * التصنيف بمتوسّط سوء الحالة لكل فئة.
 */
export async function getTopGapCategories(actor: ProductStudioActor, limit = 10) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const db = requireDb();
  const health = healthCaseSql();
  const rows = await db
    .select({
      categoryId: products.categoryId,
      categoryName: categories.name,
      total: sql<number>`count(*)`,
      noImages: sql<number>`sum(case when (${health}) in ('NO_IMAGES','BUNDLE_NO_IMAGE') then 1 else 0 end)`,
      singleImage: sql<number>`sum(case when (${health}) = 'SINGLE_IMAGE' then 1 else 0 end)`,
      variantsIncomplete: sql<number>`sum(case when (${health}) in ('PARENT_ONLY_HAS_VARIANTS','VARIANTS_INCOMPLETE') then 1 else 0 end)`,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(eq(products.isActive, true), eq(products.isService, false)))
    .groupBy(products.categoryId, categories.name)
    .having(sql`sum(case when (${health}) in ('NO_IMAGES','BUNDLE_NO_IMAGE','SINGLE_IMAGE','PARENT_ONLY_HAS_VARIANTS','VARIANTS_INCOMPLETE') then 1 else 0 end) > 0`)
    .orderBy(desc(sql`sum(case when (${health}) in ('NO_IMAGES','BUNDLE_NO_IMAGE') then 1 else 0 end)`))
    .limit(Math.max(1, Math.min(limit, 50)));
  void isNull; // silence unused-import warning; kept for future filters
  return rows.map((r) => ({
    categoryId: r.categoryId == null ? null : Number(r.categoryId),
    categoryName: r.categoryName ?? "(بلا فئة)",
    total: Number(r.total ?? 0),
    noImages: Number(r.noImages ?? 0),
    singleImage: Number(r.singleImage ?? 0),
    variantsIncomplete: Number(r.variantsIncomplete ?? 0),
    gapTotal: Number(r.noImages ?? 0) + Number(r.singleImage ?? 0) + Number(r.variantsIncomplete ?? 0),
  }));
}
