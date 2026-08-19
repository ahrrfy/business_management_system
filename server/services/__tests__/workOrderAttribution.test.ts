/**
 * نسبة فاتورة أمر الشغل (١٩/٨) — قاعدة #638: «العمولة تتبع البائع الأصليّ».
 *
 * الفجوة: فاتورة أمر الشغل تُنشأ **لحظة التسليم/الإرسال**، وقد ينفّذه كاشيرٌ آخر عن الذي
 * استقبل الطلب وباعه. فكان `createdBy = actor` ⇒ البيعُ والعمولةُ وتقريرُ الموظفين كلّها
 * للمُسلِّم، والبائع الحقيقيّ بلا أثر. مسارُ التصحيح كان يورّث `createdBy` صراحةً
 * (`attributeToUserId` في sale/correct) بينما مسارا التسليم والإرسال لا.
 *
 * والثابت المقابل: **أثر المُسلِّم يبقى كاملاً** — إيصال القبض باسمه، والفاتورة بورديّته
 * ⇒ النقد والدرج وZ عليه، وهو الصحيح مالياً (النقد في درجه هو).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createWorkOrder } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import { dispatchToDelivery } from "../delivery/dispatch";
import { openShift } from "../shiftService";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryConsignments",
  "deliveryParties", "orderPayments", "idempotencyKeys", "auditLogs", "accountingEntries",
  "receipts", "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
];

/** مستقبِل الطلب — البائع الحقيقيّ. */
const SELLER = { userId: 2, branchId: 1, role: "cashier" };
/** المُسلِّم — كاشيرٌ آخر في وردية لاحقة. */
const DELIVERER = { userId: 3, branchId: 1, role: "cashier" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  const d = db();
  await d.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const t of TABLES) await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
  await ensureFinancialPostingGate(d);
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "m", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "seller", name: "بائع الاستقبال", email: "s@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "deliv", name: "كاشير التسليم", email: "d@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "مندوب", partyKind: "INDIVIDUAL", currentBalance: "0.00", isActive: true },
  ]);
});

/** أمر شغلٍ ينشئه **البائع**، ويصير جاهزاً. */
async function orderBySeller(hasDelivery: boolean, reqId: string) {
  const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
  const wo = await createWorkOrder({
    branchId: 1, customerId: 1, title: "طلب", quantity: 1, salePrice: "10000.00",
    materials: [], deposit: "0", clientRequestId: reqId,
    ...(hasDelivery ? { hasDelivery: true, deliveryAddress: "بغداد", deliveryPhone: "+9647701234567" } : {}),
  } as never, SELLER);
  const woId = Number((wo as { workOrderId: number }).workOrderId);
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  return { woId, sellerShiftId: shift.shiftId };
}

const invoiceOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];

describe("نسبة فاتورة أمر الشغل — البيع لمنشئه لا لمُسلِّمه", () => {
  it("⭐ التسليم المباشر بيد كاشيرٍ آخر: الفاتورة منسوبةٌ للبائع، والقبض على المُسلِّم", async () => {
    const { woId } = await orderBySeller(false, "att-1");
    // المُسلِّم يفتح ورديّته الخاصة ويُسلّم ويقبض.
    const delivShift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 3, branchId: 1 });
    const res = await deliverWorkOrder(
      { workOrderId: woId, payment: { amount: "10000.00", method: "CASH" } },
      DELIVERER,
    );

    const inv = await invoiceOf(res.invoiceId);
    // النسبة التجارية: البائع.
    expect(Number(inv.createdBy)).toBe(SELLER.userId);
    expect(inv.salespersonNameSnapshot).toBe("بائع الاستقبال");
    // والأثر النقديّ: المُسلِّم ووردِيّته (النقد في درجه هو).
    expect(Number(inv.shiftId)).toBe(delivShift.shiftId);
    const receipt = (await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, res.invoiceId)))[0];
    expect(Number(receipt.createdBy)).toBe(DELIVERER.userId);
  });

  it("⭐ الإرسال للتوصيل بيد كاشيرٍ آخر: الفاتورة منسوبةٌ للبائع أيضاً", async () => {
    const { woId } = await orderBySeller(true, "att-2");
    const res = await dispatchToDelivery({ workOrderId: woId, partyId: 1, clientRequestId: "att-d2" }, DELIVERER);

    const inv = await invoiceOf(res.invoiceId);
    expect(Number(inv.createdBy)).toBe(SELLER.userId);
    expect(inv.salespersonNameSnapshot).toBe("بائع الاستقبال");
  });

  it("أمرٌ بلا منشئٍ معروف يسقط للفاعل (لا فاتورةَ بلا نسبة)", async () => {
    const { woId } = await orderBySeller(false, "att-3");
    await db().update(s.workOrders).set({ createdBy: null }).where(eq(s.workOrders.id, woId));
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 3, branchId: 1 });

    const res = await deliverWorkOrder({ workOrderId: woId }, DELIVERER);
    expect(Number((await invoiceOf(res.invoiceId)).createdBy)).toBe(DELIVERER.userId);
  });
});
