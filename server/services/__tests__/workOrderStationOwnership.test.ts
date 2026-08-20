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
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import { startWorkOrder, claimWorkOrder, reassignWorkOrder, releaseWorkOrder } from "../workOrder/lifecycle";

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

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const TECH_A = { userId: 3, branchId: 1, role: "print_operator" };
const TECH_B = { userId: 4, branchId: 1, role: "print_operator" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
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
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.products).values([{ id: 1, name: "ورق" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "P-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
});

async function order(reqId: string, branchId = 1) {
  const r = await createWorkOrder({
    branchId, customerId: 1, title: "لوحة", quantity: 1, salePrice: "10000.00", deposit: "0",
    materials: [{ variantId: 1, baseQuantity: 2 }], clientRequestId: reqId,
  } as never, { ...CASHIER, branchId });
  return Number((r as { workOrderId: number }).workOrderId);
}
const woOf = async (id: number) =>
  (await db().select().from(s.workOrders).where(eq(s.workOrders.id, id)))[0];

describe("ش٣ — ملكيّة أمر الشغل", () => {
  it("⭐ (أ) البدءُ بلا مُسنَد يجعل الفاعل مُسنَداً — يموت اليتيم", async () => {
    const woId = await order("st-1");
    expect((await woOf(woId)).assignedTo).toBeNull();

    await startWorkOrder(woId, CASHIER);

    const wo = await woOf(woId);
    expect(wo.status).toBe("IN_PROGRESS");
    // العطب التاريخيّ: كان يبقى NULL فلا يراه منفّذٌ ولا يستطيع أحدٌ وسمَه جاهزاً.
    expect(Number(wo.assignedTo)).toBe(CASHIER.userId);
  });

  it("⭐ (ب) البدءُ لا يسرق أمراً مُسنَداً لغيره", async () => {
    const woId = await order("st-2");
    await claimWorkOrder(woId, TECH_A);
    await startWorkOrder(woId, TECH_A);
    expect(Number((await woOf(woId)).assignedTo)).toBe(TECH_A.userId);
  });

  it("⭐ (ج) التحرّر الذاتيّ: مسموحٌ قبل البدء ومرفوضٌ بعده", async () => {
    const woId = await order("st-3");
    await claimWorkOrder(woId, TECH_A);
    await releaseWorkOrder(woId, TECH_A);
    expect((await woOf(woId)).assignedTo).toBeNull(); // عاد للطابور

    await claimWorkOrder(woId, TECH_A);
    await startWorkOrder(woId, TECH_A);
    // المواد مستهلَكة والمؤقّت يعمل ⇒ لا انسحابَ صامت.
    await expect(releaseWorkOrder(woId, TECH_A)).rejects.toThrowError(/بعد بدء التنفيذ|انقله/);
  });

  it("⭐ (د) النقل بعد البدء بلا سببٍ مرفوض — ومعه يُكتب مِمَّن نُقل", async () => {
    const woId = await order("st-4");
    await claimWorkOrder(woId, TECH_A);
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
});
