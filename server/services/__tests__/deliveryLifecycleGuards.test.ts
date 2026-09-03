/**
 * حرّاس دورة حياة الطلب المُسنَد + الإرجاع من أيّ حالة عبور (بلاغ المالك ١٨/٨: «المندوب يرجع
 * الفاتورة والطلب إلى المكتبة» — حدثٌ يوميّ).
 *
 * الجذر المشترك للأعطاب الأربعة: الإسناد **لا يمسّ** `workOrders.status` (يبقى READY حتى إثبات
 * التسليم)، فكلّ حارسٍ كان يفحص الحالة وحدها بقي أعمى عن الطرد الخارج:
 *  · الإلغاء كان يُعيد المواد ويردّ العربون بينما الفاتورة وقيد البيع وعهدة COD حيّة.
 *  · تغييرُ طريقة التسليم كان يردّ أمانة الأجرة والطرد بيد المندوب.
 *  · التسليم المباشر على أمرٍ له فاتورةُ إرسالٍ سابقة كان يُنشئ فاتورةً وقيدَ بيعٍ ثانيَين.
 *  · والإرجاع كان محصوراً بـASSIGNED|FAILED، وتسجيلُ FAILED حصريٌّ ببوّابة المندوب — وأغلب
 *    الجهات بلا حسابات ⇒ طردٌ بيد السائق **بلا مخرج إطلاقاً**.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveWorkOrderControlRequest,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";
import {
  decideWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";
import { updateWorkOrderDeliveryMethod } from "../workOrder/fulfillment";
import { deliverWorkOrder } from "../workOrder/deliver";
import { dispatchToDelivery } from "../delivery/dispatch";
import { returnConsignment } from "../delivery/returns";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "orderPayments", "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "workOrderControlRequests", "workOrderEvents", "workOrderDesignApprovals",
  "workOrderDesignRevisions", "taskEvents", "tasks", "serviceTypes",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const OWNER = { userId: 3, branchId: 1, role: "admin", isOwner: true };

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
    { id: 3, openId: "owner", name: "مالك معتمد", email: "o@t.test", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم",
    defaultKind: "SERVICE_REQUEST",
    defaultPriority: "HIGH",
    slaHours: 24,
    blocksExecution: true,
    isActive: true,
  });
  await d.insert(s.customers).values([
    { id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "مندوب أحمد", partyKind: "INDIVIDUAL", currentBalance: "0.00", isActive: true },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}

async function readyDeliveryOrder(reqId: string) {
  const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
  const r = await checkoutReception({
    branchId: 1, shiftId: shift.shiftId, customerId: 1,
    paidAmount: "0", clientRequestId: reqId,
    workOrders: [{
      title: "طلب توصيل", quantity: 1, salePrice: "20000.00", materials: [],
      hasDelivery: true, deliveryAddress: "بغداد", deliveryPhone: "+9647701234567",
    }],
  }, CASHIER);
  const woId = r.workOrders[0].workOrderId;
  const approval = await requestWorkOrderDesignApproval({
    workOrderId: woId,
    requestKey: `delivery-design-request:${randomUUID()}`,
    note: "اعتماد النسخة الحالية قبل التسليم",
  }, CASHIER);
  await decideWorkOrderDesignApproval({
    approvalId: Number(approval.approval.id),
    decisionKey: `delivery-design-decision:${randomUUID()}`,
    decision: "APPROVED",
    reason: "ثبتت موافقة العميل على النسخة المنفذة",
    evidence: { type: "WHATSAPP_MESSAGE", reference: `wamid.delivery.${randomUUID()}` },
  }, MANAGER);
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  return woId;
}
async function cancelGoverned(workOrderId: number) {
  const [workOrder] = await db().select({ version: s.workOrders.version })
    .from(s.workOrders).where(eq(s.workOrders.id, workOrderId));
  const request = await requestWorkOrderControl({
    requestKey: `delivery-cancel-request:${randomUUID()}`,
    workOrderId,
    requestType: "CANCEL",
    baseVersion: Number(workOrder.version),
    reason: "طلب إلغاء موثق بعد خروج الإرسالية مع المندوب",
    payload: { refundShiftId: null, materials: null },
  }, MANAGER);
  return approveWorkOrderControlRequest(
    Number(request.id),
    OWNER,
    "راجعت سبب الإلغاء ومسار الإرسالية قبل الاعتماد",
  );
}
const dispatch = (workOrderId: number, reqId: string) =>
  dispatchToDelivery({ workOrderId, partyId: 1, clientRequestId: reqId }, CASHIER);
const consignmentId = async () => Number((await db().select().from(s.deliveryConsignments))[0].id);
const setParcel = (p: string) =>
  db().update(s.deliveryConsignments).set({ parcelStatus: p as never });

beforeEach(async () => {
  await reset();
  await seed();
});

describe("حرّاس: لا عملية تفترض أنّ البضاعة في المكتبة والطرد بيد المندوب", () => {
  it("⭐ إلغاء أمرٍ خارجٍ مع مندوب ⇒ مرفوض (كان يعيد المواد ويردّ العربون والفاتورة حيّة)", async () => {
    const woId = await readyDeliveryOrder("g-1");
    await dispatch(woId, "gd-1");

    await expect(cancelGoverned(woId))
      .rejects.toThrowError(/استرجع الإرساليّة|استرجع الإرسالية/);

    // ذرّية: لا شيء تغيّر — الأمر والفاتورة كما هما.
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(wo.status).toBe("READY");
    expect(wo.invoiceId).not.toBeNull();
  });

  it("تغيير طريقة التسليم لأمرٍ خارجٍ ⇒ مرفوض (كان يردّ أمانة الأجرة والطرد بالخارج)", async () => {
    const woId = await readyDeliveryOrder("g-2");
    await dispatch(woId, "gd-2");

    await expect(updateWorkOrderDeliveryMethod(
      { workOrderId: woId, hasDelivery: false, confirmFeeRefund: true },
      MANAGER,
    )).rejects.toThrowError(/استرجع الإرساليّة|استرجع الإرسالية/);
  });

  it("التسليم المباشر لأمرٍ له فاتورةُ إرسالٍ سابقة ⇒ مرفوض (لا فاتورة ثانية لبضاعةٍ واحدة)", async () => {
    const woId = await readyDeliveryOrder("g-3");
    await dispatch(woId, "gd-3");
    // محاكاة التحوّل بعد إلغاء الإسناد: الفاتورة تبقى، والعلَم يُقلَب يدوياً في القاعدة.
    await db().update(s.deliveryConsignments).set({ status: "CANCELLED", parcelStatus: "CANCELLED" });
    await db().update(s.workOrders).set({ hasDelivery: false }).where(eq(s.workOrders.id, woId));

    await expect(deliverWorkOrder({ workOrderId: woId }, CASHIER))
      .rejects.toThrowError(/فاتورةٌ صادرة سلفاً|فاتورة صادرة سلفا/);
    expect((await db().select().from(s.invoices))).toHaveLength(1); // فاتورةٌ واحدة لا اثنتان
  });
});

describe("الإرجاع من أيّ حالة عبور — مخرجٌ للطرد الذي أعاده المندوب", () => {
  it("⭐ إرجاعٌ من OUT_FOR_DELIVERY بسببٍ ⇒ يمرّ، يَسِم الطرد متعذّراً ثم يعكس البيع كاملاً", async () => {
    const woId = await readyDeliveryOrder("g-4");
    await dispatch(woId, "gd-4");
    await setParcel("OUT_FOR_DELIVERY");
    const cnId = await consignmentId();

    await returnConsignment(cnId, {
      ...MANAGER,
      clientRequestId: "ret-transit-1",
      returnReason: "العميل رفض الاستلام",
    });

    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, cnId)))[0];
    expect(cn.status).toBe("RETURNED");
    expect(cn.failureReason).toBe("العميل رفض الاستلام");
    // سلسلة الأحداث سليمة: FAILED ثم RETURNED (لا قفزة صامتة).
    const events = await db().select().from(s.deliveryEvents).where(eq(s.deliveryEvents.consignmentId, cnId));
    expect(events.map((e) => e.eventType)).toContain("PARCEL_FAILED");
    // العكس الكامل: الفاتورة مرتجعة والأمر ملغى وذمّة العميل صفر.
    const inv = (await db().select().from(s.invoices))[0];
    expect(inv.status).toBe("RETURNED");
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(wo.status).toBe("CANCELLED");
    expect(Number((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance)).toBe(0);
  });

  it("الإرجاع من حالة عبور بلا سبب ⇒ مرفوض (لا تعثّرٌ مجهول السبب في التقارير)", async () => {
    const woId = await readyDeliveryOrder("g-5");
    await dispatch(woId, "gd-5");
    await setParcel("PICKED_UP");

    await expect(returnConsignment(await consignmentId(), { ...MANAGER, clientRequestId: "ret-noreason" }))
      .rejects.toThrowError(/سبب رجوعه/);
  });

  it("الإرجاع من ASSIGNED يبقى كما كان — بلا سببٍ إلزاميّ (لم يخرج أصلاً)", async () => {
    const woId = await readyDeliveryOrder("g-6");
    await dispatch(woId, "gd-6");

    await expect(returnConsignment(await consignmentId(), { ...MANAGER, clientRequestId: "ret-assigned" }))
      .resolves.toMatchObject({ reversed: true });
  });
});
