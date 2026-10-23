/* ============================================================================
 * اتّساق ساعات اليوم مع وقتَي الدخول والانصراف — shared/attendanceHours.ts
 *
 * **نواة نقيّة بلا قاعدة بيانات** (على نمط `hrDevices/dayHours.ts`) و**مصدر حقيقةٍ واحد
 * يستهلكه الطرفان** (على نمط `shared/inboundPaymentPolicy.ts`): الخادم يُنفّذ، والواجهة
 * تُرشد بالنصّ نفسه — فلا ينجرف حارسٌ عن حارس ولا تختلف الرسالة عن سببها.
 *
 * العلّة المُعالَجة (تدقيق ١٧/٨): كانت الساعات والأوقات حقلين مستقلَّين بلا أيّ ربط، فيمرّ
 * يومٌ أوقاته صحيحة وساعاته صفر ⇒ أجرٌ صفر **ويُرفع عنه وسم المراجعة** فلا يعود أحدٌ ينتبه
 * له — أخطر من تركه بلا تصحيح. وكان الاتجاه المقابل مفتوحاً أيضاً: ساعاتٌ تفوق المدى بين
 * الوقتين هي أجرُ وقتٍ لم يقع.
 *
 * ⚠️ ما **لا** يفرضه هذا الحارس عمداً: أن تساوي الساعاتُ المدى. الطيّ التلقائي يُزاوج
 * البصمات ويجمع الفترات ⇒ ساعاتٌ **أقلّ** من المدى مشروعةٌ تماماً (الاستراحات مطروحة)،
 * وفرضُ المساواة يوقف ingest الأجهزة كلَّه.
 * ========================================================================== */

/**
 * تسامح المقارنة (ساعة). الأوقات تُخزَّن وتُعرَض بدقّة الدقيقة ("HH:MM") بينما الساعات
 * تُحسب من طوابع فيها ثوانٍ ⇒ فارقٌ بنيويّ أقصاه ٥٩ ثانية (≈0.017) + تقريب منزلتين.
 * ثلاث دقائق تستوعبه بلا أن تسمح بخطأ إدخالٍ حقيقيّ (ساعةٌ أو أكثر).
 */
