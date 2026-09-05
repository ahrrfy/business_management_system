/**
 * م١ (PR-1) — البيع بتوصيلٍ من `sales.create` + جذرُ حاجز الائتمان على عميل التوصيل الجديد.
 *
 * الجذر الذي يُغلق: `credit.ts` يعبر COD حين يصله `paymentMode='COD'`، لكنّ الاستقبال لم يكن
 * يمرّره، وقناةُ الطباعة كانت تفحص الحدّ بنسخةٍ محلّية بلا فرع COD ⇒ عميلٌ مسجَّل بحدّ «0»
 * (افتراض كلّ عميلٍ جديد) يُرفض توصيلُه من الاستقبال ويُقبل من المتجر الإلكترونيّ.
 *
 * ما تحرسه هذه الاختبارات:
 *  ① عميلٌ جديد بحدّ «0» + بيعٌ بتوصيل عبر `sales.create` ⇒ ينجح ويُسنَد في معاملة البيع نفسها:
 *     فاتورة COD غير مدفوعة + إرسالية ASSIGNED + `COD_ASSIGNED` بقيمة المتبقّي، والذمّة تبقى على
 *     العميل حتى التسليم (النموذج القائم: AR على العميل، والتعرّض على الجهة في الدفتر).
 *  ② نفس العميل ببيعٍ آجل **بلا** توصيل ⇒ يُرفض كما كان (نقديّ فقط).
 *  ③ الإعادة بنفس المفتاح تعيد الفاتورة والإرسالية نفسيهما — لا إسنادَ ثانٍ ولا قيدَ ثانٍ.
 *  ④ زبونٌ عابر (بلا حساب) + توصيل ⇒ ينجح (المتبقّي عهدةٌ على الجهة لا ذمّةٌ بلا صاحب).
 *  ⑤ الأوفلاين: `offlineCapture` + `delivery` ⇒ رفضٌ قبل أيّ كتابة.
 *  ⑥ أمانة الأجرة (COUNTER): إيصال IN في الدرج + قيد DELIVERY_FEE_HELD قبل الإسناد؛ ومخالفة
 *     المبلغ أو الطريقة ترتدّ بالمعاملة كلّها (لا فاتورة يتيمة).
 *  ⑦ الجذر: `checkoutReception` (بيعٌ مباشر، ثمّ طباعة) لعميلٍ بحدّ «0» + توصيل ⇒ ينجح وتُختَم COD.
 *  ⑧ قناة الطباعة بلا توصيل تحفظ سلوكها بعد توحيد الحارس: حدّ «0» يُرفض، وتجاوز السقف يُرفض،
 *     وبلا حدّ يمرّ ذمّةً على العميل.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createSale } from "../sale/create";
import { createPrintSale } from "../printSaleService";
import { checkoutReception } from "../receptionCheckoutService";
import { openShift } from "../shiftService";
import { withTx } from "../tx";
import { assertCreditLimit } from "../../lib/credit";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "orderPayments", "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
/** عميلٌ جديد بحدّ «0» — الافتراض التحفّظي لكلّ عميلٍ يُنشأ (قرار المالك). */
const NEW_CUSTOMER = 1;
const CAPPED_CUSTOMER = 2;
const UNCAPPED_CUSTOMER = 3;
const LINE = { variantId: 1, productUnitId: 1, quantity: "2" }; // 2 × 1000 = 2000
const PRINT_LINE = { variantId: 10, productUnitId: 10, quantity: "4" }; // 4 × 250 = 1000

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
    { id: 2, openId: "csh", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: NEW_CUSTOMER, name: "عميل جديد", phone: "+9647701234567", currentBalance: "0.00", creditLimit: "0" },
    { id: CAPPED_CUSTOMER, name: "عميل بسقف", phone: "+9647701234568", currentBalance: "0.00", creditLimit: "1000" },
    { id: UNCAPPED_CUSTOMER, name: "عميل بلا حد", phone: "+9647701234569", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "مندوب", partyType: "INDIVIDUAL", branchId: 1, currentBalance: "0.00", isActive: true, defaultFee: "1500.00" },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "دفتر" },
    { id: 10, name: "تصوير A4", productType: "PRINT_SERVICE", isService: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" },
    { id: 10, productId: 10, sku: "SVC-COPY", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true },
    { id: 10, variantId: 10, unitName: "ورقة", conversionFactor: 1, isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 10, priceTier: "RETAIL", price: "250.00" },
  ]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}

function caller(role = "cashier", id = 2, branchId = 1) {
  return appRouter.createCaller({
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user: { id, role, branchId, permissionsOverride: null },
  } as any);
}

const invoiceOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
const consignmentByInvoice = async (invoiceId: number) =>
  (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
const ledgerOf = async (partyId: number) =>
  db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.partyId, partyId));
const customerBalance = async (id: number) =>
  String((await db().select().from(s.customers).where(eq(s.customers.id, id)))[0].currentBalance);
const partyBalance = async (id: number) =>
  String((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, id)))[0].currentBalance);
const invoiceCount = async () => (await db().select().from(s.invoices)).length;
const consignmentCount = async () => (await db().select().from(s.deliveryConsignments)).length;

const DELIVERY = {
  partyId: 1,
  fee: "1500",
  feeCollection: "COURIER" as const,
  recipientName: "المستلم",
  recipientPhone: "07701234567",
  address: "بغداد — الكرادة",
  governorate: "baghdad",
};

beforeEach(async () => {
  await reset();
  await seed();
});

describe("sales.create + delivery — الإسناد في معاملة البيع نفسها", () => {
  it("⭐ عميلٌ جديد بحدّ «0» + بيعٌ بتوصيل ⇒ ينجح: فاتورة COD غير مدفوعة + إرسالية ASSIGNED + COD_ASSIGNED", async () => {
    const res = await caller().sales.create({
      branchId: 1, customerId: NEW_CUSTOMER, lines: [LINE],
      delivery: DELIVERY, clientRequestId: "pos-dlv-1",
    });
    expect(res.idempotentReplay).toBeFalsy();
    expect(res.consignmentId).toEqual(expect.any(Number));
    expect(res.consignmentNumber).toEqual(expect.any(String));

    const inv = await invoiceOf(res.invoiceId);
    expect(inv.total).toBe("2000.00");
    expect(inv.paidAmount).toBe("0.00");
    expect(inv.status).toBe("PENDING");
    expect(inv.paymentMode).toBe("COD");
    expect(inv.paymentMethod).toBeNull();

    const cn = await consignmentByInvoice(res.invoiceId);
    expect(Number(cn.id)).toBe(res.consignmentId);
    expect(cn.consignmentNumber).toBe(res.consignmentNumber);
    expect(Number(cn.partyId)).toBe(1);
    expect(cn.codAmount).toBe("2000.00");
    expect(cn.deliveryFee).toBe("1500.00");
    expect(cn.feeCollection).toBe("COURIER");
    expect(cn.parcelStatus).toBe("ASSIGNED");
    expect(cn.moneyStatus).toBe("UNSETTLED");
    expect(cn.status).toBe("DISPATCHED");
    expect(cn.governorate).toBe("baghdad");
    expect(cn.recipientPhone).toBe("07701234567");
    expect(Number(cn.endCustomerId)).toBe(NEW_CUSTOMER);

    // الدفتر: تعرّضٌ واحد بقيمة المتبقّي — ولا نقدَ بيد الجهة قبل التسليم.
    const ledger = await ledgerOf(1);
    expect(ledger.map((e) => [e.entryType, e.amount])).toEqual([["COD_ASSIGNED", "2000.00"]]);
    expect(await partyBalance(1)).toBe("0.00");
    // النموذج القائم: الذمّة على العميل حتى التسليم؛ الإسناد لا ينقلها إلى الجهة.
    expect(await customerBalance(NEW_CUSTOMER)).toBe("2000.00");
    // لا إيصالَ درجٍ لبيعٍ لم يُقبض منه شيء.
    expect((await db().select().from(s.receipts)).length).toBe(0);
  });

  it("نفس العميل ببيعٍ آجل بلا توصيل ⇒ يُرفض كما كان (نقديّ فقط، حدّه صفر)", async () => {
    await expect(
      caller().sales.create({ branchId: 1, customerId: NEW_CUSTOMER, lines: [LINE], clientRequestId: "pos-credit-1" }),
    ).rejects.toThrow(/حدّ ائتمانه صفر/);
    expect(await invoiceCount()).toBe(0);
    expect(await consignmentCount()).toBe(0);
  });

  it("الإعادة بنفس المفتاح تعيد الفاتورة والإرسالية نفسيهما — لا إسناد ثانٍ ولا قيد ثانٍ", async () => {
    const input = { branchId: 1, customerId: NEW_CUSTOMER, lines: [LINE], delivery: DELIVERY, clientRequestId: "pos-dlv-replay" };
    const first = await caller().sales.create(input);
    const second = await caller().sales.create(input);
    expect(second.idempotentReplay).toBe(true);
    expect(second.invoiceId).toBe(first.invoiceId);
    expect(second.consignmentId).toBe(first.consignmentId);
    expect(second.consignmentNumber).toBe(first.consignmentNumber);
    expect(await invoiceCount()).toBe(1);
    expect(await consignmentCount()).toBe(1);
    expect((await ledgerOf(1)).filter((e) => e.entryType === "COD_ASSIGNED").length).toBe(1);
  });

  it("زبونٌ عابر بلا حساب + توصيل ⇒ ينجح: المتبقّي عهدةٌ على الجهة لا ذمّةٌ بلا صاحب", async () => {
    // بلا `customerId` — هويّة المستلم تُكتب على الإرسالية (`delivery.recipient*`) لا على حساب عميل.
    const res = await caller().sales.create({
      branchId: 1, lines: [LINE],
      delivery: { partyId: 1, fee: "1500", recipientName: "زبون عابر", recipientPhone: "07709999999" },
      clientRequestId: "pos-walkin-1",
    });
    const inv = await invoiceOf(res.invoiceId);
    expect(inv.customerId).toBeNull();
    expect(inv.paymentMode).toBe("COD");
    const cn = await consignmentByInvoice(res.invoiceId);
    expect(cn.recipientName).toBe("زبون عابر");
    expect(cn.recipientPhone).toBe("07709999999");
    expect(cn.endCustomerId).toBeNull();
    expect(cn.codAmount).toBe("2000.00");
  });

  it("الأوفلاين: بيعٌ مُلتقَطٌ دون اتصال + توصيل ⇒ يُرفض قبل أيّ كتابة", async () => {
    await expect(
      createSale({
        branchId: 1, sourceType: "POS", customerId: NEW_CUSTOMER, lines: [LINE],
        offlineCapture: { capturedAt: new Date(), offlineReceiptNumber: "OFF-1" },
        allowNegativeStock: true,
        delivery: DELIVERY,
        clientRequestId: "off-dlv-1",
      }, CASHIER),
    ).rejects.toThrow(/طابور الأوفلاين/);
    expect(await invoiceCount()).toBe(0);
    expect(await consignmentCount()).toBe(0);
  });

  it("أمانة الأجرة (COUNTER): إيصال IN في الدرج + قيد DELIVERY_FEE_HELD على الفاتورة قبل الإسناد", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0" }, { userId: 2, branchId: 1 });
    const res = await caller().sales.create({
      branchId: 1, shiftId: shift.shiftId, customerId: NEW_CUSTOMER, lines: [LINE],
      delivery: { ...DELIVERY, feeCollection: "COUNTER" }, deliveryFeeHeld: "1500",
      clientRequestId: "pos-held-1",
    });
    const held = (await db().select().from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `DLV-FEE-INV-${res.invoiceId}`)))[0];
    expect(held).toBeTruthy();
    expect(held.direction).toBe("IN");
    expect(held.amount).toBe("1500.00");
    expect(held.paymentMethod).toBe("CASH");
    expect(held.cashBucket).toBe("DRAWER");
    expect(Number(held.shiftId)).toBe(shift.shiftId);
    expect(Number(held.invoiceId)).toBe(res.invoiceId);
    const heldEntry = (await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `DELIVERY_FEE_HELD:INV:${res.invoiceId}`)))[0];
    expect(heldEntry?.entryType).toBe("DELIVERY_FEE_HELD");
    expect(heldEntry?.amount).toBe("1500.00");
    const cn = await consignmentByInvoice(res.invoiceId);
    expect(cn.feeCollection).toBe("COUNTER");
    expect(cn.deliveryFee).toBe("1500.00");
  });

  it("أمانةٌ لا تساوي الأجرة، أو مع COURIER، أو بلا وردية ⇒ ترتدّ المعاملة كلّها (لا فاتورة يتيمة)", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0" }, { userId: 2, branchId: 1 });
    await expect(
      caller().sales.create({
        branchId: 1, shiftId: shift.shiftId, customerId: NEW_CUSTOMER, lines: [LINE],
        delivery: { ...DELIVERY, feeCollection: "COUNTER" }, deliveryFeeHeld: "1000",
        clientRequestId: "pos-held-mismatch",
      }),
    ).rejects.toThrow(/يجب أن تساوي أجرة التوصيل/);
    await expect(
      caller().sales.create({
        branchId: 1, shiftId: shift.shiftId, customerId: NEW_CUSTOMER, lines: [LINE],
        delivery: { ...DELIVERY, feeCollection: "COURIER" }, deliveryFeeHeld: "1500",
        clientRequestId: "pos-held-courier",
      }),
    ).rejects.toThrow(/لا تناسب طريقة التوصيل/);
    await expect(
      caller().sales.create({
        branchId: 1, customerId: NEW_CUSTOMER, lines: [LINE],
        delivery: { ...DELIVERY, feeCollection: "COUNTER" }, deliveryFeeHeld: "1500",
        clientRequestId: "pos-held-noshift",
      }),
    ).rejects.toThrow(/لا وردية مفتوحة/);
    expect(await invoiceCount()).toBe(0);
    expect(await consignmentCount()).toBe(0);
    expect((await db().select().from(s.receipts)).length).toBe(0);
  });
});

