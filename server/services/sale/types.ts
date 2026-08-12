// عقد البيع (POS/عبر القنوات) المشترك.
import type { PriceTier } from "../pricing";

// تصدير داخلي للحزمة فقط (يستهلكه create/payment) — لا يُعاد تصديره من البرميل saleService.ts.
// ش٥: TELECOM (رصيد زين) — يقبله receipts.paymentMethod منذ 0154؛ سطوح البيع العادية لا
// تعرضه (مقصورٌ على محطة الاستقبال خلف ضوابط reception/telecom.ts).
export type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET" | "TELECOM";

export interface SaleLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride?: string | null;
  discountPercent?: string | null;
  discountAmount?: string | null;
  /** promotions v2 (٨/٧/٢٦): معرّف العرض الذي عرضه POS للعميل — الخادم يتحقّق (idempotent)
   *  أن العرض ما زال ساري ويحسب `expectedDiscount = discountForUnit × qty` ويقارن مع `discountAmount`.
   *  إن طابق ⇒ يُخزَّن `promotionId` + `promotionDiscount` على invoiceItem. إن لم يطابق ⇒ لا نُخزّن
   *  (نعامل الخصم كيدوي) — لا نرفض لتفادي فشل بيع بعد تعديل عرض بين العرض والحفظ. */
  promotionId?: number | null;
  /**
   * **تصدير داخليّ بحت — لا يقبله أيّ راوتر ولا يصل من العميل إطلاقاً** (نمط `offlineCapture`).
   * تكلفة الوحدة المفروضة خادمياً لهذا السطر، تتجاوز `productVariants.costPrice`.
   *
   * مستهلكها الوحيد اليوم: تثبيت البيع الرقميّ (§١٠.٣) — تكلفة الكرت هي «حصة المزوّد» المقروءة
   * من نيّةٍ **مقفولة** في القاعدة، لا من الشاشة. بدونها يُسجَّل الكرت بتكلفة صفر فينتفخ الربح.
   */
  unitCostOverride?: string | null;
  /**
   * هدايا الفاتورة (0149): سطرٌ مُهدىً — يُطبَع في الفاتورة ويُخصَم من المخزون كسائر البنود، لكنّ
   * سعره **يُصفَّر خادمياً** (لا يُوثَق بسعرٍ وارد من الشاشة) وتكلفته تخرج من `invoices.costTotal`
   * وقيد SALE لتُرحَّل في قيد `GIFT_OUT` مصروفَ هدايا. فوق `GIFT_APPROVAL_THRESHOLD` (بالتكلفة)
   * يلزم تفويض مدير — نفس حوكمة سند الهدية المستقلّ.
   */
  isGift?: boolean;
  /**
   * معرّف ربط داخلي يعيده `createSaleInTx` مع invoiceItemId بعد إعادة ترتيب الأقفال.
   * لا يوجد في مخطط أيّ راوتر، ولا يُخزَّن في الفاتورة. يستعمله تركيب البيع الرقمي فقط
   * كي لا يربط مرجع كرت/طالب ببند آخر اعتماداً على ترتيب المصفوفة.
   */
  internalLineToken?: string | null;
}

