import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { appNotifications, nativePushOutbox, users, webPushOutbox } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  buildAppWebPushPayload,
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
  await database.execute(sql`TRUNCATE TABLE webPushOutbox`);
  await database.execute(sql`TRUNCATE TABLE appNotificationPreferences`);
  await database.execute(sql`TRUNCATE TABLE appNotifications`);
  await database.execute(sql`TRUNCATE TABLE users`);
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await database
    .insert(users)
    .values({ id: 41, openId: "notice-user", name: "مستخدم", role: "cashier" });
});

describe("appNotificationService", () => {
  it("يعرض نص الحضور الموجّه كاملاً في Web Push فقط عند اعتماده لشاشة القفل", () => {
    const safe = buildAppWebPushPayload({
      userId: 41,
      kind: "ATTENDANCE",
      title: "أحمد علي سجّل الحضور",
      body: "08:05 • فرع الكرادة",
      route: "/hr?tab=attendance",
      eventKey: "attendance:supervisor:41:91:2026-08-08:ATTENDANCE_CHECK_IN",
      lockScreenSafe: true,
    });
    expect(safe).toMatchObject({
      title: "أحمد علي سجّل الحضور",
      body: "08:05 • فرع الكرادة",
      url: "/hr?tab=attendance",
    });

    const privatePayload = buildAppWebPushPayload({
      userId: 41,
      kind: "ATTENDANCE",
      title: "نص غير معتمد",
      body: "تفاصيل خاصة",
      route: "/hr?tab=attendance",
      eventKey: "attendance:41:2026-08-08:ATTENDANCE_CHECK_OUT",
    });
    expect(privatePayload).toMatchObject({
      title: "تحديث الحضور",
      body: "تم تحديث سجل الدوام.",
    });
  });

  it("يبني Web Push آمناً لإشعارات النظام والإعلانات بدل حصرها داخل الصندوق", () => {
    expect(buildAppWebPushPayload({
      userId: 41,
      kind: "SYSTEM",
      title: "تسوية مطلوبة",
      body: "تفاصيل داخلية لا تظهر على القفل",
      route: "/my-work",
      eventKey: "system:reconciliation:41:2026-09-01",
    })).toMatchObject({
      kind: "SYSTEM",
      title: "تحديث من النظام",
      body: "افتح النظام لعرض التفاصيل.",
      url: "/my-work",
    });

    expect(buildAppWebPushPayload({
      userId: 41,
      kind: "ANNOUNCEMENT",
      title: "إعلان إداري",
      body: "اجتماع داخلي",
      route: "/my-work#announcements",
      eventKey: "announcement:8:41",
    })).toMatchObject({
      kind: "ANNOUNCEMENT",
      title: "إعلان جديد",
      body: "افتح النظام لقراءة الإعلان.",
    });
  });

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
    const webRows = await db().select().from(webPushOutbox);
    expect(webRows).toHaveLength(1);
    expect(webRows[0]).toMatchObject({ userId: 41, eventKey: input.eventKey, status: "PENDING" });
  });

  it("يصنّف إشعار الإدارة ويحفظ النظام والجلسة للتسليم خارج التطبيق", async () => {
    await createAppNotification({
      userId: 41,
      kind: "ATTENDANCE",
      family: "ADMIN",
      title: "أحمد سجّل الحضور",
      body: "08:00 · فرع الكرادة",
      route: "/hr?tab=attendance",
      eventKey: "attendance:manager:41:1:ATTENDANCE_CHECK_IN",
      lockScreenSafe: true,
    });
    await createAppNotification({
      userId: 41,
      kind: "SESSION_EVENT",
      family: "ADMIN",
      title: "دخول: أحمد",
      body: "جهاز موثوق",
      route: "/mobile#session-events",
      eventKey: "session:login:1:41",
    });
    await createAppNotification({
      userId: 41,
      kind: "SYSTEM",
      title: "تسوية مطلوبة",
      body: "افتح التنبيهات",
      route: "/my-work",
      eventKey: "system:settlement:41:2026-09-01",
    });

    const notices = await db().select().from(appNotifications);
    expect(notices.map((row) => row.family)).toEqual(["ADMIN", "ADMIN", "SYSTEM"]);
    const nativeRows = await db().select().from(nativePushOutbox);
    expect(nativeRows).toHaveLength(3);
    expect(nativeRows[1].payload).toMatchObject({ destination: "alrueya://app/alerts" });
    expect(nativeRows[2].payload).toMatchObject({ kind: "SYSTEM", destination: "alrueya://app/alerts" });
    expect(await db().select().from(webPushOutbox)).toHaveLength(3);
  });

  it("يوجّه إشعار حملة الاستوديو إلى وجهة Android مسجّلة", async () => {
    await createAppNotification({
      userId: 41,
      kind: "TASK_ASSIGNED",
      title: "تغيّرت حالة حملة الاستوديو",
      body: "راجع حملة التصوير.",
      route: "/product-studio/campaigns/77",
      eventKey: "studio:campaign:77:status:ACTIVE:41",
      entityType: "productStudioCampaign",
      entityId: 77,
      push: true,
    });

    const [row] = await db().select().from(nativePushOutbox);
    expect(row.payload).toMatchObject({
      kind: "TASK_ASSIGNED",
      destination: "alrueya://app/modules",
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

  it("يحجب نص الحضور على شاشة القفل ما لم يأت من الباني الآمن صراحة", async () => {
    await createAppNotification({
      userId: 41,
      kind: "ATTENDANCE",
      title: "نص غير موثوق",
      body: "تفاصيل لا ينبغي عرضها",
      route: "/mobile#attendance",
      eventKey: "attendance:unsafe:ATTENDANCE_CHECK_IN",
      push: true,
    });
    const [row] = await db().select().from(nativePushOutbox);
    expect(row.payload).toMatchObject({
      kind: "ATTENDANCE",
      title: "تحديث آمن",
      body: "افتح سوبر العربية لعرض التفاصيل.",
      sensitive: "true",
    });
  });

  it("يحجب تفاصيل الإجازة على شاشة القفل (النوع والتواريخ لا تظهر)", async () => {
    await createAppNotification({
      userId: 41,
      kind: "LEAVE_STATUS",
      title: "تمت الموافقة على الإجازة",
      body: "مرضية · 2026-08-10 — 2026-08-12",
      route: "/mobile#leave",
      eventKey: "leave:555:approved",
      entityType: "leaveRequest",
      entityId: 555,
      push: true,
    });
    const [row] = await db().select().from(nativePushOutbox);
    expect(row.payload).toMatchObject({
      kind: "LEAVE_STATUS",
      title: "تحديث آمن",
      body: "افتح سوبر العربية لعرض التفاصيل.",
      sensitive: "true",
    });
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
