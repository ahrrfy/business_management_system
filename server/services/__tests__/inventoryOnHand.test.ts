import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "stockAdjustmentRequests",
  "inventoryMovements",
  "branchStock",
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
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@t.local", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_wh", name: "مخزن", email: "wh@t.local", role: "warehouse", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "ورق A4" });
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "SKU-1", variantName: "عادي", minStock: 10 },
    { id: 2, productId: 1, sku: "SKU-2", variantName: "فاخر", minStock: 0 },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 5 }, // تحت الحد الأدنى (10)
    { variantId: 2, branchId: 1, quantity: 100 },
    { variantId: 1, branchId: 2, quantity: 50 }, // فرع آخر
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

beforeEach(async () => {
  await reset();
  await seed();
});

describe("inventory.onHand", () => {
  it("يعرض الأرصدة بالأسماء وعلم «تحت الحد الأدنى»", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    expect(rows).toHaveLength(2);
    const v1 = rows.find((r) => Number(r.variantId) === 1)!;
    const v2 = rows.find((r) => Number(r.variantId) === 2)!;
    expect(v1.productName).toBe("ورق A4");
    expect(v1.quantity).toBe(5);
    expect(v1.isLow).toBe(true);
    expect(v2.quantity).toBe(100);
    expect(v2.isLow).toBe(false);
  });

  it("lowOnly يُرجع المنخفض فقط", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1, lowOnly: true });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].variantId)).toBe(1);
  });

  it("البحث يطابق اسم المنتج وSKU", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    expect(await caller.inventory.onHand({ branchId: 1, q: "A4" })).toHaveLength(2);
    const bySku = await caller.inventory.onHand({ branchId: 1, q: "SKU-2" });
    expect(bySku).toHaveLength(1);
    expect(Number(bySku[0].variantId)).toBe(2);
  });

  it("لا يُسرّب التكلفة في المخرجات", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    for (const r of rows) expect("costPrice" in r).toBe(false);
  });

  it("عزل الفرع: مستخدم المخزن مقيَّد بفرعه ويتجاهل branchId المُرسَل — لا تسريب أرصدة الفرع الآخر", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(2))); // warehouse, branch 2
    const rows = await caller.inventory.onHand({ branchId: 1 }); // يحاول فرع 1
    // بعد إصلاح ٢٤/٨ (LEFT JOIN من الكتالوج): يرى **كل** الكتالوج النشط برصيد فرعه ٢
    // — v1 له صفٌّ في فرع ٢ (50)، وv2 بلا صفٍّ لفرع ٢ (⇒ 0). فرع ١ رقم 100 لا يُرى.
    // مقياس الحرص: `branchId` في كلّ صفٍّ = 2، والأرصدة لا تشمل رقم فرع ١ (100).
    expect(rows.every((r) => Number(r.branchId) === 2)).toBe(true);
    const quantities = rows.map((r) => r.quantity).sort((a, b) => a - b);
    // مقبول: [0 (v2 بلا صفٍّ لفرع ٢), 50 (v1 بفرع ٢)]. ممنوع صراحةً: 100 (رصيد v2 في فرع ١) أو 5 (رصيد v1 في فرع ١).
    expect(quantities).not.toContain(100);
    expect(quantities).not.toContain(5);
    expect(quantities).toContain(50);
  });

  /* ─────────── بلاغ المالك ٢٤/٨: LEFT JOIN من الكتالوج (لا INNER من branchStock) ─────────── */

  it("يُظهر متغيّراً لم يُلامَس بحركةٍ في الفرع (لا صفَّ branchStock) بـquantity=0 — بلاغ المالك", async () => {
    // نضيف متغيّراً جديداً لمنتج قائم بلا صفّ رصيدٍ لأيّ فرع (كأنّه أُدخل الكتالوج ولم يُشترَ بعد)
    await db().insert(s.productVariants).values({
      id: 99,
      productId: 1,
      sku: "ENV-COLDEN-110",
      variantName: "ظرف ابيض 110×220 COLDEN 8S8643P-AA1",
      minStock: 0,
      isActive: true,
    });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    const envelope = rows.find((r) => r.sku === "ENV-COLDEN-110");
    expect(envelope).toBeDefined(); // كان يختفي قبل الإصلاح (INNER JOIN)
    expect(envelope?.quantity).toBe(0);
    expect(envelope?.lastCountedAt).toBeNull();
    // الآن المدير يستطيع فتح تسوية على هذا الصنف من نفس الشاشة (Inventory.tsx).
  });

  it("البحث يجد المتغيّر بلا صفّ branchStock (سيناريو «أعرف اسمه لكن لا يظهر»)", async () => {
    await db().insert(s.productVariants).values({
      id: 100,
      productId: 1,
      sku: "ORPHAN-SKU",
      variantName: "متغيّر بلا رصيد",
      isActive: true,
    });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const bySku = await caller.inventory.onHand({ branchId: 1, q: "ORPHAN-SKU" });
    expect(bySku).toHaveLength(1);
    expect(bySku[0].quantity).toBe(0);
  });

  it("lowOnly لا يُصنّف المتغيّر بلا صفٍّ «تحت الحدّ» (منع فيضان الفلتر)", async () => {
    await db().insert(s.productVariants).values({
      id: 101,
      productId: 1,
      sku: "NOSTOCK-LOW",
      variantName: "لا رصيد وحدّه 50",
      minStock: 50,
      isActive: true,
    });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const low = await caller.inventory.onHand({ branchId: 1, lowOnly: true });
    // فقط v1 (رصيد 5 وحدّه 10). NOSTOCK-LOW له NULL quantity ⇒ يسقط من الفلتر.
    expect(low.map((r) => r.sku).sort()).toEqual(["SKU-1"]);
  });

  it("negativeOnly لا يشمل المتغيّر بلا صفّ (NULL ليس <0)", async () => {
    await db().insert(s.productVariants).values({
      id: 102,
      productId: 1,
      sku: "NOSTOCK-NEG",
      variantName: "لا رصيد — ليس سالباً",
      isActive: true,
    });
    // نجعل v1 سالباً للتأكيد
    await db().update(s.branchStock).set({ quantity: -3 }).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const neg = await caller.inventory.onHand({ branchId: 1, negativeOnly: true });
    expect(neg.map((r) => r.sku).sort()).toEqual(["SKU-1"]);
  });

  it("يستبعد المتغيّر غير النشط والمنتج غير النشط (البدء من الكتالوج يستدعي هذين الفلترَين صراحةً)", async () => {
    await db().insert(s.products).values({ id: 9, name: "منتج معطَّل", isActive: false });
    await db().insert(s.productVariants).values([
      { id: 200, productId: 9, sku: "INACTIVE-PROD", isActive: true },
      { id: 201, productId: 1, sku: "INACTIVE-VAR", isActive: false },
    ]);
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    const skus = rows.map((r) => r.sku);
    expect(skus).not.toContain("INACTIVE-PROD");
    expect(skus).not.toContain("INACTIVE-VAR");
  });

  it("رصيد الفرع الآخر لا يُفسِد عدّ الفرع المطلوب (شرط الفرع في ON لا WHERE)", async () => {
    await db().insert(s.productVariants).values({
      id: 300,
      productId: 1,
      sku: "OTHER-BRANCH-ONLY",
      variantName: "له رصيد بفرع ٢ فقط",
      isActive: true,
    });
    await db().insert(s.branchStock).values({ variantId: 300, branchId: 2, quantity: 77 });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rowsBranch1 = await caller.inventory.onHand({ branchId: 1 });
    const other = rowsBranch1.find((r) => r.sku === "OTHER-BRANCH-ONLY");
    // الصنف يظهر في فرع ١ بـ0 (LEFT JOIN مع شرط branch في ON)
    expect(other).toBeDefined();
    expect(other?.quantity).toBe(0);
    // فرع ٢ يعرضه بـ77
    const admin1WithScope = appRouter.createCaller(makeCtx(await userRow(1)));
    const rowsBranch2 = await admin1WithScope.inventory.onHand({ branchId: 2 });
    const otherAt2 = rowsBranch2.find((r) => r.sku === "OTHER-BRANCH-ONLY");
    expect(otherAt2?.quantity).toBe(77);
  });
});

