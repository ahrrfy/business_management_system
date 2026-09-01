/**
 * **روافدُ ردّ العربون** — من أين يخرج المال حين يُلغى أمرُ الشغل.
 *
 * الحاجةُ من بلاغٍ حيّ للمالك (١/٩): عربونٌ نقديّ ٧٠٬٠٠٠ وأدراجُ الاستقبال المفتوحة تحمل
 * ٥٦٬٠٠٠ و٥٣٬٠٠٠ — **لا درجَ واحدٌ يغطّيه**. فالردّ من درجٍ وحده بابٌ مسدود واقعيّ لا نظريّ،
 * ولا يُعالَج بمنتقٍ مهما أُحسِن: المشكلةُ في المصدر لا في الاختيار.
 *
 * ⚠️ **الروافدُ الثلاثة ليست متكافئةً محاسبياً — ولذلك لا تُشتقّ إحداها من أخرى:**
 *
 * | الرافد | الأصل | الحالة عند الإنشاء | الأثر |
 * |---|---|---|---|
 * | `DRAWER`   | `CASH` + `cashBucket=DRAWER`   | مكتملٌ فوراً | يَخصم من تسوية الدرج وZ-report |
 * | `TREASURY` | `CASH` + `cashBucket=TREASURY` | مكتملٌ فوراً | يَخصم من خزينة الفرع، **لا يمسّ درجاً** |
 * | `CARD`     | `CARD` + `cashBucket=NULL`     | **معلّقٌ باعتماد** | لا مال يخرج حتى التنفيذ الخارجيّ وإقراره |
 *
 * و`CARD` **يخالف قاعدة «يُردّ بطريقة قبضه»** عن قصدٍ وبقرار المالك (١/٩): عربونٌ قُبض نقداً
 * يُردّ على بطاقة. ولذلك يلزمه **مرجعُ تنفيذٍ خارجيّ** ويمرّ بمسار الاعتماد نفسه الذي يحكم كلّ
 * ردٍّ غير نقديّ — فلا يُسجَّل قيدُ دفعٍ ولا يُصرف دينارٌ قبل أن يُقرّ المالك وقوعَ الاسترداد
 * فعلاً على جهاز الدفع (§٥: لا دينار يخرج بلا إيصالٍ وقيدٍ ومسارٍ وفاعل).
 */

export const REFUND_RAILS = ["DRAWER", "TREASURY", "CARD"] as const;
export type RefundRail = (typeof REFUND_RAILS)[number];

/** التسمية العربية — مصدرٌ واحد؛ ⛔ لا شاشة تُعيد تعريفها محلّياً. */
export const REFUND_RAIL_LABEL: Record<RefundRail, string> = {
  DRAWER: "درج الاستقبال",
  TREASURY: "الخزينة الإدارية",
  CARD: "بطاقة (استرداد خارجيّ)",
};

/** جملةٌ تشرح أثرَ الرافد قبل الاختيار — لا بعده. */
export const REFUND_RAIL_HINT: Record<RefundRail, string> = {
  DRAWER: "يخرج النقد من درج الوردية المختارة فوراً، ويظهر في تسويتها.",
  TREASURY: "يخرج النقد من خزينة الفرع فوراً، ولا يمسّ أيّ درج ولا تسوية وردية.",
  CARD: "يُنشئ طلبَ استرداد معلّقاً — لا يخرج مال ولا يُسجَّل قيد حتى تنفّذه على جهاز الدفع ويعتمده المالك.",
};

/** أيلزم هذا الرافدَ تحديدُ درج؟ — `DRAWER` وحده. */
export function refundRailNeedsShift(rail: RefundRail): boolean {
  return rail === "DRAWER";
}

/** أيلزمه مرجعُ تنفيذٍ خارجيّ؟ — `CARD` وحده (إثباتُ وقوع الاسترداد على الجهاز). */
export function refundRailNeedsReference(rail: RefundRail): boolean {
  return rail === "CARD";
}

/** أيخرج المالُ فوراً؟ `CARD` معلّقٌ باعتماد المالك، والنقديّان فوريّان. */
export function refundRailIsImmediate(rail: RefundRail): boolean {
  return rail !== "CARD";
}

/** طريقةُ الدفع ودلوُ النقد المكتوبان على الإيصال — مصدرٌ واحد للطرفين. */
export function refundRailReceiptShape(rail: RefundRail): {
  paymentMethod: "CASH" | "CARD";
  cashBucket: "DRAWER" | "TREASURY" | null;
} {
  if (rail === "DRAWER") return { paymentMethod: "CASH", cashBucket: "DRAWER" };
  if (rail === "TREASURY") return { paymentMethod: "CASH", cashBucket: "TREASURY" };
  return { paymentMethod: "CARD", cashBucket: null };
}
