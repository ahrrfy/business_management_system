/**
 * تخطيط موسم المدارس — شريحة «بند 7» (تخطيط الموسم).
 *
 * يستغلّ عمود `productVariants.seasonTarget` (هجرة 0098): متغيّرٌ هدفُه الموسميّ > 0 ⇒ صنفٌ موسميّ (مدرسيّ).
 * - listSeasonPlan: كل متغيّرٍ موسميّ (نشط، منتجه نشط) مع مخزونه الكلّيّ عبر **كل الفروع** مقابل هدف
 *   الموسم، مرتّباً بالأبعد عن الهدف أولاً (نسبة المخزون إلى الهدف تصاعدياً). لا تُعاد التكلفة
 *   (لا تسريب هامش الربح لأدوار القراءة). الفجوة = max(0, الهدف − المخزون) = كمية الشراء المقترحة.
 * - setSeasonTarget: ضبط هدف الموسم لمتغيّر (عدد صحيح ≥ 0؛ 0 = يُزيله من خطة الموسم).
 * - countSeasonBelowTarget: عدد المتغيّرات الموسمية تحت الهدف — لمؤشّر لوحة المخزون الحيّ (استباقيّ).
 *
 * لماذا الإجمالي عبر الفروع لا لكل فرع (بخلاف reorderAlerts): خطة الموسم أداةُ **شراءٍ استباقيّ** على
 * مستوى العمل كلّه (تُشترى الكمية دفعةً ثم تُوزَّع على الفروع بأمر شراء/تحويل)، لا إنذارَ نفادٍ فرعيّ آنيّ.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { branchStock, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";

export interface SeasonPlanRow {
  variantId: number;
  productId: number;
  productName: string;
  sku: string;
  variantName: string | null;
  color: string | null;
  size: string | null;
  /** المخزون الكلّيّ بالوحدة الأساس عبر كل الفروع (قد يكون سالباً — خدمات allowNegative/وضع الافتتاح). */
  totalStock: number;
  seasonTarget: number;
  /** كمية الشراء المقترحة لبلوغ الهدف = max(0, الهدف − المخزون الكلّيّ). */
  gap: number;
}

export interface ListSeasonPlanInput {
  /** اقتصر على الأصناف تحت الهدف (فجوة > 0) — «قائمة الشراء» فقط. الافتراضي: كل الأصناف الموسمية. */
  onlyBelowTarget?: boolean;
  limit?: number;
  offset?: number;
}

export async function listSeasonPlan(input: ListSeasonPlanInput = {}): Promise<SeasonPlanRow[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(input.limit ?? 300, 1), 1000);
  const offset = Math.max(input.offset ?? 0, 0);

  // المخزون الكلّيّ عبر كل الفروع (LEFT JOIN ⇒ المتغيّر غير المُخزَّن قط يظهر بمخزونٍ صفر وفجوةٍ كاملة).
  const totalStockSum = sql<number>`COALESCE(SUM(${branchStock.quantity}), 0)`;

  const base = db
    .select({
      variantId: productVariants.id,
      productId: productVariants.productId,
      productName: products.name,
      sku: productVariants.sku,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      seasonTarget: productVariants.seasonTarget,
      totalStock: totalStockSum,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(branchStock, eq(branchStock.variantId, productVariants.id))
    .where(
      and(
        sql`${productVariants.seasonTarget} > 0`,
        eq(productVariants.isActive, true),
        eq(products.isActive, true),
      ),
    )
    .groupBy(
      productVariants.id,
      productVariants.productId,
      products.name,
      productVariants.sku,
      productVariants.variantName,
      productVariants.color,
      productVariants.size,
      productVariants.seasonTarget,
    )
    // «قائمة الشراء» فقط ⇒ المخزون الكلّيّ < الهدف (فجوة موجبة). HAVING لأن الشرط على مُجمَّع.
    .having(
      input.onlyBelowTarget
        ? sql`COALESCE(SUM(${branchStock.quantity}), 0) < ${productVariants.seasonTarget}`
        : sql`1 = 1`,
    )
    // الأبعد عن الهدف أولاً: نسبة المخزون إلى الهدف تصاعدياً (مخزون سالب ⇒ نسبة سالبة ⇒ الصدارة).
    // كسر التعادل بمعرّف المتغيّر لترتيب حتمي (ترقيم صفحات مستقرّ).
    .orderBy(
      asc(sql`(COALESCE(SUM(${branchStock.quantity}), 0) / ${productVariants.seasonTarget})`),
      asc(productVariants.id),
    )
    .limit(limit)
    .offset(offset);

  const rows = await base;

  return rows.map((r) => {
    const seasonTarget = Number(r.seasonTarget ?? 0);
    const stock = Number(r.totalStock ?? 0);
    return {
      variantId: Number(r.variantId),
      productId: Number(r.productId),
      productName: r.productName,
      sku: r.sku,
      variantName: r.variantName,
      color: r.color,
      size: r.size,
      totalStock: stock,
      seasonTarget,
      // كميات أعداد صحيحة (لا أموال) ⇒ حساب int مباشر مشروع (§٥).
      gap: Math.max(0, seasonTarget - stock),
    };
  });
}

export interface SetSeasonTargetInput {
  variantId: number;
  seasonTarget: number;
}

export async function setSeasonTarget(input: SetSeasonTargetInput) {
  const { variantId, seasonTarget } = input;
  if (!Number.isInteger(seasonTarget) || seasonTarget < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "هدف الموسم يجب أن يكون عدداً صحيحاً غير سالب" });
  }
  return withTx(async (tx) => {
    const v = (
      await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.id, variantId))
        .for("update")
        .limit(1)
    )[0];
    if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "المتغيّر غير موجود" });
    await tx.update(productVariants).set({ seasonTarget }).where(eq(productVariants.id, variantId));
    return { variantId, seasonTarget };
  });
}

