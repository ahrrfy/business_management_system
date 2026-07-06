// خدمة إشعارات Web Push (VAPID) — إشعار «برنامج اليوم» الصباحي للمدير/الأدمن.
//
// المبدأ:
//   • VAPID = مفتاح توقيع رسائل الدفع (الخصوصي في .env، العام يُخدَم للعميل ليشترك).
//   • كل جهاز/متصفّح للمستخدم يُنشئ endpoint فريدة عبر browser push service ⇒ نخزّنها.
//   • عند إرسال: نمرّ على كل الاشتراكات النشطة، ننادي web-push، ونشطب المنتهية (410/404).
//   • idempotency: log يومي لكل مستخدم × نوع ⇒ لا نُرسل مرّتين في نفس اليوم.
//
// أمان:
//   • المفتاح الخاص VAPID_PRIVATE_KEY لا يخرج من الخادم أبداً. غيابه ⇒ الخدمة معطَّلة صراحةً.
//   • محتوى الإشعار يحوي أعداداً فقط (aggregate) — لا أسماء/أرقام هواتف عملاء (يظهر في شريط الإشعارات).
//   • Subscription tokens نفسها من browser push service — endpoint وحده ليس هوية (يحتاج VAPID للتوقيع).
import { TRPCError } from "@trpc/server";
import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { and, eq, isNull, sql } from "drizzle-orm";
import { pushDailyClaim, pushSubscriptions, pushNotificationLog } from "../../drizzle/schema";
import { requireDb } from "./tx";

/** أنواع الإشعارات المدعومة — واحد الآن، قابل للتوسيع بلا تغيير schema. */
export type PushKind = "MORNING_BRIEF";

/** جسم الإشعار المُرسَل — أعداد فقط (لا بيانات شخصية). يُوسَّع للأنواع القادمة. */
export interface MorningBriefPayload {
  kind: "MORNING_BRIEF";
  title: string;
  body: string;
  /** المسار الذي يُفتَح عند النقر على الإشعار — شرطي حسب محتوى `counts` (gap-audit ٥/٧ item 10):
   *  تذكيرات AR أو وعد اليوم ⇒ /reports/ar-reminders، وإلا أمر شغل متأخّر ⇒ مركز أوامر الشغل،
   *  وإلا (لا شيء مُستحقّ، حالة نادرة) ⇒ /dashboard. انظر `pickMorningBriefUrl` في
   *  morningPushScheduler.ts. */
  url: string;
  /** أعداد للسياق (للتحقّق في اختبار E2E المستقبلي). */
  counts: { arRemindersDue: number; promisedToday: number; overdueWorkOrders: number };
}

/** تهيئة web-push من env. تُنادى مرّة عند إنشاء الخدمة (idempotent — web-push يسمح بإعادة الضبط). */
function ensureVapidConfigured(): { publicKey: string; privateKey: string; subject: string } {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@alroya.local";
  if (!publicKey || !privateKey) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "الإشعارات غير مُهيّأة (VAPID keys مفقودة في .env).",
    });
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { publicKey, privateKey, subject };
}

