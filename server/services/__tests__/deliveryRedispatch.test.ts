/**
 * إعادة الإسناد بعد إلغائه (١٩/٨) — تبديل المندوب حدثٌ يوميّ.
 *
 * الفجوة التي يسدّها: `cancelDeliveryAssignment` «فكّ إسنادٍ» لا عكسُ بيع — يحرّر تعرّض
 * الجهة ويُبقي الفاتورة وقيد البيع وذمّة العميل حيّةً (وهو الصحيح: البضاعة ما زالت مباعة).
 * لكنّ الإسناد الثاني كان يحاول إنشاء **فاتورةٍ وإرساليةٍ جديدتين** فيصطدم بقيدَين فريدين
 * (`uq_wo_invoice` و`uq_consignment_source`) ⇒ خطأ قاعدةٍ خامّ، والأمر محبوسٌ إلى الأبد
 * رغم عودته إلى طابور «جاهز للإرسال».
 *
 * العلاج (سابقة `dispatchInvoice.ts`): **إعادة تنشيط الصفّ الملغى في مكانه** وإعادة استعمال
 * الفاتورة — فلا SALE ثانٍ ولا ذمّةٌ مضاعفة، والقيدان الفريدان يبقيان حارسَين بنيويَّين.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelDeliveryAssignment } from "../delivery/cancellation";
import { dispatchToDelivery } from "../delivery/dispatch";
import { listInTransitConsignments, listReadyForDispatch } from "../delivery/queries";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "orderPayments", "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
];
const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  const d = db();
  // المسح داخل معاملة واحدة: `SET FOREIGN_KEY_CHECKS = 0` خاصيّةُ **جلسة**، و`execute`
  // المتتابعة قد تأخذ اتصالاتٍ مختلفة من المجمّع فيضيع التعطيل ويسقط الحذف على قيدٍ حيّ.
  await d.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const t of TABLES) await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
  // بوّابة الترحيل الماليّ صفٌّ ثابت خارج بيانات الاختبار — يُعاد ضمانُه بعد كل مسح
  // (withTx يُداويها ذاتياً لكن بعد تراجعٍ كامل؛ ضمانُها هنا يُبقي الاختبار حتمياً).
  await ensureFinancialPostingGate(d);
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "m", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "c", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "مندوب أول", partyKind: "INDIVIDUAL", currentBalance: "0.00", isActive: true },
    { id: 2, name: "مندوب ثانٍ", partyKind: "INDIVIDUAL", currentBalance: "0.00", isActive: true },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
});

async function readyOrder(reqId: string, salePrice = "20000.00") {
  const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
  const r = await checkoutReception({
    branchId: 1, shiftId: shift.shiftId, customerId: 1, paidAmount: "0", clientRequestId: reqId,
    workOrders: [{
      title: "طلب توصيل", quantity: 1, salePrice, materials: [],
      hasDelivery: true, deliveryAddress: "بغداد", deliveryPhone: "+9647701234567",
    }],
  }, CASHIER);
  const woId = r.workOrders[0].workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  return woId;
}
const balanceOf = async () =>
  Number((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance);

describe("إعادة الإسناد بعد الإلغاء — تبديل المندوب", () => {
  it("⭐ يُسنَد لجهةٍ أخرى بنجاح، بفاتورةٍ واحدة وقيد بيعٍ واحد وذمّةٍ غير مضاعفة", async () => {
    const woId = await readyOrder("rd-1");
    const first = await dispatchToDelivery({ workOrderId: woId, partyId: 1, clientRequestId: "d1" }, CASHIER);
    expect(await balanceOf()).toBe(20000);

    await cancelDeliveryAssignment(
      { consignmentId: first.consignmentId, reason: "تبديل المندوب", clientRequestId: "c1" },
      MANAGER,
    );
    expect((await listReadyForDispatch(1)).map((x) => Number(x.id))).toContain(woId);

    // كان هذا السطر يفشل بتصادم مفتاحٍ فريد على الفاتورة.
    const second = await dispatchToDelivery({ workOrderId: woId, partyId: 2, clientRequestId: "d2" }, CASHIER);

    // الصفّ نفسه أُعيد تنشيطه (لا إرسالية ثانية) وبفاتورته نفسها.
    expect(second.consignmentId).toBe(first.consignmentId);
    expect(second.invoiceId).toBe(first.invoiceId);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(1);
    expect(await db().select().from(s.invoices)).toHaveLength(1);

    // البيع وقع مرّةً واحدة: قيد SALE واحد وذمّةٌ غير مضاعفة.
    const sales = (await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "SALE");
    expect(sales).toHaveLength(1);
    expect(await balanceOf()).toBe(20000);

    // والطرد يظهر بالطريق باسم الجهة الجديدة.
    const inTransit = await listInTransitConsignments(1);
    expect(inTransit).toHaveLength(1);
    expect(inTransit[0].partyName).toBe("مندوب ثانٍ");

    // التعرّض: أُسنِد مرّتين وحُرِّر مرّة ⇒ الصافي على الجهة الجديدة وحدها.
    const ledger = await db().select().from(s.deliveryLedgerEntries);
    expect(ledger.filter((e) => e.entryType === "COD_ASSIGNED")).toHaveLength(2);
    expect(ledger.filter((e) => e.entryType === "COD_RELEASED")).toHaveLength(1);
    expect(Number((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0].currentBalance)).toBe(0);
  });

  it("إسنادٌ ثانٍ وإرساليةٌ حيّة قائمة ⇒ يُرفض برسالةٍ تسمّيها (لا خطأ قاعدةٍ خامّ)", async () => {
    const woId = await readyOrder("rd-2");
    await dispatchToDelivery({ workOrderId: woId, partyId: 1, clientRequestId: "d3" }, CASHIER);
    await expect(dispatchToDelivery({ workOrderId: woId, partyId: 2, clientRequestId: "d4" }, CASHIER))
      .rejects.toThrowError(/مُسنَد أصلاً للإرسالية|مسند اصلا/);
  });

  it("الإرسالية الملغاة بعد تحصيل ⇒ لا تُعاد تنشيطها (حمايةُ مالٍ متحرّك)", async () => {
    const woId = await readyOrder("rd-3");
    const first = await dispatchToDelivery({ workOrderId: woId, partyId: 1, clientRequestId: "d5" }, CASHIER);
    await cancelDeliveryAssignment(
      { consignmentId: first.consignmentId, reason: "تبديل", clientRequestId: "c2" },
      MANAGER,
    );
    // محاكاة صفٍّ ملغى يحمل تحصيلاً (شكلٌ لا ينتجه المسار العاديّ لكنّ الحارس يجب أن يمسكه).
    await db().update(s.deliveryConsignments).set({ collectedAmount: "5000.00" })
      .where(eq(s.deliveryConsignments.id, first.consignmentId));
    await expect(dispatchToDelivery({ workOrderId: woId, partyId: 2, clientRequestId: "d6" }, CASHIER))
      .rejects.toThrowError(/تحصيلاً أو توريداً/);
  });
});