export interface SeasonCandidate {
  variantId: number;
  productName: string;
  sku: string;
  variantName: string | null;
  color: string | null;
  size: string | null;
  /** هدفه الموسميّ الحاليّ (0 = غير موسميّ بعد) — يُظهر في المنتقي أنه مُضاف سلفاً. */
  seasonTarget: number;
  totalStock: number;
}

/**
 * بحث المتغيّرات النشطة (باسم المنتج/SKU/اسم المتغيّر) لإضافتها لخطة الموسم — يشمل غير المُخزَّن قط
 * (LEFT JOIN)، ويُعيد هدفه الحاليّ فيميّز المنتقي المُضاف سلفاً. المدير/المخزن (الراوتر يفرض البوّابة).
 */
export async function searchSeasonCandidates(q: string, limit = 20): Promise<SeasonCandidate[]> {
  const db = getDb();
  if (!db) return [];
  const term = q.trim();
  if (!term) return [];
  // ! حرف هروب بـ ESCAPE '!' (نمط inventoryRouter) — آمن ضدّ NO_BACKSLASH_ESCAPES.
  const pat = `%${term.replace(/[!%_]/g, "!$&")}%`;
  const totalStockSum = sql<number>`COALESCE(SUM(${branchStock.quantity}), 0)`;
  const rows = await db
    .select({
      variantId: productVariants.id,
      productName: products.name,
      sku: productVariants.sku,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      seasonTarget: productVariants.seasonTarget,
      totalStock: totalStockSum,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(branchStock, eq(branchStock.variantId, productVariants.id))
    .where(
      and(
        eq(productVariants.isActive, true),
        eq(products.isActive, true),
        sql`(${products.name} LIKE ${pat} ESCAPE '!' OR ${productVariants.sku} LIKE ${pat} ESCAPE '!' OR ${productVariants.variantName} LIKE ${pat} ESCAPE '!')`,
      ),
    )
    .groupBy(
      productVariants.id,
      products.name,
      productVariants.sku,
      productVariants.variantName,
      productVariants.color,
      productVariants.size,
      productVariants.seasonTarget,
    )
    .orderBy(asc(products.name), asc(productVariants.sku))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map((r) => ({
    variantId: Number(r.variantId),
    productName: r.productName,
    sku: r.sku,
    variantName: r.variantName,
    color: r.color,
    size: r.size,
    seasonTarget: Number(r.seasonTarget ?? 0),
    totalStock: Number(r.totalStock ?? 0),
  }));
}

/**
 * عدد المتغيّرات الموسمية التي مخزونها الكلّيّ عبر الفروع < هدف الموسم — مؤشّر «تحتاج تجهيزاً» الحيّ.
 * COUNT على استعلامٍ فرعيّ مُجمَّع (لا يجلب صفوفاً) ⇒ خفيفٌ للاستدعاء المتكرّر في رأس شاشة المخزون.
 */
export async function countSeasonBelowTarget(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS c FROM (
      SELECT v.id
      FROM productVariants v
      INNER JOIN products p ON p.id = v.productId
      LEFT JOIN branchStock bs ON bs.variantId = v.id
      WHERE v.seasonTarget > 0 AND v.isActive = TRUE AND p.isActive = TRUE
      GROUP BY v.id, v.seasonTarget
      HAVING COALESCE(SUM(bs.quantity), 0) < v.seasonTarget
    ) t
  `);
  const data = (rows as any)[0] ?? rows;
  return Number((Array.isArray(data) ? data[0]?.c : 0) ?? 0);
}
