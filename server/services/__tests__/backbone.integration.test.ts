import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { transferBetweenBranches } from "../inventoryService";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { returnSale } from "../returnService";
import { createSale, processPayment } from "../saleService";
import { closeShift, openShift as openShiftSvc } from "../shiftService";
import { assignBarcode, createProduct, getProductForEdit, lookupByBarcode, updateProduct } from "../catalogService";
import {
  cancelWorkOrder,
  createWorkOrder,
  deliverWorkOrder,
  markWorkOrderReady,
  startWorkOrder,
} from "../workOrderService";
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

describe("شراء: استلام جزئي ثم استلام تكميلي مع دفعة", () => {
  it("الجزئي يُبقي الحالة CONFIRMED + يقيّد ما استُلم فقط؛ التكميلي يُكمل ويسجّل دفعة OUT", async () => {
    await setStock(1, 1, 0);
    await db().insert(s.suppliers).values({ id: 1, name: "مورد جزئي", currentBalance: "0" });
    // أمر بـ100 قطعة بسعر 5 — إجمالي 500
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId: 1, productUnitId: 1, quantity: "100", unitPrice: "5.00" }] },
      actor
    );
    const poItem = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];

    // استلام جزئي 30 — لا دفعة
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 30 }] }, actor);
    expect(await stockOf(1, 1)).toBe(30);
    let poRow = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, po.purchaseOrderId)))[0];
    expect(poRow.status).toBe("CONFIRMED"); // ليس مُستلَماً بعد
    let sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("150.00"); // 30 × 5

    // استلام تكميلي 70 + دفعة 200 نقد
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 70 }],
        payment: { amount: "200.00", method: "CASH" },
      },
      actor
    );
    expect(await stockOf(1, 1)).toBe(100);
    poRow = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, po.purchaseOrderId)))[0];
    expect(poRow.status).toBe("RECEIVED");
    expect(poRow.paidAmount).toBe("200.00");

    // ذمة المورد = 500 (شراء) − 200 (دفعة) = 300
    sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("300.00");

    // قيدا PURCHASE (150 + 350) + قيد PAYMENT_OUT (200)
    const pe = await entries("PURCHASE");
    expect(pe).toHaveLength(2);
    expect(pe.map((e) => e.amount).sort()).toEqual(["150.00", "350.00"]);
    const pout = await entries("PAYMENT_OUT");
    expect(pout).toHaveLength(1);
    expect(pout[0].amount).toBe("200.00");

    // إيصال OUT للدفعة
    const out = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe("200.00");
  });

  it("لا يُسمح بتجاوز الكمية المطلوبة في الاستلام", async () => {
    await setStock(1, 1, 0);
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5.00" }] },
      actor
    );
    const poItem = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    await expect(
      receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 11 }] }, actor)
    ).rejects.toThrow();
    expect(await stockOf(1, 1)).toBe(0);
  });
});

