import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { applyMovement } from "../inventoryService";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { returnSale } from "../returnService";
import { createSale, processPayment } from "../saleService";
import { closeShift } from "../shiftService";
import { withTx } from "../tx";
import { createWorkOrder, deliverWorkOrder, markWorkOrderReady, startWorkOrder } from "../workOrderService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
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
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}
async function openShift(branchId = 1, userId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId, openingBalance: "0", status: "OPEN" });
  return insertId(r);
}
async function receiptsByDirection(dir: "IN" | "OUT") {
  return db().select().from(s.receipts).where(eq(s.receipts.direction, dir));
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("تسوية الصندوق — نسب الإيصالات للوردية (إصلاح العجز/الفائض الوهمي)", () => {
  it("استرداد المرتجع النقدي يُنسب للوردية المفتوحة، والصندوق يتوازن", async () => {
    await setStock(1, 1, 24);
    const shiftId = await openShift(1);
    // بيع نقدي ضمن الوردية: قطعتان × 10 = 20، مدفوع 20.
    const sale = await createSale(
      { branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CASH" } },
      actor,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    // إرجاع قطعة واحدة باسترداد نقدي 10.
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" } }, actor);

    const out = await receiptsByDirection("OUT");
    expect(out).toHaveLength(1);
    expect(Number(out[0].shiftId)).toBe(shiftId); // ← الإصلاح: كان null فيظهر عجز وهمي

    // الصندوق يتوازن: متوقّع = 0 + 20 (داخل) − 10 (خارج) = 10.
    const close = await closeShift({ shiftId, countedCash: "10.00" }, actor);
    expect(close.expectedCash).toBe("10.00");
    expect(close.variance).toBe("0.00");
  });

  it("دفع تسليم أمر الشغل النقدي يُنسب للوردية المفتوحة", async () => {
    const shiftId = await openShift(1);
    const wo = await createWorkOrder({ branchId: 1, baseVariantId: 1, title: "درع تكريم", salePrice: "50.00" }, actor);
    await startWorkOrder(wo.workOrderId, actor);
    await markWorkOrderReady(wo.workOrderId);
    await deliverWorkOrder({ workOrderId: wo.workOrderId, payment: { amount: "50.00", method: "CASH" } }, actor);

    const inn = await receiptsByDirection("IN");
    expect(inn).toHaveLength(1);
    expect(Number(inn[0].shiftId)).toBe(shiftId); // ← الإصلاح: كان null فيظهر فائض وهمي

    const close = await closeShift({ shiftId, countedCash: "50.00" }, actor);
    expect(close.expectedCash).toBe("50.00");
    expect(close.variance).toBe("0.00");
  });

  it("دفع فاتورة آجلة (processPayment) يَشتقّ الوردية تلقائياً عند عدم تمريرها", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }] },
      actor,
    );
    const shiftId = await openShift(1);
    // لا يُمرَّر shiftId — يجب أن يُشتقّ من وردية الموظّف المفتوحة.
    await processPayment({ invoiceId: sale.invoiceId, amount: "10.00", method: "CASH" }, actor);

    const inn = await receiptsByDirection("IN");
    expect(inn).toHaveLength(1);
    expect(Number(inn[0].shiftId)).toBe(shiftId);
  });
});

describe("عزل الفروع (IDOR) — منع الدفع على فاتورة فرع آخر", () => {
  it("processPayment يَرفض فاتورة فرعٍ مغاير عند enforceBranchId", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] },
      actor,
    );
    // الفاتورة في الفرع 1؛ موظّف الفرع 2 يحاول الدفع ⇒ يُرفض.
    await expect(
      processPayment({ invoiceId: sale.invoiceId, amount: "5.00", method: "CASH", enforceBranchId: 2 }, actor),
    ).rejects.toThrow();
    // ونجاح عند الفرع الصحيح.
    const ok = await processPayment({ invoiceId: sale.invoiceId, amount: "5.00", method: "CASH", enforceBranchId: 1 }, actor);
    expect(ok.paidAmount).toBe("5.00");
  });
});

describe("أقفال المخزون — إنشاء الصفّ قبل القفل + زيادة نسبية", () => {
  it("applyMovement يُنشئ صفّ الرصيد عند غيابه ويزيد/ينقص نسبياً", async () => {
    // لا صفّ branchStock مسبقاً للمتغيّر 1 في الفرع 1.
    await withTx(async (tx) => {
      await applyMovement(tx, { variantId: 1, branchId: 1, baseQuantity: 5, movementType: "IN", referenceType: "TEST" });
      await applyMovement(tx, { variantId: 1, branchId: 1, baseQuantity: 3, movementType: "IN", referenceType: "TEST" });
      await applyMovement(tx, { variantId: 1, branchId: 1, baseQuantity: 2, movementType: "OUT", referenceType: "TEST" });
    });
    const row = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    expect(row.quantity).toBe(6); // 0 → +5 → +3 → −2
  });
});

