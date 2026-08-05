// حرّاس نافذة الالتقاط الأوفلاينيّ — مشتركةٌ بين كلّ أنواع الكاشير (تجزئة/طباعة/استقبال).
//
// كانت هذه الفحوص محبوسةً داخل `replaySale.ts` وحده، فأيّ نوعِ كاشيرٍ جديد يُرحَّل بلا حارس
// نافذة أو يُعيد كتابتها فتنجرف العتبتان. استُخرجت هنا كي تبقى **قاعدةً واحدة**: أيّ مسار
// ترحيلٍ جديد يستدعيها أو لا يُقبَل في المراجعة.
import { TRPCError } from "@trpc/server";

/** أقصى عمرٍ لعنصرٍ ملتقَط يُرحَّل تلقائياً. ما تجاوزه ⇒ قرار مراجعةٍ بشريّة لا ترحيلٌ أعمى. */
export const OFFLINE_CAPTURE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** سماحية انحراف ساعة الجهاز إلى المستقبل. */
export const OFFLINE_CAPTURE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * يتحقّق من لحظة الالتقاط ويُعيدها `Date`. يرمي `PRECONDITION_FAILED` (لا `BAD_REQUEST`) على
 * تجاوز النافذة عمداً: طابور العميل يُصنّف هذا «رفض أعمال» فيُعلّق العنصر لمراجعة المدير
 * ويُكمل تفريغ ما بعده — فلا يحجب عنصرٌ واحدٌ نقودَ اليوم كلّه.
 */
export function assertCaptureWindow(capturedAtIso: string): Date {
  const capturedAt = new Date(capturedAtIso);
  if (Number.isNaN(capturedAt.getTime())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لحظة التقاط غير صالحة" });
  }
  const ageMs = Date.now() - capturedAt.getTime();
  if (ageMs < -OFFLINE_CAPTURE_FUTURE_TOLERANCE_MS) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لحظة الالتقاط في المستقبل — تحقّق من ساعة جهاز الكاشير",
    });
  }
  if (ageMs > OFFLINE_CAPTURE_MAX_AGE_MS) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "عمليّة أوفلاينية أقدم من ٧٢ ساعة — تتطلب مراجعة المدير قبل الترحيل",
    });
  }
  return capturedAt;
}

/** نقديّ فقط (قرار المالك): الآجل والبطاقة يتطلبان اتصالاً — رصيد العميل وسقفه ومرجع
 *  عمليّة البطاقة لا تُقيَّم بأمانة من نسخةٍ محليّة قديمة. */
export function assertCashOnly(method: string): void {
  if (method !== "CASH") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الأوفلاين نقدي فقط — الآجل والبطاقة يتطلبان اتصالاً" });
  }
}