export const HOURS_SPAN_TOLERANCE = 0.05;

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** دقائق "HH:MM" منذ منتصف الليل، أو null إن لم يكن وقتاً صالحاً. */
function minutesOf(time: string | null | undefined): number | null {
  if (typeof time !== "string") return null;
  const m = HHMM.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * المدى بالساعات بين وقتين (منزلتان)، أو null إن نقص أحدهما أو لم يكن
 * الانصراف بعد الدخول (إلا عند تفعيل crossMidnight لبصمات ما بعد منتصف الليل).
 */
export function spanHours(
  checkIn: string | null | undefined,
  checkOut: string | null | undefined,
  opts?: { crossMidnight?: boolean },
): number | null {
  const a = minutesOf(checkIn);
  const b = minutesOf(checkOut);
  if (a == null || b == null) return null;
  let diff = b - a;
  if (diff <= 0 && opts?.crossMidnight) {
    diff = 24 * 60 - a + b;
  }
  if (diff <= 0) return null;
  return Math.round((diff / 60) * 100) / 100;
}

export interface AttendanceHoursInput {
  checkIn: string | null | undefined;
  checkOut: string | null | undefined;
  /** الساعات المراد حفظها. */
  hours: number;
  /** PRESENT/LATE يولّدان أجراً؛ ABSENT/LEAVE لا ⇒ صفرُهما مقصودٌ لا فخّ. */
  isPaidStatus: boolean;
  /** هل الانصراف في اليوم التالي (عبور منتصف الليل)؟ */
  crossMidnight?: boolean;
  /** دقائق الاستراحة/الزمنية المطروحة في نمط الفترة الواحدة (إن وُجدت). */
  breakMinutes?: number | null;
  /** فترات الدوام المتعدّدة عند اختيار الدوام المجزّأ. */
  sessions?: AttendanceSessionInput[] | null;
}

/**
 * يُرجع نصّ المخالفة العربيّ، أو null إن كان المدخل متّسقاً.
 * بلا وقتين كاملين لا حكم: البصمة الفردية (دخولٌ بلا انصراف) حالةٌ مشروعة تُوسَم للمراجعة.
 */
export function attendanceHoursViolation(input: AttendanceHoursInput): string | null {
  if (input.isPaidStatus && input.sessions && input.sessions.length > 0) {
    const summary = computeSessionsSummary(input.sessions);
    if (summary.violation) return summary.violation;
    if (
      summary.sessions.length > 0 &&
      !summary.hasOpenSession &&
      Math.abs(input.hours - summary.totalHours) > HOURS_SPAN_TOLERANCE
    ) {
      return `الساعات (${input.hours.toFixed(2)}) لا تطابق مجموع فترات الدوام المسجَّلة (${summary.totalHoursStr} ساعة) — صحّح الفترات أو الساعات`;
    }
  }

  const hasBoth = minutesOf(input.checkIn) != null && minutesOf(input.checkOut) != null;
  if (!hasBoth) return null;

  const span = spanHours(input.checkIn, input.checkOut, { crossMidnight: Boolean(input.crossMidnight) });
  if (span == null) return "وقت الانصراف يجب أن يكون بعد وقت الدخول";

  if (!Number.isFinite(input.hours)) return "الساعات قيمةٌ غير صالحة";

  const brkMins =
    input.breakMinutes != null && Number.isFinite(Number(input.breakMinutes)) && Number(input.breakMinutes) > 0
      ? Math.round(Number(input.breakMinutes))
      : 0;
  if (brkMins > 0) {
    const brkHours = Math.round((brkMins / 60) * 100) / 100;
    if (input.isPaidStatus && brkHours >= span - HOURS_SPAN_TOLERANCE) {
      return `مدّة الاستراحة/الزمنية (${brkHours.toFixed(2)} س) تساوي أو تتجاوز المدى بين الدخول والانصراف (${span.toFixed(2)} س)`;
    }
    const maxNet = Math.max(0, Math.round((span - brkMins / 60) * 100) / 100);
    if (input.hours > maxNet + HOURS_SPAN_TOLERANCE) {
      return `الساعات (${input.hours.toFixed(2)}) تتجاوز الصافي بعد خصم الاستراحة (${maxNet.toFixed(2)} ساعة) — صحّح الأوقات أو الاستراحة أو الساعات`;
    }
  } else if (input.hours > span + HOURS_SPAN_TOLERANCE) {
    return `الساعات (${input.hours.toFixed(2)}) تتجاوز المدى بين الدخول والانصراف (${span.toFixed(2)} ساعة) — صحّح الأوقات أو الساعات`;
  }
  if (input.isPaidStatus && !(input.hours > 0)) {
    return "يومٌ بدخولٍ وانصرافٍ مسجَّلين لا تصحّ ساعاته صفراً — احسبها من الأوقات، أو غيّر الحالة إلى «غياب» إن كان غياباً فعلاً";
  }
  return null;
}

const LATE_DEDUCTION_TAG_GLOBAL_RE = /\[تأخير:\s*\d+\s*دقيقة\s*-\s*خصم\s*\d+\s*دقيقة\]\s*/g;
const LATE_DEDUCTION_TAG_CAPTURE_RE = /\[تأخير:\s*\d+\s*دقيقة\s*-\s*خصم\s*(\d+)\s*دقيقة\]/;
const SESSIONS_TAG_GLOBAL_RE = /\[فترات الدوام:[^\]]+\]\s*/g;
const SESSIONS_TAG_CAPTURE_RE = /\[فترات الدوام:\s*([^\]|]+?)(?:\s*\|\s*استراحة\/زمنية:\s*(\d+)\s*دقيقة)?\s*\]/;
const BREAK_TAG_GLOBAL_RE = /\[استراحة\/زمنية:\s*\d+\s*دقيقة\]\s*/g;
const BREAK_TAG_CAPTURE_RE = /\[استراحة\/زمنية:\s*(\d+)\s*دقيقة\]/;
const OPEN_THIRD_PUNCH_RE = /بصمة دخول\s+(\d{1,2}:\d{2})\s+بلا انصراف/;

