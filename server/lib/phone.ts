/**
 * مكتبة الهاتف المشتركة (T3.1 — بنك جهات الاتصال). تُنقَل هنا دالة التطبيع التي كانت محصورة في
 * `onlineOrderService.ts` (normalizeStorePhone) لتُشارَك بين مسار المتجر (يستمرّ عبر إعادة تصدير
 * `normalizeStorePhone` بلا تغيير سلوكي — راجع تعليقها هناك) وخدمتَي العميل/المورّد
 * (customerService/supplierService) عند إنشاء/تعديل هاتف — حتى تتلاقى كل صِيَغ نفس الرقم
 * («07701234567»/«+9647701234567»/«00964…») على سِجلٍّ واحد بدل تكرار الطرف.
 */
import { phoneMatchSuffix } from "./similarMatch";

/** يحوّل الأرقام العربية/الفارسية إلى ASCII قبل أي تحقق أو تطبيع. */
export function toAsciiPhoneDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/\D/g, "");
}

/**
 * رقم موبايل عراقي صارم لمسار الاستقبال.
 * يقبل 07xxxxxxxxx أو +9647xxxxxxxxx أو 009647xxxxxxxxx ويعيد E.164 واحدة.
 * لا يُستعمل هذا الحارس في الاستيرادات القديمة المتسامحة؛ هو عقد هوية العميل في الكاشير فقط.
 */
export function canonicalIraqiMobile(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  let digits = toAsciiPhoneDigits(raw);
  if (digits.startsWith("00964")) digits = digits.slice(2);
  if (/^07\d{9}$/.test(digits)) return `+964${digits.slice(1)}`;
  if (/^9647\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

/** الصيغة المحلية ذات ١١ رقماً للعرض داخل خانات الاستقبال. */
export function iraqiMobileLocal(raw: string | null | undefined): string | null {
  const canonical = canonicalIraqiMobile(raw);
  return canonical ? `0${canonical.slice(4)}` : null;
}

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
