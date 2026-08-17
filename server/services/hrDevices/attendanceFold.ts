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
 *   - **شهرٌ مسيّرُه معتمد لا يبتلع بصمةً بصمت (تدقيق ١٧/٨):** `recordAttendance` يرفض الكتابة
 *     على شهرٍ مقفل. كان الرفض يُصنَّف «عابراً» فتبقى البصمة `processedAt=NULL` بلا أيّ وسم —
 *     «بالانتظار» أبداً في شاشة الأجهزة (= أجرُ يومٍ يضيع صامتاً، ونقضُ §٥ من CLAUDE.md) —
 *     مع إعادة محاولةٍ كل ١٥ ثانية بلا نهاية تُعيد مسح الدفعة كاملةً وتُجوّع البصمات الجديدة
 *     عند سقف الدفعة. صار: **وسمٌ نهائيّ بملاحظةٍ تشرح**، و**استئنافٌ تلقائيّ** لحظةَ إلغاء
 *     اعتماد المسيّر (وإلّا كان الوسم وعداً كاذباً: لا مسار إعادة طيٍّ في المستودع كلّه)،
 *     و**تراجعٌ أُسّيّ** بدل الـ١٥ ثانية الثابتة.
 * ========================================================================== */
import { and, asc, eq, inArray, isNotNull, isNull, like, ne, or, sql } from "drizzle-orm";
import {
  attendance,
  branches,
  employees,
  hrAttendancePunches,
  hrAttendanceSettings,
  hrFingerprintDevices,
  payrollRuns,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { logger } from "../../logger";
import { recordAttendance } from "../attendanceService";
import { computeDayHours, DEFAULT_MAX_DAILY_HOURS, DEFAULT_NIGHT_CUTOFF_HOUR, type NightShiftOptions } from "./dayHours";
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

/** اليوم التالي لـ"YYYY-MM-DD" بتقويم UTC ثابت (توقيت حائط لا لحظة عالمية). */
function nextYmd(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
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
async function loadFoldSettings(): Promise<{ maxDailyHours: number; night: NightShiftOptions }> {
  try {
    const [row] = await requireDb().select().from(hrAttendanceSettings).where(eq(hrAttendanceSettings.id, 1)).limit(1);
    return {
      maxDailyHours: Number(row?.maxDailyHours ?? DEFAULT_MAX_DAILY_HOURS),
      night: {
        enabled: !!row?.nightShiftEnabled,
        cutoffHour: Number(row?.nightShiftCutoffHour ?? DEFAULT_NIGHT_CUTOFF_HOUR),
      },
    };
  } catch {
    return { maxDailyHours: DEFAULT_MAX_DAILY_HOURS, night: { enabled: false, cutoffHour: DEFAULT_NIGHT_CUTOFF_HOUR } };
  }
}

type FoldResult = { days: number; parked: number };

let activeFoldRun: Promise<FoldResult> | null = null;
let foldRequestsAccepting = true;
let rerunRequested = false;
let retryTimer: NodeJS.Timeout | null = null;

/* ============================ تصنيف أخطاء الطيّ ============================
 * **رمزٌ لا نصّ.** `recordAttendance` يعيش في `attendanceService.ts` ورسائلُه عربية قابلة
 * لإعادة الصياغة في أيّ لحظة؛ ومَن يطابق النصّ يخسر التصنيف **صامتاً** عند أوّل تحرير
 * صياغة — وهو حرفياً ما وقع مع رسالة قفل المسيّر (لم تكن ضمن العلامات ⇒ عُوملت عابرةً).
 * فصار العقد: رمزٌ أوّلاً (`foldCode`/`code` على الخطأ نفسه — الطريق الصحيح حين ترمي الخدمة
 * أخطاءً مرقَّمة)، ثمّ نصٌّ احتياطيّ **يحرسه اختبار تكامل** يمرّ بالخدمة الحيّة فيُحمَّر عند
 * أيّ انجراف صياغة، ثمّ — لأخطر حالة — **سؤال الجدول نفسه** بلا اعتمادٍ على نصٍّ البتّة.
 * ========================================================================== */
export const FOLD_ERROR_CODES = {
  /** شهر البصمة مقفل بمسيّر رواتب معتمد/مدفوع ⇒ لا كتابة حتى يُلغى الاعتماد. */
  PAYROLL_PERIOD_LOCKED: "PAYROLL_PERIOD_LOCKED",
  EMPLOYEE_TERMINATED: "EMPLOYEE_TERMINATED",
  EMPLOYEE_NOT_FOUND: "EMPLOYEE_NOT_FOUND",
  /** ساعات/أوقات غير متّسقة — إعادة المحاولة تُنتج الرفض نفسه حتماً. */
  HOURS_INVALID: "HOURS_INVALID",
  /** غير مصنَّف ⇒ يُفترض عابراً (انقطاع قاعدة/قفل) فتُعاد المحاولة ولا يضيع يوم. */
  TRANSIENT: "TRANSIENT",
} as const;
export type FoldErrorCode = (typeof FOLD_ERROR_CODES)[keyof typeof FOLD_ERROR_CODES];

const TERMINAL_FOLD_CODES: ReadonlySet<string> = new Set([
  FOLD_ERROR_CODES.PAYROLL_PERIOD_LOCKED,
  FOLD_ERROR_CODES.EMPLOYEE_TERMINATED,
  FOLD_ERROR_CODES.EMPLOYEE_NOT_FOUND,
  FOLD_ERROR_CODES.HOURS_INVALID,
]);

/**
 * الجسر الاحتياطيّ نصّ⇒رمز إلى أن ترمي `attendanceService` رموزاً (تغييرٌ خارج ملكية هذا
 * الملف — مرفوعٌ للقائد). `منتهي الخدمة`/`غير موجود`/`سالبة` هي العلامات النهائية الثلاث
 * السابقة حرفياً ⇒ صفر انحدار في مجموعة «النهائيّ»، والباقي **إضافةٌ** كانت تدور عبثاً.
 */
const TERMINAL_MESSAGE_RULES: ReadonlyArray<{ code: FoldErrorCode; pattern: RegExp }> = [
  { code: FOLD_ERROR_CODES.PAYROLL_PERIOD_LOCKED, pattern: /مسيّر رواتب شهر/ },
  { code: FOLD_ERROR_CODES.EMPLOYEE_TERMINATED, pattern: /منتهي الخدمة/ },
  { code: FOLD_ERROR_CODES.EMPLOYEE_NOT_FOUND, pattern: /غير موجود/ },
  // رسائل `shared/attendanceHours.ts` + حارس الساعات السالبة: كلّها رفضُ شكلٍ لا عطلَ نقل.
  { code: FOLD_ERROR_CODES.HOURS_INVALID, pattern: /سالبة|قيمةٌ غير صالحة|تتجاوز المدى|بعد وقت الدخول|لا تصحّ ساعاته صفراً/ },
];

/** رمز الخطأ كما تصنّفه هذه الوحدة. `TRANSIENT` = أعِد المحاولة، وما عداه = وَسْمٌ نهائيّ. */
export function classifyFoldError(error: unknown): FoldErrorCode {
  const declared = error as { foldCode?: unknown; code?: unknown } | null | undefined;
  for (const candidate of [declared?.foldCode, declared?.code]) {
    // نقبل الرمز المُعلَن فقط إن كان من مفرداتنا: أخطاء mysql2 تحمل code مثل ER_LOCK_DEADLOCK
    // وهي **عابرة** بطبيعتها — قبولُها رمزاً نهائياً كان سيَسِم يوماً حيّاً بالخطأ.
    if (typeof candidate === "string" && TERMINAL_FOLD_CODES.has(candidate)) return candidate as FoldErrorCode;
  }
  const msg = error instanceof Error ? error.message : "";
  for (const rule of TERMINAL_MESSAGE_RULES) if (rule.pattern.test(msg)) return rule.code;
  return FOLD_ERROR_CODES.TRANSIENT;
}

/**
 * ⛔ **نصٌّ ثابت لا يُعاد صوغه:** صفوفُ الإنتاج المركونة تحمله، والاستئناف التلقائيّ يتعرّف
 * عليها **به وحده** (لا عمود سبب في المخطّط). تغييرُه يُيتّم المركون القديم فلا يُستأنف أبداً.
 */
const PAYROLL_LOCK_NOTE_PREFIX = "شهر مقفل بمسيّر رواتب معتمد";
function payrollLockNote(period: string): string {
  return `${PAYROLL_LOCK_NOTE_PREFIX} (${period}) — أعد الطيّ بعد إلغاء اعتماد المسيّر (يُستأنف تلقائياً)`;
}

/*
 * تراجعٌ أُسّيّ بدل ١٥ ثانية ثابتة أبداً: عطلٌ عابر مستمرّ كان يُشغّل ٥٧٦٠ دورةً يومياً، وكلّ
 * دورةٍ تمسح الدفعة كاملةً (٥٠٠٠ صفّ) — عبءُ قاعدةٍ بلا فائدة. البداية تبقى ١٥ ثانية (استجابةٌ
 * فورية للعطل القصير) والسقف ١٠ دقائق: لا نتخلّى عن يومٍ أبداً، ولا نُغرق القاعدة.
 */
const FOLD_RETRY_BASE_MS = 15_000;
const FOLD_RETRY_MAX_MS = 600_000;
let foldRetryStreak = 0;

function foldRetryDelayMs(): number {
  // 15س → 30 → 60 → 120 → 240 → 480 → 600 (سقف). القصّ يمنع تجاوز حدود العدد عند طول العطل.
  return Math.min(FOLD_RETRY_BASE_MS * 2 ** Math.min(foldRetryStreak, 10), FOLD_RETRY_MAX_MS);
}

function scheduleFoldRetry(): void {
  if (!foldRequestsAccepting || retryTimer) return;
  const delayMs = foldRetryDelayMs();
  foldRetryStreak += 1;
  if (delayMs >= FOLD_RETRY_MAX_MS) {
    // بلوغ السقف = عطلٌ مستمرّ لا ينحلّ بالانتظار ⇒ يلزم عينُ مشغّل، فلا يمرّ صامتاً.
    logger.warn({ delayMs, attempts: foldRetryStreak }, "hrDevices: تراجع الطيّ بلغ سقفه — عطلٌ عابر مستمرّ");
  }
  retryTimer = setTimeout(() => {
    retryTimer = null;
    foldSoon();
  }, delayMs);
  retryTimer.unref();
}

function safeFoldErrorCode(error: unknown): string {
  // رمز السائق (mysql2 يضع ER_*/ECONN* في `code`) أدقّ تشخيصاً من `name` الذي هو "Error" دوماً.
  const raw = (error as { code?: unknown } | null | undefined)?.code;
  const value = typeof raw === "string" && raw ? raw : error instanceof Error ? error.name : "FOLD_FAILED";
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 48) || "FOLD_FAILED";
}

/**
 * هل شهرُ البصمة مقفل بمسيّر معتمد/مدفوع؟ سؤالُ الجدول نفسه — لا نصّ ولا صياغة.
 * **يفشل نحو «غير مقفل»** عمداً: تعذُّرُ السؤال (انقطاع قاعدة) لا يجوز أن يَسِم يوماً نهائياً.
 */
async function isPayrollPeriodLocked(period: string): Promise<boolean> {
  try {
    const [row] = await requireDb()
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.period, period), inArray(payrollRuns.status, ["approved", "paid"])))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * البصمات المستحقّة للطيّ = المعلَّقة **زائد** المركونة لقفل مسيّرٍ زال عن شهرها.
 *
 * الاستئناف مدموجٌ في استعلام الالتقاط نفسه عمداً (لا كنسٌ دوريّ ولا مؤقّت): وسمُ القفل
 * مشروطٌ بحالةٍ **تتغيّر** (إلغاء الاعتماد)، فمن وسم بلا إعادة تقييمٍ للشرط حوّل «عالقٌ
 * ظاهرٌ» إلى «مفقودٌ نهائياً» — ولا مسار إعادة طيٍّ يدويّ في المستودع أصلاً. وبمجرّد نجاح
 * الطيّ يُصفَّر processNote فيخرج الصفّ من هذا الشرط ⇒ لا دوران.
 *
 * التكلفة: فرعُ الاستئناف يقرأ processNote وهو **NULL في كل صفٍّ طُوي بنجاح**، فالمقارنة
 * تسقط فوراً ولا يصل الاستعلام الفرعيّ إلا لصفوفٍ مركونةٍ نادرة.
 */