describe("inventory.adjust (طلب معلَّق ثم اعتماد — فصل مهام #٦)", () => {
  it("adjust يُنشئ طلباً معلَّقاً بلا تغيير، والاعتماد يضبط الرصيد + حركة ADJUST + تدقيق", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const qOf = async () => (await caller.inventory.onHand({ branchId: 1 })).find((r) => Number(r.variantId) === 1)!.quantity;
    const initial = await qOf();

    const req = await caller.inventory.adjust({ variantId: 1, branchId: 1, targetQuantity: 30, notes: "جرد" });
    expect(req.status).toBe("PENDING_APPROVAL");
    expect(await qOf()).toBe(initial); // لا تغيير مخزون قبل الاعتماد

    // admin يعتمد طلبه (مُستثنى من SOD) ⇒ يُطبَّق.
    await caller.inventory.approveAdjustment({ id: req.requestId });
    expect(await qOf()).toBe(30);

    const mv = await db()
      .select()
      .from(s.inventoryMovements)
      .where(and(eq(s.inventoryMovements.variantId, 1), eq(s.inventoryMovements.movementType, "ADJUST")))
      .limit(1);
    expect(mv).toHaveLength(1);
    expect(mv[0].quantity).toBe(Math.abs(30 - initial));

    const audit = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "inventory.adjustApprove"))
      .limit(1);
    expect(audit).toHaveLength(1);
  });
});

describe("inventory.pendingAdjustments/rejectAdjustment — عزل الفرع + الرفض (متابعات المراجعة)", () => {
  it("S3: غير الأدمن بلا فرع مُسنَد ⇒ FORBIDDEN (لا قراءة طلبات عبر الفروع)", async () => {
    await db().insert(s.users).values({ id: 3, openId: "nb_mgr", name: "مدير بلا فرع", role: "manager", loginMethod: "local", branchId: null });
    const caller = appRouter.createCaller(makeCtx(await userRow(3)));
    await expect(caller.inventory.pendingAdjustments({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("R4: رفض طلب تسوية ⇒ REJECTED بلا تغيير مخزون + تدقيق", async () => {
    const admin = appRouter.createCaller(makeCtx(await userRow(1)));
    const qOf = async () => (await admin.inventory.onHand({ branchId: 1 })).find((r) => Number(r.variantId) === 1)!.quantity;
    const before = await qOf();
    const req = await admin.inventory.adjust({ variantId: 1, branchId: 1, targetQuantity: 99 });
    await admin.inventory.rejectAdjustment({ id: req.requestId, reason: "خطأ إدخال" });
    expect(await qOf()).toBe(before); // بلا تطبيق
    const [row] = await db().select().from(s.stockAdjustmentRequests).where(eq(s.stockAdjustmentRequests.id, req.requestId));
    expect(row.status).toBe("REJECTED");
    const audit = await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "inventory.adjustReject")).limit(1);
    expect(audit).toHaveLength(1);
  });
});