export interface CreateSaleInput {
  branchId: number;
  shiftId?: number | null;
  customerId?: number | null;
  /** ٥/٨ — زبونٌ عابر: اسمٌ/هاتفٌ مرجعيّان على الفاتورة بلا سجلّ عميل ولا ذمّة. */
  contactName?: string | null;
  contactPhone?: string | null;
  priceTier?: PriceTier | null;
  sourceType: "POS" | "ONLINE" | "ORDER" | "WORKORDER";
  lines: SaleLineInput[];
  invoiceDiscount?: string | null;
  /** أجرة توصيل/شحن تُضاف على رأس الفاتورة كإيراد شحن (بلا تكلفة/مخزون). تُستعمل في إرسال طلب المتجر
   *  (COD) كي تكون invoice.total = subtotal + الشحن = ما وافق عليه الزبون، فيُحصّل المندوب كامل المبلغ. */
  deliveryFee?: string | null;
  /**
   * إفصاح التوصيل المجّاني (0152): `true` = وُصِّل الطلب و**أُهديت** أجرته. يميّزه عن «بلا
   * توصيل» (كلاهما `deliveryFee = 0`). لا أثر ماليّ: لا إيراد ولا قيد — إفصاحٌ للزبون وللتقارير.
   */
  deliveryFree?: boolean;
  /**
   * قيمة الأجرة المُتنازَل عنها (تُعرَض «مجاناً — قيمته X»). تُقبل مع `deliveryFree` فقط،
   * و**إلزامية** معه (قرار المالك ٦/٨/٢٦): توصيلٌ مجّانيّ بلا قيمة يُضيّع قياس ما أُهدي.
   */
  deliveryWaivedAmount?: string | null;
  taxRatePercent?: string | null;
  payment?: { amount: string; method: PaymentMethod; reference?: string | null } | null;
  /** ش٤ (§٧.٢) — مالٌ قُبض **سلفاً** على هذه السلة (عرابين مسوّدة عبر orderPayments):
   *  يدخل paidAmount والذمّة، و**لا يُنشأ له إيصالٌ ثانٍ أبداً** (الإيصال الجديد للجزء
   *  المُسلَّم الآن وحده — I5). receiptIds إيصالاتٌ قائمة تُختم invoiceId فقط إن مُرّرت
   *  (نمط deliver.ts — append-only)؛ مسار التثبيت يمرّرها فارغةً ويختم أحاديّ الهدف
   *  في allocateAtCommit حيث تُعرف وحدة الهدف. */
  preCollected?: { amount: string; receiptIds: number[] } | null;
  clientRequestId?: string | null;
  /** معرّف محطة/جهاز نقطة البيع للتدقيق (ليس سراً ولا رمز مصادقة). */
  deviceId?: string | null;
  /** رمز كوبون CRM؛ يُقفل ويُتحقق ويُستهلك ذرّياً مع الفاتورة. */
  couponCode?: string | null;
  notes?: string | null;
  /** موافقة مدير على تجاوز حدّ الائتمان (يضبطها الراوتر بعد التحقّق من هوية المدير).
   *  B5: إن كانت true يجب توفير إمّا creditApprovalId (تدفّق UI جديد) أو managerOverrideByUserId (تدفّق router قديم). */
  creditApproved?: boolean;
  /**
   * تفويض داخلي حصراً من checkoutReception بعد قفل عميل فعّال والتحقق من اسمه وهاتفه العراقي.
   * لا يظهر في أي مخطط راوتر عام، ويعفي بيع الاستقبال «بدون عربون» من سقف الائتمان مع إبقاء AR.
   */
  receptionDeferredAuthorized?: boolean;
  /** B5: معرّف صفّ creditApprovals موجود (سقف صريح + انتهاء + single-use) — للتدفّق الجديد. */
  creditApprovalId?: number;
  /** B5: userId لمدير وُثِّقَت هويته خادمياً (الراوتر يمرّره بعد verifyManagerApproval) —
   *  الخدمة تُنشئ صفّ creditApproval ذرّياً داخل نفس withTx (مرتبط بالعميل، single-use، 5min TTL). */
  managerOverrideByUserId?: number;
  /** تاريخ استحقاق الفاتورة (YYYY-MM-DD) — للبيع الآجل. يظهر في AR aging والتنبيهات. */
  dueDate?: string | null;
  /** تقريب نقدي عراقي للبيع النقدي الكامل (يضبطه POS): الخادم يقرّب الإجمالي ويُسجّل الفرق ADJUST. */
  cashRoundIQD?: boolean;
  /**
   * ش٦ — تقريب السلّة المختلطة (يضبطه checkoutReception حصراً، ليس على أيّ راوتر): هذه الفاتورة
   * هي **حاملة** فرق تقريب السلّة كلّها (قيد ADJUST بالفرق).
   *
   * ⚠️ مراجعة PR #495: كان الحقل **مبلغاً يرسله العميل** ويُقبل بحارسٍ واحد (|الفرق| < ٢٥٠) ⇒
   * كاشير يرسل ٧٥١ لأسطر مجموعها ١٠٠٠ فيخلق خصماً غير معتمدٍ حتى ٢٤٩ ديناراً، ويتجاوز بوّابتَي
   * «تحت التكلفة» و«الخصم اليدويّ» (تفحصان أسطر ما قبل التقريب). الآن يُمرَّر **مجموع بقيّة
   * السلّة كما حسبه الخادم** فقط، ويشتقّ الخادمُ الفرقَ بنفسه:
   *     الفرق = roundCashIQD(إجمالي هذه الفاتورة + الباقي) − (إجمالي هذه الفاتورة + الباقي)
   * ⇒ لا رقمَ ماليّ من العميل إطلاقاً، والفرق محبوسٌ بنيوياً في ±١٢٥ (نصف خطوة ٢٥٠).
   */
  cashRoundingBasketOthers?: string | null;
  /**
   * ش٧ — الدفع عند الاستلام (COD) بعهدة مندوبٍ تُنشَأ في **نفس المعاملة** (يضبطه
   * `checkoutReceptionInTx` حصراً، ولا يقبله أيّ راوتر — نمط `offlineCapture`).
   *
   * قرار المالك (٦/٨/٢٦): «لا تُحتسَب الفاتورة التي فيها توصيل ولديها مندوب على الكاشير
   * والدرج — الدرج فقط ما قُبض عربوناً نقدياً أو كاشاً من الفواتير.» فالمتبقّي على فاتورة
   * التوصيل **ليس ذمّةً على الزبون** (قد يكون عابراً بلا سجلّ) ولا نقداً في الدرج، بل
   * **عهدةٌ على المندوب** تُرفع بقيد DELIVERY_DISPATCH فور إنشاء الفاتورة.
   *
   * لذلك يرفع هذا العلم حارسَ «البيع الآجل يتطلب عميلاً» **وحده**: حدّ الائتمان يبقى نافذاً
   * على العميل المسجَّل، والمسؤولية الماليّة تنتقل للمندوب لا تختفي. مشروطٌ بنيوياً: الخدمة
   * التي ترفعه هي نفسها التي تُنشئ الإرسالية داخل المعاملة — فلا تُنشأ فاتورةٌ بلا حاملٍ لمالها.
   */
  codDispatchPending?: boolean;
  /** الاستقبال (٨/٨): تأكيد الموظّف أن الصنف **متوفّر فيزيائياً** رغم أنه غير مجرود (رصيد سالب)
   *  في وضع الافتتاح — يفتح البيع بالسالب لطلب توصيل COD (unpaid>0) الذي يحمله المندوب بيده.
   *  بدونه يبقى الحاصر: بيعُ COD لبضاعةٍ غير موجودة فعلاً بلا مالٍ مقبوض. مشروطٌ بوضع الافتتاح
   *  فعّالاً + تكلفة>0 + ضمن السقف (نفس رِيلات البيع النقديّ الكامل). لا يُفعِّل السالب خارج
   *  الافتتاح، ولا لبضاعة الأمانة (§٥-ج). يضبطه مسار الاستقبال بعد تأكيدٍ صريح من الموظّف. */
  openingSellUnavailableConfirmed?: boolean;
  /** SALES-01/02: موافقة على البيع بأقل من التكلفة (سعر override أو خصم يَنزل بالبند/الفاتورة تحت COGS).
   *  يضبطها الراوتر: مدير/أدمن لهما السلطة ذاتياً، والكاشير يحتاج managerApproval مُتحقَّقاً. */
  priceOverrideApproved?: boolean;
  /** أوفلاين (ش٣ — داخلي، لا يعرضه saleRouter): بيانات التقاط بيعٍ جرى دون اتصال —
   *  يضبطها offline.replaySale حصراً. تُخزَّن على الفاتورة (originatedOffline/الرقم المؤقّت/
   *  لحظة الالتقاط الحقيقية) — قيود الدفتر تبقى بوقت الخادم (سلامة assertPeriodOpen). */
  offlineCapture?: { capturedAt: Date; offlineReceiptNumber: string; deviceId?: string | null } | null;
  /** أوفلاين (ش٣ — داخلي): سماح بمخزون سالب — البضاعة خرجت فعلاً أثناء الانقطاع والنقد قُبض؛
   *  رفض التسجيل يجعل الدفاتر تكذب (قرار مالك ١٨/٧: تسجيل بوسم مراجعة لا تعليق).
   *  يضبطه offline.replaySale فقط، والوسم = originatedOffline + تقرير المبيعات الأوفلاين. */
  allowNegativeStock?: boolean;
  /** داخلي حصراً: يمنع كل استثناءات السالب (الأوفلاين ووضع الافتتاح) لهذا البيع. يستعمله تحويل
   *  الحجز لأن الوحدات وُعِدت لعميل بعينه؛ يجب أن يرفض `applyMovement` تحت قفل المخزون إذا خرجت
   *  فعلياً قبل التحويل، لا أن يحوّل الوعد إلى رصيد سالب. */
  strictStock?: boolean;
  /** تصحيح الفاتورة (٠١٦٨ — داخليّ بحت، يضبطه `correctSale` فقط، لا يقبله أيّ راوتر): يسمح بأن
   *  يتجاوز `preCollected` مستحقَّ الفاتورة (حالة overpay-down: التصحيح لأقلّ من المقبوض سلفاً).
   *  الحارس الاعتياديّ يرفض ذلك؛ هنا يُقصَر `paidNow` على الإجمالي كالمعتاد، والفائض يعالجه
   *  `correctSale` بعد إعادة الترحيل (ردّاً نقدياً أو رصيداً دائناً — قرار المالك الهجين). */
  allowPreCollectedOverpay?: boolean;
}

