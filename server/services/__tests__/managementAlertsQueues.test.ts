/**
 * ش٦ — طوابيرُ المشرف الثلاثة: بلا منفّذ · بانتظار العميل · لم يحضر أصحابها (١٩/٨).
 *
 * **العطبُ:** مركز التنبيهات كان يقيس «تجاوزت أجل التسليم» وحدها — وهي **آخرُ** ما يظهر.
 * الأمرُ الذي لم يسحبه أحد، والمحجوزُ بموافقةٍ منسيّة، والجاهزُ منذ أسبوعٍ بلا مستلِم: ثلاثتُها
 * أعمى تماماً، ولا شاشةَ تسأل عنها ⇒ تُكتشَف يوم تصير شكوى.
 *
 * ويُختبَر معها مرشّحا القوائم المقابلان: `tasks.unassigned` و`workOrders.awaitingPickupDays`
 * — التنبيهُ يقول «كم»، والمرشّحُ يقول «أيّها»؛ وبلا الثاني يصير الأوّل رقماً بلا وجهةِ فعل.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { getManagementAlerts } from "../reportsAlertsService";
import { listTasks } from "../tasks/list";

const TABLES = [
  "taskEvents", "tasks", "serviceTypes",
  "workOrderMaterials", "workOrders",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users", "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const alertKeys = async () => {
  const res = await getManagementAlerts({ branchId: 1 });
  return new Map(res.alerts.map((a) => [a.key, a]));
};

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "m", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "t", name: "فنّي", email: "t@t.test", role: "print_operator", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null }]);
});

/** أمرُ شغلٍ خامّ — لا مرور بالخدمة كي تُضبَط الحالةُ والتوقيتُ بدقّة. */
async function wo(fields: Record<string, unknown>) {
  const res = await db().insert(s.workOrders).values({
    branchId: 1, customerId: 1, title: "طلب", quantity: 1,
    salePrice: "10000.00", deposit: "0.00", createdBy: 1, ...fields,
  } as never);
  return Number((res as unknown as { insertId: number }[])[0]?.insertId ?? 0);
}

