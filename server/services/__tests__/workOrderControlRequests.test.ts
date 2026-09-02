import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import {
  approveWorkOrderControlRequest,
  getWorkOrderControlPreflight,
  listPendingWorkOrderControls,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";
import { cancelWorkOrder } from "../workOrder/cancel";

const TABLES = [
  "workOrderControlRequests", "workOrderEvents", "idempotencyKeys",
  "accountingEntries", "receipts", "inventoryMovements", "orderPayments",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

const MAKER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const OTHER_MANAGER = { userId: 3, branchId: 1, role: "manager" };
const BRANCH_2_MANAGER = { userId: 4, branchId: 2, role: "manager" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الثاني", code: "B2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "manager-1", name: "مدير ١", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "maker-1", name: "منشئ", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "manager-2", name: "مدير ٢", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "manager-b2", name: "مدير فرع ٢", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل ١", currentBalance: "0.00" },
    { id: 2, name: "عميل ٢", currentBalance: "0.00" },
  ]);
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAPER-1", costPrice: "500.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 100 });
}

async function createOrder(
  creator = MAKER,
  materials: Array<{ variantId: number; baseQuantity: number }> = [{ variantId: 1, baseQuantity: 2 }],
) {
  const result = await createWorkOrder({
    branchId: creator.branchId,
    customerId: 1,
    title: "أمر أصلي",
    salePrice: "10000.00",
    quantity: 1,
    materials,
  }, creator);
  return Number((result as { workOrderId: number }).workOrderId);
}

async function order(id: number) {
  return (await db().select().from(s.workOrders).where(eq(s.workOrders.id, id)).limit(1))[0];
}

