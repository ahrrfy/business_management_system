// أسلوب العدّ في جلسة الجرد + طريقة إدخال كل عدّة — المصدر الوحيد للتسمية والقواعد.
//
// المصطلح الحاكم (وثيقة تصميم «الجرد بالباركود» ٢٢/٨):
//   - **أسلوب الجلسة (countMethod):** SCAN_REQUIRED = لا تُفتح بطاقة عدٍّ إلا بمسحٍ فعلي
//     (قارئ HID أو كاميرا)، والاختيار الحر من القائمة ملغى. FREE = السلوك القديم (النقر يفتح
//     البطاقة) — يبقى للحالات الاستثنائية بقرار مدير، ولكل جلسة قديمة أُنشئت قبل هذه الميزة.
//   - **طريقة الإدخال (entryMethod):** نسبُ كل عدّةٍ إلى مصدرها كي يميّز المراجع عدّةً جاءت من
//     مسحٍ فعلي عن رقمٍ كُتب اعتباطاً. الإثبات النهائي **خادميّ دائماً** (submit يُعيد حلّ
//     الباركود الممسوح ويطابقه بالمتغيّر) — هذا الملف تسميةٌ وقاعدةٌ مشتركة لا إنفاذ.
//
// ⚠️ لا شاشة تُعيد تعريف هاتين القائمتين محلّياً (يحرسه اختبارٌ نصّي)، كما في قاموس حالة الفاتورة.

export const COUNT_METHODS = ["SCAN_REQUIRED", "FREE"] as const;
export type CountMethod = (typeof COUNT_METHODS)[number];

/** الافتراضي لكل جلسةٍ جديدة (قرار المالك ٢٢/٨): المسح إلزاميّ ما لم يُختر «الحر» صراحةً بمدير. */
export const DEFAULT_COUNT_METHOD: CountMethod = "SCAN_REQUIRED";

export const COUNT_ENTRY_METHODS = [
  "SCAN_HID", // قارئ باركود USB/بلوتوث (HID)
  "SCAN_CAMERA", // كاميرا الجهاز
  "MANUAL_AUTHORIZED", // استثناء يدويّ محكوم بإذن مشرف (باركود تالف/بلا ملصق/قارئ معطّل)
  "SEARCH_PICK", // فتح البطاقة بالبحث/النقر الحر — مشروعٌ في FREE فقط
] as const;
export type CountEntryMethod = (typeof COUNT_ENTRY_METHODS)[number];

const COUNT_METHOD_LABELS: Record<CountMethod, string> = {
  SCAN_REQUIRED: "مسح إلزامي",
  FREE: "عدّ حر",
};

export function countMethodLabel(m: CountMethod): string {
  return COUNT_METHOD_LABELS[m] ?? m;
}

const COUNT_ENTRY_METHOD_LABELS: Record<CountEntryMethod, string> = {
  SCAN_HID: "مسح قارئ",
  SCAN_CAMERA: "مسح كاميرا",
  MANUAL_AUTHORIZED: "يدوي بإذن",
  SEARCH_PICK: "اختيار من القائمة",
};

export function countEntryMethodLabel(m: CountEntryMethod): string {
  return COUNT_ENTRY_METHOD_LABELS[m] ?? m;
}

export function isCountMethod(v: unknown): v is CountMethod {
  return typeof v === "string" && (COUNT_METHODS as readonly string[]).includes(v);
}

export function isCountEntryMethod(v: unknown): v is CountEntryMethod {
  return (
    typeof v === "string" &&
    (COUNT_ENTRY_METHODS as readonly string[]).includes(v)
  );
}

/** مسحٌ فعليّ (قارئ أو كاميرا) — لا اختيار حر ولا استثناء يدوي. */
export function isScanEntry(m: CountEntryMethod | null | undefined): boolean {
  return m === "SCAN_HID" || m === "SCAN_CAMERA";
}

/**
 * هل تُقبل طريقة الإدخال هذه في جلسةٍ بهذا الأسلوب؟
 * - FREE: كل الطرق مقبولة (entryMethod يُسجَّل للتدقيق لا للإنفاذ).
 * - SCAN_REQUIRED: مسحٌ فعليّ أو استثناء يدويّ محكوم — ويُرفض الاختيار الحر (SEARCH_PICK).
 * ⚠️ هذا فحص تسميةٍ مشترك؛ صحّة الباركود الممسوح تُثبَت خادمياً في submit لا هنا.
 */
export function isEntryMethodAllowed(
  sessionMethod: CountMethod,
  entry: CountEntryMethod,
): boolean {
  if (sessionMethod === "FREE") return true;
  return (
    entry === "SCAN_HID" ||
    entry === "SCAN_CAMERA" ||
    entry === "MANUAL_AUTHORIZED"
  );
}
