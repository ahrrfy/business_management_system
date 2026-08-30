/**
 * الكنّاس الدوري لصندوق واتساب الصادر (waOutbox) — شريحة #١ (نواة Cloud API). نمط cron مطابق
 * لـmorningPushScheduler.ts حرفياً (node-cron، حارس NODE_ENV!=="test"، توقيت UTC) + قفل isRunning
 * يمنع تراكب دورة بطيئة مع الدورة التالية (دفعة كبيرة من إعادات المحاولة قد لا تُنجَز خلال دقيقة).
 */
import cron, { type ScheduledTask } from "node-cron";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { waOutbox } from "../../../drizzle/schema";
import { logger } from "../../logger";
import { isBackgroundOperationActive, runAcrossActiveTenants } from "../../tenancy/backgroundTenants";
import { withTx } from "../tx";
import { dripRunningBroadcasts } from "./broadcastDispatch";
import { getWaHubSettings } from "./flowNotify";
import { dispatchClaimedRow, hasAnyActiveWaIntegration } from "./outboxService";
import { retryFailedWaEvents } from "./webhookProcessor";

const BATCH_LIMIT = 25;
/** يمنع سيل الوسائط الواردة من احتكار العامل: 20 للوسائط كحد أقصى وتبقى 5 خانات للصادر. */
const MEDIA_BATCH_LIMIT = 20;
/** تنظيف محدود للصفوف المحمية التي بطلت أهليتها؛ لا تُحسب من حصة طلبات Graph لكنها تبقى محدودة. */
const OUTBOUND_INSPECTION_LIMIT = 100;

/** يلتقط دفعة الصفوف المستحقّة (QUEUED + الموعد حان) بقفل SKIP LOCKED — يمنع تضارب مع dispatchOutboxRow
 *  المباشر المتزامن (كلاهما يمرّ عبر SELECT...FOR UPDATE فلا يفوز بصفٍّ إلا كاتب واحد؛ SKIP LOCKED
 *  هنا يمنع كذلك دورتَي كنّاس متراكبتين من الانتظار على قفل بعضهما بلا فائدة). */
