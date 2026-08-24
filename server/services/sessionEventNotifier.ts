import crypto from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { createAppNotification } from "./appNotificationService";
import { requireDb } from "./tx";

/**
 * ن-٢-د (٢٤/٨) — إشعارات الإدارة على أحداث الدخول/الخروج/إبطال الجلسة.
 *
 * القاعدة الحاكمة:
 *   1) الحدث يصلُ كلَّ إداريٍّ له علاقةٌ إدارية بالحساب المُلاحظ:
 *      - كلّ admin غير الفاعل نفسه (لا يستفزّ الأدمنَ إشعارٌ عن دخوله هو).
 *      - كلّ isOwner (المالكون يرَون كلَّ دخولٍ في المنشأة).
 *      - كلّ manager في نفس branchId (لا يعبر الفرع، تطابقاً مع سياسة عزل مدير الفرع).
 *   2) الحمولةُ عناوينُ بلا أسرار (اسم مختصر + جهاز + IP مقنّع + وقت). لا كوكي، لا توكن.
 *   3) idempotency: eventKey يعتمد على (kind + userId + occurredAt) لكيلا يتكرّر عند
 *      إعادةِ محاولةٍ خادميّة سببها timeout.
 *   4) fail-open: أيّ عطلٍ في هذا المسار لا يوقف تسجيل الدخول أو الخروج — يُلتقَط ويُهمَل.
 *      وظيفةُ المسار إفصاحٌ إدارية، لا حرسٌ أمنيّ حاجز.
 */
export type SessionEventKind = "LOGIN" | "LOGOUT" | "SESSION_REVOKED";

export interface SessionEventInput {
  /** المستخدمُ الذي وقع عليه الحدث. */
  userId: number;
  /** فرعُ ذلك المستخدم لتحديد نطاق مديري الفرع. `null` = بلا فرعٍ مُسنَد ⇒ يُخطَر admin/owner فقط. */
  userBranchId: number | null;
  /** الاسمُ المعروض للحدث (اسم الموظّف كما يظهر في السجلّ). */
  userDisplayName: string;
  kind: SessionEventKind;
  /** IP المُلتَقَط من الطلب. سيُقنَّع قبل الإدراج (لا يُخزَّن نصّاً كاملاً). */
  ipAddress?: string | null;
  /** وسمُ الجهاز إن توفّر (User-Agent مقتصر + خيار native). */
  deviceLabel?: string | null;
  /**
   * الفاعلُ خلف الحدث — للسّجلّ (revokeUserSessions يفعله المدير، فيدخل هنا).
   * `null` = الفاعل هو نفسُه المستخدم (login/logout الطبيعيّ).
   */
  actorUserId?: number | null;
  /**
   * وقتُ الحدث الفعليّ. مطلوبٌ لدلالة idempotency: طلبانِ متطابقان بنفس lifetime يُدمَجان
   * على نفس المفتاح، فلا يتكرّر إشعارٌ عند إعادة محاولة نقلٍ خادميّة.
   */
  occurredAt: Date;
}

function humanKind(kind: SessionEventKind): string {
  switch (kind) {
    case "LOGIN":
      return "دخول";
    case "LOGOUT":
      return "خروج";
    case "SESSION_REVOKED":
      return "إبطال جلسة";
  }
}

/**
 * IP مُقنَّع: أوّل ثلاث خانات من IPv4 مثلاً 10.0.5.* — يكفي لتصنيفٍ عامّ (شبكة الفرع مقابل
 * شبكةٍ غريبة) بلا تسريب مطلق. IPv6 يُختصر لأوّل ٤ مقاطع.
 */
function maskIp(ip: string | null | undefined): string {
  if (!ip) return "غير معلوم";
  const trimmed = ip.trim();
  if (trimmed.length === 0) return "غير معلوم";
  if (trimmed.includes(":")) {
    return trimmed.split(":").slice(0, 4).join(":") + "::*";
  }
  const parts = trimmed.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  return trimmed;
}

