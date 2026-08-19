/**
 * عكس فاتورة خدمةٍ صفريّة البنود (١٩/٨) — آخر فاتورةٍ كانت بلا مخرج.
 *
 * الحالة واقعُ المطبعة: أمرُ تخصيصٍ خالصٍ بلا منتجٍ كتالوجيّ (درعٌ/تصميم) ⇒ فاتورتُه تُنشأ
 * **بصفر `invoiceItems`** (قيد FK على `variantId`). فتُرفَض من المرتجع (يشترط أسطراً) ومن
 * التصحيح (يشترط بنوداً) ومن الإلغاء (يرفض منشأ WORKORDER) — فاتورةٌ حيّةٌ بلا فعلٍ واحد.
 *
 * الثوابت المحروسة:
 *  ① العكس يقع كاملاً: إيرادٌ معكوس، ذمّةٌ ساقطة، فاتورةٌ مرتجعة، وأمرٌ ملغى.
 *  ② المقبوض **لا يُصرَف صامتاً** — يبقى أمانةً يردّها سند صرفٍ موثَّق.
 *  ③ الحصر البنيويّ: فاتورةٌ لها بندٌ واحد تُرفَض (مخرجها المرتجع المُختبَر).
 *  ④ لا عكسَ مرّتين، وفصلُ المهام قائم.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createWorkOrder } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import { reverseServiceInvoice } from "../workOrder/reverseServiceInvoice";
import { openShift } from "../shiftService";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";

const TABLES = [
  "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

const SELLER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

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
    { id: 2, openId: "c", name: "بائع", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB", costPrice: "400.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
});

/** أمرُ تخصيصٍ **خالص**: بلا `baseVariantId` ⇒ فاتورةٌ صفريّة البنود عند التسليم. */
async function pureServiceOrder(reqId: string, paid: string | null) {
  await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
  const wo = await createWorkOrder({
    branchId: 1, customerId: 1, title: "درع تخصيص", quantity: 1,
    salePrice: "50000.00", materials: [], deposit: "0", clientRequestId: reqId,
  } as never, SELLER);
  const woId = Number((wo as { workOrderId: number }).workOrderId);
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  const res = await deliverWorkOrder(
    { workOrderId: woId, payment: paid ? { amount: paid, method: "CASH" } : null },
    SELLER,
  );
  return { woId, invoiceId: res.invoiceId };
}
const invoiceOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
const balanceOf = async () =>
  Number((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance);

describe("عكس فاتورة الخدمة الصفريّة", () => {
  it("⭐ فاتورةٌ آجلة بلا بنود: تُعكَس كاملاً — إيرادٌ وذمّةٌ وأمرٌ", async () => {
    const { woId, invoiceId } = await pureServiceOrder("rsv-1", null);
    // إثباتُ الحالة: صفر بنود، وذمّةٌ كاملة على العميل.
    expect(await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId))).toHaveLength(0);
    expect(await balanceOf()).toBe(50000);

    const res = await reverseServiceInvoice(
      { workOrderId: woId, reason: "العميل رفض الدرع بعد التسليم", clientRequestId: "rev-1" },
      MANAGER,
    );

    expect(res.reversedTotal).toBe("50000.00");
    const inv = await invoiceOf(invoiceId);
    expect(inv.status).toBe("RETURNED");
    expect(inv.returnedTotal).toBe("50000.00");
    expect(await balanceOf()).toBe(0); // الذمّة سقطت
    // القيد المعكوس موجودٌ بإيرادٍ سالب.
    const ret = (await db().select().from(s.accountingEntries))
      .filter((e) => e.entryType === "RETURN" && Number(e.invoiceId) === invoiceId);
    expect(ret).toHaveLength(1);
    expect(Number(ret[0].revenue)).toBe(-50000);
    // والأمر لم يعد «مُسلَّماً».
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(wo.status).toBe("CANCELLED");
  });

  it("⭐ المقبوض يبقى أمانةً ولا يُصرَف صامتاً من هنا", async () => {
    const { woId, invoiceId } = await pureServiceOrder("rsv-2", "50000.00");
    const receiptsBefore = (await db().select().from(s.receipts)).length;

    const res = await reverseServiceInvoice(
      { workOrderId: woId, reason: "إلغاء بعد التسليم", clientRequestId: "rev-2" },
      MANAGER,
    );

    expect(res.refundableAmount).toBe("50000.00");
    // صفرُ إيصالِ صرفٍ جديد — الردّ قرارٌ موثَّق بسندٍ مستقل لا أثرٌ جانبيّ لهذا المسار.
    expect((await db().select().from(s.receipts)).length).toBe(receiptsBefore);
    expect((await invoiceOf(invoiceId)).status).toBe("RETURNED");
    expect(await balanceOf()).toBe(0);
  });

  it("⭐ الحصر البنيويّ: فاتورةٌ لها بندٌ واحد تُرفَض (مخرجها المرتجع)", async () => {
    const { woId, invoiceId } = await pureServiceOrder("rsv-3", null);
    // حقنُ بندٍ يدوياً لمحاكاة أمرٍ له منتجٌ أساس.
    await db().insert(s.invoiceItems).values({
      invoiceId, variantId: 1, productUnitId: 1, quantity: "1.000", baseQuantity: 1,
      unitPrice: "50000.00", unitCost: "0.00", discountAmount: "0", total: "50000.00",
    });

    await expect(reverseServiceInvoice(
      { workOrderId: woId, reason: "محاولة", clientRequestId: "rev-3" },
      MANAGER,
    )).rejects.toThrowError(/للفاتورة بنودٌ|للفاتورة بنود/);
  });

  it("لا عكسَ مرّتين، وسببٌ إلزاميّ", async () => {
    const { woId } = await pureServiceOrder("rsv-4", null);
    await expect(reverseServiceInvoice({ workOrderId: woId, reason: "لا" }, MANAGER))
      .rejects.toThrowError(/سبب العكس/);
    await reverseServiceInvoice({ workOrderId: woId, reason: "سببٌ كافٍ", clientRequestId: "rev-4" }, MANAGER);
    await expect(reverseServiceInvoice({ workOrderId: woId, reason: "ثانيةً", clientRequestId: "rev-4b" }, MANAGER))
      .rejects.toThrowError(/لا تُعكَس مرّتين|لا تعكس مرتين/);
  });

  it("فصل المهام: مُصدر الفاتورة لا يعكسها", async () => {
    const { woId } = await pureServiceOrder("rsv-5", null);
    // البائع نفسه هو مُصدر الفاتورة (نسبتُها له بعد إصلاح ١٩/٨).
    await expect(reverseServiceInvoice(
      { workOrderId: woId, reason: "محاولة ذاتية", clientRequestId: "rev-5" },
      { ...SELLER, role: "manager" },
    )).rejects.toThrowError(/أصدرتها بنفسك/);
  });
});