function formatHm(totalMinutes: number): string {
  const norm = ((Math.round(totalMinutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * يبني فترتي دوام افتراضيتين صالحتين زمنياً عند التحويل من فترة واحدة إلى دوام مجزّأ،
 * مع مراعاة أوقات الورديات الصباحية والمسائية والليلية دون إنتاج فترات متداخلة أو معكوسة.
 */
export function buildDefaultSplitSessions(
  checkIn?: string | null,
  checkOut?: string | null,
  opts?: { crossMidnight?: boolean },
): { checkIn: string; checkOut: string; crossMidnight: boolean }[] {
  const inMin = minutesOf(checkIn);
  const cross = Boolean(opts?.crossMidnight);
  const span = spanHours(checkIn, checkOut, { crossMidnight: cross });

  if (inMin != null && span != null && span >= 1.5) {
    const inStr = checkIn!.trim();
    const outStr = checkOut!.trim();
    const totalMins = Math.round(span * 60);
    // حالة شائعة: دوام ممتدّ من الصباح حتى المساء (مثل 08:00 إلى 18:00 أو 20:00)
    if (!cross && inMin <= 9 * 60 && inMin + totalMins >= 18 * 60 && 12 * 60 > inMin && 16 * 60 < inMin + totalMins) {
      return [
        { checkIn: inStr, checkOut: "12:00", crossMidnight: false },
        { checkIn: "16:00", checkOut: outStr, crossMidnight: false },
      ];
    }
    const breakMins = totalMins >= 240 ? 60 : 30;
    const rawHalf = Math.floor((totalMins - breakMins) / 2);
    const work1 = rawHalf >= 30 ? Math.floor(rawHalf / 15) * 15 : Math.max(15, rawHalf);
    const end1Abs = inMin + work1;
    const start2Abs = end1Abs + breakMins;
    const end2Abs = inMin + totalMins;
    const cross1 = end1Abs >= 24 * 60;
    const cross2 = !cross1 && start2Abs < 24 * 60 && end2Abs >= 24 * 60;
    return [
      { checkIn: inStr, checkOut: formatHm(end1Abs), crossMidnight: cross1 },
      { checkIn: formatHm(start2Abs), checkOut: outStr, crossMidnight: cross2 },
    ];
  }

  if (inMin != null) {
    const inStr = checkIn!.trim();
    if (inMin <= 11 * 60) {
      return [
        { checkIn: inStr, checkOut: "12:00", crossMidnight: false },
        { checkIn: "16:00", checkOut: "20:00", crossMidnight: false },
      ];
    }
    const end1Abs = inMin + 180;
    const start2Abs = end1Abs + 60;
    const end2Abs = start2Abs + 180;
    const cross1 = end1Abs >= 24 * 60;
    const cross2 = !cross1 && start2Abs < 24 * 60 && end2Abs >= 24 * 60;
    return [
      { checkIn: inStr, checkOut: formatHm(end1Abs), crossMidnight: cross1 },
      { checkIn: formatHm(start2Abs), checkOut: formatHm(end2Abs), crossMidnight: cross2 },
    ];
  }

  return [
    { checkIn: "08:00", checkOut: "12:00", crossMidnight: false },
    { checkIn: "16:00", checkOut: "20:00", crossMidnight: false },
  ];
}

/**
 * يقترح فترة دوام إضافية تالية لآخر فترة حالية دون تداخل زمني.
 */
export function suggestNextSplitSession(
  existing: AttendanceSessionInput[],
): { checkIn: string; checkOut: string; crossMidnight: boolean } {
  const last = existing.length > 0 ? existing[existing.length - 1] : null;
  const lastOutMin = last ? minutesOf(last.checkOut) : null;
  if (lastOutMin != null && !last?.crossMidnight && lastOutMin + 90 <= 23 * 60 + 59) {
    const nextIn = Math.min(23 * 60 + 30, lastOutMin + 60);
    const nextOut = Math.min(23 * 60 + 59, nextIn + 120);
    if (nextOut > nextIn) {
      return { checkIn: formatHm(nextIn), checkOut: formatHm(nextOut), crossMidnight: false };
    }
  }
  return { checkIn: "", checkOut: "", crossMidnight: false };
}

export interface AttendanceSessionInput {
  checkIn?: string | null;
  checkOut?: string | null;
  crossMidnight?: boolean;
  checkOutNextDay?: boolean;
}

export interface AttendanceSession {
  checkIn: string;
  checkOut: string | null;
  crossMidnight?: boolean;
  hours: string;
}

export interface AttendanceBreak {
  from: string;
  to: string;
  minutes: number;
  hours: string;
}

export interface SessionsSummaryResult {
  sessions: AttendanceSession[];
  breaks: AttendanceBreak[];
  totalHours: number;
  totalHoursStr: string;
  breakMinutes: number;
  breakHours: string;
  firstCheckIn: string | null;
  lastCheckOut: string | null;
  lastCrossMidnight: boolean;
  hasOpenSession: boolean;
  openSessionCheckIn: string | null;
  violation: string | null;
}

/**
 * يحسب ملخّص فترات الدوام المتعدّدة في اليوم الواحد (الاستراحات/الزمنيات البينيّة، صافي الساعات،
 * والتحقّق من الترتيب الزمنيّ وعدم تداخل الفترات).
 */
export function computeSessionsSummary(rawSessions: AttendanceSessionInput[]): SessionsSummaryResult {
  const nonEmpty = (rawSessions ?? []).filter(
    (s) => (typeof s.checkIn === "string" && s.checkIn.trim() !== "") || (typeof s.checkOut === "string" && s.checkOut.trim() !== ""),
  );

  if (nonEmpty.length === 0) {
    return {
      sessions: [],
      breaks: [],
      totalHours: 0,
      totalHoursStr: "0.00",
      breakMinutes: 0,
      breakHours: "0.00",
      firstCheckIn: null,
      lastCheckOut: null,
      lastCrossMidnight: false,
      hasOpenSession: false,
      openSessionCheckIn: null,
      violation: null,
    };
  }

  const sessions: AttendanceSession[] = [];
  const breaks: AttendanceBreak[] = [];
  let totalHours = 0;
  let breakMinutes = 0;
  let violation: string | null = null;
  let prevOutAbsMinutes: number | null = null;
  let prevCheckOutStr: string | null = null;
  let dayOffsetMinutes = 0;

  for (let i = 0; i < nonEmpty.length; i++) {
    const raw = nonEmpty[i];
    const inStr = typeof raw.checkIn === "string" ? raw.checkIn.trim() : "";
    const outStr = typeof raw.checkOut === "string" && raw.checkOut.trim() !== "" && raw.checkOut.trim() !== "؟"
      ? raw.checkOut.trim()
      : null;
    const cross = Boolean(raw.crossMidnight || raw.checkOutNextDay);

    const inMin = minutesOf(inStr);
    if (inMin == null) {
      violation = violation ?? `حدد وقت دخول صالحاً للفترة رقم ${i + 1}`;
      continue;
    }

    const absInMin = dayOffsetMinutes + inMin;
    if (prevOutAbsMinutes != null && prevCheckOutStr != null) {
      if (absInMin < prevOutAbsMinutes) {
        violation =
          violation ??
          `فترات الدوام متداخلة أو غير مرتّبة زمنياً: دخول الفترة ${i + 1} (${inStr}) يسبق انصراف الفترة ${i} (${prevCheckOutStr})`;
      } else if (absInMin > prevOutAbsMinutes) {
        const gapMins = absInMin - prevOutAbsMinutes;
        breakMinutes += gapMins;
        breaks.push({
          from: prevCheckOutStr,
          to: inStr,
          minutes: gapMins,
          hours: (Math.round((gapMins / 60) * 100) / 100).toFixed(2),
        });
      }
    }

    if (outStr == null) {
      if (i < nonEmpty.length - 1) {
        violation = violation ?? `أكمل وقت انصراف الفترة ${i + 1} قبل إضافة فترة دوام تالية`;
      } else {
        violation = violation ?? `حدد وقت انصراف الفترة رقم ${i + 1} (الدخول ${inStr} بلا انصراف)`;
      }
      sessions.push({
        checkIn: inStr,
        checkOut: null,
        crossMidnight: false,
        hours: "0.00",
      });
      prevOutAbsMinutes = null;
      prevCheckOutStr = null;
      continue;
    }

    const outMin = minutesOf(outStr);
    if (outMin == null) {
      violation = violation ?? `وقت الانصراف غير صالح في الفترة رقم ${i + 1}`;
      continue;
    }

    const span = spanHours(inStr, outStr, { crossMidnight: cross });
    if (span == null) {
      violation =
        violation ??
        `في الفترة رقم ${i + 1}: وقت الانصراف (${outStr}) يجب أن يكون بعد وقت الدخول (${inStr})`;
      sessions.push({
        checkIn: inStr,
        checkOut: outStr,
        crossMidnight: cross,
        hours: "0.00",
      });
      continue;
    }

    totalHours += span;
    sessions.push({
      checkIn: inStr,
      checkOut: outStr,
      ...(cross ? { crossMidnight: true } : {}),
      hours: span.toFixed(2),
    });

    if (outMin <= inMin && cross) {
      dayOffsetMinutes += 24 * 60;
    }
    prevOutAbsMinutes = dayOffsetMinutes + outMin;
    prevCheckOutStr = outStr;
  }

  const roundedTotal = Math.round(totalHours * 100) / 100;
  const pairedSessions = sessions.filter((s) => s.checkOut != null);
  const openSession = sessions.find((s) => s.checkOut == null) ?? null;
  const lastPaired = pairedSessions.length > 0 ? pairedSessions[pairedSessions.length - 1] : null;

  return {
    sessions,
    breaks,
    totalHours: roundedTotal,
    totalHoursStr: roundedTotal.toFixed(2),
    breakMinutes,
    breakHours: (Math.round((breakMinutes / 60) * 100) / 100).toFixed(2),
    firstCheckIn: sessions.length > 0 ? sessions[0].checkIn : null,
    lastCheckOut: lastPaired ? lastPaired.checkOut : null,
    lastCrossMidnight: Boolean(lastPaired?.crossMidnight) || dayOffsetMinutes > 0,
    hasOpenSession: openSession != null,
    openSessionCheckIn: openSession ? openSession.checkIn : null,
    violation,
  };
}

/**
 * تنسيق مدّة بالدقائق إلى نصّ عربيّ واضح ومختصر (مثل: "45 د"، "2 س"، "1 س و30 د").
 */
export function formatDurationArabic(minutes: number | null | undefined): string {
  const mins = Math.round(Number(minutes ?? 0));
  if (!Number.isFinite(mins) || mins <= 0) return "0 د";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} د`;
  if (m === 0) return `${h} س`;
  return `${h} س و${m} د`;
}

/**
 * يُنشئ وسم فترات الدوام و/أو الاستراحة (الزمنية) لحفظه في حقل notes دون المساس بجدول قاعدة البيانات.
 */
export function formatAttendanceSessionsTag(
  sessions?: AttendanceSessionInput[] | null,
  breakMinutes?: number | null,
): string | null {
  const validSessions = (sessions ?? []).filter((s) => minutesOf(s.checkIn) != null);
  if (validSessions.length > 1) {
    const summary = computeSessionsSummary(validSessions);
    const parts = summary.sessions.map((s) => {
      if (!s.checkOut) return `${s.checkIn}→؟`;
      return `${s.checkIn}→${s.checkOut}${s.crossMidnight ? "(+1)" : ""}`;
    });
    const effectiveBreak =
      breakMinutes != null && Number.isFinite(Number(breakMinutes)) && Number(breakMinutes) >= 0
        ? Math.round(Number(breakMinutes))
        : summary.breakMinutes;
    if (effectiveBreak > 0) {
      return `[فترات الدوام: ${parts.join("، ")} | استراحة/زمنية: ${effectiveBreak} دقيقة]`;
    }
    return `[فترات الدوام: ${parts.join("، ")}]`;
  }

  const singleBreak = Math.round(Number(breakMinutes ?? 0));
  if (Number.isFinite(singleBreak) && singleBreak > 0) {
    return `[استراحة/زمنية: ${singleBreak} دقيقة]`;
  }
  return null;
}

/**
 * ينزع جميع أوسمة النظام المؤتمتة ([تأخير: ...]، [فترات الدوام: ...]، [استراحة/زمنية: ...])
 * ليبقى نصّ الملاحظة البشريّ وحده.
 */
export function stripAttendanceSystemTags(notes: string | null | undefined): string {
  return String(notes ?? "")
    .replace(LATE_DEDUCTION_TAG_GLOBAL_RE, "")
    .replace(SESSIONS_TAG_GLOBAL_RE, "")
    .replace(BREAK_TAG_GLOBAL_RE, "")
    .trim();
}

export interface ManualAttendanceEditSource {
  status?: string | null;
  state?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  crossMidnight?: boolean;
  /** الساعات المخزّنة في السجلّ (الصافية بعد خصم التأخير إن وُجد). */
  storedHours?: number | string | null;
  /** ساعات احتياطية عند غياب storedHours (مثل countedHours في الكشف). */
  fallbackHours?: number | string | null;
  notes?: string | null;
  reviewReason?: string | null;
}

export interface ParsedAttendanceDayDetails {
  sessions: AttendanceSession[];
  breaks: AttendanceBreak[];
  breakMinutes: number;
  breakHours: string;
  hasMultipleSessions: boolean;
  hasOpenSession: boolean;
  openSessionCheckIn: string | null;
  cleanNotes: string;
  grossHours: number;
  lateDeductionMinutes: number;
}

/**
 * يستخرج تفاصيل فترات الدوام والاستراحة/الزمنية والملاحظة الصافية من سجلّ حضور يوميّ.
 * يدعم كلاً من الأوسمة الصريحة في `notes` والاستنتاج التلقائي للسجلّات المطويّة سابقاً
 * التي يقلّ فيها صافي الساعات عن المدى بين أوّل دخول وآخر انصراف.
 */
export function parseAttendanceDayDetails(input: ManualAttendanceEditSource): ParsedAttendanceDayDetails {
  const notesText = String(input.notes ?? "");
  const reviewReasonText = String(input.reviewReason ?? "");
  const cleanNotes = stripAttendanceSystemTags(notesText);

  const lateMatch = LATE_DEDUCTION_TAG_CAPTURE_RE.exec(notesText);
  const parsedLate =
    lateMatch && (input.reviewReason == null || input.reviewReason === "manual_late_override")
      ? Number(lateMatch[1])
      : 0;
  const lateDeductionMinutes = Number.isFinite(parsedLate) && parsedLate > 0 ? parsedLate : 0;

  const rawStored = input.storedHours ?? input.fallbackHours;
  const storedNum = Number(rawStored ?? 0);
  const validStored = Number.isFinite(storedNum) && storedNum > 0 ? storedNum : 0;
  const grossHours =
    validStored > 0
      ? Math.round((validStored + lateDeductionMinutes / 60) * 100) / 100
      : 0;

  const sessionsMatch = SESSIONS_TAG_CAPTURE_RE.exec(notesText);
  if (sessionsMatch) {
    const rawList = sessionsMatch[1]
      .split(/[،,]/)
      .map((part) => part.trim())
      .filter(Boolean);
    const parsedInputs: AttendanceSessionInput[] = [];
    for (const item of rawList) {
      const m = /^(\d{1,2}:\d{2})\s*(?:→|->|-)\s*(\d{1,2}:\d{2}|\?|؟)(\(\+1\))?$/.exec(item);
      if (m) {
        parsedInputs.push({
          checkIn: m[1],
          checkOut: m[2] === "?" || m[2] === "؟" ? null : m[2],
          crossMidnight: Boolean(m[3]),
        });
      }
    }
    if (parsedInputs.length > 0) {
      const summary = computeSessionsSummary(parsedInputs);
      const explicitBreak = sessionsMatch[2] != null ? Number(sessionsMatch[2]) : null;
      const breakMinutes =
        explicitBreak != null && Number.isFinite(explicitBreak) && explicitBreak >= 0
          ? Math.round(explicitBreak)
          : summary.breakMinutes;
      const isMulti = summary.sessions.length > 1;
      return {
        sessions: summary.sessions,
        breaks: summary.breaks,
        breakMinutes,
        breakHours: (Math.round((breakMinutes / 60) * 100) / 100).toFixed(2),
        hasMultipleSessions: isMulti,
        hasOpenSession: isMulti && summary.hasOpenSession,
        openSessionCheckIn: isMulti ? summary.openSessionCheckIn : null,
        cleanNotes,
        grossHours: grossHours > 0 ? grossHours : summary.totalHours,
        lateDeductionMinutes,
      };
    }
  }

  // استرجاع البصمة الثالثة المفتوحة للسجلات المطويّة القديمة التي تحمل سبب المراجعة دون وسم الفترات
  const openThirdMatch = OPEN_THIRD_PUNCH_RE.exec(reviewReasonText);
  const inMin = minutesOf(input.checkIn);
  const outMin = minutesOf(input.checkOut);
  if (openThirdMatch && inMin != null && outMin != null) {
    const thirdIn = openThirdMatch[1];
    const thirdMin = minutesOf(thirdIn);
    if (thirdMin != null && thirdMin > outMin) {
      const summary = computeSessionsSummary([
        { checkIn: input.checkIn!.trim(), checkOut: input.checkOut!.trim(), crossMidnight: Boolean(input.crossMidnight) },
        { checkIn: thirdIn, checkOut: null },
      ]);
      return {
        sessions: summary.sessions,
        breaks: summary.breaks,
        breakMinutes: summary.breakMinutes,
        breakHours: summary.breakHours,
        hasMultipleSessions: true,
        hasOpenSession: true,
        openSessionCheckIn: thirdIn,
        cleanNotes,
        grossHours: grossHours > 0 ? grossHours : summary.totalHours,
        lateDeductionMinutes,
      };
    }
  }

  const breakMatch = BREAK_TAG_CAPTURE_RE.exec(notesText);
  let breakMinutes =
    breakMatch && Number.isFinite(Number(breakMatch[1])) && Number(breakMatch[1]) > 0
      ? Math.round(Number(breakMatch[1]))
      : 0;

  const isCappedAtMax = reviewReasonText.includes("قُصّت عند سقف");
  const isUnpaidDay =
    input.status === "ABSENT" ||
    input.status === "LEAVE" ||
    input.state === "absent" ||
    input.state === "paidLeave" ||
    input.state === "unpaidLeave";

  const autoSpan = spanHours(input.checkIn, input.checkOut, { crossMidnight: Boolean(input.crossMidnight) });
  if (
    breakMinutes === 0 &&
    !isCappedAtMax &&
    !isUnpaidDay &&
    autoSpan != null &&
    grossHours > 0 &&
    autoSpan - grossHours > HOURS_SPAN_TOLERANCE
  ) {
    breakMinutes = Math.round((autoSpan - grossHours) * 60);
  }

  const singleSessions: AttendanceSession[] = [];
  if (inMin != null) {
    const outValid = outMin != null ? input.checkOut!.trim() : null;
    const sessionHrs =
      grossHours > 0
        ? grossHours.toFixed(2)
        : autoSpan != null
          ? Math.max(0, autoSpan - breakMinutes / 60).toFixed(2)
          : "0.00";
    singleSessions.push({
      checkIn: input.checkIn!.trim(),
      checkOut: outValid,
      ...(input.crossMidnight ? { crossMidnight: true } : {}),
      hours: sessionHrs,
    });
  }

  return {
    sessions: singleSessions,
    breaks: [],
    breakMinutes,
    breakHours: (Math.round((breakMinutes / 60) * 100) / 100).toFixed(2),
    hasMultipleSessions: false,
    hasOpenSession: false,
    openSessionCheckIn: null,
    cleanNotes,
    grossHours,
    lateDeductionMinutes,
  };
}

export interface ParsedManualAttendanceEdit {
  status: "PRESENT" | "LATE" | "ABSENT" | "LEAVE";
  /** الساعات الإجمالية قبل خصم التأخير اليدوي — تمنع اقتطاع الخصم مرّتين عند إعادة فتح النافذة والحفظ. */
  hours: string;
  /** دقائق خصم التأخير اليدوي المحفوظة سابقاً (أو "" إن لم يُوجد خصم). */
  lateDeductionMinutes: string;
  /** الملاحظة الصافية بعد نزع أوسمة النظام المؤتمتة. */
  notes: string;
}

/**
 * يستخرج حالة نافذة «تصحيح الدوام» من صفّ موجود (في كشف الموظف أو جدول الحضور)
 * ويستعيد الساعات الإجمالية قبل خصم التأخير اليدوي كي لا يُقتطع الخصم مرّتين عند إعادة الحفظ.
 */
export function parseManualAttendanceEdit(input: ManualAttendanceEditSource): ParsedManualAttendanceEdit {
  const status: ParsedManualAttendanceEdit["status"] =
    input.status === "LATE" || input.status === "ABSENT" || input.status === "LEAVE"
      ? input.status
      : input.state === "absent"
        ? "ABSENT"
        : input.state === "paidLeave" || input.state === "unpaidLeave"
          ? "LEAVE"
          : "PRESENT";

  const notesText = String(input.notes ?? "");
  const cleanNotes = stripAttendanceSystemTags(notesText);

  if (status === "ABSENT" || status === "LEAVE") {
    return {
      status,
      hours: "0",
      lateDeductionMinutes: "",
      notes: cleanNotes,
    };
  }

  const tagMatch = LATE_DEDUCTION_TAG_CAPTURE_RE.exec(notesText);
  const parsedDeductedMins =
    tagMatch && (input.reviewReason == null || input.reviewReason === "manual_late_override")
      ? Number(tagMatch[1])
      : 0;
  const deductedMins = Number.isFinite(parsedDeductedMins) && parsedDeductedMins > 0 ? parsedDeductedMins : 0;

  const rawStored = input.storedHours ?? input.fallbackHours;
  const storedNum = Number(rawStored ?? 0);
  const validStored = Number.isFinite(storedNum) && storedNum > 0 ? storedNum : 0;
  const autoSpan = spanHours(input.checkIn, input.checkOut, { crossMidnight: Boolean(input.crossMidnight) });

  let initialHours: string;
  if (deductedMins > 0) {
    if (validStored > 0) {
      const reconstructed = Math.round((validStored + deductedMins / 60) * 100) / 100;
      const snapped =
        autoSpan != null && Math.abs(reconstructed - autoSpan) <= 0.02 ? autoSpan : reconstructed;
      initialHours = snapped.toFixed(2);
    } else if (autoSpan != null && autoSpan > 0) {
      initialHours = autoSpan.toFixed(2);
    } else {
      initialHours = (Math.round((deductedMins / 60) * 100) / 100).toFixed(2);
    }
  } else if (validStored > 0) {
    initialHours = typeof rawStored === "string" && rawStored.trim() !== "" ? rawStored.trim() : String(validStored);
  } else if (autoSpan != null) {
    initialHours = autoSpan.toFixed(2);
  } else {
    initialHours = "0";
  }

  return {
    status,
    hours: initialHours,
    lateDeductionMinutes: deductedMins > 0 ? String(deductedMins) : "",
    notes: cleanNotes,
  };
}

/**
 * يكشف ما إذا كان سجلّ الحضور اليوميّ يتضمّن بصمة دخولٍ مفتوحة لم تُغلق بعد:
 * ١) دخولٌ بلا انصراف (`checkIn != null && checkOut == null && hours <= 0`)، أو
 * ٢) دوامٌ مجزّأ أُغلقت فترتُه الأولى وبقيت فترتُه الثانية مفتوحة (`needsReview` مع بصمة دخول ثالثة/فترة مفتوحة).
 */
export function hasUnclosedAttendancePunch(row: {
  checkIn?: unknown;
  checkOut?: unknown;
  hours?: unknown;
  needsReview?: unknown;
  reviewReason?: string | null;
  notes?: string | null;
}): boolean {
  if (row.checkIn != null && row.checkOut == null && !(Number(row.hours ?? 0) > 0)) {
    return true;
  }
  if (!row.needsReview) return false;
  const reason = String(row.reviewReason ?? "");
  if (reason.includes("فترة دوام مفتوحة") || OPEN_THIRD_PUNCH_RE.test(reason)) {
    return true;
  }
  const details = parseAttendanceDayDetails({
    notes: row.notes ?? null,
    reviewReason: row.reviewReason ?? null,
  });
  return details.hasOpenSession;
}