function safeDeviceLabel(label: string | null | undefined): string {
  const cleaned = (label ?? "").replace(/[\r\n\t]/g, " ").trim();
  if (cleaned.length === 0) return "جهاز غير معلوم";
  return cleaned.length <= 60 ? cleaned : cleaned.slice(0, 57) + "…";
}

function safeName(name: string | null | undefined): string {
  const cleaned = (name ?? "").replace(/\s+/g, " ").trim();
  return cleaned.length === 0 ? "موظّف" : cleaned.slice(0, 60);
}

function buildTitle(kind: SessionEventKind, name: string): string {
  return `${humanKind(kind)}: ${name}`;
}

function buildBody(input: SessionEventInput): string {
  const device = safeDeviceLabel(input.deviceLabel);
  const ip = maskIp(input.ipAddress ?? null);
  const time = input.occurredAt.toISOString();
  return `الجهاز: ${device} · الشبكة: ${ip} · الوقت: ${time}`;
}

/**
 * مفتاحٌ ثابتٌ للحدث الواحد: (kind + userId + occurredAt-ثانية) يُنتج مفتاحاً موحَّداً بين
 * الإدراجات المتوازية لعدّة مستقبلين، وقصير الطول لعمود eventKey (VARCHAR 190).
 */
function computeEventKey(input: SessionEventInput, recipientId: number): string {
  const bucket = Math.floor(input.occurredAt.getTime() / 1000);
  const raw = `session:${input.kind}:${input.userId}:${bucket}:${recipientId}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

async function listAdminRecipients(input: SessionEventInput): Promise<number[]> {
  const db = requireDb();
  const branch = input.userBranchId;

  // Managers of the SAME branch + all admins + all isOwner — always excluding the actor and
  // the subject themselves (a user should not be notified about their own login).
  const excludeIds = new Set<number>();
  excludeIds.add(input.userId);
  if (input.actorUserId && input.actorUserId !== input.userId) excludeIds.add(input.actorUserId);

  const managerCondition =
    branch != null
      ? and(eq(users.role, "manager"), eq(users.branchId, branch))
      : sql`FALSE`;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
        or(eq(users.role, "admin"), eq(users.isOwner, true), managerCondition),
        // Never notify an expired account (its session would be rejected anyway).
        sql`(${users.accessExpiresAt} IS NULL OR ${users.accessExpiresAt} > NOW())`,
      ),
    );

  return rows
    .map((r) => r.id as number)
    .filter((id) => !excludeIds.has(id));
}

/**
 * ينشر الإشعار لكلّ مستقبلٍ إداريّ محتمل. `fail-open`: أيّ خطأ يُلتقَط ويُهمَل — لا يوقف
 * تسجيل الدخول أو الخروج. لا نُنتظِر النتائج لأنّ mutations من نوع «صياح»؛ إنشاء الإشعار
 * لا يُدخل قفلاً على مسار المصادقة.
 */
export async function notifyAdminsOfSessionEvent(input: SessionEventInput): Promise<void> {
  try {
    const recipients = await listAdminRecipients(input);
    if (recipients.length === 0) return;
    const title = buildTitle(input.kind, safeName(input.userDisplayName));
    const body = buildBody(input);
    const route = "/mobile#session-events";
    await Promise.allSettled(
      recipients.map((recipientId) =>
        createAppNotification({
          userId: recipientId,
          kind: "SYSTEM",
          title,
          body,
          route,
          eventKey: computeEventKey(input, recipientId),
          entityType: "session",
          entityId: input.userId,
          requiresAction: false,
          // الحمولةُ عناوينُ فقط ⇒ آمنة للعرض على شاشة القفل — يُبطَل الحجب الافتراضيّ.
          lockScreenSafe: true,
        }),
      ),
    );
  } catch {
    // fail-open: مسار الإفصاح لا يُعطّل الدخول/الخروج مهما جرى.
  }
}