/** هل الإشعارات مُفعَّلة أصلاً؟ (بدون رمي — للاستعمال في cron/فحوصات صحّة). */
export function isPushEnabled(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

/** المفتاح العام VAPID — يُخدَم للعميل غير المُصادَق (VAPID public keys ليست سرّية). */
export function getVapidPublicKey(): string {
  const { publicKey } = ensureVapidConfigured();
  return publicKey;
}

export interface SubscribeInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/** UPSERT اشتراك — بحماية hijack (تدقيق ٥/٧):
 *  - endpoint موجودة **لنفس المستخدم** ⇒ حدّث المفاتيح/UA وأعِد التفعيل إن كانت مُبطَلة.
 *  - endpoint موجودة **لمستخدم آخر** ⇒ CONFLICT (حظر خطف الاشتراك: المهاجم يستطيع
 *    تجميد إشعارات ضحيّته بادّعاء endpointها؛ endpoints ليست سرّية).
 *  - غير موجودة ⇒ INSERT جديد.
 *  ملاحظة: لا نصادق «ملكية» الجهاز الحقيقي — لكن حظر إعادة الإسناد يمنع الخطف الحقيقي: المتصفّح
 *  الحقيقي لصاحب endpoint لا يستطيع تسجيلها لغيره لأنّه هو المُصدِر. */
export async function subscribeUserToPush(
  input: SubscribeInput,
  userId: number,
): Promise<{ id: number }> {
  if (!input.endpoint || !input.p256dh || !input.auth) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات الاشتراك ناقصة." });
  }
  const db = requireDb();
  const existing = await db
    .select({ id: pushSubscriptions.id, userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, input.endpoint))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].userId !== userId) {
      // انتحال محاولة إسناد endpoint لغير مالكها ⇒ ارفض بدون تسريب أنّها لمستخدم آخر.
      throw new TRPCError({
        code: "CONFLICT",
        message: "الاشتراك مربوط بحساب آخر.",
      });
    }
    await db
      .update(pushSubscriptions)
      .set({
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        revokedAt: null, // إن كانت مُبطَلة سابقاً، أعِد تفعيلها.
      })
      .where(eq(pushSubscriptions.id, existing[0].id));
    return { id: existing[0].id };
  }
  const res = await db.insert(pushSubscriptions).values({
    userId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    userAgent: input.userAgent ?? null,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  return { id };
}

/** إبطال اشتراك — يُنادى من واجهة «إيقاف الإشعارات» أو تلقائياً عند 410. */
export async function unsubscribeByEndpoint(endpoint: string, userId?: number): Promise<void> {
  const db = requireDb();
  const conditions = userId != null
    ? and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId))
    : eq(pushSubscriptions.endpoint, endpoint);
  await db.update(pushSubscriptions).set({ revokedAt: new Date() }).where(conditions);
}

/**
 * حجز ذرّي لإرسال إشعار «برنامج اليوم» لمستخدم اليوم — يستخدم PK (userId,kind,claimDay) في
 * pushDailyClaim ⇒ عمليّتان تحاولان معاً (مثلاً نافذة PM2 reload) ⇒ واحدة تفوز، الأخرى تفشل بسلام.
 * يُعيد true إن فاز حاجزٌ جديد (تابع الإرسال) وfalse إن كان محجوزاً سلفاً (تخطَّ).
 */
export async function claimDailyPushSlot(userId: number, kind: PushKind): Promise<boolean> {
  const db = requireDb();
  try {
    await db.execute(sql`
      INSERT IGNORE INTO pushDailyClaim (userId, pushClaimKind, claimDay)
      VALUES (${userId}, ${kind}, UTC_DATE())
    `);
    // نتحقّق: هل نحن أدخلنا؟ نطلب الصفّ ونقارن claimedAt بالثواني القليلة الأخيرة (المكسِب).
    // أبسط: SELECT ROW_COUNT() — على mysql2 يعيد 1 عند INSERT فعلي، 0 عند التجاهل (duplicate).
    const [r] = await db.execute(sql`SELECT ROW_COUNT() AS n`);
    const n = Number(((r as unknown) as Array<{ n: number }>)[0]?.n ?? 0);
    return n === 1;
  } catch {
    // فشل قاعدة عابر ⇒ نتصرّف كأنّ الحجز مُتاح (نُعطي الأولوية للإرسال المفقود، القيود الأخرى تحمي).
    // في الواقع ROW_COUNT بعد INSERT IGNORE على PK duplicate يُعيد 0 ولا يرمي.
    return true;
  }
}

/** هل أُرسل إشعار من هذا النوع للمستخدم اليوم؟ للاستعمال في اختبار/تشخيص فقط — الجدولة الفعلية
 *  تستعمل claimDailyPushSlot لضمان الذرّية. */
export async function wasPushSentToday(userId: number, kind: PushKind): Promise<boolean> {
  const db = requireDb();
  // نطاق قابل للفهرسة (sargable) — يستعمل `idx_push_log_user_sent(userId,sentAt)` بدل الفحص الكامل.
  // «أرسل اليوم» = أيّ محاولة داخل نافذة اليوم UTC (بما فيها FAILED_OTHER — قرار: محاولة واحدة/يوم).
  const rows = await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(pushNotificationLog)
    .where(
      and(
        eq(pushNotificationLog.userId, userId),
        eq(pushNotificationLog.kind, kind),
        sql`${pushNotificationLog.sentAt} >= UTC_DATE()`,
        sql`${pushNotificationLog.sentAt} < UTC_DATE() + INTERVAL 1 DAY`,
      ),
    );
  return Number(rows[0]?.c ?? 0) > 0;
}

