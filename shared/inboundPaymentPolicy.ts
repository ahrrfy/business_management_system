/**
 * سياسة القبض العامّة (نقاط البيع وغيرها).
 *
 * الإثبات ليس نصّاً يكتبه الموظّف بل **محاولة دفع خارجية** مسجّلة خادمياً
 * (`externalPaymentAttempts`): INITIATED ⇒ CONFIRMED ⇒ استهلاك مرّةً واحدة داخل معاملة
 * الفاتورة/الإيصال، مقيّدة بالمرجع الفريد وبالكاشير وبالجهاز. تلك هي البوّابة الحاكمة
 * لمسارات نقاط البيع، ولذلك لا حاجة لإقفال الطرق غير النقدية كلّها لتحقيق النزاهة.
 *
 * ما يبقى **مغلقاً افتراضياً** هو المجهول: أي قيمة خارج القائمة تُرفض (fail-closed)، و
 * `TELECOM` تحديداً يبقى مرفوضاً قبضاً لأن رصيد زين لا يمرّ بمسار قبضٍ نقديٍّ ولا تقبله
 * محاولات الدفع الخارجية (`externalPaymentAttempts.paymentMethod`) — مسارُه شريحة البطاقات
 * الرقمية وحدها.
 *
 * تاريخ (١٦/٨/٢٦): أُقفلت الطرق غير النقدية كلّها إقفالاً شاملاً في #596 بعد بناء مسار
 * المحاولة المؤكَّدة في نفس اليوم، فتعطّل بيع البطاقة في المتجر كلّياً. الإقفال الشامل
 * أُلغي هنا وأُبقيت البوّابة الحقيقية (المحاولة المؤكَّدة) كما هي.
 */
export const INBOUND_NON_CASH_PAYMENT_METHODS = [
  "CARD",
  "CHECK",
  "TRANSFER",
  "WALLET",
  "TELECOM",
] as const;

export type InboundNonCashPaymentMethod = (typeof INBOUND_NON_CASH_PAYMENT_METHODS)[number];

/** الطرق المسموح بها قبضاً. كل ما عداها يُرفض — بما فيه القيم المستقبلية المجهولة. */
export const INBOUND_ENABLED_PAYMENT_METHODS = [
  "CASH",
  "CARD",
  "TRANSFER",
  "WALLET",
] as const;

export type InboundEnabledPaymentMethod = (typeof INBOUND_ENABLED_PAYMENT_METHODS)[number];

export const INBOUND_PAYMENT_DISABLED_MESSAGE =
  "طريقة القبض هذه غير مدعومة في النظام؛ استخدم النقد أو البطاقة أو التحويل أو المحفظة.";

/** قرار المالك (٢٢/٧): لا تعامل بالصكوك — CHECK للسجلّات التاريخية فقط، لا لقبضٍ جديد. */
export const INBOUND_CHECK_DISABLED_MESSAGE =
  "لا تعامل بالصكوك — الصكّ يبقى للسجلّات التاريخية فقط.";

/** رسالة رصيد زين تحديداً — سببه بنيويّ لا سياسيّ، فيُفصل كي لا يبحث الموظّف عن إذنٍ لا وجود له. */
export const INBOUND_TELECOM_DISABLED_MESSAGE =
  "رصيد زين لا يُقبض على الفاتورة — بيعه يتمّ من شاشة البطاقات الرقمية.";

export function isInboundPaymentMethodEnabled(
  method: string | null | undefined,
): method is InboundEnabledPaymentMethod {
  return INBOUND_ENABLED_PAYMENT_METHODS.includes(method as InboundEnabledPaymentMethod);
}

/** رسالة الرفض المناسبة للقيمة المرفوضة — تُستعمَل في الخادم والواجهة معاً. */
export function inboundPaymentRejectionMessage(method: string | null | undefined): string {
  if (method === "TELECOM") return INBOUND_TELECOM_DISABLED_MESSAGE;
  if (method === "CHECK") return INBOUND_CHECK_DISABLED_MESSAGE;
  return INBOUND_PAYMENT_DISABLED_MESSAGE;
}
