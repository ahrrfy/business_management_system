/**
 * ═══ عقد الأثر المستنديّ (documentEffects) — القانون ق٧ ═══
 *
 * مصدرُ الحقيقة الوحيد **لأنواع الآثار المسجَّلة** ومراحلها. أيُّ مسارٍ ماليٍّ يريد
 * الاندماج مع محرّك العكس الواحد يستعملها؛ لا سلسلةَ حرفيّةً حرّة تُمرَّر إلى قاعدة
 * البيانات.
 *
 * القاعدةُ العليا: يوجد **أثرٌ واحد لكل تأثيرٍ واحد** في المستند (حركة مخزون، قيد،
 * تعديل رصيد ذمّة، …). عند العكس، الطبقة الوحيدة الشرعيّة هي كتابةُ صفٍّ
 * `phase='REVERSE'` يُلغي صفَّ APPLY المقابل عبر `reversalOfEffectId`. مجموعُ
 * `signedAmount` و`signedQuantity` لكلّ (documentType, documentId, effectKind) يجب أن
 * يعود صفراً بعد الاكتمال.
 *
 * ⛔ لا شاشة تُعيد تعريف هذه القوائم محلّياً. الحرفُ العربيّ للعرض؛ الرمزُ الإنجليزيّ للعقد.
 */

export const DOCUMENT_EFFECT_KINDS = [
  "INVENTORY",
  "LEDGER_ENTRY",
  "CUSTOMER_BALANCE",
  "SUPPLIER_BALANCE",
  "DELIVERY_CUSTODY",
  "PAID_AMOUNT",
  "COMMISSION",
  "DEPOSIT",
  "COUPON",
  "GIFT",
  "INSTALLMENT",
  "CARD",
  "CONSIGNMENT",
  "ROUNDING",
  "OFFLINE",
] as const;

export type DocumentEffectKind = (typeof DOCUMENT_EFFECT_KINDS)[number];

export const DOCUMENT_EFFECT_PHASES = ["APPLY", "REVERSE"] as const;
export type DocumentEffectPhase = (typeof DOCUMENT_EFFECT_PHASES)[number];

/** التسميات العربية للعرض (لا للمقارنة). */
export const DOCUMENT_EFFECT_KIND_LABEL_AR: Record<DocumentEffectKind, string> = {
  INVENTORY: "مخزون",
  LEDGER_ENTRY: "قيد محاسبيّ",
  CUSTOMER_BALANCE: "رصيد عميل",
  SUPPLIER_BALANCE: "رصيد مورّد",
  DELIVERY_CUSTODY: "عهدة جهة توصيل",
  PAID_AMOUNT: "مدفوع",
  COMMISSION: "عمولة",
  DEPOSIT: "عربون",
  COUPON: "كوبون",
  GIFT: "هدية",
  INSTALLMENT: "قسط",
  CARD: "بطاقة رقميّة",
  CONSIGNMENT: "أمانة",
  ROUNDING: "تقريب",
  OFFLINE: "أوفلاين",
};

export const DOCUMENT_EFFECT_PHASE_LABEL_AR: Record<DocumentEffectPhase, string> = {
  APPLY: "تطبيق",
  REVERSE: "عكس",
};

/**
 * أنواعُ المستندات المدعومة (تنمو تدريجياً كلّما اندمج مسارٌ إضافيّ). لا CHECK على قاعدة
 * البيانات كي يبقى مسار الاندماج تدريجياً بلا هجرةٍ لكلّ مستند جديد.
 */
export const DOCUMENT_TYPES = [
  "INVOICE",
  "PURCHASE_ORDER",
  "DIGITAL_SALE",
  "VOUCHER",
  "WORK_ORDER",
  "ONLINE_ORDER",
  "STOCK_ADJUSTMENT",
  "DELIVERY_CONSIGNMENT",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * نطاقُ العكس. حقلان اختياريان يضيّقان الانتقاء:
 *   - `effectKinds` (في وضع `ONLY`): يقصر العكسَ على أنواعِ آثارٍ محدَّدة. **قائمةٌ فارغة
 *     في `ONLY` تعني «صفر انتقاء» لا «الكلّ»** — مطابقةٌ لقصد المستدعي الصريح (كأنّه
 *     صفّى الأنواع ديناميكياً فلم يبقَ شيء)؛ توسيعُها إلى ALL كان يُنتج **عكساً ماليّاً كاملاً
 *     صامتاً** أمسكه Codex في PR #957. راجع التعليقَ في `reversalEngine.loadPendingApplyEffects`.
 *   - `operationScopes` (في الوضعَين): يقصر العكسَ على صفوفٍ سُجِّلت بـ`scope` من هذه
 *     القائمة. الغيابُ = بلا قيدٍ (كلّ الآثار الملحقة بالمستند). ضروريٌّ لأنّ `cancel`
 *     و`returnService` يكتبان تحت **نفس هويّة `(INVOICE, id, INVENTORY)`** بسلاسل `scope`
 *     مختلفة («cancel» و«return») — بلا هذا القيد، عكسُ الإلغاء يعكس المرتجعاتِ السابقةَ
 *     أيضاً (Codex #957).
 */
export type ReversalScope =
  | { kind: "ALL"; operationScopes?: readonly string[] }
  | {
      kind: "ONLY";
      effectKinds: readonly DocumentEffectKind[];
      operationScopes?: readonly string[];
    };

/** الشكلُ المسطَّح لصفّ `documentEffects` كما يُدخَل/يُقرأ. */
export interface DocumentEffectRecord {
  id?: number;
  documentType: DocumentType;
  documentId: number;
  effectKind: DocumentEffectKind;
  phase: DocumentEffectPhase;
  effectTable: string | null;
  effectRowId: number | null;
  /** موقَّع: موجب = زيادة الرصيد، سالب = نقصانه. مساقٌ إلى دقّة العملة عند الكتابة. */
  signedAmount: string;
  /** موقَّع لحركات المخزون (وحدة الأساس). */
  signedQuantity: number;
  branchId: number | null;
  actorUserId: number | null;
  reversalOfEffectId: number | null;
  reason: string | null;
  scope: string | null;
  payloadJson: unknown | null;
}