async function claimDueBatch(limit: number, lane: "MEDIA_FETCH" | "OUTBOUND"): Promise<number[]> {
  if (limit <= 0) return [];
  return withTx(async (tx) => {
    const rows = await tx
      .select({ id: waOutbox.id })
      .from(waOutbox)
      .where(and(
        eq(waOutbox.status, "QUEUED"),
        or(isNull(waOutbox.nextAttemptAt), lte(waOutbox.nextAttemptAt, sql`NOW()`)),
        lane === "MEDIA_FETCH"
          ? eq(waOutbox.kind, "MEDIA_FETCH")
          : ne(waOutbox.kind, "MEDIA_FETCH"),
      ))
      .orderBy(asc(waOutbox.id))
      .limit(limit)
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
  if (!isBackgroundOperationActive("whatsapp_outbox")) {
    const runs = await runAcrossActiveTenants("whatsapp_outbox", sweepWaOutboxOnce);
    return { claimed: runs.reduce((sum, run) => sum + run.claimed, 0) };
  }
  if (!(await hasAnyActiveWaIntegration())) return { claimed: 0 };
  // Kill Switch = تجميد **الصادر الآلي** فوراً بالكامل — يشمل التقاط الكنّاس نفسه لصفوف outbox
  // القائمة (بثّ مُقطَّر مسبقاً، مجدولة scheduledAt، أو إعادات محاولة FAILED→QUEUED)، لا فقط توليد
  // صفوف جديدة (flowNotify/checkAutomationGate). بلا هذا الفحص كانت هذه الصفوف تستمرّ بالإرسال رغم
  // كتم المفتاح — يخالف §٣-٧/§١٢ («يجمّد كل إرسال آلي فوراً» / «يوقف الكنّاس عن الالتقاط»).
  // retryFailedWaEvents (معالجة أحداث webhook **الواردة**) ليست إرسالاً آلياً صادراً ⇒ تبقى تعمل
  // عمداً حتى مع تفعيل المفتاح، كي لا تُفقد رسائل العملاء الواردة أثناء الإيقاف.
  const settings = await getWaHubSettings();
  const killSwitchOn = settings.killSwitch;
  // الوسائط واردة وليست إرسالاً آلياً: تُقدَّم على الصادر وتحصل على سعة العامل الكاملة حتى لو كان
  // throttle منخفضاً أو kill switch مفعّلاً. ما يتبقى من سقف الدورة يُمنح للصادر ضمن حد الإرسال.
  const mediaIds = await claimDueBatch(MEDIA_BATCH_LIMIT, "MEDIA_FETCH");
  for (const id of mediaIds) await dispatchClaimedRow(id);

  let outboundIds: number[] = [];
  if (!killSwitchOn) {
    // إعداد مركز واتساب حدّ شامل للصادر الآلي؛ سقف 25 يحمي دورة العامل حتى لو ضُبطت قيمة أكبر.
    const throttle = Math.max(1, Math.min(BATCH_LIMIT, Number(settings.throttlePerMinute) || 1));
    const remainingCapacity = Math.max(0, BATCH_LIMIT - mediaIds.length);
    const sendLimit = Math.min(throttle, remainingCapacity);
    let consumedSendQuota = 0;
    let inspected = 0;
    while (consumedSendQuota < sendLimit && inspected < OUTBOUND_INSPECTION_LIMIT) {
      const ids = await claimDueBatch(
        Math.min(sendLimit - consumedSendQuota, OUTBOUND_INSPECTION_LIMIT - inspected),
        "OUTBOUND",
      );
      if (ids.length === 0) break;
      outboundIds.push(...ids);
      for (const id of ids) {
        inspected++;
        const outcome = await dispatchClaimedRow(id);
        // حراس المصدر/الموافقة قد يلغون الصف بلا Graph؛ ننظفه ولا نحرق به حصة إرسال هذه الدقيقة.
        if (outcome === "PROCESSED") consumedSendQuota++;
      }
    }
  }
  // إعادة محاولة أحداث webhook الفاشلة (سباق ترتيب: حالة سبقت رسالتها) — بعد الصندوق الصادر،
  // بنفس نبضة الدقيقة (لا جدولة cron مستقلّة). processWaEvent لا ترمي أبداً (تلتقط استثناءها
  // داخلياً وتُعلِّم الحدث FAILED) فلا حاجة لحماية إضافية هنا — نفس افتراض الحلقة أعلاه.
  // تعمل دائماً بصرف النظر عن killSwitch (وارد لا صادر — انظر التعليق أعلاه).
  await retryFailedWaEvents();
  // البث التسويقي (S5، T5.2): تقطير الحملات RUNNING — محمي صراحةً (try/catch) فلا يُفشل النبضة
  // بأكملها؛ dripRunningBroadcasts نفسها تحمي كل حملة على حدة داخلياً (نفس بروتوكول الحلقة أعلاه)
  // وتحترم killSwitch داخلياً أيضاً (نفس settings المقروءة هنا) — نتجنّب استدعاءها أصلاً عند تفعيل
  // المفتاح توفيراً لاستعلام مكرّر لا طائل منه.
  if (!killSwitchOn) {
    try {
      await dripRunningBroadcasts();
    } catch (e) {
      logger.error({ err: e }, "wa-outbox sweep: dripRunningBroadcasts threw — تُجوهل (لا تُفشل النبضة)");
    }
  }
  return { claimed: mediaIds.length + outboundIds.length };
}

let cronTask: ScheduledTask | null = null;
let isRunning = false;

/** تشغيل الكنّاس عند إقلاع الخادم. آمنة الاستدعاء مرّتين (تُوقف السابقة أولاً). */
export function startWaOutboxSweeper(): void {
  // لا cron في بيئة الاختبار (يُسبّب تسريب مؤقّتات ⇒ vitest يعلق) — نمط morningPushScheduler.
  if (process.env.NODE_ENV === "test") return;
  // إزاحة طور (فحص الحمل ٣١/٨/٢٦): الثانية ٥ بدل ٠ — ستّ وظائف كانت تنطلق في اللحظة نفسها
  // على العامل ٠ فتصنع ذروةَ استعلاماتٍ متزامنة. node-cron 4 يقبل حقل الثواني (٦ حقول).
  const cronExpr = "5 * * * * *"; // كل دقيقة UTC عند الثانية ٥
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
