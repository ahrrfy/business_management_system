import type Decimal from "decimal.js";
import type { CartLine, PayMethod } from "@/components/reception/cartMath";
import { effectivePrice } from "@/components/reception/cartMath";
import type { OrderDeliveryValue } from "@/components/reception/ReceptionTypes";
import { isDisconnected, type ConnState } from "@/lib/offline/connectivity";
import { notify } from "@/lib/notify";
import { D } from "@/lib/money";
export interface ReceptionDigitalValidationInput {
  digitalLines: readonly CartLine[];
  offline: boolean;
  connState: ConnState;
  draftAtSubmit: { id: number; version: number } | null;
  customItems: readonly CartLine[];
  printLines: readonly CartLine[];
  orderDelivery: OrderDeliveryValue | null;
  method: PayMethod;
  deferred: boolean;
  couponCode: string | null;
  rawInvoiceDiscountPctD: Decimal;
  regularLines: readonly CartLine[];
}
export function validateReceptionDigitalCart({
  digitalLines,
  offline,
  connState,
  draftAtSubmit,
  customItems,
  printLines,
  orderDelivery,
  method,
  deferred,
  couponCode,
  rawInvoiceDiscountPctD,
  regularLines,
}: ReceptionDigitalValidationInput) {
  if (digitalLines.length > 0) {
    if (offline || isDisconnected(connState)) {
      notify.err("الكروت والاشتراكات تحتاج اتصالاً فعّالاً بالخادم.");
      return false;
    }
    if (draftAtSubmit) {
      notify.err(
        "لا تُنفّذ الكروت ضمن طلب محفوظ؛ ثبّت الطلب أولاً أو افتح سلة جديدة.",
      );
      return false;
    }
    if (customItems.length > 0 || printLines.length > 0 || orderDelivery) {
      notify.err(
        "افصل الكروت الرقمية عن أوامر الشغل والطباعة والتوصيل في عملية مستقلة.",
      );
      return false;
    }
    if (method !== "CASH") {
      notify.err(
        "بيع الكروت من كاشير الاستقبال متاح نقداً فقط حالياً؛ الدفع بالبطاقة يحتاج إثبات جهاز دفع مرتبطاً بالعملية.",
      );
      return false;
    }
    if (deferred) {
      notify.err("الكروت والاشتراكات لا تقبل البيع الآجل أو الدفع الجزئي.");
      return false;
    }
    if (
      couponCode ||
      rawInvoiceDiscountPctD.gt(0) ||
      regularLines.some(
        (line) => (line.disc ?? 0) > 0 || line.row.promotionId != null,
      )
    ) {
      notify.err(
        "لا تُطبّق الكوبونات أو الخصومات على عملية تحتوي كروتاً رقمية؛ افصلها في فاتورة أخرى.",
      );
      return false;
    }
    const changedDigital = digitalLines.find(
      (line) =>
        line.qty !== 1 ||
        !line.digital ||
        !D(effectivePrice(line)).eq(line.digital.sellPriceSnapshot),
    );
    if (changedDigital) {
      notify.err(
        `بيانات «${changedDigital.row.productName}» تغيّرت؛ احذفها وأعد إضافتها من سلة المزوّد.`,
      );
      return false;
    }
  }

  return true;
}
