// إعادة تشغيل بيع خدمات طباعةٍ التُقط دون اتصال — تعميم الأوفلاين على كاشير الطباعة.
//
// النمط نفسه المُثبَت في replaySale: غلافٌ رقيق حول `createPrintSale` بنفس `clientRequestId`
// الذي كان سيستعمله البيع أونلاين ⇒ فحص `invoices.sourceId` داخل createPrintSaleInTx يجعل
// إعادة الإرسال idempotent، وبيعٌ نصف-ناجح قبل الانقطاع يُطابَق بدل أن يُزدوَج.
//
// فروقٌ جوهريّة عن كاشير التجزئة تُبرِّر مساراً مستقلاً لا إعادة استعمال replaySale:
//  - خدمات الطباعة تُسعَّر يدوياً (`unitPriceOverride` جزءٌ من طبيعة الشاشة لا استثناء).
//  - `createPrintSale` يخصم **المواد** بصمت (ورق/حبر) لا الصنف المُباع نفسه.
//  - الوردية من نوع PRINT_SERVICES، وبوّابتها `pos` لا `sales`.
import type { Actor } from "../tx";
import { createPrintSale } from "../printSaleService";
import type { CreatePrintSaleInput, CreatePrintSaleResult, PrintSaleLineInput } from "../printSaleService";
import { assertCaptureWindow, assertCashOnly } from "./captureWindow";

export interface ReplayOfflinePrintSaleInput {
  branchId: number;
  shiftId?: number | null;
  customerId?: number | null;
  priceTier?: CreatePrintSaleInput["priceTier"];
  lines: PrintSaleLineInput[];
  payment: { amount: string; method: "CASH" };
  clientRequestId: string;
  notes?: string | null;
  cashRoundIQD?: boolean;
  contactName?: string | null;
  contactPhone?: string | null;
  /** لحظة البيع الحقيقية على الجهاز (ISO). */
  capturedAt: string;
  /** الرقم المؤقّت OFF-… المطبوع على إيصال الزبون. */
  offlineReceiptNumber: string;
  deviceId?: string | null;
  /** سلطة البيع تحت التكلفة لعنصرٍ عُلِّق FORBIDDEN — يضبطها الراوتر بعد التحقّق. */
  priceOverrideApproved?: boolean;
}

export async function replayOfflinePrintSale(
  input: ReplayOfflinePrintSaleInput,
  actor: Actor,
): Promise<CreatePrintSaleResult> {
  const capturedAt = assertCaptureWindow(input.capturedAt);
  assertCashOnly(input.payment.method);

  return createPrintSale(
    {
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      customerId: input.customerId ?? null,
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone ?? null,
      priceTier: input.priceTier ?? null,
      lines: input.lines,
      payment: input.payment,
      clientRequestId: input.clientRequestId,
      notes: input.notes ?? null,
      cashRoundIQD: input.cashRoundIQD ?? false,
      offlineCapture: {
        capturedAt,
        offlineReceiptNumber: input.offlineReceiptNumber,
        deviceId: input.deviceId ?? null,
      },
      // ملاحظة: لا حاجة لـallowNegativeStock هنا — استهلاك المواد في createPrintSale
      // يمرّ أصلاً بـallowNegative: true (الخدمة لا تُرفض عند نفاد المادة، والاستهلاك يبقى مُتعقَّباً).
      priceOverrideApproved: input.priceOverrideApproved ?? false,
    },
    actor,
  );
}
