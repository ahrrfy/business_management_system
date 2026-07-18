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

import { TRPCError } from "@trpc/server";
import type { Actor } from "../tx";
import { createSale } from "../sale/create";
import type { CreateSaleInput, CreateSaleResult, SaleLineInput } from "../sale/types";

export const OFFLINE_CAPTURE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const OFFLINE_CAPTURE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

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
): Promise<CreateSaleResult> {
  // نافذة الالتقاط — فسادها قرار مراجعة بشرية لا ترحيل صامت.
  const capturedAt = new Date(input.capturedAt);
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
      message: "بيع أوفلايني أقدم من ٧٢ ساعة — يتطلب مراجعة المدير قبل الترحيل",
    });
  }
  if (input.payment.method !== "CASH") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الأوفلاين نقدي فقط — الآجل يتطلب اتصالاً" });
  }

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
      },
      allowNegativeStock: true,
      priceOverrideApproved: input.priceOverrideApproved ?? false,
    },
    actor,
  );
}
