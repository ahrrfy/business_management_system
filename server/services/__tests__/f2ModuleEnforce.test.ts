/**
 * F2 (تدقيق ٢/٧) — إنفاذ خريطة الدور المخصّص على الوحدات غير المالية.
 *
 * الفجوة المُغلَقة: كانت البوّابات الخشنة (managerProcedure/cashierProcedure/…) تفحص الدور الأساس
 * (baseRole) فقط ⇒ دور مخصّص أساسه manager بخريطةٍ تُقيّد وحدةً (مثلاً inventory=NONE) كان يتجاوز
 * القيد. الآن requireModule مُركَّب فوق كل بوّابة للوحدات التسعة ⇒ الخريطة تُنفَّذ فعلاً.
 *
 * يُثبِت:
 *  (١) دور مخصّص baseRole=manager + {module: NONE} ⇒ نقطة تلك الوحدة تُرفَض FORBIDDEN (الفجوة مُغلقة).
 *  (٢) مدير قالبيّ (بلا override) ⇒ يمرّ (لا انحدار — القالب يمنح المستوى).
 *  (٣) تصحيح قالب cashier (workorders READ→FULL): كاشير قالبيّ يمرّ على أوامر الشغل، ودور مخصّص
 *      cashier + {workorders: NONE} يُرفَض.
 *  (٤) الخريطة تُنفَّذ للقوالب أيضاً: purchasing (قالبه customers=NONE) يُرفَض من قائمة العملاء.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "idempotencyKeys", "auditLogs", "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItems", "invoices", "quotationItems", "quotations", "expenses", "workOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "customers", "suppliers", "shifts", "users", "branches",
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
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAP", costPrice: "5.00" });
}

/** سياق caller بدور + خريطة تجاوز اختيارية (كما يحقنها resolveCustomRole في context.ts). */
function caller(role: string, override: Record<string, string> | null, branchId = 1, id = 1) {
  const ctx = {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user: { id, role, branchId, permissionsOverride: override },
  } as any;
  return appRouter.createCaller(ctx);
}

const FORBIDDEN = /صلاحيات غير كافية|FORBIDDEN/;

beforeEach(async () => { await reset(); await seed(); });

// نقطة قراءة تمثيلية لكل وحدة (query ⇒ requireModule READ).
const READ_CASES: Array<{ mod: string; name: string; call: (c: any) => Promise<unknown> }> = [
  { mod: "sales", name: "sales.list", call: (c) => c.sales.list({}) },
  { mod: "purchases", name: "purchases.list", call: (c) => c.purchases.list({}) },
  { mod: "inventory", name: "inventory.stockByBranch", call: (c) => c.inventory.stockByBranch({ branchId: 1 }) },
  { mod: "customers", name: "customers.list", call: (c) => c.customers.list() },
  { mod: "suppliers", name: "suppliers.list", call: (c) => c.suppliers.list() },
  { mod: "expenses", name: "expenses.list", call: (c) => c.expenses.list({}) },
  { mod: "workorders", name: "workOrders.list", call: (c) => c.workOrders.list() },
  { mod: "products", name: "catalog.adminList", call: (c) => c.catalog.adminList({}) },
];

describe("F2 — دور مخصّص بخريطة NONE يُرفَض على نقطة الوحدة (الفجوة مُغلَقة)", () => {
  for (const { mod, name, call } of READ_CASES) {
    it(`manager + {${mod}: NONE} ⇒ ${name} FORBIDDEN`, async () => {
      await expect(call(caller("manager", { [mod]: "NONE" }))).rejects.toThrow(FORBIDDEN);
    });
  }
});

describe("F2 — مدير قالبيّ (بلا override) يمرّ (لا انحدار)", () => {
  // نقاط بلا مدخلات إلزامية معقّدة — تُثبِت أن requireModule لا يحجب الأدوار القالبية.
  it("customers.list يمرّ", async () => {
    await expect(caller("manager", null).customers.list()).resolves.toBeDefined();
  });
  it("suppliers.list يمرّ", async () => {
    await expect(caller("manager", null).suppliers.list()).resolves.toBeDefined();
  });
  it("inventory.stockByBranch يمرّ", async () => {
    await expect(caller("manager", null).inventory.stockByBranch({ branchId: 1 })).resolves.toBeDefined();
  });
  it("workOrders.list يمرّ", async () => {
    await expect(caller("manager", null).workOrders.list()).resolves.toBeDefined();
  });
});

