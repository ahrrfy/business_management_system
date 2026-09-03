/**
 * **الخطوة التالية** — عقدٌ واحدٌ يقول لكل مستند: **ما الخطوة التالية، ومَن يملكها، وأين
 * تُنفَّذ، ومتى، وما الذي يمنعها الآن**.
 *
 * ## العلّة المقيسة (ق١١ من برنامج v2)
 *
 * صفرُ حقلٍ في النظام يحمل هذا المعنى. الموظّف يفتح فاتورةً أو أمراً فيرى **حالةً** — وهي
 * وصفٌ لما مضى لا تعليمةٌ لما يأتي — ثمّ يخمّن: أيّ شاشةٍ يفتح؟ هل ينتظر أحداً؟ ولماذا هذا
 * الزرُّ رماديّ؟ والزرُّ المعطَّل بأربعة شروطٍ لا يقول أيُّها فشل، فيقف المستخدم أمام مستندٍ
 * صامت. وكلُّ شاشةٍ تُخمّن هذه الإجابة بنفسها تُخمّنها **مختلفةً** — وهو انجرافٌ وقع في هذا
 * المستودع مراراً (سبعةُ قواميس حالةِ فاتورة، وسبعةٌ لأمر الشغل).
 *
 * ## الحدُّ بين هذا الملفّ وأخَوَيه — ثلاثةُ أسئلةٍ لا تُخلَط
 *
 *  · [`shared/documentActions.ts`] — «**هل يقبل المستندُ هذا الفعل**؟» (تعديل/إلغاء/عكس/تصحيح)،
 *    ولِمَ مُنِع. سؤالُ **الإذن على فعلٍ يختاره المستخدم**.
 *  · [`shared/workOrderFlowSteps.ts`] — «أين المستندُ على **الطريق**؟» رسمُ المحطّات الأربع
 *    لأمر الشغل وحده (شريطُ تقدّمٍ للعرض).
 *  · **هذا الملفّ** — «ما **الفعلُ الواحدُ** الذي يجب أن يقع الآن، ومَن صاحبُه؟» سؤالُ
 *    **الدفع إلى الأمام**، وهو لكلّ الأنواع بجوابٍ واحدٍ مُهيكَل.
 *
 * ⇒ ولذلك تختلف الأجوبة اختلافاً مقصوداً: `SUPERSEDED` **مستندٌ ميت** عند `documentActions`
 * (لا فعلَ يقع عليه)، وله هنا **خطوةٌ تالية واضحة**: افتح البديلة وتابع تحصيلها. الميتُ ليس
 * بالضرورة نهاية الطريق — والخلطُ بينهما هو بالضبط ما يترك الموظّف واقفاً.
 *
 * ## القيود الحاكمة على هذا الملفّ
 *
 * ١) **وحدةٌ نقيّة**: بلا I/O، بلا `server/**`، بلا `Date.now()` مخفيّة. كلُّ ما تحتاجه
 *    يصل حقيقةً في المدخل، فتُختبَر حتميّاً.
 * ٢) **لا تُخترَع حالة**: قيمُ الحالات تُقرأ من قواميسها المشتركة القائمة
 *    (`invoiceStatus.ts` · `workOrderStatus.ts`)، وأمرُ الشراء يُمرَّر بنوعه من
 *    `documentActions.ts` نفسه فيستحيل الانجراف عن الـenum بلا خطأ ترجمة.
 * ٣) **لا حالةَ صمّاء**: كلُّ حالةٍ في كلّ نوعٍ إمّا تُنتج `NextAction`، وإمّا تُعلَن نهائيةً
 *    **بسببٍ مكتوب** في `NEXT_ACTION_TERMINAL_REASON`. `null` بلا سببٍ ممنوعٌ باختبار.
 * ٤) **لا مسارَ كاذب**: كلُّ `href` هنا مسارٌ معرَّفٌ فعلاً في `client/src/App.tsx`، وكلُّ
 *    `what` فعلٌ يقبله الخادمُ اليوم. (ولذلك سدادُ المورّد يقود إلى `/purchases/supplier-payments`
 *    لا إلى `purchases.pay` — فذاك المسارُ **مُغلقٌ** بـ`assertLegacyPurchaseWritePathDisabled`.)
 * ٥) **بلا تشكيل** في النصّ المعروض (`what`/`blockedBy`) — الخطّ العربيّ يشوّه التشكيل في
 *    الأحجام الصغيرة؛ وبلا إيموجي (حارس `check:emoji`)؛ والأرقام لاتينية دائماً.
 *
 * ⚠️ **ما ليس هنا عمداً:** الصلاحياتُ والأدوارُ الفعليّة للمستخدم الحاليّ. `owner` يقول
 * **مَن يملك الخطوة**، لا «هل أنتَ هو». الإنفاذ النهائيّ خادميٌّ دائماً (§٢ من CLAUDE.md).
 */

