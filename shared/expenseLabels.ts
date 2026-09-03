/**
 * expenseLabels — قواميس **المصروفات** العربية: مصدرُ حقيقةٍ واحد لما تعرضه شاشةُ
 * المصروفات والتصديرُ والطباعة معاً.
 *
 * ## لماذا وُجد هذا الملفّ
 * كانت `client/src/pages/Expenses.tsx` تُعرّف **عشرة** قواميس تسميةٍ محلّية في رأسها. خمسةٌ
 * منها مفاهيمُ مصروفاتٍ خالصة لا يملكها غيرُها (حالةُ المصروف · سببُ الصرف المخزنيّ · مصدرُ
 * التمويل · حالةُ اعتماد سند الصرف · تحذيراتُ التدقيق)، لكنّ مكانَها الطبيعيّ `shared/` لا
 * صفحةٌ واحدة: **الخادم هو الذي يولّد رموزَها** (`expenseService.integrityWarningsOf`
 * و`fundingKindOf` وتعدادات `drizzle/schema.ts`)، فتعريفُها داخل شاشةٍ يجعل كلَّ توسيعٍ
 * خادميّ يتسرّب رمزاً إنجليزياً خامّاً إلى شاشةٍ عربيّة — وهي بعينها علّةُ «سبعة قواميس
 * فاتورة منجرفة» التي يحذّر منها `CLAUDE.md`.
 *
 * ⛔ **لا تُعِد تعريف أيٍّ من هذه القواميس محلّياً في شاشة** — استهلك من هنا.
 * كلُّ قائمةِ مفاتيحَ هنا تُطابَق باختبارٍ نصّيّ (`./expenseLabels.test.ts`) مع **مصدرها
 * الحيّ** لا مع نسخةٍ مكتوبةٍ بيد: التعدادات من `drizzle/schema.ts`، ورموزُ التدقيق ومصادرُ
 * التمويل من `server/services/expenseService.ts`. ⇒ توسيعُ الخادم بلا تسميةٍ هنا
 * **يُحمِّر الاختبار** بدل أن يُسرّب الرمزَ إلى الشاشة.
 *
 * ## ما ليس هنا عمداً (قواميسُ مشترَكة يملكها غيرُنا)
 *   · **طريقةُ الدفع** ⇒ [`shared/terms.ts`](./terms.ts) (`PAYMENT_METHOD_TERMS` مع
 *     `PAYMENT_METHOD_SOURCE_ENUMS.expensePaymentMethod`). عمودُ المصروفات وحدَه يحمل
 *     `ACCRUAL`، وذاك القاموسُ يعرفها.
 *   · **الدلو المحاسبيّ** (فئةُ المصروف) ⇒ [`shared/expenseCategories.ts`](./expenseCategories.ts).
 *   · **نوعُ الوردية وحالتُها** ⇒ `client/src/lib/labels.ts` (`SHIFT_TYPE_AR`). مفهومُ
 *     الورديات لا المصروفات؛ توحيدُه يمسّ شاشاتٍ أخرى فهو موجةٌ مستقلّة.
 *
 * ## بلا تشكيل في النصّ القصير
 * كلُّ ما في هذا الملفّ يُرسَم في **شارةٍ أو رقاقةٍ بحجم 11-12px** (`text-[11px]` في جدول
 * المصروفات)، وخطُّ الواجهة (Cairo/Tajawal) يُشوّه التشكيل في هذا الحجم فيقرأ الموظّف
 * «مُلغى» ⇒ «فلغى» — نفسُ القياس الذي أنتج حارس `check:tashkeel` وقاموسَ `partyExposure`.
 * ⇒ التسمياتُ القصيرة **بلا تشكيل**، والاستثناءُ الوحيد `EXPENSE_FUNDING_META.label`
 * (عنوانُ مجموعةٍ بحجمٍ نظاميّ، ويظهر كذلك في `aria-label` حيث لا رسمَ أصلاً).
 */

/* ═════════════════════════ ١) حالةُ المصروف ═════════════════════════ */

/** مرآةُ `mysqlEnum("expenseStatus", …)` حرفياً — [drizzle/schema.ts]. الترتيب = دورةُ الحياة. */
export const EXPENSE_STATUSES = [
  "PENDING_APPROVAL",
  "ACTIVE",
  "REJECTED",
  "CANCELLED",
] as const;