async function requestCommercial(workOrderId: number, requestKey: string, actor = MAKER) {
  const current = await order(workOrderId);
  return requestWorkOrderControl({
    requestKey,
    workOrderId,
    requestType: "COMMERCIAL_EDIT",
    baseVersion: Number(current.version),
    reason: "تصحيح تجاري موثّق",
    payload: { title: "عنوان معتمد" },
  }, actor);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("طلبات التحكم بأوامر الشغل", () => {
  it("PENDING صفر أثر، وإعادة requestKey مطابقة فقط", async () => {
    const workOrderId = await createOrder();
    const before = await order(workOrderId);
    const beforeMaterials = await db().select().from(s.workOrderMaterials)
      .where(eq(s.workOrderMaterials.workOrderId, workOrderId));
    const input = {
      requestKey: "wo-material-zero-effect-1",
      workOrderId,
      requestType: "MATERIAL_ADJUST" as const,
      baseVersion: Number(before.version),
      reason: "تغيير كمية الورق بطلب العميل",
      payload: { materials: [{ variantId: 1, baseQuantity: 8 }] },
    };
    const first = await requestWorkOrderControl(input, MAKER);
    expect(first.status).toBe("PENDING");
    expect((await order(workOrderId)).version).toBe(before.version);
    expect(await db().select().from(s.workOrderMaterials)
      .where(eq(s.workOrderMaterials.workOrderId, workOrderId))).toEqual(beforeMaterials);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);

    const replay = await requestWorkOrderControl(input, MAKER);
    expect(replay.replayed).toBe(true);
    expect(Number(replay.id)).toBe(Number(first.id));
    await expect(requestWorkOrderControl({
      ...input,
      payload: { materials: [{ variantId: 1, baseQuantity: 9 }] },
    }, MAKER)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.workOrderControlRequests)).toHaveLength(1);
  });

  it("يفرض فصل الواجبات على المنشئ، وعلى منشئ/مسند الأمر في الإلغاء والمواد", async () => {
    const workOrderId = await createOrder();
    const own = await requestCommercial(workOrderId, "wo-sod-own", MANAGER);
    await expect(approveWorkOrderControlRequest(Number(own.id), MANAGER))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    const managerCreated = await createOrder(MANAGER);
    const current = await order(managerCreated);
    const materialRequest = await requestWorkOrderControl({
      requestKey: "wo-sod-creator-material",
      workOrderId: managerCreated,
      requestType: "MATERIAL_ADJUST",
      baseVersion: Number(current.version),
      reason: "تعديل مواد بعد مراجعة",
      payload: { materials: [{ variantId: 1, baseQuantity: 3 }] },
    }, MAKER);
    await expect(approveWorkOrderControlRequest(Number(materialRequest.id), MANAGER))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    await db().update(s.workOrders).set({ assignedTo: OTHER_MANAGER.userId })
      .where(eq(s.workOrders.id, workOrderId));
    const assigned = await order(workOrderId);
    const cancelRequest = await requestWorkOrderControl({
      requestKey: "wo-sod-assignee-cancel",
      workOrderId,
      requestType: "CANCEL",
      baseVersion: Number(assigned.version),
      reason: "إلغاء تشغيلي موثّق",
      payload: {},
    }, MAKER);
    await expect(approveWorkOrderControlRequest(Number(cancelRequest.id), OTHER_MANAGER))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("الاعتماد ذرّي ومزدوج الاعتماد يعيد النتيجة بلا تطبيق ثانٍ", async () => {
    const workOrderId = await createOrder();
    const request = await requestCommercial(workOrderId, "wo-approve-race");
    const [a, b] = await Promise.all([
      approveWorkOrderControlRequest(Number(request.id), MANAGER),
      approveWorkOrderControlRequest(Number(request.id), OTHER_MANAGER),
    ]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    const applied = await order(workOrderId);
    expect(applied.title).toBe("عنوان معتمد");
    expect(Number(applied.version)).toBe(Number(request.baseVersion) + 1);
    const commercialEvents = await db().select().from(s.workOrderEvents)
      .where(and(eq(s.workOrderEvents.workOrderId, workOrderId), eq(s.workOrderEvents.eventType, "COMMERCIAL_UPDATED")));
    expect(commercialEvents).toHaveLength(1);
  });

  it("النسخة القديمة تُوسم STALE ولا تطبق الحمولة", async () => {
    const workOrderId = await createOrder();
    const request = await requestCommercial(workOrderId, "wo-stale-1");
    await db().update(s.workOrders).set({ priority: "URGENT" }).where(eq(s.workOrders.id, workOrderId));
    await expect(approveWorkOrderControlRequest(Number(request.id), MANAGER))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await order(workOrderId)).title).toBe("أمر أصلي");
    const saved = (await db().select().from(s.workOrderControlRequests)
      .where(eq(s.workOrderControlRequests.id, Number(request.id))))[0];
    expect(saved.status).toBe("STALE");
    expect(Number(saved.reviewedBy)).toBe(MANAGER.userId);
  });

  it("الفاتورة تحجب الطلب التجاري/المادي، والعزل يمنع فرعاً آخر", async () => {
    const workOrderId = await createOrder();
    await db().insert(s.invoices).values({
      invoiceNumber: "INV-WO-GUARD-1",
      sourceType: "WORKORDER",
      sourceId: String(workOrderId),
      branchId: 1,
      customerId: 1,
      subtotal: "10000.00",
      total: "10000.00",
      status: "PENDING",
    });
    const invoiceId = Number((await db().select({ id: s.invoices.id }).from(s.invoices)
      .where(eq(s.invoices.invoiceNumber, "INV-WO-GUARD-1")))[0].id);
    await db().update(s.workOrders).set({ invoiceId }).where(eq(s.workOrders.id, workOrderId));
    const current = await order(workOrderId);
    await expect(requestWorkOrderControl({
      requestKey: "wo-invoice-guard",
      workOrderId,
      requestType: "COMMERCIAL_EDIT",
      baseVersion: Number(current.version),
      reason: "محاولة تعديل بعد الفاتورة",
      payload: { title: "مرفوض" },
    }, MAKER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(requestWorkOrderControl({
      requestKey: "wo-branch-guard",
      workOrderId,
      requestType: "CANCEL",
      baseVersion: Number(current.version),
      reason: "محاولة عابرة للفرع",
      payload: {},
    }, BRANCH_2_MANAGER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await listPendingWorkOrderControls(BRANCH_2_MANAGER)).toHaveLength(0);
  });

  it("الإلغاء ذو المواد لا يمر مباشرة، ويعرض preflight نسخة ودرج الاسترداد", async () => {
    const workOrderId = await createOrder();
    const current = await order(workOrderId);
    await expect(cancelWorkOrder(workOrderId, MANAGER, {
      expectedVersion: Number(current.version),
      reason: "إلغاء مباشر خطر",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await order(workOrderId)).status).toBe("RECEIVED");

    await db().insert(s.shifts).values({
      id: 10,
      branchId: 1,
      userId: MAKER.userId,
      openingBalance: "25000.00",
      expectedCash: "25000.00",
      status: "OPEN",
      shiftType: "RECEPTION",
      openGuard: "2:1:RECEPTION",
    });
    const preflight = await getWorkOrderControlPreflight(workOrderId, MAKER);
    expect(preflight.version).toBe(Number(current.version));
    expect(preflight.controlRequired.cancel).toBe(true);
    expect(preflight.openReceptionShifts).toEqual([
      expect.objectContaining({ id: 10, userId: 2, userName: "منشئ", expectedCash: "25000.00" }),
    ]);
  });
});
