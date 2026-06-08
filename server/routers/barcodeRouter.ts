/**
 * barcodeRouter — tRPC router للتحقق من توقيع QR وخدمات الباركود.
 *
 * verify: إجراء عام (public) يتحقق من أي payload QR مُولَّدة بـ barcodeService.
 * استخدام نموذجي:
 *   - موظف يمسح QR → ماسح يرسل payload → يتحقق → ينتقل للمستند
 *   - عميل يمسح بهاتفه → تطبيق يعرض نتيجة التحقق
 */

import { z } from "zod";
import { publicProcedure, router } from "../trpc";
import { verifyPayload } from "../services/barcodeService";

export const barcodeRouter = router({
  /**
   * يتحقق من payload QR ويُعيد نوع المستند وبياناته إن كان صالحاً.
   * publicProcedure: لا تسجيل دخول مطلوب (العميل يمسح بهاتفه بدون حساب).
   */
  verify: publicProcedure
    // §٧ Input bounds: payload QR عمليّاً <١٠٠ خانة (TYPE|number|date|amount|branchId|hmac).
    // الحدّ الأقصى ١٠٠٠ يحمي من DoS بحمولة عملاقة على إجراء عام بلا مصادقة.
    .input(z.object({ payload: z.string().min(1).max(1000) }))
    .query(({ input }) => {
      return verifyPayload(input.payload);
    }),
});
