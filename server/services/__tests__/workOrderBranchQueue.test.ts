/**
 * طابور الفرع (قرار المالك ١٩/٨) — الشاشات التشغيلية تعرض أوامر الفرع كلّها.
 *
 * موظّفةُ استقبالٍ لا ترى طلبات زميلتها كانت تعجز عن الردّ على زبونٍ يسأل عن طلبٍ استقبلته
 * الوردية السابقة. والعلمُ يُسقط **عزل الموظّف وحده**.
 *
 * الثوابت المحروسة — وأخطرُها الثاني:
 *  ① بلا العلم: الموظّف يرى ما أنشأه أو أُسنِد إليه فقط (السلوك القديم لم ينكسر).
 *  ② بالعلم: يرى أوامر زملائه **في فرعه** — و**لا يرى فرعاً آخر أبداً** (عزلُ الفرع حاكمٌ
 *     فوق العلم؛ لو أسقطه لصار العلمُ ثقبَ IDOR لا تيسيراً).
 *  ③ العلم يلزمه `workorders:FULL` — لا يكفي أن يطلبه العميل.
 *  ④ العدّادات تتبع نفس النطاق، وإلّا كذب الرقمُ فوق جدولٍ يعرض غيره.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { ROLE_TEMPLATES } from "@shared/permissions";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "shifts", "customers", "branches", "users", "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

/** قالب موظّف الاستقبال الحاكم — `workorders:FULL` (من shared/permissions). */
const RECEPTION_PERMS = { ...ROLE_TEMPLATES.cashier, sales: "READ", pos: "NONE" };
/** كاشير تجزئة بلا صلاحية أوامر شغل — لإثبات أنّ العلم لا يُفتح لمن لا يملكها. */
const RETAIL_PERMS = { ...ROLE_TEMPLATES.cashier, workorders: "READ" };

function ctxFor(id: number, perms: unknown, branchId = 1): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: {
      id, role: "cashier", branchId, name: `u${id}`, email: `u${id}@t.test`,
      isActive: true, permissionsOverride: perms,
    } as unknown as TrpcContext["user"],
  };
}
const caller = (id: number, perms: unknown, branchId = 1) =>
  appRouter.createCaller(ctxFor(id, perms, branchId));

async function workOrder(orderNumber: string, branchId: number, createdBy: number) {
  await db().insert(s.workOrders).values({
    orderNumber, branchId, customerId: 1, title: orderNumber,
    quantity: 1, salePrice: "1000.00", status: "RECEIVED", createdBy,
  } as never);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 10, openId: "sara", name: "سارة", email: "sara@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 11, openId: "hind", name: "هند", email: "hind@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 12, openId: "other", name: "موظف فرع آخر", email: "o@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00" }]);

  await workOrder("WO-SARA", 1, 10);   // أنشأتْه سارة
  await workOrder("WO-HIND", 1, 11);   // أنشأتْه زميلتُها في نفس الفرع
  await workOrder("WO-OTHER", 2, 12);  // فرعٌ آخر — لا يجوز أن يظهر أبداً
});

const numbers = (rows: unknown) =>
  (rows as { orderNumber: string }[]).map((r) => r.orderNumber).sort();

describe("طابور الفرع", () => {
  it("⭐ ① بلا العلم: سارة ترى ما أنشأته وحده", async () => {
    const rows = await caller(10, RECEPTION_PERMS).workOrders.list({} as never);
    expect(numbers(rows)).toEqual(["WO-SARA"]);
  });

  it("⭐ ② بالعلم: ترى طلب زميلتها — ولا ترى الفرع الآخر أبداً", async () => {
    const rows = await caller(10, RECEPTION_PERMS).workOrders.list({ branchQueue: true } as never);
    expect(numbers(rows)).toEqual(["WO-HIND", "WO-SARA"]);
    // عزلُ الفرع حاكمٌ فوق العلم — لو سقط لصار العلمُ ثقبَ IDOR.
    expect(numbers(rows)).not.toContain("WO-OTHER");
  });

  it("⭐ ② (مرآة): موظّف الفرع الآخر لا يرى الفرع الأوّل ولو طلب العلم", async () => {
    const rows = await caller(12, RECEPTION_PERMS, 2).workOrders.list({ branchQueue: true } as never);
    expect(numbers(rows)).toEqual(["WO-OTHER"]);
  });

  it("⭐ ③ العلم يلزمه workorders:FULL — لا يكفي طلبُ العميل", async () => {
    // كاشير تجزئة بـ`workorders:READ` يقرأ الوحدة لكنّه ليس مشغّل المحطّة.
    const rows = await caller(10, RETAIL_PERMS).workOrders.list({ branchQueue: true } as never);
    expect(numbers(rows)).toEqual(["WO-SARA"]);
  });

  it("⭐ ④ العدّادات تتبع نفس النطاق — لا رقمٌ فوق جدولٍ يعرض غيره", async () => {
    const own = await caller(10, RECEPTION_PERMS).workOrders.counts({} as never);
    const branch = await caller(10, RECEPTION_PERMS).workOrders.counts({ branchQueue: true } as never);
    expect(own.received).toBe(1);
    expect(branch.received).toBe(2);
    // والمرآة: عدّادُ الطابور = طول قائمته بالضبط.
    const rows = await caller(10, RECEPTION_PERMS).workOrders.list({ branchQueue: true } as never);
    expect(branch.received).toBe((rows as unknown[]).length);
  });

  it("المشرف يرى الفرع كلّه بالعلم وبدونه (نطاقُه أصلاً كذلك)", async () => {
    const mgrCtx = {
      req: { headers: {} } as unknown as TrpcContext["req"],
      res: {} as unknown as TrpcContext["res"],
      user: { id: 13, role: "manager", branchId: 1, name: "م", email: "m@t.test", isActive: true } as unknown as TrpcContext["user"],
    };
    const mgr = appRouter.createCaller(mgrCtx);
    expect(numbers(await mgr.workOrders.list({} as never))).toEqual(["WO-HIND", "WO-SARA"]);
    expect(numbers(await mgr.workOrders.list({ branchQueue: true } as never))).toEqual(["WO-HIND", "WO-SARA"]);
  });

  it("صفر تسريبٍ عبر العدّادات: مجموع الفرع لا يشمل صفوف فرعٍ آخر", async () => {
    const total = (await db().select({ n: sql<number>`COUNT(*)` }).from(s.workOrders))[0];
    expect(Number(total.n)).toBe(3); // الثلاثة موجودةٌ في القاعدة…
    const branch = await caller(10, RECEPTION_PERMS).workOrders.counts({ branchQueue: true } as never);
    const all = branch.received + branch.inProgress + branch.ready + branch.delivered + branch.cancelled;
    expect(all).toBe(2); // …ولا يُحصى منها إلا فرعُها
  });
});