import type { PurchaseOrderFacts } from "./documentActions";
import { INVOICE_STATUSES, type InvoiceStatus } from "./invoiceStatus";
import { WORK_ORDER_SLA_MINUTES } from "./orderSla";
import { ROLES, type RoleKey } from "./permissions";
import { WORK_ORDER_STATUSES, type WorkOrderStatus } from "./workOrderStatus";

// ═════════════════════════════ ١) المفردات ═════════════════════════════

/**
 * صاحبُ الخطوة. أربعةُ أنواعٍ لأنّ «مَن يملكها» أربعةُ أجوبةٍ مختلفةٍ حقيقةً في هذا النظام،
 * وجمعُها في نصٍّ واحدٍ يُفقِد الشاشةَ القدرةَ على أن تسأل «هل هي عليّ أنا؟»:
 *  · `ROLE`         — دورٌ يملكها (كاشير/مدير/محاسب…) ولم يُسنَد بعدُ لشخص.
 *  · `USER`         — شخصٌ بعينه (`workOrders.assignedTo` مثلاً) ⇒ اسمُه يُعرَض ولا يُنازَع.
 *  · `SYSTEM`       — النظام ينفّذها تلقائياً؛ لا أحدَ ينتظر أحداً.
 *  · `COUNTERPARTY` — طرفٌ **خارج** النظام (عميل/مورّد/جهة توصيل). وهذا أهمُّها عملياً:
 *    الموظّفُ الذي لا يعرف أنّ الكرة ليست في ملعبه يظلّ يفتح المستند كلَّ ساعةٍ بلا فائدة.
 */
export type NextActionOwner =
  | { kind: "ROLE"; role: RoleKey }
  | { kind: "USER"; userId: number }
  | { kind: "SYSTEM" }
  | { kind: "COUNTERPARTY"; label: string };

/**
 * الخطوةُ التالية الواحدة.
 *
 * **واحدةٌ لا قائمة** بقصد: المستندُ الذي «أمامه خمسةُ خياراتٍ» هو المستندُ الذي يقف عنده
 * الموظّف. الخياراتُ الأخرى مكانُها شريطُ الأفعال (`documentActions`)؛ وهذا الحقلُ يجيب
 * سؤالاً واحداً: **ماذا الآن؟**
 */
export type NextAction = {
  /** ماذا — فعلُ أمرٍ قصيرٌ بالعربية، بلا تشكيل ولا إيموجي. */
  what: string;
  owner: NextActionOwner;
  /** أين — مسارٌ داخليٌّ معرَّفٌ في `client/src/App.tsx`. */
  href?: string;
  /**
   * متى — سقفُ الساعات المتوقَّع للخطوة. `0` تعني **فوراً** (تجاوزَ الموعدَ أصلاً)،
   * و`undefined` تعني **لا سقفَ معلوماً** — لا «لا سقفَ لها». الفرقُ يهمّ: شاشةٌ تعرض «٠س»
   * حيث لا موعدَ تكذب، وشاشةٌ تُخفي المتأخّرَ تُخفي العطب.
   */
  slaHours?: number;
  /**
   * شروطٌ غير محقّقة تمنع الخطوة الآن — **كلٌّ بنصّه**، لا رقمَ ولا علَمَ بوليانيّ.
   * هذه هي علّةُ «الزرّ المعطَّل بأربعة شروطٍ لا يقول أيُّها فشل»: القائمةُ تُعرَض كما هي.
   * غيابُها (أو فراغُها) يعني: لا مانعَ معلوماً — الخطوةُ قابلةٌ للتنفيذ الآن.
   */
  blockedBy?: string[];
};

/** الأنواع المغطّاة اليوم. تُوسَّع نوعاً نوعاً — لا دفعةً بأجوبةٍ مخمَّنة. */
export const NEXT_ACTION_KINDS = [
  "SALE_INVOICE",
  "WORK_ORDER",
  "PURCHASE_ORDER",
] as const;

export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

/**
 * حالاتُ أمر الشراء — `mysqlEnum("poStatus")` في `drizzle/schema.ts`.
 *
 * لا قاموسَ مشتركاً لها اليوم (بخلاف الفاتورة وأمر الشغل)، فهذه المصفوفةُ أوّلُ تمثيلٍ
 * مشتركٍ لها. وحتى لا تنجرف عن الـenum بصمت، يُثبَّت تطابقُها **بفحص أنواعٍ** مع
 * `PurchaseOrderFacts["status"]` في `documentActions.ts` أدناه: أيُّ قيمةٍ تُضاف أو تُحذف
 * هناك تُحمِّر `pnpm check` هنا.
 */
export const PURCHASE_ORDER_STATUSES = [
  "DRAFT",
  "SENT",
  "CONFIRMED",
  "RECEIVED",
  "CANCELLED",
] as const;

export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

/** تطابقٌ في الاتجاهين مع مصدر الحقيقة الثاني — يفشل عند الترجمة لا عند التشغيل. */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _purchaseOrderStatusParity: MutuallyAssignable<
  PurchaseOrderStatus,
  PurchaseOrderFacts["status"]
