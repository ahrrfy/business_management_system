// نوع رموز ألوان الكاشير المشترك (PosTokens) — يُستعمَل في CashDropDialog وغيره.
//
// تاريخيّاً حَوى هذا الملف أيضاً قسم «تسليم نقد للخزينة» الاختياريّ عند إغلاق الوردية. أُزيل ذلك القسم
// وأدواته (buildHandoverPayload/handoverIncomplete/ShiftHandoverSection) عند اعتماد نموذج العهدة
// الوسيطة (imprest، ٢٨/٧/٢٦): يعود كامل نقد الدرج إلى الخزينة **تلقائياً** عند الإغلاق (settleShiftReturnTx)
// بلا اختيار مستلِمٍ ولا تسليمٍ جزئيّ. بقي هنا نوع PosTokens فقط لأنّه مُشارَكٌ خارج سياق التسليم.

/** الحدّ الأدنى من رموز ألوان الكاشير (متوافق بنيوياً مع POS_COLORS/LIGHT). */
export interface PosTokens {
  card: string;
  border: string;
  muted: string;
  mutedFg: string;
  fg: string;
  primary: string;
  danger: string;
}
