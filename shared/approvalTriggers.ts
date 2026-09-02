/**
 * تصنيفُ لحظة الخطر لكل **فعلٍ** في بوّابات الاعتماد — لا لكل إجراء.
 *
 * ## لماذا بالفعل لا بالإجراء
 *
 * إجراءٌ واحد يغطّي عادةً فعلين أو أكثر بتصنيفاتٍ متباينة. المثال الحاسم:
 * `purchases.decideControl` **يعتمد** أمر شراءٍ (لا مال ولا محو ⇒ لا بوّابة) و**يُلغيه**
 * (محوُ أثرٍ ⇒ بوّابة) — في الإجراء نفسه. تصنيفُه ككلٍّ يُنتج أحد خطأين: بوّابةٌ على كل
 * اعتمادٍ فيتعطّل العمل يومياً، أو حذفُ البوّابة فينفتح فرعُ الإلغاء بلا حارس.
 *
 * ## كيف صُنِّفت — لا بالتخمين
 *
 * كل تصنيفٍ هنا نتيجةُ قراءةِ ما تكتبه الخدمة **فعلاً** (postEntry · إيصال بالاتّجاه ·
 * applyMovement · adjustSupplierBalance · paidAmount)، ثمّ **تفنيدٍ عدائيّ** مهمّتُه إثباتُ
 * أنّ التصنيف خاطئ بتتبّع الكتابات غير المباشرة مستوًى ثانياً وثالثاً.
 *
 * والنتيجة قلبت الفرضية: **تسعةٌ من عشرة تصنيفاتٍ اقترحت الحذف رُفضت.** ثلاثةٌ منها تُخرج
 * نقداً من الدرج فعلاً — أُثبت ذلك عند التسوية لا بالادّعاء: الإيصال يُصنَّف `otherCashOut`
 * في `shiftService` فيُنقص `expectedCash` وZ-report. ⇒ المكسبُ ليس حذفَ بوّابات بل **توحيد
 * مَن يفتحها**: خمسةُ أشخاصٍ متمايزين ⇐ المالك وحده، مع اعتمادٍ تلقائيّ حين ينفّذ بنفسه.
 *
 * ⚠️ **ولا يُضاف تصنيفٌ هنا بلا دليلٍ مقروء.** كل دالّةٍ أدناه تحمل في تعليقها ما وُجد
 * بأرقام أسطره. تصنيفٌ بلا دليلٍ يحذف ضابطاً حقيقياً أو يُبقي احتكاكاً بلا سبب.
 */
import type { ApprovalTrigger } from "./approvalPolicy";

/** الرفضُ لا يكتب شيئاً ماليّاً في أيٍّ من مسارات المشتريات — يُعيد الطلب ويُسجّل. */
const REJECT_IS_FREE = null;

/**
 * أمر الشراء — `purchases.decideControl` (`purchase/controls.ts:415`).
 *
 * • `APPROVE_REVISION` (اعتماد/رفض): الكتابةُ الوحيدة على `purchaseOrders` (الحالة والمعتمِد).
 *   إنشاءُ التزامٍ تعاقديّ ليس خروجَ مالٍ ولا محوَ أثر. ⇒ لا بوّابة.
 * • `EMERGENCY_ORDER`: لا يُكتب على أمر الشراء البتّة — يصير شرطاً مُمكِّناً لاعتمادٍ لاحق.
 * • `CANCEL_ORDER` + اعتماد ⇒ **محوُ أثر — تصنيفٌ متحفّظٌ عن قصد**، وتاريخُه يستحقّ الذكر
 *   لأنّه يمنع من بعدنا أن يُعيد الجدل:
 *
 *   تفنيدٌ عدائيّ أوّل زعم أنّ `controls.ts:700` ينادي
 *   `restoreVariantsToActiveOpeningStocktakes` فتمحو `firstSignBy/firstSignAt` على جلسة
 *   الجرد الافتتاحيّ ⇒ «محوٌ صامتٌ لتوقيعٍ رقابيّ». **وتحقيقٌ مخصَّصٌ فنّد هذا التفنيد:**
 *   إبطالُ التوقيع هو **الضابطُ المقصود** لا ثغرةٌ فيه — التوقيع يشهد على نطاقٍ محدَّد،
 *   وتغيُّرُ النطاق يُبطل الشهادة؛ والنمطُ مطبَّقٌ في **سبعة مواضع** ومحروسٌ باختبارٍ صريح
 *   يؤكّد الإبطالَ عند التغيّر و**بقاءَ التوقيع** عند عدمه.
 *
 *   ⚠️ ووجد التحقيقُ ما هو أهمّ: **نفسُ الإبطال يقع من `purchases.createOrder`
 *   و`updateOrder`** (`order.ts:497` ⇐ `openingEligibility.ts:131`) — وهما **بلا مُعتمِدٍ
 *   ثانٍ إطلاقاً**. فبوّابةٌ على الإلغاء وحده تُقفل البابَ الأصعب وتترك الأسهل مفتوحاً.
 *
 *   ⇒ سقط سببُ التوقيع. ويبقى التصنيف `ERASE_EFFECT` **بالاتّجاه الآمن وحده**: الإلغاء
 *   يُدرج صفوفاً بتكلفةٍ وكمّيةٍ متوقَّعة في جلسة جردٍ نشطة (تغييرُ وعاء تقييمٍ لمستندٍ له
 *   حوكمتُه) ويُحرّر حجوزات طلب الشراء. وهذا احتكاكٌ زائدٌ محتمل لا خطرَ ماليّ — **وقرارُ
 *   إسقاطه إلى `null` قرارُ مالكٍ لا قرارُ مبرمج**، لأنّه حذفُ بوّابة.
 */
