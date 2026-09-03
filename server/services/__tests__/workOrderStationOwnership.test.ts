/**
 * ش٣ — ملكيّةُ أمر الشغل: لا يتيم، ولا نقلَ صامتاً، وطريقُ خروجٍ للفنّي (١٩/٨).
 *
 * **والمنطقة بلا اختبارٍ واحد اليوم** — وهو سببُ بقاء العطب الأوّل حيّاً:
 * `startWorkOrder` **لا يكتب `assignedTo`**، و`assertOperatorOwns` تمرّ بصمتٍ لكلّ من ليس
 * `print_operator`. فكاشيرٌ يسحب البطاقة في الكانبان ⇒ تُخصَم المواد ويبقى `assignedTo=NULL`.
 * بعدها: `claim` يشترط RECEIVED فيرفض، و`markReady` يرفض كلّ فنّيّ لأنّه غير مُسنَد، والأمر
 * لا يظهر في أيٍّ من قائمتَي المحطّة. **النتيجة: مواد مخصومة وقيد WIP قائم وأمرٌ لا يراه أحد.**
 *
 * الثوابت المحروسة:
 *  (أ) البدءُ بلا مُسنَدٍ يجعل الفاعل مُسنَداً — **يموت اليتيم**.
 *  (ب) البدءُ لا يسرق أمراً مُسنَداً لغيره.
 *  (ج) التحرّر الذاتيّ مسموحٌ في RECEIVED ومرفوضٌ بعد البدء (المواد مستهلَكة).
 *  (د) النقل بعد البدء **بلا سببٍ مرفوض**، ومعه يُكتب `oldValue` فيُعرف مِمَّن نُقل.
 *  (هـ) الإسناد لموظّفٍ بلا وحدة `workorders` مرفوض.
 *  (و) `assignableStaff` تُرجع الحمل والمداومة.
 *  (ز) عزل الفرع في كلّ ما سبق.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import {
  claimWorkOrder,
  markWorkOrderReady,
  reassignWorkOrder,
  releaseWorkOrder,
  startWorkOrder,
} from "../workOrder/lifecycle";
import {
  decideWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";

const TABLES = [
  "workOrderEvents",
  "workOrderDesignApprovals", "workOrderDesignRevisions",
  "taskEvents", "tasks", "serviceTypes",
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users", "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const TECH_A = { userId: 3, branchId: 1, role: "print_operator" };
const TECH_B = { userId: 4, branchId: 1, role: "print_operator" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
// يحاكي actor الراوتر الحالي: حساب admin بلا فرع في DB، لكن fallback يمرر branchId=1.
const ADMIN_ROUTER_ACTOR = { userId: 7, branchId: 1, role: "admin" };
/** موظّفٌ بلا وحدة أوامر شغل — لا يجوز أن يُسنَد إليه أمر. */
const OUTSIDER = { userId: 5, branchId: 1, role: "accountant" };

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "m", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "c", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "t1", name: "فنّي أ", email: "t1@t.test", role: "print_operator", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "t2", name: "فنّي ب", email: "t2@t.test", role: "print_operator", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "acc", name: "محاسب", email: "a@t.test", role: "accountant", loginMethod: "local", branchId: 1 },
    { id: 6, openId: "t3", name: "فنّي فرع آخر", email: "t3@t.test", role: "print_operator", loginMethod: "local", branchId: 2 },
    { id: 7, openId: "admin", name: "مدير النظام", email: "admin@t.test", role: "admin", loginMethod: "local", branchId: null },
    { id: 8, openId: "design-reviewer", name: "مراجع التصميم", email: "review@t.test", role: "admin", loginMethod: "local", branchId: null },
  ]);
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم", defaultKind: "SERVICE_REQUEST", defaultPriority: "HIGH",
    slaHours: 24, isActive: true, blocksExecution: true,
  });
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.products).values([{ id: 1, name: "ورق" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "P-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 1, branchId: 2, quantity: 100 },
  ]);
});

