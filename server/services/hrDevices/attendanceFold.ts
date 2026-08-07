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
 *     والحلقة تستنزف كل المعلَّق دفعةً بعد دفعة (لا سقف يترك بقيةً غير مطويّة).
 * ========================================================================== */
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { attendance, employees, hrAttendancePunches, hrAttendanceSettings } from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { logger } from "../../logger";
import { recordAttendance } from "../attendanceService";
import { computeDayHours, DEFAULT_MAX_DAILY_HOURS } from "./dayHours";
import { DEFAULT_WORK_SCHEDULE, hoursForDay } from "../hr/attendancePay";
import { createAppNotification } from "../appNotificationService";

function baghdadDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** إزاحة تاريخ نصّي بأيام (UTC نقيّ — لا انزياح منطقة زمنية). */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

/** إعدادات الاحتساب (صفّ مفرد) — الغياب = الافتراضي المعطَّل، فلا تفشل الوحدة قبل الهجرة/البذر. */
async function loadFoldSettings(): Promise<{ maxDailyHours: number }> {
  try {
    const [row] = await requireDb().select().from(hrAttendanceSettings).where(eq(hrAttendanceSettings.id, 1)).limit(1);
    return { maxDailyHours: Number(row?.maxDailyHours ?? DEFAULT_MAX_DAILY_HOURS) };
  } catch {
    return { maxDailyHours: DEFAULT_MAX_DAILY_HOURS };
  }
}

let folding = false;
let rerunRequested = false;

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

    const [existingAttendance] = await db
      .select({ id: attendance.id, checkIn: attendance.checkIn, checkOut: attendance.checkOut })
      .from(attendance)
      .where(and(eq(attendance.employeeId, g.employeeId), eq(attendance.attendanceDate, g.date), eq(attendance.source, "fingerprint")))
      .limit(1);

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
      await recordAttendance({
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
      await db
        .update(hrAttendancePunches)
        .set({ processedAt: sql`CURRENT_TIMESTAMP`, processNote: null })
        .where(inArray(hrAttendancePunches.id, g.ids));
      if (g.date === baghdadDate() && empRow?.userId) {
        const events = [
          !existingAttendance?.checkIn && day.checkIn
            ? { event: "ATTENDANCE_CHECK_IN" as const, title: "تم تسجيل الدخول", body: "تمت مزامنة بصمة دخولك من جهاز الشركة." }
            : null,
          !existingAttendance?.checkOut && day.checkOut
            ? { event: "ATTENDANCE_CHECK_OUT" as const, title: "تم تسجيل الخروج", body: "تمت مزامنة بصمة خروجك من جهاز الشركة." }
            : null,
        ].filter((event): event is NonNullable<typeof event> => event !== null);
        for (const event of events) {
          try {
            await createAppNotification({
              userId: empRow.userId,
              kind: "ATTENDANCE",
              title: event.title,
              body: event.body,
              route: "/mobile#attendance",
              eventKey: `attendance:${g.employeeId}:${g.date}:${event.event}`,
              entityType: "attendance",
              entityId: existingAttendance?.id ?? null,
              requiresAction: Boolean(day.needsReview),
              push: true,
            });
          } catch (error) {
            logger.warn({ err: error, employeeId: g.employeeId, date: g.date, kind: event.event }, "hrDevices: تعذر حفظ إشعار مزامنة الدوام");
          }
        }
      }
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
        logger.warn({ employeeId: g.employeeId, date: g.date, note }, "hrDevices: بصمات مركونة نهائياً");
      } else {
        // عابر (قفل/اتصال DB): لا يوسَم — تُعاد المحاولة في الدورة التالية فلا يضيع يوم.
        logger.error({ employeeId: g.employeeId, date: g.date, note }, "hrDevices: خطأ عابر في الطيّ — سيُعاد");
      }
    }
  }
  return { days, parked, processedAny: true };
}

/**
 * معالجة كل المعلَّق حتى الاستنزاف. متسلسلة عبر علم `folding` (قفل منطقي)، ونداء أثناء الجريان
 * يرفع `rerunRequested` فيُعاد تشغيلها بعد الفراغ — لا يُسقط أيّ طلب طيّ.
 */
export async function processPendingFolds(): Promise<{ days: number; parked: number }> {
  if (folding) {
    rerunRequested = true;
    return { days: 0, parked: 0 };
  }
  folding = true;
  let days = 0;
  let parked = 0;
  try {
    do {
      rerunRequested = false;
      // استنزاف: كرّر ما دام هناك معلَّق (سقف أمان ضد حلقة لا تنتهي بخطأ عابر متكرّر).
      for (let guard = 0; guard < 1000; guard++) {
        const r = await foldOneBatch();
        days += r.days;
        parked += r.parked;
        // توقّف حين لا يوجد معلَّق أصلاً، أو حين لم يتقدّم شيء (كل المتبقّي عابر الخطأ) لتفادي الدوران.
        if (!r.processedAny || r.days + r.parked === 0) break;
      }
    } while (rerunRequested);
  } finally {
    folding = false;
  }
  return { days, parked };
}

/** تشغيل الطيّ في الخلفية بأمان (بعد كل دفعة استلام) — الفشل يُسجَّل ولا يُسقط المقبس. */
export function foldSoon(): void {
  void processPendingFolds().catch((e) => logger.error({ err: e }, "hrDevices: فشل الطيّ الخلفي"));
}
