/**
 * **عقدُ منتقي روافد الردّ الموحَّد** — `<RefundRailPicker>` مكوّنٌ واحدٌ لكلّ مواضع الردّ
 * (م٢ ق١٠ من خطة v2، ٣/٩/٢٦ — والتعميمُ في م٢ ذيل، ٥/٩/٢٦).
 *
 * ⭐ **لماذا مكوّنٌ جديدٌ رغم وجود `ApprovalRefundRailPicker`؟**
 *
 * القالبُ القائم (`client/src/components/workOrders/ApprovalRefundRailPicker.tsx`) بُني على
 * عقدٍ يعرف أنواعَ مستنداتٍ محدَّدة: يستدعي `trpc.workOrders.refundPreflight` بحمولةٍ فيها
 * `workOrderId + operation`، ويقرأ حالةً بـ`useApprovalRefundChoice` مرتبطاً بتدفّق الاعتماد.
 * صالحٌ لأمر الشغل، غيرُ صالحٍ لمرتجع بيعٍ أو إلغاء فاتورةٍ أو ردّ عربونِ عرضٍ أو مرتجعِ شراء.
 *
 * فبدل ثمانية استدعاءاتٍ لثمانية راوترات، الشاشةُ تعرف **نوعَ المستند ومعرّفَه** فحسب،
 * وتستفتي راوتراً واحداً (`refundRails.preflight`) يفتي بخمسة أسئلةٍ يفرضها الخادمُ:
 *  ① هل يخرج نقدٌ فعلاً؟ (بلا نقد ⇒ لا منتقيَ إطلاقاً)
 *  ② كم؟ (نصٌّ ماليّ بمنزلتَي الدينار — لا تخمينَ عميليّاً)
 *  ③ من أيّ فرع؟ (فرعُ المستند، لا فرعُ الفاعل)
 *  ④ ما الأدراج المؤهَّلة، ورصيدُ الخزينة، وهل تُباح البطاقة؟
 *  ⑤ **أيُّ الروافد يقبله فعلُ التنفيذ أصلاً** — ولِمَ لا (`rails`): رافدٌ يعرضه المنتقي
 *     ويرفضه الفعلُ نهايةٌ مسدودة بثوبٍ جديد؛ فما لا يقبله العقد يُعلَن بسببه ولا يُخفى.
 */
import { z } from "zod";
import type { RefundPreflight } from "./refundPreflight";
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
 * القاعدةُ: **لا نوعٌ يُقبَل هنا قبل أن يكون له تمهيدٌ حقيقيّ في الخدمة** — وإلّا ادّعى المنتقي
 * إجابةً لا تُنفَّذ. الأربعةُ اليوم لها تمهيدٌ فعليّ في
 * [`server/services/refundRailService.ts`](../server/services/refundRailService.ts).
 */
export const REFUND_SOURCE_DOC_TYPES = [
  "WORKORDER_CANCEL",
  "WORKORDER_REVERSE_DELIVERY",
  "CONSIGNMENT_RETURN",
  "SALE_RETURN",
] as const;

export type RefundSourceDocType = (typeof REFUND_SOURCE_DOC_TYPES)[number];

/** التسميةُ العربية للنوع — لرسائل الخطأ (شاشة/خادم) عند رفضٍ مقروء. */
export const REFUND_SOURCE_DOC_LABEL: Record<RefundSourceDocType, string> = {
  WORKORDER_CANCEL: "إلغاء طلب خدمة",
  WORKORDER_REVERSE_DELIVERY: "عكسُ تسليم طلب خدمة",
  CONSIGNMENT_RETURN: "إرجاعُ إرسالية توصيل",
  SALE_RETURN: "مرتجع بيع",
};

/**
 * **حمولةُ استفتاء المنتقي** — ما يُرسِله العميلُ للخادم.
 *
 * ⚠️ الخادمُ **يحسب المبلغَ بنفس مسار التنفيذ** فلا انحرافَ بين ما تعرضه الشاشة وما يقرّره.
 * الاستثناءُ الوحيد `amount`: في **مرتجع البيع** المبلغُ قرارُ الموظّف (≤ الوعاء) لا اشتقاقٌ من
 * المستند، فيصل ليُقاس به كفايةُ الأدراج والخزينة؛ غيابُه يعني «الوعاءُ كلُّه». الخادمُ يقصّه
 * بالوعاء ولا يثق به.
 */
