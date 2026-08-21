// مرتجع شراء من **أمر دولاري** بتسوية «خصم من ذمة المورد» — لم تكن له تغطيةٌ إطلاقاً،
// وهو المسار الذي سقط على الإنتاج ٢١/٨/٢٦ (بلاغ المالك «تعذّر إتمام مرتجع الشراء»).
//
// الجذر لم يكن منطقياً بل **اسم عمود**: `purchaseReturns.settlement` كان معرَّفاً في
// `drizzle/schema.ts` بـ`mysqlEnum("purchaseReturnSettlement", …)` — وأوّلُ معامل mysqlEnum
// هو اسمُ العمود لا اسمُ النوع — بينما هجرة 0239 أنشأته باسمه الحقيقيّ `settlement`.
// قاعدةُ الاختبار تُبنى بـ`db:push` من schema.ts فتحمل الاسم الخاطئ نفسه ⇒ أخضرُ كاذب،
// والإنتاج المبنيُّ بالهجرات يردّ `Unknown column`. يحرس الاسمَ الآن `pnpm check:schema-drift`،
// ويحرس هذا الملفُّ أثرَ المسار نفسه (ذمّة دينارية + ذمّة دولارية + مخزون + قيد).
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createPurchaseReturn } from "../purchaseReturnsService";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const TABLES = [
  "documentPrintEvents", "purchaseReturnItems", "purchaseReturns", "accountingEntries", "receipts",
  "idempotencyKeys", "inventoryMovements", "branchStock", "purchaseOrderItems", "purchaseOrders",
  "productPrices", "productUnits", "productVariants", "products", "auditLogs", "suppliers", "branches", "users",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  await db().insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "pr_usd_admin", name: "مدير المشتريات", role: "admin", loginMethod: "local", isOwner: false });
  await db().insert(s.products).values({ id: 1, name: "سبايرول حلزوني قياس ٨ ملم" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PR-WHT-8", costPrice: "0.00" });
  // وحدة الأساس «قطعة»، ووحدة الشراء «باكيت» بمعامل ١٢ — كما في مستند المورّد الحقيقي.
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await db().insert(s.productUnits).values({ id: 2, variantId: 1, unitName: "باكيت", conversionFactor: "12", isBaseUnit: false });
  await db().insert(s.suppliers).values({ id: 1, name: "قرطاسية برهم", currentBalance: "0", currentBalanceUsd: "0" });
}

/** أمرٌ دولاريّ (سعر تثبيت ١٥٥٠) مستلَمٌ كاملاً: ١٠ باكيت × ٣٫٥ ‎$‎ = ٣٥ ‎$‎ = ٥٤٬٢٥٠ د.ع. */
async function receivedUsdOrder() {
  const created = await createPurchaseOrder({
    supplierId: 1,
    branchId: 1,
    status: "CONFIRMED",
    agreedCurrency: "USD",
    agreedRate: "1550",
    usdTotal: "35",
    taxRatePercent: "0",
    items: [{ variantId: 1, productUnitId: 2, quantity: "10", unitPrice: "3.5" }],
  }, actor);
  const item = (await db().select().from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId)))[0];
  await receivePurchase({
    purchaseOrderId: created.purchaseOrderId,
    lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: Number(item.baseQuantity) }],
  }, actor);
  return { poId: created.purchaseOrderId, itemId: Number(item.id) };
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("مرتجع شراء من أمر دولاري — خصم من ذمة المورد", () => {
  it("يحفظ المستند بتسويته وطريقته، ويعكس الذمّة بالدينار والدولار والمخزون معاً", async () => {
    const { poId, itemId } = await receivedUsdOrder();

    const res = await createPurchaseReturn({
      clientRequestId: "pr-usd-credit-1",
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: poId,
      items: [{ purchaseOrderItemId: itemId, quantity: "10" }],
      settlement: "CREDIT",
      paymentMethod: "CASH",
    }, actor);

    expect(res.returnedTotal).toBe("54250.00");
    expect(res.cashRefundAmount).toBe("0.00");
    expect(res.creditOffsetAmount).toBe("54250.00");

    // المستند نفسه — قراءةُ `settlement`/`paymentMethod` تفشل إن انحرف اسم العمود عن الهجرة.
    const doc = (await db().select().from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, res.purchaseReturnId)))[0];
    expect(doc.settlement).toBe("CREDIT");
    expect(doc.paymentMethod).toBe("CASH");
    expect(doc.totalAmount).toBe("54250.00");

    // الذمّة: الاستلام رفعها ٥٤٬٢٥٠ د.ع / ٣٥ ‎$‎، والمرتجع يُطفئها بالكامل بالعملتين.
    const supplier = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(supplier.currentBalance).toBe("0.00");
    expect(supplier.currentBalanceUsd).toBe("0.00");

    // لقطة المرتجع الدولاريّ على الأمر — بها يُرفض إرجاعٌ ثانٍ يتجاوز الفاتورة.
    const po = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, poId)))[0];
    expect(po.returnedUsd).toBe("35.00");

    // المخزون خرج بالوحدة الأساس (١٠ باكيت × ١٢)، والبند سُجّل مرتجعاً بسقفه الذرّي.
    const stock = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock)
      .where(and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1))))[0];
    expect(stock.q).toBe(0);
    const poItem = (await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.id, itemId)))[0];
    expect(poItem.returnedBaseQuantity).toBe(120);

    // قيد RETURN بقيمٍ سالبة، مربوطٌ بالمستند بمفتاح بنيويّ لا ببحثٍ عن «آخر مبلغ».
    const entry = (await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `PURCHASE_RETURN:${res.purchaseReturnId}`)))[0];
    expect(entry.entryType).toBe("RETURN");
    expect(entry.amount).toBe("-54250.00");
    expect(Number(doc.accountingEntryId)).toBe(Number(entry.id));
  });

  it("لا يُرجع أكثر من قيمة الفاتورة الدولارية القابلة للإرجاع", async () => {
    const { poId, itemId } = await receivedUsdOrder();
    await db().update(s.purchaseOrders).set({ returnedUsd: "35.00" })
      .where(eq(s.purchaseOrders.id, poId));

    await expect(createPurchaseReturn({
      clientRequestId: "pr-usd-credit-over",
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: poId,
      items: [{ purchaseOrderItemId: itemId, quantity: "10" }],
      settlement: "CREDIT",
      paymentMethod: "CASH",
    }, actor)).rejects.toThrow(/الدولارية تتجاوز/);
  });
});
