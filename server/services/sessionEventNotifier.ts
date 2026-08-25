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
   * معرّفٌ فريدٌ للجلسة المتعلَّقة بالحدث (Codex P2-٢٥/٨): يُدخَل في eventKey ليمنع
   * الاندماج الخاطئ لدخولين متزامنَين خلال نفس الثانية (فيصير كلٌّ منهما مسمّى بمعرّف
   * جلسته). إن لم يتوفّر (نادر: مسارُ خطأٍ)، نعود إلى مفتاحٍ بالثانية.
   */
  sessionId?: number | string | null;
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
 * IP مُقنَّع (Codex P2-٢٥/٨): أوّل ثلاث خانات من IPv4 مثلاً 10.0.5.* — يكفي لتصنيفٍ عامّ.
 * ✓ IPv4-mapped IPv6 (`::ffff:203.0.113.42` من nginx على IPv4-only) يُطبَّع أوّلاً قبل
 *   الإخفاء وإلّا كان الإصدار السابق يُبقي الرقم كاملاً ⇒ خرقُ ادّعاء الإخفاء.
 * ✓ IPv6 كامل يُختصر إلى أوّل مقطعَين (٣٢ بت) — يكفي لتصنيف ISP بلا كشف الجهاز.
 * ✓ صيغةٌ لا نفهمها ⇒ نُعيد «غير معلوم» بدل إبراز نصٍّ خامّ قد يحوي معلومات.
 */
function maskIp(ip: string | null | undefined): string {
  if (!ip) return "غير معلوم";
  const trimmed = ip.trim();
  if (trimmed.length === 0) return "غير معلوم";
  // اسحب IPv4 من IPv4-mapped IPv6 قبل أيّ فرع IPv6.
  const mappedMatch = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const canonical = mappedMatch ? mappedMatch[1] : trimmed;
  const ipv4Parts = canonical.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d{1,3}$/.test(p))) {
    return `${ipv4Parts[0]}.${ipv4Parts[1]}.${ipv4Parts[2]}.*`;
  }
  if (canonical.includes(":")) {
    const groups = canonical.split(":").filter(Boolean).slice(0, 2);
    return groups.length > 0 ? `${groups.join(":")}::*` : "غير معلوم";
  }
  return "غير معلوم";
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
 * مفتاحٌ ثابتٌ للحدث الواحد: نُميّز الجلسة بمعرّفها (Codex P2 ٢٥/٨) لكيلا يندمج دخولان
 * متزامنان لنفس الموظّف على جهازَين خلال نفس الثانية في مفتاحٍ واحد ⇒ فيتلقّى المستقبِلون
 * إشعاراً واحداً بدل اثنين. إن غاب sessionId (استثناءٌ نادر لمسار خطأ)، نعود إلى نافذة
 * الثانية بحُكم أن الحدث بلا هويّةٍ مستقلّة.
 */
function computeEventKey(input: SessionEventInput, recipientId: number): string {
  const bucket = Math.floor(input.occurredAt.getTime() / 1000);
  const session = input.sessionId != null ? String(input.sessionId) : `t${bucket}`;
  const raw = `session:${input.kind}:${input.userId}:${session}:${recipientId}`;
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
          // ن-٢-د (٢٥/٨) — SESSION_EVENT بدل SYSTEM كي يُنتج push فعليّاً عبر nativePushOutbox
          // (Codex P1: SYSTEM كان يقف عند إدراج الصندوق ⇒ المدير يجهل حتى يفتح يدويّاً).
          kind: "SESSION_EVENT",
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