describe("المرتجعات — سقف الاسترداد بالطريقة نفسها (لا يُفرّغ الصندوق ببيع بطاقة)", () => {
  it("يرفض استرداداً نقدياً لبيعٍ دُفع بالبطاقة", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      { branchId: 1, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CARD" } },
      actor,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    // الدفع كان بطاقةً ⇒ المتاح نقداً = 0 ⇒ يُرفض الاسترداد النقدي.
    await expect(
      returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" } }, actor),
    ).rejects.toThrow();
  });

  it("يسمح باسترداد نقدي لبيعٍ دُفع نقداً", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      { branchId: 1, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CASH" } },
      actor,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    const r = await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" } }, actor);
    expect(r.returnedTotal).toBe("10.00");
    const out = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe("10.00");
  });
});

describe("WAVG — متوسّط مرجّح صحيح لسطرين لنفس المتغيّر في أمر شراء واحد", () => {
  it("يحسب المتوسّط تسلسلياً (لا يطمس السطر الأول)", async () => {
    await db().update(s.productVariants).set({ costPrice: "0.00" }).where(eq(s.productVariants.id, 1));
    await db().insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "0" });
    const po = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "2.00" },
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "4.00" },
        ],
      },
      actor,
    );
    const its = await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId));
    await receivePurchase(
      { purchaseOrderId: po.purchaseOrderId, lines: its.map((i) => ({ purchaseOrderItemId: Number(i.id), receivedBaseQuantity: 10 })) },
      actor,
    );
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(v.costPrice).toBe("3.00"); // (10×2 + 10×4)/20 — وليس 4.00 (طمس السطر الأول)
    const row = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    expect(row.quantity).toBe(20);
  });
});

describe("ميزان المراجعة / التسوية المستقلّة — يوم كامل يتوازن (درج/ذمم/دفتر)", () => {
  it("درج النقد يتوازن عبر كل التدفّقات + الذمم صحيحة + ربح الدفتر = إيراد − تكلفة", async () => {
    await setStock(1, 1, 100);
    await db().insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const shRes = await db().insert(s.shifts).values({ branchId: 1, userId: 1, openingBalance: "100", status: "OPEN" });
    const shiftId = Number((shRes as any)[0]?.insertId ?? (shRes as any).insertId);

    // ١) بيع نقدي 20.
    const cashSale = await createSale(
      { branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CASH" } },
      actor,
    );
    // ٢) بيع آجل 30، مدفوع نقداً 10 (ذمة 20).
    await createSale(
      { branchId: 1, shiftId, customerId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }], payment: { amount: "10.00", method: "CASH" } },
      actor,
    );
    // ٣) دفعة لاحقة نقداً 5 (بلا shiftId ⇒ تُشتقّ تلقائياً — إصلاح الدفعة ١).
    const creditInv = (await db().select().from(s.invoices).where(eq(s.invoices.customerId, 1)))[0];
    await processPayment({ invoiceId: Number(creditInv.id), amount: "5.00", method: "CASH" }, actor);
    // ٤) مرتجع على البيع النقدي: قطعة باسترداد نقدي 10 (OUT يُنسب للوردية — إصلاح الدفعة ١).
    const cashItem = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, cashSale.invoiceId)))[0];
    await returnSale({ invoiceId: cashSale.invoiceId, lines: [{ invoiceItemId: Number(cashItem.id), baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" } }, actor);
    // ٥) أمر شغل يُسلَّم نقداً 50 (IN يُنسب للوردية — إصلاح الدفعة ١).
    const wo = await createWorkOrder({ branchId: 1, baseVariantId: 1, title: "درع", salePrice: "50.00" }, actor);
    await startWorkOrder(wo.workOrderId, actor);
    await markWorkOrderReady(wo.workOrderId);
    await deliverWorkOrder({ workOrderId: wo.workOrderId, payment: { amount: "50.00", method: "CASH" } }, actor);

    // تسوية مستقلّة للدرج: اشتقاق النقد من receipts مباشرةً.
    const cashRows = await db()
      .select({
        cin: sql<string>`COALESCE(SUM(CASE WHEN ${s.receipts.direction}='IN' AND ${s.receipts.paymentMethod}='CASH' THEN ${s.receipts.amount} ELSE 0 END),0)`,
        cout: sql<string>`COALESCE(SUM(CASE WHEN ${s.receipts.direction}='OUT' AND ${s.receipts.paymentMethod}='CASH' THEN ${s.receipts.amount} ELSE 0 END),0)`,
      })
      .from(s.receipts)
      .where(eq(s.receipts.shiftId, shiftId));
    expect(Number(cashRows[0].cin)).toBe(85); // 20 + 10 + 5 + 50 — كلها منسوبة للوردية
    expect(Number(cashRows[0].cout)).toBe(10); // الاسترداد

    // الدرج يتوازن: المتوقّع = 100 + 85 − 10 = 175 (لا عجز/فائض وهمي).
    const close = await closeShift({ shiftId, countedCash: "175.00" }, actor);
    expect(close.expectedCash).toBe("175.00");
    expect(close.variance).toBe("0.00");

    // الذمم: AR للعميل = 30 − 10 − 5 = 15.
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("15.00");

    // ربح الدفتر متّسق: profit == revenue − cost لكل قيد (ميزان البُعد الربحي).
    const ents = await db().select().from(s.accountingEntries);
    expect(ents.length).toBeGreaterThan(0);
    for (const e of ents) {
      expect(Number(e.profit)).toBeCloseTo(Number(e.revenue) - Number(e.cost), 2);
    }
  });
});
