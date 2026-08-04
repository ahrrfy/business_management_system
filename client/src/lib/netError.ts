/**
 * تمييز **فشل الشبكة** (لم يصل الطلب للخادم) عن **رفض خادميّ** (وصل ورُدّ برسالة).
 *
 * الفارق حاسم في شاشات العدّ الميداني: فشل الشبكة ⇒ نحفظ العدّة محلياً ونُزامنها لاحقاً،
 * أمّا الرفض الخادميّ (سياسة الجلسة، إقفال العدّ…) فيُعرض للمستخدم ولا يُحفظ أبداً —
 * وإلا أعدنا إرسال عدّة مرفوضة إلى الأبد.
 *
 * مصدر الحقيقة الوحيد لهذا التمييز — تستعمله بوابة العدّ (CountPortal) ومساحة عدّ
 * صاحب الحساب (MyStocktakeWorkspace) معاً كي لا ينجرف السلوكان.
 */
import { TRPCClientError } from "@trpc/client";

export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  // ردّ tRPC مكتمل يحمل data (حتى عند الخطأ) — غيابه يعني أنّ الطلب لم يصل/لم يُفهم.
  if (e instanceof TRPCClientError) return e.data == null;
  return e instanceof TypeError;
}