export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/**
 * التسميةُ العربية. «نافذ» لا «معتمد»: `ACTIVE` تعني أنّ الإيصال والقيد ومصدرَ الدفع
 * **نُفِّذت فعلاً**، بينما الاعتمادُ حالةُ سندٍ منفصلة لها قاموسُها أدناه — خلطُ اللفظين
 * يجعل الموظّف يظنّ المصروفَ صُرف بمجرّد اعتماد الطلب.
 */
export const EXPENSE_STATUS_AR: Readonly<Record<ExpenseStatus, string>> =
  Object.freeze({
    PENDING_APPROVAL: "بانتظار اعتماد المالك",
    ACTIVE: "نافذ",
    REJECTED: "مرفوض بلا صرف",
    CANCELLED: "ملغى",
  });

/** صنفُ شارة الحالة — توكنز دلالية (`badge-status-*`) لا ألوانٌ خامّة (حارس `check:colors`). */
export const EXPENSE_STATUS_BADGE_CLASS: Readonly<
  Record<ExpenseStatus, string>
> = Object.freeze({
  PENDING_APPROVAL: "badge-status-pending",
  ACTIVE: "badge-status-active",
  REJECTED: "badge-status-cancelled",
  CANCELLED: "badge-status-cancelled",
});

export function isExpenseStatus(v: unknown): v is ExpenseStatus {
  return (
    typeof v === "string" && (EXPENSE_STATUSES as readonly string[]).includes(v)
  );
}

/** المجهولُ يعود بالرمز نفسه (سلوكُ الشاشة القائم محفوظ) والفارغُ «—». */
export function expenseStatusLabel(v: string | null | undefined): string {
  if (!v) return "—";
  return isExpenseStatus(v) ? EXPENSE_STATUS_AR[v] : v;
}

/** صنفُ الشارة للمجهول: محايدٌ لا لونُ حالةٍ كاذب. */
export function expenseStatusBadgeClass(v: string | null | undefined): string {
  return isExpenseStatus(v) ? EXPENSE_STATUS_BADGE_CLASS[v] : "bg-muted";
}

/* ═══════════════════ ٢) سببُ الصرف من المخزون ═══════════════════ */

/** مرآةُ `mysqlEnum("expenseStockReason", …)` — يُقرأ مع `source = "STOCK"` وحدَه. */
export const EXPENSE_STOCK_REASONS = ["INTERNAL_USE", "WASTAGE"] as const;

export type ExpenseStockReason = (typeof EXPENSE_STOCK_REASONS)[number];

/**
 * لاحقةُ «(مخزون)» مقصودة: هذا القاموسُ يحلّ **محلّ طريقة الدفع** في عمودٍ واحد، فلولاها
 * قرأ الموظّف «نثرية» و«تلف» في عمود المصدر فظنّهما رافدَي نقدٍ لا صرفاً عينياً.
 * ⚠️ ولا يُخلَط بـ`accountingEntries.entryType` في دفتر الأستاذ: الرمزان `INTERNAL_USE`
 * و`WASTAGE` موجودان هناك أيضاً بمعنى **نوع القيد** لا سببِ صرف المصروف، ولهما تسميتُهما.
 */
export const EXPENSE_STOCK_REASON_AR: Readonly<
  Record<ExpenseStockReason, string>
> = Object.freeze({
  INTERNAL_USE: "نثرية (مخزون)",
  WASTAGE: "تلف (مخزون)",
});

export function isExpenseStockReason(v: unknown): v is ExpenseStockReason {
  return (
    typeof v === "string" &&
    (EXPENSE_STOCK_REASONS as readonly string[]).includes(v)
  );
}

/**
 * `fallback` صريحٌ لأنّ للمستهلك نصَّين مختلفَين عند غياب السبب: عمودُ المصدر يقول
 * «مخزون» وسطرُ التفصيل يقول «صرف مخزون». تمريرُه يمنع توحيدَ نصَّين مقصودَي الاختلاف.
 */
export function expenseStockReasonLabel(
  v: string | null | undefined,
  fallback: string,
): string {
  return isExpenseStockReason(v) ? EXPENSE_STOCK_REASON_AR[v] : fallback;
}