interface SendResultRecord {
  status: "SENT" | "FAILED_GONE" | "FAILED_OTHER";
  statusCode: number | null;
  errorMessage: string | null;
}

/** إرسال payload لكل الاشتراكات النشطة للمستخدم. يشطب تلقائياً كل endpoint يُرجع 404/410.
 *  يُسجّل سطراً في `pushNotificationLog` **لكل محاولة اشتراك** (ليس اشتراكاً واحداً لكل مستخدم).
 *  يُرجع ملخّصاً للـcaller ليقرّر التسجيل التجميعي. */
export async function sendPushToUser(
  userId: number,
  payload: MorningBriefPayload,
): Promise<{ sent: number; goneRevoked: number; failed: number }> {
  ensureVapidConfigured();
  const db = requireDb();
  const subs = await db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)));

  if (subs.length === 0) return { sent: 0, goneRevoked: 0, failed: 0 };

  const body = JSON.stringify(payload);

  // مُوازاة الاشتراكات (gap-audit ٥/٧ item 9): كانت الحلقة تسلسلية ⇒ N اشتراكاً لمستخدم واحد
  // قد يأخذ حتى N×١٠ث (مهلة الاشتراك الواحد). Promise.allSettled يُشغّل الكل معاً — فشل/مهلة
  // اشتراك واحد لا يُبطئ البقيّة، ونحسب نفس العدّادات الثلاثة من نتائج التسويات.
  const settled = await Promise.allSettled(
    subs.map(async (s) => {
      const subscription: WebPushSubscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      let record: SendResultRecord;
      let outcome: "SENT" | "FAILED_GONE" | "FAILED_OTHER";
      try {
        // مهلة ١٠ثوان لكل اشتراك ⇒ اشتراك بطيء لا يُعطّل بقيّة الاشتراكات والدورة الصباحية.
        const r = await webpush.sendNotification(subscription, body, { timeout: 10_000 });
        record = { status: "SENT", statusCode: r.statusCode, errorMessage: null };
        outcome = "SENT";
      } catch (err: unknown) {
        const e = err as { statusCode?: number; body?: string; message?: string };
        const code = e.statusCode ?? null;
        if (code === 410 || code === 404) {
          // Gone: المستخدم أبطل الاشتراك من المتصفّح أو حذف بيانات الموقع ⇒ لن يعمل ثانيةً.
          await unsubscribeByEndpoint(s.endpoint);
          record = { status: "FAILED_GONE", statusCode: code, errorMessage: null };
          outcome = "FAILED_GONE";
        } else {
          // 4xx أخرى (نادرة) / 5xx / أخطاء شبكة ⇒ نُبقي الاشتراك، سنعيد المحاولة الغد.
          // نخزّن رسالة موجزة فقط — لا `e.body` (قد يحوي VAPID JWT الموقَّع + رؤوس ⇒ تسريب في سجلّ التطبيق).
          record = {
            status: "FAILED_OTHER",
            statusCode: code,
            errorMessage: `${code ?? "err"}:${(e.message ?? "unknown").slice(0, 200)}`,
          };
          outcome = "FAILED_OTHER";
        }
      }
      // log سطر لكل محاولة (يفيد لتشخيص لماذا لم يصل الإشعار لجهاز معيّن).
      await db.insert(pushNotificationLog).values({
        userId,
        kind: payload.kind,
        payload: body,
        status: record.status,
        statusCode: record.statusCode,
        errorMessage: record.errorMessage,
      });
      return outcome;
    }),
  );

  let sent = 0, goneRevoked = 0, failed = 0;
  for (const r of settled) {
    // كل عنصر داخل map مُعالَج (try/catch شامل) ⇒ لا يُفترَض "rejected" هنا إطلاقاً، لكن نُبقي
    // مساراً آمناً (يُحتسَب "failed") لو نجم خطأ غير متوقَّع خارج المنطقة المحروسة (مثل db.insert).
    if (r.status === "fulfilled") {
      if (r.value === "SENT") sent++;
      else if (r.value === "FAILED_GONE") goneRevoked++;
      else failed++;
    } else {
      failed++;
    }
  }
  return { sent, goneRevoked, failed };
}
