/**
 * **شريط الأفعال** — عقدٌ واحدٌ يقول لكل مستندٍ أيُّ الأفعال الأربعة مسموحٌ عليه الآن،
 * ولِمَ مُنِع، وما المخرج.
 *
 * ## لماذا وُجد هذا الملف
 *
 * قرار المالك: «أريد التحكّم الكامل للإدارة من إلغاءٍ وتعديلٍ وإجراءاتٍ كاملة بشكلٍ سلس،
 * وشاشةُ التعديل تُظهر شاشة الإنشاء مطابقةً لتنفيذ التعديل أو الحذف بشكلٍ أصوليّ».
 * وسلاسةُ ذلك مستحيلةٌ ما دامت كلُّ شاشةٍ تخمّن بنفسها متى تُظهر زرّ «إلغاء» ومتى تُخفيه:
 * التخمينُ يُنتج عطبَين، كلاهما وقع في هذا المستودع فعلاً — زرٌّ ظاهرٌ يرفضه الخادم عند الضغط
 * (فيبدو النظام معطوباً)، وزرٌّ مخفيٌّ يقبله الخادم (فتُحجَب سلطةٌ مشروعة عن المدير).
 *
 * ## ⛔ القيد الحاكم على هذا الملف: **استخراجُ واقعٍ لا تصميمُ مثال**
 *
 * كلُّ قاعدةٍ هنا مقروءةٌ من حارسٍ قائمٍ في الخادم، وفوقها **مسارُ الملفّ ورقمُ السطر**.
 * ما لم يُوجَد له حارسٌ فليس هنا. وحيث لا مخرجَ فالمكتوب «لا مخرجَ اليوم» صراحةً — لأنّ
 * مخرجاً كاذباً أسوأ من الاعتراف بالانسداد: الموظّف يجرّبه فيفشل، ثمّ لا يصدّق الرسالة التالية.
 *
 * ⚠️ **رقمُ السطر لقطةٌ، ونصُّ الحارس هو المرساة.** أرقامُ الأسطر هنا صحيحةٌ لحظةَ كتابتها
 * وتنجرف مع أوّل تحريرٍ لتلك الملفّات (بعضُها تحرّك عشرات الأسطر أثناء كتابة هذا الملفّ نفسه).
 * فحين تتحقّق من قاعدةٍ هنا، ابحث عن **نصّ الحارس** المذكور بجانبها لا عن رقمِه — والنصّ
 * مستقرٌّ لأنّه رسالةٌ يقرؤها موظّف.
 *
 * **ما ليس في هذا الملف عمداً:**
 *  · **الصلاحيات والأدوار وفصلُ المهام** (`server/trpc.ts` و`shared/permissions.ts`): مَن يملك
 *    الفعل سؤالٌ مستقلٌّ عن هل يقبله المستند. خلطُهما يجعل زرّاً مخفيّاً لسببٍ ويُقرأ بسببٍ آخر.
 *  · **عزلُ الفرع** (`server/lib/branchAuthority.ts`): يعتمد على `Actor` لا على المستند.
 *  · **الأقفال والتزامن** (`expectedVersion`، `FOR UPDATE`): لا تُقرأ من حقائقَ ثابتة.
 *  ⇒ ولذلك: `allowed: true` هنا تعني **المستند يقبل الفعل**، لا «هذا المستخدم يملكه».
 *    الإنفاذ النهائيّ خادميٌّ دائماً (§٢ من CLAUDE.md).
 *
 * **ترتيبُ الفحوص** داخل كل فعلٍ يتبع ترتيبَ الخادم حيث عرفتُه (فتُطابق الرسالةُ ما سيقوله
 * الخادم فعلاً)، وحيث اختلف الترتيبُ بين بوّابة الطلب وبوّابة التنفيذ قدّمتُ **بوّابة الطلب**
 * لأنّها أوّلُ ما يصطدم به المستخدم.
 *
 * **بلا تشكيل في النصّ المعروض** (`why`/`doThis`/التسميات): الخطّ العربيّ يشوّه التشكيل في
 * الأحجام الصغيرة فيُقرأ «سُلِّم» شلَم — علّةٌ موثَّقة في `scripts/check-tashkeel-in-small-text.mjs`.
 * والأرقام لاتينية دائماً (قرار المالك).
 */

import type { InvoiceStatus } from "./invoiceStatus";
import type { WorkOrderStatus } from "./workOrderStatus";

// ═════════════════════════════ ١) المفردات ═════════════════════════════

/**
 * أنواعُ المستندات التي وجدتُ لها **مستنداً قائماً في القاعدة وحارساً في الخدمة**.
 *
 * ⛔ `SALES_RETURN` مدرَجٌ رغم أنّه **بلا جدولٍ خاصّ به** — وهذا بالضبط سببُ إدراجه: غيابُ
 * المستند هو الحقيقةُ التي يجب أن تعرفها الشاشة (لا شيءَ لتضع عليه شريط أفعال). مرتجعُ البيع
 * يعيش قيوداً في `accountingEntries` (entryType=RETURN) وإيصالاتٍ وتعديلاً على الفاتورة
 * — انظر `listSalesReturns` في [`server/services/returnService.ts`] («قيود RETURN ذات
 * invoiceId بلا supplierId»)، ولا يوجد `salesReturns` في `drizzle/schema.ts`.
 */
