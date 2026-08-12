/* ============================================================================
 * طيّ البصمات الخام إلى سجل الحضور (server/services/hrDevices/attendanceFold.ts)
 * لكل (موظف × يوم): أول بصمة = دخول وآخرها = خروج، الساعات = الفارق، والكتابة عبر
 * recordAttendance القائمة (UPSERT على uq_att_employee_date بمصدر fingerprint) ⇒
 * سعر الساعة/الأجر/حراس منتهي الخدمة كلها من مسار واحد — لا منطق مالي مكرر هنا.
 * وصول بصمة متأخرة لنفس اليوم يعيد حساب اليوم كاملاً (لا يفسده).
 *
 * ضمانات حاسمة (فحصها تدقيق عدائي):
 *   - **لا يطمس تصحيحاً يدوياً:** يومٌ له سجل حضور بمصدر غير fingerprint (تصحيح مدير/إجازة)
 *     تُركن بصماته موسومةً ولا يُكتب فوقه — الجهاز يتبع للمدير لا العكس.
 *   - **الخطأ العابر لا يُفقِد يوماً:** فشل DB مؤقّت لا يوسم البصمة معالَجة (تُعاد المحاولة)؛
 *     فقط الأخطاء النهائية (منتهي خدمة/غير موجود) توسَم لتُستبعد نهائياً.
 *   - **لا تسقط طلبات الطيّ:** نداءٌ أثناء طيٍّ جارٍ يرفع علم إعادة تشغيل فيُعاد بعد الفراغ،
 *     وبلوغ سقف الدفعات يسلّم البقية إلى دورة متابعة منسّقة بدلاً من تركها معلّقة.
 * ========================================================================== */
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  attendance,
  branches,
  employees,
  hrAttendancePunches,
  hrAttendanceSettings,
  hrFingerprintDevices,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { logger } from "../../logger";
import { recordAttendance } from "../attendanceService";
import { computeDayHours, DEFAULT_MAX_DAILY_HOURS } from "./dayHours";
import { DEFAULT_WORK_SCHEDULE, hoursForDay } from "../hr/attendancePay";
import { createAppNotification } from "../appNotificationService";
import {
  buildAttendanceNotification,
  type AttendanceMovement,
} from "./attendanceNotification";

function baghdadDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** بصمات (موظف × يوم) مرتّبة — مصدر واحد يستعمله اليوم وجاراه في الوردية الليلية. */
async function punchTimesOf(employeeId: number, date: string): Promise<string[]> {
  const rows = await requireDb()
    .select({ punchAt: hrAttendancePunches.punchAt })
    .from(hrAttendancePunches)
    .where(and(eq(hrAttendancePunches.employeeId, employeeId), sql`${hrAttendancePunches.punchAt} LIKE ${date + "%"}`))
    .orderBy(asc(hrAttendancePunches.punchAt));
  return rows.map((r) => String(r.punchAt));
}

async function punchWorkplaceOf(
  employeeId: number,
  date: string,
  clock: string,
): Promise<{ branchName: string | null; deviceName: string | null }> {
  const [row] = await requireDb()
    .select({
      branchName: branches.name,
      deviceName: hrFingerprintDevices.name,
      deviceLocation: hrFingerprintDevices.location,
    })
    .from(hrAttendancePunches)
    .leftJoin(
      hrFingerprintDevices,
      eq(hrAttendancePunches.deviceId, hrFingerprintDevices.id),
    )
    .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
    .where(
      and(
        eq(hrAttendancePunches.employeeId, employeeId),
        sql`${hrAttendancePunches.punchAt} LIKE ${`${date} ${clock}%`}`,
      ),
    )
    .orderBy(asc(hrAttendancePunches.id))
    .limit(1);
  return {
    branchName: row?.branchName ?? row?.deviceLocation ?? null,
    deviceName: row?.deviceName ?? null,
  };
}

function includeAttendanceWorkplace(): boolean {
  return process.env.ATTENDANCE_PUSH_INCLUDE_WORKPLACE === "true";
}

