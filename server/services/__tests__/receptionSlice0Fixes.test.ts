/**
 * ش٠ — إصلاحات مانعة حيّة لمحطة خدمة الزبائن (هجرة 0151).
 * الوثيقة الحاكمة: docs/reception-cashier-system-design-2026-08-05.md §١٣ ش٠.
 *
 * الثوابت المُثبَّتة هنا (أسماؤها من §١٢):
 *  I13 — إيصال العربون يُلتقَط **بهويّته** لا بالصدفة: أمرٌ بعربونٍ وأجرة COUNTER معاً ⇒
 *        الإلغاء يردّ العربون لا الأجرة، والتسليم يربط العربون بالفاتورة لا الأجرة.
 *        (V3: كان الالتقاط `.limit(1)` على بصمةٍ يشترك فيها الإيصالان.)
 *  V4  — سلّةٌ واحدة ⇒ درجٌ واحد: عربون سلة الاستقبال يهبط على الوردية المُتحقَّق منها
 *        المُمرَّرة من checkoutReception، لا على وردية يحلّها openShiftIdTx للفاعل
 *        (مديرٌ يسجّل على وردية موظفٍ كان عربونه يهبط على درج المدير).
 *  I21 — فاتورة توصيلٍ لعميلٍ مسجَّل تُغلق ذمّتها عند التوريد (V14: remittance كان يرفع
 *        paidAmount ولا يمسّ currentBalance إطلاقاً — مرآة courier.ts).
 *  V15 — COUNTER على مسار الفاتورة يلزمه قبضٌ واردٌ يقابل الصرف وإلا فعجزُ درج (ش٦ رفعت
 *        الحظر المطلق وأبقت الشرط: أمانةٌ مقبوضةٌ فعلاً بمرجع DLV-FEE-INV-{الفاتورة}).
 *  V1  — تقريب IQD في الاستقبال: بيعٌ مباشر خالص نقديّ بإجماليٍّ يُقرَّب لأعلى/لأسفل ينجح
 *        لزبونٍ عابر. (السلّة المختلطة صار لها تقريبها في ش٦ — receptionSlice6.test.ts.)
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { createWorkOrder } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import { cancelWorkOrder } from "../workOrder/cancel";
import { createDeliveryParty } from "../deliveryService";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { recordDeliveryRemittance } from "../delivery/remittance";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts",
  "deliveryConsignments", "deliveryRemittances", "deliveryParties",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const CASHIER = { userId: 2, branchId: 1, role: "cashier" };

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
    { id: 1, openId: "local_mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_recep", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل مسجَّل", phone: "+9647700000001", currentBalance: "0.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "47400.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
}

async function openReceptionShift(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}

/** أمر شغل بعربون نقديّ ٢٠٠٠ **وأجرة COUNTER ٣٠٠٠ معاً** — بصمتا الإيصالين كانتا متطابقتين (V3). */
async function orderWithDepositAndCounterFee() {
  const wo = await createWorkOrder({
    branchId: 1, customerId: 1, baseVariantId: null, title: "درع تكريم",
    salePrice: "10000", quantity: 1,
    deposit: "2000", paymentMethod: "CASH",
    hasDelivery: true, deliveryAddress: "بغداد — المنصور",
    deliveryCost: "3000", deliveryFeeCollection: "COUNTER",
  }, CASHIER);
  return (wo as { workOrderId: number }).workOrderId;
}

