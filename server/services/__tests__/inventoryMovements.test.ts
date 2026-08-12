import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { todayUtcDate } from "../businessDay";

/**
 * اختبارات شريحة «حركات المخزون اليدوية» — تغطّي:
 *  (أ) IN يدوي يزيد الرصيد ويسجّل referenceType="MANUAL_IN".
 *  (ب) OUT يدوي يخصم؛ يُرفض عند نقص المخزون.
 *  (ج) RETURN يدوي يزيد المخزون + referenceType="MANUAL_RETURN".
 *  (د) movementsRich يفلتر بالنوع والتاريخ والفرع.
 *  (هـ) warehouse role لا يستطيع إنشاء حركة في فرع غير فرعه (يُجبَر على فرعه).
 */

const TABLES = [
  "auditLogs",
  "inventoryMovements",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "users",
  "branches",
];

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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@m.test", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_wh1", name: "مخزن ف١", email: "wh1@m.test", role: "warehouse", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_wh2", name: "مخزن ف٢", email: "wh2@m.test", role: "warehouse", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "ورق A4" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAPER-A4", variantName: "عادي", costPrice: "5.00" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 20 },
    { variantId: 1, branchId: 2, quantity: 5 },
  ]);
}

function makeCtx(user: any) {
  const res = { cookie() {}, clearCookie() {} };
  const req = { headers: {} as Record<string, string> };
  return { req, res, user } as any;
}

