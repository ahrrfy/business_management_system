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
        variantId: 1, branchId: 1, targetQuantity: 10,
      }),
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

// #27 (تدقيق التثبيت الوظيفي ٧/٧): forPurchase — بحث منتجات جانب الشراء (يكشف التكلفة) كان محصوراً
// بالمدير، فتعذّر على purchasing/warehouse بناء أمر الشراء المخوَّلَين إنشاءه/استلامه. فُتِح لأدوار
// الشراء بمستوى READ، مع بقائه محجوباً عن الكاشير/المندوب (حماية التكلفة) وبقاء كتابة الكتالوج مديرية.
describe("#27 — forPurchase متاح لأدوار الشراء، محجوب عن غيرها (حماية التكلفة)", () => {
  it("purchasing (يبني أوامر الشراء) يمرّ على catalog.forPurchase", async () => {
    await expect(caller("purchasing", null).catalog.forPurchase({ branchId: 1 })).resolves.toBeDefined();
  });
  it("warehouse (يستلم أوامر الشراء) يمرّ على catalog.forPurchase", async () => {
    await expect(caller("warehouse", null).catalog.forPurchase({ branchId: 1 })).resolves.toBeDefined();
  });
  it("manager يمرّ على catalog.forPurchase", async () => {
    await expect(caller("manager", null).catalog.forPurchase({ branchId: 1 })).resolves.toBeDefined();
  });
  it("cashier (خارج قائمة الشراء) ⇒ forPurchase FORBIDDEN (لا تتسرّب التكلفة)", async () => {
    await expect(caller("cashier", null).catalog.forPurchase({ branchId: 1 })).rejects.toThrow(FORBIDDEN);
  });
  it("sales_rep ⇒ forPurchase FORBIDDEN (لا تتسرّب التكلفة)", async () => {
    await expect(caller("sales_rep", null).catalog.forPurchase({ branchId: 1 })).rejects.toThrow(FORBIDDEN);
  });
  it("purchasing لا يزال محجوباً عن كتابة الكتالوج (checkBarcodes على بوّابة FULL) — فُتِحت القراءة فقط", async () => {
    await expect(caller("purchasing", null).catalog.checkBarcodes({ codes: ["ABC"] })).rejects.toThrow(FORBIDDEN);
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
  it("cashier + {treasury: NONE, pos: NONE} ⇒ shifts.open FORBIDDEN (لا خزينة ولا نقطة بيع)", async () => {
    // ٢٣/٧/٢٦: الوردية صارت treasury **أو** pos=FULL (تشغيل الصندوق)؛ فالحجب يتطلّب تجريد
    // الاثنين معاً. الكاشير «pos فقط» يفتح الوردية الآن — يُغطّى في «POS-REGISTER» أدناه.
    await expect(caller("cashier", { treasury: "NONE", pos: "NONE" }).shifts.open({ branchId: 1, openingBalance: "0" } as any)).rejects.toThrow(FORBIDDEN);
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

// ─── ٦/٧: بوّابة المنح الصريح — «فتحتُ صلاحيات لحساب» تعمل فعلاً الآن ─────────────
describe("المنح الصريح يفتح بوّابة أضيق من الدور (requireModuleGate)", () => {
  it("warehouse قالبيّ يقرأ الموردين (قالبه suppliers=FULL وكان managerProcedure يصدّه)", async () => {
    await expect(caller("warehouse", null).suppliers.list()).resolves.toBeDefined();
  });
  it("cashier + {suppliers: READ} يقرأ الموردين", async () => {
    await expect(caller("cashier", { suppliers: "READ" }).suppliers.list()).resolves.toBeDefined();
  });
  it("cashier بلا منح يبقى مرفوضاً عن الموردين (قالبه NONE)", async () => {
    await expect(caller("cashier", null).suppliers.list()).rejects.toThrow(FORBIDDEN);
  });
  it("cashier + {reports: READ} منحاً صريحاً يصل تقارير reportViewer (كانت قائمة أدوار حرفية تصدّه)", async () => {
    await expect(caller("cashier", { reports: "READ" }).reports.arAging({ branchId: 1 })).resolves.toBeDefined();
  });
  // ٦/٧ (مراجعة عدائية): بوّابة التقارير تبقى على قائمة [manager/accountant/auditor] + منح صريح —
  // warehouse القالبيّ (reports=READ افتراضاً بلا override) محجوب، لئلا تُكشَف تقارير التكلفة/الربح
  // لدور canSeeCost=false. المنح الصريح للمالك وحده يفتح البوّابة (الاختبار أعلاه).
  it("warehouse قالبيّ (بلا منح صريح) يبقى محجوباً عن التقارير", async () => {
    await expect(caller("warehouse", null).reports.arAging({ branchId: 1 })).rejects.toThrow(FORBIDDEN);
  });
  it("warehouse + {reports: READ} منحاً صريحاً يصل التقارير", async () => {
    await expect(caller("warehouse", { reports: "READ" }).reports.arAging({ branchId: 1 })).resolves.toBeDefined();
  });
  it("cashier بلا منح يبقى مرفوضاً عن التقارير (قالبه NONE)", async () => {
    await expect(caller("cashier", null).reports.arAging({ branchId: 1 })).rejects.toThrow(FORBIDDEN);
  });
  it("accountant قالبيّ (treasury=FULL موعودة) لا يُرفَض صلاحياتياً عن تحويل نقدي", async () => {
    try { await caller("accountant", null).cashTransfers.send({ fromBranchId: 1, toBranchId: 2, amount: "1000" } as any); }
    catch (e: any) { expect(String(e?.message)).not.toMatch(/صلاحيات غير كافية/); }
  });
  it("user + {sales: FULL} منحاً صريحاً لا يُرفَض صلاحياتياً عن بوّابة مبيعات الكتابة", async () => {
    // قد يفشل لاحقاً لسبب أعمالي (مدخلات) — المهم أن البوّابة لم تعد ترفض المنح.
    try { await caller("user", { sales: "FULL" }).returns.list({} as any); }
    catch (e: any) { expect(String(e?.message)).not.toMatch(/صلاحيات غير كافية/); }
  });
  it("user بلا منح يبقى مرفوضاً عن بوّابة المبيعات المديرية", async () => {
    await expect(caller("user", null).returns.list({} as any)).rejects.toThrow(FORBIDDEN);
  });
});

// ─── ٢٣/٧/٢٦: «نقطة البيع» (pos=FULL) تُشغّل صندوق التجزئة كاملاً ─────────────────────
// بلاغ المالك: أنشأ حساب كاشير ومنحه «نقطة البيع» فقط، فظهر «صلاحيات غير كافية» عند فتح
// الوردية. السبب: الوردية كانت treasury، والبيع sales، وكتالوج الصندوق products — لا pos.
// الإصلاح (إتاحات إضافية بحتة): pos=FULL يُجيز الوردية (فتح/إغلاق/الحالية) + بيع POS +
// قراءة posList/byBarcode. الحدود محفوظة: المصادر الخلفية للبيع + الموردون/التقارير +
// العملاء (crm) تبقى على بوّاباتها؛ وpos=NONE يبقى محجوباً؛ ولا انحدار على أدوار treasury.
describe("POS-REGISTER — «نقطة البيع=كامل» تُشغّل الصندوق دون منح الخزينة/المبيعات/المنتجات", () => {
  // كاشير «pos فقط»: كل الوحدات NONE عدا pos=FULL (قالبيّ) — يطابق تخصيص المالك في البلاغ.
  const posOnly = {
    treasury: "NONE", sales: "NONE", products: "NONE", crm: "NONE", customers: "NONE",
    inventory: "NONE", workorders: "NONE", expenses: "NONE", campaigns: "NONE",
    collections: "NONE", store: "NONE", suppliers: "NONE", reports: "NONE",
  };

  it("يفتح الوردية (كان يُرفَض FORBIDDEN — جوهر البلاغ)", async () => {
    // لا يُرفَض صلاحياتياً؛ قد يمرّ أو يفشل لسبب أعمالي — المهم ألّا «صلاحيات غير كافية».
    try { await caller("cashier", posOnly).shifts.open({ branchId: 1, openingBalance: "0" } as any); }
    catch (e: any) { expect(String(e?.message)).not.toMatch(/صلاحيات غير كافية/); }
  });
  it("يقرأ الوردية الحالية (shifts.current)", async () => {
    await expect(caller("cashier", posOnly).shifts.current({ branchId: 1 } as any)).resolves.toBeDefined();
  });
  it("يقرأ كتالوج الصندوق (catalog.posList)", async () => {
    await expect(caller("cashier", posOnly).catalog.posList({ branchId: 1, tier: "RETAIL" } as any)).resolves.toBeDefined();
  });
  it("يُتمّ بيع POS (sales.create sourceType=POS) — لا يُرفَض صلاحياتياً", async () => {
    try {
      await caller("cashier", posOnly).sales.create({
        branchId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      } as any);
    } catch (e: any) { expect(String(e?.message)).not.toMatch(/صلاحيات غير كافية/); }
  });

  // ─── الحدود: pos لا يفتح إلا الصندوق (لا إتاحة زائدة) ───
  it("يُرفَض عن بيع WORKORDER (pos لا يفتح المصادر الخلفية للبيع)", async () => {
    await expect(caller("cashier", posOnly).sales.create({
      branchId: 1, sourceType: "WORKORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
    } as any)).rejects.toThrow(FORBIDDEN);
  });
  it("يبقى محجوباً عن الموردين والتقارير (pos وحده لا يفتحهما)", async () => {
    await expect(caller("cashier", posOnly).suppliers.list()).rejects.toThrow(FORBIDDEN);
    await expect(caller("cashier", posOnly).reports.arAging({ branchId: 1 })).rejects.toThrow(FORBIDDEN);
  });
  it("العملاء يبقون على crm (البيع النقدي لا يحتاجهم؛ الائتمان يتطلّب منح crm صريحاً)", async () => {
    await expect(caller("cashier", posOnly).customers.list()).rejects.toThrow(FORBIDDEN);
  });

  // ─── لا انحدار ───
  it("cashier + {pos: NONE, treasury: NONE} ⇒ shifts.open FORBIDDEN (لا وصول إطلاقاً)", async () => {
    await expect(caller("cashier", { pos: "NONE", treasury: "NONE" }).shifts.open({ branchId: 1, openingBalance: "0" } as any)).rejects.toThrow(FORBIDDEN);
  });
  it("auditor (treasury=READ قالباً، بلا pos) لا يفتح الوردية (الكتابة مقصورة على cashier/manager+pos)", async () => {
    await expect(caller("auditor", null).shifts.open({ branchId: 1, openingBalance: "0" } as any)).rejects.toThrow(FORBIDDEN);
  });
  it("auditor يقرأ قائمة الورديات (treasury=READ قالباً — لا انحدار على القراءة)", async () => {
    await expect(caller("auditor", null).shifts.list({})).resolves.toBeDefined();
  });
});
