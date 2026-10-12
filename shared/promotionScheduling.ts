/**
 * shared/promotionScheduling.ts
 *
 * المنظومة الموحدة لجدولة العروض والكوبونات وأيام الأسبوع
 * وكوبونات العودة التلقائية على فواتير الكاشير (Bounce-back Coupons).
 */

export interface DayOfWeekOption {
  readonly id: number; // 0 = الأحد, 1 = الإثنين, ..., 6 = السبت
  readonly nameAr: string;
  readonly shortAr: string;
}

export const DAYS_OF_WEEK: readonly DayOfWeekOption[] = Object.freeze([
  { id: 0, nameAr: "الأحد", shortAr: "أحد" },
  { id: 1, nameAr: "الإثنين", shortAr: "إثنين" },
  { id: 2, nameAr: "الثلاثاء", shortAr: "ثلاثاء" },
  { id: 3, nameAr: "الأربعاء", shortAr: "أربعاء" },
  { id: 4, nameAr: "الخميس", shortAr: "خميس" },
  { id: 5, nameAr: "الجمعة", shortAr: "جمعة" },
  { id: 6, nameAr: "السبت", shortAr: "سبت" },
]);

export const ALL_DAYS_MASK = [0, 1, 2, 3, 4, 5, 6];

/**
 * حساب يوم الأسبوع المعتمد وفق توقيت بغداد (UTC+3).
 */
export function getBaghdadDayOfWeek(dateInput?: Date | string | null): number {
  const d = dateInput ? (dateInput instanceof Date ? dateInput : new Date(dateInput)) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().getUTCDay();

  // تحويل إلى توقيت بغداد (UTC+3)
  const baghdadTime = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return baghdadTime.getUTCDay();
}

/**
 * اسم اليوم العربي وفق توقيت بغداد.
 */
export function getBaghdadDayName(dateInput?: Date | string | null): string {
  const dayIdx = getBaghdadDayOfWeek(dateInput);
  return DAYS_OF_WEEK.find((day) => day.id === dayIdx)?.nameAr ?? "اليوم";
}

/**
 * فحص ما إذا كان التاريخ مشمولاً ضمن الأيام المحددة.
 * إذا كانت المصفوفة فارغة أو غير محددة أو تضم كافة الأيام، يعتبر اليوم متاحاً.
 */
export function isDayActive(
  dateInput: Date | string | null | undefined,
  activeDays?: number[] | null,
): boolean {
  if (!activeDays || !Array.isArray(activeDays) || activeDays.length === 0 || activeDays.length >= 7) {
    return true;
  }
  const currentDay = getBaghdadDayOfWeek(dateInput);
  return activeDays.includes(currentDay);
}

/**
 * صياغة نصية موجزة للأيام المتاحة للكوبون.
 */
export function formatActiveDays(activeDays?: number[] | null): string {
  if (!activeDays || !Array.isArray(activeDays) || activeDays.length === 0 || activeDays.length >= 7) {
    return "طوال أيام الأسبوع";
  }

  const sorted = [...activeDays].sort((a, b) => a - b);
  const names = sorted
    .map((id) => DAYS_OF_WEEK.find((d) => d.id === id)?.nameAr)
    .filter(Boolean);

  if (names.length === 1) {
    return `كل ${names[0]} فقط`;
  }
  if (names.length === 2) {
    return `كل ${names[0]} و${names[1]}`;
  }
  return `أيام: ${names.join("، ")}`;
}

/**
 * لقطة إعدادات التصميم والجدولة والعودة التلقائية المحفوظة في designJson
 */
export interface PromotionDesignMeta {
  title?: string | null;
  subtitle?: string | null;
  terms?: string | null;
  color?: string | null;
  /** أيام الأسبوع المسموح فيها بتطبيق الكوبون (0=الأحد ... 6=السبت) */
  activeDays?: number[] | null;
  /** تفعيل الإصدار التلقائي لكوبون العودة مع فواتير الكاشير */
  isAutoBounceBack?: boolean;
  /** الحد الأدنى لقيمة الفاتورة لتفعيل الكوبون التلقائي (بالدينار العراقي) */
  autoBounceBackMinInvoice?: string | null;
  /** مدة صلاحية كوبون العودة بالأيام (مثلاً 14 يوماً من تاريخ الفاتورة) */
  bounceBackValidityDays?: number | null;
  /** بادئة رمز كوبون العودة (افتراضياً NEXT) */
  bounceBackPrefix?: string | null;
  /** عنوان بارز لكوبون العودة في الإيصال الحراري */
  bounceBackHeadline?: string | null;
}
