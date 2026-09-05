/**
 * deliveryFeeCollection — قاموس «مَن يقبض أجرة التوصيل» (برنامج v2 م١، ٥/٩/٢٦).
 *
 * المصدر الوحيد لتسميات `feeCollection` على مستوى الطرد/الفاتورة. كانت شاشة الاستقبال
 * (`OrderDeliveryDialog`) تُعرّف الخيارات الثلاثة نصّاً محلّياً، وكاشير التجزئة يحتاجها
 * الآن في وضع «توصيل» ⇒ قاموسٌ واحد بدل نسختين تنجرفان (نفس بلاء قواميس invoiceStatus).
 *
 * الدلالة الماليّة (لا تتغيّر بتغيير التسمية):
 *   COURIER — المندوب يقبض الأجرة من الزبون عند التسليم (تمريرٌ لا يدخل درج المكتبة).
 *   COUNTER — الأجرة تُقبض نقداً الآن في المكتبة (تدخل الدرج أمانةً للمندوب وتُصرف له عند التوريد).
 *   SHOP    — على المكتبة (مجّاناً للزبون؛ إفصاحٌ لا محاسبة — راجع `deliveryFree`).
 */
export type DeliveryFeeCollection = "COURIER" | "COUNTER" | "SHOP";

export const DELIVERY_FEE_COLLECTIONS: readonly DeliveryFeeCollection[] = ["COURIER", "COUNTER", "SHOP"] as const;

/** تسمية الخيار في القوائم المنسدلة (واجهة الموظّف). */
export const DELIVERY_FEE_COLLECTION_LABEL_AR: Readonly<Record<DeliveryFeeCollection, string>> = Object.freeze({
  COURIER: "المندوب من الزبون",
  COUNTER: "مقبوضة في الاستقبال الآن",
  SHOP: "على المكتبة",
});

/** شرحٌ قصير يظهر تحت الخيار المختار — يذكّر الكاشير بالأثر النقديّ. */
export const DELIVERY_FEE_COLLECTION_HINT_AR: Readonly<Record<DeliveryFeeCollection, string>> = Object.freeze({
  COURIER: "يقبضها المندوب من الزبون عند التسليم — لا تدخل درجك.",
  COUNTER: "تقبض الأجرة نقداً الآن مع الطلب — تدخل درجك أمانةً للمندوب وتُصرف له عند توريده.",
  SHOP: "الأجرة على المكتبة — الزبون لا يدفعها (إفصاحٌ على الإيصال لا محاسبة).",
});

export function isDeliveryFeeCollection(v: unknown): v is DeliveryFeeCollection {
  return typeof v === "string" && (DELIVERY_FEE_COLLECTIONS as readonly string[]).includes(v);
}