async function receiptsOf(workOrderId: number) {
  return db().select().from(s.receipts).where(eq(s.receipts.workOrderId, workOrderId));
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("I13 — إيصال العربون بهويّته لا بالصدفة (V3)", () => {
  it("الإلغاء يردّ مبلغ العربون (٢٠٠٠) لا مبلغ الأجرة (٣٠٠٠)، وdepositReceiptId يشير للعربون", async () => {
    await openReceptionShift();
    const workOrderId = await orderWithDepositAndCounterFee();

    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, workOrderId)))[0];
    expect(wo.depositReceiptId).not.toBeNull();
    const depRcpt = (await db().select().from(s.receipts).where(eq(s.receipts.id, Number(wo.depositReceiptId))))[0];
    expect(depRcpt.amount).toBe("2000.00");

    await cancelWorkOrder(workOrderId, MANAGER);

    // تدقيق ٦/٨ (ث٢): الإلغاء يردّ **الاثنين** — العربون بهويّته (٢٬٠٠٠) وأمانة الأجرة
    // (٣٬٠٠٠) التي لم تُصرَف للمندوب. سابقاً كانت الأمانة تُستثنى فتبقى نقداً في الدرج بلا
    // مالكٍ ولا قيد إبراء. المهمّ أنّ كلاً منهما بمبلغه لا أن يُخلط أحدهما بالآخر (علّة V3).
    const outs = (await receiptsOf(workOrderId)).filter((r) => r.direction === "OUT");
    expect(outs.length).toBe(2);
    const amounts = outs.map((r) => String(r.amount)).sort();
    expect(amounts).toEqual(["2000.00", "3000.00"]);
    const feeRefund = outs.find((r) => String(r.referenceNumber ?? "").startsWith("DLV-FEE-WO-"));
    expect(feeRefund).toBeTruthy();
    expect(String(feeRefund!.amount)).toBe("3000.00"); // الأمانة تُردّ بمرجعها
  });

  it("مسار ما قبل 0151 (depositReceiptId فارغ): البديل الاحتياطي يستثني إيصال الأجرة فيردّ العربون", async () => {
    await openReceptionShift();
    const workOrderId = await orderWithDepositAndCounterFee();
    // محاكاة أمرٍ قديم لم يلتقطه backfill.
    await db().update(s.workOrders).set({ depositReceiptId: null }).where(eq(s.workOrders.id, workOrderId));

    await cancelWorkOrder(workOrderId, MANAGER);

    // البديل الاحتياطي يلتقط العربون (٢٬٠٠٠) لا الأجرة، وأمانة الأجرة تُردّ بمسارها المستقلّ.
    const outs = (await receiptsOf(workOrderId)).filter((r) => r.direction === "OUT");
    const depositRefund = outs.find((r) => !String(r.referenceNumber ?? "").startsWith("DLV-FEE-WO-"));
    expect(depositRefund).toBeTruthy();
    expect(String(depositRefund!.amount)).toBe("2000.00");
  });

  it("التسليم يربط إيصال العربون بالفاتورة ويُبقي إيصال الأجرة غير مربوط", async () => {
    await openReceptionShift();
    const workOrderId = await orderWithDepositAndCounterFee();
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, workOrderId));

    const res = await deliverWorkOrder(
      { workOrderId, payment: { amount: "8000", method: "CASH" } },
      CASHIER,
    );

    const rcpts = await receiptsOf(workOrderId);
    const dep = rcpts.find((r) => r.amount === "2000.00" && r.direction === "IN");
    const fee = rcpts.find((r) => r.amount === "3000.00" && r.direction === "IN");
    expect(Number(dep?.invoiceId)).toBe(res.invoiceId); // العربون ارتبط بالفاتورة
    expect(fee?.invoiceId).toBeNull(); // الأمانة تبقى مستقلّة — تُبرَّأ عند الإرسال لا هنا
  });
});

describe("V4 — سلّةٌ واحدة ⇒ درجٌ واحد (الوردية المُتحقَّق منها تُمرَّر للعربون)", () => {
  it("مديرٌ له وردية RETAIL يسجّل على وردية استقبال الموظّف ⇒ العربون يهبط على درج الموظّف لا درجه", async () => {
    const receptionShift = await openReceptionShift(2); // وردية الموظف
    const managerRetail = await openShift(
      { branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 1, branchId: 1 },
    ); // وردية المدير الخاصة — كان openShiftIdTx(المدير) سيختارها

    const result = await checkoutReception({
      branchId: 1,
      shiftId: receptionShift.shiftId,
      customerId: 1,
      paymentMethod: "CASH",
      clientRequestId: "slice0-v4-0001",
      workOrders: [{
        baseVariantId: null, title: "لوحة مكتبية", salePrice: "6000", quantity: 1,
        deposit: "2500", paymentMethod: "CASH",
      }],
    }, MANAGER);

    const workOrderId = result.workOrders[0].workOrderId;
    const dep = (await receiptsOf(workOrderId)).find((r) => r.direction === "IN");
    expect(Number(dep?.shiftId)).toBe(receptionShift.shiftId);
    expect(Number(dep?.shiftId)).not.toBe(managerRetail.shiftId);
    expect(dep?.cashBucket).toBe("DRAWER");
  });
});

