/**
 * shortfallReason — قاموس أسباب العجز في التحصيل عند تأكيد تسليم المندوب (Slice DFP1، ٣٠/٨/٢٦).
 *
 * الغرض:
 *  حين يقبض المندوب أقلّ من المطلوب (`collectedAmount < requiredAmount`)، النظام **يُلزم** الكاشير
 *  بتصنيف السبب من هذه القائمة الثابتة قبل قبول التسجيل. الفرق يُقيَّد فوراً ذمّةً على المندوب
 *  (SHORTFALL_ASSIGNED في `deliveryLedgerEntries`)، والفاتورة تبقى مسدَّدةً كاملاً — لا ذمّة على العميل.
 *
 * قرار المالك (٣٠/٨/٢٦):
 *  «الفرق على المندوب فوراً + سبب مصنَّف من قائمة» — لا اعتماد مدير مطلوب لأن السبب المصنَّف +
 *  التوثيق في دفتر التوصيل + ظهوره في كشف الجهة يُوفّر المسار الرقابيّ الكامل بلا احتكاك يوميّ.
 *
 * لماذا enum ثابت لا نصّ حرّ:
 *  النصّ الحرّ يُنتج «مشاكل» غير قابلة للتحليل. القائمة الثابتة تسمح بتقارير «أسباب العجز الأكثر
 *  تكراراً» فيصير القرار قابلاً للاتخاذ (مثلاً: إن كانت 60% من العجز بسبب MERCHANT_REFUSED_COMMISSION،
 *  المالك يعرف أنّ عمولة المناديب غير مقبولة عند بعض التجّار — قرارٌ عمليّ لا انطباع).
 */

export type ShortfallReason =
  | "MERCHANT_REFUSED_COMMISSION"    // التاجر رفض دفع عمولة المندوب — المندوب استقطعها من المبلغ
  | "CUSTOMER_REQUESTED_DISCOUNT"    // العميل طلب خصماً في اللحظة الأخيرة، والمندوب وافق
  | "WRONG_PRICE_QUOTED"             // سعرٌ خاطئ قد نُقل للعميل عبر الاتصال، والمندوب سلَّم بالسعر المتّفق عليه
  | "PARTIAL_REFUSAL"                // العميل رفض جزءاً من الطلب (منتج معيّن) وقبل الباقي
  | "DAMAGED_ITEM_REJECTION"         // منتج تالف رُفض، خُصم من الإجمالي عند التسليم
  | "OTHER";                          // سببٌ آخر (نادر — يُوثَّق نصّياً في حقل ملاحظات منفصل)

export const SHORTFALL_REASONS: readonly ShortfallReason[] = [
  "MERCHANT_REFUSED_COMMISSION",
  "CUSTOMER_REQUESTED_DISCOUNT",
  "WRONG_PRICE_QUOTED",
  "PARTIAL_REFUSAL",
  "DAMAGED_ITEM_REJECTION",
  "OTHER",
] as const;

/** تسميات عربية للعرض في الواجهة (شارات، قوائم منسدلة، تقارير). */
export const SHORTFALL_REASON_LABEL_AR: Readonly<Record<ShortfallReason, string>> = Object.freeze({
  MERCHANT_REFUSED_COMMISSION: "التاجر رفض عمولة المندوب",
  CUSTOMER_REQUESTED_DISCOUNT: "العميل طلب خصماً لحظياً",
  WRONG_PRICE_QUOTED:          "سعر مُبلَّغ خاطئ",
  PARTIAL_REFUSAL:             "رفض جزء من الطلب",
  DAMAGED_ITEM_REJECTION:      "رفض منتج تالف",
  OTHER:                       "سبب آخر",
});

/** وصف تفصيليّ للعرض في tooltip حين يمرّر المستعمِل فوق الشارة. */
export const SHORTFALL_REASON_DESCRIPTION_AR: Readonly<Record<ShortfallReason, string>> = Object.freeze({
  MERCHANT_REFUSED_COMMISSION: "طلبَ التاجرُ عدم قبض عمولة المندوب، فاستقطعها المندوب من المبلغ عند التسليم.",
  CUSTOMER_REQUESTED_DISCOUNT: "طلب العميل خصماً في اللحظة الأخيرة، والمندوب وافق دون مراجعة المكتبة.",
  WRONG_PRICE_QUOTED:          "أُبلِغ العميل بسعرٍ خاطئ عبر الاتصال، فسلَّم المندوب بالسعر المتّفق عليه.",
  PARTIAL_REFUSAL:             "رفض العميل جزءاً من الطلب (منتج معيّن)، وقبض ثمن الباقي فقط.",
  DAMAGED_ITEM_REJECTION:      "منتج تالف رُفض عند التسليم، وخُصم ثمنه من الإجمالي.",
  OTHER:                       "سببٌ آخر لم يُغطَّ بالتصنيفات القياسية — يُوثَّق نصّياً في حقل الملاحظات.",
});

/** تحقّق: هل النصّ ينتمي للـenum؟ يُستخدم في زود schema وفي إثباتات الوقت الفعليّ. */
export function isShortfallReason(v: unknown): v is ShortfallReason {
  return typeof v === "string" && (SHORTFALL_REASONS as readonly string[]).includes(v);
}

/** ⚠️ هذا الملف مصدر الحقيقة الوحيد — أيّ نسخة أخرى في UI/server تكسر تقارير أسباب العجز. */
