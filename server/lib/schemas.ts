import { z } from "zod";

/** سلسلة مالية بـ٢ خانات عشرية على الأكثر، تَقبل السالب (للمرتجعات/التعديلات).
 *  متّسق مع toDbMoney(string) في server/services/money.ts.
 */
export const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, "مبلغ بصيغة غير صالحة");

/** سلسلة مالية موجبة فقط (> 0)، بـ٢ خانات عشرية. للدفعات/الفواتير الإيجابية.
 *  يَرفض الصفر و السالب (الصفر = «بلا دفعة» يَستخدم تدفّقاً مختلفاً).
 *  (§٥: بلا parseFloat على المال — نَكتفي بفحص وجود رقم غير صفري، والـregex يَمنع السالب أصلاً.)
 */
export const positiveMoneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ موجب فقط")
  .refine((s) => /[1-9]/.test(s), "مبلغ موجب صفر غير مسموح");

/** سلسلة مالية غير سالبة (≥ 0)، بـ٢ خانات عشرية. للأسعار/الخصومات التي تَقبل الصفر
 *  (سعر شراء/مرتجع، override). الـregex يَمنع السالب؛ الصفر مسموح. */
export const nonNegMoneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (غير سالب، منزلتان كحدّ أقصى)");

/** كمية موجبة (> 0)، بـ٣ منازل عشرية كحدّ أقصى. */
export const positiveQtyString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة (موجبة، ٣ منازل)")
  .refine((s) => /[1-9]/.test(s), "الكمية يجب أن تكون موجبة");

/** نسبة مئوية في [٠، ١٠٠]، بـ٢ منازل. للضريبة/الخصم النسبي (نسبة لا مال ⇒ مقارنة عددية مقبولة). */
export const percentString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "نسبة غير صالحة")
  .refine((s) => Number(s) <= 100, "النسبة يجب ألّا تتجاوز ١٠٠٪");

/** سلسلة مالية موقَّعة (تَقبل السالب للمرتجعات). مرادف لـmoneyString — للوضوح الدلالي. */
export const signedMoneyString = moneyString;

/** تاريخ بصيغة YYYY-MM-DD (متّسق مع toDateStr() في money.ts و dueDate في invoices). */
export const ymdDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ بصيغة YYYY-MM-DD");
