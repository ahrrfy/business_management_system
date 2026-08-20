/**
 * ش٢ — موافقة التصميم مهمّةٌ حاجزة، والنسخةُ الجديدة تُبطلها (١٩/٨).
 *
 * الثوابت المحروسة — وأخطرُها الأوّل:
 *  ① البدء مرفوضٌ بمهمّةٍ حاجزة مفتوحة، **و`branchStock` و`inventoryMovements` بلا صفٍّ
 *     جديد**: الحارس قبل القفل ⇒ لا دينارَ خامةٍ يُستهلَك على تصميمٍ لم يُقرَّ، ولا أثرَ
 *     نصفيّ يُترك خلفه.
 *  ② بعد إغلاق المهمّة يمرّ البدء.
 *  ③ `markReady` مرفوضٌ بمهمّةٍ فُتحت **أثناء** التنفيذ (نسخةٌ جديدة تُبطل ما بُني عليه).
 *  ④ مهمّةٌ `blocksExecution=false` لا تمنع شيئاً — الحجزُ سياسةٌ لا مجرّد ارتباط.
 *  ⑤ idempotency: نداءان ⇒ مهمّةٌ واحدة.
 *  ⑥ حفظُ نفس مجموعة الصور ⇒ **لا نسخة ولا مهمّة** (لا يُبطل الحفظُ الأعمى موافقةً قائمة).
 *  ⑦ تغييرُ صورةٍ ⇒ `revision+1` والقديمة **باقية** (سجلٌّ بلا حذف).
 *  ⑧ حمولةٌ غير صورةٍ بترويسة صورة ⇒ مرفوضة (`strictMagic`).
 *  ⑨ **أمرٌ بلا تصميم يبدأ كما هو اليوم** — عدمُ انحدار.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import { startWorkOrder, markWorkOrderReady } from "../workOrder/lifecycle";
import { requestDesignApproval } from "../workOrder/approval";
import { setWorkOrderDesign } from "../workOrder/design";
import { claimTask, resolveTask } from "../tasks/lifecycle";

const TABLES = [
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
const getInsertId = (r: any): number => Number(r?.[0]?.insertId ?? r?.insertId);

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

/** صورةُ PNG صالحةٌ فعلاً (بايتات سليمة) — `strictMagic` يفحص البايتات لا الترويسة. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG2 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let blockingTypeId = 0;
let plainTypeId = 0;

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "m", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "c", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.products).values([{ id: 1, name: "ورق" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "P-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);

  // النوعان: الحاجز (كما تبذره الهجرة 0236) وغيرُ الحاجز.
  blockingTypeId = getInsertId(await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم", defaultKind: "SERVICE_REQUEST", defaultPriority: "HIGH",
    slaHours: 24, isActive: true, blocksExecution: true,
  } as never));
  plainTypeId = getInsertId(await d.insert(s.serviceTypes).values({
    name: "متابعة عادية", defaultKind: "FOLLOW_UP", defaultPriority: "NORMAL",
    slaHours: 48, isActive: true, blocksExecution: false,
  } as never));
});

/** أمرُ شغلٍ بمادّةٍ واحدة — كي يكون للبدء أثرٌ مخزنيٌّ يمكن قياس غيابه. */
async function order(reqId: string) {
  const r = await createWorkOrder({
    branchId: 1, customerId: 1, title: "لوحة إعلانية", quantity: 1,
    salePrice: "50000.00", deposit: "0",
    materials: [{ variantId: 1, baseQuantity: 5 }],
    clientRequestId: reqId,
  } as never, CASHIER);
  return Number((r as { workOrderId: number }).workOrderId);
}
const stockOf = async () =>
  Number((await db().select().from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0].quantity);
const movementCount = async () =>
  Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.inventoryMovements))[0].n);