> = true;
void _purchaseOrderStatusParity;

// ═════════════════════ ٢) حقائقُ المستندات (مدخلات) ═════════════════════

/**
 * حقائقُ فاتورة البيع. كلُّ حقلٍ هنا **يقرؤه حارسٌ أو كاتبٌ قائم** — لا حقلَ تخمينياً.
 */
export interface SaleInvoiceNextActionFacts {
  kind: "SALE_INVOICE";
  /** `invoices.id` — يبني المسار. */
  invoiceId: number;
  /** `invoices.status` (`shared/invoiceStatus.ts`). */
  status: InvoiceStatus;
  /**
   * إرساليةٌ حيّةٌ عند جهة توصيل (حالتُها ليست CANCELLED ولا RETURNED) — نفسُ حقيقة
   * `SaleInvoiceFacts.hasLiveConsignment` في `documentActions.ts`. وهي التي تنقل ملكيّة
   * الخطوة من الكاشير إلى **جهة التوصيل**: المالُ بيدها والطردُ معها.
   */
  hasLiveConsignment: boolean;
  /** اسمُ جهة التوصيل (`deliveryParties.name`) حين وُجدت إرساليةٌ حيّة. */
  deliveryPartyLabel: string | null;
  /**
   * مُعرِّفُ الفاتورة البديلة للمستبدَلة — `sale/correct.ts` يُصدر فاتورةً جديدة تحمل
   * الالتزام كلَّه ويسِمُ الأصلَ `SUPERSEDED`. `null` حين لم يُلتقَط الرابط.
   */
  replacementInvoiceId: number | null;
  /**
   * ساعاتٌ حتى `invoices.dueDate` (سالبٌ = متأخّرة، `null` = بلا استحقاق مسجَّل).
   * يُحسَب خارجَ الوحدة كي تبقى نقيّةً وحتميّة الاختبار.
   */
  hoursUntilDue: number | null;
}

/**
 * حقائقُ أمر الشغل. أسماءُ الحقول موافقةٌ لِـ`WorkOrderFlowInput` في
 * [`shared/workOrderFlowSteps.ts`] عمداً — الملفّان يقرآن نفسَ الصفّ، واختلافُ التسمية
 * بينهما يُنتج شاشتين تسألان القاعدةَ السؤالَ نفسه بحقلين.
 */
export interface WorkOrderNextActionFacts {
  kind: "WORK_ORDER";
  /** `workOrders.id`. */
  workOrderId: number;
  /** `workOrders.status` (`shared/workOrderStatus.ts`). */
  status: WorkOrderStatus;
  /** `workOrders.assignedTo` — الفنّيُّ المسنَد إن وُجد (`assertOperatorOwns` يقرؤه). */
  assignedToUserId: number | null;
  /** طريقةُ التسليم توصيلٌ لا استلامٌ من المحلّ. */
  hasDelivery: boolean;
  /** الإرسالية المُنشأة للأمر إن أُسند لمندوب. */
  consignmentId: number | null;
  /** لحظةُ إثبات وصول الطرد — `null` يعني أنّه ما زال بالطريق. */
  courierDeliveredAt: Date | string | null;
  /** `workOrders.kanbanState` — إشارةُ الفنّيّ داخل المرحلة (0292). */
  kanbanState: "NORMAL" | "READY" | "BLOCKED" | null;
  /** `workOrders.blockedReason` — يُفرَض غير فارغٍ حين `kanbanState = BLOCKED`. */
  blockedReason: string | null;
  /**
   * عنوانُ مهمّةٍ حاجزةٍ مفتوحة (`serviceTypes.blocksExecution` وحالتُها NEW/IN_PROGRESS/
   * WAITING_CUSTOMER). يقرؤها `assertNoBlockingTask` في
   * [`server/services/workOrder/helpers.ts`] فتمنع **البدء ووسمَ الجاهزية معاً**.
   */
  blockingTaskLabel: string | null;
}

/** حقائقُ أمر الشراء — كلُّها مقروءةٌ من حرّاس `server/services/purchase/controls.ts`. */
export interface PurchaseOrderNextActionFacts {
  kind: "PURCHASE_ORDER";
  /** `purchaseOrders.id`. */
  purchaseOrderId: number;
  status: PurchaseOrderStatus;
  /**
   * حالةُ طلب الاعتماد (`APPROVE_REVISION`) على المراجعة الحالية:
   *  · `PENDING` — قائمٌ ينتظر معتمِداً مستقلاً.
   *  · `STALE`   — تغيّر الأمرُ بعد إنشائه فبطل (`controls.ts`: `baseOrderVersion !== po.version`).
   *  · `NONE`    — لا طلبَ قائماً.
   */
  approvalRequest: "PENDING" | "STALE" | "NONE";
  /**
   * تغطيةُ المراجعة بطلبات شراءٍ معتمدة — `assertRequisitionOrEmergencyTx`:
   *  · `NOT_REQUIRED` — إعداداتُ الفرع لا تفرضها.
   *  · `COVERED`      — مغطّاةٌ بالكامل (أو باستثناءٍ طارئٍ معتمَد).
   *  · `MISSING`      — غيرُ مغطّاة ⇒ **الإرسالُ والاعتمادُ كلاهما يسقط**.
   */
  requisitionCoverage: "NOT_REQUIRED" | "COVERED" | "MISSING";
  /** `purchaseOrders.currentRevisionId != null` — «أمر الشراء بلا مراجعة ثابتة حالية». */
  hasCurrentRevision: boolean;
  /** بقي للمورّد مستحقٌّ على هذا الأمر (`total − paidAmount > 0`). */
  hasUnpaidBalance: boolean;
  /** ساعاتٌ حتى `expectedDeliveryDate` (سالبٌ = متأخّر، `null` = بلا تاريخ متوقَّع). */
  hoursUntilExpectedDelivery: number | null;
}

