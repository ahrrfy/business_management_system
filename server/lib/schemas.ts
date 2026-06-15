import { z } from "zod";

/** سلسلة مالية بـ٢ خانات عشرية على الأكثر، تَقبل السالب (للمرتجعات/التعديلات).
 *  متّسق مع toDbMoney(string) في server/services/money.ts.
 */
export const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, "مبلغ بصيغة غير صالحة");

/** سلسلة مالية موجبة فقط (> 0)، بـ٢ خانات عشرية. للدفعات/الفواتير الإيجابية.
 *  يَرفض الصفر و السالب (الصفر = «بلا دفعة» يَستخدم تدفّقاً مختلفاً).
 */
export const positiveMoneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ موجب فقط")
  .refine((s) => parseFloat(s) > 0, "مبلغ موجب صفر غير مسموح");

/** سلسلة مالية موقَّعة (تَقبل السالب للمرتجعات). مرادف لـmoneyString — للوضوح الدلالي. */
export const signedMoneyString = moneyString;

/** تاريخ بصيغة YYYY-MM-DD (متّسق مع toDateStr() في money.ts و dueDate في invoices). */
export const ymdDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ بصيغة YYYY-MM-DD");
