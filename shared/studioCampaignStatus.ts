/**
 * قاموس حالات حملة استوديو المنتجات — **المصدر الوحيد** للتسميات وتحوّلات الحالة
 * وأدوار العرض. أيّ شاشةٍ تُعرِّف نصّاً محلياً هنا (كما كانت الشاشة الأصلية تكتب
 * `selectedCampaign.status` خاماً) يجب استبدالُه بالوصولِ إلى `STUDIO_CAMPAIGN_STATUS_AR`
 * وحده — الدرس من [`shared/invoiceStatus.ts`] و[`shared/receptionChannel.ts`]:
 * قاموسٌ منجرفٌ في سبع شاشات = سبعُ حقائق.
 *
 * الحالات (بعد إضافة PAUSED ٢٨/٨):
 *   • DRAFT     — مسوّدة، لم تُفعَّل بعد.
 *   • ACTIVE    — نشطة، المصوّرون يعملون فيها.
 *   • PAUSED    — «تجميد ذكيّ»: تختفي عن مسار المصوّر لكنّ المهام المسنَدة قابلةٌ للإتمام.
 *   • COMPLETED — انتهت رسمياً (نهائيّة).
 *   • CANCELLED — أُلغيت (نهائيّة، طابورها الغير مسنَد أُلغي معها).
 */

export type StudioCampaignStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";

export const STUDIO_CAMPAIGN_STATUS_AR: Record<StudioCampaignStatus, string> = {
  DRAFT: "مسوّدة",
  ACTIVE: "نشطة",
  PAUSED: "موقوفة مؤقّتاً",
  COMPLETED: "مكتملة",
  CANCELLED: "ملغاة",
};

/** لون الشارة التي تُمثّل الحالة بصرياً — مطابقٌ لعائلة variants الموحّدة في `@/components/ui/badge`. */
export const STUDIO_CAMPAIGN_STATUS_VARIANT: Record<StudioCampaignStatus, "info" | "success" | "warning" | "neutral" | "danger"> = {
  DRAFT: "neutral",
  ACTIVE: "success",
  PAUSED: "warning",
  COMPLETED: "info",
  CANCELLED: "danger",
};

/** الحالات النهائيّة: لا يُسمح بالانتقال منها ولا بتعديل بيانات الحملة. */
export const STUDIO_CAMPAIGN_TERMINAL: ReadonlySet<StudioCampaignStatus> = new Set<StudioCampaignStatus>(["COMPLETED", "CANCELLED"]);

/** الحالات القابلة للتعديل (اسم، عدد صور مطلوبة، مواعيد). */
export const STUDIO_CAMPAIGN_EDITABLE: ReadonlySet<StudioCampaignStatus> = new Set<StudioCampaignStatus>(["DRAFT", "ACTIVE", "PAUSED"]);

/**
 * الانتقالات المشروعة — **مطابقٌ بالحرف** لحرس `transitionStudioCampaign` في الخادم.
 * كسرُ التطابق يعني زرّاً في الواجهة يقود إلى `CONFLICT` من الخادم = تجربةٌ مكسورة.
 * الاختبارُ الوحيد الصحيح هو أن يستهلك كلاهما هذا القاموس.
 */
export const STUDIO_CAMPAIGN_LEGAL_TRANSITIONS: Record<StudioCampaignStatus, ReadonlyArray<StudioCampaignStatus>> = {
  DRAFT:     ["ACTIVE", "CANCELLED"],
  ACTIVE:    ["PAUSED", "COMPLETED", "CANCELLED"],
  PAUSED:    ["ACTIVE", "COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionStudioCampaign(from: StudioCampaignStatus, to: StudioCampaignStatus): boolean {
  return STUDIO_CAMPAIGN_LEGAL_TRANSITIONS[from]?.includes(to) === true;
}