describe("الجذر: الاستقبال يمرّر COD فتعبر فاتورةُ التوصيل حاجزَ الائتمان", () => {
  async function openReception(): Promise<number> {
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    return shift.shiftId;
  }

  it("⭐ بيعٌ مباشر من الاستقبال لعميلٍ بحدّ «0» + توصيل ⇒ ينجح وتُختَم الفاتورة COD وتُسنَد", async () => {
    const shiftId = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId, customerId: NEW_CUSTOMER, paidAmount: "0", clientRequestId: "rc-sale-1",
      regularSale: { lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], amount: "1000.00" },
      delivery: { partyId: 1, fee: "1500", feeCollection: "COURIER", recipientPhone: "07701234567", address: "بغداد" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;
    const inv = await invoiceOf(invoiceId);
    expect(inv.paymentMode).toBe("COD");
    expect(inv.status).toBe("PENDING");
    const cn = await consignmentByInvoice(invoiceId);
    expect(cn.codAmount).toBe("1000.00");
    expect(cn.parcelStatus).toBe("ASSIGNED");
  });

  it("⭐ قناة الطباعة من الاستقبال لعميلٍ بحدّ «0» + توصيل ⇒ ينجح وتُختَم COD (كانت تفحص الحدّ محلّياً بلا فرع COD)", async () => {
    const shiftId = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId, customerId: NEW_CUSTOMER, paidAmount: "0", clientRequestId: "rc-print-1",
      printSale: { lines: [PRINT_LINE], amount: "1000.00" },
      delivery: { partyId: 1, fee: "1500", feeCollection: "COURIER", recipientPhone: "07701234567", address: "بغداد" },
    }, CASHIER);
    const invoiceId = r.printSale!.invoiceId;
    const inv = await invoiceOf(invoiceId);
    expect(inv.paymentMode).toBe("COD");
    expect(inv.status).toBe("PENDING");
    const cn = await consignmentByInvoice(invoiceId);
    expect(cn.codAmount).toBe("1000.00");
  });
});

