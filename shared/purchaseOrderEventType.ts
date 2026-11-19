/**
 * أنواع أحداث أوامر الشراء وحقول المقارنة — مصدر الحقيقة الوحيد للتعريب.
 */

export const PURCHASE_ORDER_EVENT_LABELS: Record<string, string> = {
  ORDER_CREATED: "إنشاء أمر شراء",
  ORDER_SUBMITTED: "إرسال للاعتماد",
  REVISION_CREATED: "حفظ نسخة معدلة",
  PAYMENT_SOURCE_REVISED: "تعديل مصدر السداد",
  PAYMENT_REQUESTED: "طلب اعتماد سداد",
  PAYMENT_SETTLED: "تثبيت السداد",
  SHIPPING_SETTLED_FROM_DRAWER: "سداد الشحن من الدرج",
  APPROVE_REVISION_REQUESTED: "طلب اعتماد النسخة",
  APPROVE_REVISION_STALE: "تجاوز طلب الاعتماد",
  APPROVE_REVISION_REJECTED: "رفض الاعتماد",
  APPROVE_REVISION_APPROVED: "اعتماد أمر الشراء",
  CANCEL_ORDER_REQUESTED: "طلب إلغاء الأمر",
  CANCEL_ORDER_STALE: "انتهاء صلاحية طلب الإلغاء",
  CANCEL_ORDER_REJECTED: "رفض إلغاء الأمر",
  CANCEL_ORDER_APPROVED: "اعتماد إلغاء الأمر",
  EMERGENCY_ORDER_REQUESTED: "طلب اعتماد طارئ",
  EMERGENCY_ORDER_STALE: "انتهاء صلاحية الطلب الطارئ",
  EMERGENCY_ORDER_REJECTED: "رفض الطلب الطارئ",
  EMERGENCY_ORDER_APPROVED: "اعتماد الطلب الطارئ",
  RECEIPT_POSTED: "ترحيل استلام بضاعة",
  RECEIPT_REVERSED: "عكس استلام بضاعة",
};

export function purchaseOrderEventLabel(
  eventType: string | null | undefined,
): string {
  if (!eventType) return "حركة";
  return PURCHASE_ORDER_EVENT_LABELS[eventType] ?? "تحديث أمر شراء";
}

export const PURCHASE_REVISION_HEAD_LABELS: Record<string, string> = {
  supplierId: "المورد",
  agreedCurrency: "العملة",
  agreedRate: "سعر الصرف",
  settlementType: "نوع التسوية",
  paymentSource: "مصدر سداد البضاعة",
  expectedDeliveryDate: "تاريخ التسليم المتوقع",
  subtotal: "المجموع",
  taxAmount: "الضريبة",
  shippingCost: "الشحن",
  shippingFundingSource: "حالة سداد الشحن",
  shippingFundingShiftId: "وردية سداد الشحن",
  customsCost: "الكمرك",
  invoiceDiscount: "خصم فاتورة المورد",
  total: "الإجمالي",
  usdTotal: "إجمالي الدولار",
  notesSnapshot: "الملاحظات",
};

const PURCHASE_REVISION_VALUE_AR: Record<string, string> = {
  CASH: "نقدي — دفع فوري",
  CREDIT: "آجل — ذمة مورد",
  IQD: "دينار عراقي (IQD)",
  USD: "دولار أمريكي (USD)",
  PAID: "مسدد",
  UNPAID: "غير مسدد",
  DRAWER: "درج الكاشير",
  TREASURY: "الخزينة الإدارية",
  CARD: "بطاقة مصرفية",
};

export function formatPurchaseRevisionHeadValue(
  field: string,
  value: unknown,
): string {
  if (value == null || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  const raw = String(value);
  if (
    field === "settlementType" ||
    field === "agreedCurrency" ||
    field === "shippingFundingSource"
  ) {
    return PURCHASE_REVISION_VALUE_AR[raw] ?? raw;
  }
  return raw;
}

export function formatPurchaseEventActor(
  actorName: string | null | undefined,
  actorUserId?: number | null,
): string {
  const clean = actorName?.trim();
  if (clean) return clean;
  if (actorUserId != null && actorUserId > 0) return `حساب #${actorUserId}`;
  return "النظام";
}

export const PURCHASE_ORDER_STATUS_LABELS: Record<string, string> = {
  DRAFT: "مسودة",
  SENT: "بانتظار الاعتماد",
  CONFIRMED: "بانتظار الاعتماد",
  APPROVED: "معتمد",
  PARTIALLY_RECEIVED: "مستلم جزئياً",
  RECEIVED: "مستلم",
  CANCELLED: "ملغى",
  REJECTED: "مرفوض",
  CLOSED: "مغلق",
};

export function purchaseOrderStatusLabel(
  status: string | null | undefined,
): string {
  if (!status) return "—";
  return PURCHASE_ORDER_STATUS_LABELS[status] ?? status;
}

