export const FIELD_TYPE_LABELS = {
  TEXT: "نص قصير",
  TEXTAREA: "نص طويل للتفاصيل",
  SELECT: "قائمة اختيارات",
  SWATCH: "ألوان أو اختيارات مرئية",
  FILE: "ملف أو رابط تصميم",
  NUMBER: "رقم",
};

export const PRESET_BUTTONS: Array<{
  preset:
    | "LONG_TEXT"
    | "SHORT_TEXT"
    | "CHOICE"
    | "COLOR"
    | "DESIGN_FILE"
    | "NUMBER";
  label: string;
}> = [
  { preset: "LONG_TEXT", label: "تفاصيل يكتبها الزبون" },
  { preset: "SHORT_TEXT", label: "اسم أو عبارة" },
  { preset: "CHOICE", label: "اختيار من قائمة" },
  { preset: "COLOR", label: "اختيار لون" },
  { preset: "DESIGN_FILE", label: "ملف تصميم" },
  { preset: "NUMBER", label: "رقم" },
];

export const KIND_DEFAULTS = {
  GENERAL: {
    title: "خصّص طلبك",
    description: "اكتب التفاصيل التي تريد تنفيذها قبل إضافة المنتج إلى السلة.",
  },
  PRINT: {
    title: "تفاصيل الطباعة أو التصميم",
    description: "اختر طريقة التنفيذ وأرسل النص أو مرجع التصميم المطلوب.",
  },
  GIFT: {
    title: "تفاصيل الهدية",
    description: "أضف بيانات التغليف والمستلم والرسالة قبل الإرسال.",
  },
};
