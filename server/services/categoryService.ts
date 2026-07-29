/**
 * categoryService.ts — إدارة فئات/تصنيفات المنتجات (categories).
 *
 * الفئة جدول مستقل (`categories`) يرتبط به المنتج عبر `products.categoryId` (FK بلا ON DELETE)،
 * لذا أي حذف/دمج يجب أن يُعيد تخصيص منتجات الفئة أولاً ضمن معاملة ذرّية واحدة قبل الحذف —
 * وإلا فشل قيد المفتاح الأجنبي أو يُتمت فقدان ربط منتجات.
 *
 * أقسام فرعية (٢٩/٧): `categories.parentId` مرجع ذاتي بلا قيد FK (نمط accounts.parentId).
 * **العمق مقيَّد بمستويين فقط** (فئة رئيسية ← فئة فرعية) — يُفرض هنا (لا في DB): فئة برٍّ (parentId
 * أب) لا يمكن أن تحمل هي نفسها فئات فرعية، ولا يمكن جعل فئة تحوي فرعيات فئةً فرعيةً لأخرى. المنتج
 * يبقى مرتبطاً بفئة واحدة (`products.categoryId`) سواء كانت رئيسية أو فرعية — لا فرق للمخزن.
 *
 * يوفّر: قائمة بعدد المنتجات لكل فئة (مباشر + شامل الفرعيات)، إنشاء/تعديل فئة أو فئة فرعية،
 * حذف (مع إعادة تخصيص، ويُمنع حذف فئة تحوي فرعيات قبل حذفها/نقلها)، دمج فئات من نفس المستوى
 * (يُمنع دمج فئة تحوي فرعيات)، ونقل منتجات محدّدة بين الفئات.
 *
 * المطابقة على الاسم غير حسّاسة للحالة (ترتيب utf8mb4_*_ci) مطابقةً لقيد UNIQUE في DB —
 * نفحص التكرار مسبقاً برسالة عربية واضحة، والقيد هو الحارس الأخير.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { categories, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { extractInsertId } from "../lib/insertId";
import { withTx, type Actor } from "./tx";

export interface CategoryAdminRow {
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  showInStore: boolean;
  parentId: number | null;
  productCount: number;
  /** عدد منتجات الفئة نفسها + كل فئاتها الفرعية (للفئات الرئيسية فقط؛ يساوي productCount للفرعية). */
  productCountWithChildren: number;
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
      sortOrder: categories.sortOrder,
      showInStore: categories.showInStore,
      parentId: categories.parentId,
      createdAt: categories.createdAt,
      productCount: sql<number>`COUNT(${products.id})`,
    })
    .from(categories)
    .leftJoin(products, eq(products.categoryId, categories.id))
    .groupBy(categories.id)
    .orderBy(asc(categories.sortOrder), asc(categories.name));

  const mapped = rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    description: r.description ?? null,
    isActive: r.isActive == null ? true : !!r.isActive,
    sortOrder: Number(r.sortOrder ?? 0),
    showInStore: r.showInStore == null ? true : !!r.showInStore,
    parentId: r.parentId != null ? Number(r.parentId) : null,
    productCount: Number(r.productCount ?? 0),
    createdAt: r.createdAt,
  }));

  // شامل الفرعيات: للفئة الرئيسية = مباشرها + Σ مباشر كل فئاتها الفرعية.
  const childSums = new Map<number, number>();
  for (const r of mapped) {
    if (r.parentId != null) childSums.set(r.parentId, (childSums.get(r.parentId) ?? 0) + r.productCount);
  }
  return mapped.map((r) => ({
    ...r,
    productCountWithChildren: r.parentId == null ? r.productCount + (childSums.get(r.id) ?? 0) : r.productCount,
  }));
}

/** إظهار/إخفاء قسمٍ من واجهة المتجر (لوحة hPanel). لا يمسّ المنتجات ولا الـERP. */
export async function setCategoryStoreVisibility(input: { id: number; showInStore: boolean }, _actor: Actor) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const cur = (await db.select({ id: categories.id }).from(categories).where(eq(categories.id, input.id)).limit(1))[0];
  if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "الفئة غير موجودة." });
  await db.update(categories).set({ showInStore: input.showInStore }).where(eq(categories.id, input.id));
  return { id: input.id, showInStore: input.showInStore };
}

/** ترتيب عرض الأقسام في المتجر — يُسنِد sortOrder=الفهرس لكل معرّف بالترتيب المُمرَّر، ذرّياً. */
export async function reorderCategories(input: { orderedIds: number[] }, _actor: Actor) {
  return withTx(async (tx) => {
    for (let i = 0; i < input.orderedIds.length; i++) {
      await tx.update(categories).set({ sortOrder: i }).where(eq(categories.id, input.orderedIds[i]));
    }
    return { count: input.orderedIds.length };
  });
}