export const RefundRailContextSchema = z.object({
  sourceDocType: z.enum(REFUND_SOURCE_DOC_TYPES),
  sourceDocId: z.number().int().positive(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح").optional(),
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

// ═══════════════════ توفّرُ الروافد — ما يقبله فعلُ التنفيذ فعلاً ═══════════════════

/**
 * توفّرُ رافدٍ واحد. `reason` حين لا يتوفّر **نصٌّ للموظّف**: يذكر المخرجَ القائم أو يعترف
 * صراحةً بأنّ المسار لم يُبنَ بعد — لا إخفاءَ صامتاً (كان المنتقي يعرض «الخزينة» لعكس التسليم
 * وإرجاع الإرسالية بينما فعلُهما لا يقبلها: نهايةٌ مسدودة بثوبٍ جديد — Codex #960).
 */
export interface RefundRailAvailability {
  available: boolean;
  reason: string | null;
}

export type RefundRailAvailabilityMap = Record<RefundRail, RefundRailAvailability>;

/** التمهيدُ الموحَّد كما يُعيده `refundRails.preflight`: التمهيدُ الماليّ + خريطةُ الروافد. */
export type RefundRailPreflightResult = RefundPreflight & { rails: RefundRailAvailabilityMap };

const OK: RefundRailAvailability = { available: true, reason: null };

/**
 * ⭐ **سياسةُ الروافد لكلّ نوع مستند — دالّةٌ نقيّة واحدة يستعملها الخادمُ والشاشةُ معاً.**
 *
 * الخادمُ يبنيها في التمهيد الموحَّد، والشاشةُ تستعملها حين يصلها تمهيدٌ من مسارٍ آخر (تمهيدُ
 * الاعتماد في `controlPreflight`) — فلا يوجد تعريفان ينجرفان. المدخلاتُ حقائقُ التمهيد وحدها.
 *
 * ⛔ ما يُعلَن هنا «لم يُبنَ» **يبقى معلَناً** حتى يُبنى فعلاً: لا تُفتح الخزينةُ لعكس التسليم أو
 * إرجاع الإرسالية قبل أن يقبلها عقدُ الطلب (`workOrderReversePayload` في `workOrderRouter` +
 * `ReverseDeliveryControlPayload` في `controlRequests.ts`) وفعلُ `delivery.returnConsignment` —
 * وكلاهما خارج هذه الشريحة (ق١٠: «المفتاح الناقص»).
 */
export function refundRailAvailability(
  sourceDocType: RefundSourceDocType,
  preflight: Pick<RefundPreflight, "drawers" | "cardRefundAllowed">,
  /**
   * هل يملك **المنفِّذ** الصرفَ من الخزينة؟ يهمّ مرتجعَ البيع (المنفِّذ هو الطالب). في عكس التسليم
   * المنفِّذُ هو المعتمِد (مديرٌ بحكم فصل المهام) فلا يُقاس على الطالب.
   */
  actorMayUseTreasury = true,
): RefundRailAvailabilityMap {
  const hasOpenDrawer = preflight.drawers.length > 0;
  const card: RefundRailAvailability = preflight.cardRefundAllowed
    ? OK
    : { available: false, reason: "الردُّ على البطاقة غير متاح لهذا المستند — جزءٌ نقديٌّ محتجَز أو تفويضٌ لا يقبل البطاقة" };
  switch (sourceDocType) {
    case "WORKORDER_CANCEL":
      return { DRAWER: OK, TREASURY: OK, CARD: card };
    case "WORKORDER_REVERSE_DELIVERY":
      // ⭐ المفتاحُ الناقص (ق١٠): بلا وردية استقبال مفتوحة يخرج الردُّ عند **الاعتماد** من الخزينة بصفة
      // المعتمِد (مدير/أدمن) تحت استثناء `WORK_ORDER_REVERSE_DELIVERY_COMPENSATION` — لا حمولةَ جديدة:
      // الطلبُ بلا `refundShiftId` والخدمةُ تختار الخزينة حين لا درج. والدرجُ الصريح يفوز دائماً.
      return {
        DRAWER: hasOpenDrawer ? OK : { available: false, reason: "لا وردية استقبال مفتوحة في هذا الفرع يخرج منها النقد" },
        TREASURY: hasOpenDrawer
          ? { available: false, reason: "توجد وردية استقبال مفتوحة — يخرج ردّ عكس التسليم من درجها لا من الخزينة" }
          : OK,
        CARD: { available: false, reason: "عكسُ التسليم يردّ بطريقة القبض ولا يقبل تحويلاً إلى بطاقة" },
      };
    case "CONSIGNMENT_RETURN":
      return {
        DRAWER: OK,
        TREASURY: {
          available: false,
          reason: "إرجاعُ الإرسالية يقبل درجاً مفتوحاً فقط (delivery.returnConsignment لا يحمل رافد الخزينة بعد) — افتح وردية أو موّل الدرج من الخزينة ثمّ أعد المحاولة",
        },
        CARD: { available: false, reason: "إرجاعُ الإرسالية يردّ ما قُبض نقداً ولا يقبل بطاقة" },
      };
    case "SALE_RETURN":
      return {
        DRAWER: hasOpenDrawer ? OK : { available: false, reason: "لا وردية مفتوحة في هذا الفرع يخرج منها النقد" },
        // مرآةُ `shiftIdForCashTx`: الخزينةُ مخرجُ الإداريّ حين لا وردية مفتوحة — لا بديلٌ يُختار بجانب الدرج.
        TREASURY: hasOpenDrawer
          ? { available: false, reason: "توجد وردية مفتوحة — يخرج النقد من درجها لا من الخزينة" }
          : actorMayUseTreasury
            ? OK
            : { available: false, reason: "الصرفُ من الخزينة بلا وردية مفتوحة صلاحيةُ المدير أو الأدمن — افتح وردية أو اطلب من المدير تنفيذ المرتجع" },
        CARD: card,
      };
  }
}

/** الروافدُ المتاحة بالترتيب المعتمد — ما يعرضه المنتقي رقاقاتٍ قابلةً للاختيار. */
export function availableRefundRails(rails: RefundRailAvailabilityMap): RefundRail[] {
  return REFUND_RAILS.filter((rail) => rails[rail].available);
}
