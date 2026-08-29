import crypto from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  appNotificationPreferences,
  appNotifications,
  nativePushOutbox,
} from "../../drizzle/schema";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  isPushEnabled,
  sendPushToUser,
  type AppPushPayload,
} from "./pushService";
import {
  NATIVE_PUSH_ENVIRONMENTS,
  normalizeNativePushPayload,
  type NativePushEnvironment,
  type NormalizedNativePushPayload,
} from "./nativePushService";
import { requireDb } from "./tx";

export type AppNotificationKind =
  | "TASK_ASSIGNED"
  | "PAYROLL_READY"
  | "ATTENDANCE"
  | "LEAVE_STATUS"
  | "APPROVAL_REQUIRED"
  | "ANNOUNCEMENT"
  // ن-٢-د (٢٥/٨) — إشعارُ إدارةٍ لدخول/خروج/إبطالِ جلسةٍ لموظّف. مُنفصلٌ عن SYSTEM حتى
  // يحصل على push فعليّ عبر pushKindFor + nativeDestinationFor (كان SYSTEM لا يُنتج إلا
  // إدراجاً في الصندوق، فيبقى المدير جاهلاً حتى يفتحه يدويّاً — Codex P1).
  | "SESSION_EVENT"
  | "SYSTEM";

export interface NotificationPreferencesInput {
  taskAssigned: boolean;
  payrollReady: boolean;
  attendance: boolean;
  leaveStatus: boolean;
  approvals: boolean;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

export interface CreateAppNotificationInput {
  userId: number;
  kind: AppNotificationKind;
  title: string;
  body: string;
  route: string;
  eventKey: string;
  entityType?: string | null;
  entityId?: number | null;
  requiresAction?: boolean;
  /**
   * true فقط عندما يكون العنوان والنص مُنشأين من باني حمولة آمنة لشاشة القفل ولا
   * يحتويان بيانات مالية أو شخصية. الافتراضي false ويؤدي إلى الحجب.
   */
  lockScreenSafe?: boolean;
  /** false للأحداث التأكيدية التي يكفي ظهورها داخل التطبيق. */
  push?: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferencesInput = {
  taskAssigned: true,
  payrollReady: true,
  attendance: true,
  leaveStatus: true,
  approvals: true,
  quietHoursStart: null,
  quietHoursEnd: null,
};

function preferencesFromRow(
  row?: typeof appNotificationPreferences.$inferSelect,
): NotificationPreferencesInput {
  return row
    ? {
        taskAssigned: row.taskAssigned,
        payrollReady: row.payrollReady,
        attendance: row.attendance,
        leaveStatus: row.leaveStatus,
        approvals: row.approvals,
        quietHoursStart: row.quietHoursStart,
        quietHoursEnd: row.quietHoursEnd,
      }
    : { ...DEFAULT_PREFERENCES };
}

function safeInternalRoute(route: string): string {
  // لا تُخفِ الوجهة الفاسدة خلف شاشة حقيقية؛ مسار غير معرّف يجعل خلل الربط قابلاً للاكتشاف.
  return route.startsWith("/") && !route.startsWith("//")
    ? route.slice(0, 255)
    : "/__invalid_notification_route__";
}

function pushKindFor(
  kind: AppNotificationKind,
):
  | "TASK_ASSIGNED"
  | "PAYROLL_READY"
  | "LEAVE_STATUS"
  | "APPROVAL_REQUIRED"
  | "SESSION_EVENT"
  | null {
  if (kind === "TASK_ASSIGNED") return "TASK_ASSIGNED";
  if (kind === "PAYROLL_READY") return "PAYROLL_READY";
  if (kind === "LEAVE_STATUS") return "LEAVE_STATUS";
  if (kind === "APPROVAL_REQUIRED") return "APPROVAL_REQUIRED";
  if (kind === "SESSION_EVENT") return "SESSION_EVENT";
  return null;
}

function webPushPayloadFor(
  input: CreateAppNotificationInput,
  route: string,
): AppPushPayload | null {
  if (input.kind === "ATTENDANCE") {
    const kind = input.eventKey.endsWith("ATTENDANCE_CHECK_OUT")
      ? "ATTENDANCE_CHECK_OUT"
      : input.eventKey.endsWith("ATTENDANCE_CHECK_IN")
        ? "ATTENDANCE_CHECK_IN"
        : null;
    return kind
      ? {
          kind,
          title: input.title.trim().slice(0, 90),
          body: "تم تحديث سجل دوامك.",
          url: "/hr?tab=attendance",
        }
      : null;
  }
  const kind = pushKindFor(input.kind);
  if (!kind) return null;
  const body =
    input.kind === "PAYROLL_READY"
      ? "تم تحديث كشفك الشخصي."
      : input.kind === "SESSION_EVENT"
        ? // نصٌّ عامّ آمن — التفاصيل تظهر في التطبيق فقط (الجسم النصّيّ الفعليّ يحمل IP
          // مقنَّعاً واسم جهاز، وقد تُعرض على شاشة القفل عبر Web Push فوجب تعميمه هنا).
          "دخول/خروجٌ لموظّف — افتح الصندوق للتفاصيل."
        : "لديك تحديث جديد في مساحة العمل.";
  return { kind, title: input.title.trim().slice(0, 90), body, url: route };
}

function preferenceAllows(
  kind: AppNotificationKind,
  p: NotificationPreferencesInput,
): boolean {
  if (kind === "TASK_ASSIGNED") return p.taskAssigned;
  if (kind === "PAYROLL_READY") return p.payrollReady;
  if (kind === "ATTENDANCE") return p.attendance;
  if (kind === "LEAVE_STATUS") return p.leaveStatus;
  if (kind === "APPROVAL_REQUIRED") return p.approvals;
  return true;
}

function parseClockMinutes(value?: string | null): number | null {
  if (!value || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function baghdadClockMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Baghdad",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour =
    Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value ?? 0,
  );
  return hour * 60 + minute;
}

/** وقت الإفراج عن إشعار خلال ساعات الهدوء في بغداد؛ null يعني الإرسال الآن. */
export function quietHoursReleaseAt(
  start?: string | null,
  end?: string | null,
  now = new Date(),
): Date | null {
  const startMinutes = parseClockMinutes(start);
  const endMinutes = parseClockMinutes(end);
  if (startMinutes == null || endMinutes == null || startMinutes === endMinutes)
    return null;
  const current = baghdadClockMinutes(now);
  const quiet =
    startMinutes < endMinutes
      ? current >= startMinutes && current < endMinutes
      : current >= startMinutes || current < endMinutes;
  if (!quiet) return null;
  const waitMinutes = (endMinutes - current + 24 * 60) % (24 * 60);
  return new Date(now.getTime() + Math.max(waitMinutes, 1) * 60_000);
}

function nativeEnvironment(): NativePushEnvironment {
  const value = process.env.NATIVE_PUSH_ENVIRONMENT?.trim();
  if (
    value &&
    NATIVE_PUSH_ENVIRONMENTS.includes(value as NativePushEnvironment)
  ) {
    return value as NativePushEnvironment;
  }
  return process.env.NODE_ENV === "production" ? "prod" : "dev";
}

function nativeDestinationFor(
  input: CreateAppNotificationInput,
): string | null {
  const entity = input.entityId != null ? String(input.entityId) : null;
  if (input.kind === "TASK_ASSIGNED") {
    return entity
      ? `alrueya://app/module/tasks/view/${entity}`
      : "alrueya://app/tasks";
  }
  if (input.kind === "APPROVAL_REQUIRED") return "alrueya://app/approvals";
  if (input.kind === "ATTENDANCE") return "alrueya://app/module/hr/browse";
  if (input.kind === "PAYROLL_READY" || input.kind === "LEAVE_STATUS") {
    return entity
      ? `alrueya://app/module/hr/view/${entity}`
      : "alrueya://app/profile";
  }
  if (input.kind === "ANNOUNCEMENT") {
    // إعلانٌ بعينه ⇒ تغذية «إعلاناتي» على تفصيله (القصر العميل يوجّهه للتغذية قبل بوّابة الصلاحية).
    return entity ? `alrueya://app/module/announcements/view/${entity}` : null;
  }
  if (input.kind === "SESSION_EVENT") {
    // مسارٌ حصريٌّ للأحداث الأمنيّة الإداريّة (ن-٢-د). يحمل معرّف الموظّف كسياق افتتاحيّ
    // لشاشة التنبيهات — الفتحُ الفعليّ للتفاصيل يبقى على الإدارة داخل التطبيق.
    return entity ? `alrueya://app/alerts/session/${entity}` : "alrueya://app/alerts";
  }
  return null;
}

function nativePayloadFor(
  input: CreateAppNotificationInput,
): NormalizedNativePushPayload | null {
  const destination = nativeDestinationFor(input);
  if (!destination) return null;
  const notificationId = `np_${crypto.createHash("sha256").update(input.eventKey, "utf8").digest("base64url")}`;
  const sensitive =
    input.kind === "PAYROLL_READY" ||
    // إشعار الإجازة يحمل نوعها ونطاق تواريخها (بيانات شخصية) ⇒ يُنقَّح على شاشة القفل دائماً كالراتب.
    input.kind === "LEAVE_STATUS" ||
    // الإعلان قد يحمل معلوماتٍ داخليّةً حسّاسة وجمهورُه واسع ⇒ يُنقَّح على شاشة القفل افتراضاً
    // (العميل يستبدل العنوان/النص بنصٍّ آمن حتى فتح التطبيق).
    input.kind === "ANNOUNCEMENT" ||
    // الاعتماد يحمل رقم السند والمبلغ وسبب الرفض ⇒ يُنقَّح على شاشة القفل (بيانات ماليّة).
    // Codex P1 ٢٨/٨: كان lockScreenSafe:false في المستدعي بلا أثر لأنّ الفحص أدناه
    // خصّ ATTENDANCE وحده — الاعتماد كان يخرج sensitive=false ⇒ VISIBILITY_PUBLIC على أندرويد.
    input.kind === "APPROVAL_REQUIRED" ||
    // إشعار الجلسة يحمل عنوان IP والموقع الجغرافي ⇒ حسّاس كذلك.
    input.kind === "SESSION_EVENT" ||
    (input.kind === "ATTENDANCE" && input.lockScreenSafe !== true);
  return normalizeNativePushPayload({
    notificationId,
    kind: input.kind,
    title: input.title.trim().slice(0, 80),
    body: input.body.trim().slice(0, 180),
    destination,
    urgency: input.requiresAction ? "action" : "information",
    sensitive,
  });
}

export async function getNotificationPreferences(
  userId: number,
): Promise<NotificationPreferencesInput> {
  const db = requireDb();
  const [row] = await db
    .select()
    .from(appNotificationPreferences)
    .where(eq(appNotificationPreferences.userId, userId))
    .limit(1);
  return preferencesFromRow(row);
}

export async function updateNotificationPreferences(
  userId: number,
  input: NotificationPreferencesInput,
) {
  const db = requireDb();
  const values = {
    userId,
    taskAssigned: input.taskAssigned,
    payrollReady: input.payrollReady,
    attendance: input.attendance,
    leaveStatus: input.leaveStatus,
    approvals: input.approvals,
    quietHoursStart: input.quietHoursStart ?? null,
    quietHoursEnd: input.quietHoursEnd ?? null,
  };
  await db
    .insert(appNotificationPreferences)
    .values(values)
    .onDuplicateKeyUpdate({ set: { ...values, updatedAt: new Date() } });
  return getNotificationPreferences(userId);
}

export async function createAppNotification(
  input: CreateAppNotificationInput,
): Promise<{ created: boolean }> {
  const db = requireDb();
  const route = safeInternalRoute(input.route);
  const eventKey = input.eventKey.trim().slice(0, 190);
  const normalizedInput = { ...input, eventKey };
  const webPayload = webPushPayloadFor(normalizedInput, route);
  const nativePayload = nativePayloadFor(normalizedInput);
  let webPushAllowed = false;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(appNotifications).values({
        userId: input.userId,
        kind: input.kind,
        title: input.title.trim().slice(0, 180),
        body: input.body.trim().slice(0, 600),
        route,
        entityType: input.entityType?.slice(0, 60) ?? null,
        entityId: input.entityId ?? null,
        eventKey,
        requiresAction: input.requiresAction ?? false,
      });

      if (input.push === false || (!webPayload && !nativePayload)) return;
      const [preferenceRow] = await tx
        .select()
        .from(appNotificationPreferences)
        .where(eq(appNotificationPreferences.userId, input.userId))
        .limit(1);
      const preferences = preferencesFromRow(preferenceRow);
      if (!preferenceAllows(input.kind, preferences)) return;

      const quietRelease = quietHoursReleaseAt(
        preferences.quietHoursStart,
        preferences.quietHoursEnd,
      );
      webPushAllowed = quietRelease == null;
      if (nativePayload) {
        await tx.insert(nativePushOutbox).values({
          userId: input.userId,
          eventKey,
          payload: nativePayload,
          environment: nativeEnvironment(),
          availableAt: quietRelease ?? new Date(),
        });
      }
    });
  } catch (error) {
    if (isDupEntry(error)) return { created: false };
    throw error;
  }

  if (webPushAllowed && webPayload && isPushEnabled()) {
    // Web Push قناة توافق قديمة best-effort. قناة Android الأصلية وحدها تمر عبر outbox دائم.
    void sendPushToUser(input.userId, webPayload).catch(() => undefined);
  }
  return { created: true };
}