export function purchaseOrderControlTrigger(
  kind: "APPROVE_REVISION" | "CANCEL_ORDER" | "EMERGENCY_ORDER",
  approve: boolean,
): ApprovalTrigger | null {
  if (!approve) return REJECT_IS_FREE;
  return kind === "CANCEL_ORDER" ? "ERASE_EFFECT" : null;
}

/**
 * طلب الشراء الداخليّ — `purchases.decideRequisition` (`purchase/requisitions.ts:598`).
 *
 * **الوحيدُ الذي صمد تصنيفُه بلا تفنيد.** يكتب ثلاثةً كلُّها داخل مستند الطلب:
 * `approvedBaseQuantity` لكل بند · حالةَ الطلب ونسخته · وسمَ طلب القرار. والطلبُ الداخليّ
 * يسبق أمر الشراء، فالالتزام التعاقديّ نفسه لاحقٌ له. ⇒ لا بوّابة في أيّ فعل.
 */
export function purchaseRequisitionControlTrigger(): ApprovalTrigger | null {
  return null;
}

/**
 * عكسُ الاستلام — `goodsReceipts.decideReversal` (`purchase/goodsReceipts.ts:889`).
 *
 * الاعتماد ⇒ **محوُ أثر** مُثبَتٌ بكتابتين: `goodsReceipts.ts:1146` بـ`applyMovement`
 * باتّجاه `OUT` (تتبّعاً إلى `inventoryService.ts:329` إدراج حركة و`:347` إنقاص
 * `branchStock`) — إخراجٌ فعليّ لمخزونٍ أُدخل؛ و`:1226` `postGoodsReceiptReversalTx`
 * ⇒ قيدٌ عكسيّ يمحو التزام GRNI.
 */
export function goodsReceiptReversalTrigger(action: "APPROVE" | "REJECT"): ApprovalTrigger | null {
  return action === "APPROVE" ? "ERASE_EFFECT" : REJECT_IS_FREE;
}

/**
 * فاتورة المورّد — `supplierInvoices.decideApproval` (`purchase/supplierInvoices.ts:614`).
 *
 * • `POST_INVOICE` + اعتماد: يُنشئ ذمّةً جديدة. المالُ لم يخرج بعد ولا أثرَ قائماً يُمحى.
 *   ⇒ لا بوّابة. (السدادُ نفسه بوّابةٌ مستقلّة — انظر `supplierPaymentTrigger`.)
 * • `REVERSE_INVOICE` + اعتماد ⇒ **محوُ أثر**: `supplierInvoices.ts:892` قيدٌ عكسيّ
 *   (مدين AP / دائن GRNI) · `:903` و`:908` إنقاصُ `suppliers.currentBalance` والدولاريّ
 *   · `:914` الحالة `REVERSED` — وهي **الكاتب الوحيد لهذه الحالة في المستودع**.
 */
export function supplierInvoiceApprovalTrigger(
  kind: "POST_INVOICE" | "REVERSE_INVOICE",
  action: "APPROVE" | "REJECT",
): ApprovalTrigger | null {
  if (action === "REJECT") return REJECT_IS_FREE;
  return kind === "REVERSE_INVOICE" ? "ERASE_EFFECT" : null;
}

/**
 * مرتجع الشراء — `purchaseReturnGovernance.decideReturn` (`purchase/returnGovernance.ts:480`).
 *
 * الاعتماد ⇒ **محوُ أثر**. ولا خروجَ نقدٍ فيه (النقد باتّجاه `IN` حصراً عند `:490`)، لكنّ
 * التفنيد أثبت خمسَ كتاباتٍ ماليّةٍ غير مباشرة، أوضحُها: `:598` `applyMovement` بـ`OUT`
 * (أصلٌ يغادر) و`:626` `postEntry` (قيدٌ منشور) و`:631` `adjustSupplierBalance` بالسالب.
 */
