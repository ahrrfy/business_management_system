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
  /** B5: معرّف صفّ creditApprovals موجود (سقف صريح + انتهاء + single-use) — للتدفّق الجديد. */
  creditApprovalId?: number;
  /** B5: userId لمدير وُثِّقَت هويته خادمياً (الراوتر يمرّره بعد verifyManagerApproval) —
   *  الخدمة تُنشئ صفّ creditApproval ذرّياً داخل نفس withTx (مرتبط بالعميل، single-use، 5min TTL). */
  managerOverrideByUserId?: number;
  /** تاريخ استحقاق الفاتورة (YYYY-MM-DD) — للبيع الآجل. يظهر في AR aging والتنبيهات. */
  dueDate?: string | null;
  /** تقريب نقدي عراقي للبيع النقدي الكامل (يضبطه POS): الخادم يقرّب الإجمالي ويُسجّل الفرق ADJUST. */
  cashRoundIQD?: boolean;
  /** ش٦ — تقريب السلّة المختلطة (يضبطه checkoutReception حصراً، ليس على أيّ راوتر): إجماليٌّ
   *  فعّالٌ صريح يحمل فرقَ تقريبِ السلّة **كلّها** على هذه الفاتورة وحدها (قيد ADJUST بالفرق).
   *  محروس: نقديّ فقط، |الفرق| < ٢٥٠ (نصف خطوة التقريب ١٢٥ عملياً)، والناتج موجب. */
  cashRoundingOverride?: string | null;
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
}

export interface CreateSaleResult {
  invoiceId: number;
  invoiceNumber: string;
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
}
