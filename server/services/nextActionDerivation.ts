/**
 * **مُشتقُّ الخطوة التالية على الخادم** — طبقةٌ رقيقةٌ تعبر بحقائق صفوف قواعد البيانات
 * إلى العقد المشترك [`shared/nextAction.ts`] بعد اشتقاق ما تعنيه هذه الحقائق حقيقةً في
 * وحدة التخزين (ثواني/دقائق/تواريخ ⇒ ساعات، وقيمُ حالاتٍ متأصّلة في جداولَ أخرى ⇒
 * enum مُقيَّد على شكلٍ واحد).
 *
 * ## لماذا هنا لا في راوتر
 *
 * لأنّ ثلاثة قرّاء يحتاجون الحقلَ نفسه (`sales.get` و`workOrders.get` و`purchases.get`)،
 * ولأنّ كتابةَ نفس الاشتقاق ثلاث مرّات هي بالضبط ما ينتج «سبعة قواميس فاتورةٍ منجرفة»
 * التي سبق أن أُغلقت. مصدرٌ واحدٌ يُستهلَك عند كلّ قارئ.
 *
 * ⛔ ولا راوترٌ جديد له: حارس `check:orphans` يمنع إجراءً بلا مستدعٍ في الواجهة، والقيمةُ
 * هنا **حقلٌ اختياريّ يُلحَق بردٍّ قائم** لا استدعاءٌ منفصل — ذلك يُبقي الجولة الشبكية
 * الواحدة عند فتح المستند، ويجعل الشاشة تعرض «الخطوة التالية» دون مسارٍ ثانٍ ينكسر
 * وحده حين يتغيّر عقدُه.
 *
 * ## القيود الحاكمة
 *
 * ١) **نقيّةٌ حقيقةً**: بلا I/O، وتستقبل `now: Date` من المستدعي بدل قراءة الساعة —
 *    الحرّاس التي كتبناها في هذا المستودع نسيت هذا الشرط أكثر من مرّة فسقطت اختباراتُها
 *    عند منتصف ليل UTC (ذاكرة [[test-time-constant-rollover-2026-08-31]]). المدخلاتُ
 *    كلُّها في يد المستدعي كي تُثبَّت في الاختبار.
 * ٢) **بلا افتراضٍ صامت** على حقلٍ ماديّ: عمود `dueDate` `null` يمرّ بوصفه `null` إلى
 *    العقد المشترك (⇒ لا سقفَ معلوماً — لا `0` ولا رقمٌ مخترَع)، وعمود `hasDelivery`
 *    الصريح يُقرأ صراحةً. مصدرُ العطب «صفرُ سقفٍ زائفٌ» أطول من أن يُعاد.
 * ٣) **لا تُخترَع حقيقةٌ لا يعرفها الصفّ**: تغطيةُ طلب الشراء (`requisitionCoverage`)
 *    اشتقاقُها الحقيقيّ داخل `server/services/purchase/**` وهو **ممنوعٌ للمسّ** في هذه
 *    الموجة (م٢ ق١١). فنقتصر هنا على ما يقوله الصفُّ صدقاً: إن كان الأمرُ في `SENT` أو
 *    بعدها، فقد **عبَر البوّابةَ فعلاً** ⇒ `COVERED` بحكم الحالة. أمّا `DRAFT` فنُبلِغ
 *    عنه `NOT_REQUIRED` تحفّظاً — أفضلُ ألّا ننذر خطأً على أن ننذر كذباً. الشاشة تبقى
 *    صادقةً، والاشتقاقُ الدقيق يبقى للموجات اللاحقة عبر الخدمة نفسها.
 */

import {
  deriveNextAction,
  type NextAction,
  type PurchaseOrderStatus,
  type SaleInvoiceNextActionFacts,
  type WorkOrderNextActionFacts,
  type PurchaseOrderNextActionFacts,
} from "@shared/nextAction";
import type { InvoiceStatus } from "@shared/invoiceStatus";
import type { WorkOrderStatus } from "@shared/workOrderStatus";

