// جدولة إشعار «برنامج اليوم» الصباحي — cron يومي ينشئ إشعاراً دائماً لكل مدير/مالك فعّال.
//
// القرارات:
//   • التوقيت: افتراضياً `0 4 * * *` UTC = 07:00 بغداد (افتتاح المتجر). قابل للتخصيص بـMORNING_PUSH_CRON.
//   • الجمهور: admin + manager فقط (مطابق RBAC لوحة MorningBrief في Dashboard.tsx).
//   • النطاق: فرع الحساب؛ وللأدمن بلا فرع نستخدم أول فرع فعّال، مطابقاً لشاشة التنفيذ.
//   • idempotency: appNotifications.eventKey يومي لكل مستخدم ⇒ لا تكرار عند إعادة التشغيل/تعدد العمال.
//   • الحدّ الأدنى: إن كان total=0 لهذا المستخدم ⇒ نتخطّى (لا نُشتّت بلا سبب — يطابق سلوك MorningBrief).
//   • القنوات: صندوق التطبيق + Web Push المتين + FCM الأصلي؛ عدم وجود VAPID لا يلغي الصندوق الداخلي.
import cron, { type ScheduledTask } from "node-cron";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { branches, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { isBackgroundOperationActive, runAcrossActiveTenants } from "../tenancy/backgroundTenants";
import { getDashboardMetrics, getMyTaskBriefCounts } from "./reports/dashboard";
import { createAppNotification } from "./appNotificationService";
import { baghdadToday } from "./businessDay";

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
function buildBody(counts: MorningBriefCounts, total: number, myOverdueTasks = 0): string {
  const parts: string[] = [];
  if (counts.arRemindersDue > 0) {
    const promiseNote = counts.promisedToday > 0 ? ` (منها ${counts.promisedToday} موعود اليوم)` : "";
    parts.push(`${counts.arRemindersDue} تذكير${promiseNote}`);
  } else if (counts.promisedToday > 0) {
    parts.push(`${counts.promisedToday} موعود اليوم`);
  }
  if (counts.overdueWorkOrders > 0) parts.push(`${counts.overdueWorkOrders} أمر شغل متأخّر`);
  if (counts.myOpenTasks) {
    const overdueNote = myOverdueTasks > 0 ? ` (منها ${myOverdueTasks} متأخرة)` : "";
    parts.push(`${counts.myOpenTasks} مهمة مفتوحة${overdueNote}`);
  }
  const otherOverdueTasks = Math.max(0, (counts.overdueTasks ?? 0) - myOverdueTasks);
  if (otherOverdueTasks > 0) parts.push(`${otherOverdueTasks} مهمة متأخّرة أخرى`);
  return `${total} بند للمتابعة${parts.length > 0 ? ": " + parts.join("، ") : ""}`;
}

/** الرابط الأنسب للإشعار حسب ما هو مُستحقّ فعلاً (gap-audit ٥/٧ item 10) — كان مُثبَّتاً على
 *  /dashboard دائماً رغم أنّ محتوى الإشعار غالباً تذكير ذمم أو أمر شغل متأخّر تحديداً؛ الآن يوجّه
 *  المستخدم مباشرةً لشاشة العمل ذات الصلة بدل تحويلة إضافية عبر لوحة التحكم.
 *  الأولوية: تذكيرات AR/وعد اليوم (الأكثر إلحاحاً مالياً) > أوامر شغل متأخّرة > مهام (S2) > /dashboard. */
function pickMorningBriefUrl(counts: MorningBriefCounts, branchId: number): string {
  if (counts.arRemindersDue > 0 || counts.promisedToday > 0) return "/reports/ar-reminders";
  if (counts.overdueWorkOrders > 0) return `/work-orders?branch=${branchId}`;
  if (counts.overdueTasks && counts.myOpenTasks) return "/dashboard";
  if (counts.overdueTasks) return `/tasks?tab=list&branchId=${branchId}&overdue=1`;
  if (counts.myOpenTasks) return "/tasks?tab=mine";
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
  if (!isBackgroundOperationActive("morning_push")) {
    const runs = await runAcrossActiveTenants("morning_push", runMorningBriefPush);
    return runs.reduce<MorningPushRunResult>(
      (sum, run) => ({
        candidates: sum.candidates + run.candidates,
        sent: sum.sent + run.sent,
        skippedAlreadySent: sum.skippedAlreadySent + run.skippedAlreadySent,
        skippedEmpty: sum.skippedEmpty + run.skippedEmpty,
        goneRevoked: sum.goneRevoked + run.goneRevoked,
        failed: sum.failed + run.failed,
      }),
      { candidates: 0, sent: 0, skippedAlreadySent: 0, skippedEmpty: 0, goneRevoked: 0, failed: 0 },
    );
  }
  const result: MorningPushRunResult = {
    candidates: 0, sent: 0, skippedAlreadySent: 0, skippedEmpty: 0, goneRevoked: 0, failed: 0,
  };
  const db = getDb();
  if (!db) return result;

  // كل مدير/مالك فعّال مرشّح، حتى إن لم يسجّل Web Push: الإشعار الدائم يظهر داخل النظام،
  // ويدفعه صندوق Android الأصلي إن كان الجهاز مسجّلاً. قصر الجمهور على المشتركين كان يجعل
  // التنبيه الإداري يختفي تماماً من صندوق المدير نفسه.
  const candidates = await db
    .select({
      userId: users.id,
      role: users.role,
      branchId: users.branchId,
      isOwner: users.isOwner,
    })
    .from(users)
    .where(
      and(
        or(inArray(users.role, ["admin", "manager"]), eq(users.isOwner, true)),
        eq(users.isActive, true),
      ),
    );
  result.candidates = candidates.length;

  const needsDefaultBranch = candidates.some((candidate) =>
    (candidate.role === "admin" || candidate.isOwner) && candidate.branchId == null,
  );
  const defaultBranch = needsDefaultBranch
    ? (await db
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.isActive, true))
        .orderBy(asc(branches.id))
        .limit(1))[0]
    : undefined;

  // العدّادات مشتركة بين مستخدمي الفرع نفسه؛ التخزين حسب الفرع يمنع N+1 ويحافظ على نطاق التنفيذ.
  const metricsCache = new Map<number, Awaited<ReturnType<typeof getDashboardMetrics>>>();
  async function metricsFor(branchId: number) {
    let m = metricsCache.get(branchId);
    if (!m) {
      m = await getDashboardMetrics({ branchId });
      metricsCache.set(branchId, m);
    }
    return m;
  }

  const claimDay = baghdadToday();
  for (const { userId, role, branchId, isOwner } of candidates) {
    try {
      const actionBranchId = branchId ?? (role === "admin" || isOwner ? defaultBranch?.id : undefined);
      if (actionBranchId == null) {
        result.skippedEmpty++;
        continue;
      }
      const m = await metricsFor(actionBranchId);
      // myOpenTasks شخصيّ ⇒ خارج الـcache المشترك (لا يُدمَج داخل m.morningBrief كي لا يُلوَّث
      // الكائن المُخزَّن مؤقّتاً بين مستخدمين مختلفين) — استعلامٌ خفيف مستقلّ لكل مستخدم.
      const myTasks = await getMyTaskBriefCounts(userId, actionBranchId);
      const myOpenTasks = myTasks.open;
      const counts: MorningBriefCounts = { ...m.morningBrief, myOpenTasks };
      // promisedToday جزء من arRemindersDue، والمهام المتأخّرة المسندة للمستخدم تقاطع بين عدّادي المهام.
      const uniqueTasks = myOpenTasks + (counts.overdueTasks ?? 0) - myTasks.overdueInScope;
      const total = counts.arRemindersDue + counts.overdueWorkOrders + uniqueTasks;
      if (total === 0) {
        result.skippedEmpty++;
        continue;
      }
      const notification = await createAppNotification({
        userId,
        kind: "SYSTEM",
        family: "ADMIN",
        title: "برنامج اليوم — الرؤية العربية",
        body: buildBody(counts, total, myTasks.overdueInScope),
        route: pickMorningBriefUrl(counts, actionBranchId),
        eventKey: `morning-brief:${claimDay}:${userId}`,
        entityType: "morningBrief",
        requiresAction: true,
        // الحمولة أعداد تشغيلية فقط، بلا أسماء أو مبالغ؛ وافقنا على إظهارها كاملة خارج التطبيق.
        lockScreenSafe: true,
      });
      if (notification.created) result.sent++;
      else result.skippedAlreadySent++;
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
