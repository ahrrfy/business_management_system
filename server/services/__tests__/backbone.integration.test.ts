import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { transferBetweenBranches } from "../inventoryService";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { returnSale } from "../returnService";
import { createSale, processPayment } from "../saleService";
import { closeShift, openShift as openShiftSvc } from "../shiftService";
import { withTx } from "../tx";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "purchaseOrderItems", "purchaseOrders", "workOrderMaterials", "workOrders",
  "onlineOrderItems", "onlineOrders", "attendance", "employees", "importBatches",
  "printJobs", "auditLogs", "customers", "suppliers", "categories", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const insertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

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
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "120.00" },
  ]);
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}
async function openShift(branchId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId: 1, openingBalance: "0", status: "OPEN" });
  return insertId(r);
}
async function stockOf(variantId: number, branchId: number): Promise<number> {
  const rows = await db()
    .select({ q: s.branchStock.quantity })
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return rows[0]?.q ?? 0;
}
async function entries(type: string) {
  return db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, type as any));
}
async function moves() {
  return db().select().from(s.inventoryMovements);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("العمود الفقري ثنائي الاتجاه", () => {
  it("بيع POS نقدي بوحدة الدرزن: يخصم 12 بالأساس + حركة OUT + قيد SALE + مقبوض + PAID", async () => {
    await setStock(1, 1, 24);
    const shiftId = await openShift(1);
    const r = await createSale(
      { branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }], payment: { amount: "120.00", method: "CASH" } },
      actor
    );
    expect(r.status).toBe("PAID");
    expect(await stockOf(1, 1)).toBe(12);

    const mv = await moves();
    expect(mv).toHaveLength(1);
    expect(mv[0].movementType).toBe("OUT");
    expect(mv[0].quantity).toBe(12);
    expect(mv[0].referenceType).toBe("INVOICE");

    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, r.invoiceId));
    expect(items[0].baseQuantity).toBe(12);
    expect(items[0].unitCost).toBe("4.00");
    expect(items[0].total).toBe("120.00");

    const sale = (await entries("SALE"))[0];
    expect(sale.revenue).toBe("120.00");
    expect(sale.cost).toBe("48.00");
    expect(sale.profit).toBe("72.00");
    expect(sale.amount).toBe("120.00");
    expect((await entries("PAYMENT_IN"))[0].amount).toBe("120.00");

    const rc = await db().select().from(s.receipts);
    expect(rc).toHaveLength(1);
    expect(rc[0].direction).toBe("IN");
    expect(rc[0].amount).toBe("120.00");
  });

  it("بيع آجل ثم دفعتان: PENDING → PARTIALLY_PAID → PAID والذمة تتناقص", async () => {
    await setStock(1, 1, 50);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "2" }] },
      actor
    );
    expect(sale.status).toBe("PENDING");
    expect(sale.total).toBe("240.00");
    let cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("240.00");
    expect(await entries("PAYMENT_IN")).toHaveLength(0);

    const p1 = await processPayment({ invoiceId: sale.invoiceId, amount: "100.00", method: "CASH" }, actor);
    expect(p1.status).toBe("PARTIALLY_PAID");
    cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("140.00");

    const p2 = await processPayment({ invoiceId: sale.invoiceId, amount: "140.00", method: "CASH" }, actor);
    expect(p2.status).toBe("PAID");
    cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("0.00");
    expect(await entries("PAYMENT_IN")).toHaveLength(2);
  });

  it("استلام شراء: المخزون يزيد + قيد PURCHASE + ذمة المورد (AP) + آخر تكلفة", async () => {
    await setStock(1, 1, 5);
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId: 1, productUnitId: 1, quantity: "100", unitPrice: "5.00" }] },
      actor
    );
    const poItem = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 100 }] }, actor);

    expect(await stockOf(1, 1)).toBe(105);
    const mv = await moves();
    expect(mv[0].movementType).toBe("IN");
    expect(mv[0].quantity).toBe(100);
    const poRow = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, po.purchaseOrderId)))[0];
    expect(poRow.status).toBe("RECEIVED");
    const pe = (await entries("PURCHASE"))[0];
    expect(pe.cost).toBe("500.00");
    expect(pe.amount).toBe("500.00");
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("500.00");
    const variant = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(variant.costPrice).toBe("5.00");
  });

  it("تحويل بين فرعين: ينقل الرصيد بحركتين دون فقد ولا قيد", async () => {
    await setStock(1, 1, 20);
    await withTx((tx) => transferBetweenBranches(tx, { variantId: 1, fromBranchId: 1, toBranchId: 2, baseQuantity: 8, createdBy: 1 }));
    expect(await stockOf(1, 1)).toBe(12);
    expect(await stockOf(1, 2)).toBe(8);
    const mv = await moves();
    const out = mv.find((m) => m.movementType === "TRANSFER_OUT")!;
    const inn = mv.find((m) => m.movementType === "TRANSFER_IN")!;
    expect(out.quantity).toBe(8);
    expect(Number(out.relatedBranchId)).toBe(2);
    expect(inn.quantity).toBe(8);
    expect(Number(inn.relatedBranchId)).toBe(1);
    expect(await entries("ADJUST")).toHaveLength(0);
  });

  it("مرتجع كامل: يعيد المخزون + قيد RETURN سالب + استرداد + RETURNED", async () => {
    await setStock(1, 1, 12);
    const shiftId = await openShift(1);
    const sale = await createSale(
      { branchId: 1, shiftId, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }], payment: { amount: "120.00", method: "CASH" } },
      actor
    );
    expect(await stockOf(1, 1)).toBe(0);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 12 }], refund: { amount: "120.00", method: "CASH" }, restock: true }, actor);

    expect(await stockOf(1, 1)).toBe(12);
    const ret = (await entries("RETURN"))[0];
    expect(ret.revenue).toBe("-120.00");
    expect(ret.cost).toBe("-48.00");
    expect(ret.profit).toBe("-72.00");
    expect(ret.amount).toBe("-120.00");
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.status).toBe("RETURNED");
    const out = (await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT")));
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe("120.00");
  });

  it("فشل في المنتصف → تراجع كامل (rollback)", async () => {
    await setStock(1, 1, 50);
    // متغيّر ثانٍ بمخزون صفر
    await db().insert(s.products).values({ id: 2, name: "دفتر" });
    await db().insert(s.productVariants).values({ id: 2, productId: 2, sku: "NB-1", costPrice: "4.00" });
    await db().insert(s.productUnits).values({ id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
    await db().insert(s.productPrices).values({ productUnitId: 3, priceTier: "RETAIL", price: "10.00" });
    await setStock(2, 1, 0);

    await expect(
      createSale(
        { branchId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }, { variantId: 2, productUnitId: 3, quantity: "1" }], payment: { amount: "20.00", method: "CASH" } },
        actor
      )
    ).rejects.toThrow();

    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.invoiceItems)).toHaveLength(0);
    expect(await moves()).toHaveLength(0);
    expect(await stockOf(1, 1)).toBe(50);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("بيع متزامن (oversell): لا رصيد سالب — واحد ينجح والآخر يُرفض", async () => {
    await setStock(1, 1, 3);
    const mk = (rid: string) =>
      createSale(
        { branchId: 1, sourceType: "POS", clientRequestId: rid, lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CASH" } },
        actor
      );
    const res = await Promise.allSettled([mk("c1"), mk("c2")]);
    const ok = res.filter((r) => r.status === "fulfilled");
    const fail = res.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(fail).toHaveLength(1);
    expect(await stockOf(1, 1)).toBe(1);
  });

  it("idempotency: نفس clientRequestId لا يُنشئ فاتورة مكررة", async () => {
    await setStock(1, 1, 24);
    const input = { branchId: 1, sourceType: "POS" as const, clientRequestId: "abc", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }], payment: { amount: "120.00", method: "CASH" as const } };
    const r1 = await createSale(input, actor);
    const r2 = await createSale(input, actor);
    expect(r2.invoiceId).toBe(r1.invoiceId);
    expect(r2.idempotentReplay).toBe(true);
    expect(await db().select().from(s.invoices)).toHaveLength(1);
    expect(await stockOf(1, 1)).toBe(12);
  });

  it("كمية تنتج baseQuantity كسرياً تُرفض", async () => {
    await setStock(1, 1, 24);
    await expect(
      createSale({ branchId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "0.5" }], payment: { amount: "5.00", method: "CASH" } }, actor)
    ).rejects.toThrow();
    expect(await db().select().from(s.invoices)).toHaveLength(0);
  });

  it("بيع آجل بلا عميل يُرفض", async () => {
    await setStock(1, 1, 24);
    await expect(
      createSale({ branchId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }] }, actor)
    ).rejects.toThrow();
    expect(await db().select().from(s.invoices)).toHaveLength(0);
  });
});

