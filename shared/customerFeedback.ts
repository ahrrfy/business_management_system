/**
 * مصدر الحقيقة الموحّد لتصنيفات التغذية العكسية ومحطات الخلل وحالات الشكاوى التشغيلية
 *
 * صفر إيموجي — قاموس موحد يمنع الانجراف وازدواج التسميات بين الخادم والواجهة.
 */

export const FEEDBACK_CATEGORIES = [
  "COLOR_QUALITY",
  "PRINT_DELAY",
  "CUTTING",
  "LAMINATION",
  "DELIVERY",
  "SERVICE",
  "PACKAGING",
  "GENERAL",
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  COLOR_QUALITY: "جودة وتطابق الألوان",
  PRINT_DELAY: "تأخير في موعد التسليم",
  CUTTING: "دقة القص والأبعاد",
  LAMINATION: "جودة السلفنة والتجليد",
  DELIVERY: "مشاكل الشحن والتوصيل",
  SERVICE: "خدمة العملاء والاستقبال",
  PACKAGING: "التغليف والحماية",
  GENERAL: "ملاحظات عامة",
};

export const ROOT_CAUSE_STATIONS = [
  "PRINTING",
  "CUTTING",
  "LAMINATION",
  "DESIGN",
  "DELIVERY",
  "RECEPTION",
  "OTHER",
] as const;

export type RootCauseStation = (typeof ROOT_CAUSE_STATIONS)[number];

export const ROOT_CAUSE_STATION_LABELS: Record<RootCauseStation, string> = {
  PRINTING: "محطة الطباعة الرقمية (Digital)",
  CUTTING: "محطة القص والتشطيب (Finishing)",
  LAMINATION: "محطة السلفنة والحراري",
  DESIGN: "قسم التصميم والمونتاج",
  DELIVERY: "فريق التوصيل والشحن",
  RECEPTION: "الاستقبال والمبيعات",
  OTHER: "أخرى / عام",
};

export const ISSUE_STATUSES = [
  "NEW",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  NEW: "شكوى جديدة",
  IN_PROGRESS: "قيد المعالجة والمتابعة",
  RESOLVED: "تم الحل والتعويض",
  CLOSED: "مغلقة نهائياً",
};

export const SENTIMENTS = ["POSITIVE", "NEUTRAL", "NEGATIVE"] as const;

export type Sentiment = (typeof SENTIMENTS)[number];

export const SENTIMENT_LABELS: Record<Sentiment, string> = {
  POSITIVE: "إيجابي",
  NEUTRAL: "محايد",
  NEGATIVE: "سلبي",
};
