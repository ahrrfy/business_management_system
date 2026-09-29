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

const verifyInputSchema = z.object({
  payload: z.string().max(1000).optional(),
  ref: z.string().max(1000).optional(),
  id: z.string().max(1000).optional(),
  number: z.string().max(1000).optional(),
});

export const barcodeRouter = router({
  /**
   * يتحقق من payload QR أو مرجع المستند ويُعيد نوع المستند وبياناته إن كان صالحاً.
   * publicProcedure: لا تسجيل دخول مطلوب (العميل يمسح بهاتفه بدون حساب).
   * يقبل بصيغة مرنة { payload?: string, ref?: string, id?: string } أو { payload: string }.
   */
  verify: publicProcedure
    // §٧ Input bounds: payload QR عمليّاً <١٠٠ خانة (TYPE|number|date|amount|branchId|hmac).
    // الحدّ الأقصى ١٠٠٠ يحمي من DoS بحمولة عملاقة على إجراء عام بلا مصادقة.
    .input(verifyInputSchema)
    .query(async ({ input }) => {
      try {
        const code =
          ("payload" in input && input.payload?.trim()) ||
          ("ref" in input && input.ref?.trim()) ||
          ("id" in input && input.id?.trim()) ||
          ("number" in input && input.number?.trim()) ||
          "";

        if (!code) {
          return { valid: false };
        }

        return await verifyPayload(code);
      } catch {
        return { valid: false };
      }
    }),
});