describe("إصلاحات المراجعة العدائية", () => {
  it("مرتجع فاتورة آجلة: يُرفض استرداد نقدي يتجاوز المدفوع، والذمة تنخفض بلا نقد", async () => {
    await setStock(1, 1, 12);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale({ branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }] }, actor);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    // فاتورة آجلة (paid=0): سقف الاسترداد = min(120, 0) = 0 → استرداد نقدي مرفوض
    await expect(
      returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 12 }], refund: { amount: "120.00", method: "CASH" } }, actor)
    ).rejects.toThrow();
    // إرجاع بلا استرداد نقدي → الذمة تنخفض إلى 0 بلا إيصال OUT
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 12 }] }, actor);
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("0.00");
    expect(await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"))).toHaveLength(0);
    expect(await stockOf(1, 1)).toBe(12);
  });

  it("مرتجع نقدي: يُنشئ قيد PAYMENT_OUT ويُخفّض paidAmount", async () => {
    await setStock(1, 1, 12);
    const shiftId = await openShift(1);
    const sale = await createSale({ branchId: 1, shiftId, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }], payment: { amount: "120.00", method: "CASH" } }, actor);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 12 }], refund: { amount: "120.00", method: "CASH" } }, actor);
    const po = await entries("PAYMENT_OUT");
    expect(po).toHaveLength(1);
    expect(po[0].amount).toBe("120.00");
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.paidAmount).toBe("0.00");
    expect(inv.status).toBe("RETURNED");
  });

  it("استلام شراء بالدرزن: قيد PURCHASE وAP يطابقان إجمالي أمر الشراء بالضبط (لا انجراف تقريب)", async () => {
    await setStock(1, 1, 0);
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    const po = await createPurchaseOrder({ supplierId: 1, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId: 1, productUnitId: 2, quantity: "1", unitPrice: "5.00" }] }, actor);
    expect(po.total).toBe("5.00");
    const poItem = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 12 }] }, actor);
    expect(await stockOf(1, 1)).toBe(12);
    const pe = (await entries("PURCHASE"))[0];
    expect(pe.cost).toBe("5.00");
    expect(pe.amount).toBe("5.00");
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("5.00");
  });

  it("idempotency متزامن: لا فاتورة مكررة عند نفس clientRequestId", async () => {
    await setStock(1, 1, 24);
    const input = {
      branchId: 1, sourceType: "POS" as const, clientRequestId: "dup",
      lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }],
      payment: { amount: "120.00", method: "CASH" as const },
    };
    await Promise.allSettled([createSale(input, actor), createSale(input, actor)]);
    expect(await db().select().from(s.invoices)).toHaveLength(1);
    expect(await stockOf(1, 1)).toBe(12);
  });
});

describe("إدارة الورديات (Z-report)", () => {
  it("فتح برصيد افتتاحي → بيع نقدي → إغلاق: المتوقع والفروقات صحيحة", async () => {
    await setStock(1, 1, 24);
    const { shiftId } = await openShiftSvc({ branchId: 1, openingBalance: "50.00" }, actor);
    await createSale(
      { branchId: 1, shiftId, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }], payment: { amount: "120.00", method: "CASH" } },
      actor
    );
    // النقد المتوقع = 50 (افتتاحي) + 120 (بيع نقدي) = 170
    const closed = await closeShift({ shiftId, countedCash: "165.00" }, actor);
    expect(closed.expectedCash).toBe("170.00");
    expect(closed.countedCash).toBe("165.00");
    expect(closed.variance).toBe("-5.00"); // عجز 5
  });

  it("لا يُسمح بوردية مفتوحة ثانية لنفس المستخدم/الفرع", async () => {
    await openShiftSvc({ branchId: 1, openingBalance: "0" }, actor);
    await expect(openShiftSvc({ branchId: 1, openingBalance: "0" }, actor)).rejects.toThrow();
  });
});
