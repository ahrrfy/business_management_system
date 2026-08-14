// الشحن/الكمرك على أمر الشراء — **قرار المالك ٥/٨/٢٦**: «الشحن يُسجَّل مصروفاً لحظة الاستلام
// وتكلفة الصنف سعر المورّد فقط؛ الشحن مصاريف علينا ولا دخل للمورّد به.»
//
// نسخت هذه الاختبارات سياسةً سابقة (رسملة الشحن في WAVG + إضافته لذمّة المورّد، #311) وأُعيدت
// كتابتها بالكامل. الثوابت الأربعة الآن:
//   (١) `purchaseOrders.total` = البضاعة + الضريبة فقط — الشحن يُخزَّن ولا يدخل الإجمالي/الذمّة.
//   (٢) WAVG بعد الاستلام = **سعر المورّد وحده** (لا حصّة شحن) ⇒ COGS عند البيع لا يحمل الشحن.
//   (٣) رصيد المورّد يرتفع بالبضاعة + الضريبة فقط، وقيد PURCHASE.cost = البضاعة.
//   (٤) الشحن يُسجَّل **صفّ مصروفٍ حقيقياً** (فئة نقل) + إيصال صرف + قيد PAYMENT_OUT، بحصّةٍ
//       متناسبة مع المستلَم فعلاً (Σ عبر الاستلامات = الشحن بالضبط، لا انجراف).
// الجمع بين (٢) و(٤) محظور: لو رُسمِل الشحن **وسُجّل** مصروفاً لاحتُسِب مرّتين فينقص الربح ضعفاً.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["idempotencyKeys", "accountingEntries", "expenses", "receipts", "inventoryMovements", "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices", "productUnits", "productVariants", "products", "suppliers", "branches", "users"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 1,
  });
  await d.insert(s.products).values([{ id: 1, name: "ورق" }, { id: 2, name: "حبر" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "P-1", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "P-2", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
}
beforeEach(async () => { await reset(); await seed(); });

async function costOf(variantId: number): Promise<string> {
  const r = (await db().select({ c: s.productVariants.costPrice }).from(s.productVariants).where(eq(s.productVariants.id, variantId)))[0];
  return String(r?.c);
}
async function supplierBalance(): Promise<string> {
  const r = (await db().select({ b: s.suppliers.currentBalance }).from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
  return String(r?.b);
}
async function itemsOf(poId: number) {
  return db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, poId)).orderBy(s.purchaseOrderItems.id);
}
async function entries() {
  return db().select().from(s.accountingEntries).orderBy(s.accountingEntries.id);
}
async function expenseRows() {
  return db().select().from(s.expenses).orderBy(s.expenses.id);
}

/** أمرٌ بقيمة بضاعة ٤٬٠٠٠ وشحن+كمرك ٤٠٠ (بلا ضريبة). */
async function orderWithShipping(shipping = "300", customs = "100") {
  return createPurchaseOrder(
    {
      supplierId: 1, branchId: 1, taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }, // 1,000
        { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" },  // 3,000
      ],
      shippingCost: shipping, customsCost: customs,
    },
    actor,
  );
}

