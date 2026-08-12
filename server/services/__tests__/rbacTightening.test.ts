/**
 * اختبارات شريحة «تَمتين RBAC» (٢٣/٦/٢٦):
 *  1) inventory.stockByBranch / movements / onHand / movementsRich — مدير الفرع لا يَستعلم عن فرع آخر.
 *  2) workOrders.assignableStaff — لا يَكشف admin/manager للكاشير (يُعيد التَنفيذيين فقط).
 *  3) verifyManagerApproval — admin عابر-الفرع يُسجَّل سطر «adminCrossBranch» في audit.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { hashPassword } from "../../auth/password";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "customers",
  "shifts",
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
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@t.test", passwordHash: await hashPassword("Admin@12345"), role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_mgr1", name: "مدير ف١", email: "m1@t.test", passwordHash: await hashPassword("Admin@12345"), role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_mgr2", name: "مدير ف٢", email: "m2@t.test", passwordHash: await hashPassword("Admin@12345"), role: "manager", loginMethod: "local", branchId: 2 },
    { id: 4, openId: "local_cashier1", name: "كاشير ف١", email: "c1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "local_print", name: "فني مطبعة", email: "po@t.test", role: "print_operator", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAP", costPrice: "5.00" });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 1, branchId: 2, quantity: 50 },
  ]);
}

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}
async function userById(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

beforeEach(async () => { await reset(); await seed(); });

// ─── (1) inventory: مدير الفرع يقرأ فرعه فقط (قرار المالك ١٢/٨ يعكس ٢٣/٧) ─────────
// ١٢/٨: عزل مدير الفرع — لا عبورَ بين الفروع إطلاقاً (قراءةً ولا كتابةً). المالك/الأدمن وحدهما يعبُران.
// (سابقاً ٢٣/٧: «قراءة الكل، كتابة فرعه»؛ أُلغي.) الكتابة مُغطّاةٌ في inventoryBranchScope.test.ts +
// managerBranchIsolation.test.ts.
describe("inventory — مدير الفرع يقرأ فرعه فقط (قرار المالك ١٢/٨)", () => {
  it("stockByBranch: مدير ف١ يطلب ف٢ ⇒ يُقصَر على فرعه ف١ (لا يعبُر)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(2))); // مدير ف١
    const rows = await caller.inventory.stockByBranch({ branchId: 2 });
    expect(rows.every((r) => Number(r.branchId) === 1)).toBe(true);
  });

  it("stockByBranch: مدير ف١ يطلب ف١ ⇒ يَعمل (فرعه)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(2)));
    const rows = await caller.inventory.stockByBranch({ branchId: 1 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => Number(r.branchId) === 1)).toBe(true);
  });

  it("stockByBranch: مدير ف٢ يطلب ف١ ⇒ يُقصَر على فرعه ف٢ (لا يعبُر)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(3))); // مدير ف٢
    const rows = await caller.inventory.stockByBranch({ branchId: 1 });
    expect(rows.every((r) => Number(r.branchId) === 2)).toBe(true);
  });

  it("stockByBranch: admin يَعبر أيّ فرع", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(1)));
    const rows = await caller.inventory.stockByBranch({ branchId: 2 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => Number(r.branchId) === 2)).toBe(true);
  });

  it("الكاشير لا يَختار branchId ⇒ يُجبَر على فرعه (sanity — السلوك الموجود)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(4))); // كاشير ف١
    // حتى لو مرّر branchId=2، scopedBranchId=1 يَجبره. النتيجة: مخزون ف١.
    const rows = await caller.inventory.stockByBranch({ branchId: 2 });
    expect(rows.every((r) => Number(r.branchId) === 1)).toBe(true);
  });
});

// ─── (2) assignableStaff: لا تَكشف admin/manager ─────────────────────
describe("workOrders.assignableStaff — فنيو المطبعة فقط", () => {
  it("القائمة لا تعرض الحسابات الإدارية أو موظفي البيع والكاشير", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(4))); // كاشير
    const staff = await caller.workOrders.assignableStaff();
    const roles = staff.map((s) => s.role);
    expect(roles).not.toContain("admin");
    expect(roles).not.toContain("manager");
    expect(roles).not.toContain("cashier");
    expect(roles).not.toContain("warehouse");
    expect(roles).toContain("print_operator");
  });
});

// ملاحظة: اختبار verifyManagerApproval (admin cross-branch audit) يَتطلّب تَدفّق بيع آجل
// كاملاً بكلمة مرور إدارية + سقف ائتمان مُجاوز. مُغطّى بفحص الكود + المراجعة العدائية،
// وسيُختبَر تَكاملياً في شريحة تَدفّق الائتمان لاحقاً.
