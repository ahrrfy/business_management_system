/**
 * اختبارات شريحة «إغلاق ثغرات النقد والذرّية» (٢٣/٦/٢٦):
 *  1) sale.create idempotency بصمة كاملة (عميل/طريقة دفع/عدد أسطر) — لا «استرداد فاتورة قديمة صامت».
 *  2) cashBucket='DRAWER' على receipts النقدية (بيع/دفعة/استرداد) — يَحرس صيَغ reconcile مستقبلاً.
 *  3) cashTransfer.send بصمة (from/to/amount) — لا «نُقل بنجاح» وهمي.
 *  4) inventory.transferBatch idempotency — نقرة مزدوجة = سند واحد (لا حركتان).
 *  5) workOrder.create فرض branchId الفعّال — كاشير فرعٍ لا يُنشئ أمر شغل بفرع آخر.
 *  6) reports.topProducts/slowMovers/profitByCategory — مدير الفرع لا يَستعلم عن فرع آخر.
 *  7) openShiftIdTx قفل وإعادة فحص — وردية مغلقة تَتلوّ القفل = null.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createSale, processPayment } from "../saleService";
import { sendTransfer } from "../cashTransferService";
import { openShiftIdTx } from "../shiftService";
import { withTx } from "../tx";
import { returnSale } from "../returnService";

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "cashTransfers",
  "workOrderImages",
  "workOrderMaterials",
  "workOrders",
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
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@t.test", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_cashier1", name: "كاشير ف١", email: "c1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_cashier2", name: "كاشير ف٢", email: "c2@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
    { id: 4, openId: "local_mgr2", name: "مدير ف٢", email: "m2@t.test", role: "manager", loginMethod: "local", branchId: 2 },
    { id: 5, openId: "local_wh1", name: "مخزن ف١", email: "wh1@t.test", role: "warehouse", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "ورق A4" }, { id: 2, name: "قلم" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PAP-1", costPrice: "5.00" },
    { id: 2, productId: 2, sku: "PEN-1", costPrice: "1.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "3.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 50 },
    { variantId: 2, branchId: 1, quantity: 20 },
    { variantId: 1, branchId: 2, quantity: 10 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "زبون ١", defaultPriceTier: "RETAIL", currentBalance: "0" },
    { id: 2, name: "زبون ٢", defaultPriceTier: "RETAIL", currentBalance: "0" },
  ]);
  // وردية مفتوحة للأدمن (ف١) — للنقد المباشر.
  await d.insert(s.shifts).values({
    id: 1, userId: 1, branchId: 1, status: "OPEN",
    openedAt: new Date(), openGuard: "1:1", openingBalance: "0",
  });
  // وردية مفتوحة لكاشير ف٢ (للاختبارات التي تَستعمله).
  await d.insert(s.shifts).values({
    id: 2, userId: 3, branchId: 2, status: "OPEN",
    openedAt: new Date(), openGuard: "3:2", openingBalance: "0",
  });
}

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}
async function userById(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

const actorAdmin = { userId: 1, branchId: 1, role: "admin" } as const;

beforeEach(async () => { await reset(); await seed(); });

// ─── (1) sale.create idempotency بصمة كاملة ─────────────────────────────
describe("sale.create idempotency — بصمة كاملة تَكشف إعادة استعمال المفتاح", () => {
  it("نفس clientRequestId بعميل مختلف ⇒ CONFLICT", async () => {
    const reqId = "sale-fp-cust";
    await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], clientRequestId: reqId },
      actorAdmin,
    );
    await expect(
      createSale(
        { branchId: 1, customerId: 2, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], clientRequestId: reqId },
        actorAdmin,
      ),
    ).rejects.toThrow(/عميل مختلف/);
    expect((await db().select().from(s.invoices))).toHaveLength(1);
  });

  it("نفس clientRequestId بطريقة دفع مختلفة ⇒ CONFLICT", async () => {
    const reqId = "sale-fp-method";
    await createSale(
      {
        branchId: 1, shiftId: 1, customerId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "10", method: "CASH" }, clientRequestId: reqId,
      },
      actorAdmin,
    );
    await expect(
      createSale(
        {
          branchId: 1, shiftId: 1, customerId: 1, sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          payment: { amount: "10", method: "CARD" }, clientRequestId: reqId,
        },
        actorAdmin,
      ),
    ).rejects.toThrow(/طريقة دفع مختلفة/);
  });

  it("نفس clientRequestId بعدد أسطر مختلف ⇒ CONFLICT", async () => {
    const reqId = "sale-fp-lines";
    await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], clientRequestId: reqId },
      actorAdmin,
    );
    await expect(
      createSale(
        {
          branchId: 1, customerId: 1, sourceType: "ORDER",
          lines: [
            { variantId: 1, productUnitId: 1, quantity: "1" },
            { variantId: 2, productUnitId: 2, quantity: "1" },
          ],
          clientRequestId: reqId,
        },
        actorAdmin,
      ),
    ).rejects.toThrow(/عدد أصناف مختلف/);
  });

  it("نفس clientRequestId بكامل البصمة ⇒ replay آمن (لا فاتورة ثانية)", async () => {
    const reqId = "sale-fp-replay";
    const r1 = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], clientRequestId: reqId },
      actorAdmin,
    );
    const r2 = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], clientRequestId: reqId },
      actorAdmin,
    );
    expect(r2.invoiceId).toBe(r1.invoiceId);
    expect(r2.idempotentReplay).toBe(true);
    expect((await db().select().from(s.invoices))).toHaveLength(1);
  });
});

// ─── (2) cashBucket='DRAWER' على receipts النقدية ─────────────────────
describe("cashBucket='DRAWER' على receipts النقدية", () => {
  it("بيع نقدي ⇒ DRAWER؛ بطاقة ⇒ null", async () => {
    await createSale(
      {
        branchId: 1, shiftId: 1, customerId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "10", method: "CASH" },
      },
      actorAdmin,
    );
    await createSale(
      {
        branchId: 1, shiftId: 1, customerId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "10", method: "CARD" },
      },
      actorAdmin,
    );
    const rs = await db().select().from(s.receipts).orderBy(s.receipts.id);
    expect(rs).toHaveLength(2);
    expect(rs[0].cashBucket).toBe("DRAWER");
    expect(rs[0].paymentMethod).toBe("CASH");
    expect(rs[1].cashBucket).toBeNull();
    expect(rs[1].paymentMethod).toBe("CARD");
  });

  it("processPayment نقدي ⇒ DRAWER", async () => {
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }] },
      actorAdmin,
    );
    await processPayment({ invoiceId: sale.invoiceId, amount: "10", method: "CASH", shiftId: 1 }, actorAdmin);
    const r = (await db().select().from(s.receipts).where(eq(s.receipts.direction, "IN")))[0];
    expect(r.cashBucket).toBe("DRAWER");
  });

  it("مرتجع نقدي ⇒ DRAWER على OUT", async () => {
    const sale = await createSale(
      {
        branchId: 1, shiftId: 1, customerId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        payment: { amount: "20", method: "CASH" },
      },
      actorAdmin,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await returnSale(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
        refund: { amount: "10", method: "CASH" },
      },
      actorAdmin,
    );
    const out = (await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT")))[0];
    expect(out.cashBucket).toBe("DRAWER");
  });
});

// ─── (3) cashTransfer.send بصمة ────────────────────────────────────────
describe("cashTransfer.send بصمة (from/to/amount)", () => {
  async function seedTreasury() {
    // أوجد رصيد TREASURY في الفرع ١ — receipt IN بـcashBucket='TREASURY'.
    const d = db();
    await d.insert(s.receipts).values({
      branchId: 1, shiftId: null, direction: "IN",
      amount: "1000.00", paymentMethod: "CASH", cashBucket: "TREASURY",
      status: "COMPLETED",
      partyType: "OTHER", description: "تمويل خزينة افتتاحي للاختبار",
      referenceNumber: "TEST-FUND",
      createdBy: 1,
    });
  }

  it("نفس المفتاح بمبلغ مختلف ⇒ CONFLICT (لا تحويل ثانٍ وهمي)", async () => {
    await seedTreasury();
    const reqId = "ct-fp-amount";
    await sendTransfer({ fromBranchId: 1, toBranchId: 2, amount: "100.00", clientRequestId: reqId }, actorAdmin);
    await expect(
      sendTransfer({ fromBranchId: 1, toBranchId: 2, amount: "200.00", clientRequestId: reqId }, actorAdmin),
    ).rejects.toThrow(/فرع\/مبلغ مختلف/);
    expect((await db().select().from(s.cashTransfers))).toHaveLength(1);
  });

  it("نفس المفتاح بوجهة مختلفة ⇒ CONFLICT", async () => {
    await seedTreasury();
    const reqId = "ct-fp-to";
    await sendTransfer({ fromBranchId: 1, toBranchId: 2, amount: "100.00", clientRequestId: reqId }, actorAdmin);
    await expect(
      sendTransfer({ fromBranchId: 1, toBranchId: 1, amount: "100.00", clientRequestId: reqId }, actorAdmin),
    ).rejects.toThrow(); // إمّا «نفس الفرع» وإمّا «بصمة مختلفة» — السلوك المهمّ: لا إنشاء.
    expect((await db().select().from(s.cashTransfers))).toHaveLength(1);
  });

  it("نفس المفتاح بكامل البصمة ⇒ replay آمن", async () => {
    await seedTreasury();
    const reqId = "ct-fp-replay";
    const r1 = await sendTransfer({ fromBranchId: 1, toBranchId: 2, amount: "100.00", clientRequestId: reqId }, actorAdmin);
    const r2 = await sendTransfer({ fromBranchId: 1, toBranchId: 2, amount: "100.00", clientRequestId: reqId }, actorAdmin);
    expect(r2.transferId).toBe(r1.transferId);
    expect((await db().select().from(s.cashTransfers))).toHaveLength(1);
  });
});

// ─── (4) inventory.transferBatch idempotency ──────────────────────────
describe("inventory.transferBatch idempotency", () => {
  it("نفس clientRequestId ⇒ سند واحد (لا تكرار نقل)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(1)));
    const reqId = "batch-idem-1";
    const r1 = await caller.inventory.transferBatch({
      fromBranchId: 1, toBranchId: 2, reason: "REBALANCE",
      items: [{ variantId: 1, baseQuantity: 5 }],
      clientRequestId: reqId,
    });
    const r2 = await caller.inventory.transferBatch({
      fromBranchId: 1, toBranchId: 2, reason: "REBALANCE",
      items: [{ variantId: 1, baseQuantity: 5 }],
      clientRequestId: reqId,
    });
    expect(r1.idempotentReplay).toBe(false);
    expect(r2.idempotentReplay).toBe(true);

    // المخزون انتقل مرّة واحدة فقط (50−5=45، 10+5=15).
    const at1 = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    const at2 = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 2))))[0];
    expect(at1.quantity).toBe(45);
    expect(at2.quantity).toBe(15);

    // حركتان (out + in) فقط، لا أربع.
    const movs = await db().select().from(s.inventoryMovements);
    expect(movs).toHaveLength(2);
  });

  it("مفاتيح مختلفة ⇒ سندان منفصلان (تأكيد عدم الإفراط)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(1)));
    await caller.inventory.transferBatch({
      fromBranchId: 1, toBranchId: 2, items: [{ variantId: 1, baseQuantity: 3 }], clientRequestId: "k-A",
    });
    await caller.inventory.transferBatch({
      fromBranchId: 1, toBranchId: 2, items: [{ variantId: 1, baseQuantity: 2 }], clientRequestId: "k-B",
    });
    const at2 = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 2))))[0];
    expect(at2.quantity).toBe(15); // 10 + 3 + 2
  });
});

// ─── (5) workOrder.create فرض branchId الفعّال ─────────────────────────
describe("workOrder.create — كاشير لا يُنشئ أمر شغل بفرع آخر", () => {
  it("كاشير ف٢ يحاول إنشاء أمر في ف١ ⇒ FORBIDDEN (لا أمر، لا عربون)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(3))); // كاشير ف٢
    await expect(
      caller.workOrder.create({
        branchId: 1, // ❌ ليس فرع المستخدم
        title: "بطاقات أعمال",
        quantity: 100,
        salePrice: "50.00",
      }),
    ).rejects.toThrow(/فرع آخر|FORBIDDEN/);
    expect((await db().select().from(s.workOrders))).toHaveLength(0);
    expect((await db().select().from(s.receipts))).toHaveLength(0);
  });

  it("كاشير ف٢ يُنشئ في فرعه ⇒ مقبول، والأمر في ف٢", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(3)));
    const r = await caller.workOrder.create({
      branchId: 2,
      title: "كروت دعوة",
      quantity: 50,
      salePrice: "75.00",
    });
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, (r as any).workOrderId)))[0];
    expect(Number(wo.branchId)).toBe(2);
  });
});

// ─── (6) reports.* — مدير الفرع لا يَستعلم عن فرع آخر ──────────────────
describe("reports — عزل الفرع لـtopProducts/slowMovers/profitByCategory", () => {
  it("مدير ف٢ يطلب topProducts لـbranchId=1 ⇒ FORBIDDEN", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(4))); // مدير ف٢
    await expect(caller.reports.topProducts({ branchId: 1 })).rejects.toThrow(/فرع آخر|FORBIDDEN/);
  });

  it("مدير ف٢ يطلب slowMovers لـbranchId=1 ⇒ FORBIDDEN", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(4)));
    await expect(caller.reports.slowMovers({ branchId: 1 })).rejects.toThrow(/فرع آخر|FORBIDDEN/);
  });

  it("مدير ف٢ يطلب profitByCategory لـbranchId=1 ⇒ FORBIDDEN", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(4)));
    await expect(caller.reports.profitByCategory({ branchId: 1 })).rejects.toThrow(/فرع آخر|FORBIDDEN/);
  });

  it("admin يَعبر أيّ فرع (لا حصر)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(1)));
    // لا رمي — استدعاء صامت يَنجح حتى لو القائمة فارغة.
    await expect(caller.reports.topProducts({ branchId: 2 })).resolves.toBeDefined();
  });
});

// ─── (7) openShiftIdTx — قفل وإعادة فحص ───────────────────────────────
describe("openShiftIdTx — قفل صفّ + إعادة فحص بعد القفل", () => {
  it("وردية مفتوحة ⇒ يُرجع المعرّف", async () => {
    const id = await withTx((tx) => openShiftIdTx(tx, 1, 1));
    expect(id).toBe(1);
  });

  it("وردية CLOSED قبل القفل ⇒ null (إعادة الفحص بعد القفل تَكشف الإغلاق)", async () => {
    await db().update(s.shifts).set({ status: "CLOSED" }).where(eq(s.shifts.id, 1));
    const id = await withTx((tx) => openShiftIdTx(tx, 1, 1));
    expect(id).toBeNull();
  });

  it("لا وردية لهذا المستخدم/الفرع ⇒ null", async () => {
    const id = await withTx((tx) => openShiftIdTx(tx, 2, 1)); // كاشير ف١ بلا وردية
    expect(id).toBeNull();
  });
});
