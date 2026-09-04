/**
 * expenseCategoryService — إدارة فئات المصروفات المُدارة (جدول `expenseCategories`، هجرة 0203).
 *
 * العقد الحاكم: **الفئة تُصنِّف، والدلو يُحاسِب.** كل فئة تُعلن دلوها (`bucket`) وهو نفسه اتّحاد
 * `expenses.expenseCategory`، فيكتب المصروفُ الفئةَ ودلوَها معاً. من ذلك تتبع ثلاث قواعد صارمة:
 *
 *  ١) **لا يتغيّر دلو فئةٍ ارتبطت بمصروف** — تغييره يُعيد تصنيف تاريخٍ محاسبيّ صامتاً (المصروف
 *     المُرحَّل سيبقى في حسابه القديم بينما تقول الفئة غير ذلك) ⇒ انحرافٌ بين التصنيف والدفتر.
 *     البديل المعلَن: أنشئ فئة جديدة بالدلو الصحيح.
 *  ٢) **لا حذف** — تعطيلٌ فقط، كي تحتفظ المصروفات التاريخية بتصنيفها (وقيد FK يجعلها حقيقةً في
 *     القاعدة لا اتفاقاً في الكود).
 *  ٣) **فئة الدلو الاحتياطية لا تُعطَّل** — هي مهبط أي طلبٍ قديم يحمل الدلو وحده (أندرويد/أوفلاين/
 *     استيراد)؛ تعطيلها يترك مصروفاً بلا فئةٍ مُدارة.
 */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { expenseCategories, expenses } from "../../drizzle/schema";
import {
  DEFAULT_EXPENSE_CATEGORIES,
  isExpenseBucket,
  type DefaultExpenseCategory,
  type ExpenseBucket,
} from "../../shared/expenseCategories";
import { getDb, type Tx } from "../db";
import { extractAffectedRows, extractInsertId } from "../lib/insertId";
import { withTx, type Actor } from "./tx";

export interface ExpenseCategoryListRow {
  id: number;
  name: string;
  bucket: ExpenseBucket;
  description: string | null;
  isActive: boolean;
  isBucketDefault: boolean;
  sortOrder: number;
  /** عدد المصروفات المرتبطة — يُظهر للمستخدم لماذا قد يُمنع تغيير الدلو. */
  usedExpenseCount: number;
}

/** مطابقة الاسم كما في DB (UNIQUE بترتيب غير حسّاس للحالة). */
function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase("ar");
}

export async function listExpenseCategories(input?: {
  includeInactive?: boolean;
}): Promise<ExpenseCategoryListRow[]> {
  const db = getDb();
  if (!db) return [];
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(expenseCategories)
      .where(
        input?.includeInactive
          ? undefined
          : eq(expenseCategories.isActive, true),
      )
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id)),
    db
      .select({
        categoryId: expenses.expenseCategoryId,
        count: sql<number>`COUNT(*)`,
      })
      .from(expenses)
      .where(sql`${expenses.expenseCategoryId} IS NOT NULL`)
      .groupBy(expenses.expenseCategoryId),
  ]);
  const countById = new Map(
    counts.map((row) => [Number(row.categoryId), Number(row.count ?? 0)]),
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    bucket: row.bucket as ExpenseBucket,
    description: row.description ?? null,
    isActive: !!row.isActive,
    isBucketDefault: !!row.isBucketDefault,
    sortOrder: Number(row.sortOrder ?? 0),
    usedExpenseCount: countById.get(Number(row.id)) ?? 0,
  }));
}

async function assertNameFree(tx: Tx, name: string, excludeId?: number) {
  const clash = (
    await tx
      .select({ id: expenseCategories.id })
      .from(expenseCategories)
      .where(eq(expenseCategories.name, name))
      .limit(1)
  )[0];
  if (clash && Number(clash.id) !== excludeId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "لا يمكن استعمال هذا الاسم للفئة",
        why: `الفئة «${name}» موجودة مسبقاً في الكتالوج (قد تكون معطَّلة) — الأسماء المكرّرة تُنتج تصنيفَين لنفس المصروف`,
        doThis: "افتح شاشة فئات المصروف وفعّل الفئة الحالية، أو اختر اسماً مميزاً لفئتك الجديدة",
      }),
    });
  }
}

async function countExpensesUsing(tx: Tx, categoryId: number): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(expenses)
    .where(eq(expenses.expenseCategoryId, categoryId));
  return Number(row?.n ?? 0);
}