function duePunchesCondition() {
  return and(
    isNotNull(hrAttendancePunches.employeeId),
    or(
      isNull(hrAttendancePunches.processedAt),
      and(
        like(hrAttendancePunches.processNote, `${PAYROLL_LOCK_NOTE_PREFIX}%`),
        sql`NOT EXISTS (SELECT 1 FROM ${payrollRuns} WHERE ${payrollRuns.period} = DATE_FORMAT(${hrAttendancePunches.punchAt}, '%Y-%m') AND ${payrollRuns.status} IN ('approved','paid'))`,
      ),
    ),
  );
}

/** طيّ دفعة واحدة (≤٥٠٠٠ بصمة معلَّقة مربوطة). يُعيد days/parked/processedAny للتحكّم بالحلقة. */
async function foldOneBatch(): Promise<{ days: number; parked: number; transient: number; processedAny: boolean }> {
  const db = requireDb();
  const pending = await db
    .select({
      id: hrAttendancePunches.id,
      employeeId: hrAttendancePunches.employeeId,
      punchAt: hrAttendancePunches.punchAt,
    })
    .from(hrAttendancePunches)
    .where(duePunchesCondition())
    .orderBy(asc(hrAttendancePunches.punchAt))
    .limit(5000);
  if (pending.length === 0) return { days: 0, parked: 0, transient: 0, processedAny: false };
  const { maxDailyHours, night } = await loadFoldSettings();

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
  let transient = 0;
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
      /*
       * جوارُ اليوم حين تُفعَّل الوردية الليلية: بصماتُ فجر الغد هي التي تُغلق وردية اليوم.
       * الإسناد يُشتقّ من الجيران لا من حالةٍ مخزَّنة ⇒ إعادةُ الطيّ تعطي النتيجة نفسها.
       */
      const nextPunches = night.enabled ? await punchTimesOf(g.employeeId, nextYmd(g.date)) : [];
      const day = computeDayHours(times, maxDailyHours, schedHours, { ...night, nextDayPunches: nextPunches });
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
        // وردية عبرت منتصف الليل ⇒ الانصراف على تاريخ الغد لا على تاريخ الوردية.
        checkOutDate: day.checkOutNextDay ? nextYmd(g.date) : undefined,
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
      const rawNote = e instanceof Error ? e.message.slice(0, 200) : "تعذر الطي";
      let code = classifyFoldError(e);
      /*
       * شبكةُ أمانٍ **بنيويّة لا نصّية** لأخطر حالة: صياغة رسالة قفل المسيّر تعيش في
       * `attendanceService.ts` (ليس ملكية هذه الوحدة)، وأيّ تحرير صياغةٍ هناك كان يُعيد
       * العطب صامتاً — بصمةٌ «بالانتظار» أبداً + إعادة محاولة كل ١٥ ثانية. فنسأل جدول
       * المسيّرات مباشرةً. تُغطّي أيضاً السباق: مسيّرٌ اعتُمد بين الحساب والكتابة.
       */
      if (code === FOLD_ERROR_CODES.TRANSIENT && (await isPayrollPeriodLocked(g.date.slice(0, 7)))) {
        code = FOLD_ERROR_CODES.PAYROLL_PERIOD_LOCKED;
      }
      if (code !== FOLD_ERROR_CODES.TRANSIENT) {
        // نهائيّ: يوسَم بملاحظةٍ يقرؤها المدير في شاشة الأجهزة («مركونة» + سببها) فلا يضيع
        // يومٌ صامتاً ولا تدور الدفعة عبثاً. وملاحظةُ القفل بصيغتها الثابتة هي **مفتاح
        // الاستئناف** لحظة إلغاء الاعتماد (راجع duePunchesCondition).
        const note = code === FOLD_ERROR_CODES.PAYROLL_PERIOD_LOCKED ? payrollLockNote(g.date.slice(0, 7)) : rawNote;
        await db
          .update(hrAttendancePunches)
          .set({ processedAt: sql`CURRENT_TIMESTAMP`, processNote: note })
          .where(inArray(hrAttendancePunches.id, g.ids));
        parked++;
        logger.warn(
          { code, errorCode: safeFoldErrorCode(e) },
          "hrDevices: بصمات مركونة نهائياً",
        );
      } else {
        // عابر (قفل/اتصال DB): لا يوسَم — تُعاد المحاولة في الدورة التالية فلا يضيع يوم.
        transient++;
        logger.error(
          { code, errorCode: safeFoldErrorCode(e) },
          "hrDevices: خطأ عابر في الطيّ — سيُعاد",
        );
        scheduleFoldRetry();
      }
    }
  }
  return { days, parked, transient, processedAny: true };
}