export type NextActionInput =
  | SaleInvoiceNextActionFacts
  | WorkOrderNextActionFacts
  | PurchaseOrderNextActionFacts;

// ═══════════════ ٣) النهاياتُ المُعلَنة — لا حالةَ صمّاء ═══════════════

/**
 * **لماذا لا خطوةَ تالية** لكل حالةٍ يجوز أن تُرجع فيها `deriveNextAction` قيمةَ `null`.
 *
 * الغرضُ عمليٌّ لا توثيقيّ: الشاشةُ تعرض هذا النصَّ مكانَ الفراغ. «لا شيء» بلا كلمةٍ يُقرأ
 * عطباً في النظام، فيُفتَح المستندُ مرّةً بعد مرّةٍ بحثاً عن زرٍّ لا وجود له.
 *
 * ⛔ ويحرسه اختبارٌ في الاتّجاهين: كلُّ `null` يلزمه مدخلةٌ هنا، وكلُّ مدخلةٍ هنا يلزمها
 * تركيبةُ حقائقَ تُنتج `null` فعلاً — فلا تُدرَج نهايةٌ لا وجودَ لها.
 */
export const NEXT_ACTION_TERMINAL_REASON: {
  SALE_INVOICE: Partial<Record<InvoiceStatus, string>>;
  WORK_ORDER: Partial<Record<WorkOrderStatus, string>>;
  PURCHASE_ORDER: Partial<Record<PurchaseOrderStatus, string>>;
} = {
  SALE_INVOICE: {
    // مسددة بالكامل ولا طرد معلق ⇒ انتهى التزام الطرفين. (وجودُ طردٍ حيٍّ يُنتج خطوةً، فهذه
    // النهايةُ مشروطةٌ بغيابه — انظر الفرع في deriveSaleInvoiceNextAction.)
    PAID: "الفاتورة محصلة بالكامل ولا طرد معلق — لا التزام باق على الطرفين",
    CANCELLED:
      "الفاتورة ملغاة بعكس كامل: الايراد والمخزون والذمة صفرت والمبلغ رد — لا خطوة تدفعها للامام",
    RETURNED:
      "الفاتورة مرتجعة بالكامل: البضاعة عادت والمبلغ سوي — لا خطوة تدفعها للامام",
  },
  WORK_ORDER: {
    DELIVERED:
      "الامر سلم للزبون وصدرت فاتورته ووصل طرده — خرج من دورة العمل ولا حمل على منفذ",
    CANCELLED:
      "الامر ملغى: خرج من دورة العمل ولا يحمل التزاما ولا حملا على منفذ",
  },
  PURCHASE_ORDER: {
    RECEIVED:
      "وصلت البضاعة كاملة وسدد المورد — دورة الشراء مقفلة على هذا الامر",
    CANCELLED:
      "امر الشراء ملغى ولا دفعة عليه — يبقى للتدقيق ولا خطوة تدفعه للامام",
  },
};

/**
 * سببُ انعدام الخطوة لهذه (النوع × الحالة)، أو `null` حين لا نهايةَ معلنةً لها.
 * تُستدعى حين تُرجع `deriveNextAction` قيمةَ `null` — والاثنان متلازمان باختبار.
 */
export function nextActionTerminalReason(
  kind: NextActionKind,
  status: string,
): string | null {
  const table = NEXT_ACTION_TERMINAL_REASON[kind] as Record<string, string | undefined>;
  return table[status] ?? null;
}

// ═════════════════════════ ٤) مساعدون داخليّون ═════════════════════════

/** دورٌ يملك الخطوة. */
function byRole(role: RoleKey): NextActionOwner {
  return { kind: "ROLE", role };
}

/** شخصٌ بعينه — يُستعمَل حين يكون الإسنادُ مكتوباً في الصفّ لا مستنتَجاً. */
function byUser(userId: number): NextActionOwner {
  return { kind: "USER", userId };
}

/** طرفٌ خارجيّ. التسميةُ تُقصّ وتُنظَّف، وتسقط إلى وصفٍ عامٍّ إن كانت فارغة. */
function byCounterparty(label: string | null, fallback: string): NextActionOwner {
  const clean = (label ?? "").trim();
  return { kind: "COUNTERPARTY", label: clean.length > 0 ? clean : fallback };
}

