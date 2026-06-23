/**
 * اختبارات شريحة «تَصليب متوسّط» (٢٣/٦/٢٦):
 *  1) supplier.list/search/get — كاشير ⇒ UNAUTHORIZED (لا يَرى الموردين).
 *  2) computeExpectedCash — فلتر cashBucket='DRAWER' (سندات TREASURY لا تَدخل التسوية).
 *  3) escLike — البحث يُهرّب % و _ ليُعامَلا كنصّ لا وايلد-كارد.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { hashPassword } from "../../auth/password";

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "workOrderImages",
  "workOrderMaterials",
  "workOrders",
  "cashTransfers",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "users",
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
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "adm", name: "المدير", email: "admin@t.test", passwordHash: hashPassword("P@ss1"), role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "cashier", name: "كاشير", email: "cashier@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "mgr", name: "مدير فرع", email: "mgr@t.test", passwordHash: hashPassword("P@ss1"), role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.suppliers).values([
    { id: 1, name: "مورّد اختبار", phone: "+9647001234567" },
  ]);
}

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}
async function userById(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

beforeEach(async () => { await reset(); await seed(); });

// ─── (1) supplier.list/search/get — cashier ⇒ UNAUTHORIZED ──────────────────
describe("supplierRouter — كاشير لا يَرى الموردين", () => {
  it("list: كاشير ⇒ UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(2)));
    await expect(caller.suppliers.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("search: كاشير ⇒ UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(2)));
    await expect(caller.suppliers.search()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("get: كاشير ⇒ UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(2)));
    await expect(caller.suppliers.get({ supplierId: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("list: مدير ⇒ يَصل", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(3)));
    const rows = await caller.suppliers.list();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("list: أدمن ⇒ يَصل", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(1)));
    const rows = await caller.suppliers.list();
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ─── (2) computeExpectedCash — cashBucket filter ─────────────────────────────
describe("computeExpectedCash — سندات TREASURY لا تَدخل تسوية الدرج", () => {
  it("TREASURY receipt بشiftId لا تُضاف للنقد المتوقّع", async () => {
    const d = db();
    // وردية مفتوحة برصيد افتتاحي 100
    await d.insert(s.shifts).values({
      id: 1, userId: 1, branchId: 1, openingBalance: "100.00", status: "OPEN",
    });
    // سند DRAWER عادي IN 50
    await d.insert(s.receipts).values({
      id: 1, branchId: 1, shiftId: 1, direction: "IN", amount: "50.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", createdBy: 1,
    });
    // سند TREASURY بشiftId (يجب ألا يَحسَب)
    await d.insert(s.receipts).values({
      id: 2, branchId: 1, shiftId: 1, direction: "IN", amount: "200.00",
      paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", createdBy: 1,
    });

    // إغلاق الوردية: النقد المتوقّع = 100 + 50 = 150 (لا 350)
    const { closeShift } = await import("../shiftService");
    const res = await closeShift({ shiftId: 1, countedCash: "150.00" }, { userId: 1, branchId: 1, role: "admin" });
    expect(res.expectedCash).toBe("150.00");
    expect(res.variance).toBe("0.00");
  });
});

// ─── (3) escLike — الهروب من % و _ ─────────────────────────────────────────
describe("escLike — تهريب محارف LIKE الخاصة", () => {
  it("البحث بـ% لا يُعيد كل المنتجات", async () => {
    const d = db();
    await d.insert(s.products).values([
      { id: 1, name: "ورق A4" },
      { id: 2, name: "ورق A3" },
    ]);
    await d.insert(s.productVariants).values([
      { id: 1, productId: 1, sku: "A4", costPrice: "5.00" },
      { id: 2, productId: 2, sku: "A3", costPrice: "5.00" },
    ]);
    await d.insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: 10 },
      { variantId: 2, branchId: 1, quantity: 10 },
    ]);

    const caller = appRouter.createCaller(makeCtx(await userById(1)));
    // البحث بنجمة خام: يجب ألّا يجلب كل السجلّات (الهروب يجعلها نصّاً حرفياً)
    const rows = await caller.inventory.stockByBranch({ branchId: 1, q: "%" });
    // لا منتج اسمه «%» حرفياً ⇒ نتيجة فارغة أو محدودة (لا الكل)
    expect(rows.length).toBe(0);
  });
});