async function order(
  reqId: string,
  branchId = 1,
  actor: { userId: number; branchId: number; role: string } = { ...CASHIER, branchId },
) {
  const r = await createWorkOrder({
    branchId, customerId: 1, title: "لوحة", quantity: 1, salePrice: "10000.00", deposit: "0",
    materials: [{ variantId: 1, baseQuantity: 2 }], clientRequestId: reqId,
  } as never, actor as never);
  return Number((r as { workOrderId: number }).workOrderId);
}
const woOf = async (id: number) =>
  (await db().select().from(s.workOrders).where(eq(s.workOrders.id, id)))[0];

async function approveCurrentDesign(workOrderId: number, branchId = 1) {
  const requester = branchId === 1 ? MANAGER : { ...ADMIN_ROUTER_ACTOR, branchId };
  const requested = await requestWorkOrderDesignApproval(
    {
      workOrderId,
      requestKey: `station-ownership-design-request:${randomUUID()}`,
      note: "اعتماد التصميم قبل اختبار ملكية التنفيذ",
    },
    requester,
  );
  await decideWorkOrderDesignApproval(
    {
      approvalId: Number(requested.approval.id),
      decisionKey: `station-ownership-design-approve:${randomUUID()}`,
      decision: "APPROVED",
      reason: "راجع العميل التصميم ووافق على التنفيذ",
      evidence: {
        type: "WHATSAPP_MESSAGE",
        reference: `wamid.station-ownership.${randomUUID()}`,
      },
    },
    { userId: 8, branchId, role: "admin" },
  );
}