/* ═════════════ ٣) حالةُ اعتماد سند الصرف المرافق ═════════════ */

/**
 * مرآةُ `mysqlEnum("receiptApprovalStatus", …)` — تصل الشاشةَ من `receipts.approvalStatus`
 * المرتبط بالمصروف لا من عمودٍ على `expenses`. لذلك هي **حالةُ السند** لا حالةُ المصروف:
 * العمودان يظهران متجاورَين في الجدول، وتسميتُهما بنفس اللفظ كانت تُوهم تكراراً لا معنيَين.
 */
export const EXPENSE_APPROVAL_STATUSES = [
  "APPROVED",
  "PENDING_APPROVAL",
  "REJECTED",
] as const;

export type ExpenseApprovalStatus = (typeof EXPENSE_APPROVAL_STATUSES)[number];

export const EXPENSE_APPROVAL_AR: Readonly<
  Record<ExpenseApprovalStatus, string>
> = Object.freeze({
  APPROVED: "معتمد",
  PENDING_APPROVAL: "بانتظار الاعتماد",
  REJECTED: "مرفوض",
});

export function isExpenseApprovalStatus(
  v: unknown,
): v is ExpenseApprovalStatus {
  return (
    typeof v === "string" &&
    (EXPENSE_APPROVAL_STATUSES as readonly string[]).includes(v)
  );
}

/* ═══════════════════ ٤) مصدرُ التمويل (تجميعُ العرض) ═══════════════════ */

/**
 * مصدرُ التمويل كما **تعرضه** الشاشة. ليس تعداداً في المخطّط بل تجميعٌ للعرض فوق
 * `ExpenseFundingKind` الخادميّة، ويفترق عنها في موضعَين مقصودَين:
 *   · `PENDING` **إضافةٌ للعرض**: الطلبُ غير المنفَّذ (PENDING_APPROVAL/REJECTED) لا مصدرَ
 *     تمويلٍ له أصلاً — إدراجُه تحت «مصدرٍ غير محسوم» كان يُظهره عطباً وهو مسارٌ سليم.
 *   · `UNATTRIBUTED` هي `UNKNOWN` الخادميّة بتسميةٍ تقول للموظّف ما العمل.
 * الترتيبُ مقصود: ما لا أثرَ ماليّاً له أوّلاً، ثمّ النقدُ بوعائَيه، ثمّ غيرُ النقد، ثمّ
 * الاستحقاق، ثمّ المخزون، والمعطوبُ آخراً (فلا يتصدّر شاشةً معظمُها سليم).
 */
export const EXPENSE_FUNDING_VIEWS = [
  "PENDING",
  "DRAWER",
  "TREASURY",
  "NON_CASH",
  "ACCRUED_UNPAID",
  "ACCRUED_PAID",
  "STOCK",
  "UNATTRIBUTED",
] as const;

export type ExpenseFundingView = (typeof EXPENSE_FUNDING_VIEWS)[number];

export interface ExpenseFundingMeta {
  /** عنوانُ المجموعة و`aria-label` — بحجمٍ نظاميّ، فالتشكيلُ فيه مأمون. */
  label: string;
  /** نصُّ الشارة والعمود المختصر — **بلا تشكيل** (11-12px). */
  short: string;
  /** توكن الشارة الدلاليّ (لا لونٌ خامّ). */
  badge: string;
}

export const EXPENSE_FUNDING_META: Readonly<
  Record<ExpenseFundingView, ExpenseFundingMeta>
> = Object.freeze({
  PENDING: {
    label: "طلبات اعتماد غير منفذة",
    short: "بلا أثر مالي",
    badge: "badge-status-pending",
  },
  DRAWER: {
    label: "مصروفات الأدراج والورديات",
    short: "درج وردية",
    badge: "badge-status-active",
  },
  TREASURY: {
    label: "مصروفات الخزينة الإدارية",
    short: "خزينة إدارية",
    badge: "badge-status-pending",
  },
  NON_CASH: {
    label: "مصروفات غير نقدية",
    short: "غير نقدي",
    badge: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  },
  ACCRUED_UNPAID: {
    label: "مصروفات مستحقة غير مدفوعة",
    short: "مستحق غير مدفوع",
    badge: "badge-status-pending",
  },
  ACCRUED_PAID: {
    label: "مصروفات مستحقة سُوّيت فعلياً",
    short: "استحقاق مسوى",
    badge: "badge-status-active",
  },
  STOCK: {
    label: "مصروفات من المخزون بالكلفة",
    short: "مخزون",
    badge: "badge-stock-low",
  },
  UNATTRIBUTED: {
    label: "مصروفات تحتاج تحديد مصدر التمويل",
    short: "مصدر غير محسوم",
    badge: "badge-status-cancelled",
  },
});

