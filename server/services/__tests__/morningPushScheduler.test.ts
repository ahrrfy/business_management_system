/**
 * اختبار دورة «برنامج اليوم» الدائمة — تُنشئ appNotification ثم يتولى صندوقا Web/Native الدفع.
 * نتحقّق من: RBAC، العمل بلا اشتراك Web، تخطّي الأصفار، وعدم تكرار نفس اليوم.
 */
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockSendNotification = vi.fn();
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => mockSendNotification(...args),
  },
  setVapidDetails: vi.fn(),
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}));

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { subscribeUserToPush } from "../pushService";
import { notifyUpcomingPayrollDue, runMorningBriefPush } from "../morningPushScheduler";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeAll(() => {
  process.env.VAPID_PUBLIC_KEY = "test-fake-vapid-public";
  process.env.VAPID_PRIVATE_KEY = "test-fake-vapid-private";
});

const TABLES = [
  "payrollObligations",
  "nativePushOutbox",
  "webPushOutbox",
  "appNotifications",
  "appNotificationPreferences",
  "pushDailyClaim",
  "pushNotificationLog",
  "pushSubscriptions",
  "arReminders",
  "tasks",
  "workOrders",
  "receipts",
  "invoiceItems",
  "invoices",
  "customers",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "branches",
  "users",
];

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "u1", name: "مدير", role: "admin", loginMethod: "local", branchId: 1, isActive: true },
    { id: 2, openId: "u2", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1, isActive: true },
    { id: 3, openId: "u3", name: "مدير غير فعّال", role: "manager", loginMethod: "local", branchId: 1, isActive: false },
  ]);
  mockSendNotification.mockReset();
  mockSendNotification.mockResolvedValue({ statusCode: 201 });
});

/** يُنشئ WO متأخّرة ⇒ overdueWorkOrders > 0 ⇒ MorningBrief غير فارغ. */
async function seedOverdueWo(userId: number, orderNumber: string, branchId = 1) {
  const d = db();
  await d.insert(s.customers).values({
    id: userId * 10,
    name: `عميل-${userId}`,
    defaultPriceTier: "RETAIL",
    currentBalance: "0",
  });
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await d.insert(s.workOrders).values({
    orderNumber,
    branchId,
    customerId: userId * 10,
    status: "IN_PROGRESS",
    dueDate: yesterday,
    title: "طلبية",
    subtotal: "100",
    total: "100",
  });
}

const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/user-1",
  p256dh: "BNKeys256Public",
  auth: "authSecret16Chars",
  userAgent: null,
};

