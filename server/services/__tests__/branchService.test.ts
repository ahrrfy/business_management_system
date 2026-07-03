/**
 * اختبارات branchService (CRUD الفروع) — تغطي إنشاء/تعديل/تعطيل، وشرطَي حراسة التعطيل:
 * منع تصفير الفروع النشطة إلى صفر، ومنع تعطيل فرع لا يزال يحمل مخزوناً فعلياً.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createBranch, listBranchesAdmin, setBranchActive, updateBranch } from "../branchService";

const actor = { userId: 1, branchId: 1 };

const TABLES = ["branchStock", "productVariants", "products", "branches"];

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
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("listBranchesAdmin", () => {
  it("يُرجع كل الفروع (نشطة+معطّلة) مرتّبة بالمعرّف", async () => {
    await db().update(s.branches).set({ isActive: false }).where(eq(s.branches.id, 2));
    const rows = await listBranchesAdmin();
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(1);
    expect(rows[1].isActive).toBe(false);
  });
});

describe("createBranch", () => {
  it("مسار سعيد: يُنشئ فرعاً جديداً ويُطبّع الرمز لحروف كبيرة", async () => {
    const r = await createBranch({ name: "فرع الكرادة", code: "sales-2", type: "SALES" }, actor);
    expect(r.code).toBe("SALES-2");
    const row = (await db().select().from(s.branches).where(eq(s.branches.id, r.id)))[0];
    expect(row.name).toBe("فرع الكرادة");
    expect(row.isActive).toBe(true);
  });

  it("رفض: اسم فارغ ⇒ BAD_REQUEST", async () => {
    await expect(createBranch({ name: "   ", code: "X1", type: "SALES" }, actor)).rejects.toThrow(/اسم الفرع مطلوب/);
  });

  it("رفض: رمز بصيغة غير صالحة (عربي/مسافات) ⇒ BAD_REQUEST", async () => {
    await expect(createBranch({ name: "فرع", code: "فرع جديد", type: "SALES" }, actor)).rejects.toThrow(/رمز الفرع/);
  });

  it("رفض: رمز مكرّر (حتى بحالة أحرف مختلفة) ⇒ CONFLICT", async () => {
    await expect(createBranch({ name: "فرع آخر", code: "main", type: "SALES" }, actor)).rejects.toThrow(/مستخدَم مسبقاً/);
  });
});

describe("updateBranch", () => {
  it("تحديث جزئي: يغيّر الهاتف فقط ويُبقي الباقي", async () => {
    const r = await updateBranch({ id: 2, phone: "07701234567" }, actor);
    expect(r.id).toBe(2);
    const row = (await db().select().from(s.branches).where(eq(s.branches.id, 2)))[0];
    expect(row.name).toBe("فرع المبيعات");
    expect(row.phone).toBe("07701234567");
  });

  it("إعادة تسمية الرمز لنفس القيمة لا تُطلق فحص التعارض", async () => {
    await expect(updateBranch({ id: 1, code: "MAIN" }, actor)).resolves.toEqual({ id: 1 });
  });

  it("رفض: تغيير الرمز إلى رمز فرع آخر موجود ⇒ CONFLICT", async () => {
    await expect(updateBranch({ id: 1, code: "SALES" }, actor)).rejects.toThrow(/مستخدَم مسبقاً/);
  });

  it("رفض: فرع غير موجود ⇒ NOT_FOUND", async () => {
    await expect(updateBranch({ id: 999999, name: "أياً كان" }, actor)).rejects.toThrow(/الفرع غير موجود/);
  });
});

describe("setBranchActive", () => {
  it("تعطيل فرع نشط (وله فرع آخر نشط، بلا مخزون) ينجح", async () => {
    const r = await setBranchActive(2, false, actor);
    expect(r).toEqual({ id: 2, isActive: false });
    const row = (await db().select().from(s.branches).where(eq(s.branches.id, 2)))[0];
    expect(row.isActive).toBe(false);
  });

  it("تفعيل فرع معطّل ينجح", async () => {
    await setBranchActive(2, false, actor);
    const r = await setBranchActive(2, true, actor);
    expect(r).toEqual({ id: 2, isActive: true });
  });

  it("نفس الحالة الحالية ⇒ عملية بلا أثر (idempotent)", async () => {
    const r = await setBranchActive(1, true, actor);
    expect(r).toEqual({ id: 1, isActive: true });
  });

  it("رفض: تعطيل آخر فرع نشط ⇒ BAD_REQUEST", async () => {
    await setBranchActive(2, false, actor);
    await expect(setBranchActive(1, false, actor)).rejects.toThrow(/آخر فرع نشط/);
  });

  it("رفض: تعطيل فرع لا يزال يحمل مخزوناً ⇒ BAD_REQUEST، بلا تغيير", async () => {
    await db().insert(s.products).values({ id: 1, name: "دفتر" });
    await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "SKU-1", costPrice: "1000" });
    await db().insert(s.branchStock).values({ id: 1, variantId: 1, branchId: 2, quantity: 5 });

    await expect(setBranchActive(2, false, actor)).rejects.toThrow(/لا يزال يحمل مخزوناً/);
    const row = (await db().select().from(s.branches).where(eq(s.branches.id, 2)))[0];
    expect(row.isActive).toBe(true); // لم يتغيّر (rollback)
  });

  it("مخزون صفري (كمية 0) لا يمنع التعطيل", async () => {
    await db().insert(s.products).values({ id: 1, name: "دفتر" });
    await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "SKU-1", costPrice: "1000" });
    await db().insert(s.branchStock).values({ id: 1, variantId: 1, branchId: 2, quantity: 0 });

    const r = await setBranchActive(2, false, actor);
    expect(r.isActive).toBe(false);
  });

  it("رفض: فرع غير موجود ⇒ NOT_FOUND", async () => {
    await expect(setBranchActive(999999, false, actor)).rejects.toThrow(/الفرع غير موجود/);
  });
});
