/**
 * categoryService.ts — إدارة فئات/تصنيفات المنتجات (categories).
 *
 * الفئة جدول مستقل (`categories`) يرتبط به المنتج عبر `products.categoryId` (FK بلا ON DELETE)،
 * لذا أي حذف/دمج يجب أن يُعيد تخصيص منتجات الفئة أولاً ضمن معاملة ذرّية واحدة قبل الحذف —
 * وإلا فشل قيد المفتاح الأجنبي أو يُتمت فقدان ربط منتجات.
 *
 * يوفّر: قائمة بعدد المنتجات لكل فئة، إنشاء، تعديل (اسم/وصف/حالة)، حذف (مع إعادة تخصيص)،
 * دمج فئات (نقل منتجات المصدر إلى الهدف ثم حذف المصدر)، ونقل منتجات محدّدة بين الفئات.
 *
 * المطابقة على الاسم غير حسّاسة للحالة (ترتيب utf8mb4_*_ci) مطابقةً لقيد UNIQUE في DB —
 * نفحص التكرار مسبقاً برسالة عربية واضحة، والقيد هو الحارس الأخير.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { categories, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { extractInsertId } from "../lib/insertId";
import { withTx, type Actor } from "./tx";

export interface CategoryAdminRow {
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
  productCount: number;
  createdAt: Date;
}

/** قائمة الفئات بعدد منتجاتها (يشمل المعطّلة منها والمنتجات المعطّلة — صورة كاملة للإدارة). */
export async function listCategoriesAdmin(): Promise<CategoryAdminRow[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      description: categories.description,
      isActive: categories.isActive,
      createdAt: categories.createdAt,
      productCount: sql<number>`COUNT(${products.id})`,
    })
    .from(categories)
    .leftJoin(products, eq(products.categoryId, categories.id))
    .groupBy(categories.id)
    .orderBy(asc(categories.name));
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    description: r.description ?? null,
    isActive: r.isActive == null ? true : !!r.isActive,
    productCount: Number(r.productCount ?? 0),
    createdAt: r.createdAt,
  }));
}

/** يتحقّق من عدم وجود فئة أخرى بنفس الاسم (غير حسّاس للحالة)، مع استثناء معرّف اختياري. */
async function assertNameFree(name: string, excludeId?: number) {
  const db = getDb();
  if (!db) return;
  const clash = (
    await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        excludeId != null
          ? and(eq(categories.name, name), ne(categories.id, excludeId))
          : eq(categories.name, name),
      )
      .limit(1)
  )[0];
  if (clash) throw new TRPCError({ code: "CONFLICT", message: `الفئة «${name}» موجودة مسبقاً.` });
}

export async function createCategory(input: { name: string; description?: string | null }, _actor: Actor) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const name = input.name.trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الفئة مطلوب." });
  await assertNameFree(name);
  const res = await db.insert(categories).values({ name, description: input.description?.trim() || null });
  return { id: extractInsertId(res), name };
}

export async function updateCategory(
  input: { id: number; name?: string; description?: string | null; isActive?: boolean },
  _actor: Actor,
) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const cur = (await db.select().from(categories).where(eq(categories.id, input.id)).limit(1))[0];
  if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "الفئة غير موجودة." });

  const patch: { name?: string; description?: string | null; isActive?: boolean } = {};
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الفئة مطلوب." });
    if (name !== cur.name) {
      await assertNameFree(name, input.id);
      patch.name = name;
    }
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.isActive != null) patch.isActive = input.isActive;

  if (Object.keys(patch).length) await db.update(categories).set(patch).where(eq(categories.id, input.id));
  return { id: input.id };
}

/**
 * حذف فئة. منتجاتها تُعاد إلى `reassignToId` (إن وُجد) أو تصبح «بلا فئة» (NULL) — لا تُحذف منتجات،
 * ولا يُترك ربط معلّق ينتهك FK. ذرّي: إعادة التخصيص ثم الحذف في معاملة واحدة.
 */
export async function deleteCategory(input: { id: number; reassignToId?: number | null }, _actor: Actor) {
  return withTx(async (tx) => {
    const cur = (await tx.select().from(categories).where(eq(categories.id, input.id)).limit(1))[0];
    if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "الفئة غير موجودة." });

    const target = input.reassignToId ?? null;
    if (target != null) {
      if (target === input.id) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن نقل المنتجات إلى الفئة نفسها المراد حذفها." });
      const t = (await tx.select({ id: categories.id }).from(categories).where(eq(categories.id, target)).limit(1))[0];
      if (!t) throw new TRPCError({ code: "BAD_REQUEST", message: "الفئة الهدف للنقل غير موجودة." });
    }

    const moved = Number(
      (await tx.select({ n: sql<number>`COUNT(*)` }).from(products).where(eq(products.categoryId, input.id)))[0]?.n ?? 0,
    );
    if (moved) await tx.update(products).set({ categoryId: target }).where(eq(products.categoryId, input.id));
    await tx.delete(categories).where(eq(categories.id, input.id));
    return { id: input.id, reassigned: moved, reassignedTo: target };
  });
}

/**
 * دمج فئات: تُنقَل منتجات كل فئات المصدر إلى الفئة الهدف ثم تُحذف فئات المصدر.
 * يستبعد الهدف من المصادر تلقائياً. ذرّي.
 */
export async function mergeCategories(input: { sourceIds: number[]; targetId: number }, _actor: Actor) {
  return withTx(async (tx) => {
    const target = (await tx.select({ id: categories.id }).from(categories).where(eq(categories.id, input.targetId)).limit(1))[0];
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "الفئة الهدف غير موجودة." });

    const sources = Array.from(new Set(input.sourceIds.filter((s) => s !== input.targetId)));
    if (!sources.length) return { moved: 0, deleted: 0, targetId: input.targetId };

    const moved = Number(
      (await tx.select({ n: sql<number>`COUNT(*)` }).from(products).where(inArray(products.categoryId, sources)))[0]?.n ?? 0,
    );
    if (moved) await tx.update(products).set({ categoryId: input.targetId }).where(inArray(products.categoryId, sources));
    await tx.delete(categories).where(inArray(categories.id, sources));
    return { moved, deleted: sources.length, targetId: input.targetId };
  });
}

/**
 * نقل منتجات محدّدة إلى فئة (أو «بلا فئة» عند categoryId=null). يُستعمل للنقل الجماعي من قائمة المنتجات.
 */
export async function reassignProducts(input: { productIds: number[]; categoryId: number | null }, _actor: Actor) {
  return withTx(async (tx) => {
    const ids = Array.from(new Set(input.productIds.filter((n) => Number.isFinite(n) && n > 0)));
    if (!ids.length) return { moved: 0, categoryId: input.categoryId };
    if (input.categoryId != null) {
      const t = (await tx.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId)).limit(1))[0];
      if (!t) throw new TRPCError({ code: "BAD_REQUEST", message: "الفئة الهدف غير موجودة." });
    }
    await tx.update(products).set({ categoryId: input.categoryId }).where(inArray(products.id, ids));
    return { moved: ids.length, categoryId: input.categoryId };
  });
}