export async function createExpenseCategory(
  input: {
    name: string;
    bucket: ExpenseBucket;
    description?: string | null;
    sortOrder?: number;
  },
  _actor: Actor,
) {
  return withTx(async (tx) => {
    const name = input.name.trim();
    if (!name)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "اسم الفئة مطلوب",
          why: "حقل «اسم الفئة» فارغ — لا يمكن إنشاء فئة مصروف بلا اسم مميّز",
          doThis: "أدخل اسماً واضحاً للفئة (كهرباء/إيجار/…) ثم أعد الحفظ",
        }),
      });
    if (!isExpenseBucket(input.bucket)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "قيمة الدلو المحاسبي غير مقبولة",
          why: "الدلو المرسل لا يتطابق مع أيّ من التصنيفات المعروفة (SUPPLIES/RENT/UTILITIES/…)",
          doThis: "اختر دلواً محاسبياً من القائمة المنسدلة (لا تكتبه يدوياً)",
        }),
      });
    }
    await assertNameFree(tx, name);
    const id = extractInsertId(
      await tx.insert(expenseCategories).values({
        name,
        bucket: input.bucket,
        description: input.description?.trim() || null,
        sortOrder: input.sortOrder ?? 500,
        isActive: true,
        // الاحتياطية تضبطها الهجرة وحدها — الإنشاء من الواجهة لا يُنتج احتياطيةً ثانية للدلو.
        isBucketDefault: false,
      }),
    );
    return { id, name, bucket: input.bucket, isActive: true };
  });
}

export async function updateExpenseCategory(
  input: {
    id: number;
    name?: string;
    bucket?: ExpenseBucket;
    description?: string | null;
    sortOrder?: number;
  },
  _actor: Actor,
) {
  return withTx(async (tx) => {
    const [current] = await tx
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.id, input.id))
      .for("update")
      .limit(1);
    if (!current)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر العثور على فئة المصروف",
          why: "معرّف الفئة المرسل يشير إلى فئة محذوفة أو غير موجودة",
          doThis: "أعد تحميل قائمة فئات المصروف واختر فئة موجودة، أو أنشئها من شاشة الفئات",
        }),
      });

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "اسم الفئة مطلوب.",
        });
      if (name !== current.name) {
        await assertNameFree(tx, name, input.id);
        patch.name = name;
      }
    }
    if (input.bucket !== undefined && input.bucket !== current.bucket) {
      if (!isExpenseBucket(input.bucket)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الدلو المحاسبي غير معروف.",
        });
      }
      if (current.isBucketDefault) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "لا يمكن تغيير دلو هذه الفئة",
            why: "الفئة احتياطية (isBucketDefault) — تستقبل الطلبات التي تحمل الدلو وحده (أوفلاين/أندرويد/استيراد)، ونقلها يفسد مسار تلك الطلبات",
            doThis: "أنشئ فئة جديدة بالدلو المستهدف من شاشة فئات المصروف بدل نقل الاحتياطية",
          }),
        });
      }
      if (await countExpensesUsing(tx, input.id)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "لا يمكن تغيير الدلو المحاسبي لفئة مرتبطة بمصروفات",
            why: "الفئة مستعمَلة على مصروفات مُرحَّلة سلفاً — تغيير الدلو يعيد تصنيف تاريخٍ محاسبيّ ويشوّه تقارير الفترات المغلقة",
            doThis: "أنشئ فئة جديدة بالدلو الصحيح من شاشة فئات المصروف، ثم استخدمها للطلبات الجديدة",
          }),
        });
      }
      patch.bucket = input.bucket;
    }
    if (input.description !== undefined)
      patch.description = input.description?.trim() || null;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;

    if (Object.keys(patch).length) {
      await tx
        .update(expenseCategories)
        .set(patch)
        .where(eq(expenseCategories.id, input.id));
    }
    return { id: input.id, changed: Object.keys(patch) };
  });
}

