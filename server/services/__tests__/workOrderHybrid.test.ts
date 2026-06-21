// أوامر الشغل الهجينة (٢١/٦/٢٦) — سلامة التنفيذ والفوترة:
//  • تسليم أمر خدمة خالص (baseVariantId=null) ⇒ فاتورة بلا سطر مخزون + قيد SALE (كان مكسوراً).
//  • إغلاق ثغرة workOrderItems (لا تُكتب بعد الآن ⇒ لا مخزون/COGS يتيم).
//  • السحب الذاتي (claim) + منع سرقة أمر زميل.
//  • عزل المحطة: فني المطبعة ينفّذ أوامره فقط؛ ولا يُسلّم/يُصدر فاتورة (أقلّ امتياز).
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createWorkOrder, startWorkOrder, markWorkOrderReady, deliverWorkOrder } from "../workOrderService";
import { openShift } from "../shiftService";

const actor = { userId: 1, branchId: 1 };
const adminCtx = { req: { headers: {}, ip: "127.0.0.1" } as any, res: { cookie() {}, clearCookie() {} } as any, user: { id: 1, role: "admin", branchId: 1 } as any };
const opCtx = (id: number, role = "print_operator") => ({ req: { headers: {}, ip: "127.0.0.1" } as any, res: { cookie() {}, clearCookie() {} } as any, user: { id, role, branchId: 1 } as any });
const caller = (ctx: any = adminCtx) => appRouter.createCaller(ctx);

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "expenses", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderImages", "workOrderItems", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
];
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "op2", name: "فني ١", role: "print_operator", branchId: 1, loginMethod: "local" },
    { id: 3, openId: "op3", name: "فني ٢", role: "print_operator", branchId: 1, loginMethod: "local" },
  ]);
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAP-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
}
beforeEach(async () => { await reset(); await seedBase(); });

describe("تسليم أمر خدمة خالص (بلا منتج أساس) — كان مكسوراً", () => {
  it("baseVariantId=null ⇒ فاتورة بلا سطر invoiceItems + قيد SALE صحيح", async () => {
    await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const wo = await createWorkOrder({ branchId: 1, baseVariantId: null, title: "تصميم شعار", salePrice: "100.00" }, actor);
    await startWorkOrder(wo.workOrderId, { ...actor, role: "admin" }); // لا مواد ⇒ لا خصم مخزون
    await markWorkOrderReady(wo.workOrderId, { ...actor, role: "admin" });
    const d = await deliverWorkOrder({ workOrderId: wo.workOrderId, payment: { amount: "100.00", method: "CASH" } }, { ...actor, role: "admin" });
    expect(d.invoiceId).toBeTruthy();
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, d.invoiceId)))[0];
    expect(inv.total).toBe("100.00");
    expect(inv.status).toBe("PAID");
    // أمر خدمة ⇒ لا سطر مخزون (variantId NOT NULL يَمنع سطراً وهمياً).
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, d.invoiceId));
    expect(items).toHaveLength(0);
    // قيد SALE واحد بإيراد كامل.
    const sale = (await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "SALE");
    expect(sale).toHaveLength(1);
    expect(sale[0].revenue).toBe("100.00");
  });
});

describe("إغلاق ثغرة الأصناف اليتيمة (workOrderItems)", () => {
  it("create لا يكتب workOrderItems حتى لو مُرّرت items (الأصناف الجاهزة تُباع بفاتورة مستقلّة)", async () => {
    const wo = await createWorkOrder(
      { branchId: 1, baseVariantId: 1, title: "لوحة", salePrice: "50.00",
        items: [{ variantId: 1, productUnitId: 1, quantity: "2", baseQuantity: 2, unitPrice: "10", total: "20" }] } as any,
      actor,
    );
    const items = await db().select().from(s.workOrderItems).where(eq(s.workOrderItems.workOrderId, wo.workOrderId));
    expect(items).toHaveLength(0);
  });
});

describe("السحب الذاتي (claim) + منع سرقة أمر زميل", () => {
  it("فنّي يسحب أمراً واردًا غير مُسنَد ⇒ assignedTo = هو؛ وزميله لا يستطيع سحبه", async () => {
    const wo = await createWorkOrder({ branchId: 1, baseVariantId: 1, title: "بنر", salePrice: "30.00" }, actor);
    await caller(opCtx(2)).workOrders.claim({ workOrderId: wo.workOrderId });
    const row = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, wo.workOrderId)))[0];
    expect(Number(row.assignedTo)).toBe(2);
    // الزميل (٣) لا يسرق أمراً مسحوباً لـ(٢).
    await expect(caller(opCtx(3)).workOrders.claim({ workOrderId: wo.workOrderId })).rejects.toThrow();
  });

  it("لا يُسحب أمر إلا في الطابور الوارد (RECEIVED)", async () => {
    const wo = await createWorkOrder({ branchId: 1, baseVariantId: 1, title: "x", salePrice: "30.00" }, actor);
    await caller(opCtx(2)).workOrders.claim({ workOrderId: wo.workOrderId });
    await caller(opCtx(2)).workOrders.start({ workOrderId: wo.workOrderId }); // RECEIVED→IN_PROGRESS
    await expect(caller(opCtx(3)).workOrders.claim({ workOrderId: wo.workOrderId })).rejects.toThrow();
  });
});

describe("عزل المحطة: الفني ينفّذ أوامره فقط، ولا يُسلّم", () => {
  it("فنّي غير المالك لا يبدأ الأمر؛ والمالك يبدأ", async () => {
    const wo = await createWorkOrder({ branchId: 1, baseVariantId: 1, title: "كرت", salePrice: "30.00" }, actor);
    await caller(opCtx(2)).workOrders.claim({ workOrderId: wo.workOrderId });
    await expect(caller(opCtx(3)).workOrders.start({ workOrderId: wo.workOrderId })).rejects.toThrow();
    await caller(opCtx(2)).workOrders.start({ workOrderId: wo.workOrderId });
    const row = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, wo.workOrderId)))[0];
    expect(row.status).toBe("IN_PROGRESS");
  });

  it("فنّي المطبعة لا يُسلّم/يُصدر فاتورة (أقلّ امتياز — cashierProcedure)", async () => {
    const wo = await createWorkOrder({ branchId: 1, baseVariantId: 1, title: "درع", salePrice: "30.00" }, actor);
    await caller(opCtx(2)).workOrders.claim({ workOrderId: wo.workOrderId });
    await caller(opCtx(2)).workOrders.start({ workOrderId: wo.workOrderId });
    await caller(opCtx(2)).workOrders.markReady({ workOrderId: wo.workOrderId });
    await expect(
      caller(opCtx(2)).workOrders.deliver({ workOrderId: wo.workOrderId, payment: { amount: "30.00", method: "CASH" } }),
    ).rejects.toThrow();
  });
});
