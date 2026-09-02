export const SALES_CONTROL_TYPES = [
  "SALES_RETURN",
  "SALES_CANCEL",
  "SALES_REISSUE",
  "SALES_EXCHANGE",
  "SALES_DUE_DATE_CHANGE",
] as const;

export type SalesControlType = (typeof SALES_CONTROL_TYPES)[number];

export const SALES_CONTROL_TYPE_LABELS: Record<SalesControlType, string> = {
  SALES_RETURN: "مرتجع بيع",
  SALES_CANCEL: "إلغاء فاتورة",
  SALES_REISSUE: "إعادة إصدار",
  SALES_EXCHANGE: "استبدال أصناف",
  SALES_DUE_DATE_CHANGE: "تغيير تاريخ الاستحقاق",
};

export const SALES_CONTROL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "STALE", "WITHDRAWN"] as const;
export type SalesControlStatus = (typeof SALES_CONTROL_STATUSES)[number];

export const SALES_CONTROL_STATUS_LABELS: Record<SalesControlStatus, string> = {
  PENDING: "بانتظار الاعتماد",
  APPROVED: "معتمد ومنفّذ",
  REJECTED: "مرفوض",
  STALE: "قديم بسبب تغيّر الفاتورة",
  WITHDRAWN: "مسحوب من الطالب",
};