export interface CreateSaleResult {
  invoiceId: number;
  invoiceNumber: string;
  /** G3 (١١/٨): shiftId المُثبَّت على الفاتورة الفعليّة — سواء أُنشئت الآن أو أُعيدت من idempotent
   *  replay. يتيح للإيصال المطبوع أن يحمل رقم الوردية الحقيقيّة للمعاملة (لا الوردية الحيّة
   *  للفاعل التي قد تكون انفتحت بعد إغلاق الأصليّة). Codex P2 على PR #553. */
  shiftId?: number | null;
  total: string;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID";
  idempotentReplay?: boolean;
  /** SALES-01/02: صحيح إن باع بند/فاتورة تحت التكلفة (طُبِّق بموافقة) — للتدقيق. */
  priceOverride?: boolean;
  /** هدايا الفاتورة (0149): تكلفة البنود المُهداة (قيد GIFT_OUT) — يغيب إن لم تكن ثمّة هدية. */
  giftCost?: string;
  /** «وضع الافتتاح» (ش٢): أصناف هبطت تحت الصفر بهذا البيع (معلومة استشارية للمحاولة الفائزة
   *  فقط — replay الـidempotency لا يعيدها؛ حدث التدقيق sale.openingNegative يقع مرّة واحدة). */
  negativeDips?: { variantId: number; newQuantity: number }[];
  /** نتيجة داخلية لمسارات البيع المركّبة؛ الراوتر العام لا يرسل internalLineToken أصلاً. */
  createdLineItems?: { lineToken: string; invoiceItemId: number }[];
}