/** إعدادات الاحتساب (صفّ مفرد) — الغياب = الافتراضي المعطَّل، فلا تفشل الوحدة قبل الهجرة/البذر. */
async function loadFoldSettings(): Promise<{ maxDailyHours: number }> {
  try {
    const [row] = await requireDb().select().from(hrAttendanceSettings).where(eq(hrAttendanceSettings.id, 1)).limit(1);
    return { maxDailyHours: Number(row?.maxDailyHours ?? DEFAULT_MAX_DAILY_HOURS) };
  } catch {
    return { maxDailyHours: DEFAULT_MAX_DAILY_HOURS };
  }
}

type FoldResult = { days: number; parked: number };

let activeFoldRun: Promise<FoldResult> | null = null;
let foldRequestsAccepting = true;
let rerunRequested = false;
let retryTimer: NodeJS.Timeout | null = null;

function safeFoldErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.name : "FOLD_FAILED";
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 48) || "FOLD_FAILED";
}

function scheduleFoldRetry(): void {
  if (!foldRequestsAccepting || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    foldSoon();
  }, 15_000);
  retryTimer.unref();
}

/** علامات أخطاء recordAttendance النهائية (يوسَم بها المعالَج نهائياً) — أيّ خطأ آخر عابر يُعاد. */
function isTerminalFoldError(msg: string): boolean {
  return msg.includes("منتهي الخدمة") || msg.includes("غير موجود") || msg.includes("سالبة");
}

