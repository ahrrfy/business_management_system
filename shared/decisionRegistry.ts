/**
 * سجلُّ القرارات — المفردةُ الواحدة لكلّ «اعتماد/رفض/بتّ» في النظام.
 *
 * ## العلّة المقيسة
 *
 * المستودع يحمل ثلاثين جدولَ «طلب اعتماد» وسبعين إجراءَ قرارٍ في **٣٥ راوتراً**، بلا مفردةٍ
 * واحدة تجمعها. النتيجةُ طوابيرُ مخفيّة: مَن يعتمد لا يعرف أنّ عليه شيئاً حتى يفتح الشاشة
 * التي يسكنها الطلب — والمشتريات وحدها فيها ثمانيةُ طوابيرَ متفرّقة.
 *
 * وحارسُ الاحتكاك [`scripts/check-friction.mjs`](../scripts/check-friction.mjs) يقيس هذا
 * بالمحور **D3** = «إجراءُ قرارٍ في راوتر غير مُسجَّلٍ هنا»، وخطُّ أساسه ٧٥ موضعاً. هذا
 * الملفّ هو علاجُه.
 *
 * ## ما هذا الملفّ وما ليس هو
 *
 * **سجلٌّ تصريحيٌّ نقيّ.** لا يستورد شيئاً، ولا ينفّذ صلاحية، ولا يقرّر مَن يعتمد فعلاً —
 * الإنفاذُ يبقى حيث هو: بوّابةُ الإجراء في [`server/trpc.ts`](../server/trpc.ts)، وتصنيفُ
 * لحظة الخطر في [`shared/approvalTriggers.ts`](./approvalTriggers.ts)، والبتُّ في
 * [`server/services/approval/ownerGate.ts`](../server/services/approval/ownerGate.ts).
 * هذا الملفّ يجيب سؤالاً آخر: **ما القرارات الموجودة، وما الذي يجب أن يراه المعتمِد
 * ليقرّر، وأين يذهب ليفعل؟**
 *
 * ## ⛔ ثلاثة قيود لا تُكسَر
 *
 * ١) **لا يُسجَّل قرارٌ غير مبنيّ.** كلُّ مدخلٍ أدناه فوقه مرجعُ ملفٍّ وسطرٍ للإجراء الحيّ
 *    الذي ينفّذه. سجلٌّ فيه قرارٌ متخيَّل يُنتج صندوقَ قرارٍ يعرض ما لا وجودَ له.
 *
 * ٢) **`why` لا يُقبَل فيه «للحوكمة» ولا «إجراءٌ حسّاس».** السببُ يقول ما الذي يقع لو مرّ
 *    القرارُ بلا عين: أيُّ مالٍ يخرج، أيُّ أثرٍ يُمحى، أيُّ رقمٍ يكذب بعدها. ضابطٌ لا أحد
 *    يعرف لماذا هو موجود يُلغى أوّلَ ضغطٍ تشغيليّ — وهذا ما وقع مراراً في هذا المستودع.
 *
 * ٣) **`decidesOn` هو ما يُغيّر القرار، لا ما يسهُل عرضه.** هذه هي العلّة الحقيقية المقيسة:
 *    شاشةُ اعتماد أوامر الشراء اليوم تُرجع `purchaseOrderId` و`poNumber` و«عدد النسخة»
 *    — **بلا اسم مورّد، بلا إجمالي، بلا عملة، بلا صنفٍ واحد**
 *    ([`purchase/controls.ts:814-861`](../server/services/purchase/controls.ts)). فالمعتمِدُ
 *    يضغط «اعتماد» على معرّفٍ قاعديٍّ لا معنى له، وهذا اعتمادٌ شكليّ لا رقابة. ⛔ لا يُدرَج
 *    في `decidesOn` معرّفٌ داخليّ ولا رقمُ نسخة ولا «عدد الأسطر» وحده — يحرس ذلك
 *    [`decisionRegistry.test.ts`](./decisionRegistry.test.ts).
 *
 * ## ⚠️ كيف يقرأ الحارسُ هذا الملفّ — وحدُّ ذلك
 *
 * `loadRegisteredDecisions` في الحارس يجرّد التعليقات ثمّ يلتقط **كلَّ سلسلةٍ نصّيةٍ**
 * صيغتُها `approve|reject|decide` متبوعةً باسمٍ اختياريّ. ⇒ الذي يُسجَّل فعلياً هو حقل
 * `procedure.name` أدناه لا `kind`. ولذلك يحمل كلُّ مدخلٍ اسمَ إجراءٍ **حرفيّاً**.
 *
 * ⚠️ والمطابقةُ **بالاسم المجرّد لا بالزوج (راوتر · اسم)**: تسجيلُ `"approve"` يُرضي الحارس
 * عن كلّ `approve` في كلّ راوتر. ولذلك سُجِّل هنا **كلُّ** موضعٍ يحمل اسماً عامّاً
 * (`approve` · `reject` · `decide`) بمدخلٍ مستقلٍّ بدليله — وإلّا كان التسجيل تعميةً
 * للحارس لا علاجاً له. ومن يضيف إجراءَ قرارٍ جديداً باسمٍ عامّ **لن يُنبَّه**، فليضف مدخله
 * هنا يدوياً. (العلاجُ البنيويّ أن يطابق الحارسُ الزوجَ — وهو تعديلٌ في `scripts/` خارج
 * نطاق هذا الملفّ.)
 */

/** مفتاحٌ مستقرّ للقرار — `<وحدة>.<مستند>.<فعل>`. لا يتغيّر بعد نشره (يُخزَّن في الروابط). */
export type DecisionKind = string;

/** الإجراءُ الخادميّ الذي ينفّذ القرار. `name` حرفيٌّ — وهو ما يقرأه حارس D3. */
export interface DecisionProcedure {
  /** اسمُ الراوتر في `server/routers.ts` (مثال `purchases`, `digitalCardsWallets`). */
  router: string;
  /** اسمُ الإجراء داخل الراوتر، حرفياً كما هو في الشيفرة. */
  name: string;
}

/** مَن يملك البتّ. ثلاثةٌ لا رابع — وهي أوضاعٌ قائمةٌ فعلاً في الشيفرة لا تصنيفٌ متمنّى. */
export type DecisionApprover =
  /** بوّابةٌ تشترط `users.isOwner` (`ownerProcedure`) — لا مديرَ فرعٍ ولا محاسب. */
  | "OWNER_ONLY"
  /** بوّابةُ وحدةٍ بمستوى مدير — أيُّ مديرٍ مخوَّل، ولو كان هو الطالب. */
  | "MANAGER"
  /** بوّابةُ مديرٍ **زائد** فصلُ مهامٍ مُنفَّذ: الطالبُ لا يعتمد طلبَه. */
  | "INDEPENDENT_REVIEWER";

export interface DecisionSpec {
  kind: DecisionKind;
  /** بالعربية، بلا تشكيل (يُعرَض في رؤوس جداولَ وشاراتٍ صغيرة — `check:tashkeel`). */
  title: string;
  /** لماذا يوجد هذا الضابط — ⛔ لا يُقبل «للحوكمة». قل ما الذي يقع لو مرّ بلا عين. */
  why: string;
  /** ما الذي يُقرَّر عليه فعلاً: الحقول التي يجب أن يراها المعتمِد في الصفّ. */
  decidesOn: string[];
  /** مَن يعتمد. */
  approver: DecisionApprover;
  /** هل يقبل السحب من الطالب قبل البتّ؟ */
  withdrawable: boolean;
  /** الإجراء الخادميّ المنفِّذ — المرجعُ الذي يجعل هذا السجلّ قابلاً للتكذيب. */
  procedure: DecisionProcedure;
  /** أين يذهب المعتمِد. المعرّفُ المتوقَّع موصوفٌ في تعليق كلّ مدخل. */
  href: (id: number | string) => string;
}

/** بانٍ صغير يحفظ `kind` مرّةً واحدة فلا ينحرف المفتاحُ عن مفتاح الخريطة. */
function spec(s: DecisionSpec): DecisionSpec {
  return s;
}

// ═════════════════════════ المشتريات — ثمانيةُ طوابيرَ متفرّقة ═════════════════════════
// وهذه بالضبط العلّةُ المقيسة: ثمانيةُ صناديقَ في ستّ شاشات، لا أحدَ يرى مجموعَها.