describe("ش٢ — حارس موافقة التصميم", () => {
  it("⭐ ① البدء مرفوض — وصفر أثرٍ مخزنيّ (الحارس قبل القفل)", async () => {
    const woId = await order("ap-1");
    await requestDesignApproval({ workOrderId: woId }, CASHIER);

    const before = { stock: await stockOf(), moves: await movementCount() };
    await expect(startWorkOrder(woId, CASHIER)).rejects.toThrowError(/موافقة العميل|لا يبدأ التنفيذ/);

    // الثابت الأخطر: لا خامةَ استُهلكت ولا حركةَ كُتبت.
    expect(await stockOf()).toBe(before.stock);
    expect(await movementCount()).toBe(before.moves);
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(wo.status).toBe("RECEIVED");
  });

  it("⭐ ② بعد إغلاق المهمّة يمرّ البدء", async () => {
    const woId = await order("ap-2");
    const res = await requestDesignApproval({ workOrderId: woId }, CASHIER);
    // دورةُ المهمّة الحقيقيّة: NEW ⇒ (سحب) IN_PROGRESS ⇒ (حلّ) RESOLVED — `resolveTask`
    // ترفض المهمّة NEW صراحةً، فالتسجيل يمرّ بالسحب أوّلاً.
    await claimTask(res.taskId, MANAGER);
    await resolveTask(res.taskId, MANAGER, "وافق العميل هاتفياً");

    await startWorkOrder(woId, CASHIER);
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(wo.status).toBe("IN_PROGRESS");
    expect(await stockOf()).toBe(95); // الخامة استُهلكت الآن فقط
  });

  it("⭐ ③ نسخةٌ تُفتَح أثناء التنفيذ تمنع الوسم جاهزاً", async () => {
    const woId = await order("ap-3");
    const first = await requestDesignApproval({ workOrderId: woId }, CASHIER);
    await claimTask(first.taskId, MANAGER);
    await resolveTask(first.taskId, MANAGER, "وافق");
    await startWorkOrder(woId, CASHIER);

    await requestDesignApproval({ workOrderId: woId, note: "العميل طلب تعديلاً" }, CASHIER);
    await expect(markWorkOrderReady(woId, CASHIER)).rejects.toThrowError(/لا يُوسَم الأمر جاهزاً/);
  });

  it("⭐ ④ مهمّةٌ غير حاجزة لا تمنع شيئاً", async () => {
    const woId = await order("ap-4");
    const { createTask } = await import("../tasks/create");
    await createTask({
      branchId: 1, title: "اتصل بالعميل", serviceTypeId: plainTypeId, linkedWorkOrderId: woId,
    } as never, { userId: 2, branchId: 1, role: "cashier" });

    await startWorkOrder(woId, CASHIER); // يمرّ
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(wo.status).toBe("IN_PROGRESS");
  });

  it("⭐ ⑤ idempotent: نداءان ⇒ مهمّةٌ واحدة", async () => {
    const woId = await order("ap-5");
    const a = await requestDesignApproval({ workOrderId: woId }, CASHIER);
    const b = await requestDesignApproval({ workOrderId: woId }, CASHIER);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.taskId).toBe(a.taskId);
    const n = (await db().select({ n: sql<number>`COUNT(*)` }).from(s.tasks))[0];
    expect(Number(n.n)).toBe(1);
  });

  it("⭐ ⑨ أمرٌ بلا تصميم يبدأ كما هو اليوم (عدم انحدار)", async () => {
    const woId = await order("ap-9");
    await startWorkOrder(woId, CASHIER);
    expect(await stockOf()).toBe(95);
  });
});

describe("ش٢ — نسخةُ ملفّ التصميم", () => {
  it("⭐ ⑦ تغييرُ صورةٍ ⇒ نسخةٌ جديدة والقديمة باقية", async () => {
    const woId = await order("dz-1");
    const r1 = await setWorkOrderDesign({ workOrderId: woId, images: [{ url: PNG }] }, CASHIER);
    expect(r1.changed).toBe(true);
    expect(r1.revision).toBe(1);

    const r2 = await setWorkOrderDesign({ workOrderId: woId, images: [{ url: PNG2 }] }, CASHIER);
    expect(r2.revision).toBe(2);

    const rows = await db().select().from(s.workOrderImages).where(eq(s.workOrderImages.workOrderId, woId));
    expect(rows.length).toBe(2); // سجلٌّ بلا حذف
    expect(rows.filter((x) => Number(x.revision) === 1)).toHaveLength(1);
    expect(rows.filter((x) => Number(x.revision) === 2)).toHaveLength(1);
  });

  it("⭐ ⑥ حفظُ نفس المجموعة ⇒ لا نسخة ولا مهمّة", async () => {
    const woId = await order("dz-2");
    await setWorkOrderDesign({ workOrderId: woId, images: [{ url: PNG }] }, CASHIER);
    const tasksAfterFirst = Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.tasks))[0].n);

    const again = await setWorkOrderDesign({ workOrderId: woId, images: [{ url: PNG }] }, CASHIER);
    expect(again.changed).toBe(false);
    expect(again.revision).toBe(1);
    expect(Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.tasks))[0].n)).toBe(tasksAfterFirst);
  });

  it("⭐ ⑧ حمولةٌ غير صورةٍ بترويسة صورة ⇒ مرفوضة", async () => {
    const woId = await order("dz-3");
    // ترويسةٌ سليمة وبايتاتٌ ليست PNG.
    const fake = "data:image/png;base64," + Buffer.from("<script>alert(1)</script>").toString("base64");
    await expect(
      setWorkOrderDesign({ workOrderId: woId, images: [{ url: fake }] }, CASHIER),
    ).rejects.toThrowError();
  });

  it("⭐ حفظُ نسخةٍ يفتح الحجز فيُرفَض البدء", async () => {
    const woId = await order("dz-4");
    await setWorkOrderDesign({ workOrderId: woId, images: [{ url: PNG }] }, CASHIER);
    await expect(startWorkOrder(woId, CASHIER)).rejects.toThrowError(/لا يبدأ التنفيذ/);
  });

  it("لا يُعدَّل تصميم أمرٍ ملغى", async () => {
    const woId = await order("dz-5");
    await db().update(s.workOrders).set({ status: "CANCELLED" }).where(eq(s.workOrders.id, woId));
    await expect(
      setWorkOrderDesign({ workOrderId: woId, images: [{ url: PNG }] }, CASHIER),
    ).rejects.toThrowError(/مُسلَّم أو ملغى/);
  });
});
