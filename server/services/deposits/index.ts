/* ============================================================================
 * نواة العرابين (server/services/deposits/index.ts) — م٣ من برنامج v2 «السهل الممتنع»
 *
 * الواجهة العامّة **الوحيدة** لدفتر المال المحتجَز قبل الفاتورة (`orderPayments`):
 * قبضٌ محتجَز على مستند · تخصيصُه لمستندٍ آخر عند التثبيت · ردُّه · قراءةُ رصيده · وربطُ
 * إيصاله بالفاتورة. كلّ ما يستهلكه أمرُ الشغل أو الاستقبال أو أيّ كاشيرٍ لاحق (م٩) يمرّ من هنا.
 *
 * اتّجاه التبعيّة (يحرسه `__tests__/isolation.test.ts`): النواة **لا تعرف مستهلكيها** —
 * لا ملفَّ فيها يستورد من `reception/` ولا من `workOrder/`؛ هم يستوردونها. ولا يستورد أحدٌ
 * من خارجها ملفّاً داخلها إلّا عبر هذا البرميل.
 *
 * ⚠️ **كتّابُ الإيصالات بقوا في `reception/deposits.ts` عمداً** (`collectDeposit` ·
 * `refundDeposit` · `refundAppliedCollectionsForWorkOrder`): جردُ كتّاب إدراج `receipts` في
 * `server/services/__tests__/cashDayClosedWriteGate.test.ts` يثبّت مسارَ الملفّ وعددَه (٣)،
 * ومعيارُ خروج م٣ «صفر تعديلٍ في أيّ اختبار». ⇒ النواة اليوم = **دفتر المال المحتجَز**
 * (القراءة والتخصيص والربط)، وطبقةُ الإيصال محوِّلٌ في الاستقبال **يستورد النواة لا العكس**.
 * نقلُهم إلى هنا يلزمه تحديثُ مفتاحٍ واحد في ذلك الجرد — قرارُ م٩ لا م٣.
 *
 * مفردات الخطّة (§٨ م٣) ⇄ الدوالّ القائمة — لا اسمَ ثانياً لدالّةٍ قائمة (قاموسٌ واحد، D6):
 *   takeDeposit             ⇒ `collectDeposit` (reception/deposits.ts — قبضٌ على مسوّدة).
 *                              عربونُ أمر الشغل المباشر ما زال مضمَّناً في `workOrder/create.ts`.
 *   applyDepositToPayment   ⇒ `allocateAtCommit` (COLLECTION ⇒ APPLICATION على INVOICE/WORKORDER)
 *                              + `linkSoleTargetCollectionsToInvoice` (ختمُ الإيصال أحاديّ الهدف).
 *   refundDeposit           ⇒ `refundDeposit` (المحتجَز HELD) و`refundAppliedCollectionsForWorkOrder`
 *                              (حصصٌ مطبَّقة) — كلاهما في reception/deposits.ts (انظر التحذير أعلاه).
 *   readDepositBalance      ⇒ `heldNetOfDraft` (قراءةٌ **قافلة** — بعد قفل المسوّدة، ترتيب §٧.٤)
 *                              · `appliedCollectionsForWorkOrder` (حصص أمر الشغل) · `listDraftPayments`.
 *   assertDepositReleasedTx ⇒ **لم يُبنَ في م٣**: ثابتٌ جديدٌ لا نقلٌ ميكانيكيّ، ويلزمه اختبارُ
 *                              قاعدة. الفحصُ القائم اليوم: `reception/draft.ts` يشترط
 *                              `heldNetOfDraft = 0` قبل الإلغاء.
 *
 * البرميل لا يُضيف منطقاً — إعادةُ تصديرٍ محضة (نقلٌ ميكانيكيّ من `reception/deposits.ts`؛
 * الاختبارات القائمة تمرّ كما هي بلا لمس).
 * ========================================================================== */

export * from "./orderPayments";
