// عقود حزمة خدمات محطة خدمة الزبائن (Reception) — ش١ من الوثيقة الحاكمة
// docs/reception-cashier-system-design-2026-08-05.md §٦-§٧.

export type ReceptionDeliveryState = "ALL" | "NOT_DISPATCHED" | "DISPATCHED" | "DELIVERED";
/** UNSETTLED = غير مسدَّدة (معلّقة + جزئية معاً) — رقاقة الطابور الشائعة. */
export type ReceptionPaymentState = "ALL" | "UNSETTLED" | "UNPAID" | "PARTIAL" | "PAID";
export type ReceptionPayMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";

export interface ReceptionInvoiceQueueInput {
  branchId: number;
  /** ورديات بعينها (رقاقة «ورديتي»). فارغة ⇒ نطاق زمني عبر sinceDays. */
  shiftIds?: number[];
  /** 0 = اليوم (بحدّ businessDay UTC)، 7 = أسبوع… يُتجاهَل عند تمرير shiftIds. */
  sinceDays?: number;
  /** بحث: رقم فاتورة / اسم أو هاتف الزبون (المسجَّل أو العابر) / رقم الإيصال المؤقّت. */
  q?: string;
  deliveryState?: ReceptionDeliveryState;
  paymentState?: ReceptionPaymentState;
  method?: ReceptionPayMethod;
  cursor?: number;
  limit?: number;
}

export interface CollectOnInvoiceInput {
  invoiceId: number;
  amount: string;
  method: ReceptionPayMethod;
  reference?: string | null;
  clientRequestId: string;
}
