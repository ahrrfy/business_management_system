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
 * المدى بالساعات بين وقتين في اليوم نفسه (منزلتان)، أو null إن نقص أحدهما أو لم يكن
 * الانصراف بعد الدخول. لا يعبر منتصف الليل: صفّ الحضور يخزّن الوقتين على تاريخ اليوم نفسه.
 */
export function spanHours(checkIn: string | null | undefined, checkOut: string | null | undefined): number | null {
  const a = minutesOf(checkIn);
  const b = minutesOf(checkOut);
  if (a == null || b == null) return null;
  const diff = b - a;
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
}

/**
 * يُرجع نصّ المخالفة العربيّ، أو null إن كان المدخل متّسقاً.
 * بلا وقتين كاملين لا حكم: البصمة الفردية (دخولٌ بلا انصراف) حالةٌ مشروعة تُوسَم للمراجعة.
 */
export function attendanceHoursViolation(input: AttendanceHoursInput): string | null {
  const hasBoth = minutesOf(input.checkIn) != null && minutesOf(input.checkOut) != null;
  if (!hasBoth) return null;

  const span = spanHours(input.checkIn, input.checkOut);
  if (span == null) return "وقت الانصراف يجب أن يكون بعد وقت الدخول";

  if (!Number.isFinite(input.hours)) return "الساعات قيمةٌ غير صالحة";
  if (input.hours > span + HOURS_SPAN_TOLERANCE) {
    return `الساعات (${input.hours.toFixed(2)}) تتجاوز المدى بين الدخول والانصراف (${span.toFixed(2)} ساعة) — صحّح الأوقات أو الساعات`;
  }
  if (input.isPaidStatus && !(input.hours > 0)) {
    return "يومٌ بدخولٍ وانصرافٍ مسجَّلين لا تصحّ ساعاته صفراً — احسبها من الأوقات، أو غيّر الحالة إلى «غياب» إن كان غياباً فعلاً";
  }
  return null;
}
