/**
 * مكتبة الهاتف المشتركة (T3.1 — بنك جهات الاتصال). تُنقَل هنا دالة التطبيع التي كانت محصورة في
 * `onlineOrderService.ts` (normalizeStorePhone) لتُشارَك بين مسار المتجر (يستمرّ عبر إعادة تصدير
 * `normalizeStorePhone` بلا تغيير سلوكي — راجع تعليقها هناك) وخدمتَي العميل/المورّد
 * (customerService/supplierService) عند إنشاء/تعديل هاتف — حتى تتلاقى كل صِيَغ نفس الرقم
 * («07701234567»/«+9647701234567»/«00964…») على سِجلٍّ واحد بدل تكرار الطرف.
 */
import { phoneMatchSuffix } from "./similarMatch";

/**
 * تطبيع رقم عراقي إلى صيغة E.164 قانونية واحدة (+964…). منطق مُطابق حرفياً لِما كان في
 * onlineOrderService.ts (مراجعة عدائية ١٢/٧) — بلا أي تعديل سلوكي عند الاستخراج. مدخل بلا أرقام
 * (garbage) يُعاد مُشذَّباً (trim) بلا انهيار — تسامح، لا رمي.
 */
export function normalizeIraqPhoneE164(raw: string): string {
  const trimmed = raw.trim();
  let s = trimmed.replace(/[\s\-()]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    return digits ? "+" + digits : trimmed;
  }
  const digits = s.replace(/\D/g, "");
  if (!digits) return trimmed;
  if (digits.startsWith("964")) return "+" + digits;
  if (digits.startsWith("0")) return "+964" + digits.slice(1);
  return "+964" + digits;
}

/**
 * لاحقة آخر ١٠ أرقام من هاتف بأي صيغة كتابة — غلاف رقيق حول `similarMatch.phoneMatchSuffix`
 * (لا تكرار منطق؛ هي مصدر الحقيقة الوحيد لمطابقة الهاتف بالتشابه). `null` لمدخل بلا أرقام كافية.
 */
export function phoneSuffix10(raw: string | null | undefined): string | null {
  return phoneMatchSuffix(raw);
}