// ═════════════════════════ ١) مساعدات زمنيّة ═════════════════════════

/**
 * ساعاتٌ من الآن حتى تاريخٍ مستقبليّ (سالبٌ = متأخّر، `null` = بلا تاريخ).
 * تُقرَّب إلى منزلة عشرية واحدة كي لا تتسرّب كسورٌ عائمةٌ للعرض. الاسمُ يقصد ما يفعل:
 * لا «tillDue» ولا «ageOf» — الاسمُ الغامضُ يجعل العلامةَ سالبةً بلا انتباه.
 */
function hoursFromNowUntil(
  now: Date,
  target: Date | string | null | undefined,
): number | null {
  if (target == null) return null;
  const t = target instanceof Date ? target : new Date(String(target));
  const ms = t.getTime();
  if (!Number.isFinite(ms)) return null;
  const diffMs = ms - now.getTime();
  return Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10;
}

// ═════════════════════════ ٢) صفوف المدخل ═════════════════════════

/**
 * صفٌّ مسطَّحٌ يكفي لاشتقاق الخطوة التالية لفاتورة البيع.
 * الأسماءُ موافقةٌ لأعمدة استعلام `sales.get` عمداً — تفريغُها ثمّ إعادةُ تسميتها في
 * كلّ مستدعٍ يبعث بابَ الانجراف. `hasLiveConsignment` **مشتقٌّ في المستدعي** (له مصادرُ
 * عدّة: `deliveryConsignments` و`onlineOrders`) كي تبقى هذه الدالّة نقيّةً بلا تصورٍ
 * عن مخطّطٍ متعدّد.
 */
export interface SaleInvoiceNextActionRow {
  invoiceId: number;
  status: InvoiceStatus;
  hasLiveConsignment: boolean;
  deliveryPartyLabel: string | null;
  /** رقمُ الإرسالية الحيّة حين يعرفه المستدعي — يُحمَل في هدف الخطوة كي يفتح الطردَ بعينه (LC02). */
  consignmentId?: number | null;
  replacementInvoiceId: number | null;
  /** `invoices.dueDate` — `null` مسموحٌ (فواتير كثيرة بلا استحقاق مسجَّل). */
  dueDate: Date | string | null;
}

export interface WorkOrderNextActionRow {
  workOrderId: number;
  status: WorkOrderStatus;
  assignedToUserId: number | null;
  hasDelivery: boolean;
  consignmentId: number | null;
  courierDeliveredAt: Date | string | null;
  kanbanState: "NORMAL" | "READY" | "BLOCKED" | null;
  blockedReason: string | null;
  /** عنوانُ مهمّةٍ حاجزةٍ مفتوحة أو `null` — يُقرأ من `assertNoBlockingTask` نفسه. */
  blockingTaskLabel: string | null;
}

export interface PurchaseOrderNextActionRow {
  purchaseOrderId: number;
  status: PurchaseOrderStatus;
  currentRevisionId: number | null;
  /** `purchaseOrders.total − purchaseOrders.paidAmount > 0`. */
  hasUnpaidBalance: boolean;
  /**
   * حالةُ طلب `APPROVE_REVISION` القائم على المراجعة الحالية:
   *  · `PENDING` — قائمٌ ينتظر معتمِداً.
   *  · `STALE`   — بطل: تغيّر الأمر بعد إنشائه أو أُلغي.
   *  · `NONE`    — لا طلبَ (لم يُرسَل أو رُفض ولم يُعَد).
   *
   * يُشتَقّ في المستدعي بقراءة `purchaseOrderControlRequests`. المستدعي هو مَن يرى الجدولَ
   * الآخر، فلا نُقحمه هنا.
   */
  approvalRequest: "PENDING" | "STALE" | "NONE";
  /**
   * `purchaseControlSettings.requireRequisition` للفرع. `undefined` تعني «لم يُقرأ» ⇒
   * نتحفّظ ونعتبرها غير مفروضة (لا نُنذر كذباً).
   */
  requireRequisition: boolean | undefined;
  /** `purchaseOrders.expectedDeliveryDate`. */
  expectedDeliveryDate: Date | string | null;
}