describe("الشحن/الكمرك — مصروفُ شركةٍ لا ذمّةُ مورّد ولا تكلفةُ صنف", () => {
  it("(١) إجمالي أمر الشراء = البضاعة + الضريبة فقط، والشحن يُخزَّن خارجه", async () => {
    const po = await orderWithShipping();
    const row = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, po.purchaseOrderId)))[0];
    expect(row.subtotal).toBe("4000.00");
    expect(row.shippingCost).toBe("300.00");
    expect(row.customsCost).toBe("100.00");
    // ٤٬٠٠٠ لا ٤٬٤٠٠: المورّد لم يبِعنا الشحن، فلا يدخل ما نُطالَب به.
    expect(row.total).toBe("4000.00");
  });

  it("(٢+٣) استلام كامل: WAVG = سعر المورّد وحده، والذمّة = البضاعة، وقيد PURCHASE بلا شحن", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      { purchaseOrderId: po.purchaseOrderId, lines: items.map((i) => ({ purchaseOrderItemId: Number(i.id), receivedBaseQuantity: i.baseQuantity })) },
      actor,
    );
    // سعر المورّد: ١٠٠ و٦٠٠ — بلا أيّ حصّة شحن مُضافة (كانت ١١٠ و٦٦٠ في السياسة الملغاة).
    expect(await costOf(1)).toBe("100.00");
    expect(await costOf(2)).toBe("600.00");
    expect(await supplierBalance()).toBe("4000.00");
    const purchase = (await entries()).filter((e) => e.entryType === "PURCHASE");
    expect(purchase).toHaveLength(1);
    expect(purchase[0].cost).toBe("4000.00");
    expect(purchase[0].amount).toBe("4000.00");
  });

  it("(٤) الاستلام يُنشئ مصروف نقلٍ حقيقياً بالشحن كاملاً + قيد PAYMENT_OUT", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      { purchaseOrderId: po.purchaseOrderId, lines: items.map((i) => ({ purchaseOrderItemId: Number(i.id), receivedBaseQuantity: i.baseQuantity })) },
      actor,
    );
    const exps = await expenseRows();
    expect(exps).toHaveLength(1);
    expect(exps[0].category).toBe("TRANSPORT");
    expect(exps[0].amount).toBe("400.00"); // ٣٠٠ شحن + ١٠٠ كمرك
    expect(exps[0].status).toBe("ACTIVE");
    expect(exps[0].receiptId).not.toBeNull();

    const payOut = (await entries()).filter((e) => e.entryType === "PAYMENT_OUT");
    expect(payOut).toHaveLength(1);
    expect(payOut[0].amount).toBe("400.00");
    // المصروف **ليس** على المورّد: القيد بلا supplierId فلا يظهر حركةً في كشف حسابه.
    expect(payOut[0].supplierId).toBeNull();
    // وإيصال صرفٍ فعليّ خرج به النقد.
    const rcpts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    expect(rcpts).toHaveLength(1);
    expect(rcpts[0].direction).toBe("OUT");
    expect(rcpts[0].amount).toBe("400.00");
  });

  it("الاستلام الجزئيّ: المصروف متناسب، وΣ عبر الاستلامات = الشحن بالضبط", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    // الدفعة الأولى: نصف كمية البند الأول فقط.
    await receivePurchase(
      { purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(items[0].id), receivedBaseQuantity: 5 }] },
      actor,
    );
    const first = await expenseRows();
    expect(first).toHaveLength(1);
    // حصّة البند الأول من الشحن = ٤٠٠ × (1000/4000) = ١٠٠، ونصفها = ٥٠.
    expect(first[0].amount).toBe("50.00");
    expect(await supplierBalance()).toBe("500.00"); // بضاعة الدفعة وحدها

    // بقيّة الكميات.
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [
          { purchaseOrderItemId: Number(items[0].id), receivedBaseQuantity: 5 },
          { purchaseOrderItemId: Number(items[1].id), receivedBaseQuantity: items[1].baseQuantity },
        ],
      },
      actor,
    );
    const all = await expenseRows();
    const sum = all.reduce((a, e) => a + Number(e.amount), 0);
    expect(sum).toBeCloseTo(400, 2); // لا انجراف تقريب
    expect(await supplierBalance()).toBe("4000.00");
    expect(await costOf(1)).toBe("100.00"); // ما زال سعر المورّد وحده
  });

  it("أمرٌ بلا شحن ⇒ لا مصروف ولا إيصال (حارس انحدار)", async () => {
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, taxRatePercent: "0", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }] },
      actor,
    );
    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      { purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(items[0].id), receivedBaseQuantity: items[0].baseQuantity }] },
      actor,
    );
    expect(await expenseRows()).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT")),
    ).toHaveLength(0);
    expect(await costOf(1)).toBe("100.00");
    expect(await supplierBalance()).toBe("1000.00");
  });

  it("نقص الخزينة عند دفع الشحن ⇒ rollback للاستلام والمخزون والذمة والمصروف", async () => {
    await db()
      .delete(s.receipts)
      .where(eq(s.receipts.referenceNumber, "TEST-TREASURY-FUND"));
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);

    await expect(
      receivePurchase(
        {
          purchaseOrderId: po.purchaseOrderId,
          lines: items.map((item) => ({
            purchaseOrderItemId: Number(item.id),
            receivedBaseQuantity: item.baseQuantity,
          })),
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(await costOf(1)).toBe("0.00");
    expect(await costOf(2)).toBe("0.00");
    expect(await supplierBalance()).toBe("0.00");
    expect(await expenseRows()).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect((await entries()).filter((e) => e.entryType === "PURCHASE")).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT")),
    ).toHaveLength(0);
  });

  it("حارس: شحن سالب ⇒ BAD_REQUEST", async () => {
    await expect(orderWithShipping("-1", "0")).rejects.toThrow(/سالب/);
  });
});
