/* ============================================================================
 * البصمة الأجرية للموظف — نواة نقيّة (server/services/hr/wageProfile.ts)
 *
 * **لماذا وُجدت:** حارس «الأجر لا يُغيَّر من شاشة الموظف» كان يقارن حقلين اثنين
 * (`salary`, `allowances`) بينما نموذج الأجر بالحضور (هجرات 0138-0141) جعل حقولاً
 * أخرى **حاملةً للأجر** فعلياً:
 *   • `workSchedule[يوم].rate` — سعر ساعةٍ صريح، يضرب الساعات مباشرةً (attendancePay).
 *   • `workSchedule[يوم].hours` — مقام السعر المُشتقّ (الراتب ÷ ساعات ٣٠ يوماً) وسقفُ
 *     اليوم؛ تخفيضُ الساعات يرفع سعر الساعة **ويُحوّل الفائض أوفر تايم بالسعر الأعلى**
 *     ⇒ مضاعفةُ أجرٍ بلا لمس حقل «الراتب» إطلاقاً.
 *   • `dayRates[يوم]` — سعر ساعة الساعيّ حرفياً (attendanceService.rateForDay).
 *   • `attendanceExempt` — «راتب ثابت لا يخضع للحضور» ⇒ أجرٌ كامل بلا حضور.
 *   • `payType` — يبدّل نموذج الاحتساب كلَّه.
 * فمَن يملك hr/FULL كان يرفع أجره الفعليّ من شاشة تعديل الموظف بلا معتمِدٍ ثانٍ،
 * والحارسُ يمرّره لأنه لم يلمس «الراتب» (ملاحظة مراجعة Codex على PR #446).
 *
 * **الحدّ المختار:** الحارس يقارن **البصمة الأجرية** لا أسماء الحقول — أي تغيّرٍ فيها
 * يمرّ بمسار الترقيات (معتمِد ≠ مُنشئ + تاريخ سريان + سجلّ). حدُّ «الحقول» البديل كان
 * إمّا مُسرِّباً (السماح بالساعات وحدها يُضاعف الأجر عبر الأوفر تايم أعلاه) أو كاذباً
 * (المقارنة الخام تُفشل كلّ تعديلٍ عاديّ — انظر التطبيع أدناه).
 *
 * **التطبيع شرطُ صحّة الحارس لا تجميلٌ:** نموذج الموظف الواحد (إضافة/تعديل) يُرسل
 * **دائماً** جدول دوامٍ كاملاً وأسعارَ أيامٍ كاملة حتى لمن جدولُه `null` في القاعدة،
 * فالمقارنة الخام (`JSON.stringify`) كانت ستمنع تعديل رقم هاتفٍ لكل موظفٍ قديم.
 * لذلك تُطبَّع القيم إلى **ما يدفعه المسيّر فعلاً**: `null` ⇒ الافتراضي الذي يستعمله
 * المستهلك نفسه (`DEFAULT_WORK_SCHEDULE` كاملاً في payrollService، و`DAY_RATES_DEFAULT`
 * **لكل يومٍ على حدة** في attendanceService) ⇒ إعادةُ إرسال نفس القيم الفعليّة = لا تغيير.
 *
 * ⚠️ عند تغيير أيّ مصدر أسعارٍ في `attendancePay.ts`/`attendanceService.ts` حدِّث
 * التطبيع هنا معه — هذه النواة **مرآةُ** ما يُدفع، وانحرافُها يفتح ثغرةً صامتة.
 * ========================================================================== */
import { DAY_RATES_DEFAULT, WEEK_DAYS } from "@shared/hr";
import { WAGE_FIELD_LABELS, normalizeScheduleShape, type WageDayShape, type WageProfileShape } from "@shared/wageDiff";
import { money } from "../money";
import { DEFAULT_WORK_SCHEDULE } from "./attendancePay";

/** يومٌ مطبَّع: ساعاتُه (صفر = راحة) وسعرُ ساعته الصريح (null = يُشتقّ من الراتب). */
export type WageDay = WageDayShape;

