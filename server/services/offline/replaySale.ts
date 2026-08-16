// إعادة تشغيل بيعٍ التُقط دون اتصال — الشريحة ٣ من خطة الأوفلاين.
//
// النمط: غلاف رقيق حول createSale نفسه (سابقة dispatchOnlineOrder) — نفس sourceType "POS"
// ونفس clientRequestId اللذين كان سيستعملهما البيع لو تمّ أونلاين ⇒ uq_invoice_source وفحص
// بصمة السلة يعملان بلا تعديل، وبيعٌ نصف-ناجح قبل الانقطاع (وصل الخادم وانقطع الردّ) يُطابَق
// idempotent-ياً بدل الازدواج.
//
// الفروق عن البيع الأونلايني المباشر:
//  - الأسعار تصل كـunitPriceOverride (النقد قُبض فعلاً بالسعر المطبوع على الإيصال المؤقّت) —
//    وحارس البيع تحت التكلفة يبقى فاعلاً (يرفض ⇒ يُعلَّق العنصر لدى العميل لمراجعة المدير).
//  - allowNegativeStock: البضاعة خرجت أثناء الانقطاع؛ التسجيل بسالبٍ موسوم أصدق من الرفض
//    (قرار مالك ١٨/٧). الوسم = originatedOffline + الرقم المؤقّت + capturedAt على الفاتورة.
//  - نافذة الالتقاط: capturedAt المستقبلي (> ٥ دقائق سماحية ساعة جهاز) أو الأقدم من ٧٢ ساعة
//    يُرفض بـPRECONDITION_FAILED — يعلّقه طابور العميل لمراجعة المدير (ش٤) بدل ترحيلٍ أعمى.
//  - نقدي فقط (قرار مالك): طريقة الدفع CASH إلزاماً — الآجل يتطلب اتصالاً (رصيد العميل
//    وسقفه لا يُقيَّمان بأمانة من نسخة محلية قديمة).

import type { Actor } from "../tx";
import { createSale } from "../sale/create";
import type { CreateSaleInput, CreateSaleResult, SaleLineInput } from "../sale/types";
import { assertCaptureWindow, assertCashOnly } from "./captureWindow";

// أُعيد تصدير العتبتين للتوافق مع المستوردين القائمين (الاختبارات/الوثائق) — مصدرهما الآن
// captureWindow.ts المشترك بين كلّ أنواع الكاشير، فلا تنجرف نسختان.
export { OFFLINE_CAPTURE_MAX_AGE_MS, OFFLINE_CAPTURE_FUTURE_TOLERANCE_MS } from "./captureWindow";

export interface ReplayOfflineSaleInput {
  branchId: number;
  shiftId?: number | null;
  customerId?: number | null;
  priceTier?: CreateSaleInput["priceTier"];
  lines: SaleLineInput[];
  invoiceDiscount?: string | null;
  payment: { amount: string; method: "CASH" };
  clientRequestId: string;
  notes?: string | null;
  cashRoundIQD?: boolean;
  /** لحظة البيع الحقيقية على الجهاز (ISO). */
  capturedAt: string;
  /** الرقم المؤقّت OFF-... المطبوع على إيصال الزبون. */
  offlineReceiptNumber: string;
  /** معرّف جهاز الالتقاط — للتدقيق الآن، ولسجلّ الأجهزة في ش٥. */
  deviceId?: string | null;
  /** ش٤: سلطة البيع تحت التكلفة لعنصرٍ عُلِّق FORBIDDEN — يضبطها الراوتر بعد
   *  verifyManagerApproval (أو تلقائياً للمدير/الأدمن المرحِّل). */
  priceOverrideApproved?: boolean;
}

export async function replayOfflineSale(
  input: ReplayOfflineSaleInput,
  actor: Actor,
  options?: { skipCaptureWindow?: boolean },
): Promise<CreateSaleResult> {
  // نافذة الالتقاط ونقديّة الدفع — حرّاسٌ مشتركة (captureWindow.ts) لا نسخةٌ محليّة.
  // `skipCaptureWindow` لمسار استرداد المدير وحده (offline/recovery.ts): عمرُ العنصر هو **سببُ**
  // وجوده في الطابور أصلاً، وقد راجعه إنسانٌ الآن. أمّا حارس الوردية المفتوحة فيبقى نافذاً
  // داخل createSale — الإقفال حدٌّ محاسبيّ لا يُكتب بأثر رجعيّ بأيّ حال.
  const capturedAt = assertCaptureWindow(input.capturedAt, { allowAged: options?.skipCaptureWindow });
  assertCashOnly(input.payment.method);

  return createSale(
    {
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      customerId: input.customerId ?? null,
      priceTier: input.priceTier ?? null,
      sourceType: "POS",
      lines: input.lines,
      invoiceDiscount: input.invoiceDiscount ?? null,
      payment: input.payment,
      clientRequestId: input.clientRequestId,
      notes: input.notes ?? null,
      cashRoundIQD: input.cashRoundIQD ?? false,
      offlineCapture: {
        capturedAt,
        offlineReceiptNumber: input.offlineReceiptNumber,
        deviceId: input.deviceId ?? null,
      },
      allowNegativeStock: true,
      priceOverrideApproved: input.priceOverrideApproved ?? false,
    },
    actor,
  );
}
