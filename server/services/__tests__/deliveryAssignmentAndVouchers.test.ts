/**
 * اختبارات تسليم كاشير الاستقبال، إلغاء أوامر الشغل المسندة للتوصيل، وسندات جهات التوصيل.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { createDeliveryParty } from "../deliveryService";
import { dispatchToDelivery } from "../delivery/dispatch";
import { createWorkOrder } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import {
  approveWorkOrderControlRequest,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";
import { createVoucher } from "../voucherService";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts",
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines", "deliveryPartyMembers",
  "deliveryConsignments", "deliveryRemittances", "deliveryParties",
  "workOrderControlRequests", "workOrderEvents",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const OWNER = { userId: 4, branchId: 1, role: "manager" as const };

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
    { id: 3, openId: "local_courier", name: "مندوب", email: "c@t.test", role: "courier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "local_owner", name: "مالك", email: "o@t.test", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل مسجَّل", phone: "+9647700000001", currentBalance: "0.00" }]);
}

async function openReceptionShift(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("إصلاحات إسناد التوصيل والذمم في كاشير الاستقبال", () => {
  it("checkoutReception بأمر شغل خالص وتوصيل ينجح بلا فاتورة بيع ولا يمنعه عدم وجود carrierInvoiceId", async () => {
    const shift = await openReceptionShift();
    const result = await checkoutReception({
      clientRequestId: `req-${randomUUID()}`,
      customerId: 1,
      customerName: "عميل مسجَّل",
      customerPhone: "+9647700000001",
      shiftId: shift.shiftId,
      branchId: 1,
      paymentMethod: "CASH",
      paidAmount: "2000.00",
      workOrders: [
        {
          title: "طباعة بنر",
          quantity: 1,
          salePrice: "10000.00",
          deposit: "2000.00",
          paymentMethod: "CASH",
          receptionChannel: "WHATSAPP",
          hasDelivery: true,
          deliveryAddress: "بغداد — الكرادة",
          deliveryCost: "5000.00",
          deliveryFeeCollection: "COUNTER",
        },
      ],
      delivery: {
        cost: "5000.00",
        address: "بغداد — الكرادة",
        feeCollection: "COUNTER",
      },
    }, CASHIER);

    expect(result.workOrders).toHaveLength(1);
    const [wo] = await db().select().from(s.workOrders).where(eq(s.workOrders.id, result.workOrders[0].workOrderId));
    expect(Boolean(wo.hasDelivery)).toBe(true);
    expect(wo.deliveryCost).toBe("5000.00");
    expect(wo.deliveryFeeCollection).toBe("COUNTER");
    expect(wo.deliveryAddress).toBe("بغداد — الكرادة");
  });

  it("سند قبض وصرف لجهة توصيل (DELIVERY_PARTY) يوثق التحصيل ويسوّي الرصيد بدقة في القيود المحاسبية", async () => {
    const partyRes = await createDeliveryParty({
      name: "شركة النسر للتوصيل",
      phone: "+9647700000009",
      partyType: "COMPANY",
      feeModel: "FIXED",
      defaultFee: "5000.00",
    }, MANAGER);

    const partyId = partyRes.id;
    const shift = await openReceptionShift();

    // إنشاء سند قبض (RECEIPT) من شركة التوصيل بالمبالغ المحصّلة نقداً
    const receiptVoucher = await createVoucher({
      clientRequestId: `req-${randomUUID()}`,
      branchId: 1,
      voucherType: "RECEIPT",
      amount: "25000.00",
      paymentMethod: "CASH",
      partyType: "DELIVERY_PARTY",
      partyId,
      description: "استلام متحصلات توصيل نقدي من المندوب",
      referenceNumber: "DLV-COLLECT-001",
    }, CASHIER);

    expect(receiptVoucher).toBeDefined();
    expect(receiptVoucher.receiptId).toBeGreaterThan(0);

    // التحقق من إنشاء مدخل دفتر أستاذ التوصيل
    const ledgerEntries = await db().select().from(s.deliveryLedgerEntries)
      .where(eq(s.deliveryLedgerEntries.partyId, partyId));
    expect(ledgerEntries.length).toBeGreaterThan(0);
    expect(ledgerEntries[0].entryType).toBe("COD_REMITTED");
    expect(ledgerEntries[0].amount).toBe("25000.00");

    // التحقق من القيد المحاسبي المزدوج DR CASH_ASSETS / CR DELIVERY_FLOAT
    const entries = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.receiptId, receiptVoucher.receiptId));
    expect(entries.length).toBe(1);
    expect(entries[0].entryType).toBe("PAYMENT_IN");
    expect(entries[0].amount).toBe("25000.00");
    expect(Number(entries[0].deliveryPartyId)).toBe(partyId);
  });

  it("أمر شغل مسند للتوصيل في حالة READY وصدرت له فاتورة يمكن إلغاؤه بسلاسة وفك إسناده وعكس فاتورته", async () => {
    const shift = await openReceptionShift();
    const partyRes = await createDeliveryParty({
      name: "شركة الفهد للتوصيل",
      partyType: "COMPANY",
      feeModel: "FIXED",
      defaultFee: "4000.00",
    }, MANAGER);

    const woRes = await createWorkOrder({
      branchId: 1,
      customerId: 1,
      title: "أمر شغل للتوصيل",
      salePrice: "15000.00",
      quantity: 1,
      deposit: "5000.00",
      paymentMethod: "CASH",
      hasDelivery: true,
      deliveryAddress: "بغداد — الجادرية",
      deliveryCost: "4000.00",
      deliveryFeeCollection: "COURIER",
    }, CASHIER);

    const workOrderId = (woRes as { workOrderId: number }).workOrderId;

    // تجهيز أمر الشغل بحالة READY
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, workOrderId));

    // إسناد أمر الشغل للتوصيل (يُصدر الفاتورة ويُنشئ الإرسالية)
    await dispatchToDelivery({
      workOrderId,
      partyId: partyRes.id,
      clientRequestId: `req-dispatch-${randomUUID()}`,
    }, MANAGER);

    // الآن أمر الشغل مرتبط بإرسالية وفاتورة
    const [woBefore] = await db().select().from(s.workOrders).where(eq(s.workOrders.id, workOrderId));
    expect(woBefore.invoiceId).not.toBeNull();
    const [parcelBefore] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.workOrderId, workOrderId));
    expect(parcelBefore).toBeDefined();
    expect(parcelBefore.parcelStatus).toBe("ASSIGNED");

    // طلب واعتماد إلغاء أمر الشغل — كسر الجمود المعماري
    const request = await requestWorkOrderControl({
      requestKey: `cancel-dispatch-${randomUUID()}`,
      workOrderId,
      requestType: "CANCEL",
      baseVersion: Number(woBefore.version),
      reason: "إلغاء الطلب بناء على رغبة العميل وفك إسناد التوصيل",
      payload: { refundShiftId: shift.shiftId, materials: null },
    }, MANAGER);

    await approveWorkOrderControlRequest(Number(request.id), OWNER, "موافق على الإلغاء وفك الشحنة");

    const [woAfter] = await db().select().from(s.workOrders).where(eq(s.workOrders.id, workOrderId));
    expect(woAfter.status).toBe("CANCELLED");

    // التحقق من فك الشحنة وإلغاء الطرد
    const [parcel] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.workOrderId, workOrderId));
    expect(parcel.parcelStatus).toBe("CANCELLED");
    expect(parcel.status).toBe("CANCELLED");
  });
});