describe("ش٦ — طوابير أوامر الشغل في تنبيهات الإدارة", () => {
  it("⭐ «بلا منفّذ»: يُعدّ المفتوحَ اليتيم وحده — لا الجاهزَ ولا المُسنَد", async () => {
    await wo({ orderNumber: "WO-A1", status: "RECEIVED", assignedTo: null });
    await wo({ orderNumber: "WO-A2", status: "IN_PROGRESS", assignedTo: null });
    await wo({ orderNumber: "WO-A3", status: "RECEIVED", assignedTo: 3 });   // مُسنَد
    await wo({ orderNumber: "WO-A4", status: "READY", assignedTo: null });   // جاهز — انتهى العمل
    await wo({ orderNumber: "WO-A5", status: "CANCELLED", assignedTo: null });

    const a = await alertKeys();
    expect(a.get("wo-unassigned")?.count).toBe(2);
    expect(a.get("wo-unassigned")?.severity).toBe("critical");
  });

  it("⭐ «بانتظار موافقة العميل»: مهمّةٌ حاجزةٌ مفتوحة فقط", async () => {
    const blocking = await wo({ orderNumber: "WO-B1", status: "RECEIVED", assignedTo: 3 });
    const nonBlocking = await wo({ orderNumber: "WO-B2", status: "RECEIVED", assignedTo: 3 });
    const resolved = await wo({ orderNumber: "WO-B3", status: "IN_PROGRESS", assignedTo: 3 });

    await db().insert(s.serviceTypes).values([
      { id: 1, name: "موافقة تصميم", blocksExecution: true, isActive: true },
      { id: 2, name: "متابعة عادية", blocksExecution: false, isActive: true },
    ] as never);
    await db().insert(s.tasks).values([
      { taskNumber: "TSK-1", branchId: 1, title: "وافق", serviceTypeId: 1, taskStatus: "WAITING_CUSTOMER", linkedWorkOrderId: blocking, createdBy: 1 },
      { taskNumber: "TSK-2", branchId: 1, title: "اتّصل", serviceTypeId: 2, taskStatus: "NEW", linkedWorkOrderId: nonBlocking, createdBy: 1 },
      { taskNumber: "TSK-3", branchId: 1, title: "وافق", serviceTypeId: 1, taskStatus: "RESOLVED", linkedWorkOrderId: resolved, createdBy: 1 },
    ] as never);

    const a = await alertKeys();
    // الحاجزةُ المفتوحة وحدها: غيرُ الحاجزة لا تمنع التنفيذ، والمنتهيةُ رُفع حجزُها.
    expect(a.get("wo-awaiting-approval")?.count).toBe(1);
  });

  it("⭐ «لم يحضر أصحابها»: جاهزيّةٌ مشتقّة أقدم من ٧ أيّام — لا عمودَ رابع", async () => {
    // جاهزٌ منذ ١٠ أيّام: بدأ قبل ١١ يوماً واستغرق يوماً.
    await db().execute(sql`
      INSERT INTO workOrders (branchId, customerId, orderNumber, title, quantity, salePrice, deposit,
                              workOrderStatus, createdBy, workStartedAt, workSeconds)
      VALUES (1, 1, 'WO-C1', 'قديم', 1, '10000.00', '0.00', 'READY', 1,
              DATE_SUB(UTC_TIMESTAMP(), INTERVAL 11 DAY), 86400)
    `);
    // جاهزٌ منذ يومين — دون العتبة.
    await db().execute(sql`
      INSERT INTO workOrders (branchId, customerId, orderNumber, title, quantity, salePrice, deposit,
                              workOrderStatus, createdBy, workStartedAt, workSeconds)
      VALUES (1, 1, 'WO-C2', 'حديث', 1, '10000.00', '0.00', 'READY', 1,
              DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY), 86400)
    `);
    // جاهزٌ بلا مؤقّت (بياناتٌ قديمة): عمرُه **مجهول** ⇒ يُستبعَد صراحةً بدل ادّعاءِ أحد الطرفين.
    await wo({ orderNumber: "WO-C3", status: "READY", workStartedAt: null, workSeconds: null });

    const a = await alertKeys();
    expect(a.get("wo-awaiting-pickup")?.count).toBe(1);
  });

  it("لا تنبيهَ حين لا طابور (لا صفرٌ يملأ الكوكبِت)", async () => {
    await wo({ orderNumber: "WO-D1", status: "IN_PROGRESS", assignedTo: 3 });
    const a = await alertKeys();
    expect(a.has("wo-unassigned")).toBe(false);
    expect(a.has("wo-awaiting-approval")).toBe(false);
    expect(a.has("wo-awaiting-pickup")).toBe(false);
  });

  it("⭐ مرشّح `unassigned` في المهام: المفتوحُ اليتيم وحده", async () => {
    await db().insert(s.serviceTypes).values([{ id: 1, name: "خدمة", isActive: true }] as never);
    await db().insert(s.tasks).values([
      { taskNumber: "TSK-U1", branchId: 1, title: "يتيمة", serviceTypeId: 1, taskStatus: "NEW", assignedTo: null, createdBy: 1 },
      { taskNumber: "TSK-U2", branchId: 1, title: "مُسنَدة", serviceTypeId: 1, taskStatus: "NEW", assignedTo: 3, createdBy: 1 },
      { taskNumber: "TSK-U3", branchId: 1, title: "منتهية يتيمة", serviceTypeId: 1, taskStatus: "RESOLVED", assignedTo: null, createdBy: 1 },
      { taskNumber: "TSK-U4", branchId: 1, title: "ملغاة يتيمة", serviceTypeId: 1, taskStatus: "CANCELLED", assignedTo: null, createdBy: 1 },
    ] as never);

    const res = await listTasks({ scopedBranchId: 1, scopedOwnerId: null }, { unassigned: true });
    expect(res.rows.map((r) => r.taskNumber)).toEqual(["TSK-U1"]);
  });

  it("عزلُ الفرع يبقى حاكماً فوق التنبيهات", async () => {
    await db().insert(s.branches).values([{ id: 2, name: "المبيعات", code: "SALES", type: "SALES" }]);
    await wo({ orderNumber: "WO-E1", status: "RECEIVED", assignedTo: null, branchId: 2 });
    const a = await alertKeys(); // نطاقُه الفرع ١
    expect(a.has("wo-unassigned")).toBe(false);
    const all = await getManagementAlerts({});
    expect(all.alerts.find((x) => x.key === "wo-unassigned")?.count).toBe(1);
  });
});