/** طيّ دفعة واحدة (≤٥٠٠٠ بصمة معلَّقة مربوطة). يُعيد days/parked/processedAny للتحكّم بالحلقة. */
async function foldOneBatch(): Promise<{ days: number; parked: number; processedAny: boolean }> {
  const db = requireDb();
  const pending = await db
    .select({
      id: hrAttendancePunches.id,
      employeeId: hrAttendancePunches.employeeId,
      punchAt: hrAttendancePunches.punchAt,
    })
    .from(hrAttendancePunches)
    .where(and(isNull(hrAttendancePunches.processedAt), isNotNull(hrAttendancePunches.employeeId)))
    .orderBy(asc(hrAttendancePunches.punchAt))
    .limit(5000);
  if (pending.length === 0) return { days: 0, parked: 0, processedAny: false };
  const { maxDailyHours } = await loadFoldSettings();

  // تجميع (موظف × يوم) — punchAt نص "YYYY-MM-DD HH:MM:SS" فاليوم = أول ١٠ خانات.
  const groups = new Map<string, { employeeId: number; date: string; ids: number[] }>();
  for (const p of pending) {
    const date = String(p.punchAt).slice(0, 10);
    const key = `${p.employeeId}|${date}`;
    const g = groups.get(key) ?? { employeeId: Number(p.employeeId), date, ids: [] };
    g.ids.push(p.id);
    groups.set(key, g);
  }

  let days = 0;
  let parked = 0;
  for (const g of Array.from(groups.values())) {
    // حارس التصحيح اليدوي: لا نطمس يوماً كتبه المدير (تصحيح/إجازة). نوسمه معالَجاً كي لا يعيد المحاولة.
    const [manual] = await db
      .select({ id: attendance.id })
      .from(attendance)
      .where(
        and(
          eq(attendance.employeeId, g.employeeId),
          eq(attendance.attendanceDate, g.date),
          ne(attendance.source, "fingerprint")
        )
      )
      .limit(1);
    if (manual) {
      await db
        .update(hrAttendancePunches)
        .set({ processedAt: sql`CURRENT_TIMESTAMP`, processNote: "يوجد إدخال يدوي لليوم — لم يُكتب فوقه" })
        .where(inArray(hrAttendancePunches.id, g.ids));
      parked++;
      continue;
    }

    // كل بصمات اليوم (معالجة وغير معالجة) — إعادة حساب اليوم كاملاً عند كل وصول جديد.
    // ومعها يوما الجوار حين تُفعَّل الوردية الليلية: الإسناد حتميّ يُستنتَج من الجيران
    // لا من حالةٍ مخزَّنة، فيعطي النتيجة نفسها مهما تكرّر الطيّ.
    const times = await punchTimesOf(g.employeeId, g.date);
    // ساعات ذلك اليوم في جدول الموظف — بدونها كان حارس «أقلّ من نصف المقرَّر» ميتاً
      // في الإنتاج ولا يُختبَر إلا في الوحدات (Codex P2).
      const [empRow] = await db
        .select({ userId: employees.userId, workSchedule: employees.workSchedule })
        .from(employees)
        .where(eq(employees.id, g.employeeId))
        .limit(1);
      const sched = (empRow?.workSchedule && typeof empRow.workSchedule === "object"
        ? empRow.workSchedule
        : DEFAULT_WORK_SCHEDULE) as Record<string, { hours?: number } | number>;
      const schedHours = hoursForDay(sched as never, g.date).toNumber();
      const day = computeDayHours(times, maxDailyHours, schedHours);
    if (day.usedCount === 0) {
      // كل بصمات اليوم مملوكة لوردية أمس ⇒ لا يوم هنا. توسَم معالَجةً كي لا تدور أبداً.
      await db
        .update(hrAttendancePunches)
        .set({ processedAt: sql`CURRENT_TIMESTAMP`, processNote: "أُسندت لوردية اليوم السابق" })
        .where(inArray(hrAttendancePunches.id, g.ids));
      parked++;
      continue;
    }
    try {
      const savedAttendance = await recordAttendance({
        employeeId: g.employeeId,
        attendanceDate: g.date,
        hours: day.hours,
        checkIn: day.checkIn,
        checkOut: day.checkOut,
        status: "PRESENT",
        source: "fingerprint",
        notes: null,
        needsReview: day.needsReview,
        reviewReason: day.reviewReason,
      });

      // لا نوسم البصمات الخام معالَجة قبل أن يُحفظ إشعار الموظف وصندوق FCM. إذا تعذّر
      // الحفظ يبقى الصف معلّقاً؛ وإعادة الطيّ آمنة لأن recordAttendance وeventKey كلاهما
      // idempotent. هذه هي وصلة الاعتمادية بين ingest الجهاز وشاشة القفل.
      if (g.date === baghdadDate() && empRow?.userId) {
        const events: Array<{ movement: AttendanceMovement; clock: string }> = [];
        if (day.checkIn) {
          events.push({ movement: "ATTENDANCE_CHECK_IN", clock: day.checkIn });
        }
        if (day.checkOut) {
          events.push({ movement: "ATTENDANCE_CHECK_OUT", clock: day.checkOut });
        }
        for (const event of events) {
          const workplace = await punchWorkplaceOf(
            g.employeeId,
            g.date,
            event.clock,
          );
          const notification = buildAttendanceNotification({
            employeeId: g.employeeId,
            attendanceDate: g.date,
            movement: event.movement,
            clock: event.clock,
            // تسجيل الدخول ناجح بذاته؛ نقص الخروج في منتصف اليوم ليس خطأً للمستخدم.
            needsReview:
              event.movement === "ATTENDANCE_CHECK_OUT" && day.needsReview,
            ...workplace,
            includeWorkplace: includeAttendanceWorkplace(),
          });
          await createAppNotification({
            userId: empRow.userId,
            kind: "ATTENDANCE",
            title: notification.title,
            body: notification.body,
            route: "/mobile#attendance",
            eventKey: notification.eventKey,
            entityType: "attendance",
            entityId: savedAttendance.id,
            requiresAction: notification.requiresAction,
            lockScreenSafe: true,
            push: true,
          });
        }
      }
      await db
        .update(hrAttendancePunches)
        .set({ processedAt: sql`CURRENT_TIMESTAMP`, processNote: null })
        .where(inArray(hrAttendancePunches.id, g.ids));
      days++;
    } catch (e) {
      const note = e instanceof Error ? e.message.slice(0, 200) : "تعذر الطي";
      if (isTerminalFoldError(note)) {
        // نهائيّ (منتهي خدمة/غير موجود): يوسَم فلا يعيد المحاولة عبثاً.
        await db
          .update(hrAttendancePunches)
          .set({ processedAt: sql`CURRENT_TIMESTAMP`, processNote: note })
          .where(inArray(hrAttendancePunches.id, g.ids));
        parked++;
        logger.warn(
          { errorCode: safeFoldErrorCode(e) },
          "hrDevices: بصمات مركونة نهائياً",
        );
      } else {
        // عابر (قفل/اتصال DB): لا يوسَم — تُعاد المحاولة في الدورة التالية فلا يضيع يوم.
        logger.error(
          { errorCode: safeFoldErrorCode(e) },
          "hrDevices: خطأ عابر في الطيّ — سيُعاد",
        );
        scheduleFoldRetry();
      }
    }
  }
  return { days, parked, processedAny: true };
}