/**
 * قيمُ `ExpenseFundingKind` الخادميّة (`server/services/expenseService.ts`) — مكتوبةٌ هنا
 * ليُطابقها الاختبارُ بالمصدر الحيّ، فيمسك أيَّ قيمةٍ تُضاف هناك بلا تسميةٍ عندنا.
 */
export const SERVER_EXPENSE_FUNDING_KINDS = [
  "DRAWER",
  "TREASURY",
  "NON_CASH",
  "STOCK",
  "ACCRUED_UNPAID",
  "ACCRUED_PAID",
  "UNKNOWN",
] as const;

/** ترجمةُ قيمة الخادم إلى قيمة العرض — الموضعُ الوحيد الذي يعرف أنّ UNKNOWN ≡ UNATTRIBUTED. */
export function fundingViewOfServerKind(
  kind: string,
): ExpenseFundingView | null {
  if (kind === "UNKNOWN") return "UNATTRIBUTED";
  return (EXPENSE_FUNDING_VIEWS as readonly string[]).includes(kind)
    ? (kind as ExpenseFundingView)
    : null;
}

/* ═════════════════ ٥) تحذيراتُ تدقيق سلامة المصروف ═════════════════ */

/**
 * رموزُ `integrityWarnings` التي يولّدها `expenseService.integrityWarningsOf` — بترتيب
 * ظهورها في الخدمة (نقصُ البيان أوّلاً، ثمّ مطابقةُ الإيصال، ثمّ وعاءُ النقد، ثمّ المخزون،
 * ثمّ الاستحقاق). كلُّ رمزٍ **يُعرَض للموظّف** فلا يجوز أن يبقى إنجليزياً خامّاً.
 */
export const EXPENSE_AUDIT_WARNINGS = [
  "DESCRIPTION_MISSING",
  "PAYEE_MISSING",
  "RECEIPT_MISSING",
  "RECEIPT_DIRECTION_MISMATCH",
  "RECEIPT_AMOUNT_MISMATCH",
  "RECEIPT_BRANCH_MISMATCH",
  "RECEIPT_SHIFT_MISMATCH",
  "RECEIPT_PAYMENT_METHOD_MISMATCH",
  "RECEIPT_CASH_BUCKET_MISMATCH",
  "RECEIPT_CREATOR_MISMATCH",
  "RECEIPT_STATUS_MISMATCH",
  "RECEIPT_NOT_APPROVED",
  "CASH_FUNDING_UNKNOWN",
  "DRAWER_WITHOUT_SHIFT",
  "TREASURY_WITH_SHIFT",
  "NON_CASH_HAS_CASH_BUCKET",
  "STOCK_HAS_RECEIPT",
  "STOCK_HAS_CASH_LOCATION",
  "PENDING_RECEIPT_MISMATCH",
  "REJECTED_RECEIPT_MISMATCH",
  "UNEXECUTED_HAS_CASH_LOCATION",
  "ACCRUAL_PAYMENT_METHOD_MISMATCH",
  "ACCRUAL_HAS_DIRECT_RECEIPT",
  "ACCRUAL_HAS_CASH_LOCATION",
  "ACCRUAL_OBLIGATION_MISSING",
  "ACCRUAL_RECOGNITION_ENTRY_MISSING",
  "ACCRUAL_SETTLEMENT_TRACE_MISSING",
  "UNPAID_ACCRUAL_HAS_SETTLEMENT_EFFECT",
] as const;

export type ExpenseAuditWarning = (typeof EXPENSE_AUDIT_WARNINGS)[number];

/**
 * رسائلُ تدقيقٍ مفهومةٌ للموظّف بدل رموز السلامة الداخلية. تُرسَم رقاقاتٍ بـ`text-[11px]`
 * ⇒ **بلا تشكيل**: «خطأً» و«معلّقاً» و«متناقضاً» كانت تُقرأ مشوَّهةً في هذا الحجم.
 */
