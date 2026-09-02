// راوتر Web Push — يوفّر مفتاح VAPID العام + endpoints اشتراك/إبطال.
// كل الإجراءات محميّة (protectedProcedure) — يجب تسجيل الدخول لتفعيل الإشعارات لحسابك.
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { pushSubscriptions } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  getVapidPublicKey,
  isPushEnabled,
  subscribeUserToPush,
  unsubscribeByEndpoint,
} from "../services/pushService";
import { logAudit } from "../services/auditService";
import { router, selfServiceProcedure } from "../trpc";

// الاشتراك ذاتيّ لكل مستخدم مسجّل. نوع المحتوى وتفويضه يقرره منشئ الحدث الخادميّ؛ فتح
// الاشتراك لا يمنح بياناتٍ ولا يسمح للمستخدم باختيار مستلمٍ آخر.
export const pushRouter = router({
  /** حالة تفعيل الإشعارات على الخادم (VAPID مُهيّأ؟) + المفتاح العام. للعميل ليعرف هل يعرض الزر. */
  publicKey: selfServiceProcedure.query(() => {
    if (!isPushEnabled()) return { enabled: false as const, publicKey: null };
    return { enabled: true as const, publicKey: getVapidPublicKey() };
  }),

  /** عدد اشتراكاتي النشطة (لعرض حالة «مفعّل على X أجهزة» في واجهة الحساب). */
  myStatus: selfServiceProcedure.query(async ({ ctx }) => {
    const db = getDb();
    if (!db) return { activeCount: 0 };
    const rows = await db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(
        and(eq(pushSubscriptions.userId, ctx.user.id), isNull(pushSubscriptions.revokedAt)),
      );
    return { activeCount: rows.length };
  }),

  /** اشتراك: يستدعيه العميل بعد subscribe() من PushManager. UPSERT على endpoint (نفس المتصفّح
   *  يعيد الاشتراك ⇒ نحدّث لا نُنشئ ثانياً). */
  subscribe: selfServiceProcedure
    .input(
      z.object({
        endpoint: z.string().url().max(500),
        p256dh: z.string().min(1).max(255),
        auth: z.string().min(1).max(100),
        userAgent: z.string().max(255).optional().nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const r = await subscribeUserToPush(input, ctx.user.id);
      await logAudit(ctx, {
        action: "push.subscribed",
        entityType: "pushSubscription",
        entityId: r.id,
        newValue: { endpoint: input.endpoint.slice(0, 60) + "…", userAgent: input.userAgent ?? null },
      });
      return r;
    }),

  /** إبطال اشتراك — من زرّ «إيقاف الإشعارات» في واجهة الحساب. */
  unsubscribe: selfServiceProcedure
    .input(z.object({ endpoint: z.string().url().max(500) }))
    .mutation(async ({ input, ctx }) => {
      await unsubscribeByEndpoint(input.endpoint, ctx.user.id);
      await logAudit(ctx, {
        action: "push.unsubscribed",
        entityType: "pushSubscription",
        entityId: 0,
        newValue: { endpoint: input.endpoint.slice(0, 60) + "…" },
      });
      return { ok: true };
    }),
});