export const DOCUMENT_KINDS = [
  "SALE_INVOICE",
  "WORK_ORDER",
  "PURCHASE_ORDER",
  "GOODS_RECEIPT",
  "SALES_RETURN",
  "PURCHASE_RETURN",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_ACTIONS = ["EDIT", "CANCEL", "REVERSE", "CORRECT"] as const;

export type DocumentAction = (typeof DOCUMENT_ACTIONS)[number];

export const DOCUMENT_KIND_AR: Record<DocumentKind, string> = {
  SALE_INVOICE: "فاتورة بيع",
  WORK_ORDER: "أمر شغل",
  PURCHASE_ORDER: "أمر شراء",
  GOODS_RECEIPT: "إذن استلام",
  SALES_RETURN: "مرتجع بيع",
  PURCHASE_RETURN: "مرتجع شراء",
};

export const DOCUMENT_ACTION_AR: Record<DocumentAction, string> = {
  EDIT: "تعديل",
  CANCEL: "إلغاء",
  REVERSE: "عكس",
  CORRECT: "تصحيح",
};

/**
 * حكمُ الفعل: مسموح، أو ممنوعٌ **بسببٍ ومخرج**.
 *
 * لا بوليان عارٍ — البوليان يجعل الشاشة تُخفي الزرّ بلا كلمة، فيقف المستخدم أمام مستندٍ
 * صامتٍ لا يعرف لِمَ لا يفعل شيئاً. نفس عقد [`shared/errors.ts`] (`what`/`why`/`doThis`)،
 * بلا `what` لأنّ الشاشة تعرفه (اسمُ المستند أمامها).
 */
/**
 * المستنداتُ/الشاشاتُ التي قد يحيل إليها مخرجُ حكمٍ ممنوع — قاموسٌ مغلق كي لا يُخترَع مخرجٌ نصّيّ
 * لشاشةٍ لا وجود لها.
 */
export const EXIT_DOCUMENTS = [
  "SALE_INVOICE",
  "WORK_ORDER",
  "PURCHASE_ORDER",
  "GOODS_RECEIPT",
  "PURCHASE_RETURN",
  "DELIVERY_CONSIGNMENT",
  "INSTALLMENT_PLAN",
  "DIGITAL_CARDS",
  "EXCHANGE_VOUCHER",
  "STOCKTAKE",
  "SUPPLIER_LEDGER",
  "APPROVAL_REQUEST",
] as const;

export type ExitDocument = (typeof EXIT_DOCUMENTS)[number];

/**
 * **مخرجُ الحكم مُهيكَلاً** (LC01 — م٢ ذيل): إلى أين يحيل «ماذا تفعل الآن» بالضبط.
 *
 * النصُّ وحده كان يكذب بصمت: فاتورةٌ بلا بنود كان إلغاؤها يحيل إلى المرتجع، ومرتجعُها يحيل إلى
 * الإلغاء، وتصحيحُها يحيل إلى الإلغاء — **ثلاثتُها ممنوعة**، فيدور الموظّف بين ثلاثة أزرار معطَّلة
 * كلٌّ يشير إلى الآخر. المخرجُ المُهيكَل يُثبته الاختبار: إحالةٌ إلى فعلٍ على المستند نفسه يجب أن
 * تكون إلى فعلٍ **مسموحٍ فعلاً** على هذا المستند بعينه — وإلّا أُعلن المخرجُ على مستندٍ آخر، أو
 * تدخّلاً إدارياً، أو انسداداً صريحاً. لا إحالةَ دائرية.
 *
 *  · `ACTION`         — فعلٌ آخر على **المستند نفسه**؛ الاختبار يُثبت أنّه مسموح.
 *  · `OTHER_DOCUMENT` — المخرج على مستندٍ/شاشةٍ أخرى مسمّاة من `EXIT_DOCUMENTS`.
 *  · `NONE`           — لا إجراء يبقى (نهايةٌ مقصودة).
 *  · `ADMIN`          — يلزم تدخّلٌ إداريّ خارج شريط الأفعال (فتحُ فترة، سجلٌّ بلا بنود…).
 *  · `BLOCKED`        — لا مخرج اليوم: انسدادٌ معلَنٌ (دينٌ على النظام، لا وعدٌ بحلٍّ قائم).
 */
export type ActionExit =
  | { kind: "ACTION"; action: DocumentAction }
  | { kind: "OTHER_DOCUMENT"; document: ExitDocument }
  | { kind: "NONE" }
  | { kind: "ADMIN" }
  | { kind: "BLOCKED" };

export type ActionVerdict =
  | { allowed: true }
  | { allowed: false; why: string; doThis: string; exit: ActionExit };

const ALLOWED: ActionVerdict = { allowed: true };

const NONE_EXIT: ActionExit = { kind: "NONE" };
const ADMIN_EXIT: ActionExit = { kind: "ADMIN" };
const BLOCKED_EXIT: ActionExit = { kind: "BLOCKED" };
const toAction = (action: DocumentAction): ActionExit => ({ kind: "ACTION", action });
const onDocument = (document: ExitDocument): ActionExit => ({ kind: "OTHER_DOCUMENT", document });

/**
 * مخرجٌ **يرث** حكمَ الفعل المُحال إليه: إن كان مسموحاً فالإحالةُ إليه، وإلّا فمخرجُه هو المخرج.
 * (أمرٌ مسلَّم لا يُعدَّل: المخرجُ «اطلب عكس التسليم» — لكن إن كان العكسُ نفسُه ممنوعاً لإرساليةٍ
 * حيّة فالمخرجُ الصادق هو إرساليتُه، لا زرٌّ معطَّلٌ آخر.)
 */
function inherit(target: ActionVerdict, action: DocumentAction): ActionExit {
  return target.allowed ? toAction(action) : target.exit;
}

/**
 * منعٌ **يحيل إلى فعلٍ آخر على المستند نفسه**: إن كان مسموحاً فالإحالةُ إليه بنصّها؛ وإن كان
 * ممنوعاً بدوره فالمخرجُ **نصّاً ومخرجاً** هو مخرجُ ذلك الفعل — فلا يقرأ الموظّف «اطلب العكس»
 * والعكسُ نفسه معطَّل (LC01: النصُّ والمخرجُ المُهيكَل لا يفترقان).
 */
function denyVia(why: string, doThisIfAllowed: string, target: ActionVerdict, action: DocumentAction): ActionVerdict {
  return target.allowed
    ? deny(why, doThisIfAllowed, toAction(action))
    : deny(why, target.doThis, target.exit);
}

/**
 * يبني حكمَ منعٍ ويرفض — بلا تسامح — ما أنتج رسائلَ ميتةً في المستودع فعلاً: جزءاً فارغاً،
 * أو `doThis` يكرّر `why`. نفس فحص `appError` في [`shared/errors.ts`]، ولنفس السبب:
 * الجزءُ المنسيُّ دائماً هو المخرج، وكاتبُ الحارس يظنّ أنّ السبب يكفي.
 * والمخرجُ المُهيكَل إلزاميّ: لا منعَ بلا إجابةٍ قابلةٍ للفحص عن «إلى أين».
 */
function deny(why: string, doThis: string, exit: ActionExit): ActionVerdict {
  const w = why.trim();
  const d = doThis.trim();
  if (!w || !d) throw new Error("documentActionVerdict: المنع يلزمه سببٌ ومخرجٌ غير فارغين");
  if (w === d) throw new Error("documentActionVerdict: المخرج يكرر السبب — الحكم بلا مخرج عملي");
  return { allowed: false, why: w, doThis: d, exit };
}

// ═════════════════════════ ٢) حقائق المستندات ═════════════════════════

/**
 * حقائقُ فاتورة البيع. كلُّ حقلٍ هنا **يقرؤه حارسٌ قائم** — لا حقلَ تخمينياً.
 */
export interface SaleInvoiceFacts {
  kind: "SALE_INVOICE";
  /** `invoices.status`. */
  status: InvoiceStatus;
  /** `invoices.sourceType === "WORKORDER"`. */
  fromWorkOrder: boolean;
  /** للفاتورة بندٌ واحدٌ على الأقل في `invoiceItems`. */
  hasItems: boolean;
  /** `invoices.returnedTotal > 0` — عليها مرتجعٌ سابق. */
  hasPriorReturn: boolean;
  /** خطة أقساط `ACTIVE` مربوطة بالفاتورة. */
  hasActiveInstallmentPlan: boolean;
  /** صفوفٌ في `digitalSaleDetails` — بطاقاتٌ رقمية صدرت من جهاز المزوّد. */
  hasDigitalCards: boolean;
  /** إرسالية توصيلٍ حيّة (حالتها ليست CANCELLED ولا RETURNED). */
  hasLiveConsignment: boolean;
  /** شهرُ `invoices.invoiceDate` مقفلٌ ماليّاً. */
  periodLocked: boolean;
}

export interface WorkOrderFacts {
  kind: "WORK_ORDER";
  /** `workOrders.status`. */
  status: WorkOrderStatus;
  /** `workOrders.invoiceId != null` — صدرت فاتورةٌ للأمر (بالتسليم أو بالإرسال للمندوب). */
  invoiceIssued: boolean;
  /** إرسالية توصيلٍ حيّة مرتبطة بالأمر. */
  hasLiveConsignment: boolean;
  /** المقبوضُ على الأمر يتضمّن سند صيرفة EXCHANGE بلا قناة ردٍّ موثّقة. */
  hasUnsupportedExchangeReceipt: boolean;
  /** شهرُ تاريخ الفاتورة أو التسليم مقفلٌ ماليّاً. */
  periodLocked: boolean;
}

export interface PurchaseOrderFacts {
  kind: "PURCHASE_ORDER";
  /** `purchaseOrders.status` (enum `poStatus`). */
  status: "DRAFT" | "SENT" | "CONFIRMED" | "RECEIVED" | "CANCELLED";
  /** أيُّ بندٍ فيه `receivedBaseQuantity > 0`. */
  hasReceivedQuantity: boolean;
  /** `paidAmount > 0` أو `paidUsd > 0`. */
  hasPayment: boolean;
}

export interface GoodsReceiptFacts {
  kind: "GOODS_RECEIPT";
  /** `goodsReceipts.status`. */
  status: "POSTED" | "PARTIALLY_REVERSED" | "REVERSED";
  /** `goodsReceipts.origin` — التاريخيُّ المجمَّع بلا مستندٍ أصليٍّ يُعكَس عليه. */
  origin: "NATIVE" | "LEGACY_AGGREGATE";
  /** بقي في بندٍ ما `accepted - reversed - returned > 0`. */
  hasReversibleQuantity: boolean;
  /** شهرُ `goodsReceipts.receivedAt` مقفلٌ ماليّاً. */
  periodLocked: boolean;
}

/**
 * مرتجعُ البيع **بلا حقائق** — وهذا هو الخبر. لا جدولَ له ولا `id` يُشار إليه ولا حالةَ
 * تتغيّر، فلا فعلَ يقع عليه أصلاً. انظر `DEAD_END_SALES_RETURN_HAS_NO_DOCUMENT`.
 */
export interface SalesReturnFacts {
  kind: "SALES_RETURN";
}

export interface PurchaseReturnFacts {
  kind: "PURCHASE_RETURN";
  /** `purchaseReturns.status`. */
  status: "POSTED" | "PARTIALLY_REVERSED" | "REVERSED";
  /** `purchaseReturns.origin` — الإرثيُّ لا يُعكَس. */
  origin: "NATIVE" | "LEGACY";
}

export type DocumentFacts =
  | SaleInvoiceFacts
  | WorkOrderFacts
  | PurchaseOrderFacts
  | GoodsReceiptFacts
  | SalesReturnFacts
  | PurchaseReturnFacts;

export interface DocumentActionInput {
  action: DocumentAction;
  document: DocumentFacts;
}

// ═══════════════════ ٣) ماذا يعني كل فعلٍ لكل نوع فعلاً ═══════════════════

/**
 * **المسارُ الخادميّ الحقيقيّ** لكل (نوع × فعل)، أو `null` حين **لا مسارَ له في النظام**.
 *
 * هذه الخريطة وحدها تُغني عن سؤالٍ يتكرّر: «أين زرّ تعديل إذن الاستلام؟» — لا يوجد، ولم
 * يُحذَف، ولم يُنسَ: إذن الاستلام لا يُعدَّل بحكم التصميم (يُعكَس ثمّ يُعاد إنشاؤه صحيحاً).
 */
export const DOCUMENT_ACTION_PATH: Record<
  DocumentKind,
  Record<DocumentAction, string | null>
> = {
  SALE_INVOICE: {
    // server/routers/saleRouter.ts:733 (ملاحظات) + shared/salesControl.ts SALES_DUE_DATE_CHANGE
    EDIT: "sales.correct (ملاحظات) و salesControl:SALES_DUE_DATE_CHANGE",
    // server/routers/saleRouter.ts:1404 => requestSalesControl => sale/cancel.ts
    CANCEL: "sales.cancel => salesControl:SALES_CANCEL => cancelSaleInTx",
    // server/routers/returnRouter.ts:48 => salesControl:SALES_RETURN او تنفيذ المالك
    REVERSE: "returns.create => salesControl:SALES_RETURN => returnSaleInTx",
    // server/routers/saleRouter.ts:821 => server/services/sale/correct.ts
    CORRECT: "sales.reissue => correctSale (الاصل SUPERSEDED وفاتورة بديلة)",
  },
  WORK_ORDER: {
    // server/routers/workOrderRouter.ts:1603 => server/services/workOrder/update.ts
    EDIT: "workOrders.update او workOrders:COMMERCIAL_EDIT",
    // server/routers/workOrderRouter.ts:1741 => server/services/workOrder/cancel.ts
    CANCEL: "workOrders.cancel او workOrders:CANCEL",
    // server/services/workOrder/controlRequests.ts:197 => reverseDelivery.ts
    REVERSE: "workOrders:REVERSE_DELIVERY",
    // server/services/workOrder/controlRequests.ts (MATERIAL_ADJUST)
    CORRECT: "workOrders:MATERIAL_ADJUST",
  },
  PURCHASE_ORDER: {
    // server/services/purchase/order.ts:541 (مسودة فقط، يكتب مراجعة جديدة)
    EDIT: "purchases.updateOrder",
    // server/services/purchase/controls.ts (CANCEL_ORDER) — الالغاء المباشر متوقف
    CANCEL: "purchases:CANCEL_ORDER",
    // لا عكس على امر الشراء نفسه: العكس يقع على اذن الاستلام
    REVERSE: null,
    // مراجعة جديدة تُكتب من updatePurchaseOrder وحده (order.ts:642) => مسودة فقط
    CORRECT: "purchases.updateOrder (مراجعة جديدة) بعد اعادة الامر مسودة",
  },
  GOODS_RECEIPT: {
    EDIT: null,
    CANCEL: null,
    // server/services/purchase/goodsReceipts.ts:870 و :988
    REVERSE: "goodsReceipts.requestReversal ثم decideGoodsReceiptReversal",
    CORRECT: null,
  },
  SALES_RETURN: {
    EDIT: null,
    CANCEL: null,
    REVERSE: null,
    CORRECT: null,
  },
  PURCHASE_RETURN: {
    EDIT: null,
    CANCEL: null,
    // server/services/purchase/returnGovernance.ts:667 و :709
    REVERSE: "purchaseReturnGovernance.requestReversal ثم decideReversal",
    CORRECT: null,
  },
};

/**
 * **نطاقُ «التعديل» الحقيقيّ** — تحذيرٌ لازمٌ لأيّ شاشةٍ تقرأ `allowed: true` على `EDIT`.
 *
 * `EDIT` على فاتورة بيعٍ مُثبَّتة **لا يمسّ بنداً ولا سعراً ولا عميلاً ولا طريقةَ قبض**:
 * [`saleRouter.ts:786`] يقرأ حقلَ الملاحظات وحده ويرمي «لم تتغير ملاحظات الفاتورة» إن لم
 * يتغيّر، وتعليقُه يقول صراحةً إنّ إعادة تصنيف طريقة القبض «مسارها مستندٌ مستقلٌّ يُبنى بقرار
 * مالك، لا أثرٌ جانبيٌّ هنا». فشاشةُ تعديلٍ تُظهر محرّرَ بنودٍ كاملاً هنا تَعِد بما لا يقع.
 * تعديلُ البنود مسارُه `CORRECT` (عكسٌ كاملٌ واعادةُ إصدار).
 */
export const DOCUMENT_EDIT_SCOPE: Record<DocumentKind, string> = {
  SALE_INVOICE: "الملاحظات وتاريخ الاستحقاق فقط — لا بنود ولا اسعار ولا عميل ولا طريقة قبض",
  WORK_ORDER: "العنوان والتخصيص والسعر والاستحقاق والاولوية وبيانات التواصل، وتغيير العميل ممنوع بعد العربون او بدء التنفيذ",
  PURCHASE_ORDER: "الامر كله ما دام مسودة — وكل حفظ يكتب مراجعة جديدة موثقة",
  GOODS_RECEIPT: "لا تعديل — الاذن يعكس ثم يعاد انشاؤه صحيحا",
  SALES_RETURN: "لا تعديل — لا مستند اصلا",
  PURCHASE_RETURN: "لا تعديل — المرتجع يعكس لا يعدل",
};

// ═══════════════════════ ٤) نصوصٌ متكرّرة (مصدرٌ واحد) ═══════════════════════

/**
 * مخرجُ فاتورة أمر الشغل — يتكرّر في أربعة أحكام، فمصدرُه واحد. صياغتُه مأخوذةٌ من
 * [`returnRouter.ts:109`] و[`sale/controlRequests.ts:182`] معاً.
 */
const WORK_ORDER_INVOICE_EXIT =
  "افتح امر الشغل نفسه واطلب عكس التسليم — وهو المسار الوحيد الذي يعكس البيع والذمة والعربون وقيمة العمل الجاري معا";

/** مخرجُ الفترة المقفلة — الرسالةُ الخادمية تسمّي فاعلَه: `assertPeriodOpen`. */
const PERIOD_EXIT =
  "اطلب من الادمن فتح الفترة المالية (unlockLatestPeriod) ثم اعد المحاولة، او سجل المعالجة في فترة مفتوحة";

/** مخرجُ الإرسالية الحيّة — منقولٌ عن [`workOrder/helpers.ts:108`]. */
const CONSIGNMENT_EXIT =
  "استرجع الارسالية اولا من ادارة التوصيل — وهي تعكس البيع والمخزون والعربون معا";

/**
 * مخرجُ الفاتورة بلا بنود — **اداريٌّ صريح** (LC01): الالغاء والمرتجع والتصحيح ثلاثتها ترفضها
 * (`sale/cancel.ts:268` · `returnService.ts:575` · `correct.ts:383`)، وكان كل حكم يحيل الى الاخر
 * فيدور الموظف بين ثلاثة ازرار معطلة. لا زر على الشاشة يعالج مستندا بلا بنود.
 */
const NO_ITEMS_EXIT =
  "ابلغ الادمن ليعالج الفاتورة بلا بنود (يستعيد بنودها الضائعة او يقفلها بقيد يدوي موثق) — لا يلغى ولا يرجع ولا يصحح مستند بلا بنود من الشاشة";

// ═════════════════════════ ٥) أحكامُ فاتورة البيع ═════════════════════════

const DEAD_SALE_STATUSES: readonly InvoiceStatus[] = ["CANCELLED", "RETURNED", "SUPERSEDED"];

function isDeadSale(status: InvoiceStatus): boolean {
  return DEAD_SALE_STATUSES.includes(status);
}

/**
 * سببُ الموت ومخرجُه لكل حالةٍ ميتة. الثلاثةُ **ليست واحدة**: المستبدَلة لها خلَفٌ حيٌّ
 * يُعمَل عليه، والملغاة والمرتجَعة أُغلقتا بعكسٍ تامٍّ فلا شيءَ يُعمَل.
 * الدليل: [`shared/invoiceStatus.ts:39`] و[`returnService.ts:395-412`].
 */
function deadSaleVerdict(status: InvoiceStatus, actionAr: string): ActionVerdict {
  if (status === "SUPERSEDED") {
    return deny(
      "الفاتورة استبدلت بفاتورة مصححة، والالتزام كله انتقل الى البديلة",
      `افتح الفاتورة المصححة البديلة ونفذ ${actionAr} عليها — الاصل مغلق بحكم الاستبدال`,
      onDocument("SALE_INVOICE"),
    );
  }
  if (status === "CANCELLED") {
    return deny(
      "الفاتورة ملغاة بعكس كامل: الايراد والمخزون والذمة صفرت والمبلغ رد بسند",
      "لا اجراء يبقى على هذا المستند — اصدر فاتورة بيع جديدة ان عاد الزبون يشتري",
      NONE_EXIT,
    );
  }
  return deny(
    "الفاتورة مرتجعة بالكامل: البضاعة عادت والمبلغ سوي، فلا يبقى فيها شيء يعالج",
    "لا اجراء يبقى على هذا المستند — اصدر فاتورة بيع جديدة ان عاد الزبون يشتري",
    NONE_EXIT,
  );
}

function saleInvoiceVerdict(action: DocumentAction, d: SaleInvoiceFacts): ActionVerdict {
  const actionAr = DOCUMENT_ACTION_AR[action];

  if (action === "EDIT") {
    // saleRouter.ts:764 — الحارس الوحيد على تعديل الملاحظات: المستند الميت لا تعدل بياناته.
    if (isDeadSale(d.status)) return deadSaleVerdict(d.status, actionAr);
    // ملاحظة صدق: تاريخ الاستحقاق (SALES_DUE_DATE_CHANGE) محجوب لفاتورة امر الشغل
    // (sale/controlRequests.ts:182)، لكن الملاحظات تبقى قابلة للتعديل — فالحكم «مسموح»
    // بنطاقه المعلن في DOCUMENT_EDIT_SCOPE.
    return ALLOWED;
  }

  if (action === "CANCEL") {
    // sale/controlRequests.ts:182 — بوابة الطلب تسبق كل شيء، وتسبق فحص الحالة الميتة.
    if (d.fromWorkOrder) {
      return deny(
        "هذه فاتورة امر شغل، والغاؤها من هنا يعيد مواد استهلكت عند بدء التنفيذ فيخلق مخزونا وهميا لمنتج مخصص",
        WORK_ORDER_INVOICE_EXIT,
        onDocument("WORK_ORDER"),
      );
    }
    // sale/controlRequests.ts:186 — «الفاتورة نهائية ولا تقبل طلب تحكم جديدا».
    if (isDeadSale(d.status)) return deadSaleVerdict(d.status, actionAr);
    // sale/cancel.ts:186 — assertInvoiceCancellationDeliverySafeTx: الوسم وحده لا يكفي،
    // تثبت الحيازة وCOD والتسوية المفتوحة تحت الاقفال نفسها.
    if (d.hasLiveConsignment) {
      return deny(
        "للفاتورة ارسالية حية عند المندوب: الطرد بيده وعهدة التحصيل قائمة، فالغاؤها الان يترك نقدا بلا مالك",
        CONSIGNMENT_EXIT,
        onDocument("DELIVERY_CONSIGNMENT"),
      );
    }
    // sale/cancel.ts:212 — حارس الفترة على تاريخ الفاتورة الاصلي لا على اليوم.
    if (d.periodLocked) {
      return deny(
        "شهر الفاتورة مقفل ماليا، والالغاء يحذفها رجعيا من تقارير شهر اصدارها فتتغير ارقام شهر اغلق",
        PERIOD_EXIT,
        ADMIN_EXIT,
      );
    }
    // sale/cancel.ts:239 — الخطة النشطة تبقى قابلة للتحصيل بعد الالغاء (payLine يكتب
    // invoiceId=null بقصد) فيستمر التحصيل على التزام سبق الغاؤه.
    if (d.hasActiveInstallmentPlan) {
      return deny(
        "الفاتورة مرتبطة بخطة اقساط نشطة، وخطة كهذه تبقى قابلة للتحصيل بعد الالغاء فيطالب الزبون بالتزام سبق الغاؤه",
        "الغ خطة الاقساط اولا من شاشة الاقساط ثم اعد طلب الالغاء",
        onDocument("INSTALLMENT_PLAN"),
      );
    }
    // sale/cancel.ts:261 — الكرت صدر من جهاز المزود وقد يكون استهلك.
    if (d.hasDigitalCards) {
      return deny(
        "الفاتورة تحوي بطاقات رقمية صدرت من جهاز المزود وقد تكون استهلكت، فالغاء الفاتورة لا يستعيدها",
        "استعمل «عكس بيع الكروت» في شاشة البطاقات الرقمية — وهو المسار الوحيد الذي يخاطب المزود",
        onDocument("DIGITAL_CARDS"),
      );
    }
    // sale/cancel.ts:268 — «الفاتورة بلا بنود — تعذر الالغاء».
    if (!d.hasItems) {
      // ⚠️ كان المخرج هنا يحيل الى المرتجع والتصحيح — وكلاهما ممنوع على فاتورة بلا بنود (احالة دائرية
      // امسكها LC01). المخرج الصادق اداري: لا زر على الشاشة يعالج مستندا بلا بنود.
      return deny(
        "الفاتورة بلا بنود، والالغاء يعمل باعادة كل بند متبق الى المخزون فلا يجد ما يعكسه",
        NO_ITEMS_EXIT,
        ADMIN_EXIT,
      );
    }
    return ALLOWED;
  }

  if (action === "REVERSE") {
    // returnRouter.ts:110 (مسار المالك) و sale/controlRequests.ts:182 (مسار الطلب) — كلاهما.
    if (d.fromWorkOrder) {
      return deny(
        "مرتجع فاتورة امر الشغل يسم الفاتورة مرتجعة بينما حالة الامر تبقى مسلمة وقيمة العمل الجاري والتكلفة بلا عكس والعربون مقفل",
        WORK_ORDER_INVOICE_EXIT,
        onDocument("WORK_ORDER"),
      );
    }
    // returnService.ts:395 — رسالة المستبدلة هنا صريحة: «ارجع من الفاتورة المصححة».
    if (isDeadSale(d.status)) return deadSaleVerdict(d.status, actionAr);
    // returnService.ts:391 — الفترة قبل فحص الحالة في هذا المسار.
    if (d.periodLocked) {
      return deny(
        "شهر الفاتورة مقفل ماليا، والمرتجع يغير الفاتورة وبنودها والمخزون والذمم تاريخيا",
        PERIOD_EXIT,
        ADMIN_EXIT,
      );
    }
    // returnService.ts:575 — assertNoActiveInstallmentPlanAfterInvoiceLockTx.
    if (d.hasActiveInstallmentPlan) {
      return deny(
        "الفاتورة مرتبطة بخطة اقساط نشطة، والمرتجع يغير اساس الخطة تحتها",
        "الغ خطة الاقساط اولا من شاشة الاقساط ثم اعد تسجيل المرتجع",
        onDocument("INSTALLMENT_PLAN"),
      );
    }
    // returnService.ts:1325 — «اعد الارسالية اولا او ورد تحصيلها».
    if (d.hasLiveConsignment) {
      return deny(
        "للفاتورة ارسالية مفتوحة عند المندوب، فالبضاعة لم تعد الى المحل بعد ليسجل عليها مرتجع",
        "اعد الارسالية اولا او ورد تحصيلها من ادارة التوصيل ثم سجل المرتجع",
        onDocument("DELIVERY_CONSIGNMENT"),
      );
    }
    // returnService.ts:575 — «لا اصناف للارجاع»: المرتجع يلزمه بند.
    if (!d.hasItems) {
      // ⚠️ كان يحيل الى الالغاء — والالغاء ممنوع على فاتورة بلا بنود (LC01). فاتورة امر الشغل عولجت اعلاه.
      return deny(
        "المرتجع يلزمه بند واحد على الاقل، وهذه الفاتورة بلا بنود",
        NO_ITEMS_EXIT,
        ADMIN_EXIT,
      );
    }
    return ALLOWED;
  }

  // CORRECT — عكس كامل واعادة اصدار (correctSale)، والاصل يصير SUPERSEDED.
  // sale/controlRequests.ts:182 يسبق (طلب التحكم)، ثم correct.ts بحراسه.
  if (d.fromWorkOrder) {
    return deny(
      "فاتورة امر الشغل تبيع متغيرا اساس لم يدخل المخزون فعلا، فاعادة اصدارها تعيد ترحيل مخزون لا وجود له",
      WORK_ORDER_INVOICE_EXIT,
      onDocument("WORK_ORDER"),
    );
  }
  // correct.ts:304 — «لا تصحح فاتورة ملغاة او مرتجعة او مستبدلة سلفا».
  if (isDeadSale(d.status)) return deadSaleVerdict(d.status, actionAr);
  // correct.ts:297 — assertPeriodOpen على تاريخ الفاتورة الاصلي.
  if (d.periodLocked) {
    return deny(
      "شهر الفاتورة مقفل ماليا، والتصحيح يعكس قيود الشهر المقفل ثم يعيد اصدارها",
      PERIOD_EXIT,
      ADMIN_EXIT,
    );
  }
  // correct.ts:298 — assertNoActiveInstallmentPlanAfterInvoiceLockTx.
  if (d.hasActiveInstallmentPlan) {
    return deny(
      "الفاتورة مرتبطة بخطة اقساط نشطة، والتصحيح يقتل الفاتورة الاصل التي بنيت عليها الخطة",
      "الغ خطة الاقساط اولا من شاشة الاقساط ثم اعد التصحيح",
      onDocument("INSTALLMENT_PLAN"),
    );
  }
  // correct.ts:317 — «لا تصحح فاتورة عليها مرتجع سابق — عالجها عبر المرتجعات».
  if (d.hasPriorReturn) {
    // المخرج «المرتجع» يرث حكمه: ان كان المرتجع نفسه ممنوعا (ارسالية حية مثلا) فمخرجه هو المخرج.
    return denyVia(
      "على الفاتورة مرتجع سابق، والتصحيح يعكسها كلها فيعكس المرتجع مرة ثانية",
      "اكمل المعالجة من شاشة المرتجعات: ارجع ما تبقى من البنود بدل اعادة اصدار الفاتورة",
      saleInvoiceVerdict("REVERSE", d),
      "REVERSE",
    );
  }
  // correct.ts:323 — البطاقات الرقمية.
  if (d.hasDigitalCards) {
    return deny(
      "الفاتورة فيها بطاقات رقمية صدرت من جهاز المزود، ولا تستعاد باعادة اصدار الفاتورة",
      "استعمل «عكس بيع الكروت» في شاشة البطاقات الرقمية اولا",
      onDocument("DIGITAL_CARDS"),
    );
  }
  // correct.ts:383 — «الفاتورة بلا بنود لتصحيحها».
  if (!d.hasItems) {
    // ⚠️ كان يحيل الى الالغاء — والالغاء ممنوع على فاتورة بلا بنود (LC01).
    return deny(
      "الفاتورة بلا بنود، والتصحيح يعيد اصدار البنود مصححة فلا يجد ما يصححه",
      NO_ITEMS_EXIT,
      ADMIN_EXIT,
    );
  }
  // correct.ts (assertInvoiceReversalDeliverySafeTx) — نفس حارس الالغاء على العكس.
  if (d.hasLiveConsignment) {
    return deny(
      "للفاتورة ارسالية حية عند المندوب، والتصحيح يعكس البيع بينما الطرد وعهدة التحصيل قائمان",
      CONSIGNMENT_EXIT,
      onDocument("DELIVERY_CONSIGNMENT"),
    );
  }
  return ALLOWED;
}

// ═════════════════════════ ٦) أحكامُ أمر الشغل ═════════════════════════

function workOrderVerdict(action: DocumentAction, d: WorkOrderFacts): ActionVerdict {
  const closed = d.status === "DELIVERED" || d.status === "CANCELLED";

  /** نصُّ الامر المنتهي — يتكرر في ثلاثة افعال. */
  const closedDeny = (): ActionVerdict => {
    if (d.status === "CANCELLED") {
      return deny(
        "الامر ملغى: خرج من دورة العمل ولا يحمل التزاما ولا حملا على منفذ",
        "لا اجراء يبقى على هذا الامر — انشئ امر شغل جديدا ان عاد الزبون يطلب",
        NONE_EXIT,
      );
    }
    // المخرج «عكس التسليم» يرث حكمه (ارسالية حية · سند صيرفة · فترة مقفلة ⇒ مخرجه هو المخرج)؛
    // ومسلم بلا فاتورة شذوذ بيانات لا زر له — تدخل اداري.
    if (!d.invoiceIssued) {
      return deny(
        "الامر سلم للزبون بلا فاتورة مسجلة، فلا مستند بيع يعكس ولا زر على الشاشة يعالجه",
        "ابلغ الادمن: امر مسلم بلا فاتورة شذوذ بيانات يعالج من قاعدة البيانات لا من شريط الافعال",
        ADMIN_EXIT,
      );
    }
    return denyVia(
      "الامر سلم للزبون وصدرت فاتورته، فلم يعد مستندا قيد التنفيذ",
      "المسار الوحيد لامر مسلم هو طلب عكس التسليم — وهو يعكس البيع والذمة والعربون وقيمة العمل الجاري معا",
      workOrderVerdict("REVERSE", d),
      "REVERSE",
    );
  };

  if (action === "EDIT") {
    // workOrder/update.ts:58 — «الامر مسلم بالفعل» او «لا يمكن تعديل امر ملغى».
    if (closed) return closedDeny();
    // workOrder/update.ts:62 — «صدرت فاتورة لهذا الامر — عالج التغيير بتصحيح/مرتجع الفاتورة».
    if (d.invoiceIssued) {
      return deny(
        "صدرت فاتورة لهذا الامر (ارسل مع مندوب)، وتعديل الامر تحت فاتورة قائمة يجعل المستندين متناقضين",
        "اكمل مسار التوصيل اولا: اثبت التسليم فيصير الامر مسلما وتفتح له معالجة كاملة، او استرجع الارسالية فيلغى الامر ويعكس بيعه",
        onDocument("DELIVERY_CONSIGNMENT"),
      );
    }
    return ALLOWED;
  }

  if (action === "CANCEL") {
    // workOrder/cancel.ts:222 — «لا يمكن الغاء امر مسلم او ملغى».
    if (closed) return closedDeny();
    // workOrder/cancel.ts:237 — assertNoLiveConsignment، ورسالته «لا يلغى امر خرج مع مندوب».
    if (d.hasLiveConsignment) {
      return deny(
        "الامر خرج مع مندوب والارسالية ما زالت حية، فالالغاء يعيد المواد ويرد العربون بينما البيع والعهدة قائمان",
        CONSIGNMENT_EXIT,
        onDocument("DELIVERY_CONSIGNMENT"),
      );
    }
    // workOrder/cancel.ts:242 — الحارس الذي اضيف بعد اكتشاف ان invoiceId يكتب ولا يقرا.
    if (d.invoiceIssued) {
      return deny(
        "صدرت فاتورة لهذا الطلب، والالغاء يعيد المواد ويرد العربون وفاتورته وقيد بيعها قائمان: ايراد بلا بضاعة وذمة على زبون لطلب ملغى",
        "اكمل التسليم ثم اطلب عكس التسليم، او استرجع الارسالية من ادارة التوصيل فيلغى الامر ويعكس بيعه معها",
        onDocument("DELIVERY_CONSIGNMENT"),
      );
    }
    return ALLOWED;
  }

  if (action === "REVERSE") {
    // workOrder/controlRequests.ts:199 و reverseDelivery.ts:359 — الشرطان معا.
    if (d.status !== "DELIVERED" || !d.invoiceIssued) {
      if (d.status === "CANCELLED") {
        return deny(
          "الامر ملغى، ولا يعكس تسليم لم يقع",
          "لا اجراء يبقى على هذا الامر — انشئ امر شغل جديدا ان عاد الزبون يطلب",
          NONE_EXIT,
        );
      }
      // المخرج «الالغاء» يرث حكمه (فوتر مع مندوب ⇒ مخرجه الارسالية)؛ ومسلم بلا فاتورة شذوذ اداري.
      if (d.status === "DELIVERED") {
        return deny(
          "الامر مسلم بلا فاتورة مسجلة، وعكس التسليم يعكس فاتورة لا وجود لها",
          "ابلغ الادمن: امر مسلم بلا فاتورة شذوذ بيانات يعالج من قاعدة البيانات لا من شريط الافعال",
          ADMIN_EXIT,
        );
      }
      return denyVia(
        "عكس التسليم لا يفتح الا لامر مسلم صدرت له فاتورة، وهذا الامر لم يبلغ التسليم بعد",
        "اكمل مسار الامر حتى التسليم، وان اردت ايقافه قبل ذلك فاستعمل الالغاء لا العكس",
        workOrderVerdict("CANCEL", d),
        "CANCEL",
      );
    }
    // workOrder/reverseDelivery.ts:501 — assertSettledConsignmentOrNone، و helpers.ts:104.
    if (d.hasLiveConsignment) {
      return deny(
        "الارسالية ما زالت حية عند المندوب، والعكس يسقط الذمة بينما عهدته وتحصيله قائمان فينشا نقد بلا مالك",
        CONSIGNMENT_EXIT,
        onDocument("DELIVERY_CONSIGNMENT"),
      );
    }
    // workOrder/reverseDelivery.ts:404 — preflight.unsupportedMethods.
    if (d.hasUnsupportedExchangeReceipt) {
      return deny(
        "المقبوض على هذا الامر يتضمن سند صيرفة لا يملك قناة رد موثقة الى الزبون، فلا يعرف النظام من اين يرد المال",
        "سو سند الصيرفة اولا من شاشة الصيرفة ثم اعد طلب عكس التسليم",
        onDocument("EXCHANGE_VOUCHER"),
      );
    }
    // workOrder/reverseDelivery.ts:570-571 — الفترة على تاريخ الفاتورة وتاريخ التسليم معا.
    if (d.periodLocked) {
      return deny(
        "شهر الفاتورة او التسليم مقفل ماليا، والعكس يكتب قيودا في شهر اغلق",
        PERIOD_EXIT,
        ADMIN_EXIT,
      );
    }
    return ALLOWED;
  }

  // CORRECT — تصحيح الخامة (MATERIAL_ADJUST): المسار الوحيد لتصحيح ما استهلك على الامر.
  // workOrder/controlRequests.ts:221 — «لا يفتح طلب تحكم لامر نهائي».
  if (closed) return closedDeny();
  // workOrder/controlRequests.ts:224 — «لا تعديل تجاري او مادي بعد الفوترة».
  if (d.invoiceIssued) {
    return deny(
      "صدرت فاتورة لهذا الامر، وتصحيح الخامة بعد الفوترة يغير التكلفة تحت قيد بيع مرحل",
      "اكمل التسليم ثم اطلب عكس التسليم لتعالج الامر كاملا، او استرجع الارسالية فيلغى الامر ويعكس بيعه",
      onDocument("DELIVERY_CONSIGNMENT"),
    );
  }
  return ALLOWED;
}

// ═════════════════════════ ٧) أحكامُ أمر الشراء ═════════════════════════

const PO_CANCELLABLE: readonly PurchaseOrderFacts["status"][] = ["DRAFT", "SENT", "CONFIRMED"];

function purchaseOrderVerdict(action: DocumentAction, d: PurchaseOrderFacts): ActionVerdict {
  /** مخرجُ الامر الذي استلمت منه بضاعة — منقولٌ عن [`purchase/order.ts:586`] و[`purchase/controls.ts:411`]. */
  const receivedExit =
    "عالج البضاعة على مستندها: اطلب عكس اذن الاستلام ان كان الاستلام خطا، او سجل مرتجع شراء على المورد ان عادت البضاعة اليه";

  if (action === "EDIT" || action === "CORRECT") {
    // purchase/order.ts:575 — «لا يعدل الا امر شراء مسودة».
    if (d.status === "CANCELLED") {
      return deny(
        "امر الشراء ملغى، ولا يعدل مستند اغلق",
        "انشئ امر شراء جديدا بالبيانات الصحيحة — الملغى يبقى للتدقيق",
        NONE_EXIT,
      );
    }
    if (d.status === "RECEIVED" || d.hasReceivedQuantity) {
      // purchase/order.ts:586 — الحارس يقرا receivedBaseQuantity لا الحالة وحدها (دفاع متعمق).
      return deny(
        "استلمت بضاعة من هذا الامر، وتعديل بنوده بعد الاستلام يغير اساس تكلفة مخزون دخل فعلا",
        receivedExit,
        onDocument("GOODS_RECEIPT"),
      );
    }
    if (d.status === "CONFIRMED") {
      // المخرج «الالغاء» يرث حكمه: ان منعته دفعة او استلام فمخرجهما هو المخرج.
      return denyVia(
        "الامر معتمد ومرسل للمورد، ولا يعاد الى منطقة التعديل بعد الاعتماد",
        "الغ الامر بطلب الغاء يعتمده مستخدم مستقل ثم انشئ امرا جديدا بالبيانات الصحيحة",
        purchaseOrderVerdict("CANCEL", d),
        "CANCEL",
      );
    }
    if (d.status === "SENT") {
      // controls.ts:584-589 — الرفض وحده يعيد الامر مسودة، وتعليقه يسمي الابقاء SENT
      // «طريقا مسدودا لا يمكن فيه تعديل المراجعة المرفوضة ولا اعادة ارسالها بصدق».
      return deny(
        "الامر مرسل بانتظار الاعتماد، ولا يعدل تحت مراجعة معتمد",
        "اطلب من المعتمد رفض طلب اعتماد المراجعة — الرفض يعيد الامر مسودة فيفتح للتعديل واعادة الارسال",
        onDocument("APPROVAL_REQUEST"),
      );
    }
    // order.ts:591 — دفاع متعمق: الدفع لا يقع الا مع الاستلام، فوجوده اثر مالي قائم.
    if (d.hasPayment) {
      return deny(
        "على امر الشراء دفعة مسجلة، وتعديل بنوده يغير الذمة التي سدد جزء منها",
        receivedExit,
        onDocument("GOODS_RECEIPT"),
      );
    }
    return ALLOWED;
  }

  if (action === "CANCEL") {
    if (d.status === "CANCELLED") {
      return deny(
        "امر الشراء ملغى سلفا ولا يحمل التزاما ولا كمية منتظرة من المورد",
        "لا اجراء يبقى على هذا المستند — انشئ امر شراء جديدا ان عادت الحاجة",
        NONE_EXIT,
      );
    }
    // purchase/controls.ts:221 و :679 — الحالات المقبولة هي المسودة والمرسل والمعتمد وحدها.
    if (!PO_CANCELLABLE.includes(d.status)) {
      return deny(
        "الامر في حالة استلام، والالغاء قلب حالة خالص لا يعكس مخزونا دخل ولا ذمة قامت",
        receivedExit,
        onDocument("GOODS_RECEIPT"),
      );
    }
    // purchase/controls.ts:411 — assertCancellationSafeTx يقرا الكمية المستلمة لا الحالة.
    if (d.hasReceivedQuantity) {
      return deny(
        "استلمت بضاعة من هذا الامر ولو لم تتغير حالته، فالالغاء يترك مخزونا داخلا بلا مستند",
        receivedExit,
        onDocument("GOODS_RECEIPT"),
      );
    }
    // purchase/controls.ts:685 — «امر الشراء عليه دفعة مسجلة؛ لا يمكن الغاؤه».
    if (d.hasPayment) {
      return deny(
        "على الامر دفعة مسجلة للمورد، والالغاء يمحو مستند دين سدد جزء منه",
        "سو الدفعة مع المورد اولا (مرتجع شراء او تسوية ذمة) ثم اعد طلب الالغاء",
        onDocument("SUPPLIER_LEDGER"),
      );
    }
    return ALLOWED;
  }

  // REVERSE — لا وجود له على امر الشراء نفسه: العكس يقع على اذن الاستلام.
  return deny(
    "لا عكس على امر الشراء نفسه: الامر لا يكتب قيدا ولا مخزونا، وكل الاثر المالي والمخزني يقع عند اذن الاستلام",
    "افتح اذن الاستلام المعني واطلب عكسه، او سجل مرتجع شراء على المورد ان عادت البضاعة اليه",
    onDocument("GOODS_RECEIPT"),
  );
}

// ═════════════════════════ ٨) أحكامُ إذن الاستلام ═════════════════════════

function goodsReceiptVerdict(action: DocumentAction, d: GoodsReceiptFacts): ActionVerdict {
  /**
   * مخرجُ الاذن الارثي — **منقولٌ حرفياً بالمعنى** عن `doThis` في [`goodsReceipts.ts:960`]،
   * وهو نموذجُ ما يجب ان يكون عليه كل مخرجٍ هنا.
   */
  const legacyExit =
    "صحح الفرق بتسوية مخزون معتمدة او بمرتجع شراء على المورد، ولا تنتظر عكسا لهذا الاذن";

  if (action !== "REVERSE") {
    // لا مسار في النظام (DOCUMENT_ACTION_PATH). الاذن يعكس ثم يعاد انشاؤه صحيحا:
    // goodsReceipts.ts:1393 يعيد receivedBaseQuantity الى امر الشراء عند اعتماد العكس،
    // فتتحرر الكمية ويقبل goodsReceipts.create اذنا جديدا صحيحا.
    if (d.origin === "LEGACY_AGGREGATE") {
      return deny(
        "اذن الاستلام لا يعدل ولا يلغى ولا يصحح في مكانه، وهذا الاذن تاريخي مجمع فلا يعكس ايضا",
        legacyExit,
        onDocument("STOCKTAKE"),
      );
    }
    // المخرج «العكس» يرث حكمه (معكوس بالكامل ⇒ امر الشراء؛ فترة مقفلة ⇒ اداري).
    return denyVia(
      "اذن الاستلام لا يعدل ولا يلغى ولا يصحح في مكانه: قيده وحركة مخزونه وقعا فعلا، وتغيير المستند تحتهما يفصل الرقم عن مستنده",
      "اطلب عكس الاذن على البنود الخاطئة، وحين يعتمد العكس تتحرر الكمية على امر الشراء فتنشئ اذن استلام جديدا بالبيانات الصحيحة",
      goodsReceiptVerdict("REVERSE", d),
      "REVERSE",
    );
  }

  // purchase/goodsReceipts.ts:959 — الاذن التاريخي المجمع بلا مستند اصلي واحد يعكس عليه.
  if (d.origin === "LEGACY_AGGREGATE") {
    return deny(
      "الاذن تاريخي مجمع (رحل من قبل النظام) ولا يحمل مستندا اصليا واحدا يعكس عليه",
      legacyExit,
      onDocument("STOCKTAKE"),
    );
  }
  // goodsReceipts.ts:977 — «الاذن معكوس بالكامل سلفا».
  if (d.status === "REVERSED" || !d.hasReversibleQuantity) {
    return deny(
      "لم يبق في الاذن كمية مقبولة تعكس: ما فيه اما عكس سلفا واما رد الى المورد",
      "افتح امر الشراء وراجع الكميات المتبقية عليه، ولاخراج بضاعة عادت للمورد بعد استلامها استعمل مرتجع الشراء",
      onDocument("PURCHASE_ORDER"),
    );
  }
  // goodsReceipts.ts:1217 — assertPeriodOpen على receivedAt عند اعتماد العكس.
  if (d.periodLocked) {
    return deny(
      "شهر الاستلام مقفل ماليا، وعكس الاذن يكتب قيدا وحركة مخزون في شهر اغلق",
      PERIOD_EXIT,
      ADMIN_EXIT,
    );
  }
  return ALLOWED;
}

// ══════════════════════ ٩) أحكامُ مرتجعَي البيع والشراء ══════════════════════

/**
 * مرتجعُ البيع — **الاربعة ممنوعة، ولا مخرج اليوم**. انظر
 * `DEAD_END_SALES_RETURN_HAS_NO_DOCUMENT` للدليل الكامل.
 */
function salesReturnVerdict(): ActionVerdict {
  return deny(
    "مرتجع البيع ليس مستندا في هذا النظام: لا جدول له ولا رقم يشار اليه، بل قيود وايصالات كتبت لحظة تسجيله",
    "لا مخرج اليوم على المرتجع نفسه — راجع الفاتورة الاصل لترى اثره، واي تصحيح لمرتجع خاطئ يحتاج قرار مالك ومسارا يبنى (لا تعد بحل قائم)",
    BLOCKED_EXIT,
  );
}

function purchaseReturnVerdict(action: DocumentAction, d: PurchaseReturnFacts): ActionVerdict {
  if (action !== "REVERSE") {
    // لا مسار في النظام: purchaseReturnGovernanceRouter لا يحمل تعديلا ولا الغاء ولا تصحيحا.
    return denyVia(
      "مرتجع الشراء لا يعدل ولا يلغى ولا يصحح: هو نفسه مستند تصحيح، وتصحيح المصحح يفقد اثر ما جرى",
      "اطلب عكس المرتجع على البنود الخاطئة ليعتمده مستخدم مستقل، ثم سجل مرتجعا جديدا بالكميات الصحيحة",
      purchaseReturnVerdict("REVERSE", d),
      "REVERSE",
    );
  }
  // purchase/returnGovernance.ts:685 — «المرتجع غير قابل للعكس» للارثي وللمعكوس معا.
  if (d.origin === "LEGACY") {
    return deny(
      "المرتجع ارثي (رحل من نظام سابق) ولا يحمل مستندا اصليا يعكس عليه",
      "لا مخرج اليوم على هذا المرتجع — عالج الفرق بتسوية مخزون معتمدة او بتسوية ذمة مع المورد",
      BLOCKED_EXIT,
    );
  }
  if (d.status === "REVERSED") {
    return deny(
      "المرتجع معكوس بالكامل سلفا، فلا تبقى فيه كمية تعكس",
      "راجع امر الشراء وفاتورة المورد لترى الوضع بعد العكس، وسجل مرتجعا جديدا ان عادت بضاعة الى المورد",
      onDocument("PURCHASE_ORDER"),
    );
  }
  return ALLOWED;
}

// ═════════════════════════ ١٠) نقطةُ الدخول ═════════════════════════

/**
 * **الحكم**: هل يقبل هذا المستند هذا الفعل الان؟ دالة نقية بلا قاعدة ولا `ctx`.
 *
 * تقرا حقائق المستند وحدها وتعيد حكما واحدا. وحين تمنع تحمل سببا ومخرجا معا — فالشاشة
 * تعرض الاثنين ولا تكتفي باخفاء الزر.
 */
export function documentActionVerdict(input: DocumentActionInput): ActionVerdict {
  const { action, document: d } = input;
  switch (d.kind) {
    case "SALE_INVOICE":
      return saleInvoiceVerdict(action, d);
    case "WORK_ORDER":
      return workOrderVerdict(action, d);
    case "PURCHASE_ORDER":
      return purchaseOrderVerdict(action, d);
    case "GOODS_RECEIPT":
      return goodsReceiptVerdict(action, d);
    case "SALES_RETURN":
      return salesReturnVerdict();
    case "PURCHASE_RETURN":
      return purchaseReturnVerdict(action, d);
  }
}

/** الاحكام الاربعة دفعة واحدة — ما يحتاجه شريط الافعال ليرسم نفسه. */
export function documentActionBar(
  document: DocumentFacts,
): Record<DocumentAction, ActionVerdict> {
  return {
    EDIT: documentActionVerdict({ action: "EDIT", document }),
    CANCEL: documentActionVerdict({ action: "CANCEL", document }),
    REVERSE: documentActionVerdict({ action: "REVERSE", document }),
    CORRECT: documentActionVerdict({ action: "CORRECT", document }),
  };
}

// ═══════════════════════ ١١) النهايات المسدودة ═══════════════════════

/**
 * **حالةٌ يرفض فيها النظام الافعال الاربعة معا.** وهي نوعان لا يجوز خلطهما:
 *
 *  · `terminalByDesign: true` — **نهايةٌ مقصودة**: المستند ادى دوره واغلق بعكسٍ تام، فلا
 *    شيء ينتظر عملاً. المستخدم ليس عالقاً؛ هو امام مستندٍ منتهٍ.
 *  · `terminalByDesign: false` — **انسدادٌ فعليّ**: للمستند عملٌ ينتظر ولا يقبله. هذه وحدها
 *    ما يجب ان يقرأه المالك بوصفه ديناً على النظام.
 *
 * وخلطُ النوعين هو ما يجعل قوائمَ «النهايات المسدودة» بلا قيمة: تمتلئ بالمنتهي بطبيعته
 * فيضيع بينها المسدود حقاً.
 */
export interface DocumentDeadEnd {
  /** معرف ثابت — تستعمله الشاشة والاختبار معاً. */
  id: string;
  kind: DocumentKind;
  /** وصفُ الحالة بدقةٍ تكفي لاعادة انتاجها. */
  state: string;
  /**
   * **عيّنةٌ حقيقيّة** من هذه الحالة. وجودُها هو ما يمنع هذه القائمة من ان تصير ادّعاءً:
   * الاختبار يمرّرها على `documentActionBar` ويثبت ان الاحكام مطابقةٌ لما تدّعيه هذه المدخلة.
   * فان تغيّر حارسٌ في الخادم وحُدّثت الدالّة، سقطت المدخلةُ الكاذبة فوراً.
   */
  sample: DocumentFacts;
  /** ملفٌّ وسطرٌ لكل ما يمنع — الدليلُ لا الادعاء. */
  evidence: readonly string[];
  /** من يفتحها وكيف — او الاعتراف بانعدام المخرج. */
  doThis: string;
  /** نهايةٌ مقصودة ام انسداد؟ */
  terminalByDesign: boolean;
  /**
   * فعلٌ واحدٌ يبقى «مسموحاً» **وهو اجوف**: يمرّ عند الخادم لكنه لا يعالج شيئاً ممّا يريده
   * الواقف امام المستند. يوثَّق هنا صراحةً بدل ان يُدّعى انسدادٌ تامّ غير دقيق — وبدل ان
   * تُحذَف الحالةُ من القائمة فيضيع اهمُّ ما فيها.
   */
  residualAction?: { action: DocumentAction; scope: string };
}

/** فاتورةُ بيعٍ نظيفة (لا مانعَ فيها) — اساسٌ تُبنى منه العيّنات بتبديل الحقل المعنيّ وحده. */
function saleSample(over: Partial<SaleInvoiceFacts> = {}): SaleInvoiceFacts {
  return {
    kind: "SALE_INVOICE",
    status: "PAID",
    fromWorkOrder: false,
    hasItems: true,
    hasPriorReturn: false,
    hasActiveInstallmentPlan: false,
    hasDigitalCards: false,
    hasLiveConsignment: false,
    periodLocked: false,
    ...over,
  };
}

/** امرُ شغلٍ نظيف. */
function workOrderSample(over: Partial<WorkOrderFacts> = {}): WorkOrderFacts {
  return {
    kind: "WORK_ORDER",
    status: "RECEIVED",
    invoiceIssued: false,
    hasLiveConsignment: false,
    hasUnsupportedExchangeReceipt: false,
    periodLocked: false,
    ...over,
  };
}

/** فاتورة بيع ملغاة: عكست بالكامل ورد مالها بسند. */
export const DEAD_END_SALE_INVOICE_CANCELLED: DocumentDeadEnd = {
  sample: saleSample({ status: "CANCELLED" }),
  id: "SALE_INVOICE_CANCELLED",
  kind: "SALE_INVOICE",
  state: "فاتورة بيع حالتها CANCELLED",
  evidence: [
    "server/routers/saleRouter.ts:764 — isDeadInvoiceStatus يمنع تعديل البيانات",
    "server/services/sale/controlRequests.ts:186 — «الفاتورة نهائية ولا تقبل طلب تحكم جديدا» (يمنع الالغاء والمرتجع والتصحيح معا)",
    "server/services/sale/cancel.ts:201 — «الفاتورة ملغاة مسبقا»",
    "server/services/returnService.ts:395 — isDeadInvoiceStatus",
    "server/services/sale/correct.ts:304 — «لا تصحح فاتورة ملغاة/مرتجعة/مستبدلة سلفا»",
  ],
  doThis: "لا اجراء يبقى — المستند اغلق بعكس تام. اصدر فاتورة بيع جديدة ان عاد الزبون يشتري",
  terminalByDesign: true,
};

/** فاتورة بيع مرتجعة بالكامل. */
export const DEAD_END_SALE_INVOICE_RETURNED: DocumentDeadEnd = {
  sample: saleSample({ status: "RETURNED", hasPriorReturn: true }),
  id: "SALE_INVOICE_RETURNED",
  kind: "SALE_INVOICE",
  state: "فاتورة بيع حالتها RETURNED",
  evidence: [
    "server/routers/saleRouter.ts:764 — isDeadInvoiceStatus",
    "server/services/sale/cancel.ts:206 — «الفاتورة مرتجعة بالكامل — لا حاجة للالغاء»",
    "server/services/returnService.ts:395 — «الفاتورة ملغاة او مرتجعة بالكامل»",
    "server/services/sale/correct.ts:304",
  ],
  doThis: "لا اجراء يبقى — البضاعة عادت والمال سوي. اصدر فاتورة بيع جديدة ان عاد الزبون يشتري",
  terminalByDesign: true,
};

/**
 * فاتورة بيع مستبدلة. **ليست انسدادا**: لها خلفٌ حيٌّ يحمل الالتزام، ورسالةُ
 * `returnService` تقول ذلك حرفيا («ارجع من الفاتورة المصححة»).
 */
export const DEAD_END_SALE_INVOICE_SUPERSEDED: DocumentDeadEnd = {
  sample: saleSample({ status: "SUPERSEDED" }),
  id: "SALE_INVOICE_SUPERSEDED",
  kind: "SALE_INVOICE",
  state: "فاتورة بيع حالتها SUPERSEDED (عكست واعيد اصدارها مصححة)",
  evidence: [
    "shared/invoiceStatus.ts:39 — SUPERSEDED ضمن DEAD_INVOICE_STATUSES",
    "server/services/returnService.ts:402 — «الفاتورة مستبدلة بفاتورة مصححة — ارجع من الفاتورة المصححة»",
    "server/services/sale/correct.ts:304",
    "server/services/sale/controlRequests.ts:186",
  ],
  doThis: "افتح الفاتورة المصححة البديلة ونفذ ما تريد عليها — كل الالتزام انتقل اليها",
  terminalByDesign: true,
};

/**
 * فاتورة بيع منشؤها امر شغل. **الاربعة مغلقة على الفاتورة**، والمخرج على مستند اخر
 * (امر الشغل) — ولذلك تظهر هنا: من يقف امام الفاتورة لا يجد فيها زرا يعمل.
 *
 * ⚠️ وله شرطٌ خفيّ: عكسُ التسليم لا يفتح الا حين يكون الامر `DELIVERED`. فان كانت
 * الفاتورة صدرت بالارسال الى مندوب (`delivery/dispatch.ts:553`) والامر ما زال `READY`،
 * فالمخرج ليس شاشة امر الشغل بل شاشة التوصيل — انظر
 * `DEAD_END_WORK_ORDER_INVOICED_BEFORE_DELIVERY`.
 */
export const DEAD_END_SALE_INVOICE_FROM_WORK_ORDER: DocumentDeadEnd = {
  sample: saleSample({ fromWorkOrder: true, status: "PENDING" }),
  residualAction: {
    action: "EDIT",
    scope:
      "تعديل الملاحظات وحده يمر (saleRouter.ts:733 بلا حارس sourceType) — ولا يعالج شيئا من البيع ولا الذمة ولا المخزون",
  },
  id: "SALE_INVOICE_FROM_WORK_ORDER",
  kind: "SALE_INVOICE",
  state: "فاتورة بيع sourceType=WORKORDER وحالتها حية",
  evidence: [
    "server/services/sale/controlRequests.ts:182 — «فاتورة امر الشغل تعالج من مسار عكس التسليم» (يمنع الالغاء والمرتجع والتصحيح وتغيير الاستحقاق)",
    "server/routers/returnRouter.ts:110 — يمنع حتى مسار المالك الفوري",
    "server/services/sale/cancel.ts:248 — «لا تلغى فواتير اوامر الشغل من هنا»",
    "server/services/sale/correct.ts:313 — «فاتورة امر الشغل تصحح من تدفق امر الشغل»",
    "server/services/workOrder/reverseServiceInvoice.ts:1-4 — كل فواتير WORKORDER، ذات البنود وصفريتها، تحول الى REVERSE_DELIVERY نفسه",
  ],
  doThis: "افتح امر الشغل واطلب عكس التسليم — وهو المخرج الوحيد ويلزمه ان يكون الامر مسلما",
  terminalByDesign: false,
};

/** امر شغل ملغى. */
export const DEAD_END_WORK_ORDER_CANCELLED: DocumentDeadEnd = {
  sample: workOrderSample({ status: "CANCELLED" }),
  id: "WORK_ORDER_CANCELLED",
  kind: "WORK_ORDER",
  state: "امر شغل حالته CANCELLED",
  evidence: [
    "server/services/workOrder/update.ts:58 — «لا يمكن تعديل امر ملغى»",
    "server/services/workOrder/cancel.ts:222 — «لا يمكن الغاء امر مسلم او ملغى»",
    "server/services/workOrder/controlRequests.ts:221 — «لا يفتح طلب تحكم لامر نهائي»",
    "server/services/workOrder/controlRequests.ts:199 — عكس التسليم يشترط DELIVERED",
  ],
  doThis: "لا اجراء يبقى — انشئ امر شغل جديدا ان عاد الزبون يطلب",
  terminalByDesign: true,
};

/**
 * امر شغل مسلم ومقبوضه فيه سند صيرفة EXCHANGE. الاربعة مغلقة، والمخرج **خارج الامر**:
 * تسويةُ سند الصيرفة اولا.
 */
export const DEAD_END_WORK_ORDER_EXCHANGE_RECEIPT: DocumentDeadEnd = {
  sample: workOrderSample({ status: "DELIVERED", invoiceIssued: true, hasUnsupportedExchangeReceipt: true }),
  id: "WORK_ORDER_EXCHANGE_RECEIPT",
  kind: "WORK_ORDER",
  state: "امر شغل DELIVERED مقبوضه يتضمن سند صيرفة EXCHANGE",
  evidence: [
    "server/services/workOrder/reverseDelivery.ts:404 — preflight غير مؤهل: «يتضمن المقبوض سند صيرفة EXCHANGE لا يملك قناة رد عميل موثقة»",
    "server/services/workOrder/controlRequests.ts:207 — الطلب يسقط على preflight.ineligibleReason",
    "server/services/workOrder/update.ts:58 و workOrder/cancel.ts:222 — المسلم لا يعدل ولا يلغى",
    "server/services/workOrder/controlRequests.ts:221 — لا تعديل تجاري ولا مادي لامر نهائي",
  ],
  doThis: "سو سند الصيرفة اولا من شاشة الصيرفة، فينقلب preflight مؤهلا ويفتح طلب عكس التسليم",
  terminalByDesign: false,
};

/**
 * ⭐ امر شغل صدرت فاتورته بالارسال الى مندوب وحالته لم تبلغ التسليم بعد. **الاربعة مغلقة
 * على الامر، والاربعة مغلقة على فاتورته ايضا** — وهذا اقرب ما وجدتُ الى انسدادٍ دائريّ.
 *
 * المخرجُ موجودٌ لكنه **على مستند ثالث**: الارسالية. تاكيدُ التسليم ينقل الامر الى
 * `DELIVERED` ([`delivery/courier.ts:1091-1099`]) فيفتح عكس التسليم؛ واسترجاعُ الارسالية
 * يجعل الامر `CANCELLED` ([`delivery/returns.ts:622`]) ويعكس البيع.
 *
 * ⚠️ ولذلك **لا يجوز لشاشة امر الشغل ان تقول «لا مخرج»** هنا: المخرج قائم وفي شاشة اخرى.
 * وهو بالضبط ما يجعل هذه الحالة تستحق الادراج: كل رسالة رفض تراها العين هنا تشير الى
 * مستند غير الذي يحمل المخرج.
 */
export const DEAD_END_WORK_ORDER_INVOICED_BEFORE_DELIVERY: DocumentDeadEnd = {
  sample: workOrderSample({ status: "READY", invoiceIssued: true }),
  id: "WORK_ORDER_INVOICED_BEFORE_DELIVERY",
  kind: "WORK_ORDER",
  state: "امر شغل حالته RECEIVED او IN_PROGRESS او READY و invoiceId مكتوب (ارسل مع مندوب)",
  evidence: [
    "server/services/delivery/dispatch.ts:553 — الارسال يكتب workOrders.invoiceId والحالة تبقى كما هي",
    "server/services/workOrder/update.ts:62 — «صدرت فاتورة لهذا الامر — عالج التغيير بتصحيح/مرتجع الفاتورة»",
    "server/services/workOrder/cancel.ts:242 — «لا يلغى بعد الفوترة؛ استعمل الاسترجاع»",
    "server/services/workOrder/controlRequests.ts:224 — لا تعديل تجاري ولا مادي بعد الفوترة",
    "server/services/workOrder/controlRequests.ts:199 — عكس التسليم يشترط DELIVERED فيسقط هنا",
    "server/services/sale/controlRequests.ts:182 و server/routers/returnRouter.ts:110 — وفاتورته لا تقبل الغاء ولا مرتجعا ولا تصحيحا",
  ],
  doThis: "المخرج في شاشة التوصيل لا في شاشة الامر: اثبت التسليم فيصير الامر مسلما وينفتح عكس التسليم، او استرجع الارسالية فيلغى الامر ويعكس بيعه ومخزونه وعربونه",
  terminalByDesign: false,
};

/** امر شراء استلمت منه بضاعة. */
export const DEAD_END_PURCHASE_ORDER_RECEIVED: DocumentDeadEnd = {
  sample: { kind: "PURCHASE_ORDER", status: "RECEIVED", hasReceivedQuantity: true, hasPayment: false },
  id: "PURCHASE_ORDER_RECEIVED",
  kind: "PURCHASE_ORDER",
  state: "امر شراء حالته RECEIVED او فيه بند receivedBaseQuantity اكبر من صفر",
  evidence: [
    "server/services/purchase/order.ts:575 — «لا يعدل الا امر شراء مسودة»",
    "server/services/purchase/order.ts:586 — «استلمت بضاعة من هذا الامر — لا يعدل بعد الاستلام؛ استعمل مرتجع شراء»",
    "server/services/purchase/controls.ts:221 و :676 — الالغاء للمسودة والمرسل والمعتمد وحدها",
    "server/services/purchase/controls.ts:411 — assertCancellationSafeTx",
    "server/services/purchase/revisions.ts:49 — createPurchaseOrderRevisionTx مستدعاه الوحيدان في order.ts:467 و :642 (انشاء وتعديل مسودة) ⇒ لا مراجعة جديدة لامر غير مسودة",
    "DOCUMENT_ACTION_PATH.PURCHASE_ORDER.REVERSE = null — لا عكس على الامر نفسه",
  ],
  doThis: "عالج البضاعة على مستندها: اطلب عكس اذن الاستلام ان كان الاستلام خطا، او سجل مرتجع شراء على المورد ان عادت البضاعة اليه",
  terminalByDesign: false,
};

/** امر شراء ملغى. */
export const DEAD_END_PURCHASE_ORDER_CANCELLED: DocumentDeadEnd = {
  sample: { kind: "PURCHASE_ORDER", status: "CANCELLED", hasReceivedQuantity: false, hasPayment: false },
  id: "PURCHASE_ORDER_CANCELLED",
  kind: "PURCHASE_ORDER",
  state: "امر شراء حالته CANCELLED",
  evidence: [
    "server/services/purchase/order.ts:575 — التعديل للمسودة وحدها",
    "server/services/purchase/controls.ts:221 — الالغاء لا يقبل حالة CANCELLED",
    "server/services/purchase/controls.ts:589 — العودة الى DRAFT برفض الاعتماد محصورة بالحالة SENT",
  ],
  doThis: "لا اجراء يبقى — انشئ امر شراء جديدا ان عادت الحاجة، والملغى يبقى للتدقيق",
  terminalByDesign: true,
};

/** اذن استلام تاريخي مجمع. */
export const DEAD_END_GOODS_RECEIPT_LEGACY: DocumentDeadEnd = {
  sample: { kind: "GOODS_RECEIPT", status: "POSTED", origin: "LEGACY_AGGREGATE", hasReversibleQuantity: true, periodLocked: false },
  id: "GOODS_RECEIPT_LEGACY_AGGREGATE",
  kind: "GOODS_RECEIPT",
  state: "اذن استلام origin=LEGACY_AGGREGATE",
  evidence: [
    "server/services/purchase/goodsReceipts.ts:959 — «الاذن تاريخي مجمع ولا يحمل مستندا اصليا واحدا يعكس عليه»",
    "server/services/purchase/goodsReceipts.ts — لا تصدر منه دالة تعديل ولا الغاء ولا تصحيح (المصدرات: create، requestReversal، decideReversal، get، list، listPending)",
  ],
  doThis: "صحح الفرق بتسوية مخزون معتمدة او بمرتجع شراء على المورد، ولا تنتظر عكسا لهذا الاذن",
  terminalByDesign: false,
};

/** اذن استلام معكوس بالكامل. */
export const DEAD_END_GOODS_RECEIPT_REVERSED: DocumentDeadEnd = {
  sample: { kind: "GOODS_RECEIPT", status: "REVERSED", origin: "NATIVE", hasReversibleQuantity: false, periodLocked: false },
  id: "GOODS_RECEIPT_REVERSED",
  kind: "GOODS_RECEIPT",
  state: "اذن استلام حالته REVERSED او لم يبق فيه مقبول قابل للعكس",
  evidence: [
    "server/services/purchase/goodsReceipts.ts:977 — «الاذن معكوس بالكامل سلفا، فلا تبقى فيه كمية تعكس»",
    "server/services/purchase/goodsReceipts.ts:1022 — «لم يبق في هذا السطر ما يعكس»",
  ],
  doThis: "افتح امر الشراء وراجع الكميات المتبقية عليه — وحين تتحرر تنشئ اذن استلام جديدا صحيحا؛ ولاخراج بضاعة عادت للمورد استعمل مرتجع الشراء",
  terminalByDesign: true,
};

/**
 * ⭐⭐ **اخطر ما في هذه القائمة**: مرتجع البيع لا مستند له اصلا.
 *
 * لا `salesReturns` في `drizzle/schema.ts`، ولا اجراء في `returnRouter` يمس مرتجعا مسجلا،
 * و[`financialPolicies.test.ts:175-177`] يثبّت هذا **قصدا** باختبارٍ يؤكد ان
 * `cancelReturn`/`voidReturn`/`deleteReturn` غير موجودة، ويقول تعليقه صراحةً:
 * «اي محاولة لاحقة لاضافة void يجب ان تولد receipt IN مقابل».
 *
 * ⇒ المرتجعُ الخاطئ (كمية غلط، مصير بضاعة غلط، فاتورة غلط) **لا يصحح ولا يعكس اليوم**.
 * وهذا قرارٌ حمائيّ مقصود في الاصل (منع تفريغ نقد بلا قيد مقابل)، لكنه يترك الموظف امام
 * خطأ لا يملك ازالته. اذكره كما هو ولا تعد بمخرج.
 */
export const DEAD_END_SALES_RETURN_HAS_NO_DOCUMENT: DocumentDeadEnd = {
  sample: { kind: "SALES_RETURN" },
  id: "SALES_RETURN_HAS_NO_DOCUMENT",
  kind: "SALES_RETURN",
  state: "اي مرتجع بيع مسجل",
  evidence: [
    "drizzle/schema.ts — لا جدول salesReturns؛ المرتجع قيود accountingEntries بنوع RETURN وايصالات وتعديل على الفاتورة",
    "server/services/returnService.ts — listSalesReturns تقرا «قيود RETURN ذات invoiceId بلا supplierId»",
    "server/routers/returnRouter.ts — الاجراءات: create و request و approveRequest و rejectRequest و list — ولا واحد منها يمس مرتجعا مسجلا",
    "server/services/__tests__/financialPolicies.test.ts:175-177 — اختبار يثبت غياب cancelReturn و voidReturn و deleteReturn",
  ],
  doThis: "لا مخرج اليوم. المرتجع الخاطئ لا يصحح ولا يعكس، ومعالجته تحتاج قرار مالك ومسار عكس يبنى (يولد ايصال IN مقابلا) — لا تعد الموظف بحل قائم",
  terminalByDesign: false,
};

/** مرتجع شراء ارثي. */
export const DEAD_END_PURCHASE_RETURN_LEGACY: DocumentDeadEnd = {
  sample: { kind: "PURCHASE_RETURN", status: "POSTED", origin: "LEGACY" },
  id: "PURCHASE_RETURN_LEGACY",
  kind: "PURCHASE_RETURN",
  state: "مرتجع شراء origin=LEGACY",
  evidence: [
    "server/services/purchase/returnGovernance.ts:685 — «المرتجع غير قابل للعكس» حين origin ليس NATIVE",
    "server/routers/purchaseReturnGovernanceRouter.ts — الاجراءات: requestReturn و decideReturn و requestReversal و decideReversal وقوائم — ولا تعديل ولا الغاء ولا تصحيح",
  ],
  doThis: "لا مخرج اليوم على المرتجع نفسه — عالج الفرق بتسوية مخزون معتمدة او بتسوية ذمة مع المورد",
  terminalByDesign: false,
};

/** مرتجع شراء معكوس بالكامل. */
export const DEAD_END_PURCHASE_RETURN_REVERSED: DocumentDeadEnd = {
  sample: { kind: "PURCHASE_RETURN", status: "REVERSED", origin: "NATIVE" },
  id: "PURCHASE_RETURN_REVERSED",
  kind: "PURCHASE_RETURN",
  state: "مرتجع شراء حالته REVERSED",
  evidence: [
    "server/services/purchase/returnGovernance.ts:685 — status REVERSED ضمن نفس الحارس",
    "server/routers/purchaseReturnGovernanceRouter.ts — لا تعديل ولا الغاء ولا تصحيح لمرتجع شراء",
  ],
  doThis: "راجع امر الشراء وفاتورة المورد لترى الوضع بعد العكس، وسجل مرتجعا جديدا ان عادت بضاعة الى المورد",
  terminalByDesign: true,
};

/** كلُّ النهايات المسدودة المعروفة اليوم — يعدّها الاختبار ويقارنها بالاحكام الفعلية. */
export const DOCUMENT_DEAD_ENDS: readonly DocumentDeadEnd[] = [
  DEAD_END_SALE_INVOICE_CANCELLED,
  DEAD_END_SALE_INVOICE_RETURNED,
  DEAD_END_SALE_INVOICE_SUPERSEDED,
  DEAD_END_SALE_INVOICE_FROM_WORK_ORDER,
  DEAD_END_WORK_ORDER_CANCELLED,
  DEAD_END_WORK_ORDER_EXCHANGE_RECEIPT,
  DEAD_END_WORK_ORDER_INVOICED_BEFORE_DELIVERY,
  DEAD_END_PURCHASE_ORDER_RECEIVED,
  DEAD_END_PURCHASE_ORDER_CANCELLED,
  DEAD_END_GOODS_RECEIPT_LEGACY,
  DEAD_END_GOODS_RECEIPT_REVERSED,
  DEAD_END_SALES_RETURN_HAS_NO_DOCUMENT,
  DEAD_END_PURCHASE_RETURN_LEGACY,
  DEAD_END_PURCHASE_RETURN_REVERSED,
];

/** الانسدادات الفعلية وحدها — ما يستحق ان يقرأه المالك دينا على النظام. */
export const DOCUMENT_BLOCKED_DEAD_ENDS: readonly DocumentDeadEnd[] =
  DOCUMENT_DEAD_ENDS.filter((entry) => !entry.terminalByDesign);

/** هل هذا المستند في نهاية مسدودة الان؟ (الاربعة ممنوعة معا.) */
export function isDocumentDeadEnd(document: DocumentFacts): boolean {
  const bar = documentActionBar(document);
  return DOCUMENT_ACTIONS.every((action) => bar[action].allowed === false);
}