/**
 * ش٦ (١٩/٨) — مرشّحان صريحان بدل ترشيحٍ في الواجهة: صندوقُ عشرين إشعاراً يُقتطع بـ`limit`
 * **قبل** أن تراه الشاشة، فترشيحُه هناك يُخفي ما لم يصل أصلاً ويكذب العدّاد. `unreadOnly`
 * لصندوقٍ يُقرأ، و`requiresActionOnly` لما وُسِم عند إنشائه مطلوباً فعلاً.
 *
 * ⚠️ **حدٌّ قائمٌ لا يُخفى:** `requiresAction` **لا يُبطَل** حين ينفّذ الإجراءَ شخصٌ آخر (لا مسار
 * كتابةٍ له بعد الإنشاء) ⇒ هذا المرشّح **يضيّق سجلّاً** ولا يصنع طابور فعلٍ صادقاً. الطابور
 * الحيّ هو `approvalInbox` الذي يقرأ الحالة الحقيقية.
 */
export async function listUserNotifications(
  userId: number,
  limit = 40,
  opts: { unreadOnly?: boolean; requiresActionOnly?: boolean } = {},
) {
  const db = requireDb();
  const filters = [eq(appNotifications.userId, userId)];
  if (opts.unreadOnly) filters.push(isNull(appNotifications.readAt));
  if (opts.requiresActionOnly) filters.push(eq(appNotifications.requiresAction, true));
  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(appNotifications)
      .where(and(...filters))
      .orderBy(desc(appNotifications.createdAt), desc(appNotifications.id))
      .limit(Math.min(Math.max(limit, 1), 100)),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(appNotifications)
      .where(
        and(
          eq(appNotifications.userId, userId),
          isNull(appNotifications.readAt),
        ),
      ),
  ]);
  return { rows, unreadCount: Number(countRows[0]?.count ?? 0) };
}

export async function markNotificationRead(userId: number, id: number) {
  const db = requireDb();
  await db
    .update(appNotifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(appNotifications.id, id), eq(appNotifications.userId, userId)),
    );
  return { ok: true as const };
}

export async function markAllNotificationsRead(userId: number) {
  const db = requireDb();
  await db
    .update(appNotifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(appNotifications.userId, userId), isNull(appNotifications.readAt)),
    );
  return { ok: true as const };
}