describe("I21 — توريد المندوب يُغلق ذمّة العميل المسجَّل (V14)", () => {
  it("فاتورة آجلة بعميل ⇒ إسناد ⇒ توريد كامل ⇒ paidAmount كامل وcurrentBalance يعود صفراً", async () => {
    await openReceptionShift(); // درج المستلم للتوريد
    const { id: partyId } = await createDeliveryParty(
      { partyType: "INDIVIDUAL", name: "مندوب", defaultFee: "0", branchId: 1 }, MANAGER,
    );
    // فاتورة آجلة قائمة (كما ينتجها بيع استقبالٍ آجل): الذمّة على العميل ١٠٬٠٠٠.
    await db().insert(s.invoices).values({
      id: 501, invoiceNumber: "INV-T-501", sourceType: "POS", sourceId: "slice0-i21",
      branchId: 1, customerId: 1, priceTier: "RETAIL",
      subtotal: "10000.00", taxAmount: "0.00", discountAmount: "0.00",
      total: "10000.00", costTotal: "0.00", status: "PENDING", paidAmount: "0.00",
      createdBy: 2,
    });
    await db().update(s.customers).set({ currentBalance: "10000.00" }).where(eq(s.customers.id, 1));

    const dispatched = await dispatchInvoiceToDelivery(
      { invoiceId: 501, partyId, deliveryFee: "0", clientRequestId: "slice0-i21-d" }, CASHIER,
    );
    expect(dispatched.codAmount).toBe("10000.00");

    await recordDeliveryRemittance({
      branchId: 1, partyId,
      lines: [{ consignmentId: dispatched.consignmentId, collectedAmount: "10000.00" }],
      countedCash: "10000.00",
      clientRequestId: "slice0-i21-r",
    }, CASHIER);

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, 501)))[0];
    expect(inv.paidAmount).toBe("10000.00");
    expect(inv.status).toBe("PAID");
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("0.00"); // كانت تبقى ١٠٬٠٠٠ للأبد قبل الإصلاح
    const party = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, partyId)))[0];
    expect(Number(party.currentBalance)).toBe(0); // العهدة أُبرئت بالتوريد
  });
});