export interface ProductForAssign {
  id: number;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
}

/** منتقي منتجات لإسنادها لقسم (بوّابة store، لا تحتاج وحدة products). categoryId=0/null ⇒ «بلا فئة». */
export async function listProductsForAssign(input: { q?: string; categoryId?: number | null; limit?: number }): Promise<ProductForAssign[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(input.limit ?? 100, 500);
  const conds = [];
  if (input.categoryId === 0 || input.categoryId === null) conds.push(isNull(products.categoryId));
  else if (input.categoryId != null) conds.push(eq(products.categoryId, input.categoryId));
  const q = input.q?.trim();
  if (q) conds.push(sql`(${products.name} LIKE ${"%" + q + "%"} OR ${products.searchNorm} LIKE ${"%" + q + "%"})`);
  const rows = await db
    .select({ id: products.id, name: products.name, categoryId: products.categoryId, categoryName: categories.name })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(products.name))
    .limit(limit);
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    categoryId: r.categoryId != null ? Number(r.categoryId) : null,
    categoryName: r.categoryName ?? null,
  }));
}

/** هل للفئة `id` فئات فرعية؟ */
async function hasChildren(exec: any, id: number): Promise<boolean> {
  const row = (
    await exec.select({ n: sql<number>`COUNT(*)` }).from(categories).where(eq(categories.parentId, id))
  )[0];
  return Number(row?.n ?? 0) > 0;
}

/**
 * يتحقّق من صلاحية `parentId` مقترَح لفئة `selfId` (أو فئة جديدة إن كان selfId=null): الأب موجود
 * ومفعَّل بنيوياً كفئة رئيسية (parentId=null له هو)، وليس الفئة نفسها، وليس فئة فرعية بالفعل
 * (يمنع عمقاً > مستويين). لا تُستدعى إن كان parentId=null (ترقية لرئيسية — مسموحة دائماً).
 */
async function assertValidParent(exec: any, parentId: number, selfId: number | null) {
  if (selfId != null && parentId === selfId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن أن تكون الفئة أباً لنفسها." });
  }
  const parent = (
    await exec.select({ id: categories.id, parentId: categories.parentId }).from(categories).where(eq(categories.id, parentId)).limit(1)
  )[0];
  if (!parent) throw new TRPCError({ code: "BAD_REQUEST", message: "الفئة الرئيسية المحدَّدة غير موجودة." });
  if (parent.parentId != null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إنشاء فئة فرعية تحت فئة فرعية أخرى (الحدّ الأقصى مستويان)." });
  }
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

export async function createCategory(
  input: { name: string; description?: string | null; parentId?: number | null },
  _actor: Actor,
) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const name = input.name.trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الفئة مطلوب." });
  await assertNameFree(name);
  if (input.parentId != null) await assertValidParent(db, input.parentId, null);
  const res = await db.insert(categories).values({ name, description: input.description?.trim() || null, parentId: input.parentId ?? null });
  return { id: extractInsertId(res), name };
}

export async function updateCategory(
  input: { id: number; name?: string; description?: string | null; isActive?: boolean; parentId?: number | null },
  _actor: Actor,
) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const cur = (await db.select().from(categories).where(eq(categories.id, input.id)).limit(1))[0];
  if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "الفئة غير موجودة." });

  const patch: { name?: string; description?: string | null; isActive?: boolean; parentId?: number | null } = {};
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

  if (input.parentId !== undefined) {
    const nextParentId = input.parentId;
    if (nextParentId !== (cur.parentId ?? null)) {
      if (nextParentId == null) {
        // ترقية لفئة رئيسية: مسموحة دائماً (حتى لو كانت تحوي فرعيات هي نفسها — تبقى فرعياتها كما هي).
      } else {
        await assertValidParent(db, nextParentId, input.id);
        if (await hasChildren(db, input.id)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن جعل فئة تحوي فئات فرعية، فئةً فرعيةً لأخرى. انقل/احذف فرعياتها أولاً." });
        }
      }
      patch.parentId = nextParentId;
    }
  }

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
    if (await hasChildren(tx, input.id)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "هذه الفئة تحوي فئات فرعية. احذفها أو انقلها أولاً." });
    }

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

    // فئة مصدر تحوي فرعيات ستُحذف ⇒ فرعياتها تصبح يتيمة (parentId يشير لفئة محذوفة). امنع
    // ذلك: الدمج مقصور على فئات بلا فرعيات (انقل/ادمج الفرعيات أولاً).
    const sourcesWithChildren = (
      await tx
        .select({ parentId: categories.parentId })
        .from(categories)
        .where(inArray(categories.parentId, sources))
        .groupBy(categories.parentId)
    ).map((r) => Number(r.parentId));
    if (sourcesWithChildren.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن دمج فئة تحوي فئات فرعية. انقل أو ادمج فرعياتها أولاً." });
    }

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