/**
 * يحوّل «ساعاتٍ حتى الموعد» إلى سقفٍ للخطوة:
 *  · `null`  ⇒ `undefined` (لا سقفَ معلوماً — لا سقفَ منعدماً).
 *  · سالبٌ   ⇒ `0` (تجاوزَ الموعد ⇒ فوراً).
 * ويُقرَّب إلى منزلةٍ واحدة كي لا تتسرّب كسورٌ عائمةٌ إلى العرض.
 */
function slaFromHoursUntil(hours: number | null | undefined): number | undefined {
  if (hours == null || !Number.isFinite(hours)) return undefined;
  return Math.max(0, Math.round(hours * 10) / 10);
}

/** سقفُ الحالة لأمر الشغل، مشتقٌّ من المصدر الوحيد `WORK_ORDER_SLA_MINUTES`. */
function workOrderSlaHours(status: WorkOrderStatus): number | undefined {
  const row = WORK_ORDER_SLA_MINUTES[status];
  if (!row) return undefined;
  return Math.round((row.breachAfter / 60) * 10) / 10;
}

/** يبني قائمة الموانع، ويحذف الفارغَ منها ثمّ يُسقِط الحقلَ كلَّه إن لم يبقَ شيء. */
function blockers(...entries: (string | null | undefined)[]): string[] | undefined {
  const list = entries
    .map((entry) => (entry ?? "").trim())
    .filter((entry) => entry.length > 0);
  return list.length > 0 ? list : undefined;
}

/** يُركّب الخطوة ويُسقِط الحقول الاختيارية الفارغة (فلا `href: undefined` في الحمولة). */
function action(input: {
  what: string;
  owner: NextActionOwner;
  href?: string;
  slaHours?: number;
  blockedBy?: string[];
}): NextAction {
  const out: NextAction = { what: input.what, owner: input.owner };
  if (input.href != null) out.href = input.href;
  if (input.slaHours != null) out.slaHours = input.slaHours;
  if (input.blockedBy != null && input.blockedBy.length > 0) out.blockedBy = input.blockedBy;
  return out;
}

// ═════════════════════ ٥) فاتورة البيع — سبعُ حالات ═════════════════════

/**
 * **الحالاتُ السبع كلُّها مغطّاة**، ولا واحدةَ منها صمّاء:
 *
 * | الحالة | الخطوة |
 * |---|---|
 * | `PENDING` · `CONFIRMED` · `PARTIALLY_PAID` | تحصيلٌ — على الكاشير، أو على **جهة التوصيل** إن كان الطردُ بيدها |
 * | `PAID` مع طردٍ حيّ | إثباتُ الوصول — على جهة التوصيل |
 * | `PAID` بلا طرد | نهائيّة بسببٍ معلن |
 * | `SUPERSEDED` | **ليست نهاية**: افتح البديلة وتابعها |
 * | `CANCELLED` · `RETURNED` | نهائيّتان بسببٍ معلن |
 *
 * ملاحظةُ صدقٍ عن `CONFIRMED`: **لا كاتبَ لها اليوم** — `computeInvoiceStatus`
 * ([`server/services/ledgerService.ts`]) يُنتج `PENDING`/`PARTIALLY_PAID`/`PAID` وحدها،
 * ولا خدمةَ تكتبها. لكنّ قرّاء الذمم يعدّونها **رصيداً مفتوحاً** صراحةً
 * (`arRemindersService.ts` و`customerService.ts`) ⇒ تُعامَل هنا معاملةَ المستحقّ، لا تُترك
 * بلا خطوة. صفٌّ قديمٌ يحملها يجب أن يُطالَب لا أن يُنسى.
 */
