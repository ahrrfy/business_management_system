/**
 * ترجمة أخطاء العميل التقنية (إنجليزية غامضة) لرسائل عربية قابلة للفهم والتصرّف.
 *
 * «Unable to transform response from server» = استجابة غير tRPC وصلت للعميل — نصّ
 * حرفي داخلي من @trpc/client (TransformResultError): كان علّة تعذّر الدخول من متصفح
 * اللوحي (٤/٧/٢٠٢٦)، ويبقى ممكناً من خادم قديم لم يُحدَّث بعد أو صفحة خطأ من nginx.
 * ⚠️ المطابقة حرفية === — عند ترقية @trpc/client تحقّق أن النص لم يتغيّر (يحرسه اختبار
 * transformResult في server/middleware/__tests__/csrf.test.ts الذي يستورد المكتبة نفسها).
 */
export function translateLoginError(message: string): string {
  if (message === "Unable to transform response from server") {
    return "رُفض الطلب قبل وصوله للنظام (غالباً تجاوز حدّ محاولات الدخول — انتظر ١٥ دقيقة، أو المتصفح يحجب ترويسة المصدر). حدّث الصفحة وأعد المحاولة.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "تعذّر الاتصال بالخادم — تحقّق من اتصال الإنترنت ثم أعد المحاولة.";
  }
  // الصيغ الثلاث: Chrome «Unexpected token … is not valid JSON»، Safari «JSON Parse
  // error»، Firefox «JSON.parse: unexpected character at line 1 column 1 …».
  if (/unexpected token|not valid json|json.parse|unexpected character/i.test(message)) {
    return "الخادم غير متاح مؤقتاً — أعد المحاولة بعد قليل.";
  }
  return message;
}
