/**
 * اسم توافق لمسارات نقاط البيع والاستقبال. التنفيذ الحاكم موحّد مع كل قبض
 * يدخله الموظف، كي لا تنجرف سياسة POS عن بقية منافذ القبض مستقبلاً.
 */
import { assertInboundPaymentMethodEnabled } from "./inboundPaymentPolicy";

export function assertPosPaymentMethodEnabled(method: string | null | undefined): void {
  assertInboundPaymentMethodEnabled(method);
}