describe("F2 — بوّابة الطفرات (FULL)", () => {
  it("manager + {inventory: NONE} ⇒ inventory.adjust FORBIDDEN (طفرة تتطلّب FULL)", async () => {
    await expect(
      caller("manager", { inventory: "NONE" }).inventory.adjust({
        variantId: 1, branchId: 1, newQuantity: 10, reason: "correction",
      } as any),
    ).rejects.toThrow(FORBIDDEN);
  });
});

describe("F2 — تصحيح قالب cashier (workorders READ→FULL)", () => {
  it("كاشير قالبيّ يمرّ على workOrders.list (workorders=FULL بعد التصحيح)", async () => {
    await expect(caller("cashier", null).workOrders.list()).resolves.toBeDefined();
  });
  it("دور مخصّص cashier + {workorders: NONE} ⇒ workOrders.list FORBIDDEN", async () => {
    await expect(caller("cashier", { workorders: "NONE" }).workOrders.list()).rejects.toThrow(FORBIDDEN);
  });
});

describe("F2 — الخريطة تُنفَّذ للأدوار القالبية أيضاً (حجب مقصود)", () => {
  it("purchasing (قالبه customers=NONE) ⇒ customers.list FORBIDDEN", async () => {
    await expect(caller("purchasing", null).customers.list()).rejects.toThrow(FORBIDDEN);
  });
  it("accountant (قالبه products=NONE) ⇒ catalog.adminList FORBIDDEN", async () => {
    await expect(caller("accountant", null).catalog.adminList({})).rejects.toThrow(FORBIDDEN);
  });
});

// F7 (تدقيق ٢/٧): إكمال بوّابات الوحدة المالية «treasury» على الكتابة (سندات/تحويلات/صيرفة/ورديات).
describe("F7 — إنفاذ وحدة treasury على الكتابة المالية", () => {
  const forbidden: Array<[string, (c: any) => Promise<unknown>]> = [
    ["vouchers.create", (c) => c.vouchers.create({ voucherType: "PAYMENT", branchId: 1, amount: "1000", paymentMethod: "CASH", partyType: "OTHER", description: "x" })],
    ["vouchers.approve", (c) => c.vouchers.approve({ receiptId: 1 })],
    ["cashTransfers.send", (c) => c.cashTransfers.send({ fromBranchId: 1, toBranchId: 2, amount: "1000" })],
    ["exchange.deposit", (c) => c.exchange.deposit({ exchangeHouseId: 1, amount: "1000" })],
    ["exchange.withdraw", (c) => c.exchange.withdraw({ exchangeHouseId: 1, amount: "1000" })],
    ["exchange.buyUsd", (c) => c.exchange.buyUsd({ exchangeHouseId: 1 })],
    ["exchange.settle", (c) => c.exchange.settle({ exchangeHouseId: 1 })],
  ];
  for (const [name, call] of forbidden) {
    it(`manager + {treasury: NONE} ⇒ ${name} FORBIDDEN (وهم الخريطة مُغلَق)`, async () => {
      await expect(call(caller("manager", { treasury: "NONE" }))).rejects.toThrow(FORBIDDEN);
    });
  }
  it("cashier + {treasury: NONE} ⇒ shifts.open FORBIDDEN", async () => {
    await expect(caller("cashier", { treasury: "NONE" }).shifts.open({ branchId: 1, openingBalance: "0" } as any)).rejects.toThrow(FORBIDDEN);
  });
  it("مدير قالبيّ (treasury=FULL) ⇒ لا يُرفَض بالخريطة على الكتابة المالية (لا انحدار)", async () => {
    // قد ينجح أو يفشل لسبب أعمالي (لا طرف/لا صيرفة) — المهم ألّا يكون FORBIDDEN صلاحيات.
    try { await caller("manager", null).cashTransfers.send({ fromBranchId: 1, toBranchId: 2, amount: "1000" } as any); }
    catch (e: any) { expect(String(e?.message)).not.toMatch(/صلاحيات غير كافية/); }
  });
  it("كاشير قالبيّ (treasury=READ) ⇒ shifts.open لا تُرفَض بالخريطة (البوّابة تمرّ)", async () => {
    try { await caller("cashier", null).shifts.open({ branchId: 1, openingBalance: "0" } as any); }
    catch (e: any) { expect(String(e?.message)).not.toMatch(/صلاحيات غير كافية/); }
  });
});
