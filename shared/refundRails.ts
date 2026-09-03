/**
 * **عقدُ منتقي روافد الردّ الموحَّد** — `<RefundRailPicker>` مكوّنٌ واحدٌ لثمانية مواضع
 * (م٢ ق١٠ من خطة v2، ٣/٩/٢٦).
 *
 * ⭐ **لماذا مكوّنٌ جديدٌ رغم وجود `ApprovalRefundRailPicker`؟**
 *
 * القالبُ القائم (`client/src/components/workOrders/ApprovalRefundRailPicker.tsx`) بُني على
 * عقدٍ يعرف أنواعَ مستنداتٍ محدَّدة: يستدعي `trpc.workOrders.refundPreflight` بحمولةٍ فيها
 * `workOrderId + operation`، ويقرأ حالةً بـ`useApprovalRefundChoice` مرتبطاً بتدفّق الاعتماد.
 * صالحٌ لأمر الشغل، غيرُ صالحٍ لمرتجع بيعٍ أو إلغاء فاتورةٍ أو ردّ عربونِ عرضٍ أو مرتجعِ شراء.
 *
 * فبدل ثمانية استدعاءاتٍ لثمانية راوترات، الشاشةُ تعرف **نوعَ المستند ومعرّفَه** فحسب،
 * وتستفتي راوتراً واحداً (`refundRails.preflight`) يفتي بأربعة أسئلةٍ يفرضها الخادمُ:
 *  ① هل يخرج نقدٌ فعلاً؟ (بلا نقد ⇒ لا منتقيَ إطلاقاً)
 *  ② كم؟ (نصٌّ ماليّ بمنزلتَي الدينار — لا تخمينَ عميليّاً)
 *  ③ من أيّ فرع؟ (فرعُ المستند، لا فرعُ الفاعل)
 *  ④ ما الأدراج المؤهَّلة، ورصيدُ الخزينة، وهل تُباح البطاقة؟
 *
 * وبذلك يُغلَق «رقمُ ورديةٍ يُكتَب يدوياً» و«ثمانية سلوكيات» ونهاياتُ الطريق المسدودة عن
 * فاتورةٍ مدفوعةٍ بالبطاقة كاملاً بلا وردية مفتوحة (يذكرها `shared/refundPreflight.ts`).
 *
 * ⛔ **هذه الشريحة لا تُوصِل المكوّنَ إلى المستهلكين الثمانية.** التوصيلُ شريحةٌ لاحقة
 * (م٢ ق١٠ب): بناءُ الأنابيب (العقد + الخدمة + الراوتر + المكوّن) هنا، وقلبُ المستهلكين إلى
 * المكوّن الجديد وحذفُ نظائرهم المحلّية هناك.
 */
import { z } from "zod";
import {
  REFUND_RAILS,
  REFUND_RAIL_HINT,
  REFUND_RAIL_LABEL,
  refundRailIsImmediate,
  refundRailNeedsReference,
  refundRailNeedsShift,
  refundRailReceiptShape,
  type RefundRail,
} from "./refundRail";

export {
  REFUND_RAILS,
  REFUND_RAIL_HINT,
  REFUND_RAIL_LABEL,
  refundRailIsImmediate,
  refundRailNeedsReference,
  refundRailNeedsShift,
  refundRailReceiptShape,
};
export type { RefundRail };

/**
 * **أنواعُ المستندات التي قد تُولّد ردَّ مال** — مصدرٌ واحد يعرفه الطرفان.
 *
 * تُضاف إليها الأنواعُ في شريحةٍ لاحقة (م٢ ق١٠ب) كلّما بُني تمهيدُها الخادميّ (مرتجعُ بيع،
 * إلغاءُ فاتورة، مرتجعُ شراء…). القاعدةُ: **لا نوعٌ يُقبَل هنا قبل أن يكون له تمهيدٌ حقيقيّ
 * في الخدمة** — وإلّا ادّعى المنتقي إجابةً لا تُنفَّذ. ثلاثةُ أنواعٍ اليوم لأنّ لها تمهيداً
 * فعلياً في [`server/services/workOrder/refundPreflight.ts`](../server/services/workOrder/refundPreflight.ts).
 */
export const REFUND_SOURCE_DOC_TYPES = [
  "WORKORDER_CANCEL",
  "WORKORDER_REVERSE_DELIVERY",
  "CONSIGNMENT_RETURN",
] as const;

export type RefundSourceDocType = (typeof REFUND_SOURCE_DOC_TYPES)[number];

/** التسميةُ العربية للنوع — لرسائل الخطأ (شاشة/خادم) عند رفضٍ مقروء. */
export const REFUND_SOURCE_DOC_LABEL: Record<RefundSourceDocType, string> = {
  WORKORDER_CANCEL: "إلغاء طلب خدمة",
  WORKORDER_REVERSE_DELIVERY: "عكسُ تسليم طلب خدمة",
  CONSIGNMENT_RETURN: "إرجاعُ إرسالية توصيل",
};

/**
 * **حمولةُ استفتاء المنتقي** — ما يُرسِله العميلُ للخادم.
 *
 * ⚠️ لا يوجد `amount` هنا: التخمينُ العميليّ لِـ«كم سيخرج» أنتج ثلاثةَ حوائطَ أُغلقت
 * في `shared/refundPreflight.ts`. الخادمُ **يحسب المبلغَ بنفس مسار التنفيذ** فلا انحرافَ
 * بين ما تعرضه الشاشة وما يقرّره الخادم.
 */
export const RefundRailContextSchema = z.object({
  sourceDocType: z.enum(REFUND_SOURCE_DOC_TYPES),
  sourceDocId: z.number().int().positive(),
});
export type RefundRailContext = z.infer<typeof RefundRailContextSchema>;

/**
 * **اختيارُ المنتقي** — ما يُسلّمه المكوّن للحوار الأب.
 *
 * الحقول المشروطة (`refundShiftId`/`cardReference`) تُملأ **حين يلزمها** الرافدُ فقط
 * (§٥: لكلّ رافدٍ رقاقتُه). التحقّقُ من كمال الاختيار وظيفةٌ خادميّة عند التنفيذ لا شاشية.
 */
export type RefundRailSelection = {
  rail: RefundRail;
  /** لازمٌ لِـ`DRAWER` فقط — درجُ الوردية المفتوحة الذي سيخرج منه النقد. */
  refundShiftId?: number;
  /** لازمٌ لِـ`CARD` فقط — مرجعُ عملية الاسترداد على جهاز الدفع. */
  cardReference?: string;
};

/**
 * **الحدُّ الأدنى لمرجع البطاقة** — سلّةٌ واحدة تحرسها الخدمةُ عند التنفيذ **ونعرضها للشاشة**
 * كي لا يُبنى شرطُ التعطيل بيدَين متباعدتَين تنجرفان. مطابقٌ لِـ`ApprovalRefundRailPicker`
 * (٣ محارف). لا نحاول إثباتَ صحّة المرجع هنا — إثباتُه بالجهاز والاعتماد لا بالطول.
 */
export const CARD_REFERENCE_MIN_LENGTH = 3;
export const CARD_REFERENCE_MAX_LENGTH = 100;

/** المرجعُ ناقصٌ؟ — منطقٌ مشترك: الرافدُ بطاقة **و**الطولُ أدنى من العتبة. */
export function cardReferenceIsMissing(rail: RefundRail, reference: string | null | undefined): boolean {
  if (!refundRailNeedsReference(rail)) return false;
  return (reference ?? "").trim().length < CARD_REFERENCE_MIN_LENGTH;
}
