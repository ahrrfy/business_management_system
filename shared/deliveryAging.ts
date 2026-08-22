/**
 * **سلّم عمر الطرد** — مقياسٌ واحد للمنظومة كلّها (شاشة «قيد التوصيل» · تنبيهات الإدارة ·
 * الكنّاس الدوريّ). السياق (٢٢/٨): ٧٩/٨٤ طرداً جامداً «مُسنَد — لم يخرج» ٩-١٣ يوماً ولا شاشةَ
 * تقيس العمر ولا عتبةَ تُشعِل إنذاراً — كلُّ قارئٍ كان سيخترع عتبته لو لم تُوحَّد هنا.
 *
 * العتبات **ثوابت الآن** ومرشّحة للانتقال إلى إعدادات قاعدةٍ لاحقاً (نمط `openingModeSettings`)؛
 * حين يحدث ذلك يبقى هذا الملف مصدرَ الافتراضات والتسمية، وتقرأ الشاشات القيمة الفعلية من الخادم.
 *
 * درس `shared/invoiceStatus.ts` مطبَّق: ⛔ لا شاشة تُعيد تعريف العتبات أو الصيغة محلّياً —
 * يحرسه `deliveryAging.test.ts`.
 */

/** بعدها يُعَدّ الطرد «يحتاج نظرة» (لون تحذير). */
export const DELIVERY_AGE_WARN_HOURS = 24;
/** بعدها يُعَدّ «متعثّراً» (لون خطر) — وهي عتبة تنبيه الإدارة `delivery-stuck`. */
export const DELIVERY_AGE_DANGER_HOURS = 48;
/** بعدها يتدخّل الكنّاس الدوريّ (`staleSweep`) بحدث `STALE_ESCALATED` وإشعارٍ للمديرين. */
export const DELIVERY_AGE_ESCALATE_HOURS = 72;

export type DeliveryAgeLevel = "ok" | "warn" | "danger";

/** درجة الخطورة من عمر الطرد بالساعات (كما تُرجعه `TIMESTAMPDIFF(HOUR, dispatchedAt, NOW())`). */
export function deliveryAgeLevel(ageHours: number): DeliveryAgeLevel {
  if (!Number.isFinite(ageHours) || ageHours < DELIVERY_AGE_WARN_HOURS) return "ok";
  return ageHours < DELIVERY_AGE_DANGER_HOURS ? "warn" : "danger";
}

/**
 * صيغة العرض: بالساعات حتى ٤٨ («37 س») وبالأيام بعدها («13 يوماً») — الرقم لاتينيّ والوحدة
 * عربية (اصطلاح الواجهة كلّها). التفريق مقصود: «٥ أيام» تُقرأ فوراً بينما «120 س» تحتاج قسمة،
 * والعكس صحيح تحت اليومين حيث الساعات هي الحبيبة المفيدة.
 */
export function formatDeliveryAge(ageHours: number): string {
  const h = Number.isFinite(ageHours) ? Math.max(0, Math.floor(ageHours)) : 0;
  if (h <= DELIVERY_AGE_DANGER_HOURS) return `${h} س`;
  const d = Math.floor(h / 24);
  // صرف العدد العربيّ: مثنّى ثم جمع قلّة (٣-١٠) ثم تمييز منصوب (١١+) — «13 يوماً» لا «13 أيام».
  if (d === 2) return "يومان";
  if (d <= 10) return `${d} أيام`;
  return `${d} يوماً`;
}

/** توكنز الحالة الدلالية (لا ألوان خامّة — حارس `check:colors`)؛ نمط `WO_DELIVERY_STATE_CLS`. */
export const DELIVERY_AGE_CLS: Record<DeliveryAgeLevel, string> = {
  ok: "border-[var(--sem-ok)]/45 bg-[var(--sem-ok-bg)] text-[var(--sem-ok)]",
  warn: "border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  danger: "border-[var(--sem-danger)]/45 bg-[var(--sem-danger-bg)] text-[var(--sem-danger)]",
};
