/**
 * **قواميسُ حالات الإرسالية الثلاثة** — مصدرٌ مشترك لسجلّ الأتمتة والواجهة (م١، PR-4).
 *
 * الإرساليةُ تحمل ثلاث حالاتٍ متعامدة (`deliveryConsignments`):
 *   · `parcelStatus`       الحالةُ **الفيزيائيّة** للطرد (أين هو؟).
 *   · `moneyStatus`        حالةُ **النقد** (هل سُوّي؟).
 *   · `status` (`consignmentStatus`) حالةُ **الإغلاق الماليّ** للمستند (تعريف «الطرد المفتوح» في
 *     `deliveryOpenParcel.ts` يقوم عليها).
 *
 * القيمُ مرآةُ تعدادات المخطّط حرفياً ويحرسها `deliveryStatuses.test.ts` (مطابقةٌ مع
 * `enumValues`) — فتوسيعُ عمودٍ بلا تحديث القاموس يكسر الاختبار لا الشاشة.
 * ⛔ لا شاشة ولا خدمة تُعيد تعريف هذه المصفوفات محلّياً.
 */

export const DELIVERY_PARCEL_STATUSES = [
  "ASSIGNED",
  "ACCEPTED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "FAILED",
  "CANCELLED",
  "RETURNED",
] as const;
export type DeliveryParcelStatus = (typeof DELIVERY_PARCEL_STATUSES)[number];

export const DELIVERY_MONEY_STATUSES = [
  "NOT_APPLICABLE",
  "UNSETTLED",
  "PARTIAL",
  "SETTLED",
  "CANCELLED",
  "WRITTEN_OFF",
] as const;
export type DeliveryMoneyStatus = (typeof DELIVERY_MONEY_STATUSES)[number];

export const DELIVERY_CONSIGNMENT_STATUSES = [
  "DISPATCHED",
  "DELIVERED",
  "PARTIAL",
  "CANCELLED",
  "RETURNED",
  "WRITTEN_OFF",
] as const;
export type DeliveryConsignmentStatus = (typeof DELIVERY_CONSIGNMENT_STATUSES)[number];