function deriveSaleInvoiceNextAction(d: SaleInvoiceNextActionFacts): NextAction | null {
  const sla = slaFromHoursUntil(d.hoursUntilDue);

  if (d.status === "CANCELLED" || d.status === "RETURNED") {
    // نهائيّتان: عُكِستا بالكامل فلا مالَ ولا بضاعةَ ولا ذمّةَ تنتظر أحداً.
    return null;
  }

  if (d.status === "SUPERSEDED") {
    /**
     * ⭐ **موضعُ الفائدة كلِّه**: هذه الفاتورة «ميتة» عند شريط الأفعال (لا تُعدَّل ولا تُلغى
     * ولا تُعكَس ولا تُصحَّح)، ومع ذلك **الطريقُ يستمرّ** على البديلة التي تحمل الالتزام.
     * صمتُ الشاشة هنا هو الذي يجعل الموظّف يظنّ المستندَ معطوباً.
     */
    return action({
      what: "افتح الفاتورة المصححة البديلة وتابع تحصيلها",
      owner: byRole("cashier"),
      href:
        d.replacementInvoiceId != null
          ? `/invoices/${d.replacementInvoiceId}`
          : "/invoices",
      blockedBy: blockers(
        d.replacementInvoiceId == null
          ? "الفاتورة البديلة غير مرتبطة بهذا المستند — ابحث عنها في قائمة الفواتير باسم العميل وتاريخ الاصل"
          : null,
      ),
    });
  }

  if (d.status === "PAID") {
    if (d.hasLiveConsignment) {
      /**
       * مسدَّدةٌ سلفاً وطردُها ما زال بالطريق: لا مالَ يُطلَب، لكنّ **الحيازة** لم تُغلق بعد.
       * صاحبُ الخطوة جهةُ التوصيل، لا موظّفٌ في المحلّ ينتظر.
       */
      return action({
        what: "اثبت وصول الطرد واغلق الارسالية",
        owner: byCounterparty(d.deliveryPartyLabel, "جهة التوصيل"),
        href: "/delivery",
      });
    }
    return null; // نهائيّة — السببُ في NEXT_ACTION_TERMINAL_REASON.
  }

  // PENDING · CONFIRMED · PARTIALLY_PAID — رصيدٌ مفتوح يُطالَب به.
  const what =
    d.status === "PARTIALLY_PAID"
      ? "حصل المبلغ المتبقي من العميل"
      : "حصل قيمة الفاتورة من العميل";

  if (d.hasLiveConsignment) {
    /**
     * المالُ ليس في المحلّ: الطردُ عند المندوب وعهدةُ التحصيل قائمةٌ عليه، والتحصيلُ يقع
     * بمسار التوصيل (`staffConfirm`/التوريد) لا على شاشة الفاتورة. عرضُ زرّ قبضٍ هنا
     * يُنتج تحصيلاً مزدوجاً أو نقداً بلا مالك — وهو الفرقُ الذي بُنيت له منظومةُ التوصيل.
     */
    return action({
      what: "حصل قيمة الفاتورة عند تسليم الطرد ثم ورد التحصيل",
      owner: byCounterparty(d.deliveryPartyLabel, "جهة التوصيل"),
      href: "/delivery",
      slaHours: sla,
    });
  }

  return action({
    what,
    owner: byRole("cashier"),
    href: `/invoices/${d.invoiceId}`,
    slaHours: sla,
  });
}

// ═════════════════════ ٦) أمر الشغل — خمسُ حالات ═════════════════════

/**
 * **الخمسُ كلُّها مغطّاة.** المسارُ: استلام ← تنفيذ ← جاهز ← تسليم (مباشرٌ أو بمندوب).
 * والسقوفُ الزمنيّة مأخوذةٌ من `WORK_ORDER_SLA_MINUTES` ([`shared/orderSla.ts`]) — مصدرٌ
 * واحدٌ لا رقمٌ يُكتب هنا ثانيةً.
 *
 * **الإسنادُ يُغيّر صاحبَ الخطوة لا الخطوة**: أمرٌ مسنَدٌ لفنّيٍّ يملكه ذلك الفنّيُّ بعينه
 * (`assertOperatorOwns` يمنع غيرَه)، وأمرٌ بلا إسنادٍ يملكه الدورُ كلُّه فيسحبه أوّلُ فارغ.
 */
function deriveWorkOrderNextAction(d: WorkOrderNextActionFacts): NextAction | null {
  if (d.status === "CANCELLED") return null; // نهائيّة — خرج من دورة العمل.

  const operator: NextActionOwner =
    d.assignedToUserId != null ? byUser(d.assignedToUserId) : byRole("print_operator");
  const href = `/work-orders/${d.workOrderId}`;
  const sla = workOrderSlaHours(d.status);

  /** المهمّةُ الحاجزة تمنع **البدء ووسمَ الجاهزية معاً** — نصٌّ واحدٌ لموضعين. */
  const blockingTask = (verb: string): string | null =>
    d.blockingTaskLabel != null && d.blockingTaskLabel.trim().length > 0
      ? `${verb} قبل اغلاق المهمة الحاجزة «${d.blockingTaskLabel.trim()}» — سجل موافقة العميل من بطاقة التصميم او اغلق المهمة بسبب من شاشة المهام`
      : null;

  if (d.status === "RECEIVED") {
    return action({
      what: "ابدا التنفيذ واخصم المواد",
      owner: operator,
      href,
      slaHours: sla,
      blockedBy: blockers(blockingTask("لا يبدا التنفيذ")),
    });
  }

  if (d.status === "IN_PROGRESS") {
    const blockedByKanban =
      d.kanbanState === "BLOCKED"
        ? (d.blockedReason ?? "").trim() ||
          "التنفيذ متوقف باشارة الفني — راجع سبب التعطيل على الامر"
        : null;
    return action({
      what: "ضع علامة جاهز عند انتهاء الشغل",
      owner: operator,
      href,
      slaHours: sla,
      blockedBy: blockers(blockedByKanban, blockingTask("لا يوسم الامر جاهزا")),
    });
  }

  if (d.status === "READY") {
    if (d.hasDelivery && d.consignmentId != null) {
      /**
       * جاهزٌ **وأُسند فعلاً** لمندوب: الكرةُ خرجت من المحلّ. الشاشةُ التي تُبقي زرّ
       * «أسند لمندوب» هنا تدعو إلى إسنادٍ ثانٍ لطردٍ مُسنَد.
       */
      return action({
        what: "تابع الطرد مع جهة التوصيل حتى اثبات الوصول",
        owner: byCounterparty(null, "جهة التوصيل"),
        href: "/delivery",
        slaHours: sla,
      });
    }
    return action({
      what: d.hasDelivery
        ? "اسند الامر لمندوب التوصيل واصدر الارسالية"
        : "سلم الامر للعميل واصدر الفاتورة",
      owner: byRole("cashier"),
      href,
      slaHours: sla,
    });
  }

  // DELIVERED — سُلِّم وصدرت فاتورتُه. يبقى طرفٌ واحدٌ مفتوحٌ محتمل: طردٌ لم يُثبَت وصولُه.
  if (d.hasDelivery && d.consignmentId != null && d.courierDeliveredAt == null) {
    return action({
      what: "اثبت وصول الطرد وحصل قيمته",
      owner: byCounterparty(null, "جهة التوصيل"),
      href: "/delivery",
    });
  }
  return null; // نهائيّة — السببُ في NEXT_ACTION_TERMINAL_REASON.
}

