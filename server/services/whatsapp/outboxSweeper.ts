/**
 * الكنّاس الدوري لصندوق واتساب الصادر (waOutbox) — شريحة #١ (نواة Cloud API). نمط cron مطابق
 * لـmorningPushScheduler.ts حرفياً (node-cron، حارس NODE_ENV!=="test"، توقيت UTC) + قفل isRunning
 * يمنع تراكب دورة بطيئة مع الدورة التالية (دفعة كبيرة من إعادات المحاولة قد لا تُنجَز خلال دقيقة).
 */
import cron, { type ScheduledTask } from "node-cron";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { waOutbox } from "../../../drizzle/schema";
import { logger } from "../../logger";
import { withTx } from "../tx";
import { dripRunningBroadcasts } from "./broadcastDispatch";
import { dispatchClaimedRow, hasAnyActiveWaIntegration } from "./outboxService";
import { retryFailedWaEvents } from "./webhookProcessor";

const BATCH_LIMIT = 25;

/** يلتقط دفعة الصفوف المستحقّة (QUEUED + الموعد حان) بقفل SKIP LOCKED — يمنع تضارب مع dispatchOutboxRow
 *  المباشر المتزامن (كلاهما يمرّ عبر SELECT...FOR UPDATE فلا يفوز بصفٍّ إلا كاتب واحد؛ SKIP LOCKED
 *  هنا يمنع كذلك دورتَي كنّاس متراكبتين من الانتظار على قفل بعضهما بلا فائدة). */
async function claimDueBatch(): Promise<number[]> {
  return withTx(async (tx) => {
    const rows = await tx
      .select({ id: waOutbox.id })
      .from(waOutbox)
      .where(and(
        eq(waOutbox.status, "QUEUED"),
        or(isNull(waOutbox.nextAttemptAt), lte(waOutbox.nextAttemptAt, sql`NOW()`)),
      ))
      .orderBy(asc(waOutbox.id))
      .limit(BATCH_LIMIT)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    const ids = rows.map((r) => Number(r.id));
    await tx.update(waOutbox).set({ status: "SENDING" }).where(inArray(waOutbox.id, ids));
    return ids;
  });
}

export interface WaOutboxSweepResult {
  claimed: number;
}

/** دورة كنس واحدة — تُستعمل من cron ومن الاختبار مباشرة (بلا انتظار مؤقّت دقيقة). */
export async function sweepWaOutboxOnce(): Promise<WaOutboxSweepResult> {
  if (!(await hasAnyActiveWaIntegration())) return { claimed: 0 };
  const ids = await claimDueBatch();
  for (const id of ids) {
    await dispatchClaimedRow(id);
  }
  // إعادة محاولة أحداث webhook الفاشلة (سباق ترتيب: حالة سبقت رسالتها) — بعد الصندوق الصادر،
  // بنفس نبضة الدقيقة (لا جدولة cron مستقلّة). processWaEvent لا ترمي أبداً (تلتقط استثناءها
  // داخلياً وتُعلِّم الحدث FAILED) فلا حاجة لحماية إضافية هنا — نفس افتراض الحلقة أعلاه.
  await retryFailedWaEvents();
  // البث التسويقي (S5، T5.2): تقطير الحملات RUNNING — محمي صراحةً (try/catch) فلا يُفشل النبضة
  // بأكملها؛ dripRunningBroadcasts نفسها تحمي كل حملة على حدة داخلياً (نفس بروتوكول الحلقة أعلاه).
  try {
    await dripRunningBroadcasts();
  } catch (e) {
    logger.error({ err: e }, "wa-outbox sweep: dripRunningBroadcasts threw — تُجوهل (لا تُفشل النبضة)");
  }
  return { claimed: ids.length };
}

let cronTask: ScheduledTask | null = null;
let isRunning = false;

/** تشغيل الكنّاس عند إقلاع الخادم. آمنة الاستدعاء مرّتين (تُوقف السابقة أولاً). */
export function startWaOutboxSweeper(): void {
  // لا cron في بيئة الاختبار (يُسبّب تسريب مؤقّتات ⇒ vitest يعلق) — نمط morningPushScheduler.
  if (process.env.NODE_ENV === "test") return;
  const cronExpr = "* * * * *"; // كل دقيقة UTC
  if (cronTask) cronTask.stop();
  cronTask = cron.schedule(
    cronExpr,
    async () => {
      if (isRunning) return; // قفل تنفيذ متداخل — يمنع تراكب دقيقة بطيئة مع التالية.
      isRunning = true;
      try {
        const r = await sweepWaOutboxOnce();
        if (r.claimed > 0) logger.info({ claimed: r.claimed }, "wa-outbox sweep cycle");
      } catch (e) {
        logger.error({ err: e }, "wa-outbox sweep cron threw");
      } finally {
        isRunning = false;
      }
    },
    { timezone: "UTC" },
  );
  logger.info(`[wa-outbox] scheduler started (cron: ${cronExpr} UTC)`);
}

/** للاختبار فقط — يوقف الجدولة النشطة (نظافة). */
export function stopWaOutboxSweeper(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