const PURCHASING: Record<string, DecisionSpec> = {
  /**
   * [`purchaseRouter.ts:529`](../server/routers/purchaseRouter.ts#L529) ⇐
   * [`purchase/controls.ts:532`](../server/services/purchase/controls.ts#L532).
   * الاعتماد بإقرار `confirmedFullReceipt` يُشغّل داخل معاملةٍ واحدة السلسلةَ كاملةً:
   * GRN ⇐ مخزون/WAVG ⇐ GRNI ⇐ فاتورة المورّد ⇐ AP. `href` يأخذ **معرّف أمر الشراء**.
   */
  "purchase.order.control": spec({
    kind: "purchase.order.control",
    title: "اعتماد أمر شراء",
    why: "الاعتماد وحده يحرك المخزون ويعيد حساب متوسط التكلفة وينشئ ذمة المورد. مروره بلا عين يعني بضاعة مسجلة لم تصل، وتكلفة مسمومة تتسرب الى كل بيع لاحق.",
    decidesOn: [
      "اسم المورد",
      "اجمالي الامر بعملته",
      "عملة الامر",
      "الاصناف وكمياتها واسعار وحداتها",
      "قيمة فاتورة المورد المطابقة",
      "من طلب ومن انشا الامر",
      "سبب الطلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "purchases", name: "decideControl" },
    href: (id) => `/purchases/${id}`,
  }),

  /**
   * [`purchaseRouter.ts:791`](../server/routers/purchaseRouter.ts#L791) ⇐
   * [`purchase/requisitions.ts:684`](../server/services/purchase/requisitions.ts#L684).
   * الطلبُ الداخليّ يسبق أمر الشراء ⇒ لا التزامَ تعاقدياً بعد. `href` ⇐ تبويب الطلبات.
   */
  "purchase.requisition.control": spec({
    kind: "purchase.requisition.control",
    title: "اعتماد طلب شراء داخلي",
    why: "الاعتماد يثبت الكمية المسموح شراؤها لكل بند. تمريره بلا مراجعة يحول طلب فرع الى امر شراء اكبر مما يحتاجه، فيتحول النقد الى مخزون راكد.",
    decidesOn: [
      "الفرع الطالب",
      "الاصناف والكميات المطلوبة",
      "الكمية المعتمدة لكل بند",
      "سبب الطلب ودرجة استعجاله",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "purchases", name: "decideRequisition" },
    href: () => "/purchases?tab=requisitions",
  }),

  /**
   * [`purchaseChargesRouter.ts:11`](../server/routers/purchaseChargesRouter.ts#L11) ⇐
   * [`purchase/purchaseCharges.ts:248`](../server/services/purchase/purchaseCharges.ts#L248).
   * مصنَّفٌ `MONEY_OUT` بدليله في [`approvalTriggers.ts`](./approvalTriggers.ts): الاعتماد
   * يكتب ايصال `OUT/CASH/DRAWER` ⇒ نقدٌ يغادر الدرج ماديّاً. `href` ⇐ تبويب المصاريف.
   */
  "purchase.charge.control": spec({
    kind: "purchase.charge.control",
    title: "اعتماد مصروف شراء",
    why: "الاعتماد يخرج نقدا من الدرج فعليا (ايصال صرف نقدي معتمد) وينقص النقد المتوقع في تسوية الوردية. لا مسار رجوع الا بعكس موثق.",
    decidesOn: [
      "نوع المصروف",
      "المبلغ",
      "امر الشراء المرتبط",
      "مصدر النقد (درج ام خزينة)",
      "المستند المرفق او مرجعه",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "purchaseCharges", name: "decideControl" },
    href: () => "/purchases?tab=charges",
  }),

  /**
   * [`purchaseIntegrityRouter.ts:13`](../server/routers/purchaseIntegrityRouter.ts#L13) ⇐
   * [`purchase/integrityCases.ts:143`](../server/services/purchase/integrityCases.ts#L143).
   * لا مالَ ولا محو — الكتابةُ حالةُ القضية وحدثُ تدقيق. `href` ⇐ تبويب السلامة.
   */
  "purchase.integrity.resolution": spec({
    kind: "purchase.integrity.resolution",
    title: "بت قضية سلامة مشتريات",
    why: "القضية هي الاثر الوحيد على تعارض بين المستندات (استلام بلا فاتورة، فرق مطابقة ثلاثية). اغلاقها بلا مراجعة يمحو الاشارة التي تمنع اقفال الشهر على خلل قائم.",
    decidesOn: [
      "نوع التعارض ودرجة خطورته",
      "المستندات المتعارضة وارقامها",
      "الفرق بالمبلغ او بالكمية",
      "المعالجة المقترحة",
      "من طلب المعالجة",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "purchaseIntegrity", name: "decideResolution" },
    href: () => "/purchases?tab=integrity",
  }),

  /**
   * [`purchaseReturnGovernanceRouter.ts:21`](../server/routers/purchaseReturnGovernanceRouter.ts#L21)
   * ⇐ [`purchase/returnGovernance.ts:499`](../server/services/purchase/returnGovernance.ts#L499).
   * مصنَّفٌ `ERASE_EFFECT`: `applyMovement` باتّجاه `OUT` + `postEntry` + إنقاصُ ذمّة المورّد.
   * `href` ⇐ **طابور الحوكمة** لا `/purchase-returns/:id`: المعرّفُ هنا معرّفُ **الطلب**
   * (`purchaseReturnRequests.id`) والمرتجعُ نفسه (`purchaseReturns`) لا يُنشأ إلّا عند
   * الاعتماد — فرابطٌ بمعرّف الطلب كان يفتح صفحةَ مرتجعٍ لا وجودَ له (Codex على #1004).
   */
  "purchase.return.decide": spec({
    kind: "purchase.return.decide",
    title: "اعتماد مرتجع شراء",
    why: "الاعتماد يخرج البضاعة من المخزن وينشر قيدا وينقص ذمة المورد. مروره بلا عين يخرج مخزونا حقيقيا مقابل ورقة، والجرد وحده يكتشفه بعد شهور.",
    decidesOn: [
      "اسم المورد",
      "الاصناف والكميات المرتجعة",
      "قيمة المرتجع",
      "امر الشراء وفاتورة المورد المرتبطان",
      "سبب الارجاع ودليله",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "purchaseReturnGovernance", name: "decideReturn" },
    href: () => "/purchases?tab=returns-governance",
  }),

  /**
   * [`purchaseReturnGovernanceRouter.ts:23`](../server/routers/purchaseReturnGovernanceRouter.ts#L23)
   * ⇐ [`purchase/returnGovernance.ts:731`](../server/services/purchase/returnGovernance.ts#L731).
   * مصنَّفٌ `MONEY_OUT` — أوضحُ خروجٍ في المشتريات: ايصال `OUT` بـ`cashBucket` يُصنَّف
   * `otherCashOut` في `shiftService` فيُنقص `expectedCash` وZ-report فعلياً.
   */
  "purchase.return.reversal": spec({
    kind: "purchase.return.reversal",
    title: "اعتماد عكس مرتجع شراء",
    why: "الاعتماد يخرج نقدا من الدرج او الخزينة ويعيد البضاعة الى المخزن ويعكس القيد. هو اخطر ما في المشتريات لانه يجمع خروج المال ومحو الاثر معا.",
    decidesOn: [
      "المرتجع الاصلي ورقمه",
      "الاصناف والكميات المعادة",
      "المبلغ الذي سيخرج",
      "مصدر النقد",
      "نوع الدليل ومرجعه",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "purchaseReturnGovernance", name: "decideReversal" },
    href: (id) => `/purchase-returns/${id}`,
  }),

  /**
   * [`supplierPaymentsRouter.ts:75`](../server/routers/supplierPaymentsRouter.ts#L75) ⇐
   * [`purchase/supplierPayments.ts:843`](../server/services/purchase/supplierPayments.ts#L843).
   * مصنَّفٌ `MONEY_OUT`، وهو **التفويض الوحيد** لخروج المال الى المورّد.
   */
  "supplier.payment.decide": spec({
    kind: "supplier.payment.decide",
    title: "اعتماد سداد مورد",
    why: "هذه هي البوابة الوحيدة قبل خروج المال الى المورد: ايصال صرف مكتمل بمصدر نقد مقفل. غيابها يعني دفعا مكررا او دفعا لمن لا يستحق، وكلاهما لا يرجع.",
    decidesOn: [
      "اسم المورد",
      "المبلغ وعملته",
      "الفواتير التي سيسددها والمتبقي عليها",
      "طريقة الدفع ومرجعها",
      "مصدر النقد ورصيده المتاح",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "supplierPayments", name: "decidePayment" },
    href: () => "/purchases?tab=supplier-payments",
  }),

  /**
   * [`supplierPaymentsRouter.ts:125`](../server/routers/supplierPaymentsRouter.ts#L125) ⇐
   * [`purchase/supplierPayments.ts:1452`](../server/services/purchase/supplierPayments.ts#L1452).
   * مصنَّفٌ `ERASE_EFFECT`: عكسٌ جبريٌّ كاملٌ للدفع سطراً بسطر (المالُ يدخل، والمستندُ يُمحى).
   */
  "supplier.payment.refund": spec({
    kind: "supplier.payment.refund",
    title: "اعتماد استرداد سداد مورد",
    why: "الاعتماد يمحو دفعة منشورة: يعكس القيد ويرفع ذمة المورد ويعيد الفاتورة مفتوحة. تمريره بلا عين يفتح بابا لاخفاء دفعة وقعت فعلا.",
    decidesOn: [
      "اسم المورد",
      "الدفعة الاصلية ومبلغها وتاريخها",
      "المبلغ المسترد",
      "الفواتير التي ستعود مفتوحة",
      "نوع الدليل ومرجعه",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "supplierPayments", name: "decideRefund" },
    href: () => "/purchases?tab=supplier-payments",
  }),

  /**
   * [`goodsReceiptReversalRouter.ts:51`](../server/routers/goodsReceiptReversalRouter.ts#L51) ⇐
   * [`purchase/goodsReceipts.ts:1077`](../server/services/purchase/goodsReceipts.ts#L1077).
   * كان **آخر موضعٍ في المشتريات خارج السجلّ** (D3 = 1 على هذا الراوتر وحده). الاعتماد
   * يُخرج البضاعة من المخزون ويعكس GRNI ويُعيد الاستلام إلى ما قبل التوريد — محوُ أثرٍ
   * مخزنيّ قائم. `href` ⇐ تبويب **عكس الاستلامات** في `PurchasesHub` (`goods-receipt-reversals`
   * حرفياً — تبويبٌ غيرُ مُسجَّل يُسقط `PageTabs` إلى أوّل تبويبٍ مرئيّ بصمت؛ Codex على #1004).
   * المعرّف معرّفُ طلب العكس وليس له مسارٌ مستقلّ.
   */
  "purchase.goodsReceipt.reversal": spec({
    kind: "purchase.goodsReceipt.reversal",
    title: "اعتماد عكس استلام بضاعة",
    why: "الاعتماد يخرج البضاعة من المخزون ويعكس التزام الاستلام غير المفوتر: توريد سجل ثم اختفى بلا عين يترك رصيدا كاذبا وتكلفة مرجحة مسمومة.",
    decidesOn: [
      "اسم المورد",
      "رقم الاستلام وتاريخه وقيمته",
      "الاصناف والكميات المعكوسة",
      "سبب العكس",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "goodsReceiptReversal", name: "decideReversal" },
    href: () => "/purchases?tab=goods-receipt-reversals",
  }),

  /**
   * [`supplierInvoiceApprovalRouter.ts:60`](../server/routers/supplierInvoiceApprovalRouter.ts#L60) ⇐
   * [`purchase/supplierInvoices.ts:827`](../server/services/purchase/supplierInvoices.ts#L827).
   * الراوتر يقبل `REVERSE_INVOICE` وحده عمداً (مراجعة Codex على #1001) — الترحيلُ الاعتياديّ
   * يقع آلياً داخل سلسلة `purchases.decideControl`. الاعتماد يعكس قيد AP ويُنقص ذمة المورد
   * ويعيد فاتورة مرحلة إلى ما قبل الترحيل. `href` ⇐ تبويب **اعتمادات فواتير الموردين**
   * (`supplier-invoice-approvals` حرفياً كما في `PurchasesHub`).
   */
  "purchase.supplierInvoice.reversal": spec({
    kind: "purchase.supplierInvoice.reversal",
    title: "اعتماد عكس فاتورة مورد",
    why: "الاعتماد يعكس قيد الذمة الدائنة ويسحب الفاتورة من كشف المورد: فاتورة رحلت ثم محيت بلا عين تخفي دينا حقيقيا او تبرر دفعة بلا مستند.",
    decidesOn: [
      "اسم المورد",
      "رقم الفاتورة الخارجي وقيمتها وعملتها",
      "الدفعات المرتبطة بها",
      "نوع الدليل ومرجعه",
      "سبب العكس",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "supplierInvoiceApproval", name: "decideApproval" },
    href: () => "/purchases?tab=supplier-invoice-approvals",
  }),
};

// ═════════════════════════════════ المخزون والجرد ═════════════════════════════════

const INVENTORY: Record<string, DecisionSpec> = {
  /**
   * [`inventoryRouter.ts:430`](../server/routers/inventoryRouter.ts#L430) ⇐
   * [`inventory/adjustmentApproval.ts:245`](../server/services/inventory/adjustmentApproval.ts#L245).
   * فصلُ المهام مُنفَّذٌ نصّاً (`assertIndependentInventoryReviewer`، السطر 219).
   */
  "inventory.adjustment.approve": spec({
    kind: "inventory.adjustment.approve",
    title: "اعتماد تسوية مخزون",
    why: "الاعتماد يكتب حركة مخزون ويرحل قيد ADJUST بقيمة الفرق مضروبا بالتكلفة. هو الطريق الوحيد لتغيير رصيد قائم بلا بيع ولا شراء، اي الطريق الذي يخفي به السارق نقصه.",
    decidesOn: [
      "الصنف والوحدة والفرع",
      "الرصيد الحالي والرصيد المطلوب",
      "الفرق بالكمية وبالقيمة",
      "سبب التسوية والمرفق",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "inventory", name: "approveAdjustment" },
    href: () => "/inventory?tab=movements",
  }),

  /**
   * [`inventoryRouter.ts:456`](../server/routers/inventoryRouter.ts#L456) ⇐
   * [`inventory/adjustmentApproval.ts`](../server/services/inventory/adjustmentApproval.ts).
   * الرفضُ لا يكتب مخزوناً ولا قيداً — لكنّه يُعلَن للطالب بإشعار.
   */
  "inventory.adjustment.reject": spec({
    kind: "inventory.adjustment.reject",
    title: "رفض تسوية مخزون",
    why: "الرفض بلا سبب مكتوب يترك الفرق المخزني قائما بلا اثر يفسره، فيعاد طلبه بصياغة اخرى حتى يمر. السبب هو ما يجعل الرفض معلومة لا صمتا.",
    decidesOn: [
      "الصنف والفرع",
      "الفرق بالكمية وبالقيمة",
      "سبب التسوية المطلوب",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "inventory", name: "rejectAdjustment" },
    href: () => "/inventory?tab=movements",
  }),

  /**
   * [`inventoryRouter.ts:543`](../server/routers/inventoryRouter.ts#L543) ⇐
   * [`inventory/costRevaluationRequest.ts:322`](../server/services/inventory/costRevaluationRequest.ts#L322).
   * مصنَّفٌ `ERASE_EFFECT`: يُغيّر القيمة الدفترية لمخزونٍ **قائم** ويُرحّل قيداً لكلّ فرعٍ له رصيد.
   */
  "inventory.costRevaluation.approve": spec({
    kind: "inventory.costRevaluation.approve",
    title: "اعتماد اعادة تقييم تكلفة",
    why: "الاعتماد يغير القيمة الدفترية لمخزون قائم ويرحل قيدا لكل فرع له رصيد. هذا هو المسار الذي بني خصيصا كي لا تقع حركة حقوق صامتة، فمروره بلا عين يفرغه من معناه.",
    decidesOn: [
      "الصنف والوحدة",
      "التكلفة الحالية والتكلفة المقترحة",
      "الكميات المتاثرة في كل فرع",
      "اثر القيمة الاجمالي",
      "سبب اعادة التقييم ومستنده",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "inventory", name: "approveCostRevaluation" },
    href: () => "/inventory?tab=stock",
  }),

  /** [`inventoryRouter.ts:560`](../server/routers/inventoryRouter.ts#L560). */
  "inventory.costRevaluation.reject": spec({
    kind: "inventory.costRevaluation.reject",
    title: "رفض اعادة تقييم تكلفة",
    why: "التكلفة الخاطئة تبقى تسمم كل هامش ربح يعرضه النظام حتى تصحح. الرفض بلا سبب يترك الصنف على قيمة يعرف طالبها انها خطا ولا يعرف احد لماذا رفض تصحيحها.",
    decidesOn: [
      "الصنف",
      "التكلفة الحالية والمقترحة",
      "اثر القيمة الاجمالي",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "inventory", name: "rejectCostRevaluation" },
    href: () => "/inventory?tab=stock",
  }),

  /**
   * [`stocktakeRouter.ts:580`](../server/routers/stocktakeRouter.ts#L580) ⇐
   * `decideStocktakeItem`. قرارٌ لكلّ صنفٍ داخل الجلسة: تسوية أم إبقاء. `href` ⇐ معرّف الجلسة.
   */
  "stocktake.item.decide": spec({
    kind: "stocktake.item.decide",
    title: "بت فرق جرد لصنف",
    why: "قرار ADJUST يحول فرق العد الى تسوية مخزون حقيقية، وقرار KEEP يبقي الرصيد الدفتري. اختيار الاسهل صنفا صنفا هو كيف يتحول الجرد من كشف الى تغطية.",
    decidesOn: [
      "الصنف والوحدة",
      "الرصيد الدفتري والمعدود",
      "الفرق بالكمية وبالقيمة",
      "من عد ومن راجع",
      "سبب الفرق المصنف",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "stocktakes", name: "decide" },
    href: (id) => `/stocktakes/${id}/review`,
  }),

  /** [`stocktakeRouter.ts:608`](../server/routers/stocktakeRouter.ts#L608). `href` ⇐ معرّف الجلسة. */
  "stocktake.items.approve": spec({
    kind: "stocktake.items.approve",
    title: "اعتماد اصناف مجرودة",
    why: "الاعتماد الجماعي يمرر عشرات الاصناف بضغطة واحدة. بلا عرض قيمة الفرق لكل صنف يصير المعتمد ختما لا عينا، ويمر الصنف الثمين مع مئة صنف تافه.",
    decidesOn: [
      "عدد الاصناف المختارة",
      "اكبر الفروق قيمة بينها",
      "مجموع اثر القيمة",
      "الاصناف التي فرقها فوق العتبة",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "stocktakes", name: "approveItems" },
    href: (id) => `/stocktakes/${id}/review`,
  }),

  /**
   * [`stocktakeRouter.ts:705`](../server/routers/stocktakeRouter.ts#L705) ⇐ `approveStocktake`.
   * تعليقُ الراوتر صريح: «منشئ ≠ معتمد وعادّ ≠ معتمد، admin مُستثنى للتصحيح الإداريّ»،
   * ويؤكّده [`stocktake/reviewCore.ts:375`](../server/services/stocktake/reviewCore.ts#L375).
   */
  "stocktake.session.approve": spec({
    kind: "stocktake.session.approve",
    title: "اعتماد جلسة جرد",
    why: "اعتماد الجلسة يثبت كل تسوياتها دفعة واحدة على المخزون والقيود. هي اللحظة التي يصير فيها العد حقيقة محاسبية، ولا رجوع بعدها الا بجلسة جديدة.",
    decidesOn: [
      "الفرع ونطاق الجرد",
      "عدد الاصناف التي بها فرق",
      "مجموع اثر القيمة (زيادة ونقصا)",
      "الاصناف الاكبر فرقا",
      "من عد ومن وقع اولا",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: false,
    procedure: { router: "stocktakes", name: "approve" },
    href: (id) => `/stocktakes/${id}/report`,
  }),
};

// ═══════════════════════════ الخزينة والنقد والمصروفات ═══════════════════════════

const TREASURY: Record<string, DecisionSpec> = {
  /**
   * [`voucherRouter.ts:153`](../server/routers/voucherRouter.ts#L153) ⇐ `approveVoucher`.
   * التصنيفُ بالفعل لا بالإجراء ([`approvalTriggers.ts`](./approvalTriggers.ts)): سندُ `OUT`
   * ⇒ `MONEY_OUT`؛ و`IN` عاديّ ⇒ بلا مُطلِق **لكنّ ضابطَه مُستبقًى بقرار المالك ٢/٩/٢٦**
   * لأنّه البوّابة الوحيدة على نقدٍ مجهول المصدر يدخل الخزينة.
   */
  "treasury.voucher.approve": spec({
    kind: "treasury.voucher.approve",
    title: "اعتماد سند",
    why: "سند الصرف يخرج نقدا من الدرج او الخزينة فورا. وسند القبض هو الضابط الوحيد على نقد يدخل بلا مصدر معروف، فالطرفان يحتاجان عينا لا واحد منهما.",
    decidesOn: [
      "اتجاه السند (قبض ام صرف)",
      "المبلغ",
      "الطرف المنسوب اليه (عميل او مورد او موظف)",
      "التبويب وسبب السند",
      "مصدر النقد ورصيده المتاح",
      "الفاتورة المرتبطة ان وجدت",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "vouchers", name: "approve" },
    href: () => "/treasury?tab=vouchers",
  }),

  /** [`voucherRouter.ts:183`](../server/routers/voucherRouter.ts#L183) ⇐ `rejectVoucher`. */
  "treasury.voucher.reject": spec({
    kind: "treasury.voucher.reject",
    title: "رفض سند",
    why: "السند المرفوض يترك مالا معلقا بلا تبويب: لا خرج ولا دخل. السبب المكتوب هو ما يمنع اعادة تقديمه بصياغة اخرى، ويبقي اثرا لماذا لم يقبل.",
    decidesOn: [
      "اتجاه السند",
      "المبلغ",
      "الطرف المنسوب اليه",
      "سبب السند المعلن",
      "سبب الرفض",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "vouchers", name: "reject" },
    href: () => "/treasury?tab=vouchers",
  }),

  /**
   * [`expenseRouter.ts:383`](../server/routers/expenseRouter.ts#L383) — البوّابة `ownerProcedure`
   * (`server/trpc.ts:211` = `requireOwnerSession`) ⇒ المالكُ حصراً.
   */
  "expense.approve": spec({
    kind: "expense.approve",
    title: "اعتماد مصروف",
    why: "الاعتماد يخرج المال ويعترف بالمصروف في تقريره. المصروف هو المكان الذي يتسرب منه المال بلا مقابل عيني يمكن جرده لاحقا، فهو بوابة المالك.",
    decidesOn: [
      "تبويب المصروف",
      "المبلغ",
      "الجهة المستفيدة",
      "الفرع والفترة المحاسبية",
      "المستند المرفق او مرجعه",
      "من طلب",
    ],
    approver: "OWNER_ONLY",
    withdrawable: false,
    procedure: { router: "expenses", name: "approve" },
    href: () => "/treasury?tab=expenses",
  }),

  /** [`expenseRouter.ts:394`](../server/routers/expenseRouter.ts#L394) — `ownerProcedure`. */
  "expense.reject": spec({
    kind: "expense.reject",
    title: "رفض مصروف",
    why: "الرفض هو المكان الذي يتعلم فيه الموظف ما لا يصرف عليه. رفض بلا سبب يعيد نفس المصروف بعد اسبوع بتبويب مختلف.",
    decidesOn: [
      "تبويب المصروف",
      "المبلغ",
      "الجهة المستفيدة",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "OWNER_ONLY",
    withdrawable: false,
    procedure: { router: "expenses", name: "reject" },
    href: () => "/treasury?tab=expenses",
  }),

  /**
   * [`expenseRouter.ts:255`](../server/routers/expenseRouter.ts#L255) — `ownerProcedure`.
   * الاستردادُ مصنَّفٌ `ERASE_EFFECT` في [`approvalTriggers.ts`](./approvalTriggers.ts)
   * (`postEntry` بمبلغٍ سالب + عكسُ الاعتراف).
   */
  "expense.accrualCorrection.approve": spec({
    kind: "expense.accrualCorrection.approve",
    title: "اعتماد تصحيح استحقاق مصروف",
    why: "التصحيح يعكس اعترافا محاسبيا منشورا وقد يرد مالا. هو مسح لرقم ظهر في تقرير سابق، فالفترة التي اقفلت على الرقم القديم تصير كاذبة ان مر بلا اثر.",
    decidesOn: [
      "المصروف الاصلي ومبلغه وتاريخه",
      "المبلغ الصحيح والفرق",
      "الفترة المحاسبية المتاثرة",
      "هل يترتب عليه رد نقدي",
      "سبب التصحيح",
    ],
    approver: "OWNER_ONLY",
    withdrawable: false,
    procedure: { router: "expenses", name: "approveAccrualCorrection" },
    href: () => "/treasury?tab=expenses",
  }),

  /** [`expenseRouter.ts:266`](../server/routers/expenseRouter.ts#L266) — `ownerProcedure`. */
  "expense.accrualCorrection.reject": spec({
    kind: "expense.accrualCorrection.reject",
    title: "رفض تصحيح استحقاق مصروف",
    why: "الرفض يبقي الرقم الخاطئ منشورا في تقرير الفترة. لذلك سبب الرفض ليس مجاملة: هو الاقرار بان الرقم القائم صحيح فعلا.",
    decidesOn: [
      "المصروف الاصلي ومبلغه",
      "المبلغ المقترح والفرق",
      "الفترة المتاثرة",
      "سبب الرفض",
    ],
    approver: "OWNER_ONLY",
    withdrawable: false,
    procedure: { router: "expenses", name: "rejectAccrualCorrection" },
    href: () => "/treasury?tab=expenses",
  }),

  /**
   * [`cashVarianceRouter.ts:116`](../server/routers/cashVarianceRouter.ts#L116).
   * التصنيفُ بالفعل: العجز ⇒ `MONEY_OUT` (ايصال `OUT/CASH/TREASURY`)، والزيادة ⇒ بلا مُطلِق
   * لكنّ ضابطَها **مُستبقًى** حتى يحسمه المالك (`cashVarianceApprovalRetainsLegacy`).
   */
  "cash.variance.approve": spec({
    kind: "cash.variance.approve",
    title: "اعتماد معالجة فرق نقد",
    why: "العجز المعتمد يخرج نقدا من الخزينة، والزيادة المعتمدة تحول نقدا مجهول المصدر الى التزام مبوب. الفرق الذي يمر بلا عين هو كيف يصير العجز المتكرر عادة لا انذارا.",
    decidesOn: [
      "الوردية والدرج والتاريخ",
      "النقد المتوقع والمعدود",
      "قيمة الفرق واتجاهه (عجز ام زيادة)",
      "من كان مسؤولا عن الدرج",
      "المعالجة المقترحة ومن يتحملها",
      "فروق سابقة لنفس الشخص",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "treasury.cashVariance", name: "approve" },
    href: () => "/treasury?tab=cash-variance",
  }),

  /** [`cashVarianceRouter.ts:122`](../server/routers/cashVarianceRouter.ts#L122). */
  "cash.variance.reject": spec({
    kind: "cash.variance.reject",
    title: "رفض معالجة فرق نقد",
    why: "الرفض يبقي الفرق مفتوحا، وهو ما يمنع اقفال اليوم وتوريد الخزينة. فالرفض هنا قرار بابقاء الباب مغلقا حتى يفسر الفرق، لا مجرد اعتراض.",
    decidesOn: [
      "الوردية والدرج والتاريخ",
      "قيمة الفرق واتجاهه",
      "المعالجة المقترحة",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "treasury.cashVariance", name: "reject" },
    href: () => "/treasury?tab=cash-variance",
  }),

  /**
   * [`missedDailyCountExceptionRouter.ts:80`](../server/routers/missedDailyCountExceptionRouter.ts#L80)
   * ⇐ `decideMissedDailyCountException`.
   */
  "cash.missedDailyCount.decide": spec({
    kind: "cash.missedDailyCount.decide",
    title: "بت استثناء عد يومي فائت",
    why: "النظام يمنع اقفال اليوم وتوريد الخزينة مع ايام لم تعد. الاستثناء هو المفتاح الوحيد لتجاوز ذلك، فمنحه بلا عين يفتح ثغرة تلغي كل حراسة العد اليومي.",
    decidesOn: [
      "التاريخ الفائت والفرع",
      "الدرج او الخزينة المعنية",
      "الرصيد القائم وقت الفوات",
      "سبب عدم العد",
      "من طلب الاستثناء",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "treasury.missedDailyCount", name: "decide" },
    href: () => "/treasury?tab=daily-reconciliation",
  }),

  /**
   * [`exchangeRouter.ts:271`](../server/routers/exchangeRouter.ts#L271) ⇐ `approveExchangeDeposit`.
   * `href` ⇐ شاشة الصيرفة (المعرّفُ هو `txnId` وليس له مسارٌ مستقلّ).
   */
  "exchange.deposit.approve": spec({
    kind: "exchange.deposit.approve",
    title: "اعتماد ايداع صيرفة",
    why: "الايداع يدخل مالا الى حساب الصيرفة وينسبه لطرف. اعتماده بلا تحقق من المصدر يجعل الحساب مستودعا لنقد بلا مسار، وهو ما تمنعه القاعدة المالية الحاكمة.",
    decidesOn: [
      "الحساب المستفيد",
      "المبلغ وعملته",
      "سعر الصرف المطبق ان وجد",
      "مصدر المال ومرجعه",
      "من سجل الايداع",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "exchange", name: "approveDeposit" },
    href: () => "/exchange",
  }),
};

// ═════════════════════════ البيع والمرتجع وامر الشغل ═════════════════════════

const SALES: Record<string, DecisionSpec> = {
  /**
   * [`salesControlRouter.ts:124`](../server/routers/salesControlRouter.ts#L124) ⇐
   * [`sale/controlRequests.ts:120`](../server/services/sale/controlRequests.ts#L120) —
   * الطالبُ ممنوعٌ من الاعتماد نصّاً، ويحرسه CHECK في المخطّط (`chk_sales_control_maker_checker`).
   * ⚠️ رافدُ ردّ النقد يختاره **المعتمِد** لا الطالب (الدرج المُجمَّد قد يكون أُقفل).
   */
  "sales.control.approve": spec({
    kind: "sales.control.approve",
    title: "اعتماد ضبط مبيعات",
    why: "الطلب يلغي فاتورة او يصححها او يرد مالا لعميل. اعتماده يعكس قيدا منشورا ويخرج نقدا من درج قد يكون اقفل، فالمعتمد يختار رافد الرد لا الطالب.",
    decidesOn: [
      "الفاتورة ورقمها واجماليها",
      "نوع الضبط (الغاء ام تصحيح ام رد)",
      "المبلغ الذي سيرد",
      "الدرج او الخزينة التي سيخرج منها",
      "سبب الطلب",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: true,
    procedure: { router: "salesControl", name: "approve" },
    href: () => "/invoices?tab=controls",
  }),

  /**
   * [`salesControlRouter.ts:173`](../server/routers/salesControlRouter.ts#L173).
   * ⚠️ والرفضُ محجوبٌ عن الطالب أيضاً — ولذلك بُني له مخرجٌ مستقلّ: `salesControl.withdraw`
   * ([`salesControlRouter.ts:190`](../server/routers/salesControlRouter.ts#L190)، حالة
   * `WITHDRAWN` في المخطّط)، وهو الوحيدُ من نوعه في المشتريات والمبيعات معاً.
   */
  "sales.control.reject": spec({
    kind: "sales.control.reject",
    title: "رفض ضبط مبيعات",
    why: "الرفض يبقي الفاتورة كما هي ويحرر ارتباطها. وبما ان الطالب لا يملك رفض طلبه، فان الرفض بلا سبب يترك الكاشير امام عميل ينتظر بلا جواب يقوله له.",
    decidesOn: [
      "الفاتورة ورقمها واجماليها",
      "نوع الضبط المطلوب",
      "المبلغ المطلوب رده",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "INDEPENDENT_REVIEWER",
    withdrawable: true,
    procedure: { router: "salesControl", name: "reject" },
    href: () => "/invoices?tab=controls",
  }),

  /**
   * [`returnRouter.ts:258`](../server/routers/returnRouter.ts#L258) ⇐ `approveReturnRequest`.
   * الاعتمادُ يقبل حمولةَ `refund` (مبلغ · طريقة · درج · مرجع) و`restock` — أي أنّ المعتمِد
   * يقرّر رافدَ الردّ وإعادةَ الادخال معاً، لا الطالب.
   */
  "sales.returnRequest.approve": spec({
    kind: "sales.returnRequest.approve",
    title: "اعتماد طلب مرتجع بيع",
    why: "الاعتماد يعيد البضاعة الى المخزن ويرد مالا للعميل وينقص الايراد. والمرتجع الوهمي هو اسهل طريق لسحب نقد من الدرج بورقة سليمة الشكل.",
    decidesOn: [
      "الفاتورة الاصلية ورقمها",
      "الاصناف والكميات المرتجعة",
      "المبلغ المطلوب رده والمدفوع اصلا",
      "رافد الرد (نقد ام بطاقة ام ذمة)",
      "هل تعاد البضاعة للمخزن",
      "سبب الارجاع ومن طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "returns", name: "approveRequest" },
    href: () => "/invoices?tab=returns",
  }),

  /** [`returnRouter.ts:315`](../server/routers/returnRouter.ts#L315) ⇐ `rejectReturnRequest`. */
  "sales.returnRequest.reject": spec({
    kind: "sales.returnRequest.reject",
    title: "رفض طلب مرتجع بيع",
    why: "الرفض يعني ان العميل لن يسترد ماله ولن تعود البضاعة. السبب المكتوب هو ما يحمله الكاشير الى العميل، وبدونه يصير الرفض خصومة شخصية.",
    decidesOn: [
      "الفاتورة الاصلية ورقمها",
      "الاصناف والكميات المطلوب ارجاعها",
      "المبلغ المطلوب رده",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "returns", name: "rejectRequest" },
    href: () => "/invoices?tab=returns",
  }),

  /**
   * [`workOrderRouter.ts:532`](../server/routers/workOrderRouter.ts#L532) ⇐
   * `approveWorkOrderControlRequest`. الاعتماد يقبل `refundRail`/`refundShiftId` ⇒ المعتمِد
   * يختار رافدَ الردّ (ذاكرة `approver-owns-refund-rail-2026-09-02`).
   */
  "workOrder.control.approve": spec({
    kind: "workOrder.control.approve",
    title: "اعتماد ضبط امر شغل",
    why: "الاعتماد يلغي امر شغل او يعكس تسليمه: يرد عربونا ويعكس الخامة المستهلكة والقيد. ورافد الرد قرار المعتمد لان درج الطالب قد يكون اقفل قبل البت.",
    decidesOn: [
      "امر الشغل ورقمه وحالته",
      "نوع الضبط المطلوب",
      "المقبوض عليه والمبلغ الذي سيرد",
      "رافد الرد والدرج",
      "الخامة المستهلكة ومصيرها",
      "سبب الطلب ومن طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "workOrders", name: "approveControl" },
    href: (id) => `/work-orders/${id}`,
  }),

  /** [`workOrderRouter.ts:550`](../server/routers/workOrderRouter.ts#L550). */
  "workOrder.control.reject": spec({
    kind: "workOrder.control.reject",
    title: "رفض ضبط امر شغل",
    why: "الرفض يبقي الامر في مساره ويبقي العربون محتجزا. وما دام المال محتجزا فان سبب الرفض هو المستند الوحيد الذي يفسر للعميل لماذا لم يرد اليه.",
    decidesOn: [
      "امر الشغل ورقمه وحالته",
      "نوع الضبط المطلوب",
      "المبلغ المحتجز",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "workOrders", name: "rejectControl" },
    href: (id) => `/work-orders/${id}`,
  }),

  /**
   * [`workOrderRouter.ts:1812`](../server/routers/workOrderRouter.ts#L1812) — `ownerProcedure`.
   * `href` ⇐ **معرّف الايصال** (`receiptId`) لا امر الشغل؛ يُعرَض من تبويب السندات.
   */
  "workOrder.cancellationRefund.approve": spec({
    kind: "workOrder.cancellationRefund.approve",
    title: "اعتماد رد الغاء امر شغل",
    why: "هذا هو خروج المال الفعلي بعد الغاء امر الشغل، ويلزمه مرجع تاكيد مكتوب. بلا بوابة المالك يصير الالغاء طريقا لسحب نقد بلا بيع ولا مرتجع.",
    decidesOn: [
      "امر الشغل الملغى ورقمه",
      "المبلغ المقبوض والمبلغ الذي سيرد",
      "رافد الرد (درج ام خزينة ام بطاقة)",
      "مرجع تاكيد الرد",
      "العميل المستفيد",
    ],
    approver: "OWNER_ONLY",
    withdrawable: false,
    procedure: { router: "workOrders", name: "approveCancellationRefund" },
    href: () => "/treasury?tab=vouchers",
  }),

  /**
   * [`workOrderDesignApprovalRouter.ts:60`](../server/routers/workOrderDesignApprovalRouter.ts#L60).
   * ⚠️ `href` يأخذ **معرّف المهمّة** (`/tasks/:id`) لا `approvalId` — الشاشةُ الوحيدة التي
   * تستهلك هذا الإجراء هي [`TaskDetail.tsx:242`](../client/src/pages/TaskDetail.tsx#L242).
   */
  "workOrder.designApproval.decide": spec({
    kind: "workOrder.designApproval.decide",
    title: "بت اعتماد تصميم",
    why: "موافقة العميل على التصميم هي ما يمنع اعادة العمل على حساب المطبعة. والدليل الزامي هنا لان الخلاف لاحقا يكون على من وافق ومتى، لا على التصميم نفسه.",
    decidesOn: [
      "امر الشغل والمهمة",
      "نسخة التصميم المعروضة",
      "نوع دليل الموافقة ومرجعه",
      "من صمم ومن يراجع",
      "سبب القرار",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "workOrderDesignApproval", name: "decide" },
    href: (id) => `/tasks/${id}`,
  }),
};

// ═════════════════════════════════ التوصيل ═════════════════════════════════

const DELIVERY: Record<string, DecisionSpec> = {
  /**
   * [`deliveryRouter.ts:873`](../server/routers/deliveryRouter.ts#L873) ⇐
   * `approveDeliveryCodWriteOff`. `href` ⇐ تبويب جهات التوصيل (`DeliveryParties`).
   */
  "delivery.codWriteOff.approve": spec({
    kind: "delivery.codWriteOff.approve",
    title: "اعتماد شطب تحصيل توصيل",
    why: "الشطب يمحو ذمة قائمة على جهة التوصيل، اي يعفيها من مال قبضته ولم توردها. هو الباب الذي يتحول به العجز المتكرر الى خسارة صامتة على المكتبة.",
    decidesOn: [
      "جهة التوصيل واسم المندوب",
      "المبلغ المطلوب شطبه",
      "الفواتير والطرود المرتبطة",
      "عمر الطرد المفتوح",
      "سبب العجز المصنف",
      "شطوبات سابقة لنفس الجهة",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "delivery", name: "approveWriteOffRequest" },
    href: () => "/delivery?tab=parties",
  }),

  /** [`deliveryRouter.ts:891`](../server/routers/deliveryRouter.ts#L891). */
  "delivery.codWriteOff.reject": spec({
    kind: "delivery.codWriteOff.reject",
    title: "رفض شطب تحصيل توصيل",
    why: "الرفض يبقي الذمة على جهة التوصيل، وهو ما يمنع اسناد طرود جديدة اليها ما دام لديها طرود قديمة مفتوحة. فالرفض قرار تشغيلي لا اداري.",
    decidesOn: [
      "جهة التوصيل واسم المندوب",
      "المبلغ المطلوب شطبه",
      "الفواتير والطرود المرتبطة",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "delivery", name: "rejectWriteOffRequest" },
    href: () => "/delivery?tab=parties",
  }),
};

// ═══════════════════════ الموارد البشرية والاجور والعمولات ═══════════════════════

const HR: Record<string, DecisionSpec> = {
  /**
   * [`payrollRouter.ts:130`](../server/routers/payrollRouter.ts#L130) — `ownerHrWrite`
   * (بوّابةُ مالك). `href` ⇐ تبويب الرواتب.
   */
  "payroll.run.approve": spec({
    kind: "payroll.run.approve",
    title: "اعتماد دورة رواتب",
    why: "الاعتماد يجمد اجور الشهر ويحول الدورة الى التزام واجب الدفع لكل موظف. وبعده يصير الشهر مصروفا مجمدا لا يقبل تعديلا رجعيا.",
    decidesOn: [
      "الشهر والفرع",
      "عدد الموظفين",
      "اجمالي الاجور والاستقطاعات",
      "الصافي الواجب دفعه",
      "الفروق عن الشهر السابق",
      "الموظفون الذين تغير اجرهم",
    ],
    approver: "OWNER_ONLY",
    withdrawable: false,
    procedure: { router: "payroll", name: "approve" },
    href: () => "/hr?tab=payroll",
  }),

  /** [`payrollRouter.ts:275`](../server/routers/payrollRouter.ts#L275) — `hrWrite` (مدير). */
  "payroll.remittance.approve": spec({
    kind: "payroll.remittance.approve",
    title: "اعتماد حوالة رواتب",
    why: "الحوالة هي خروج المال الفعلي الى الموظفين. اعتمادها على قائمة لا تعرض المستفيدين ومبالغهم يعني تحويل مبلغ اجمالي لا يعرف احد توزيعه.",
    decidesOn: [
      "الدورة والشهر",
      "قائمة المستفيدين ومبالغهم",
      "الاجمالي المحول",
      "قناة التحويل ومرجعها",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "payroll", name: "approveRemittance" },
    href: () => "/hr?tab=payroll",
  }),

  /** [`payrollRouter.ts:288`](../server/routers/payrollRouter.ts#L288). */
  "payroll.remittance.reject": spec({
    kind: "payroll.remittance.reject",
    title: "رفض حوالة رواتب",
    why: "الرفض يؤخر اجر موظفين استحقوه فعلا. لذلك السبب الزامي: هو الفرق بين خطا في بيانات التحويل وبين احتجاز اجر بلا وجه.",
    decidesOn: [
      "الدورة والشهر",
      "الاجمالي المحول",
      "عدد المستفيدين",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "payroll", name: "rejectRemittance" },
    href: () => "/hr?tab=payroll",
  }),

  /** [`payrollRouter.ts:486`](../server/routers/payrollRouter.ts#L486) — `ownerHrWrite`. */
  "payroll.advanceRepayment.approve": spec({
    kind: "payroll.advanceRepayment.approve",
    title: "اعتماد تسديد سلفة",
    why: "الاعتماد يقفل سلفة على ذمة موظف. اقفالها بلا تحقق من دخول المال فعلا يعني اعفاء ديون بصيغة اجرائية لا يظهر في اي تقرير مصروف.",
    decidesOn: [
      "الموظف",
      "السلفة الاصلية ومبلغها وتاريخها",
      "المبلغ المسدد والمتبقي",
      "طريقة التسديد ومرجعها (خصم من الاجر ام نقد)",
      "من طلب",
    ],
    approver: "OWNER_ONLY",
    withdrawable: false,
    procedure: { router: "payroll", name: "approveAdvanceRepayment" },
    href: () => "/hr?tab=advances",
  }),

  /** [`payrollRouter.ts:504`](../server/routers/payrollRouter.ts#L504) — `ownerHrWrite`. */
  "payroll.advanceRepayment.reject": spec({
    kind: "payroll.advanceRepayment.reject",
    title: "رفض تسديد سلفة",
    why: "الرفض يبقي السلفة على ذمة الموظف وتستمر الاستقطاعات. السبب هو ما يمنع تكرار الخصم على موظف سدد فعلا ولم يوثق تسديده.",
    decidesOn: [
      "الموظف",
      "السلفة ومبلغها",
      "المبلغ المدعى تسديده",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "OWNER_ONLY",
    withdrawable: false,
    procedure: { router: "payroll", name: "rejectAdvanceRepayment" },
    href: () => "/hr?tab=advances",
  }),

  /**
   * [`leaveRouter.ts:180`](../server/routers/leaveRouter.ts#L180) ⇐ `decideLeave`.
   * ⭐ **قابلٌ للسحب**: للموظّف مخرجٌ ذاتيّ عبر `superApp.withdrawLeave`
   * ([`superAppRouter.ts:2355`](../server/routers/superAppRouter.ts#L2355) ⇐
   * [`leaveService.ts:359`](../server/services/leaveService.ts#L359)).
   */
  "hr.leave.decide": spec({
    kind: "hr.leave.decide",
    title: "بت طلب اجازة",
    why: "القرار يغير رصيد الاجازات ويؤثر في احتساب الاجر والحضور. وقبوله بلا رؤية من يغطي الوردية يترك الفرع بلا كاشير في يوم ذروة.",
    decidesOn: [
      "الموظف وفرعه",
      "نوع الاجازة",
      "التواريخ وعدد الايام",
      "الرصيد المتبقي بعد الطلب",
      "من يغطي المناوبة",
      "سبب الطلب",
    ],
    approver: "MANAGER",
    withdrawable: true,
    procedure: { router: "leaves", name: "decide" },
    href: () => "/hr?tab=leaves",
  }),

  /** [`promotionRouter.ts:150`](../server/routers/promotionRouter.ts#L150) ⇐ `approvePromotion`. */
  "hr.promotion.approve": spec({
    kind: "hr.promotion.approve",
    title: "اعتماد ترقية موظف",
    why: "الترقية تغير الاجر الاساس، والاجر الاساس يدخل في كل دورة رواتب لاحقة وفي تسوية نهاية الخدمة. خطؤها لا يظهر شهرا واحدا بل يتراكم.",
    decidesOn: [
      "الموظف ومسماه الحالي",
      "المسمى الجديد",
      "الاجر الحالي والاجر الجديد",
      "تاريخ سريان الترقية",
      "سبب الترقية ومن طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "promotions", name: "approvePromotion" },
    href: () => "/hr?tab=promotions",
  }),

  /** [`hrDeviceRouter.ts:297`](../server/routers/hrDeviceRouter.ts#L297) ⇐ `svc.getDevice`. */
  "hr.device.approve": spec({
    kind: "hr.device.approve",
    title: "اعتماد جهاز حضور",
    why: "الجهاز المعتمد يصير مصدرا موثوقا لبصمات الحضور، والحضور هو مدخل احتساب الاجر. جهاز يعتمد بلا تحقق من موقعه يفتح باب تسجيل حضور من خارج الفرع.",
    decidesOn: [
      "اسم الجهاز وبصمته العتادية",
      "الفرع الذي سينسب اليه",
      "عنوان الشبكة الذي ظهر منه",
      "اول ظهور له وعدد بصماته المعلقة",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "hrDevices", name: "approveDevice" },
    href: () => "/hr?tab=devices",
  }),

  /**
   * [`commissionsRouter.ts:238`](../server/routers/commissionsRouter.ts#L238) ⇐
   * `runApprovalsSvc.approveCommissionRunRequest` + `assertCompanyCommissionAuthority`.
   */
  "commissions.run.approve": spec({
    kind: "commissions.run.approve",
    title: "اعتماد دورة عمولات",
    why: "الاعتماد يحول حساب العمولة الى مستحق واجب الدفع للمندوبين. ومصدره فواتير قد تلغى او ترتجع لاحقا، فالمعتمد يحتاج ان يرى الوعاء لا الاجمالي.",
    decidesOn: [
      "الخطة والفترة",
      "المندوبون ومبلغ كل منهم",
      "وعاء الاحتساب (المبيعات المؤهلة)",
      "الاجمالي المستحق",
      "الفرق عن الدورة السابقة",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "commissions", name: "approveRequest" },
    href: () => "/hr?tab=commission-runs",
  }),

  /** [`commissionsRouter.ts:257`](../server/routers/commissionsRouter.ts#L257). */
  "commissions.run.reject": spec({
    kind: "commissions.run.reject",
    title: "رفض دورة عمولات",
    why: "الرفض يمنع صرف عمولة محسوبة، وهو غالبا لان الوعاء خاطئ لا لان المندوب لا يستحق. السبب هو ما يوجه اعادة الاحتساب بدل اعادة الطلب كما هو.",
    decidesOn: [
      "الخطة والفترة",
      "الاجمالي المحسوب",
      "عدد المندوبين",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "commissions", name: "rejectRequest" },
    href: () => "/hr?tab=commission-runs",
  }),
};

// ═══════════════════════════ الاقفال المحاسبي والاصول ═══════════════════════════

const CLOSING: Record<string, DecisionSpec> = {
  /**
   * [`periodLockRouter.ts:306`](../server/routers/periodLockRouter.ts#L306) ⇐ `approveMonthClose`.
   * مصنَّفٌ ضمن `ERASE_EFFECT` مفهومياً (مسُّ فترةٍ مُقفَلة) في [`approvalPolicy.ts`](./approvalPolicy.ts).
   */
  "closing.monthClose.approve": spec({
    kind: "closing.monthClose.approve",
    title: "اعتماد اقفال شهر",
    why: "الاقفال يمنع اي قيد جديد على الشهر. اعتماده وفيه مستندات معلقة يجمد ارقاما ناقصة تصير هي المرجع، وفتحه لاحقا يحتاج بوابة اخرى.",
    decidesOn: [
      "الشهر والفرع",
      "المستندات المعلقة المانعة",
      "فروق النقد غير المعالجة",
      "قضايا سلامة المشتريات المفتوحة",
      "من طلب الاقفال",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "periodLock", name: "approveClose" },
    href: () => "/closing?tab=period",
  }),

  /** [`periodLockRouter.ts:351`](../server/routers/periodLockRouter.ts#L351) ⇐ `rejectMonthClose`. */
  "closing.monthClose.reject": spec({
    kind: "closing.monthClose.reject",
    title: "رفض اقفال شهر",
    why: "الرفض يبقي الشهر مفتوحا فتستمر القيود عليه. السبب هو قائمة ما يجب معالجته قبل اعادة الطلب، وبدونه يعاد الطلب كما هو بعد يوم.",
    decidesOn: [
      "الشهر والفرع",
      "المستندات المعلقة",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "periodLock", name: "rejectClose" },
    href: () => "/closing?tab=period",
  }),

  /** [`yearEndRouter.ts:130`](../server/routers/yearEndRouter.ts#L130) ⇐ `approveYearEndReopen`. */
  "closing.yearEndReopen.approve": spec({
    kind: "closing.yearEndReopen.approve",
    title: "اعتماد اعادة فتح سنة",
    why: "اعادة الفتح تلغي اقفالا سنويا نشرت ارقامه، وقد تكون سلمت الى محاسب او جهة رسمية. هذا اخطر ما في الاقفال لان اثره يمتد خارج النظام.",
    decidesOn: [
      "السنة المالية",
      "سبب اعادة الفتح المعلن",
      "القيود التي ستتاثر",
      "هل سلمت ارقام السنة الى جهة خارجية",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "yearEnd", name: "approveReopen" },
    href: () => "/closing?tab=yearend",
  }),

  /** [`yearEndRouter.ts:157`](../server/routers/yearEndRouter.ts#L157) ⇐ `rejectYearEndReopen`. */
  "closing.yearEndReopen.reject": spec({
    kind: "closing.yearEndReopen.reject",
    title: "رفض اعادة فتح سنة",
    why: "الرفض يبقي السنة مقفلة، وهو القرار الافتراضي الصحيح. السبب يوثق ان الخطا المدعى عولج بطريق اخر لا انه اهمل.",
    decidesOn: [
      "السنة المالية",
      "سبب اعادة الفتح المطلوب",
      "سبب الرفض",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "yearEnd", name: "rejectReopen" },
    href: () => "/closing?tab=yearend",
  }),

  /**
   * [`statutoryAccountingRouter.ts:266`](../server/routers/statutoryAccountingRouter.ts#L266)
   * ⇐ `approveStatutoryProfile`. يشترط اسمَ المحاسب ومرجعَ اعتماده.
   */
  "statutory.profile.approve": spec({
    kind: "statutory.profile.approve",
    title: "اعتماد ملف محاسبي نظامي",
    why: "الملف يحدد كيف تعرض ارقام النظام في الدفتر النظامي المسلم للجهة الرسمية. اعتماده باسم محاسب ومرجع هو ما ينسب المسؤولية لشخص حقيقي.",
    decidesOn: [
      "الملف والسنة التي يغطيها",
      "خرائط الحسابات فيه",
      "اسم المحاسب المعتمد",
      "مرجع الاعتماد",
      "الفروق عن الملف السابق",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "statutoryAccounting", name: "approveProfile" },
    href: () => "/statutory-accounting",
  }),

  /**
   * [`assetsRouter.ts:104`](../server/routers/assetsRouter.ts#L104) ⇐ `approveAccrualCorrection`
   * (نفسُ محرّك تصحيح الاستحقاق، بوسم الأصل). `href` ⇐ **معرّف الأصل**.
   */
  "asset.acquisitionCorrection.approve": spec({
    kind: "asset.acquisitionCorrection.approve",
    title: "اعتماد تصحيح اقتناء اصل",
    why: "تصحيح قيمة الاقتناء يغير اساس الاهلاك، فيغير مصروف الاهلاك في كل شهر تال وقيمة الاصل الدفترية. خطؤه يمتد سنوات لا شهرا.",
    decidesOn: [
      "الاصل ورقمه",
      "قيمة الاقتناء الحالية والمصححة",
      "الفرق واثره على الاهلاك المتراكم",
      "الفترات المتاثرة",
      "سبب التصحيح ومستنده",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "assets", name: "approveAcquisitionCorrection" },
    href: (id) => `/assets/${id}`,
  }),

  /** [`assetsRouter.ts:115`](../server/routers/assetsRouter.ts#L115). `href` ⇐ معرّف الأصل. */
  "asset.acquisitionCorrection.reject": spec({
    kind: "asset.acquisitionCorrection.reject",
    title: "رفض تصحيح اقتناء اصل",
    why: "الرفض يبقي اساس الاهلاك على قيمته الحالية، اي يقر ضمنا بانها صحيحة. السبب المكتوب هو هذا الاقرار.",
    decidesOn: [
      "الاصل ورقمه",
      "القيمة الحالية والمقترحة",
      "الفرق واثره على الاهلاك",
      "سبب الرفض",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "assets", name: "rejectAcquisitionCorrection" },
    href: (id) => `/assets/${id}`,
  }),
};

// ═══════════════════════════════ البطاقات الرقمية ═══════════════════════════════

const DIGITAL_CARDS: Record<string, DecisionSpec> = {
  /**
   * [`digitalCards/pricingRouter.ts:112`](../server/routers/digitalCards/pricingRouter.ts#L112)
   * ⇐ `pricingService.approveBigChange`. `href` ⇐ تبويب التسعير.
   */
  "digitalCards.pricing.bigChange.approve": spec({
    kind: "digitalCards.pricing.bigChange.approve",
    title: "اعتماد تغيير سعر كبير",
    why: "الدفعة تغير اسعار بيع بطاقات دفعة واحدة فوق عتبة الامان. تمريرها بلا رؤية الفرق لكل بطاقة يبيع بخسارة او يوقف البيع بسعر شاذ حتى ينتبه احد.",
    decidesOn: [
      "الدفعة وعدد البطاقات فيها",
      "السعر القديم والجديد لكل بطاقة",
      "نسبة التغير واتجاهه",
      "تكلفة الشراء لكل بطاقة",
      "من طلب التغيير",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.pricing", name: "approveBigChange" },
    href: () => "/digital-cards?tab=pricing",
  }),

  /**
   * [`digitalCards/pricingRouter.ts:148`](../server/routers/digitalCards/pricingRouter.ts#L148).
   * بلاغُ الكاشير «السعر لدى الجهاز مختلف» لا يغيّر سعراً بذاته — الاعتمادُ هو الذي يغيّره.
   */
  "digitalCards.pricing.mismatch.approve": spec({
    kind: "digitalCards.pricing.mismatch.approve",
    title: "اعتماد بلاغ اختلاف سعر",
    why: "الاعتماد يثبت السعر الذي ابلغ به الكاشير سعرا رسميا لليوم. قبوله بلا مقارنة بالتكلفة يجعل بلاغ الكاشير طريقا لتسعير ما دون التكلفة.",
    decidesOn: [
      "البطاقة والفرع",
      "السعر المسجل والسعر المبلغ عنه",
      "تكلفة الشراء والهامش الناتج",
      "تاريخ العمل المتاثر",
      "من ابلغ",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.pricing", name: "approveMismatch" },
    href: () => "/digital-cards?tab=pricing",
  }),

  /** [`digitalCards/pricingRouter.ts:161`](../server/routers/digitalCards/pricingRouter.ts#L161). */
  "digitalCards.pricing.mismatch.reject": spec({
    kind: "digitalCards.pricing.mismatch.reject",
    title: "رفض بلاغ اختلاف سعر",
    why: "الرفض يبقي السعر المسجل ويبقي الكاشير يبيع بسعر يراه خاطئا. الملاحظة المكتوبة هي ما يحسم الخلاف بدل ان يعاد البلاغ كل يوم.",
    decidesOn: [
      "البطاقة والفرع",
      "السعر المسجل والمبلغ عنه",
      "سبب الرفض",
      "من ابلغ",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.pricing", name: "rejectMismatch" },
    href: () => "/digital-cards?tab=pricing",
  }),

  /**
   * [`digitalCards/reversalRouter.ts:16`](../server/routers/digitalCards/reversalRouter.ts#L16)
   * ⇐ `reversalService.approveReversal`. `href` ⇐ **معرّف الفاتورة**.
   */
  "digitalCards.reversal.approve": spec({
    kind: "digitalCards.reversal.approve",
    title: "اعتماد عكس بيع بطاقة",
    why: "العكس يلغي بيع بطاقة سلمت للعميل ويرد قيمتها. والبطاقة الرقمية لا تعود الى المخزن، فالعكس بلا تحقق من عدم استعمالها خسارة مباشرة.",
    decidesOn: [
      "الفاتورة ورقمها",
      "البطاقات المطلوب عكسها وارقامها",
      "قيمة كل بطاقة والاجمالي",
      "هل استعملت البطاقة لدى المزود",
      "سبب العكس ومن طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.reversal", name: "approve" },
    href: (id) => `/invoices/${id}`,
  }),

  /** [`digitalCards/reversalRouter.ts:53`](../server/routers/digitalCards/reversalRouter.ts#L53). */
  "digitalCards.lossRefund.reject": spec({
    kind: "digitalCards.lossRefund.reject",
    title: "رفض رد خسارة بطاقة",
    why: "الرفض يبقي الخسارة على المكتبة او على الموظف بحسب التصنيف. وهو قرار مالي حقيقي لا اجرائي، فيحتاج ان يرى المبلغ ومن يتحمله.",
    decidesOn: [
      "الفاتورة والبطاقات المعنية",
      "قيمة الخسارة",
      "من يتحملها بعد الرفض",
      "سبب الرفض",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.reversal", name: "rejectLossRefund" },
    href: (id) => `/invoices/${id}`,
  }),

  /**
   * [`digitalCards/salesRouter.ts:141`](../server/routers/digitalCards/salesRouter.ts#L141)
   * ⇐ `reviewResolutionService.approveResolution`. `href` ⇐ تبويب المراجعة.
   */
  "digitalCards.reviewResolution.approve": spec({
    kind: "digitalCards.reviewResolution.approve",
    title: "اعتماد معالجة نية بيع معلقة",
    why: "النية المعلقة هي بيع بدا ولم يثبت: مال قد يكون قبض وبطاقة قد تكون سلمت. اعتماد المعالجة يحسم الاتجاهين معا، وخطؤه يخلق فاتورة بلا بطاقة او العكس.",
    decidesOn: [
      "النية ورقمها وتاريخها",
      "البطاقة المطلوبة وقيمتها",
      "هل قبض المال",
      "حالة الطلب لدى المزود",
      "المعالجة المقترحة",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.sales", name: "approveReviewResolution" },
    href: () => "/digital-cards?tab=review",
  }),

  /** [`digitalCards/salesRouter.ts:146`](../server/routers/digitalCards/salesRouter.ts#L146). */
  "digitalCards.reviewResolution.reject": spec({
    kind: "digitalCards.reviewResolution.reject",
    title: "رفض معالجة نية بيع معلقة",
    why: "الرفض يبقي النية معلقة، اي يبقي المال والبطاقة في وضع غير محسوم. لذلك السبب الزامي: هو التزام بان المعالجة الصحيحة ستاتي لا بان الملف اغلق.",
    decidesOn: [
      "النية ورقمها وتاريخها",
      "البطاقة وقيمتها",
      "هل قبض المال",
      "سبب الرفض",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.sales", name: "rejectReviewResolution" },
    href: () => "/digital-cards?tab=review",
  }),

  /** [`digitalCards/salesRouter.ts:164`](../server/routers/digitalCards/salesRouter.ts#L164). */
  "digitalCards.intentWriteoff.approve": spec({
    kind: "digitalCards.intentWriteoff.approve",
    title: "اعتماد شطب نية عالقة",
    why: "الشطب يعترف بخسارة قيمة البطاقة نهائيا ويغلق النية. هو الاعتراف بان المال ضاع، فلا يمر بلا عين ترى المبلغ وسببه.",
    decidesOn: [
      "النية ورقمها وعمرها",
      "قيمة البطاقة المشطوبة",
      "حالة الطلب لدى المزود",
      "سبب التعليق الاصلي",
      "من طلب الشطب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.sales", name: "approveWriteoff" },
    href: () => "/digital-cards?tab=review",
  }),

  /** [`digitalCards/salesRouter.ts:170`](../server/routers/digitalCards/salesRouter.ts#L170). */
  "digitalCards.intentWriteoff.reject": spec({
    kind: "digitalCards.intentWriteoff.reject",
    title: "رفض شطب نية عالقة",
    why: "الرفض يعني ان المال ما زال قابلا للاسترداد من المزود. وهو قرار يلزم بمتابعة، فبقاء النية معلقة بلا متابعة اسوا من شطبها.",
    decidesOn: [
      "النية ورقمها وعمرها",
      "قيمة البطاقة",
      "حالة الطلب لدى المزود",
      "سبب الرفض",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.sales", name: "rejectWriteoff" },
    href: () => "/digital-cards?tab=review",
  }),

  /**
   * [`digitalCards/walletsRouter.ts:116`](../server/routers/digitalCards/walletsRouter.ts#L116)
   * ⇐ `walletOpsService.approveAdjustment`. `href` ⇐ تبويب المحافظ.
   */
  "digitalCards.wallet.adjustment.approve": spec({
    kind: "digitalCards.wallet.adjustment.approve",
    title: "اعتماد تسوية محفظة مزود",
    why: "التسوية تغير رصيد محفظة لدى المزود بلا شراء ولا بيع. هي نظير تسوية المخزون في المال: الطريق الوحيد لتغيير رصيد قائم، فهي حيث يخفى النقص.",
    decidesOn: [
      "المحفظة والمزود",
      "الرصيد قبل التسوية وبعدها",
      "قيمة التسوية واتجاهها",
      "كشف المزود المقابل",
      "سبب التسوية ومن طلب",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.wallets", name: "approveAdjustment" },
    href: () => "/digital-cards?tab=wallets",
  }),

  /** [`digitalCards/walletsRouter.ts:122`](../server/routers/digitalCards/walletsRouter.ts#L122). */
  "digitalCards.wallet.adjustment.reject": spec({
    kind: "digitalCards.wallet.adjustment.reject",
    title: "رفض تسوية محفظة مزود",
    why: "الرفض يبقي الفرق بين رصيدنا وكشف المزود قائما، وهو فرق يكبر مع كل يوم لا يعالج. السبب يوجه الى المطابقة الصحيحة بدل تكرار الطلب.",
    decidesOn: [
      "المحفظة والمزود",
      "الفرق بين رصيدنا وكشف المزود",
      "قيمة التسوية المطلوبة",
      "سبب الرفض",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.wallets", name: "rejectAdjustment" },
    href: () => "/digital-cards?tab=wallets",
  }),

  /** [`digitalCards/walletsRouter.ts:189`](../server/routers/digitalCards/walletsRouter.ts#L189). */
  "digitalCards.wallet.variance.resolve": spec({
    kind: "digitalCards.wallet.variance.resolve",
    title: "اعتماد تسوية فرق مطابقة محفظة",
    why: "هذا الاجراء يعتمد التسوية ويقفل جلسة المطابقة معا. اقفال المطابقة يعني الاقرار بان رصيدنا يطابق المزود، فان كان خطا ضاع الفرق بلا اثر يعاد اليه.",
    decidesOn: [
      "جلسة المطابقة وتاريخها",
      "رصيدنا ورصيد المزود",
      "الفرق المتبقي بعد التسوية",
      "التسوية المرتبطة وقيمتها",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "digitalCards.wallets", name: "approveAndResolveVariance" },
    href: () => "/digital-cards?tab=wallets",
  }),
};

// ═══════════════════════ الكتالوج والمحتوى والحملات والهدايا ═══════════════════════

const CONTENT: Record<string, DecisionSpec> = {
  /**
   * [`catalogRouter.ts:663`](../server/routers/catalogRouter.ts#L663) ⇐ `decideProductContentDraft`.
   */
  "catalog.contentDraft.decide": spec({
    kind: "catalog.contentDraft.decide",
    title: "بت مسودة محتوى منتج",
    why: "المحتوى المعتمد يظهر للزبون في المتجر ويصير الوصف الرسمي للمنتج. وصف خاطئ لمواصفة او مقاس ينتج مرتجعات لا يكشف سببها احد.",
    decidesOn: [
      "المنتج",
      "النص الحالي والنص المقترح",
      "الصور المرفقة",
      "من كتب المسودة",
      "سبب القرار",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "catalog", name: "decideContentDraft" },
    href: () => "/products/content-drafts",
  }),

  /**
   * [`productStudioRouter.ts:293`](../server/routers/productStudioRouter.ts#L293) ⇐
   * `approveStudioTask` (بـ`expectedRevision` — حارسٌ تفاؤليّ على النسخة).
   */
  "productStudio.task.approve": spec({
    kind: "productStudio.task.approve",
    title: "اعتماد مهمة استوديو صور",
    why: "الاعتماد ينشر الصورة على المنتج في كل شاشة وفي المتجر. صورة لصنف اخر هي اسرع طريق لبيع خاطئ، ولا يكشفها الا الزبون عند الاستلام.",
    decidesOn: [
      "المنتج والبديل المصور",
      "الصور المقترحة",
      "الصور الحالية ان وجدت",
      "من صور ومن راجع",
      "سبب التجاوز الاداري ان وجد",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "productStudio", name: "approve" },
    href: () => "/catalog/image-studio",
  }),

  /** [`productStudioRouter.ts:294`](../server/routers/productStudioRouter.ts#L294). */
  "productStudio.task.reject": spec({
    kind: "productStudio.task.reject",
    title: "رفض مهمة استوديو صور",
    why: "الرفض يعيد المهمة الى المصور، والسبب هو التوجيه الوحيد الذي يمنع اعادة نفس الصورة. رفض بلا سبب يدور المهمة بلا نهاية.",
    decidesOn: [
      "المنتج والبديل المصور",
      "الصور المرفوضة",
      "سبب الرفض",
      "من صور",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "productStudio", name: "reject" },
    href: () => "/catalog/image-studio",
  }),

  /**
   * [`storeAdminRouter.ts:498`](../server/routers/storeAdminRouter.ts#L498) ⇐
   * `approveStorefrontPushCampaign`. البوّابة `storeGlobalAdminProcedure`.
   */
  "store.pushCampaign.approve": spec({
    kind: "store.pushCampaign.approve",
    title: "اعتماد حملة اشعارات متجر",
    why: "الحملة ترسل اشعارا الى كل زبائن المتجر ولا يمكن سحبه بعد الارسال. خطا في النص او في العرض المعلن يصل الى الالاف في ثوان ويلزم الشركة به.",
    decidesOn: [
      "نص الاشعار كما سيصل",
      "الجمهور المستهدف وعدده",
      "العرض او الرابط المرفق",
      "موعد الارسال",
      "من اعد الحملة",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "storeAdmin", name: "approve" },
    href: () => "/store-admin",
  }),

  /**
   * [`broadcastsRouter.ts:166`](../server/routers/broadcastsRouter.ts#L166) ⇐ `approveBroadcast`.
   * ⚠️ مركزُ واتساب معطَّلٌ بلا تكامل `ACTIVE` (CLAUDE.md §٦) — الإجراءُ مبنيٌّ والتدفّقُ مغلق.
   */
  "broadcast.approve": spec({
    kind: "broadcast.approve",
    title: "اعتماد بث واتساب",
    why: "البث يرسل رسالة الى قائمة عملاء باسم الشركة ولا يسترد. وتجاوز حدود المزود يعرض رقم الشركة للحجب، فالخطا هنا يكلف القناة كلها لا رسالة.",
    decidesOn: [
      "نص الرسالة والقالب المعتمد",
      "قائمة المستقبلين وعددها",
      "توقيت الارسال",
      "المرفقات ان وجدت",
      "من اعد البث",
    ],
    approver: "MANAGER",
    withdrawable: false,
    procedure: { router: "broadcasts", name: "approve" },
    href: () => "/reports/whatsapp-hub",
  }),

  /**
   * [`giftsRouter.ts:217`](../server/routers/giftsRouter.ts#L217) ⇐ `approveGift`.
   * ⭐ **قابلٌ للسحب**: `gifts.cancelGift` ([`giftsRouter.ts:225`](../server/routers/giftsRouter.ts#L225))
   * يسمح لصاحب الطلب بإلغاء طلبه المعلَّق — والأثرُ لا يُطبَّق إلّا عند الاعتماد.
   */
  "gifts.request.approve": spec({
    kind: "gifts.request.approve",
    title: "اعتماد طلب هدية",
    why: "الاعتماد يخرج بضاعة من المخزن بلا فاتورة بيع ويحمل تكلفتها على قيد GIFT_OUT خارج وعاء العمولة. هو خروج مخزون مجاني، فالباب الاسهل للتسرب.",
    decidesOn: [
      "الاصناف والكميات",
      "تكلفة ما سيخرج",
      "الجهة المستفيدة وسبب الاهداء",
      "الفرع الذي سيخصم منه",
      "من طلب",
    ],
    approver: "MANAGER",
    withdrawable: true,
    procedure: { router: "gifts", name: "approveGift" },
    href: () => "/gifts",
  }),
};

/**
 * السجلّ الكامل — الاتحادُ المسطَّح لكلّ المجموعات أعلاه.
 *
 * التقسيمُ إلى ثوابتَ وسيطة تنظيمٌ للقراءة لا أكثر؛ المستهلِكُ يرى خريطةً واحدة.
 */
export const DECISION_REGISTRY: Record<DecisionKind, DecisionSpec> = {
  ...PURCHASING,
  ...INVENTORY,
  ...TREASURY,
  ...SALES,
  ...DELIVERY,
  ...HR,
  ...CLOSING,
  ...DIGITAL_CARDS,
  ...CONTENT,
};

/** يُرجع مواصفةَ القرار، أو `undefined` لمفتاحٍ غير مُسجَّل. */
export function decisionSpec(kind: string): DecisionSpec | undefined {
  return DECISION_REGISTRY[kind];
}

/** كلُّ القرارات المُسجَّلة — للعرض في صندوق القرار الموحّد. */
export function allDecisions(): DecisionSpec[] {
  return Object.values(DECISION_REGISTRY);
}

/**
 * القراراتُ التي يفتحها فاعلٌ بصفةٍ معيّنة — تُستعمل لبناء «مطلوب مني الآن».
 * ⚠️ فرزٌ للعرض لا إنفاذُ صلاحية: الإنفاذُ خادميٌّ دائماً (CLAUDE.md §٢).
 */
export function decisionsForApprover(approver: DecisionApprover): DecisionSpec[] {
  return allDecisions().filter((d) => d.approver === approver);
}


// ═══════════════════════ صندوق القرار الموحّد — نموذج الصفّ ═══════════════════════
//
// هذا القسم هو **عقد الصفّ** بين الخادم (`server/services/decisions/**` يبنيه من مصادره
// الفعلية) والشاشة (`client/src/components/decision/DecisionRow.tsx` تعرضه وتحسم فيه).
// كلُّ ما هنا نقيٌّ: بلا I/O وبلا `Date.now()` مخفيّة — «الآن» يصل في المدخل صراحةً.

/** ما يستطيع المُقرِّر فعله على صفٍّ. `WITHDRAW` للطالب وحده على القرارات القابلة للسحب. */
export const DECISION_ACTIONS = ["APPROVE", "REJECT", "WITHDRAW"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export const DECISION_ACTION_LABEL_AR: Record<DecisionAction, string> = {
  APPROVE: "اعتماد",
  REJECT: "رفض",
  WITHDRAW: "سحب الطلب",
};

/**
 * نتيجةُ الحسم — **مُهيكَلة لا «نجاح» عارٍ** (عيب Codex SALE-04: اعتمادٌ على طلبٍ صار
 * `STALE` كان يُبلَّغ نجاحاً). الشاشةُ تعرض كلَّ نتيجةٍ بلونها ونصّها لا بتوست «تم».
 *  · `EXECUTED`  الاعتماد وقع وأثرُه كُتب (مخزون/قيد/حالة).
 *  · `REQUESTED` الاعتماد لم يُنفَّذ بعد بل أنشأ طلباً ينتظر جهةً أعلى (مثل ايصال ردٍّ
 *                 معلَّق ينتظر المالك) — ليس نجاحاً كاملاً وليس فشلاً.
 *  · `STALE`     الطلب لم يعد معلَّقاً (حُسم من غيرك، أو تغيّر مستندُه بعد الطلب).
 *  · `REJECTED`  الرفض وقع وسُجّل سببه.
 *  · `WITHDRAWN` الطالبُ سحب طلبه.
 */
export const DECISION_OUTCOMES = ["EXECUTED", "REQUESTED", "STALE", "REJECTED", "WITHDRAWN"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const DECISION_OUTCOME_LABEL_AR: Record<DecisionOutcome, string> = {
  EXECUTED: "اعتمد ونفذ",
  REQUESTED: "اعتمد وينتظر جهة اعلى",
  STALE: "لم يعد معلقا",
  REJECTED: "رفض",
  WITHDRAWN: "سحب",
};

/** لحظةُ الخطر التي تفتح البوّابة — من `shared/approvalPolicy.ts` (تُكرَّر هنا نصّاً كي يبقى الملفّ بلا استيراد). */
export type DecisionTrigger = "MONEY_OUT" | "ERASE_EFFECT";

/** بندٌ ممّا يُقرَّر عليه فعلاً: صنفٌ بكمّيته وسعره، أو فاتورةٌ بمبلغها. */
export interface DecisionSummaryItem {
  label: string;
  qty?: number | string | null;
  unit?: string | null;
  unitPrice?: string | null;
}

/** حالةُ الطلب كما يقرؤها الصندوق قبل الحسم — لا ثالثَ للمعلَّق إلّا «حُسم» أو «زال». */
export type DecisionFreshness = "PENDING" | "DECIDED" | "GONE";

export interface DecisionSla {
  hours: number;
  remainingHours: number;
  breached: boolean;
}

/**
 * صفُّ الصندوق الموحّد — **يعرض ما يُقرَّر عليه** لا معرّفاً قاعدياً.
 *
 * ⛔ لا حقلَ هنا يُملأ «إن أمكن»: `party` و`amount` قد يكونان `null` لقرارٍ لا طرفَ له ولا
 * مبلغ (إجازة، إقفال شهر)، لكنّ `summaryItems` و`reason` يملؤهما كلُّ مصدرٍ بما يملك.
 */
export interface DecisionRowModel {
  /** مفتاحُ السجلّ (للأزواج approve/reject يُستعمل مفتاحُ الاعتماد). */
  kind: DecisionKind;
  /** معرّفُ الطلب الذي يستقبله الحسم — ليس بالضرورة معرّفَ المستند. */
  id: number;
  title: string;
  /** تسميةُ النوع الفرعيّ داخل النوع (مثل «إلغاء أمر» داخل ضبط أمر الشراء). */
  subkind: string | null;
  /** الطرف: مورّد/عميل/موظّف/جهة توصيل. */
  party: string | null;
  /** المبلغ نصّاً عشرياً بالعملة المذكورة، أو `null` لقرارٍ بلا مبلغ. */
  amount: string | null;
  currency: "IQD" | "USD";
  branchId: number | null;
  branchName: string | null;
  requestedBy: number | null;
  requestedByName: string | null;
  /** ISO-8601. */
  requestedAt: string;
  ageHours: number;
  sla: DecisionSla | null;
  summaryItems: DecisionSummaryItem[];
  reason: string | null;
  allowedActions: DecisionAction[];
  href: string;
  /** قفلٌ تفاؤليّ يُعاد إلى الخادم مع الحسم حيث تشترطه الخدمة. */
  expectedVersion: number | null;
  /** إقراراتٌ يلزم أن يوافق عليها المُقرِّر قبل الاعتماد (مثل «وصلت البضاعة كاملة»). */
  confirmations: Array<{ key: string; label: string }>;
  /** مرجعٌ نصّيّ يلزم الاعتماد (مثل مرجع تنفيذ الاسترداد على جهاز الدفع). */
  requiredReference: { key: string; label: string; minLength: number } | null;
  rejectReason: "REQUIRED" | "OPTIONAL" | "NOT_SUPPORTED";
  /** هل يلزم الاعتمادَ سببٌ مكتوب؟ (حوكمة المشتريات تشترطه على القرارين معاً). */
  approveReason: "REQUIRED" | "OPTIONAL";
  /** الحدُّ الأدنى لطول السبب حيث يلزم — تشترطه بعض الخدمات (5 أو 10 محارف). */
  reasonMinLength: number;
  /**
   * الاعتمادُ في مكانه غيرُ ممكن لسببٍ مكتوب (مثل: يلزم اختيارُ رافد الردّ من شاشة المستند).
   * حين لا يكون `null` يُخفي الصفُّ زرَّ الاعتماد ويعرض السبب مع رابط الشاشة.
   */
  approveBlockedReason: string | null;
  /**
   * صيغُ الاعتماد حين يكون للاعتماد **أكثرُ من نتيجةٍ واحدة** (قضيةُ السلامة: «حُلّت» أو
   * «تُصرَف»). فارغةٌ = اعتمادٌ واحد. حين لا تكون فارغةً يلزم المُقرِّرَ اختيارُ واحدةٍ صراحةً
   * وتُرسَل `variant` مع الحسم — ⛔ لا افتراضَ صامتٌ لأولاها: كان الصندوق يحوّل كلَّ اعتمادٍ
   * إلى «حُلّت» فيُمحى «تُصرَف» من الشيفرة (Codex على #1004).
   */
  approveVariants: Array<{ key: string; label: string }>;
  trigger: DecisionTrigger | null;
}

/**
 * تسمياتُ الأنواع الفرعية داخل القرار — قاموسٌ واحد لكلّ ما يعرضه الصندوق كنوعٍ فرعيّ
 * (نوعُ طلب ضبط أمر الشراء، نوعُ التحويل، ...). `subkind` في الصفّ يحمل التسمية لا المفتاح.
 */
export const DECISION_SUBKIND_LABEL_AR: Record<string, string> = {
  // ضبط أمر الشراء
  APPROVE_REVISION: "اعتماد المراجعة",
  CANCEL_ORDER: "الغاء الامر",
  EMERGENCY_ORDER: "امر طارئ",
  // طلب الشراء الداخلي
  APPROVE: "اعتماد",
  CANCEL: "الغاء",
  // مصروف الشراء
  POST: "ترحيل",
  REVERSE: "عكس",
  // فاتورة المورد
  POST_INVOICE: "ترحيل الفاتورة",
  REVERSE_INVOICE: "عكس الفاتورة",
  // ضبط امر الشغل
  COMMERCIAL_EDIT: "تعديل تجاري",
  MATERIAL_ADJUST: "تعديل خامات",
  REVERSE_DELIVERY: "عكس تسليم",
  // تحويلات الرواتب
  INCOME_TAX: "ضريبة الدخل",
  SOCIAL_SECURITY: "الضمان الاجتماعي",
  // سداد السلف
  REPAYMENT: "تقسيط سلفة",
  RETURN: "ارجاع تقسيط",
  // اعادة تقييم التكلفة
  CORRECTION: "تصحيح تكلفة",
  IMPAIRMENT: "انخفاض قيمة",
  // اتجاه السند
  IN: "سند قبض",
  OUT: "سند صرف",
};

export function decisionSubkindLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  return DECISION_SUBKIND_LABEL_AR[key] ?? key;
}

export interface DecisionDecideResult {
  kind: DecisionKind;
  id: number;
  action: DecisionAction;
  outcome: DecisionOutcome;
  /** نصٌّ عربيّ يُعرَض كما هو — من الخدمة الأصلية حين تُرجع رسالة. */
  message: string;
}

/**
 * سقفُ ساعات القرار — **افتراضٌ تشغيليّ لا عقد**: يرتّب الصندوق ويلوّن المتأخّر. ما يُخرج
 * مالاً يُنتظر أقلّ لأنّ الطرف الآخر ينتظر ماله؛ والباقي يومان.
 */
export const DEFAULT_DECISION_SLA_HOURS = 48;
export const MONEY_OUT_DECISION_SLA_HOURS = 24;

/** الساعات بين لحظتين — لا تقلّ عن صفر، بمنزلةٍ عشرية واحدة. */
export function decisionAgeHours(requestedAt: string | Date, now: Date): number {
  const at = typeof requestedAt === "string" ? new Date(requestedAt) : requestedAt;
  const ms = now.getTime() - at.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round((ms / 3_600_000) * 10) / 10;
}

/** يبني SLA الصفّ من عمره ولحظة خطره. */
export function decisionSla(ageHours: number, trigger: DecisionTrigger | null): DecisionSla {
  const hours = trigger === "MONEY_OUT" ? MONEY_OUT_DECISION_SLA_HOURS : DEFAULT_DECISION_SLA_HOURS;
  const remaining = Math.round((hours - ageHours) * 10) / 10;
  return { hours, remainingHours: remaining, breached: remaining < 0 };
}

/**
 * ترتيبُ الصندوق: المتأخّرُ عن سقفه أوّلاً (الأكثرُ تأخّراً فالأقلّ)، ثمّ الأقربُ إلى سقفه،
 * ثمّ الأقدم. صفٌّ بلا SLA يُعامَل كأنّ سقفه الافتراضيّ.
 */
export function sortDecisionRows<T extends Pick<DecisionRowModel, "ageHours" | "sla">>(rows: T[]): T[] {
  const remaining = (r: T) => r.sla?.remainingHours ?? DEFAULT_DECISION_SLA_HOURS - r.ageHours;
  return [...rows].sort((a, b) => {
    const ra = remaining(a);
    const rb = remaining(b);
    if (ra !== rb) return ra - rb;
    return b.ageHours - a.ageHours;
  });
}

export interface DecisionInboxFilter {
  kind?: string | null;
  branchId?: number | null;
  minAgeHours?: number | null;
}

/** ترشيحٌ نقيّ للعرض — الإنفاذُ (من يرى ماذا) خادميٌّ قبل هذا بمراحل. */
export function filterDecisionRows<T extends Pick<DecisionRowModel, "kind" | "branchId" | "ageHours">>(
  rows: T[],
  filter: DecisionInboxFilter,
): T[] {
  return rows.filter((r) => {
    if (filter.kind && r.kind !== filter.kind) return false;
    if (filter.branchId != null && r.branchId !== filter.branchId) return false;
    if (filter.minAgeHours != null && r.ageHours < filter.minAgeHours) return false;
    return true;
  });
}
