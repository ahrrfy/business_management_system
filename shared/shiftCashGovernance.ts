/**
 * سياسة حوكمة فروقات **درج الكاشير عند إغلاق الوردية** (Z-report).
 *
 * الرقم المعدود ليس مصدراً مالياً بحد ذاته. أي فرق عن الرصيد الدفتري يحتاج
 * دليلاً (عدّ الفئات) وتفسيراً، والفروق الجوهرية تحتاج فصلاً للواجبات.
 *
 * ⚠️ **ليس هذا قاموس [`shared/cashVariance.ts`](./cashVariance.ts)، ولا يُوحَّد معه.**
 * تصادفت ثلاثةٌ من رموز المجموعتين نصّاً (`COUNT_ERROR` و`UNRECORDED_CASH_IN`
 * و`UNRECORDED_CASH_OUT`) فبَدَتا قاموساً واحداً تكرّر، وليستا كذلك — المستند والأثر
 * مختلفان:
 *
 *  - **محلّ العدّ:** هنا درجُ الكاشير قبل توريده. وهناك العهدةُ الشخصية (`CUSTODY`) أو
 *    الخزينةُ اليومية (`DAILY_TREASURY`) — أي **بعد** مغادرة المال للدرج.
 *  - **المستند:** هنا عمودُ `shifts.varianceReasonCode`. وهناك عمودُ
 *    `cashVarianceCases.cashVarianceReasonCode` — عمودان منفصلان لا يقرأ أحدهما الآخر.
 *  - **الأثر:** هنا **تفسيرٌ على صفّ الوردية** يرافقه `reconciliationStatus` — بلا قيدٍ
 *    محاسبيّ ولا ذمّةٍ على أحد. وهناك **قضيّةٌ كاملة**: اقتراحٌ واعتمادٌ أو رفض، ودليلٌ
 *    مبصوم، وطرفٌ مسؤولٌ مُسمّى، وقيدٌ بحسابٍ مقابل (عهدةُ موظف/التزام/خسائر).
 *
 * ولهذا فالرموزُ غير المشتركة **متنافيةٌ بطبيعتها** لا ناقصةٌ من إحداهما: `UNRECORDED_SALE`
 * و`OFFLINE_SALE` و`CHANGE_FUND_TRANSFER` و`REFUND_ERROR` عللٌ لا تقع إلّا على درج نقطة
 * بيع، بينما `CUSTODY_LOSS` تُحمّل ذمّةً على أمين عهدةٍ مُسمّى فلا معنى لها على صفّ وردية.
 * وحتى `COUNT_ERROR` المشترك يختلف عقده: هناك «موثّق» لأنّ القضيّة **تشترط** مستند دليلٍ
 * ببصمة، وهنا يكفي عدّ الفئات.
 *
 * ⛔ لا يُعاد تسمية مفتاحٍ في أيٍّ منهما — المفاتيح مخزَّنةٌ حرفياً في عمودَي `mysqlEnum`،
 * وتغييرُها يُيتّم الصفوف القائمة. ومن أراد عرض سببٍ فليقرأه من قاموس مستنده هو، لا من
 * القاموس الآخر اتّكالاً على تشابه المفتاح.
 */
export { IQD_DENOMINATIONS } from "./cashDailyReconciliation";

/**
 * علل فرق درج الوردية. تُكتَب في `shifts.varianceReasonCode` من `closeShift` وحدها.
 *
 * ⚠️ **المسار مُقفَلٌ اليوم عملياً، والقاموس ليس ميتاً:** راوتر `shift.close` يمرّر
 * `enforceCashGovernance: true` دائماً، فأيّ فرقٍ يُرفَض بـ`PRECONDITION_FAILED` قبل بلوغ
 * حقل السبب — العدّ لا يُنشئ مالاً، والتصحيح يكون من وحدته المختصّة ثم يُعاد الإغلاق. ولذلك
 * لا يقبل مُدخَل الراوتر `varianceReasonCode` أصلاً، و`SHIFT_VARIANCE_LABELS` لا تعرضها
 * شاشة بعد. تبقى المجموعة عقدَ الكتابة للمسارات الداخلية (سكربتات الصيانة والاختبارات التي
 * تستدعي `closeShift` بلا حارس) ومرجعَ أيّ شاشة تحقيقٍ لاحقة تقرأ الصفوف التاريخية.
 */
export const SHIFT_VARIANCE_CODES = [
  "COUNT_ERROR",
  "UNRECORDED_SALE",
  "UNRECORDED_CASH_IN",
  "UNRECORDED_CASH_OUT",
  "CHANGE_FUND_TRANSFER",
  "OFFLINE_SALE",
  "REFUND_ERROR",
  "OTHER",
] as const;

export type ShiftVarianceCode = (typeof SHIFT_VARIANCE_CODES)[number];

export const SHIFT_VARIANCE_LABELS: Record<ShiftVarianceCode, string> = {
  COUNT_ERROR: "خطأ في العد أو الفئات",
  UNRECORDED_SALE: "بيع لم يُسجّل",
  UNRECORDED_CASH_IN: "نقد وارد غير مسجّل",
  UNRECORDED_CASH_OUT: "نقد صادر غير مسجّل",
  CHANGE_FUND_TRANSFER: "فكّة/عهدة من الخزينة",
  OFFLINE_SALE: "بيع دون اتصال لم يُزامن",
  REFUND_ERROR: "خطأ في مرتجع أو استرداد",
  OTHER: "سبب آخر موثّق",
};

/**
 * حد تشغيلي أولي بالدينار العراقي. تجاوزه لا يعني اختلاساً، بل يعني أن
 * الكاشير لا يعتمد فرق عهدته بنفسه ويجب أن يغلقها مدير/أدمن بعد التحقيق.
 */
export const MATERIAL_SHIFT_VARIANCE_IQD = 5_000;
