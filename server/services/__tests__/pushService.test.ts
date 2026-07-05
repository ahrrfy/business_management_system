/**
 * اختبارات pushService — اشتراك (UPSERT) + idempotency + إرسال بمحاكاة web-push.
 * نمحاكي web-push بدل نداء fcm.googleapis.com الحقيقي.
 */
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// محاكاة web-push — يجب أن تكون قبل استيراد pushService (vi.mock مرفوعة تلقائياً).
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
import {
  isPushEnabled,
  sendPushToUser,
  subscribeUserToPush,
  unsubscribeByEndpoint,
  wasPushSentToday,
  type MorningBriefPayload,
} from "../pushService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeAll(() => {
  // VAPID keys لتشغيل ensureVapidConfigured — قيم صالحة كافية للتوقيع البصري (لن يُنادى web-push فعلاً).
  // web-push مُحاكاة كليّاً ⇒ لا حاجة لمفاتيح صالحة الصياغة. سلاسل رمزيّة تكفي وتُرضي حارس أسرار CI.
  process.env.VAPID_PUBLIC_KEY = "test-fake-vapid-public";
  process.env.VAPID_PRIVATE_KEY = "test-fake-vapid-private";
});

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await d.execute(sql`TRUNCATE TABLE pushDailyClaim`);
  await d.execute(sql`TRUNCATE TABLE pushNotificationLog`);
  await d.execute(sql`TRUNCATE TABLE pushSubscriptions`);
  await d.execute(sql`TRUNCATE TABLE users`);
  await d.execute(sql`TRUNCATE TABLE branches`);
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "u1", name: "مدير", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "u2", name: "مدير-٢", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  mockSendNotification.mockReset();
});

const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-1",
  p256dh: "BNKeys256Public",
  auth: "authSecret16Chars",
  userAgent: "Mozilla/5.0 (Windows) Chrome/121",
};

describe("isPushEnabled + VAPID", () => {
  it("مُفعَّل حين VAPID مضبوطة", () => {
    expect(isPushEnabled()).toBe(true);
  });
});

