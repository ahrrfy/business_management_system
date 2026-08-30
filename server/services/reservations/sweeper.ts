/**
 * كنّاس الحجوزات المنتهية — يستدعي `expireDueReservations` دورياً على العامل الخلفيّ (worker 0)
 * حصراً (يُغلَّف بحارس `isBackgroundJobRunner` في `server/index.ts`). النمط مطابقٌ لـwaOutboxSweeper
 * (node-cron + قفل `isRunning` يمنع تراكب دورةٍ بطيئة مع التالية + timezone UTC + حارس NODE_ENV=test).
 *
 * لماذا نحتاج كنّاساً خلفياً رغم الفحص الكسول في `list`/`get`؟
 * - الفحص الكسول ينفَّذ **فقط عند وجود قارئ**: إن لم يفتح أحدٌ شاشة الحجوزات لأيّامٍ، تبقى الحجوزات
 *   المنتهية بحالة ACTIVE وتحبس مخزوناً محجوزاً بلا داعٍ.
 * - الكنّاس يضمن أنّ الحالة على الخادم صحيحةٌ **باستقلالٍ عن أيّ مستخدم** — تقاريرٌ خلفيّة أخرى
 *   (تنبيهات، تكاملات، فحص توفّر ATP) تعتمد على `status` الفعليّ لا الظنّي.
 * - قرار المالك ١٢/٨: «الحجز يبقى نشطاً بعد انقضاء وقته» — الاعتماد الحصريّ على القارئ لا يكفي.
 */
import cron, { type ScheduledTask } from "node-cron";
import { logger } from "../../logger";
import { expireDueReservations } from "./lifecycle";
import { notifyNearExpiryReservations } from "./nearExpiry";

let expiryCronTask: ScheduledTask | null = null;
let nearExpiryCronTask: ScheduledTask | null = null;
let expiryIsRunning = false;
let nearExpiryIsRunning = false;

/** دورة كنسٍ واحدة — تُستعمل من الكرون ومن الاختبار مباشرةً (بلا انتظار دقيقة). */
export async function sweepExpiredReservationsOnce(): Promise<{ expired: number }> {
  return expireDueReservations(200);
}

/** دورة تنبيه واحدة — تُستعمل من كرون الدقيقة ومن الاختبار مباشرةً. */
export async function notifyNearExpiryReservationsOnce(): Promise<NotifyNearExpiryResult> {
  return notifyNearExpiryReservations();
}

type NotifyNearExpiryResult = Awaited<ReturnType<typeof notifyNearExpiryReservations>>;

/**
 * تشغيل الكنّاس عند إقلاع الخادم. آمنة الاستدعاء مرّتين (تُوقف السابقة أولاً).
 * الجدولة: كلّ ٥ دقائق UTC — الحجوزات مدّتها بالساعات (max 72س)، فتأخير حتى ٥ دقائق مقبول
 * ولا يُثقل القاعدة. الفحص الكسول في list/get يمسك حالة الظهور الفوريّ للمستخدم.
 */
export function startReservationsSweeper(): void {
  // لا cron في بيئة الاختبار (يُسبّب تسريب مؤقّتات ⇒ vitest يعلّق) — نمط outboxSweeper/morningPushScheduler.
  if (process.env.NODE_ENV === "test") return;
  stopReservationsSweeper();
  // إزاحة الأطوار (فحص الحمل ٣١/٨/٢٦): ستّ وظائف دورية كانت تنطلق في الثانية `00` نفسها على
  // العامل ٠ (ثلاثٌ كل دقيقة وثلاثٌ كل ٥ دقائق) فتتراكم ذروةُ استعلاماتٍ متزامنة على مجمّع
  // اتصالٍ واحد. node-cron 4 يقبل حقل الثواني (٦ حقول) ⇒ نوزّعها على الدقيقة بفواصل ≥١٠ث.
  const expiryCronExpr = "35 */5 * * * *"; // كل ٥ دقائق UTC عند الثانية ٣٥
  const nearExpiryCronExpr = "45 * * * * *"; // كل ٦٠ ثانية عند الثانية ٤٥
  expiryCronTask = cron.schedule(
    expiryCronExpr,
    async () => {
      if (expiryIsRunning) return; // قفل تنفيذ متداخل — يمنع تراكب دورةٍ ثقيلة مع التالية.
      expiryIsRunning = true;
      try {
        const r = await sweepExpiredReservationsOnce();
        if (r.expired > 0) logger.info({ expired: r.expired }, "[reservations] expiry sweep cycle");
      } catch (e) {
        logger.error({ err: e }, "[reservations] expiry sweep cron threw");
      } finally {
        expiryIsRunning = false;
      }
    },
    { timezone: "UTC" },
  );
  nearExpiryCronTask = cron.schedule(
    nearExpiryCronExpr,
    async () => {
      if (nearExpiryIsRunning) return;
      nearExpiryIsRunning = true;
      try {
        const r = await notifyNearExpiryReservationsOnce();
        if (r.notified > 0) logger.info(r, "[reservations] near-expiry notification cycle");
      } catch (e) {
        logger.error({ err: e }, "[reservations] near-expiry notification cron threw");
      } finally {
        nearExpiryIsRunning = false;
      }
    },
    { timezone: "UTC" },
  );
  logger.info(`[reservations] expiry sweeper started (cron: ${expiryCronExpr} UTC)`);
  logger.info(`[reservations] near-expiry notifier started (cron: ${nearExpiryCronExpr} UTC)`);
}

/** للاختبار فقط — يوقف الجدولة النشطة (نظافة). */
export function stopReservationsSweeper(): void {
  if (expiryCronTask) {
    expiryCronTask.stop();
    expiryCronTask = null;
  }
  if (nearExpiryCronTask) {
    nearExpiryCronTask.stop();
    nearExpiryCronTask = null;
  }
}