// ═════════════════════ ٧) أمر الشراء — خمسُ حالات ═════════════════════

/**
 * **الخمسُ كلُّها مغطّاة.** والمسارُ محكومٌ بقرار المالك (٢/٩/٢٦، §٦ من CLAUDE.md):
 * `DRAFT` بلا أثرٍ ⇒ `SENT` إرسالٌ وطلبُ اعتماد ⇒ اعتمادُ مراجعٍ **مستقلٍّ** ينفّذ سلسلةً
 * ذرّيةً واحدة (GRN → مخزون/WAVG → GRNI → فاتورةُ المورّد → AP) وينتهي عند `RECEIVED`.
 *
 * ولذلك `CONFIRMED` **ليست محطّةً عابرةً في الحالة الطبيعيّة** — السلسلةُ تعبرها داخل
 * المعاملة نفسها. تبقى مكتوبةً في القاعدة في حالتين حقيقيّتين وحدهما:
 * استلامٌ جزئيّ تاريخيّ ([`goodsReceipts.ts`]: `fullyReceived ? "RECEIVED" : "CONFIRMED"`)،
 * أو **عكسُ إذن استلامٍ** يُعيد الأمرَ إليها. وفي الحالتين المعنى واحد: **معتمَدٌ وبقيت
 * كمياتٌ لم تدخل المخزن**.
 *
 * ⚠️ ولا شاشةَ استلامٍ مستقلّةٍ اليوم: `purchases.receive` مُغلَقٌ بـ
 * `assertLegacyPurchaseWritePathDisabled`، وقرارُ المالك أنّ **الشحنة الجزئية أمرُ شراءٍ
 * مستقلٌّ** بالكميات الواصلة وحدها. فالخطوةُ الصادقة هي فتحُ أمرٍ جديد، لا انتظارُ زرٍّ
 * غيرِ موجود.
 */
function derivePurchaseOrderNextAction(
  d: PurchaseOrderNextActionFacts,
): NextAction | null {
  if (d.status === "CANCELLED") return null; // نهائيّة — ملغى ولا دفعة عليه.

  const href = `/purchases/${d.purchaseOrderId}`;

  /** غيابُ تغطية طلب الشراء يُسقِط **الإرسالَ والاعتمادَ** معاً — نصٌّ واحدٌ لموضعين. */
  const requisitionBlocker =
    d.requisitionCoverage === "MISSING"
      ? "المراجعة غير مغطاة بطلب شراء معتمد — انشئ طلب استثناء طارئ واعتمده اولا، او غط الامر بطلبات شراء"
      : null;

  if (d.status === "DRAFT") {
    return action({
      what: "ارسل الامر للاعتماد",
      owner: byRole("purchasing"),
      href,
      blockedBy: blockers(
        requisitionBlocker,
        d.hasCurrentRevision ? null : "امر الشراء بلا مراجعة ثابتة حالية — احفظ بنوده مرة اخرى لتثبت مراجعته",
      ),
    });
  }

  if (d.status === "SENT") {
    if (d.approvalRequest === "PENDING") {
      /**
       * صاحبُها **مديرٌ غيرُ منشئ الأمر وغيرِ محرّره الأخير وغيرِ صاحب الطلب** (فصلُ مهام
       * مفروضٌ في [`controls.ts`]: «يلزم معتمد مستقل عن المنشئ وآخر محرر وصاحب الطلب»).
       * الدورُ هو ما يُعرَض هنا؛ فحصُ الشخص خادميٌّ لا يُخمَّن في وحدةٍ نقيّة.
       */
      return action({
        what: "اعتمد المراجعة واقر وصول الكميات كاملة",
        owner: byRole("manager"),
        href,
        blockedBy: blockers(requisitionBlocker),
      });
    }
    return action({
      what:
        d.approvalRequest === "STALE"
          ? "اعد طلب الاعتماد على المراجعة الحالية"
          : "اطلب اعتماد المراجعة",
      owner: byRole("purchasing"),
      href,
      blockedBy: blockers(
        d.approvalRequest === "STALE"
          ? "طلب الاعتماد السابق لاغ: تغير امر الشراء بعد انشائه"
          : null,
        requisitionBlocker,
      ),
    });
  }

  if (d.status === "CONFIRMED") {
    return action({
      what: "سجل الكميات الباقية بامر شراء مستقل عند وصولها",
      owner: byRole("purchasing"),
      href: "/purchases/new",
      slaHours: slaFromHoursUntil(d.hoursUntilExpectedDelivery),
    });
  }

  // RECEIVED — دخلت البضاعةُ وقُيِّدت ذمّةُ المورّد. يبقى السداد إن بقي مستحقّ.
  if (d.hasUnpaidBalance) {
    /**
     * ⚠️ المسارُ الحيّ هو `supplierPayments.requestPayment` بشاشته المحكومة —
     * `purchases.pay` **مُغلَقٌ** بعد حوكمة المشتريات
     * ([`server/services/purchase/governanceCutover.ts`]). توجيهُ المستخدم إلى الأوّل هو
     * الفرقُ بين خطوةٍ تنجح وأخرى ترتدّ برسالة «أُغلق المسار القديم».
     */
    return action({
      what: "اطلب سداد المورد باعتماد ثان",
      owner: byRole("accountant"),
      href: "/purchases/supplier-payments",
    });
  }
  return null; // نهائيّة — السببُ في NEXT_ACTION_TERMINAL_REASON.
}