export function purchaseReturnTrigger(action: "APPROVE" | "REJECT"): ApprovalTrigger | null {
  return action === "APPROVE" ? "ERASE_EFFECT" : REJECT_IS_FREE;
}

/**
 * عكسُ مرتجع الشراء — `purchaseReturnGovernance.decideReversal` (`returnGovernance.ts:700`).
 *
 * الاعتماد ⇒ **خروجُ مال**، وهو أوضحُ ما في المشتريات: `returnGovernance.ts:793` إيصالٌ
 * باتّجاه `OUT` مكتملٌ ومعتمَد بـ`cashBucket`، و`shiftService.ts:794` يصنّفه ضمن
 * `otherCashOut` فيُنقص `expectedCash` وZ-report فعلياً. ومعه `:780`
 * `assertCashOutAvailable` — حارسُ توفّرٍ لا يُوضَع إلّا لمالٍ يخرج.
 */
export function purchaseReturnReversalTrigger(
  action: "APPROVE" | "REJECT",
): ApprovalTrigger | null {
  return action === "APPROVE" ? "MONEY_OUT" : REJECT_IS_FREE;
}

/**
 * مصاريف الشراء — `purchaseCharges.decideControl` (`purchase/purchaseCharges.ts:222`).
 *
 * الاعتماد ⇒ **خروجُ مال**: `purchaseCharges.ts:277` إيصالٌ باتّجاه `OUT` يستوفي شروط
 * «النقد المتحقّق» الأربعة نصّاً (`cash/cashAvailability.ts:319`): `cashBucket='DRAWER'`
 * و`paymentMethod='CASH'` وحالةٌ مكتملة واعتمادٌ مقبول ⇒ نقدٌ يغادر الدرج ماديّاً.
 */
export function purchaseChargeControlTrigger(
  action: "APPROVE" | "REJECT",
): ApprovalTrigger | null {
  return action === "APPROVE" ? "MONEY_OUT" : REJECT_IS_FREE;
}

/**
 * حالاتُ سلامة المشتريات — `purchaseIntegrity.decideResolution` (`purchase/integrityCases.ts:131`).
 *
 * لا مالَ ولا محو. الكتابةُ حالةٌ وحقولُ قرارٍ على `purchaseIntegrityCases` + حدثُ تدقيق،
 * والمُفرَّغُ عند الرفض محفوظٌ في حدث `RESOLUTION_REQUESTED` فلا يضيع. ⇒ لا بوّابة.
 */
export function purchaseIntegrityResolutionTrigger(): ApprovalTrigger | null {
  return null;
}

/**
 * سدادُ المورّد — `supplierPayments.decidePayment` (`purchase/supplierPayments.ts:768`).
 *
 * الاعتماد ⇒ **خروجُ مال**، وهذه البوّابة هي **التفويض الوحيد** له: `supplierPayments.ts:1030`
 * إيصالٌ `OUT` مكتمل بـ`cashBucket`، و`:1002` `assertCashOutAvailable` أو نظيرُ الخزينة،
 * و`:792` قفلُ مصدر النقد `FOR UPDATE` مع رفض الوردية المغلقة.
 */
export function supplierPaymentTrigger(action: "APPROVE" | "REJECT"): ApprovalTrigger | null {
  return action === "APPROVE" ? "MONEY_OUT" : REJECT_IS_FREE;
}

/**
 * استردادُ سدادٍ من المورّد — `supplierPayments.decideRefund` (`supplierPayments.ts:1353`).
 *
 * الاعتماد ⇒ **محوُ أثر**: عكسٌ جبريٌّ كاملٌ للدفع سطراً بسطر بالإشارة المعاكسة —
 * إيصال `IN` مقابل `OUT` (`:1556` مقابل `:1031`) · `PAYMENT_IN` مقابل `PAYMENT_OUT`
 * (`:1586` مقابل `:1061`) · `adjustSupplierBalance(+)` مقابل `(−)` (`:1686` مقابل `:1117`)
 * · والفاتورة تعود `OPEN` بعد `SETTLED`. المالُ يدخل لا يخرج، لكنّ المستند المنشور يُمحى.
 */
export function supplierPaymentRefundTrigger(
  action: "APPROVE" | "REJECT",
): ApprovalTrigger | null {
  return action === "APPROVE" ? "ERASE_EFFECT" : REJECT_IS_FREE;
}

// ═══════════ الخزينة والسندات — تصنيفٌ عدائيّ (٢/٩/٢٦) ═══════════════════════════════
// خمسةُ إجراءاتٍ أنتجت **تسعةَ أفعالٍ متمايزة**: الإجراءُ الواحد يحمل تصنيفين مختلفين
// بحسب اتّجاه الإيصال ونوع الطلب النظاميّ. ⇒ التصنيفُ على **الفعل** لا على اسم الإجراء،
// وهو نفسُ الدرس الذي أخرج `decideControl` بلا بوّابةٍ عند الاعتماد وببوّابةٍ عند الإلغاء.

