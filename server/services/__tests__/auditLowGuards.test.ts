/**
 * تدقيق ٢٥/٧ — حارسان منخفضا الأثر:
 *  (L) workOrder.assign: منع إسناد أمرٍ لموظفٍ من فرعٍ آخر لا يستطيع تنفيذه (الموظف المشترك بلا فرع مسموح).
 *  (L) cardAccount.createReconciliation: أثرٌ تدقيقيّ (auditLog) لسجلّ المطابقة الماليّ — كان يُنشأ بلا تدوين.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const TABLES = ["auditLogs", "cardReconciliations", "receipts", "workOrders", "users", "branches"];
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "adm", name: "admin", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "e1", name: "منفّذ ف١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "e2", name: "منفّذ ف٢", role: "cashier", loginMethod: "local", branchId: 2 },
    { id: 4, openId: "sh", name: "منفّذ مشترك", role: "cashier", loginMethod: "local", branchId: null },
  ]);
}
function caller(role: string, branchId: number, id: number) {
  const ctx = { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user: { id, role, branchId } } as any;
  return appRouter.createCaller(ctx);
}

beforeEach(async () => { await reset(); await seed(); });

describe("L — workOrder.assign: عزل فرع المُسنَد إليه", () => {
  beforeEach(async () => {
    await db().insert(s.workOrders).values({ id: 1, orderNumber: "WO-1", branchId: 1, title: "طلب طباعة" });
  });

  it("إسناد أمر فرعٍ ١ لموظف فرعٍ ٢ ⇒ BAD_REQUEST (لا ينفّذه)", async () => {
    await expect(
      caller("admin", 1, 1).workOrders.assign({ workOrderId: 1, assignedTo: 3 }),
    ).rejects.toThrow(/فرعٍ آخر/);
    const wo = (await db().select().from(s.workOrders))[0];
    expect(wo.assignedTo).toBeNull(); // لم يُسنَد
  });

  it("إسناد لموظف نفس الفرع ⇒ يُقبل", async () => {
    await caller("admin", 1, 1).workOrders.assign({ workOrderId: 1, assignedTo: 2 });
    const wo = (await db().select().from(s.workOrders))[0];
    expect(wo.assignedTo).toBe(2);
  });

  it("إسناد لموظفٍ مشترك (بلا فرع) ⇒ يُقبل", async () => {
    await caller("admin", 1, 1).workOrders.assign({ workOrderId: 1, assignedTo: 4 });
    const wo = (await db().select().from(s.workOrders))[0];
    expect(wo.assignedTo).toBe(4);
  });
});

describe("L — cardAccount.createReconciliation: أثرٌ تدقيقيّ", () => {
  it("إنشاء مطابقة ⇒ صفٌّ في auditLogs بالفعل cardAccount.reconcile", async () => {
    await caller("manager", 1, 1).cardAccount.createReconciliation({ asOfDate: "2026-07-25", statementBalance: "0" });
    expect(await db().select().from(s.cardReconciliations)).toHaveLength(1);
    const logs = await db().select().from(s.auditLogs);
    const rec = logs.find((l) => l.action === "cardAccount.reconcile");
    expect(rec).toBeTruthy();
    expect(Number(rec!.entityId)).toBeGreaterThan(0);
  });
});