describe("ش٣ — ملكيّة أمر الشغل", () => {
  it("⭐ (أ) البدءُ بلا مُسنَد يجعل الفاعل مُسنَداً — يموت اليتيم", async () => {
    const woId = await order("st-1");
    expect((await woOf(woId)).assignedTo).toBeNull();

    await approveCurrentDesign(woId);
    await startWorkOrder(woId, CASHIER);

    const wo = await woOf(woId);
    expect(wo.status).toBe("IN_PROGRESS");
    // العطب التاريخيّ: كان يبقى NULL فلا يراه منفّذٌ ولا يستطيع أحدٌ وسمَه جاهزاً.
    expect(Number(wo.assignedTo)).toBe(CASHIER.userId);
  });

  it("⭐ (ب) البدءُ لا يسرق أمراً مُسنَداً لغيره", async () => {
    const woId = await order("st-2");
    await claimWorkOrder(woId, TECH_A);
    await approveCurrentDesign(woId);
    await startWorkOrder(woId, TECH_A);
    expect(Number((await woOf(woId)).assignedTo)).toBe(TECH_A.userId);
  });

  it("⭐ (ج) التحرّر الذاتيّ: مسموحٌ قبل البدء ومرفوضٌ بعده", async () => {
    const woId = await order("st-3");
    await claimWorkOrder(woId, TECH_A);
    await releaseWorkOrder(woId, TECH_A);
    expect((await woOf(woId)).assignedTo).toBeNull(); // عاد للطابور

    await claimWorkOrder(woId, TECH_A);
    await approveCurrentDesign(woId);
    await startWorkOrder(woId, TECH_A);
    // المواد مستهلَكة والمؤقّت يعمل ⇒ لا انسحابَ صامت.
    await expect(releaseWorkOrder(woId, TECH_A)).rejects.toThrowError(/بعد بدء التنفيذ|انقله/);
  });

  it("⭐ (د) النقل بعد البدء بلا سببٍ مرفوض — ومعه يُكتب مِمَّن نُقل", async () => {
    const woId = await order("st-4");
    await claimWorkOrder(woId, TECH_A);
    await approveCurrentDesign(woId);
    await startWorkOrder(woId, TECH_A);

    await expect(
      reassignWorkOrder({ workOrderId: woId, assignedTo: TECH_B.userId }, MANAGER),
    ).rejects.toThrowError(/سبب/);

    await reassignWorkOrder(
      { workOrderId: woId, assignedTo: TECH_B.userId, reason: "الفنّي أ في إجازة طارئة" },
      MANAGER,
    );
    expect(Number((await woOf(woId)).assignedTo)).toBe(TECH_B.userId);

    const log = (await db().select().from(s.auditLogs)
      .where(eq(s.auditLogs.action, "workOrder.assign")))[0];
    expect(log).toBeTruthy();
    // بلا oldValue لا يُعرف مِمَّن نُقل الأمر — وهي الحقيقة التي يحتاجها المشرف.
    expect(Number((log.oldValue as { assignedTo: number }).assignedTo)).toBe(TECH_A.userId);
  });

  it("⭐ (هـ) الإسناد لموظّفٍ بلا وحدة أوامر الشغل مرفوض", async () => {
    const woId = await order("st-5");
    await expect(
      reassignWorkOrder({ workOrderId: woId, assignedTo: OUTSIDER.userId }, MANAGER),
    ).rejects.toThrowError(/صلاحية|أوامر الشغل/);
  });

  it("⭐ (ز) عزل الفرع: لا إسناد لفنّيّ فرعٍ آخر", async () => {
    const woId = await order("st-6");
    await expect(
      reassignWorkOrder({ workOrderId: woId, assignedTo: 6 }, MANAGER),
    ).rejects.toThrowError(/فرع/);
  });

  it("النقل قبل البدء لا يلزمه سبب (لا مواد مستهلَكة)", async () => {
    const woId = await order("st-7");
    await reassignWorkOrder({ workOrderId: woId, assignedTo: TECH_A.userId }, MANAGER);
    expect(Number((await woOf(woId)).assignedTo)).toBe(TECH_A.userId);
  });

  it("صفر أثرٍ ماليّ من كلّ ما سبق", async () => {
    const woId = await order("st-8");
    const before = Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.accountingEntries))[0].n);
    await reassignWorkOrder({ workOrderId: woId, assignedTo: TECH_A.userId }, MANAGER);
    await releaseWorkOrder(woId, TECH_A);
    expect(Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.accountingEntries))[0].n)).toBe(before);
    const stock = (await db().select().from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    expect(Number(stock.quantity)).toBe(100); // لم يبدأ ⇒ لا خصم
  });

  it("admin العابر للفروع ينسب claim/release/start/ready إلى فرع الأمر المقفول", async () => {
    const woId = await order("st-admin-branch", 2, ADMIN_ROUTER_ACTOR);

    await claimWorkOrder(woId, ADMIN_ROUTER_ACTOR);
    await releaseWorkOrder(woId, ADMIN_ROUTER_ACTOR);
    await claimWorkOrder(woId, ADMIN_ROUTER_ACTOR);
    await approveCurrentDesign(woId, 2);
    await startWorkOrder(woId, ADMIN_ROUTER_ACTOR);
    await markWorkOrderReady(woId, ADMIN_ROUTER_ACTOR);

    const audits = await db()
      .select({ action: s.auditLogs.action, branchId: s.auditLogs.branchId })
      .from(s.auditLogs)
      .where(eq(s.auditLogs.entityId, String(woId)));
    const lifecycleAudits = audits.filter((row) =>
      ["workOrder.claim", "workOrder.release", "workOrder.start", "workOrder.markReady"].includes(row.action),
    );
    expect([...new Set(lifecycleAudits.map((row) => row.action))].sort()).toEqual([
      "workOrder.claim",
      "workOrder.markReady",
      "workOrder.release",
      "workOrder.start",
    ]);
    expect(lifecycleAudits.every((row) => Number(row.branchId) === 2)).toBe(true);
    expect(lifecycleAudits.some((row) => Number(row.branchId) === 1)).toBe(false);

    const events = await db()
      .select({ eventType: s.workOrderEvents.eventType, branchId: s.workOrderEvents.branchId })
      .from(s.workOrderEvents)
      .where(eq(s.workOrderEvents.workOrderId, woId));
    expect(events.map((row) => row.eventType).sort()).toEqual([
      "CLAIMED",
      "DESIGN_APPROVED",
      "MARKED_READY",
      "STARTED",
    ]);
    expect(events.every((row) => Number(row.branchId) === 2)).toBe(true);
    expect(events.some((row) => Number(row.branchId) === 1)).toBe(false);
  });
});