describe("runMorningBriefPush", () => {
  it("ينبّه الإدارة مرة واحدة عندما تستحق التزامات الرواتب غداً", async () => {
    await db().insert(s.payrollObligations).values({
      kind: "SALARY_NET",
      originalAmount: "1250000",
      remainingAmount: "1250000",
      dueDate: "2026-09-02",
      status: "OPEN",
      sourceType: "OPENING_CERTIFICATE",
      sourceKey: "payroll-due-alert-test",
    });
    const now = new Date("2026-09-01T05:00:00.000Z");

    expect(await notifyUpcomingPayrollDue(now)).toEqual({ created: 1, skippedAlreadySent: 0 });
    expect(await notifyUpcomingPayrollDue(now)).toEqual({ created: 0, skippedAlreadySent: 1 });
    const [notice] = await db().select().from(s.appNotifications);
    expect(notice).toMatchObject({
      userId: 1,
      kind: "SYSTEM",
      family: "ADMIN",
      title: "رواتب مستحقة غداً",
      route: "/payroll",
    });
    expect(notice.body).not.toContain("1250000");
  });

  it("يُرسل لمدير الأدمن حين المحتوى غير فارغ", async () => {
    await subscribeUserToPush(SUB, 1);
    await seedOverdueWo(1, "WO-A");

    const r = await runMorningBriefPush();
    expect(r.candidates).toBe(1);
    expect(r.sent).toBe(1);
    expect(r.skippedEmpty).toBe(0);
    const [notice] = await db().select().from(s.appNotifications);
    const [outbox] = await db().select().from(s.webPushOutbox);
    // نتحقّق من الجسم — يحوي «١ أمر شغل متأخّر» ولا يحوي اسم عميل. الرابط: أمر شغل متأخّر فقط (بلا
    // تذكيرات AR) ⇒ pickMorningBriefUrl يوجّه لمركز أوامر الشغل التشغيلي لا /dashboard الثابت
    // (gap-audit ٥/٧ بند ١٠ — الرابط صار ديناميكياً حسب المحتوى المستحقّ فعلياً).
    expect(notice).toMatchObject({ kind: "SYSTEM", family: "ADMIN", route: "/work-orders?branch=1" });
    expect(notice.body).toContain("أمر شغل متأخّر");
    expect(notice.body).not.toContain("عميل-1"); // لا تسريب أسماء عملاء في جسم الإشعار
    expect(outbox.payload).toMatchObject({ kind: "SYSTEM", url: "/work-orders?branch=1", body: notice.body });
  });

  it("يتخطّى الكاشير (RBAC — admin/manager فقط)", async () => {
    await subscribeUserToPush({ ...SUB, endpoint: SUB.endpoint + "-cashier" }, 2);
    await seedOverdueWo(2, "WO-B");
    const r = await runMorningBriefPush();
    expect(r.candidates).toBe(1); // الأدمن الفعّال مرشّح دائماً؛ الكاشير ليس مرشّحاً.
    expect(r.sent).toBe(1);
    const notices = await db().select().from(s.appNotifications);
    expect(notices.map((row) => row.userId)).toEqual([1]);
  });

  it("يتخطّى المدير غير الفعّال (isActive=false)", async () => {
    await subscribeUserToPush({ ...SUB, endpoint: SUB.endpoint + "-inactive" }, 3);
    await seedOverdueWo(3, "WO-C");
    const r = await runMorningBriefPush();
    expect(r.candidates).toBe(1); // الأدمن فقط؛ المدير المعطّل مستبعد.
    expect((await db().select().from(s.appNotifications)).map((row) => row.userId)).toEqual([1]);
  });

  it("يتخطّى المحتوى الفارغ (لا متابعات ⇒ لا إشعار)", async () => {
    await subscribeUserToPush(SUB, 1);
    // بلا seed لأي morningBrief data
    const r = await runMorningBriefPush();
    expect(r.candidates).toBe(1);
    expect(r.sent).toBe(0);
    expect(r.skippedEmpty).toBe(1);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("لا يرسل لمدير فرع ١ عدّادات تخص فرعاً آخر", async () => {
    const d = db();
    await d.insert(s.branches).values({ id: 2, name: "الثاني", code: "B2", type: "SALES" });
    await d.insert(s.users).values({
      id: 4,
      openId: "u4",
      name: "مدير فرع ١",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isActive: true,
    });
    await subscribeUserToPush({ ...SUB, endpoint: SUB.endpoint + "-manager-scope" }, 4);
    await seedOverdueWo(4, "WO-OTHER-BRANCH", 2);

    const r = await runMorningBriefPush();

    expect(r.candidates).toBe(2);
    expect(r.sent).toBe(0);
    expect(r.skippedEmpty).toBe(2);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("لا يحتسب العميل الموعود مرتين في إجمالي بنود الإشعار", async () => {
    const d = db();
    await subscribeUserToPush(SUB, 1);
    await d.insert(s.customers).values({
      id: 700,
      name: "عميل موعود",
      phone: "07901234567",
      defaultPriceTier: "RETAIL",
      currentBalance: "100",
    });
    const dueDate = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    await d.insert(s.invoices).values({
      invoiceNumber: "INV-PROMISE",
      sourceType: "ORDER",
      branchId: 1,
      customerId: 700,
      dueDate,
      subtotal: "100",
      total: "100",
      status: "PENDING",
      createdBy: 1,
    });
    const todayYmd = new Date().toISOString().slice(0, 10);
    await d.insert(s.arReminders).values({
      customerId: 700,
      branchId: 1,
      totalUnpaidSnapshot: "100",
      oldestInvoiceDate: dueDate,
      daysOverdue: 20,
      messageBody: "",
      status: "SKIPPED",
      skipReason: "وعد اليوم",
      promisedDate: todayYmd,
      createdBy: 1,
    });

    const r = await runMorningBriefPush();

    expect(r.sent).toBe(1);
    const [notice] = await db().select().from(s.appNotifications);
    expect(notice.body).toMatch(/^1 بند للمتابعة/);
    expect(notice.body).toContain("1 تذكير (منها 1 موعود اليوم)");
  });

  it("لا يحتسب المهمة المتأخرة المسندة للمستخدم مرتين في الإجمالي", async () => {
    const d = db();
    await subscribeUserToPush(SUB, 1);
    await d.insert(s.tasks).values({
      taskNumber: "TASK-OVERDUE-MINE",
      branchId: 1,
      taskKind: "FOLLOW_UP",
      taskStatus: "IN_PROGRESS",
      priority: "HIGH",
      title: "متابعة متأخرة",
      assignedTo: 1,
      createdBy: 1,
      dueAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const r = await runMorningBriefPush();

    expect(r.sent).toBe(1);
    const [notice] = await db().select().from(s.appNotifications);
    expect(notice.body).toMatch(/^1 بند للمتابعة/);
    expect(notice.body).toContain("1 مهمة مفتوحة (منها 1 متأخرة)");
  });

  it("idempotency: إعادة التشغيل نفس اليوم لا يُرسل ثانيةً", async () => {
    await subscribeUserToPush(SUB, 1);
    await seedOverdueWo(1, "WO-D");

    const r1 = await runMorningBriefPush();
    expect(r1.sent).toBe(1);

    const r2 = await runMorningBriefPush();
    expect(r2.sent).toBe(0);
    expect(r2.skippedAlreadySent).toBe(1);
    expect(await db().select().from(s.appNotifications)).toHaveLength(1);
  });

  it("المستخدم الإداري بلا اشتراك نشط يبقى مرشحاً ويستلم الصندوق الداخلي", async () => {
    // مدير بحساب فعّال بلا اشتراك.
    await seedOverdueWo(1, "WO-E");
    const r = await runMorningBriefPush();
    expect(r.candidates).toBe(1);
    expect(r.sent).toBe(1);
  });

  it("ينشئ تنبيه إدارة دائم للأدمن بلا اشتراك Web Push كي يظهر داخل النظام وعلى التطبيق الأصلي", async () => {
    await seedOverdueWo(1, "WO-NATIVE-ONLY");

    const r = await runMorningBriefPush();

    expect(r.candidates).toBe(1);
    expect(r.sent).toBe(1);
    const notices = await db().select().from(s.appNotifications);
    expect(notices).toEqual([expect.objectContaining({
      userId: 1,
      kind: "SYSTEM",
      family: "ADMIN",
      title: "برنامج اليوم — الرؤية العربية",
    })]);
    expect(await db().select().from(s.nativePushOutbox)).toHaveLength(1);
    expect(await db().select().from(s.webPushOutbox)).toHaveLength(1);
  });

  it("لا يخلط إشعار فرع الأدمن مديني الرصيد الافتتاحي غير المنتمين إلى قائمة ذلك الفرع", async () => {
    await subscribeUserToPush(SUB, 1); // مستخدم ١ = admin (seedBeforeEach)
    const d = db();
    await d.insert(s.customers).values({
      id: 500,
      name: "مدين افتتاحي",
      defaultPriceTier: "RETAIL",
      currentBalance: "500000",
    });
    const openedOn = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await d.insert(s.accountingEntries).values({
      entryType: "OPENING",
      customerId: 500,
      amount: "500000",
      entryDate: openedOn,
      dedupeKey: "OPENING:CUSTOMER:500",
    });

    const r = await runMorningBriefPush();
    expect(r.sent).toBe(0);
    expect(r.skippedEmpty).toBe(1);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  // نفس السيناريو لكن للمدير (لا أدمن) — يجب أن يبقى غائباً (لا انتماء فرعيّ لهؤلاء المدينين، ولا
  // مسار للمدير للتصرّف بهم — openingScope/openingWriteBranch أدمن حصراً).
  it("جسم إشعار المدير (لا أدمن) لا يتضمّن مدين الرصيد الافتتاحي — الحصر بالأدمن يعمل عبر السلسلة كاملة", async () => {
    const d = db();
    // مدير فعّال بديل (id=1 admin موجود مسبقاً؛ نضيف مديراً فعّالاً بدل تعديل seedBase).
    await d.insert(s.users).values({ id: 4, openId: "u4", name: "مدير فعّال", role: "manager", loginMethod: "local", branchId: 1, isActive: true });
    await subscribeUserToPush({ ...SUB, endpoint: SUB.endpoint + "-manager" }, 4);
    await d.insert(s.customers).values({
      id: 501,
      name: "مدين افتتاحي٢",
      defaultPriceTier: "RETAIL",
      currentBalance: "300000",
    });
    const openedOn = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await d.insert(s.accountingEntries).values({
      entryType: "OPENING",
      customerId: 501,
      amount: "300000",
      entryDate: openedOn,
      dedupeKey: "OPENING:CUSTOMER:501",
    });

    const r = await runMorningBriefPush();
    expect(r.candidates).toBe(2); // الأدمن والمدير كلاهما مرشحان ولو بلا اشتراك Web.
    expect(r.sent).toBe(0);
    expect(r.skippedEmpty).toBe(2); // arRemindersDue=0 لكليهما ⇒ محتوى فارغ ⇒ لا إشعار
  });
});
