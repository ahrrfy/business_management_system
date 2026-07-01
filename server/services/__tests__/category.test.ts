/**
 * اختبارات categoryService (فئات المنتجات: إنشاء/تعديل/حذف مع إعادة تخصيص/دمج/نقل جماعي) —
 * فجوة موثَّقة: عمليات ذرّية (withTx) تُعيد تخصيص products.categoryId قبل الحذف، بصفر تغطية.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createCategory,
  deleteCategory,
  listCategoriesAdmin,
  mergeCategories,
  reassignProducts,
  updateCategory,
} from "../categoryService";

const actor = { userId: 1, branchId: 1 };

const TABLES = ["products", "categories"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.categories).values([
    { id: 1, name: "قرطاسية", description: "أدوات مكتبية" },
    { id: 2, name: "هدايا" },
    { id: 3, name: "فئة معطّلة", isActive: false },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "دفتر", categoryId: 1 },
    { id: 2, name: "قلم", categoryId: 1 },
    { id: 3, name: "كرت هدية", categoryId: 2 },
    { id: 4, name: "منتج معطّل", categoryId: 1, isActive: false },
    { id: 5, name: "بلا فئة", categoryId: null },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

async function productCategoryIds(): Promise<Record<number, number | null>> {
  const rows = await db().select({ id: s.products.id, categoryId: s.products.categoryId }).from(s.products);
  const map: Record<number, number | null> = {};
  for (const r of rows) map[Number(r.id)] = r.categoryId == null ? null : Number(r.categoryId);
  return map;
}

describe("listCategoriesAdmin", () => {
  it("يحسب عدد المنتجات لكل فئة بما فيها المعطّلة، ويرتّب بالاسم", async () => {
    const rows = await listCategoriesAdmin();
    expect(rows).toHaveLength(3);
    const stationery = rows.find((r) => r.id === 1)!;
    expect(stationery.productCount).toBe(3); // دفتر+قلم+منتج معطّل (كلها تُحسَب)
    const gifts = rows.find((r) => r.id === 2)!;
    expect(gifts.productCount).toBe(1);
    const disabledCat = rows.find((r) => r.id === 3)!;
    expect(disabledCat.productCount).toBe(0);
    expect(disabledCat.isActive).toBe(false);
  });
});

describe("createCategory", () => {
  it("مسار سعيد: يُنشئ فئة جديدة", async () => {
    const r = await createCategory({ name: "أدوات مدرسية", description: "قسم جديد" }, actor);
    expect(r.name).toBe("أدوات مدرسية");
    const row = (await db().select().from(s.categories).where(eq(s.categories.id, r.id)))[0];
    expect(row.description).toBe("قسم جديد");
  });

  it("رفض: اسم فارغ ⇒ BAD_REQUEST", async () => {
    await expect(createCategory({ name: "   " }, actor)).rejects.toThrow(/اسم الفئة مطلوب/);
  });

  it("رفض: اسم مكرّر (بالحرف) ⇒ CONFLICT", async () => {
    await expect(createCategory({ name: "قرطاسية" }, actor)).rejects.toThrow(/موجودة مسبقاً/);
  });

  it("رفض: اسم مكرّر بحالة أحرف مختلفة (ترتيب _ci) ⇒ CONFLICT", async () => {
    await createCategory({ name: "Office" }, actor);
    await expect(createCategory({ name: "OFFICE" }, actor)).rejects.toThrow(/موجودة مسبقاً/);
  });
});

describe("updateCategory", () => {
  it("تحديث جزئي: يغيّر الوصف فقط ويُبقي الاسم والحالة", async () => {
    const r = await updateCategory({ id: 1, description: "وصف جديد" }, actor);
    expect(r.id).toBe(1);
    const row = (await db().select().from(s.categories).where(eq(s.categories.id, 1)))[0];
    expect(row.name).toBe("قرطاسية");
    expect(row.description).toBe("وصف جديد");
  });

  it("إعادة تسمية لنفس الاسم لا تُطلق فحص التعارض", async () => {
    await expect(updateCategory({ id: 1, name: "قرطاسية" }, actor)).resolves.toEqual({ id: 1 });
  });

  it("تعطيل فئة (isActive:false) يُحفَظ", async () => {
    await updateCategory({ id: 2, isActive: false }, actor);
    const row = (await db().select().from(s.categories).where(eq(s.categories.id, 2)))[0];
    expect(row.isActive).toBe(false);
  });

  it("رفض: إعادة تسمية إلى اسم فئة أخرى موجودة ⇒ CONFLICT", async () => {
    await expect(updateCategory({ id: 1, name: "هدايا" }, actor)).rejects.toThrow(/موجودة مسبقاً/);
  });

  it("رفض: إعادة تسمية إلى اسم فارغ ⇒ BAD_REQUEST", async () => {
    await expect(updateCategory({ id: 1, name: "   " }, actor)).rejects.toThrow(/اسم الفئة مطلوب/);
  });

  it("رفض: فئة غير موجودة ⇒ NOT_FOUND", async () => {
    await expect(updateCategory({ id: 999999, name: "أياً كان" }, actor)).rejects.toThrow(/الفئة غير موجودة/);
  });
});

describe("deleteCategory", () => {
  it("حذف مع إعادة تخصيص: منتجات الفئة المحذوفة تنتقل للهدف ذرّياً", async () => {
    const r = await deleteCategory({ id: 1, reassignToId: 2 }, actor);
    expect(r.reassigned).toBe(3); // دفتر+قلم+منتج معطّل
    expect(r.reassignedTo).toBe(2);

    const cats = await db().select().from(s.categories).where(eq(s.categories.id, 1));
    expect(cats).toHaveLength(0);

    const ids = await productCategoryIds();
    expect(ids[1]).toBe(2);
    expect(ids[2]).toBe(2);
    expect(ids[4]).toBe(2);
    expect(ids[3]).toBe(2); // كان أصلاً في فئة ٢، يبقى كما هو
  });

  it("حذف بلا إعادة تخصيص: منتجاتها تصبح بلا فئة (NULL)", async () => {
    await deleteCategory({ id: 1 }, actor);
    const ids = await productCategoryIds();
    expect(ids[1]).toBeNull();
    expect(ids[2]).toBeNull();
    expect(ids[4]).toBeNull();
  });

  it("رفض: النقل إلى الفئة نفسها المراد حذفها ⇒ BAD_REQUEST، ولا شيء يتغيّر", async () => {
    await expect(deleteCategory({ id: 1, reassignToId: 1 }, actor)).rejects.toThrow(/الفئة نفسها المراد حذفها/);
    const cats = await db().select().from(s.categories).where(eq(s.categories.id, 1));
    expect(cats).toHaveLength(1); // لم تُحذَف (rollback)
  });

  it("رفض: الفئة الهدف للنقل غير موجودة ⇒ BAD_REQUEST، ولا شيء يتغيّر (rollback)", async () => {
    await expect(deleteCategory({ id: 1, reassignToId: 999999 }, actor)).rejects.toThrow(/الفئة الهدف للنقل غير موجودة/);
    const cats = await db().select().from(s.categories).where(eq(s.categories.id, 1));
    expect(cats).toHaveLength(1);
    const ids = await productCategoryIds();
    expect(ids[1]).toBe(1); // لم يُعَد تخصيصه
  });

  it("رفض: فئة غير موجودة ⇒ NOT_FOUND", async () => {
    await expect(deleteCategory({ id: 999999 }, actor)).rejects.toThrow(/الفئة غير موجودة/);
  });
});

describe("mergeCategories", () => {
  it("دمج فئتين مصدر في هدف: نقل كل منتجاتهما ثم حذف المصدرين", async () => {
    const r = await mergeCategories({ sourceIds: [1, 3], targetId: 2 }, actor);
    expect(r.moved).toBe(3); // منتجات الفئة ١ فقط (الفئة ٣ بلا منتجات)
    expect(r.deleted).toBe(2);
    expect(r.targetId).toBe(2);

    const remaining = await db().select({ id: s.categories.id }).from(s.categories);
    expect(remaining.map((c) => c.id).sort()).toEqual([2]);

    const ids = await productCategoryIds();
    expect(ids[1]).toBe(2);
    expect(ids[2]).toBe(2);
    expect(ids[4]).toBe(2);
    expect(ids[3]).toBe(2); // كان في ٢ أصلاً
  });

  it("الهدف يُستبعَد تلقائياً من قائمة المصادر (دمج ذاتي آمن بلا أثر)", async () => {
    const r = await mergeCategories({ sourceIds: [1, 2], targetId: 2 }, actor);
    expect(r.deleted).toBe(1); // فقط الفئة ١ حُذفت، الفئة ٢ (الهدف) استُبعِدت من المصادر
    const remaining = await db().select({ id: s.categories.id }).from(s.categories);
    expect(remaining.map((c) => c.id).sort()).toEqual([2, 3]);
  });

  it("مصادر فارغة بعد استبعاد الهدف ⇒ لا شيء يتغيّر (moved=0, deleted=0)", async () => {
    const r = await mergeCategories({ sourceIds: [2], targetId: 2 }, actor);
    expect(r).toEqual({ moved: 0, deleted: 0, targetId: 2 });
    const remaining = await db().select({ id: s.categories.id }).from(s.categories);
    expect(remaining).toHaveLength(3); // لم تُحذف أي فئة
  });

  it("رفض: الفئة الهدف غير موجودة ⇒ NOT_FOUND", async () => {
    await expect(mergeCategories({ sourceIds: [1], targetId: 999999 }, actor)).rejects.toThrow(/الفئة الهدف غير موجودة/);
  });
});

describe("reassignProducts", () => {
  it("نقل منتجات محدّدة إلى فئة أخرى", async () => {
    const r = await reassignProducts({ productIds: [1, 2], categoryId: 2 }, actor);
    expect(r.moved).toBe(2);
    const ids = await productCategoryIds();
    expect(ids[1]).toBe(2);
    expect(ids[2]).toBe(2);
    expect(ids[4]).toBe(1); // لم يُذكَر ⇒ يبقى كما هو
  });

  it("categoryId=null ⇒ يُصبح المنتج بلا فئة", async () => {
    await reassignProducts({ productIds: [1], categoryId: null }, actor);
    const ids = await productCategoryIds();
    expect(ids[1]).toBeNull();
  });

  it("يُصفّي المعرّفات غير الصالحة (سالب/صفر) قبل العدّ", async () => {
    const r = await reassignProducts({ productIds: [1, -5, 0, 1], categoryId: 2 }, actor);
    expect(r.moved).toBe(1); // معرّف صالح وحيد بعد إزالة التكرار والقيم غير الصالحة
  });

  it("مصفوفة فارغة بعد التصفية ⇒ moved=0 بلا أي تغيير", async () => {
    const r = await reassignProducts({ productIds: [-1, 0], categoryId: 2 }, actor);
    expect(r.moved).toBe(0);
    const ids = await productCategoryIds();
    expect(ids[1]).toBe(1); // بلا تغيير
  });

  it("رفض: فئة هدف غير موجودة ⇒ BAD_REQUEST، ولا شيء يتغيّر", async () => {
    await expect(reassignProducts({ productIds: [1], categoryId: 999999 }, actor)).rejects.toThrow(/الفئة الهدف غير موجودة/);
    const ids = await productCategoryIds();
    expect(ids[1]).toBe(1);
  });
});