describe("V15 — COUNTER على مسار الفاتورة مشروطٌ بأمانةٍ مقبوضة (رُفع الحظر المطلق في ش٦)", () => {
  it("dispatchInvoice بأجرة «مقبوضة في الكاشير» بلا إيصال أمانةٍ يُرفض برسالة صريحة", async () => {
    const { id: partyId } = await createDeliveryParty(
      { partyType: "INDIVIDUAL", name: "مندوب", defaultFee: "2000", branchId: 1 }, MANAGER,
    );
    await db().insert(s.invoices).values({
      id: 502, invoiceNumber: "INV-T-502", sourceType: "POS", sourceId: "slice0-v15",
      branchId: 1, customerId: null, priceTier: "RETAIL",
      subtotal: "5000.00", taxAmount: "0.00", discountAmount: "0.00",
      total: "5000.00", costTotal: "0.00", status: "PENDING", paidAmount: "0.00",
      createdBy: 2,
    });

    // ش٦: الرفض بقي لكنه صار **مشروطاً** بغياب الأمانة (PRECONDITION_FAILED) بدل حظرٍ مطلق —
    // القبول مع أمانةٍ مقبوضة مُثبَتٌ في receptionSlice6.test.ts (S1).
    await expect(dispatchInvoiceToDelivery(
      { invoiceId: 502, partyId, deliveryFee: "2000", feeCollection: "COUNTER" }, CASHIER,
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("V1 — تقريب IQD للبيع المباشر الخالص النقديّ في الاستقبال", () => {
  it("تقريبٌ لأعلى (٤٧٬٤٠٠ ⇒ ٤٧٬٥٠٠) لزبونٍ عابر ⇒ ينجح والفاتورة والنقد بالمقرَّب", async () => {
    const shift = await openReceptionShift();
    const result = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId,
      paymentMethod: "CASH", paidAmount: "47500.00", cashRoundIQD: true,
      clientRequestId: "slice0-v1-up",
      regularSale: { lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], amount: "47500.00" },
    }, CASHIER);

    const inv = (await db().select().from(s.invoices)
      .where(eq(s.invoices.id, Number(result.regularSale!.invoiceId))))[0];
    expect(inv.total).toBe("47500.00"); // قبل الإصلاح: رفضٌ حتميّ («البيع الآجل يتطلب عميلاً»)
    expect(inv.paidAmount).toBe("47500.00");
    expect(inv.status).toBe("PAID");
    const rcpt = (await db().select().from(s.receipts)
      .where(and(eq(s.receipts.invoiceId, Number(result.regularSale!.invoiceId)), eq(s.receipts.direction, "IN"))))[0];
    expect(rcpt.amount).toBe("47500.00"); // الدرج = المقبوض فعلاً ⇒ الإغلاق بفارق صفر
  });

  it("تقريبٌ لأسفل (٤٧٬٣٠٠ ⇒ ٤٧٬٢٥٠) ⇒ ينجح بلا ذمّةٍ صامتة", async () => {
    await db().update(s.productPrices).set({ price: "47300.00" })
      .where(eq(s.productPrices.productUnitId, 1));
    const shift = await openReceptionShift();
    const result = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId,
      paymentMethod: "CASH", paidAmount: "47250.00", cashRoundIQD: true,
      clientRequestId: "slice0-v1-down",
      regularSale: { lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], amount: "47250.00" },
    }, CASHIER);

    const inv = (await db().select().from(s.invoices)
      .where(eq(s.invoices.id, Number(result.regularSale!.invoiceId))))[0];
    expect(inv.total).toBe("47250.00");
    expect(inv.status).toBe("PAID");
  });

  // ش٦: تقريب السلّة المختلطة صار متاحاً لكن **بتسميةٍ صريحة** (cashRoundingOverride) لا
  // بعلم cashRoundIQD وحده — فهذا الثابت يبقى كما هو: العلم العاري يُسقَط على المختلطة.
  it("السلّة المختلطة (بيع + أمر شغل) تبقى بلا تقريبٍ حين يُرسَل العلم وحده بلا تسمية الحاملة", async () => {
    const shift = await openReceptionShift();
    const result = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "47400.00", cashRoundIQD: true,
      clientRequestId: "slice0-v1-mixed",
      regularSale: { lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], amount: "47400.00" },
      workOrders: [{ baseVariantId: null, title: "ختم دائري", salePrice: "3000", quantity: 1, deposit: "0" }],
    }, CASHIER);

    const inv = (await db().select().from(s.invoices)
      .where(eq(s.invoices.id, Number(result.regularSale!.invoiceId))))[0];
    expect(inv.total).toBe("47400.00"); // بلا تقريب — العلم أُسقط خادمياً على السلة المختلطة
  });
});

describe("سلامة إيصال العربون غير النقديّ (انحدار V3 على مسار البطاقة)", () => {
  it("عربون بطاقة: cashBucket فارغ (خارج الدرج) وdepositReceiptId مثبَّت", async () => {
    await openReceptionShift();
    const wo = await createWorkOrder({
      branchId: 1, customerId: 1, baseVariantId: null, title: "بنر",
      salePrice: "8000", quantity: 1,
      deposit: "3000", paymentMethod: "CARD", paymentReference: "CARD-REF-77",
    }, CASHIER);
    const workOrderId = (wo as { workOrderId: number }).workOrderId;
    const row = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, workOrderId)))[0];
    const dep = (await db().select().from(s.receipts).where(eq(s.receipts.id, Number(row.depositReceiptId))))[0];
    expect(dep.paymentMethod).toBe("CARD");
    expect(dep.cashBucket).toBeNull();
    expect(dep.amount).toBe("3000.00");
  });
});