describe("subscribeUserToPush - UPSERT على endpoint", () => {
  it("اشتراك جديد يُدخِل صفّاً واحداً بالبيانات الصحيحة", async () => {
    const r = await subscribeUserToPush(SUB, 1);
    expect(r.id).toBeGreaterThan(0);
    const rows = await db().select().from(s.pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(1);
    expect(rows[0].endpoint).toBe(SUB.endpoint);
    expect(rows[0].revokedAt).toBeNull();
  });

  it("إعادة اشتراك بنفس endpoint من مستخدم مختلف ⇒ CONFLICT (حظر خطف الاشتراك، مراجعة أمنية ٥/٧)", async () => {
    await subscribeUserToPush(SUB, 1);
    await expect(subscribeUserToPush(SUB, 2)).rejects.toThrow(/CONFLICT|حساب آخر/);
    // الصفّ الأصلي لم يتغيّر
    const rows = await db().select().from(s.pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(1);
  });

  it("إعادة اشتراك بنفس endpoint من نفس المستخدم ⇒ يُحدَّث المفاتيح ويُعيد التفعيل", async () => {
    await subscribeUserToPush(SUB, 1);
    await unsubscribeByEndpoint(SUB.endpoint);
    await subscribeUserToPush({ ...SUB, p256dh: "NEW-KEY" }, 1);
    const rows = await db().select().from(s.pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(1);
    expect(rows[0].p256dh).toBe("NEW-KEY");
    expect(rows[0].revokedAt).toBeNull();
  });

  it("اشتراك مُبطَل يُعاد تفعيله عند إعادة الاشتراك (revokedAt يعود null)", async () => {
    await subscribeUserToPush(SUB, 1);
    await unsubscribeByEndpoint(SUB.endpoint);
    let rows = await db().select().from(s.pushSubscriptions);
    expect(rows[0].revokedAt).not.toBeNull();
    await subscribeUserToPush(SUB, 1);
    rows = await db().select().from(s.pushSubscriptions);
    expect(rows[0].revokedAt).toBeNull();
  });

  it("بيانات ناقصة (endpoint فارغ) ⇒ يرفض", async () => {
    await expect(
      subscribeUserToPush({ ...SUB, endpoint: "" }, 1),
    ).rejects.toThrow(/بيانات الاشتراك ناقصة/);
  });
});

describe("wasPushSentToday - idempotency", () => {
  it("لا سجلّ ⇒ false", async () => {
    expect(await wasPushSentToday(1, "MORNING_BRIEF")).toBe(false);
  });

  it("سجلّ اليوم بحالة SENT ⇒ true", async () => {
    await db().insert(s.pushNotificationLog).values({
      userId: 1,
      kind: "MORNING_BRIEF",
      payload: "{}",
      status: "SENT",
      statusCode: 201,
    });
    expect(await wasPushSentToday(1, "MORNING_BRIEF")).toBe(true);
  });

  it("سجلّ اليوم بحالة FAILED_OTHER ⇒ true (لا نعيد المحاولة نفس اليوم)", async () => {
    await db().insert(s.pushNotificationLog).values({
      userId: 1,
      kind: "MORNING_BRIEF",
      payload: "{}",
      status: "FAILED_OTHER",
      statusCode: 500,
      errorMessage: "server down",
    });
    expect(await wasPushSentToday(1, "MORNING_BRIEF")).toBe(true);
  });

  it("سجلّ أمس ⇒ false (اليوم مسموح مجدداً)", async () => {
    await db().execute(sql`
      INSERT INTO pushNotificationLog (userId, pushKind, payload, pushLogStatus, statusCode, sentAt)
      VALUES (1, 'MORNING_BRIEF', '{}', 'SENT', 201, DATE_SUB(NOW(), INTERVAL 1 DAY))
    `);
    expect(await wasPushSentToday(1, "MORNING_BRIEF")).toBe(false);
  });

  it("سجلّ لمستخدم آخر ⇒ لا يمنع مستخدمي", async () => {
    await db().insert(s.pushNotificationLog).values({
      userId: 2, kind: "MORNING_BRIEF", payload: "{}", status: "SENT", statusCode: 201,
    });
    expect(await wasPushSentToday(1, "MORNING_BRIEF")).toBe(false);
  });
});

describe("sendPushToUser", () => {
  const payload: MorningBriefPayload = {
    kind: "MORNING_BRIEF",
    title: "برنامج اليوم",
    body: "٣ بند للمتابعة",
    url: "/dashboard",
    counts: { arRemindersDue: 2, promisedToday: 1, overdueWorkOrders: 0 },
  };

  it("ينجح ويُسجّل SENT لكل اشتراك نشط", async () => {
    await subscribeUserToPush(SUB, 1);
    await subscribeUserToPush({ ...SUB, endpoint: SUB.endpoint + "-2" }, 1);
    mockSendNotification.mockResolvedValue({ statusCode: 201 });

    const r = await sendPushToUser(1, payload);
    expect(r.sent).toBe(2);
    expect(r.goneRevoked).toBe(0);
    expect(r.failed).toBe(0);
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    const logs = await db().select().from(s.pushNotificationLog);
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.status === "SENT")).toBe(true);
  });

  it("410 Gone ⇒ يشطب الاشتراك ويُسجّل FAILED_GONE", async () => {
    await subscribeUserToPush(SUB, 1);
    mockSendNotification.mockRejectedValue({ statusCode: 410, body: "gone" });

    const r = await sendPushToUser(1, payload);
    expect(r.sent).toBe(0);
    expect(r.goneRevoked).toBe(1);
    const rows = await db().select().from(s.pushSubscriptions);
    expect(rows[0].revokedAt).not.toBeNull();
    const logs = await db().select().from(s.pushNotificationLog);
    expect(logs[0].status).toBe("FAILED_GONE");
    expect(logs[0].statusCode).toBe(410);
  });

  it("500 خطأ خادم ⇒ يُبقي الاشتراك ويُسجّل FAILED_OTHER (نعيد الغد)", async () => {
    await subscribeUserToPush(SUB, 1);
    mockSendNotification.mockRejectedValue({ statusCode: 500, body: "server error" });

    const r = await sendPushToUser(1, payload);
    expect(r.failed).toBe(1);
    expect(r.goneRevoked).toBe(0);
    const rows = await db().select().from(s.pushSubscriptions);
    expect(rows[0].revokedAt).toBeNull(); // لم يُشطب
    const logs = await db().select().from(s.pushNotificationLog);
    expect(logs[0].status).toBe("FAILED_OTHER");
    expect(logs[0].statusCode).toBe(500);
  });

  it("لا اشتراكات نشطة ⇒ لا نداءات web-push ولا logs", async () => {
    await subscribeUserToPush(SUB, 1);
    await unsubscribeByEndpoint(SUB.endpoint);

    const r = await sendPushToUser(1, payload);
    expect(r.sent).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
    const logs = await db().select().from(s.pushNotificationLog);
    expect(logs).toHaveLength(0);
  });
});
