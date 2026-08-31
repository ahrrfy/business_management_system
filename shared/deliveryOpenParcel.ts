/**
 * deliveryOpenParcel — تعريف موحَّد لـ«الطرد المفتوح» (Slice DFP2، ٣١/٨/٢٦).
 *
 * الجذر (الفحص البصريّ ٣١/٨): على نفس البيانات (Ibrahim Ahmed + شركة الشمس)، ٣ شاشات تُنتِج
 * أعداداً مختلفة لنفس المفهوم:
 *   - Settlement tab (listPartyObligations): 5 + 2 = **7**
 *   - Aging tab (نفس الحسبة تقريباً):        5 + 2 = **7**
 *   - Delivery Parties (listDeliveryParties): 51 + 18 = **69** ⚠️
 *
 * الفرق ٦٢ طرداً على نفس البيانات! المدير يفتح شاشتين فيرى ٦٩ و٧ ⇒ يظنّ عطباً نظامياً.
 *
 * السبب الجذريّ: **تعريفان مختلفان لنفس اللفظ**:
 *   listPartyObligations: consignmentStatus IN ('DISPATCHED', 'PARTIAL')          ← عملي/ماليّ
 *   listDeliveryParties:  parcelStatus NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED')
 *                         OR moneyStatus IN ('UNSETTLED', 'PARTIAL')              ← يجمع القناتين
 *
 * القرار (Slice DFP2):
 *   **تعريف واحدٌ موحَّد للـ«طرد مفتوح» = `consignmentStatus IN ('DISPATCHED', 'PARTIAL')`.**
 *
 * لماذا هذا التعريف بالذات:
 *   1. `consignmentStatus` هو المفهوم **الماليّ** للإرسالية (الحالة العملية للإغلاق).
 *   2. `parcelStatus` هو الحالة **الفيزيائيّة** (الموقع) — لا تخصّ التسوية.
 *   3. `moneyStatus` هو خاصيّة موجودة على الطرد — لكنّها تصبح مربكةً عند التصفية:
 *      طرد `DELIVERED + UNSETTLED` = وصل الزبون بلا قبض ⇒ هل «مفتوح» ماليّاً؟ نعم! لكن
 *      حالته `DISPATCHED` مالياً (أو `PARTIAL` عند تحصيل جزئيّ) — فيدخل هذا التعريف تلقائياً.
 *
 * الغرض: مصدرٌ واحدٌ لكل استعلامٍ يعرض «طرود مفتوحة» في أيّ شاشة.
 */

/**
 * قيم `consignmentStatus` التي تعني «مفتوح» (يحتاج معالجة).
 * ⛔ لا تُوسَّع بلا تحديث كلّ الاستعلامات + الاختبارات.
 */
export const OPEN_CONSIGNMENT_STATUSES = ["DISPATCHED", "PARTIAL"] as const;

/**
 * قيم `consignmentStatus` التي تعني «مغلق» (لا يحتاج معالجة).
 * DELIVERED = مسدَّد كاملاً · CANCELLED = ألغي · RETURNED = أُرجع.
 */
export const CLOSED_CONSIGNMENT_STATUSES = ["DELIVERED", "CANCELLED", "RETURNED"] as const;

export type OpenConsignmentStatus = (typeof OPEN_CONSIGNMENT_STATUSES)[number];
export type ClosedConsignmentStatus = (typeof CLOSED_CONSIGNMENT_STATUSES)[number];

/**
 * جملة SQL جاهزة لتصفية «الطرود المفتوحة» ماليّاً.
 * تُستعمل في:
 *   - listPartyObligations.openScope
 *   - listInTransitConsignments
 *   - listDeliveryParties.openConsignments  ← إصلاحٌ Slice DFP2
 *   - listStaleParties
 *   - أعمار الإرساليات (aging)
 *
 * مثال:
 *   sql`SELECT COUNT(*) FROM deliveryConsignments WHERE ${OPEN_PARCEL_SQL_FILTER('dc.consignmentStatus')}`
 */
export function OPEN_PARCEL_SQL_FILTER(columnRef: string): string {
  return `${columnRef} IN ('DISPATCHED', 'PARTIAL')`;
}

/**
 * حكم على قيمة `consignmentStatus` واحدة: هل هي «مفتوحة»؟
 * للاستعمال في العميل والخادم بعد جلب الصفوف.
 */
export function isOpenConsignmentStatus(status: string | null | undefined): boolean {
  if (status == null) return false;
  return (OPEN_CONSIGNMENT_STATUSES as readonly string[]).includes(status);
}

/**
 * تعريفٌ فرعيٌّ: هل هذا الطرد «سُلِّم لكنّ نقده لم يُوَرَّد بعد»؟
 * = consignmentStatus مفتوح + parcelStatus=DELIVERED.
 * هذه الحالة هي مصدر الالتباس التاريخيّ:
 *   - listDeliveryParties كان يعدّها «مفتوحة» (٦٩)
 *   - listPartyObligations يعدّها «مفتوحة» أيضاً — لكن بشرطها الأصحّ
 *   - القرار: **تُعدّ مفتوحةً** لأنّ التوريد لم يُغلقها ماليّاً بعد.
 *
 * هذا العدّاد الفرعيّ يُعرَض كشارة «سلَّم بانتظار توريد» بجوار الطرود المفتوحة.
 */
export function isDeliveredAwaitingRemittance(
  consignmentStatus: string | null | undefined,
  parcelStatus: string | null | undefined,
): boolean {
  return isOpenConsignmentStatus(consignmentStatus) && parcelStatus === "DELIVERED";
}
