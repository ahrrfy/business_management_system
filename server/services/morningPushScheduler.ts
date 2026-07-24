// جدولة إشعار «برنامج اليوم» الصباحي — cron يومي على الخادم يمرّ بالمشتركين ويرسل ما لم يُرسَل اليوم.
//
// القرارات:
//   • التوقيت: افتراضياً `0 4 * * *` UTC = 07:00 بغداد (افتتاح المتجر). قابل للتخصيص بـMORNING_PUSH_CRON.
//   • الجمهور: admin + manager فقط (مطابق RBAC لوحة MorningBrief في Dashboard.tsx).
//   • النطاق: كل الفروع (branchId=null) — نفس نطاق `MorningBrief` للمستخدم المُرتَقي (`elevated ? undefined`).
//   • idempotency: log يومي لكل مستخدم × نوع ⇒ لا نُرسل مرّتين لو أُعيد تشغيل الخادم قبل نهاية اليوم.
//   • الحدّ الأدنى: إن كان total=0 لهذا المستخدم ⇒ نتخطّى (لا نُشتّت بلا سبب — يطابق سلوك MorningBrief).
//   • إعادة تشغيل PM2 آمنة: لن يُرسل مرّتين لأن wasPushSentToday يمنع.
//
// ⚠️ يجب تشغيل الخادم في PM2 fork mode (نسخة واحدة). لو تحوَّل لـcluster ⇒ يُشغَّل cron N مرّات
// ⇒ N طلبات إرسال متزامنة (idempotency يحمي المستقبِل، لكن الجهد مُهدَر). CLAUDE.md يذكر fork ⇒ آمن.
import cron, { type ScheduledTask } from "node-cron";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { pushSubscriptions, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { getDashboardMetrics, getMyOpenTasksCount } from "./reports/dashboard";
import {
  claimDailyPushSlot,
  isPushEnabled,
  sendPushToUser,
  type MorningBriefPayload,
} from "./pushService";

/** عدّادا المهام (نظام المهام الموحّد S2) — myOpenTasks شخصيّ بحت (لا يمرّ بـ`metricsFor`
 *  المُخزَّنة مؤقّتاً)، overdueTasks يأتي من نفس نتيجة `getDashboardMetrics` المُخزَّنة (تشغيليّ،
 *  نطاق كل الفروع مثل overdueWorkOrders). كلاهما اختياريّان في التوقيع (مطابقة توافقية لأي
 *  استدعاء لا يزوّدهما — لا مستدعٍ حالياً غير هذا الملف). */
type MorningBriefCounts = {
  arRemindersDue: number;
  promisedToday: number;
  overdueWorkOrders: number;
  myOpenTasks?: number;
  overdueTasks?: number;
};

/** الصياغة العربية للجسم — أعداد فقط (يظهر في شريط إشعارات النظام، بلا أسماء عملاء). */
function buildBody(counts: MorningBriefCounts, total: number): string {
  const parts: string[] = [];
  if (counts.promisedToday > 0) parts.push(`${counts.promisedToday} موعود`);
  if (counts.arRemindersDue > 0) parts.push(`${counts.arRemindersDue} تذكير`);
  if (counts.overdueWorkOrders > 0) parts.push(`${counts.overdueWorkOrders} أمر شغل متأخّر`);
  if (counts.myOpenTasks) parts.push(`${counts.myOpenTasks} مهمة مفتوحة`);
  if (counts.overdueTasks) parts.push(`${counts.overdueTasks} مهمة متأخّرة`);
  return `${total} بند للمتابعة${parts.length > 0 ? ": " + parts.join("، ") : ""}`;
}

/** الرابط الأنسب للإشعار حسب ما هو مُستحقّ فعلاً (gap-audit ٥/٧ item 10) — كان مُثبَّتاً على
 *  /dashboard دائماً رغم أنّ محتوى الإشعار غالباً تذكير ذمم أو أمر شغل متأخّر تحديداً؛ الآن يوجّه
 *  المستخدم مباشرةً لشاشة العمل ذات الصلة بدل تحويلة إضافية عبر لوحة التحكم.
 *  الأولوية: تذكيرات AR/وعد اليوم (الأكثر إلحاحاً مالياً) > أوامر شغل متأخّرة > مهام (S2) > /dashboard. */
function pickMorningBriefUrl(counts: MorningBriefCounts): string {
  if (counts.arRemindersDue > 0 || counts.promisedToday > 0) return "/reports/ar-reminders";
  if (counts.overdueWorkOrders > 0) return "/work-orders"; // مركز أوامر الشغل التشغيلي (PrintHub) — لا /reports/work-orders الثابتة.
  if (counts.overdueTasks || counts.myOpenTasks) return "/tasks";
  return "/dashboard";
}

/** نتيجة تشغيل واحدة — للاستعمال في السجلّ والاختبار. */
export interface MorningPushRunResult {
  candidates: number;
  sent: number;
  skippedAlreadySent: number;
  skippedEmpty: number;
  goneRevoked: number;
  failed: number;
}

/**
 * دورة إرسال واحدة — تُستعمل من cron ومن الاختبار (يمكن استدعاؤها يدوياً).
 * تُرجع تفصيلاً كافياً للتشخيص. أخطاء الإرسال الفردية لا تُوقف الدورة.
 */
export async function runMorningBriefPush(): Promise<MorningPushRunResult> {
  const result: MorningPushRunResult = {
    candidates: 0, sent: 0, skippedAlreadySent: 0, skippedEmpty: 0, goneRevoked: 0, failed: 0,
  };
  if (!isPushEnabled()) return result;
  const db = getDb();
  if (!db) return result;

  // مستخدمون فعّالون بحسابات admin/manager ولديهم اشتراك دفع نشط واحد على الأقلّ.
  // GROUP BY على userId يعطي مرشّحين فريدين (اشتراكات متعدّدة لنفس المستخدم = جهاز واحد).
  const candidates = await db
    .selectDistinct({ userId: pushSubscriptions.userId, role: users.role })
    .from(pushSubscriptions)
    .innerJoin(users, eq(users.id, pushSubscriptions.userId))
    .where(
      and(
        isNull(pushSubscriptions.revokedAt),
        inArray(users.role, ["admin", "manager"]),
        eq(users.isActive, true),
      ),
    );
  result.candidates = candidates.length;

  // النتيجة (branchId:null) لا تعتمد على هوية المستخدم — فقط على includeOpeningBalance (أدمن/غيره)
  // ⇒ قيمتان فريدتان بالضبط بغضّ النظر عن عدد المشتركين. cache بدل استدعاء getDashboardMetrics
  // الكامل لكل مستخدم (gap-audit ٥/٧ medium: N+1 حقيقي كان يعيد نفس الاستعلامات لكل مشترك).
  const metricsCache = new Map<boolean, Awaited<ReturnType<typeof getDashboardMetrics>>>();
  async function metricsFor(includeOpeningBalance: boolean) {
    let m = metricsCache.get(includeOpeningBalance);
    if (!m) {
      m = await getDashboardMetrics({ branchId: null, includeOpeningBalance });
      metricsCache.set(includeOpeningBalance, m);
    }
    return m;
  }

  for (const { userId, role } of candidates) {
    try {
      // حجز ذرّي — يمنع الازدواج عند نافذة إعادة PM2 (كلا العمليتَين تحاولان، واحدة فقط تنجح).
      if (!(await claimDailyPushSlot(userId, "MORNING_BRIEF"))) {
        result.skippedAlreadySent++;
        continue;
      }
      // نطاق كل الفروع (يطابق ما يراه المدير/الأدمن على لوحة التحكم). gap-audit ٥/٧ (HIGH):
      // مدينو الرصيد الافتتاحي (openingScope) للأدمن حصراً — مطابقةً لحصر النطاق في الراوتر
      // (كانوا غائبين كلياً عن هذا الإشعار رغم أنه القناة اليومية المصمَّمة لهذا الغرض بالضبط).
      const m = await metricsFor(role === "admin");
      // myOpenTasks شخصيّ ⇒ خارج الـcache المشترك (لا يُدمَج داخل m.morningBrief كي لا يُلوَّث
      // الكائن المُخزَّن مؤقّتاً بين مستخدمين مختلفين) — استعلامٌ خفيف مستقلّ لكل مستخدم.
      const myOpenTasks = await getMyOpenTasksCount(userId);
      const counts: MorningBriefCounts = { ...m.morningBrief, myOpenTasks };
      const total = counts.arRemindersDue + counts.promisedToday + counts.overdueWorkOrders + myOpenTasks + (counts.overdueTasks ?? 0);
      if (total === 0) {
        result.skippedEmpty++;
        continue;
      }
      const payload: MorningBriefPayload = {
        kind: "MORNING_BRIEF",
        title: "برنامج اليوم — الرؤية العربية",
        body: buildBody(counts, total),
        url: pickMorningBriefUrl(counts),
        counts,
      };
      const r = await sendPushToUser(userId, payload);
      result.sent += r.sent;
      result.goneRevoked += r.goneRevoked;
      result.failed += r.failed;
    } catch {
      // فشل مستخدم واحد لا يوقف البقيّة (idempotency log يمنع الازدواج الغد).
      result.failed++;
    }
  }
  return result;
}

let cronTask: ScheduledTask | null = null;

/** تشغيل الجدولة عند إقلاع الخادم. آمنة الاستدعاء مرّتين (تُوقف السابقة أولاً). */
export function startMorningPushCron(): void {
  // لا cron في بيئة الاختبار (يُسبّب تسريب مؤقّتات ⇒ vitest يعلق).
  if (process.env.NODE_ENV === "test") return;
  if (!isPushEnabled()) {
    console.info("[push] scheduler disabled (VAPID keys غير مُهيّأة).");
    return;
  }
  const cronExpr = process.env.MORNING_PUSH_CRON || "0 4 * * *"; // 04:00 UTC = 07:00 بغداد
  if (!cron.validate(cronExpr)) {
    console.error(`[push] MORNING_PUSH_CRON غير صالح: ${cronExpr}`);
    return;
  }
  if (cronTask) cronTask.stop();
  cronTask = cron.schedule(
    cronExpr,
    async () => {
      try {
        const r = await runMorningBriefPush();
        console.info(
          `[push] morning brief: candidates=${r.candidates} sent=${r.sent} skippedAlreadySent=${r.skippedAlreadySent} skippedEmpty=${r.skippedEmpty} goneRevoked=${r.goneRevoked} failed=${r.failed}`,
        );
      } catch (e) {
        console.error("[push] morning brief cron threw:", e);
      }
    },
    { timezone: "UTC" },
  );
  console.info(`[push] scheduler started (cron: ${cronExpr} UTC)`);
}

/** للاختبار فقط — يوقف الجدولة النشطة (نظافة). */
export function stopMorningPushCron(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
