/**
 * اختبار دورة إرسال «برنامج اليوم» — إعداد مستخدمين + اشتراكات + بيانات morningBrief ثم تشغيل runMorningBriefPush
 * ومحاكاة web-push. نتحقّق من: RBAC (admin/manager فقط)، تخطّي الأصفار، idempotency (لا إعادة نفس اليوم).
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
import { runMorningBriefPush } from "../morningPushScheduler";

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
  "pushDailyClaim",
  "pushNotificationLog",
  "pushSubscriptions",
  "arReminders",
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
async function seedOverdueWo(userId: number, orderNumber: string) {
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
    branchId: 1,
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
  it("يُرسل لمدير الأدمن حين المحتوى غير فارغ", async () => {
    await subscribeUserToPush(SUB, 1);
    await seedOverdueWo(1, "WO-A");

    const r = await runMorningBriefPush();
    expect(r.candidates).toBe(1);
    expect(r.sent).toBe(1);
    expect(r.skippedEmpty).toBe(0);
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    // نتحقّق من الجسم — يحوي «١ أمر شغل متأخّر» ولا يحوي اسم عميل. الرابط: أمر شغل متأخّر فقط (بلا
    // تذكيرات AR) ⇒ pickMorningBriefUrl يوجّه لمركز أوامر الشغل التشغيلي لا /dashboard الثابت
    // (gap-audit ٥/٧ بند ١٠ — الرابط صار ديناميكياً حسب المحتوى المستحقّ فعلياً).
    const [, payload] = mockSendNotification.mock.calls[0];
    const parsed = JSON.parse(payload as string);
    expect(parsed.kind).toBe("MORNING_BRIEF");
    expect(parsed.url).toBe("/work-orders");
    expect(parsed.body).toContain("أمر شغل متأخّر");
    expect(parsed.body).not.toContain("عميل-1"); // لا تسريب أسماء عملاء في جسم الإشعار
  });

  it("يتخطّى الكاشير (RBAC — admin/manager فقط)", async () => {
    await subscribeUserToPush({ ...SUB, endpoint: SUB.endpoint + "-cashier" }, 2);
    await seedOverdueWo(2, "WO-B");
    const r = await runMorningBriefPush();
    expect(r.candidates).toBe(0);
    expect(r.sent).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("يتخطّى المدير غير الفعّال (isActive=false)", async () => {
    await subscribeUserToPush({ ...SUB, endpoint: SUB.endpoint + "-inactive" }, 3);
    await seedOverdueWo(3, "WO-C");
    const r = await runMorningBriefPush();
    expect(r.candidates).toBe(0);
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

  it("idempotency: إعادة التشغيل نفس اليوم لا يُرسل ثانيةً", async () => {
    await subscribeUserToPush(SUB, 1);
    await seedOverdueWo(1, "WO-D");

    const r1 = await runMorningBriefPush();
    expect(r1.sent).toBe(1);

    const r2 = await runMorningBriefPush();
    expect(r2.sent).toBe(0);
    expect(r2.skippedAlreadySent).toBe(1);
    expect(mockSendNotification).toHaveBeenCalledTimes(1); // مرّة واحدة إجماليّاً
  });

  it("مستخدم بلا اشتراك نشط لا يظهر كـcandidate", async () => {
    // مدير بحساب فعّال بلا اشتراك.
    await seedOverdueWo(1, "WO-E");
    const r = await runMorningBriefPush();
    expect(r.candidates).toBe(0);
    expect(r.sent).toBe(0);
  });

  // إصلاح gap-audit HIGH (٥/٧): مدينو الرصيد الافتتاحي كانوا غائبين كلياً عن هذا الإشعار — أهمّ
  // قناة متابعة يومية صُمِّمت خصيصاً لهم. تحقّق طرف-لطرف: العدّاد يصل فعلياً لجسم إشعار الأدمن.
  it("جسم إشعار الأدمن يتضمّن مدين الرصيد الافتتاحي (بلا فاتورة) — لا يعود غائباً بعد الإصلاح", async () => {
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
    expect(r.sent).toBe(1);
    const [, payload] = mockSendNotification.mock.calls[0];
    const parsed = JSON.parse(payload as string);
    expect(parsed.counts.arRemindersDue).toBe(1);
    expect(parsed.body).toContain("تذكير");
    // تذكيرات AR/وعد اليوم أعلى أولوية من أوامر الشغل المتأخّرة (gap-audit ٥/٧ بند ١٠) ⇒ الرابط
    // يوجّه مباشرةً لشاشة تذكيرات الذمم لا /dashboard.
    expect(parsed.url).toBe("/reports/ar-reminders");
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
    expect(r.candidates).toBe(1); // المدير فقط (الأدمن id=1 بلا اشتراك في هذا الاختبار)
    expect(r.sent).toBe(0);
    expect(r.skippedEmpty).toBe(1); // arRemindersDue=0 للمدير ⇒ محتوى فارغ ⇒ لا إشعار
  });
});