export async function setExpenseCategoryActive(
  input: { id: number; isActive: boolean },
  _actor: Actor,
) {
  return withTx(async (tx) => {
    const [current] = await tx
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.id, input.id))
      .for("update")
      .limit(1);
    if (!current)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر العثور على فئة المصروف",
          why: "معرّف الفئة المرسل يشير إلى فئة محذوفة أو غير موجودة",
          doThis: "أعد تحميل قائمة فئات المصروف واختر فئة موجودة، أو أنشئها من شاشة الفئات",
        }),
      });
    if (!input.isActive && current.isBucketDefault) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا تُعطَّل فئة الدلو الاحتياطية",
          why: "الفئة احتياطية (isBucketDefault) — إليها تهبط الطلبات التي تحمل الدلو وحده (أوفلاين/أندرويد/استيراد)، وتعطيلها يكسر مسار تلك الطلبات",
          doThis: "أنشئ فئة احتياطية بديلة قبل التعطيل، أو أبقِ هذه فعّالة",
        }),
      });
    }
    await tx
      .update(expenseCategories)
      .set({ isActive: input.isActive })
      .where(eq(expenseCategories.id, input.id));
    return { id: input.id, isActive: input.isActive };
  });
}

export interface EnsureDefaultExpenseCategoriesResult {
  inserted: string[];
  /** فئات كتالوجٍ موجودة باسمها لكن بدلوٍ مختلف — تُترك لقرار الإدارة ويُبلَّغ عنها. */
  bucketMismatch: string[];
  /** دلاء استعادت فئتها الاحتياطية (كانت مفقودة/معطّلة). */
  defaultsRepaired: ExpenseBucket[];
  total: number;
}

/**
 * يضمن وجود الكتالوج كاملاً + فئةً احتياطيةً **مفعَّلة** لكل دلو. idempotent: لا يُكرّر، ولا
 * يُعدّل اسماً/دلواً/ترتيباً قائماً، ولا يُعيد تفعيل فئةٍ عادية عطّلها المالك — يستثني الاحتياطية
 * وحدها لأنّ تعطيلها يكسر مسار الطلبات القديمة.
 */
export async function ensureDefaultExpenseCategoriesInTx(
  tx: Tx,
): Promise<EnsureDefaultExpenseCategoriesResult> {
  const existing = await tx
    .select({
      id: expenseCategories.id,
      name: expenseCategories.name,
      bucket: expenseCategories.bucket,
      isActive: expenseCategories.isActive,
      isBucketDefault: expenseCategories.isBucketDefault,
    })
    .from(expenseCategories)
    .for("update");
  const byName = new Map(existing.map((row) => [nameKey(row.name), row]));

  const result: EnsureDefaultExpenseCategoriesResult = {
    inserted: [],
    bucketMismatch: [],
    defaultsRepaired: [],
    total: 0,
  };
  const missing: DefaultExpenseCategory[] = [];
  for (const def of DEFAULT_EXPENSE_CATEGORIES) {
    const current = byName.get(nameKey(def.name));
    if (!current) {
      missing.push(def);
      continue;
    }
    result.total += 1;
    if (current.bucket !== def.bucket) result.bucketMismatch.push(def.name);
  }

  if (missing.length) {
    await tx.insert(expenseCategories).values(
      missing.map((def) => ({
        name: def.name,
        bucket: def.bucket,
        description: def.description,
        sortOrder: def.sortOrder,
        isActive: true,
        isBucketDefault: def.isBucketDefault === true,
      })),
    );
    result.inserted = missing.map((def) => def.name);
    result.total += missing.length;
  }

  // ترميم الاحتياطية: كل دلوٍ يجب أن يملك واحدةً مفعَّلة، وإلّا سقط حلّ الفئة للطلبات القديمة.
  for (const def of DEFAULT_EXPENSE_CATEGORIES) {
    if (def.isBucketDefault !== true) continue;
    const [row] = await tx
      .select({
        id: expenseCategories.id,
        isActive: expenseCategories.isActive,
        isBucketDefault: expenseCategories.isBucketDefault,
      })
      .from(expenseCategories)
      .where(eq(expenseCategories.name, def.name))
      .limit(1);
    if (!row) continue;
    if (row.isActive && row.isBucketDefault) continue;
    await tx
      .update(expenseCategories)
      .set({ isActive: true, isBucketDefault: true })
      .where(eq(expenseCategories.id, Number(row.id)));
    result.defaultsRepaired.push(def.bucket);
  }

  return result;
}

export async function ensureDefaultExpenseCategories(): Promise<EnsureDefaultExpenseCategoriesResult> {
  return withTx((tx) => ensureDefaultExpenseCategoriesInTx(tx));
}