describe("قناة الطباعة بلا توصيل — سلوك حدّ الائتمان محفوظٌ بعد توحيد الحارس", () => {
  it("حدّ «0» ⇒ يُرفض نقديّاً فقط", async () => {
    await expect(
      createPrintSale({ branchId: 1, customerId: NEW_CUSTOMER, lines: [{ ...PRINT_LINE, quantity: "8" }] }, CASHIER),
    ).rejects.toThrow(/حدّ ائتمانه صفر/);
    expect(await invoiceCount()).toBe(0);
  });

  it("تجاوز السقف الموجب ⇒ يُرفض برسالة تحمل الأرقام — وهي رسالة الحارس الواحد نفسه", async () => {
    await expect(
      createPrintSale({ branchId: 1, customerId: CAPPED_CUSTOMER, lines: [{ ...PRINT_LINE, quantity: "8" }] }, CASHIER),
    ).rejects.toThrow(/تجاوز حدّ الائتمان/);
    // قناة الطباعة لا تملك نسخةً محلّية من الفحص بعد اليوم: نفس العميل ونفس الزيادة على
    // `assertCreditLimit` مباشرةً يُنتجان النصّ نفسه (server/lib/credit.ts هو المصدر الوحيد).
    await expect(withTx((tx) => assertCreditLimit(tx, CAPPED_CUSTOMER, "2000", 1))).rejects.toThrow(/تجاوز حدّ الائتمان/);
    expect(await invoiceCount()).toBe(0);
  });

  it("بلا حدّ (null) ⇒ يمرّ ذمّةً على العميل، وتبقى الفاتورة PREPAID", async () => {
    const r = await createPrintSale({ branchId: 1, customerId: UNCAPPED_CUSTOMER, lines: [{ ...PRINT_LINE, quantity: "8" }] }, CASHIER);
    const inv = await invoiceOf(r.invoiceId);
    expect(inv.status).toBe("PENDING");
    expect(inv.paymentMode).toBe("PREPAID");
    expect(await customerBalance(UNCAPPED_CUSTOMER)).toBe("2000.00");
  });
});