/**
 * معالجة كل المعلَّق حتى الاستنزاف. متسلسلة عبر `activeFoldRun`، ونداء أثناء الجريان
 * يرفع `rerunRequested` فيُعاد تشغيلها بعد الفراغ — لا يُسقط أيّ طلب طيّ.
 */
async function runPendingFolds(): Promise<FoldResult> {
  let days = 0;
  let parked = 0;
  do {
    rerunRequested = false;
    let reachedBatchCap = true;
    // استنزاف: كرّر ما دام هناك معلَّق (سقف أمان ضد حلقة لا تنتهي بخطأ عابر متكرّر).
    for (let guard = 0; guard < 1000; guard++) {
      const r = await foldOneBatch();
      days += r.days;
      parked += r.parked;
      // shutdown ينتظر الدفعة التي بدأت فقط؛ لا نحجز مهلة العامل باستنزاف backlog كامل.
      if (!foldRequestsAccepting) return { days, parked };
      // توقّف حين لا يوجد معلَّق أصلاً، أو حين لم يتقدّم شيء (كل المتبقّي عابر الخطأ) لتفادي الدوران.
      if (!r.processedAny || r.days + r.parked === 0) {
        reachedBatchCap = false;
        break;
      }
    }
    if (reachedBatchCap && foldRequestsAccepting) {
      // حرّر الدورة الحالية كي تمنح event loop فرصة للإشارة/الإغلاق، ثم دع finally
      // يبدأ continuation مملوكة بالمنسّق. بذلك لا يترك سقف الحماية backlog بلا trigger.
      rerunRequested = true;
      return { days, parked };
    }
  } while (foldRequestsAccepting && rerunRequested);
  return { days, parked };
}

export function processPendingFolds(): Promise<FoldResult> {
  if (!foldRequestsAccepting) return Promise.resolve({ days: 0, parked: 0 });
  if (activeFoldRun) {
    rerunRequested = true;
    return Promise.resolve({ days: 0, parked: 0 });
  }

  // طلب صريح جديد يتقدّم على retry مؤجل سابق؛ لا نترك مؤقتاً قديماً يشغّل دورة زائدة.
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  let run!: Promise<FoldResult>;
  run = (async (): Promise<FoldResult> => {
    try {
      return await runPendingFolds();
    } catch (error) {
      // يشمل requireDb وأول SELECT وتجميع اليوم، لا الأخطاء داخل recordAttendance فقط.
      // الفشل العابر عند startup لا يعتمد بعد الآن على وصول بصمة لاحقة كي يُعاد.
      scheduleFoldRetry();
      throw error;
    } finally {
      if (activeFoldRun === run) {
        // لا await بين تحرير الملكية وفحص الطلب المعلّق: إمّا أن الطلب وصل قبل هذه
        // القطعة فيُعاد تشغيله هنا، أو يصل بعدها فيرى activeFoldRun=null ويبدأ بنفسه.
        activeFoldRun = null;
        if (foldRequestsAccepting && rerunRequested && !retryTimer) {
          rerunRequested = false;
          void processPendingFolds().catch((error) =>
            logger.error(
              { err: error },
              "hrDevices: فشل إعادة تشغيل الطيّ بعد طلب متزامن",
            ),
          );
        }
      }
    }
  })();
  activeFoldRun = run;
  return run;
}

/** تشغيل الطيّ في الخلفية بأمان (بعد كل دفعة استلام) — الفشل يُسجَّل ولا يُسقط المقبس. */
export function foldSoon(): void {
  if (!foldRequestsAccepting) return;
  void processPendingFolds().catch((e) => logger.error({ err: e }, "hrDevices: فشل الطيّ الخلفي"));
}

/** يمنع طلبات/retries جديدة وينتظر الطي الجاري قبل إغلاق DB. */
export async function stopAndDrainAttendanceFolds(): Promise<void> {
  foldRequestsAccepting = false;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  while (activeFoldRun) {
    const run = activeFoldRun;
    await run.catch(() => undefined);
  }
}
