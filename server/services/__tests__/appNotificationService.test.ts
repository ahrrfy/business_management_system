import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { nativePushOutbox, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createAppNotification,
  getNotificationPreferences,
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  quietHoursReleaseAt,
  updateNotificationPreferences,
} from "../appNotificationService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  const database = db();
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await database.execute(sql`TRUNCATE TABLE nativePushOutbox`);
  await database.execute(sql`TRUNCATE TABLE appNotificationPreferences`);
  await database.execute(sql`TRUNCATE TABLE appNotifications`);
  await database.execute(sql`TRUNCATE TABLE users`);
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await database
    .insert(users)
    .values({ id: 41, openId: "notice-user", name: "مستخدم", role: "cashier" });
});

describe("appNotificationService", () => {
  it("يحفظ الحدث مرة واحدة ويحسب غير المقروء ثم يعلّمه مقروءاً", async () => {
    const input = {
      userId: 41,
      kind: "TASK_ASSIGNED" as const,
      title: "لديك مهمة جديدة",
      body: "مهمة داخلية",
      route: "/mobile#tasks",
      eventKey: "task:900:assigned:41",
      entityType: "task",
      entityId: 900,
      push: false,
    };
    expect(await createAppNotification(input)).toEqual({ created: true });
    expect(await createAppNotification(input)).toEqual({ created: false });

    let inbox = await listUserNotifications(41);
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.unreadCount).toBe(1);
    await markNotificationRead(41, inbox.rows[0].id);
    inbox = await listUserNotifications(41);
    expect(inbox.unreadCount).toBe(0);

    await createAppNotification({
      ...input,
      eventKey: "task:901:assigned:41",
      entityId: 901,
    });
    await markAllNotificationsRead(41);
    expect((await listUserNotifications(41)).unreadCount).toBe(0);
  });

  it("يعيد افتراضيات آمنة ثم يحفظ تفضيلات الفئات", async () => {
    expect((await getNotificationPreferences(41)).taskAssigned).toBe(true);
    const saved = await updateNotificationPreferences(41, {
      taskAssigned: false,
      payrollReady: true,
      attendance: true,
      leaveStatus: false,
      approvals: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
    });
    expect(saved).toMatchObject({
      taskAssigned: false,
      leaveStatus: false,
      quietHoursStart: "22:00",
    });
  });

  it("يحفظ إشعار Android في outbox داخل نفس حدث الصندوق وبلا تكرار", async () => {
    const input = {
      userId: 41,
      kind: "TASK_ASSIGNED" as const,
      title: "لديك مهمة جديدة",
      body: "راجع المهمة المسندة إليك.",
      route: "/mobile#tasks",
      eventKey: "task:902:assigned:41",
      entityType: "task",
      entityId: 902,
      requiresAction: true,
      push: true,
    };
    expect(await createAppNotification(input)).toEqual({ created: true });
    expect(await createAppNotification(input)).toEqual({ created: false });

    const rows = await db().select().from(nativePushOutbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: 41,
      eventKey: input.eventKey,
      environment: "dev",
      status: "PENDING",
    });
    expect(rows[0].payload).toMatchObject({
      kind: "TASK_ASSIGNED",
      destination: "alrueya://app/module/tasks/view/902",
      urgency: "action",
      sensitive: "false",
    });
  });

  it("يحترم تعطيل فئة الإشعار ولا ينشئ صف إرسال أصلي", async () => {
    await updateNotificationPreferences(41, {
      taskAssigned: false,
      payrollReady: true,
      attendance: true,
      leaveStatus: true,
      approvals: true,
    });
    await createAppNotification({
      userId: 41,
      kind: "TASK_ASSIGNED",
      title: "مهمة",
      body: "تحديث",
      route: "/mobile#tasks",
      eventKey: "task:903:assigned:41",
      push: true,
    });
    expect(await db().select().from(nativePushOutbox)).toHaveLength(0);
    expect((await listUserNotifications(41)).rows).toHaveLength(1);
  });

  it("يؤجل ساعات الهدوء العابرة لمنتصف الليل حتى نهايتها", () => {
    const now = new Date("2026-08-05T20:00:00.000Z"); // 23:00 بغداد
    expect(quietHoursReleaseAt("22:00", "07:00", now)?.toISOString()).toBe(
      "2026-08-06T04:00:00.000Z",
    );
    expect(
      quietHoursReleaseAt(
        "22:00",
        "07:00",
        new Date("2026-08-05T12:00:00.000Z"),
      ),
    ).toBeNull();
  });
});