/** أنواع الطلبات النظامية التي تُغيّر تصنيفَ سندِ القبض. `null` = سندٌ عاديّ بلا طلبٍ نظاميّ. */
export type VoucherSystemKind =
  | "VOUCHER_CANCELLATION"
  | "ACCRUAL_CORRECTION_REFUND"
  | (string & {});

/**
 * اعتمادُ سند.
 *
 *   • `OUT` ⇒ **MONEY_OUT**: حارسُ التوفّر ثمّ إيصالٌ بـ`cashBucket` — نقدٌ يخرج من درجٍ أو خزينة.
 *   • `IN` + إلغاءُ سند ⇒ **ERASE_EFFECT**: الأصل ⇐ `REVERSED` + قيدٌ معاكس + عكسُ الذمّة
 *     + إنقاصُ `paidAmount`.
 *   • `IN` + استردادُ تصحيحِ استحقاق ⇒ **ERASE_EFFECT**: `postEntry` بمبلغٍ سالب + عكسُ الاعتراف.
 *   • `IN` عاديّ ⇒ **null** — مالٌ يدخل ولا قيدَ يُعكس.
 */
export function voucherApprovalTrigger(
  direction: "IN" | "OUT",
  systemKind: VoucherSystemKind | null,
): ApprovalTrigger | null {
  if (direction === "OUT") return "MONEY_OUT";
  if (systemKind === "VOUCHER_CANCELLATION") return "ERASE_EFFECT";
  if (systemKind === "ACCRUAL_CORRECTION_REFUND") return "ERASE_EFFECT";
  return null;
}

/**
 * ⭐ **قرار المالك (٢/٩/٢٦): سندُ القبض العاديّ يبقى مُبوَّباً.**
 *
 * تصنيفُه `null` صحيحٌ بالقاعدة (لا مالَ يخرج ولا أثرَ يُمحى)، **لكنّه الضابطُ الوحيد على
 * نقدٍ مجهول المصدر يدخل الخزينة**: إسقاطُه يعني أنّ أيّ موظّفٍ يُدخل مبلغاً بلا اعتماد،
 * فيُخرق المبدأ المالي الحاكم «لا دينار… ليس له مسار أو تبويب» من الطرف الذي لا ينتبه إليه
 * أحد — طرفِ **الدخول**.
 *
 * والاستبقاءُ **لا يُنشئ مُطلِقاً ثالثاً**: `shared/approvalPolicy.ts` يبقى بحالتين، ويُمرَّر
 * `retainLegacy` إلى `assertApprover` فيُنفَّذ الضابطُ **القائم** كما هو. أي لا سياسةَ جديدة
 * ولا رسالةَ جديدة — يُترك ما كان.
 *
 * ⚠️ ونظيرُه **زيادةُ فرق النقد** (`SURPLUS`) لم يُحسَم بعد: نفسُ الشكل (مالٌ يدخل، ولا عكسَ
 * لقيدٍ قائم). حتى يُحسَم، **يُستبقى ضابطُه كما هو** — والاستبقاءُ هو الخيار الآمن لأنّه
 * لا يُغيّر شيئاً؛ إسقاطُه هو التغيير.
 */
export function voucherApprovalRetainsLegacy(
  direction: "IN" | "OUT",
  systemKind: VoucherSystemKind | null,
): boolean {
  return voucherApprovalTrigger(direction, systemKind) === null && direction === "IN";
}

/**
 * اعتمادُ حالة فرق نقد.
 *
 *   • عجز (`SHORTAGE`) ⇒ **MONEY_OUT**: `assertCashOutAvailable` ثمّ إيصالُ `OUT/CASH/TREASURY`.
 *   • زيادة (`SURPLUS`) ⇒ **null**: الاتّجاه `IN`، والقيد Dr خزينة / Cr التزامٌ آخر — إنشاءٌ
 *     لا عكس. (وضابطُه مُستبقًى — انظر `cashVarianceApprovalRetainsLegacy`.)
 */
export function cashVarianceApprovalTrigger(
  kind: "SHORTAGE" | "SURPLUS",
  action: "APPROVE" | "REJECT",
): ApprovalTrigger | null {
  if (action === "REJECT") return REJECT_IS_FREE;
  return kind === "SHORTAGE" ? "MONEY_OUT" : null;
}

/** الزيادةُ نظيرُ سند القبض: مالٌ يدخل بلا عكس ⇒ يُستبقى ضابطُه حتى يحسمه المالك. */
export function cashVarianceApprovalRetainsLegacy(
  kind: "SHORTAGE" | "SURPLUS",
  action: "APPROVE" | "REJECT",
): boolean {
  return action === "APPROVE" && kind === "SURPLUS";
}