/**
 * معالجة كل المعلَّق حتى الاستنزاف. متسلسلة عبر `activeFoldRun`، ونداء أثناء الجريان
 * يرفع `rerunRequested` فيُعاد تشغيلها بعد الفراغ — لا يُسقط أيّ طلب طيّ.
 */
async function runPendingFolds(): Promise<FoldResult> {
  let days = 0;
  let parked = 0;
  // دورةٌ بلا خطأ عابر واحد = القاعدة سليمة ⇒ يُصفَّر التراجع الأُسّيّ فيعود العطلُ التالي
  // إلى استجابة الـ١٥ ثانية. بدون التصفير كان أوّل عطلٍ يُبقي كل الأعطال اللاحقة على السقف.
  let transient = 0;
  do {
    rerunRequested = false;
    let reachedBatchCap = true;
    // استنزاف: كرّر ما دام هناك معلَّق (سقف أمان ضد حلقة لا تنتهي بخطأ عابر متكرّر).
    for (let guard = 0; guard < 1000; guard++) {
      const r = await foldOneBatch();
      days += r.days;
      parked += r.parked;
      transient += r.transient;
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
      if (transient === 0) foldRetryStreak = 0;
      return { days, parked };
    }
  } while (foldRequestsAccepting && rerunRequested);
  if (transient === 0) foldRetryStreak = 0;
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
  foldRetryStreak = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  while (activeFoldRun) {
    const run = activeFoldRun;
    await run.catch(() => undefined);
  }
}