/**
 * يحلّ فئةَ المصروف ودلوَه من مُدخل الطلب — **نقطة الحقيقة الوحيدة** التي تربط التصنيف بالمحاسبة.
 *
 *  • مرّر `expenseCategoryId` (المسار الحديث): تُتحقّق الفئة وتكون فعّالة، ويُشتقّ الدلو منها.
 *    الدلو المُمرَّر من العميل (إن وُجد) يُتجاهَل عمداً — الفئة هي الحاكمة فلا ينحرفان.
 *  • مرّر الدلو وحده (المسار القديم: أندرويد/أوفلاين/استيراد): يُقبل كما هو، ويُسنَد المصروف
 *    إلى فئة الدلو الاحتياطية فلا يبقى بلا تصنيف مُدار.
 *  • قاعدةٌ لم تُهاجَر بعد (جدولٌ فارغ): يُقبل الدلو ويعود `expenseCategoryId = null` بلا فشل —
 *    المصروف يُسجَّل كما كان قبل هذه الشريحة تماماً. لا نُعطّل تسجيل مصروفٍ لأجل تصنيف.
 */
export async function resolveExpenseCategory(
  tx: Tx,
  input: { expenseCategoryId?: number | null; bucket: ExpenseBucket },
): Promise<{ expenseCategoryId: number | null; bucket: ExpenseBucket }> {
  if (input.expenseCategoryId != null) {
    const [row] = await tx
      .select({
        id: expenseCategories.id,
        bucket: expenseCategories.bucket,
        isActive: expenseCategories.isActive,
        name: expenseCategories.name,
      })
      .from(expenseCategories)
      .where(eq(expenseCategories.id, input.expenseCategoryId))
      .limit(1);
    if (!row) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر العثور على فئة المصروف",
          why: "معرّف الفئة المرسل يشير إلى فئة محذوفة أو غير موجودة",
          doThis: "أعد تحميل قائمة فئات المصروف واختر فئة موجودة، أو أنشئها من شاشة الفئات",
        }),
      });
    }
    if (!row.isActive) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن استعمال هذه الفئة",
          why: `فئة «${row.name}» معطَّلة (isActive=false) — لا يجوز فتح مصروفات جديدة على تصنيف مغلق`,
          doThis: "اختر فئة فعّالة أخرى من قائمة الفئات، أو فعّل هذه الفئة من شاشة إدارة الفئات",
        }),
      });
    }
    return {
      expenseCategoryId: Number(row.id),
      bucket: row.bucket as ExpenseBucket,
    };
  }

  const [fallback] = await tx
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(
      and(
        eq(expenseCategories.bucket, input.bucket),
        eq(expenseCategories.isBucketDefault, true),
        eq(expenseCategories.isActive, true),
      ),
    )
    .orderBy(asc(expenseCategories.id))
    .limit(1);
  return {
    expenseCategoryId: fallback ? Number(fallback.id) : null,
    bucket: input.bucket,
  };
}

/** عدد المصروفات التي ما تزال بلا فئةٍ مُدارة — يُظهره زرّ المعالجة في الشاشة. */
export async function countUnclassifiedExpenses(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(expenses)
    .where(isNull(expenses.expenseCategoryId));
  return Number(row?.n ?? 0);
}

/**
 * ردمٌ رجعيّ تشغيليّ لما بقي بلا فئة مُدارة (سجلّات كُتبت قبل الهجرة، أو قاعدةٌ بُنيت بـ`db:push`
 * ثم شُغِّلت). يُسنِد كل مصروف إلى فئة دلوه الاحتياطية — **الدلو نفسه لا يُمَسّ** فلا يتحرّك
 * حسابٌ ولا تقرير؛ إثراءُ تصنيفٍ لا إعادةُ تصنيف.
 */
export async function backfillExpenseCategories(): Promise<{
  updated: number;
}> {
  return withTx(async (tx) => {
    await ensureDefaultExpenseCategoriesInTx(tx);
    const defaults = await tx
      .select({ id: expenseCategories.id, bucket: expenseCategories.bucket })
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.isBucketDefault, true),
          eq(expenseCategories.isActive, true),
        ),
      );
    let updated = 0;
    for (const def of defaults) {
      const res = await tx
        .update(expenses)
        .set({ expenseCategoryId: Number(def.id) })
        .where(
          and(
            isNull(expenses.expenseCategoryId),
            eq(expenses.category, def.bucket as ExpenseBucket),
          ),
        );
      updated += extractAffectedRows(res);
    }
    return { updated };
  });
}