describe("أوامر الشغل/المطبعة", () => {
  it("دورة كاملة: إنشاء → بدء (خصم مواد) → جاهز → تسليم (فاتورة WORKORDER + قيد SALE + نقد)", async () => {
    await setStock(1, 1, 10); // مخزون الأساس (قلم — يُستخدم كمنتج أساس بسيط)
    // مادة إضافية: متغيّر آخر
    await db().insert(s.products).values({ id: 99, name: "حبر طباعة" });
    await db().insert(s.productVariants).values({ id: 99, productId: 99, sku: "INK-BL", costPrice: "20.00" });
    await db().insert(s.productUnits).values({ id: 99, variantId: 99, unitName: "علبة", conversionFactor: "1", isBaseUnit: true });
    await db().insert(s.branchStock).values({ variantId: 99, branchId: 1, quantity: 5 });

    const r = await createWorkOrder(
      {
        branchId: 1,
        baseVariantId: 1,
        title: "درع تكريم — مناسبة",
        quantity: 2,
        laborCost: "100.00",
        salePrice: "500.00",
        materials: [{ variantId: 99, baseQuantity: 1 }],
      },
      actor
    );
    expect(r.orderNumber).toMatch(/^WO-1-\d{8}-00001$/);

    // RECEIVED → IN_PROGRESS: خصم المادة (1 من INK-BL)
    await startWorkOrder(r.workOrderId, actor);
    expect(await stockOf(99, 1)).toBe(4);
    let wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, r.workOrderId)))[0];
    expect(wo.status).toBe("IN_PROGRESS");
    expect(wo.materialsCost).toBe("20.00"); // 1 × 20.00
    const mats = await db().select().from(s.workOrderMaterials).where(eq(s.workOrderMaterials.workOrderId, r.workOrderId));
    expect(mats[0].unitCost).toBe("20.00"); // snapshot

    // IN_PROGRESS → READY
    await markWorkOrderReady(r.workOrderId);
    wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, r.workOrderId)))[0];
    expect(wo.status).toBe("READY");

    // READY → DELIVERED مع دفعة نقدية كاملة 500
    const d = await deliverWorkOrder({ workOrderId: r.workOrderId, payment: { amount: "500.00", method: "CASH" } }, actor);
    wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, r.workOrderId)))[0];
    expect(wo.status).toBe("DELIVERED");
    expect(wo.invoiceId).toBe(d.invoiceId);
    expect(wo.deliveredAt).not.toBeNull();

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, d.invoiceId)))[0];
    expect(inv.sourceType).toBe("WORKORDER");
    expect(inv.total).toBe("500.00");
    expect(inv.costTotal).toBe("120.00"); // مواد 20 + عمالة 100
    expect(inv.paidAmount).toBe("500.00");
    expect(inv.status).toBe("PAID");

    // قيد SALE + قيد PAYMENT_IN + إيصال IN
    const sale = (await entries("SALE"))[0];
    expect(sale.revenue).toBe("500.00");
    expect(sale.cost).toBe("120.00");
    expect(sale.profit).toBe("380.00");

    const pin = await entries("PAYMENT_IN");
    expect(pin).toHaveLength(1);
    expect(pin[0].amount).toBe("500.00");

    const inn = await db().select().from(s.receipts).where(eq(s.receipts.direction, "IN"));
    expect(inn).toHaveLength(1);
    expect(inn[0].amount).toBe("500.00");

    // التسليم لا يلمس المخزون مرة أخرى (المواد خُصمت عند البدء)
    expect(await stockOf(99, 1)).toBe(4);
  });

  it("إلغاء بعد البدء: المواد تعود للمخزون والحالة CANCELLED", async () => {
    await db().insert(s.products).values({ id: 99, name: "حبر" });
    await db().insert(s.productVariants).values({ id: 99, productId: 99, sku: "INK-X", costPrice: "10.00" });
    await db().insert(s.productUnits).values({ id: 99, variantId: 99, unitName: "علبة", conversionFactor: "1", isBaseUnit: true });
    await db().insert(s.branchStock).values({ variantId: 99, branchId: 1, quantity: 3 });

    const r = await createWorkOrder(
      { branchId: 1, baseVariantId: 1, title: "بنر إعلاني", quantity: 1, salePrice: "200.00", materials: [{ variantId: 99, baseQuantity: 2 }] },
      actor
    );
    await startWorkOrder(r.workOrderId, actor);
    expect(await stockOf(99, 1)).toBe(1);
    await cancelWorkOrder(r.workOrderId, actor);
    expect(await stockOf(99, 1)).toBe(3); // عادت
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, r.workOrderId)))[0];
    expect(wo.status).toBe("CANCELLED");
    // لا فاتورة، لا قيد SALE
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await entries("SALE")).toHaveLength(0);
  });

  it("رفض البيع الآجل بلا عميل", async () => {
    const r = await createWorkOrder(
      { branchId: 1, baseVariantId: 1, title: "أمر بسيط", quantity: 1, salePrice: "300.00" },
      actor
    );
    await startWorkOrder(r.workOrderId, actor);
    await markWorkOrderReady(r.workOrderId);
    await expect(
      deliverWorkOrder({ workOrderId: r.workOrderId, payment: { amount: "100.00", method: "CASH" } }, actor)
    ).rejects.toThrow();
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

describe("الكتالوج: تعديل المنتج", () => {
  it("updateProduct: إعادة تسمية + إضافة وحدة جديدة + تعديل سعر + إلغاء وحدة قديمة", async () => {
    // ابدأ بمنتج له وحدة قطعة فقط
    const c = await createProduct(
      {
        name: "ورقة A4",
        variants: [
          {
            sku: "PAPER-A4",
            costPrice: "50.00",
            units: [
              { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "100.00" }] },
            ],
          },
        ],
      },
      actor
    );
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, "PAPER-A4")))[0];
    const baseUnit = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];

    // عدّل: اسم جديد + سعر RETAIL جديد + أضف وحدة "رزمة" بمعامل 100 وسعر مفرد
    await updateProduct(
      {
        productId: c.productId,
        name: "ورقة A4 — تعديل",
        variants: [
          {
            id: Number(v.id),
            sku: "PAPER-A4",
            costPrice: "55.00",
            units: [
              { id: Number(baseUnit.id), unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "120.00" }] },
              { unitName: "رزمة", conversionFactor: "100", isBaseUnit: false, prices: [{ priceTier: "RETAIL", price: "10000.00" }] },
            ],
          },
        ],
      },
      actor
    );

    const updated = await getProductForEdit(c.productId);
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("ورقة A4 — تعديل");
    expect(updated!.variants[0].costPrice).toBe("55.00");
    expect(updated!.variants[0].units).toHaveLength(2);
    const baseAfter = updated!.variants[0].units.find((u) => u.isBaseUnit)!;
    expect(baseAfter.prices.find((p) => p.priceTier === "RETAIL")!.price).toBe("120.00");
    const newUnit = updated!.variants[0].units.find((u) => !u.isBaseUnit)!;
    expect(newUnit.unitName).toBe("رزمة");
    expect(newUnit.prices[0].price).toBe("10000.00");

    // الآن احذف الوحدة الجديدة → ينبغي إلغاء تفعيلها (لا حذف نهائي)
    await updateProduct(
      {
        productId: c.productId,
        name: "ورقة A4 — تعديل",
        variants: [
          {
            id: Number(v.id),
            sku: "PAPER-A4",
            costPrice: "55.00",
            units: [{ id: Number(baseUnit.id), unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "120.00" }] }],
          },
        ],
      },
      actor
    );
    const after = await getProductForEdit(c.productId);
    expect(after!.variants[0].units).toHaveLength(1); // getProductForEdit يُرجع النشط فقط
    const allUnits = await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id)));
    expect(allUnits).toHaveLength(2); // ما زالت في DB
    expect(allUnits.find((u) => !u.isBaseUnit)!.isActive).toBe(false);
  });

  it("updateProduct يرفض غياب وحدة الأساس", async () => {
    const c = await createProduct(
      { name: "تجربة", variants: [{ sku: "T-1", costPrice: "1.00", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }] }] },
      actor
    );
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, "T-1")))[0];
    const u = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];
    await expect(
      updateProduct(
        {
          productId: c.productId,
          name: "تجربة",
          variants: [
            { id: Number(v.id), sku: "T-1", costPrice: "1.00", units: [{ id: Number(u.id), unitName: "قطعة", conversionFactor: "1", isBaseUnit: false }] },
          ],
        },
        actor
      )
    ).rejects.toThrow();
  });
});