// ═════════════════════════ ٨) المدخلُ العامّ ═════════════════════════

/**
 * الخطوةُ التالية لهذا المستند، أو `null` حين لا خطوة — ومعها **دائماً** سببٌ معلنٌ
 * يُقرأ بـ`nextActionTerminalReason(kind, status)`.
 *
 * دالّةٌ نقيّةٌ تماماً: لا `Date.now()` ولا استعلام ولا `ctx`. كلُّ ما يتغيّر بالزمن
 * (الاستحقاق، الموعد المتوقَّع) يصل ساعاتٍ محسوبةً في المدخل.
 */
export function deriveNextAction(doc: NextActionInput): NextAction | null {
  switch (doc.kind) {
    case "SALE_INVOICE":
      return deriveSaleInvoiceNextAction(doc);
    case "WORK_ORDER":
      return deriveWorkOrderNextAction(doc);
    case "PURCHASE_ORDER":
      return derivePurchaseOrderNextAction(doc);
  }
}

// ═════════════════════════ ٩) تسميةُ صاحب الخطوة ═════════════════════════

/** تسمياتُ الأدوار من `shared/permissions.ts` — مصدرٌ واحدٌ لا قاموسَ محلّيٌّ في شاشة. */
const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  ROLES.map((role) => [role.key, role.label]),
);

/**
 * نصُّ صاحب الخطوة للعرض. `USER` **بلا اسمٍ هنا** بقصد: الأسماءُ تُقرأ من القاعدة، ووحدةٌ
 * نقيّةٌ لا تخترعها. تُمرَّر `userName` حين تكون الشاشةُ قد حمّلتها أصلاً.
 */
export function nextActionOwnerLabel(
  owner: NextActionOwner,
  userName?: string | null,
): string {
  switch (owner.kind) {
    case "ROLE":
      return ROLE_LABEL[owner.role] ?? owner.role;
    case "USER": {
      const name = (userName ?? "").trim();
      return name.length > 0 ? name : "الموظف المسند";
    }
    case "SYSTEM":
      return "النظام";
    case "COUNTERPARTY":
      return owner.label;
  }
}

/**
 * هل هذه الخطوةُ محجوبةٌ الآن؟ (بوليانٌ للعرض فقط — السببُ في `blockedBy` وهو ما يُعرَض.)
 * `null` (لا خطوة) ليس حجباً: هو نهايةٌ لها سببُها المستقلّ.
 */
export function isNextActionBlocked(next: NextAction | null): boolean {
  return next != null && (next.blockedBy?.length ?? 0) > 0;
}

/** كلُّ قيم الحالات المغطّاة، بنوعها — يستهلكه اختبارُ العدّ فلا تُنسى حالةٌ تُضاف. */
export const NEXT_ACTION_STATUS_UNIVERSE: {
  SALE_INVOICE: readonly InvoiceStatus[];
  WORK_ORDER: readonly WorkOrderStatus[];
  PURCHASE_ORDER: readonly PurchaseOrderStatus[];
} = {
  SALE_INVOICE: INVOICE_STATUSES,
  WORK_ORDER: WORK_ORDER_STATUSES,
  PURCHASE_ORDER: PURCHASE_ORDER_STATUSES,
};