/**
 * البصمة الأجرية: كلُّ ما يقرؤه محرّك الرواتب/الحضور ليحسب مبلغاً — ولا شيء سواه.
 * شكلُها مُعرَّفٌ في `@shared/wageDiff` ليصف العميلُ فرقَها بنفس التسميات (شاشة الاعتماد).
 */
export type WageProfile = WageProfileShape;

/** الحقول الحاملة للأجر كما تصل من القاعدة أو من حمولة التعديل (أنواع متسامحة). */
export interface WageBearingFields {
  payType?: string | null;
  salary?: unknown;
  allowances?: unknown;
  attendanceExempt?: unknown;
  dayRates?: unknown;
  workSchedule?: unknown;
}

export { WAGE_FIELD_LABELS };

/** رقمٌ منتهٍ أو null (يبتلع "" وNaN وInfinity الآتية من الواجهة). */
function finite(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * أسعار الأيام كما يقرؤها `attendanceService.rateForDay`: **احتياطٌ لكل يومٍ على حدة**
 * (يومٌ ناقصٌ أو غير صالح يقع على `DAY_RATES_DEFAULT[اليوم]`) — لا احتياط للكائن كلّه.
 */
function normalizeDayRates(raw: unknown): Record<string, number> {
  const stored = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const d of WEEK_DAYS) {
    const v = finite(stored[d]);
    out[d] = v != null && v >= 0 ? v : DAY_RATES_DEFAULT[d] ?? 0;
  }
  return out;
}

/**
 * جدول الدوام كما يقرؤه `payrollService`/`attendancePay.dayOf` — التطبيع نفسُه مشتركٌ
 * مع محرّر الواجهة (`@shared/wageDiff`) فلا تنحرف قراءةُ شاشةٍ عن قراءة المحرّك.
 */
function normalizeSchedule(raw: unknown): Record<string, WageDay> {
  return normalizeScheduleShape(raw, DEFAULT_WORK_SCHEDULE as Record<string, WageDay>);
}

/** يستخرج البصمة الأجرية المطبَّعة من صفّ موظف أو من حمولة تعديل. */
export function wageProfileOf(e: WageBearingFields): WageProfile {
  const salaryRaw = e.salary;
  return {
    payType: String(e.payType ?? "monthly"),
    salary: salaryRaw === null || salaryRaw === undefined || salaryRaw === "" ? null : money(salaryRaw as string).toFixed(2),
    allowances: money((e.allowances ?? 0) as string).toFixed(2),
    attendanceExempt: !!e.attendanceExempt,
    dayRates: normalizeDayRates(e.dayRates),
    workSchedule: normalizeSchedule(e.workSchedule),
  };
}

/**
 * الحقول التي اختلفت بين بصمتين. المقارنة بـ`JSON.stringify` آمنة هنا لأن كلا الطرفين
 * مُنتَجٌ من `wageProfileOf` ⇒ ترتيب المفاتيح ثابتٌ (ترتيب `WEEK_DAYS`) وأنواعها موحّدة.
 */
export function wageProfileDiff(a: WageProfile, b: WageProfile): (keyof WageProfile)[] {
  return (Object.keys(a) as (keyof WageProfile)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** أعمدة جدول `employees` المقابلة لبصمةٍ — لتطبيق حزمة أجرٍ معتمَدة دفعةً واحدة. */
export function wageProfileColumns(w: WageProfile) {
  return {
    payType: w.payType as "monthly" | "hourly",
    salary: w.salary,
    allowances: w.allowances,
    // ثابت النموذج: الساعيّ أجرُه ساعاتُ حضوره فلا «راتب ثابت» يُعفى منه (مطابقٌ لـtoValues).
    attendanceExempt: w.payType === "hourly" ? false : w.attendanceExempt,
    dayRates: w.dayRates,
    workSchedule: w.workSchedule,
  };
}