async function userRow(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

async function stockOf(variantId: number, branchId: number): Promise<number> {
  const r = await db()
    .select({ q: s.branchStock.quantity })
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)))
    .limit(1);
  return r[0]?.q ?? 0;
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("inventory.createManualMovement", () => {
  it("يرفض IN اليدوي حتى للأدمن لأنه بلا مستند مصدر", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1))); // admin
    await expect(caller.inventory.createManualMovement({
      variantId: 1, branchId: 1, movementType: "IN", productUnitId: 1,
      quantity: "5", reason: "STOCK_TAKE", notes: "جرد افتتاحي",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stockOf(1, 1)).toBe(20);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  });

  it("(ب) OUT (شطب) يُرفَض على الحركة اليدوية — يُوجَّه لتسوية معتمَدة (فصل مهام #٦)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    await expect(
      caller.inventory.createManualMovement({
        variantId: 1, branchId: 1, movementType: "OUT",
        productUnitId: 1, quantity: "7", reason: "DAMAGE", notes: "كسر شحنة",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stockOf(1, 1)).toBe(20); // بلا تغيير — الشطب لا يُطبَّق بفاعلٍ واحد
  });

  it("يرفض RETURN اليدوي ويوجّه إلى شاشة المرتجع الموثّق", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    await expect(caller.inventory.createManualMovement({
      variantId: 1, branchId: 1, movementType: "RETURN",
      productUnitId: 1, quantity: "3", reason: "OTHER",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stockOf(1, 1)).toBe(20);
  });

  it("أمين المخزن لا يستطيع إنشاء كمية في فرعه أو فرع آخر", async () => {
    const wh2 = appRouter.createCaller(makeCtx(await userRow(3)));
    await expect(wh2.inventory.createManualMovement({
      variantId: 1, branchId: 1,
      movementType: "IN",
      productUnitId: 1, quantity: "4", reason: "CORRECTION",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stockOf(1, 1)).toBe(20);
    expect(await stockOf(1, 2)).toBe(5);
  });

  it("الكاشير ممنوع من إنشاء حركة يدوية (warehouse فأعلى)", async () => {
    // أضف كاشيراً مؤقتاً.
    await db().insert(s.users).values({ id: 10, openId: "local_c1", name: "كاشير", email: "c1@m.test", role: "cashier", loginMethod: "local", branchId: 1 });
    const cashier = appRouter.createCaller(makeCtx(await userRow(10)));
    await expect(
      cashier.inventory.createManualMovement({
        variantId: 1, branchId: 1, movementType: "IN",
        productUnitId: 1, quantity: "1", reason: "OTHER",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("كمية تنتج baseQuantity كسرياً (مثل 0.5 من قطعة) تُرفض", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    await expect(
      caller.inventory.createManualMovement({
        variantId: 1, branchId: 1, movementType: "IN",
        productUnitId: 1, quantity: "0.5", reason: "OTHER",
      })
    ).rejects.toThrow();
    expect(await stockOf(1, 1)).toBe(20); // بلا تغيير.
  });
});

describe("inventory.movementsRich", () => {
  async function seedMovements() {
    // بيانات تاريخية لتمرين شاشة الكاردكس؛ endpoint اليدوي الجديد مغلق ولا يُستخدم للتهيئة.
    await db().insert(s.inventoryMovements).values([
      { variantId: 1, branchId: 1, movementType: "IN", quantity: 2, referenceType: "MANUAL_IN", createdBy: 1 },
      { variantId: 1, branchId: 1, movementType: "RETURN", quantity: 1, referenceType: "MANUAL_RETURN", createdBy: 1 },
      { variantId: 1, branchId: 1, movementType: "RETURN", quantity: 3, referenceType: "MANUAL_RETURN", createdBy: 1 },
      { variantId: 1, branchId: 2, movementType: "IN", quantity: 5, referenceType: "MANUAL_IN", createdBy: 1 },
    ]);
  }

  it("(د1) يجلب كل الحركات بأسماء المنتج والفرع والمستخدم", async () => {
    await seedMovements();
    const admin = appRouter.createCaller(makeCtx(await userRow(1)));
    const { rows, total } = await admin.inventory.movementsRich({});
    expect(total).toBe(4);
    expect(rows).toHaveLength(4);
    // أحدث أولاً.
    expect(rows[0].productName).toBe("ورق A4");
    expect(rows[0].sku).toBe("PAPER-A4");
    expect(rows[0].variantName).toBe("عادي");
    expect(rows[0].createdByName).toBe("المدير");
    // اسم الفرع يظهر.
    expect(["الرئيسي", "المبيعات"]).toContain(rows[0].branchName);
  });

  it("(د1ب) signedQty يعطي الاتجاه الصحيح — بما فيه ADJUST من علامة «(فرق ±D)» (تدقيق ١١/٨)", async () => {
    await db().insert(s.inventoryMovements).values([
      { variantId: 1, branchId: 1, movementType: "IN", quantity: 4, referenceType: "MANUAL_IN", createdBy: 1 },
      { variantId: 1, branchId: 1, movementType: "OUT", quantity: 2, referenceType: "INVOICE", createdBy: 1 },
      { variantId: 1, branchId: 1, movementType: "ADJUST", quantity: 3, referenceType: "ADJUST", notes: "تسوية: من 10 إلى 7 (فرق -3)", createdBy: 1 },
      { variantId: 1, branchId: 1, movementType: "ADJUST", quantity: 5, referenceType: "ADJUST", notes: "تسوية (فرق +5)", createdBy: 1 },
    ]);
    const admin = appRouter.createCaller(makeCtx(await userRow(1)));
    const { rows } = await admin.inventory.movementsRich({});
    const byNote = (frag: string) => rows.find((r) => (r.notes ?? "").includes(frag))!;
    expect(byNote("(فرق -3)").signedQty).toBe(-3); // ADJUST نقص ⇒ سالب
    expect(byNote("(فرق +5)").signedQty).toBe(5); // ADJUST زيادة ⇒ موجب
    expect(rows.find((r) => r.movementType === "IN")!.signedQty).toBe(4); // وارد ⇒ موجب
    expect(rows.find((r) => r.movementType === "OUT")!.signedQty).toBe(-2); // صادر ⇒ سالب
  });

  it("(د2) فلترة بنوع الحركة", async () => {
    await seedMovements();
    const admin = appRouter.createCaller(makeCtx(await userRow(1)));
    // OUT اليدويّ مُوحَّد في التسوية المعتمَدة ⇒ لا حركات OUT من هذا المسار.
    const out = await admin.inventory.movementsRich({ movementType: "OUT" });
    expect(out.total).toBe(0);

    const ins = await admin.inventory.movementsRich({ movementType: "IN" });
    expect(ins.total).toBe(2);
    expect(ins.rows.every((r) => r.movementType === "IN")).toBe(true);
  });

  it("(د3) فلترة بالفرع", async () => {
    await seedMovements();
    const admin = appRouter.createCaller(makeCtx(await userRow(1)));
    const b1 = await admin.inventory.movementsRich({ branchId: 1 });
    expect(b1.total).toBe(3);
    expect(b1.rows.every((r) => r.branchId === 1)).toBe(true);
    const b2 = await admin.inventory.movementsRich({ branchId: 2 });
    expect(b2.total).toBe(1);
    expect(b2.rows[0].branchId).toBe(2);
  });

  it("(د4) فلترة بالتاريخ — toDate يشمل اليوم كاملاً", async () => {
    await seedMovements();
    const admin = appRouter.createCaller(makeCtx(await userRow(1)));
    // يوم العمل وتقسيم طوابع قاعدة البيانات كلاهما UTC؛ لا نعتمد على منطقة جهاز تشغيل الاختبار.
    const today = todayUtcDate();
    const todayAll = await admin.inventory.movementsRich({ fromDate: today, toDate: today });
    expect(todayAll.total).toBe(4); // toDate شامل ⇒ يلتقط ما حصل اليوم.

    const past = "2000-01-01";
    const pastOnly = await admin.inventory.movementsRich({ fromDate: past, toDate: past });
    expect(pastOnly.total).toBe(0);
  });

  it("(د5) ترقيم الصفحات (limit/offset)", async () => {
    await seedMovements();
    const admin = appRouter.createCaller(makeCtx(await userRow(1)));
    const page1 = await admin.inventory.movementsRich({ limit: 2, offset: 0 });
    const page2 = await admin.inventory.movementsRich({ limit: 2, offset: 2 });
    expect(page1.total).toBe(4);
    expect(page2.total).toBe(4);
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    // لا تداخل: id الصفحات مختلفة.
    const ids1 = page1.rows.map((r) => Number(r.id));
    const ids2 = page2.rows.map((r) => Number(r.id));
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it("(د6) عزل الفرع للمستخدم الميداني — warehouse يرى فرعه فقط حتى لو طلب فرعاً آخر", async () => {
    await seedMovements();
    const wh1 = appRouter.createCaller(makeCtx(await userRow(2))); // warehouse, branch 1
    const r = await wh1.inventory.movementsRich({ branchId: 2 }); // محاولة طلب فرع آخر.
    // مُجبَر على فرعه (1): يرى ٣ حركات فرع 1 فقط.
    expect(r.total).toBe(3);
    expect(r.rows.every((row) => row.branchId === 1)).toBe(true);
  });

  it("بحث نصّي يطابق اسم المنتج وSKU", async () => {
    await seedMovements();
    const admin = appRouter.createCaller(makeCtx(await userRow(1)));
    const byName = await admin.inventory.movementsRich({ q: "A4" });
    expect(byName.total).toBe(4);
    const bySku = await admin.inventory.movementsRich({ q: "PAPER-A4" });
    expect(bySku.total).toBe(4);
    const none = await admin.inventory.movementsRich({ q: "غير موجود" });
    expect(none.total).toBe(0);
  });

  it("فلترة بنوع المرجع MANUAL_IN", async () => {
    await seedMovements();
    const admin = appRouter.createCaller(makeCtx(await userRow(1)));
    const r = await admin.inventory.movementsRich({ referenceType: "MANUAL_IN" });
    expect(r.total).toBe(2);
    expect(r.rows.every((row) => row.referenceType === "MANUAL_IN")).toBe(true);
  });
});
