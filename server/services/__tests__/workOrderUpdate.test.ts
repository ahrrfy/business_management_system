/**
 * اختبارات updateWorkOrder — تصحيح تفاصيل طلبٍ لم يُسلَّم بعد (سعر/عنوان/تخصيص/عميل/موعد/أولوية/
 * قناة). حراسها: يُرفَض بعد DELIVERED/CANCELLED، عزل الفرع، خفض السعر دون العربون المقبوض سلفاً،
 * وعدم قبول تعديلٍ فارغ.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createWorkOrder } from "../workOrder/create";
import { updateWorkOrder } from "../workOrder/update";
import { openShift } from "../shiftService";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries", "receipts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "shifts", "customers",
  "productPrices", "productUnits", "productVariants", "products",
  "branches", "users",
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

const CASHIER_B1 = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER_B1 = { userId: 1, branchId: 1, role: "manager" };
// عزل الفرع (assertWorkOrderBranch) يُستثنى منه المرتفعون (admin/manager) عمداً — نفس القاعدة
// المُطبَّقة على كل مسارات workOrder الأخرى (cancel/setDeliveryMethod)، مرآة scopedBranchId=null
// للمدير في الراوتر. الفحص الحقيقي يسري على غير المرتفعين فقط ⇒ الاختبار يستعمل كاشير فرع٢.
const CASHIER_B2 = { userId: 3, branchId: 2, role: "cashier" };

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع", code: "BR2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr1", name: "مدير ١", email: "m1@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_c1", name: "كاشير ١", email: "c1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_c2", name: "كاشير ٢", email: "c2@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل أ", defaultPriceTier: "RETAIL", currentBalance: "0" },
    { id: 2, name: "عميل ب", defaultPriceTier: "RETAIL", currentBalance: "0" },
  ]);
}

async function newWorkOrder(overrides?: Partial<{ deposit: string; paymentMethod: "CASH" }>) {
  const res = await createWorkOrder(
    {
      branchId: 1,
      customerId: 1,
      title: "أمر اختبار",
      salePrice: "10000",
      quantity: 1,
      deposit: overrides?.deposit,
      paymentMethod: overrides?.paymentMethod,
    },
    CASHIER_B1,
  );
  return (res as { workOrderId: number }).workOrderId;
}

async function loadWo(id: number) {
  return (await db().select().from(s.workOrders).where(eq(s.workOrders.id, id)).limit(1))[0];
}

describe("updateWorkOrder — تصحيح تفاصيل طلب", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("يعدّل الحقول الوصفية على طلبٍ RECEIVED", async () => {
    const woId = await newWorkOrder();
    await updateWorkOrder(
      {
        workOrderId: woId,
        title: "عنوان مُعدَّل",
        customizationText: "ملاحظات جديدة",
        dueDate: "2026-09-01",
        priority: "URGENT",
        customerId: 2,
        contactName: "زبون هاتفي",
        contactPhone: "07701234567",
        receptionChannel: "WHATSAPP",
        channelHandle: "+9647701234567",
      },
      MANAGER_B1,
    );
    const wo = await loadWo(woId);
    expect(wo.title).toBe("عنوان مُعدَّل");
    expect(wo.customizationText).toBe("ملاحظات جديدة");
    expect(new Date(wo.dueDate as unknown as string).toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(wo.priority).toBe("URGENT");
    expect(Number(wo.customerId)).toBe(2);
    expect(wo.contactName).toBe("زبون هاتفي");
    expect(wo.contactPhone).toBe("07701234567");
    expect(wo.receptionChannel).toBe("WHATSAPP");
    expect(wo.channelHandle).toBe("+9647701234567");
  });

  it("يعدّل السعر على طلبٍ بلا عربون", async () => {
    const woId = await newWorkOrder();
    await updateWorkOrder({ workOrderId: woId, salePrice: "12500" }, MANAGER_B1);
    expect((await loadWo(woId)).salePrice).toBe("12500.00");
  });

  it("يسمح بالتعديل في أي حالة نشطة (RECEIVED/IN_PROGRESS/READY)", async () => {
    const woId = await newWorkOrder();
    for (const status of ["RECEIVED", "IN_PROGRESS", "READY"] as const) {
      await db().update(s.workOrders).set({ status }).where(eq(s.workOrders.id, woId));
      await updateWorkOrder({ workOrderId: woId, title: `عنوان ${status}` }, MANAGER_B1);
      expect((await loadWo(woId)).title).toBe(`عنوان ${status}`);
    }
  });

  it("يرفض التعديل بعد DELIVERED", async () => {
    const woId = await newWorkOrder();
    await db().update(s.workOrders).set({ status: "DELIVERED" }).where(eq(s.workOrders.id, woId));
    await expect(
      updateWorkOrder({ workOrderId: woId, title: "محاولة" }, MANAGER_B1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض التعديل بعد CANCELLED", async () => {
    const woId = await newWorkOrder();
    await db().update(s.workOrders).set({ status: "CANCELLED" }).where(eq(s.workOrders.id, woId));
    await expect(
      updateWorkOrder({ workOrderId: woId, title: "محاولة" }, MANAGER_B1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض تعديل أمر فرعٍ آخر لغير المرتفعين (عزل الفرع)", async () => {
    const woId = await newWorkOrder(); // فرع ١
    await expect(
      updateWorkOrder({ workOrderId: woId, title: "محاولة" }, CASHIER_B2),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يرفض خفض السعر دون العربون المقبوض سلفاً", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, CASHIER_B1);
    const woId = await newWorkOrder({ deposit: "8000", paymentMethod: "CASH" });
    expect((await loadWo(woId)).deposit).toBe("8000.00");
    await expect(
      updateWorkOrder({ workOrderId: woId, salePrice: "7000" }, MANAGER_B1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // السعر لم يتغيّر بعد الرفض.
    expect((await loadWo(woId)).salePrice).toBe("10000.00");
  });

  it("يسمح بسعرٍ يساوي العربون بالضبط (الحد الأدنى المقبول)", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, CASHIER_B1);
    const woId = await newWorkOrder({ deposit: "8000", paymentMethod: "CASH" });
    await updateWorkOrder({ workOrderId: woId, salePrice: "8000" }, MANAGER_B1);
    expect((await loadWo(woId)).salePrice).toBe("8000.00");
  });

  it("يرفض سعراً صفرياً أو سالباً", async () => {
    const woId = await newWorkOrder();
    await expect(
      updateWorkOrder({ workOrderId: woId, salePrice: "0" }, MANAGER_B1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض عنواناً فارغاً (مسافات فقط)", async () => {
    const woId = await newWorkOrder();
    await expect(
      updateWorkOrder({ workOrderId: woId, title: "   " }, MANAGER_B1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض تعديلاً بلا أي حقل", async () => {
    const woId = await newWorkOrder();
    await expect(
      updateWorkOrder({ workOrderId: woId }, MANAGER_B1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يُرجع before/patch لِما تغيَّر فقط", async () => {
    const woId = await newWorkOrder();
    const res = await updateWorkOrder({ workOrderId: woId, title: "جديد", priority: "LOW" }, MANAGER_B1);
    expect(res.patch).toMatchObject({ title: "جديد", priority: "LOW" });
    expect(res.before).toMatchObject({ title: "أمر اختبار", priority: "NORMAL" });
    expect(res.patch).not.toHaveProperty("salePrice");
  });
});