export const EXPENSE_AUDIT_WARNING_AR: Readonly<
  Record<ExpenseAuditWarning, string>
> = Object.freeze({
  DESCRIPTION_MISSING: "لا يوجد شرح للعملية",
  PAYEE_MISSING: "المستفيد غير محدد",
  RECEIPT_MISSING: "إيصال الصرف غير مرتبط",
  RECEIPT_DIRECTION_MISMATCH: "اتجاه الإيصال لا يطابق عملية الصرف",
  RECEIPT_AMOUNT_MISMATCH: "مبلغ الإيصال لا يطابق المصروف",
  RECEIPT_BRANCH_MISMATCH: "فرع الإيصال لا يطابق فرع المصروف",
  RECEIPT_SHIFT_MISMATCH: "وردية الإيصال لا تطابق وردية المصروف",
  RECEIPT_PAYMENT_METHOD_MISMATCH: "طريقة دفع الإيصال غير مطابقة",
  RECEIPT_CASH_BUCKET_MISMATCH: "مصدر النقد في الإيصال غير مطابق",
  RECEIPT_CREATOR_MISMATCH: "منشئ الإيصال لا يطابق منشئ المصروف",
  RECEIPT_STATUS_MISMATCH: "حالة الإيصال لا تطابق حالة المصروف",
  RECEIPT_NOT_APPROVED: "إيصال الصرف غير معتمد",
  CASH_FUNDING_UNKNOWN: "مصدر النقد غير محسوم",
  DRAWER_WITHOUT_SHIFT: "صرف درج بلا وردية",
  TREASURY_WITH_SHIFT: "صرف خزينة مرتبط خطأ بوردية",
  NON_CASH_HAS_CASH_BUCKET: "عملية غير نقدية مرتبطة بدرج أو خزينة",
  STOCK_HAS_RECEIPT: "صرف مخزون مرتبط خطأ بإيصال نقدي",
  STOCK_HAS_CASH_LOCATION: "صرف مخزون مرتبط خطأ بدرج أو خزينة",
  PENDING_RECEIPT_MISMATCH: "طلب الاعتماد لا يطابق إيصالا معلقا",
  REJECTED_RECEIPT_MISMATCH: "رفض الطلب لا يطابق حالة الإيصال",
  UNEXECUTED_HAS_CASH_LOCATION: "طلب غير منفذ مرتبط خطأ بمصدر نقد",
  ACCRUAL_PAYMENT_METHOD_MISMATCH:
    "طريقة المصروف المستحق لا تطابق عقد الاستحقاق",
  ACCRUAL_HAS_DIRECT_RECEIPT: "الاعتراف بالاستحقاق مرتبط خطأ بإيصال نقدي مباشر",
  ACCRUAL_HAS_CASH_LOCATION: "الاعتراف بالاستحقاق مرتبط خطأ بدرج أو خزينة",
  ACCRUAL_OBLIGATION_MISSING: "سجل التزام الاستحقاق مفقود",
  ACCRUAL_RECOGNITION_ENTRY_MISSING: "قيد الاعتراف بالاستحقاق مفقود",
  ACCRUAL_SETTLEMENT_TRACE_MISSING: "أثر تسوية الاستحقاق المدفوع غير مكتمل",
  UNPAID_ACCRUAL_HAS_SETTLEMENT_EFFECT:
    "استحقاق غير مدفوع يحمل أثر تسوية متناقضا",
});

export function isExpenseAuditWarning(v: unknown): v is ExpenseAuditWarning {
  return (
    typeof v === "string" &&
    (EXPENSE_AUDIT_WARNINGS as readonly string[]).includes(v)
  );
}

/**
 * الرمزُ المجهول يعود كما هو عمداً: رمزٌ إنجليزيّ ظاهرٌ في الشاشة بلاغٌ عن نقصٍ في هذا
 * القاموس، بينما ابتلاعُه بـ«—» يُخفي **تحذيرَ سلامةٍ ماليّة** عن الموظّف والمالك معاً.
 */
export function expenseAuditWarningLabel(code: string): string {
  return isExpenseAuditWarning(code) ? EXPENSE_AUDIT_WARNING_AR[code] : code;
}