// ═════════════════════════ ٣) الدوالُ العامّة ═════════════════════════

/** يبني `NextActionInput` لفاتورة البيع ثمّ يُنَشِّطه على العقد المشترك. */
export function deriveInvoiceNextAction(
  row: SaleInvoiceNextActionRow,
  now: Date = new Date(),
): NextAction | null {
  const facts: SaleInvoiceNextActionFacts = {
    kind: "SALE_INVOICE",
    invoiceId: row.invoiceId,
    status: row.status,
    hasLiveConsignment: row.hasLiveConsignment,
    deliveryPartyLabel: row.deliveryPartyLabel,
    consignmentId: row.consignmentId ?? null,
    replacementInvoiceId: row.replacementInvoiceId,
    hoursUntilDue: hoursFromNowUntil(now, row.dueDate),
  };
  return deriveNextAction(facts);
}

/** يبني `NextActionInput` لأمر الشغل ثمّ يُنَشِّطه. */
export function deriveWorkOrderNextActionFromRow(
  row: WorkOrderNextActionRow,
): NextAction | null {
  const facts: WorkOrderNextActionFacts = {
    kind: "WORK_ORDER",
    workOrderId: row.workOrderId,
    status: row.status,
    assignedToUserId: row.assignedToUserId,
    hasDelivery: row.hasDelivery,
    consignmentId: row.consignmentId,
    courierDeliveredAt: row.courierDeliveredAt,
    kanbanState: row.kanbanState,
    blockedReason: row.blockedReason,
    blockingTaskLabel: row.blockingTaskLabel,
  };
  return deriveNextAction(facts);
}

/**
 * يبني `NextActionInput` لأمر الشراء ثمّ يُنَشِّطه.
 *
 * **قرارُ التغطية (`requisitionCoverage`) هنا محافظٌ عمداً**:
 *  · `!requireRequisition` ⇒ `NOT_REQUIRED` (إعدادُ الفرع صريحٌ).
 *  · `requireRequisition && status ∈ {SENT, CONFIRMED, RECEIVED}` ⇒ `COVERED` —
 *    الأمرُ عبر البوّابةَ فعلاً (`assertRequisitionOrEmergencyTx` كان سيمنعُه وإلّا).
 *  · `requireRequisition && status = DRAFT` ⇒ `NOT_REQUIRED` تحفّظاً — الاشتقاقُ الدقيق
 *    داخل خدمة الشراء الممنوعة من المسّ. ننتظر موجةً لاحقةً تصلها بمنفذ قراءةٍ صريح
 *    بدل أن نُنذر «مفقودة» على أمرٍ ربّما تكون مغطّاته.
 *  · `CANCELLED` ⇒ العقدُ لا يُلامس التغطيةَ فيها؛ نقول `NOT_REQUIRED`.
 */
export function derivePurchaseOrderNextActionFromRow(
  row: PurchaseOrderNextActionRow,
  now: Date = new Date(),
): NextAction | null {
  const requisitionCoverage: PurchaseOrderNextActionFacts["requisitionCoverage"] =
    row.requireRequisition === true &&
    (row.status === "SENT" ||
      row.status === "CONFIRMED" ||
      row.status === "RECEIVED")
      ? "COVERED"
      : "NOT_REQUIRED";
  const facts: PurchaseOrderNextActionFacts = {
    kind: "PURCHASE_ORDER",
    purchaseOrderId: row.purchaseOrderId,
    status: row.status,
    approvalRequest: row.approvalRequest,
    requisitionCoverage,
    hasCurrentRevision: row.currentRevisionId != null,
    hasUnpaidBalance: row.hasUnpaidBalance,
    hoursUntilExpectedDelivery: hoursFromNowUntil(now, row.expectedDeliveryDate),
  };
  return deriveNextAction(facts);
}

/** يُصدَّر للمساعدة في الاختبار — الاسمُ الصريحُ يمنع خلطه بحسابات وقتٍ أخرى في الخدمة. */
export const __testing = { hoursFromNowUntil };
