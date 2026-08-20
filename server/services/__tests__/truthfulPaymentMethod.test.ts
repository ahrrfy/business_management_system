// صدق طريقة الدفع (بلاغ المالك ١٨/٨: «جميع الفواتير تظهر نقدية»).
//
// القاعدة المحروسة هنا: `invoices.paymentMethod` (و`workOrders.paymentMethod`) قيمةُ **قبضٍ
// واقع** لا قيمةٌ افتراضية — صفرُ قبضٍ ⇒ NULL ⇒ تظهر تحت فلتر «آجل». كانت ثلاثة مواضع تختلق
// «نقدي»: `?? "CASH"` في تثبيت المسوّدة، وكائن دفعةٍ يُبنى دائماً ولو بصفر في سلّة الاستقبال
// (فيموت فرع `?? null` في sale/create.ts)، و`default("CASH")` على عمود أمر الشغل.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { processPayment } from "../sale/payment";

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const TABLES = [
  "orderPayments", "auditLogs", "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
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
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc1", name: "موظف", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل موثوق", phone: "+9647701234567", currentBalance: "0.00", creditLimit: "0.00" },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}
const openReception = () => openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
const LINE = { variantId: 1, productUnitId: 1, quantity: "10" }; // ١٠ × ١٠٠٠ = ١٠٬٠٠٠

async function invoiceOf(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
}
const WO = {
  title: "تخصيص",
  quantity: 1,
  salePrice: "5000.00",
  materials: [] as Array<{ variantId: number; baseQuantity: number }>,
};

describe("صدق طريقة الدفع — NULL حين لا قبض", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("بيع آجل بصفر قبض ⇒ الفاتورة بلا طريقة دفع (تظهر «آجل» لا «نقدي»)", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      // الواجهة لم تعد ترسل طريقةً بلا قبض؛ ونرسلها هنا عمداً لإثبات أنّها **تُهمَل** ولا تُختَم.
      paymentMethod: "CASH", paidAmount: "0", deferredDirect: true, clientRequestId: "truth-deferred",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER);
    const inv = await invoiceOf(r.regularSale!.invoiceId);
    expect(inv.paidAmount).toBe("0.00");
    expect(inv.paymentMethod).toBeNull();
    expect((await db().select().from(s.receipts)).length).toBe(0);
  });

  it("قبضٌ جزئيّ ⇒ الطريقة الحقيقية مختومة ومعها إيصال قبض", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "4000", deferredDirect: true, clientRequestId: "truth-partial",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER);
    const inv = await invoiceOf(r.regularSale!.invoiceId);
    expect(inv.paidAmount).toBe("4000.00");
    expect(inv.paymentMethod).toBe("CASH");
    expect((await db().select().from(s.receipts)).length).toBe(1);
  });

  it("أمر شغلٍ بلا عربون ⇒ عمود طريقة الدفع NULL (لا افتراض «نقدي» من القاعدة)", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paidAmount: "0", clientRequestId: "truth-wo-nodeposit",
      workOrders: [{ ...WO }],
    }, CASHIER);
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, r.workOrders[0].workOrderId)))[0];
    expect(wo.deposit).toBe("0.00");
    expect(wo.paymentMethod).toBeNull();
  });

  it("أمر شغلٍ بعربون ⇒ طريقة العربون مختومة على الأمر", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "2000", clientRequestId: "truth-wo-deposit",
      workOrders: [{ ...WO }],
    }, CASHIER);
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, r.workOrders[0].workOrderId)))[0];
    expect(wo.deposit).toBe("2000.00");
    expect(wo.paymentMethod).toBe("CASH");
  });

  it("قبضٌ موجب بلا طريقة ⇒ يُرفض (إدخالٌ ناقص لا يُخمَّن)", async () => {
    const shift = await openReception();
    await expect(checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paidAmount: "4000", deferredDirect: true, clientRequestId: "truth-nomethod",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER)).rejects.toThrowError(/طريقة القبض/);
  });

  it("أوّل تسديدٍ لاحق على فاتورةٍ بلا طريقة ⇒ الطريقة الحقيقية لا MIXED", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paidAmount: "0", deferredDirect: true, clientRequestId: "truth-latepay",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;
    expect((await invoiceOf(invoiceId)).paymentMethod).toBeNull();

    await processPayment({ invoiceId, amount: "10000.00", method: "CARD", reference: "TX-1", shiftId: shift.shiftId }, CASHIER);
    const after = await invoiceOf(invoiceId);
    // قبل الإصلاح كانت تُنشأ «CASH» كاذبة فيقلبها أوّل تسديدٍ إلى MIXED — طيٌّ لكذبةٍ لا لحقيقة.
    expect(after.paymentMethod).toBe("CARD");
    expect(after.paidAmount).toBe("10000.00");
  });
});