describe("الكتالوج: إنشاء منتج بمخزون افتتاحي", () => {
  it("createProduct يُنشئ منتجاً + متغيّراً + وحدات + أسعاراً + مخزوناً افتتاحياً", async () => {
    const r = await createProduct(
      {
        name: "منتج اختبار",
        variants: [
          {
            sku: "TST-1",
            costPrice: "100.00",
            openingStock: 50,
            units: [
              { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "TSTBC1", prices: [{ priceTier: "RETAIL", price: "150.00" }, { priceTier: "WHOLESALE", price: "130.00" }] },
              { unitName: "درزن", conversionFactor: "12", isBaseUnit: false, prices: [{ priceTier: "RETAIL", price: "1700.00" }] },
            ],
          },
        ],
      },
      actor
    );
    expect(r.productId).toBeGreaterThan(0);
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, "TST-1")))[0];
    expect(v).toBeTruthy();
    expect(await stockOf(Number(v.id), 1)).toBe(50); // المخزون الافتتاحي
    const units = await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id)));
    expect(units).toHaveLength(2);
    const baseUnit = units.find((u) => u.isBaseUnit)!;
    const prices = await db().select().from(s.productPrices).where(eq(s.productPrices.productUnitId, Number(baseUnit.id)));
    expect(prices.map((p) => p.priceTier).sort()).toEqual(["RETAIL", "WHOLESALE"]);
  });
});

describe("الكتالوج: إسناد الباركود (ملصقات)", () => {
  it("assignBarcode يحفظ باركوداً داخلياً لوحدة بلا باركود ويصبح قابلاً للمسح", async () => {
    const r = await createProduct(
      { name: "صنف بلا باركود", variants: [{ sku: "NOBC-1", costPrice: "10.00", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "20.00" }] }] }] },
      actor
    );
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, "NOBC-1")))[0];
    const unit = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];
    expect(unit.barcode).toBeNull();

    const code = "ALR0000999";
    await assignBarcode(Number(unit.id), code);

    const after = (await db().select().from(s.productUnits).where(eq(s.productUnits.id, Number(unit.id))))[0];
    expect(after.barcode).toBe(code);

    // قابل للمسح عبر lookupByBarcode
    const row = await lookupByBarcode(code, 1, "RETAIL");
    expect(row).not.toBeNull();
    expect(row!.sku).toBe("NOBC-1");
  });

  it("assignBarcode يرفض باركوداً مُستخدَماً لوحدة أخرى", async () => {
    const r1 = await createProduct(
      { name: "أول", variants: [{ sku: "A-1", costPrice: "1.00", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "DUP-100" }] }] },
      actor
    );
    const r2 = await createProduct(
      { name: "ثانٍ", variants: [{ sku: "B-1", costPrice: "1.00", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }] }] },
      actor
    );
    void r1;
    const v2 = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, "B-1")))[0];
    const u2 = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v2.id))))[0];
    await expect(assignBarcode(Number(u2.id), "DUP-100")).rejects.toThrow();
  });
});
