/**
 * ═══ عقدُ منفّذي التعويض — محرّك العكس (ق٧، الموجة م٢) ═══
 *
 * قبل هذه الطبقة كان `reverse()` **سجلَّ مرآةٍ**: يكتب صفَّ REVERSE مقابل كلّ APPLY ولا يمسّ
 * مخزوناً ولا قيداً ولا رصيداً (ملاحظة Codex LC06). هنا يصير العكسُ **منفَّذاً**: لكلّ نوعِ
 * أثرٍ منفّذٌ يُجري التعويضَ الفعليّ (حركة مخزون · قيد · رصيد · ردّ مال · تحرير كوبون …)
 * ثمّ يُعيد مرجعَ صفِّ التعويض الحقيقيّ كي يُسجَّل في صفّ REVERSE.
 *
 * ⭐ **المنفّذ يعمل على دفعةٍ من الآثار من النوع نفسه لا على أثرٍ واحد** — ولذلك سببٌ ماليّ
 * لا تنظيميّ: حركاتُ المخزون تُطبَّق **مجمَّعةً بترتيب `variantId` التصاعديّ** (ترتيبُ الأقفال
 * الحتميّ الذي يمنع deadlock في `sale/create.ts` و`returnService.ts`)، وقيدُ RETURN يُبنى من
 * كلّ البنود معاً لا بنداً بند. المنفّذُ الذي يعمل صفّاً صفّاً كان سيكسر الترتيبَ أو يُنتج قيوداً
 * مجزّأةً لا تطابق ما تعرفه التقارير.
 *
 * ⛔ **لا `ctx` هنا** — الفاعلُ يصل `Actor` (§٥)، والقراراتُ البشريّة (رافدُ الردّ، مصيرُ البضاعة)
 * تصل في `decisions` صريحةً؛ المنفّذ الذي يحتاج قراراً غائباً **يرفض** ولا يُخمّن.
 */
import type Decimal from "decimal.js";

import type { DocumentEffectKind, DocumentType } from "@shared/documentEffects";

import type { Tx } from "../../db";
import type { Actor } from "../tx";

/**
 * أثرُ APPLY **بما بقي منه بلا عكس**: `outstanding* = APPLY + Σ REVERSE children`.
 * الصفرُ في الاثنين معاً يعني أثراً مُغلقاً فلا يصل المنفّذَ أصلاً.
 */
export interface PendingEffect {
  id: number;
  documentType: DocumentType;
  documentId: number;
  effectKind: DocumentEffectKind;
  effectTable: string | null;
  effectRowId: number | null;
  branchId: number | null;
  scope: string | null;
  payloadJson: unknown;
  /** قيمةُ APPLY الأصليّة (موقَّعة). */
  signedAmount: Decimal;
  signedQuantity: number;
  /** ما بقي بلا عكس — موقَّعٌ بإشارة APPLY نفسها (سالبُ المخزون المخصوم يبقى سالباً). */
  outstandingAmount: Decimal;
  outstandingQuantity: number;
}

/**
 * ما فعله المنفّذ فعلاً بأثرٍ واحد.
 *
 *  · `REVERSED`  — عُكس المتبقّي كلُّه؛ يُكتب صفُّ REVERSE بمقدار `signedAmount/Quantity`
 *                  (الافتراض: سالبُ المتبقّي كاملاً).
 *  · `LEFT_OPEN` — لم يُعكَس **بقصدٍ معلن** (مالٌ لم يخرج بعد لأنّ الرافد يمرّ باعتماد):
 *                  لا صفَّ REVERSE، ويُعاد السببُ للمستدعي، ويُستثنى النوعُ من فحص التوازن.
 */
export type ExecutionOutcome =
  | {
      status: "REVERSED";
      /** مرجعُ صفِّ التعويض الحقيقيّ (حركةُ المخزون · القيد · الإيصال …) إن وُجد. */
      effectTable?: string | null;
      effectRowId?: number | null;
      /** ما عُكس فعلاً — الافتراضُ كاملُ المتبقّي معكوسَ الإشارة. */
      signedAmount?: Decimal;
      signedQuantity?: number;
      payloadJson?: unknown;
    }
  | {
      /**
       * عُكس **جزءٌ بقصدٍ معلن** والباقي يبقى مفتوحاً بحكم السياسة المحاسبيّة (مثلاً: مصروفُ
       * هديةِ خدمةٍ استُهلكت لا يُعكَس وإن عادت بقيّة الهدايا). يُكتب صفُّ REVERSE بالجزء
       * المعكوس، ويُستثنى النوعُ من فحص التوازن، ويُعاد السبب للمستدعي.
       */
      status: "PARTIAL";
      why: string;
      effectTable?: string | null;
      effectRowId?: number | null;
      signedAmount: Decimal;
      signedQuantity?: number;
      payloadJson?: unknown;
    }
  | { status: "LEFT_OPEN"; why: string; payloadJson?: unknown };

/** حمولةُ ردّ المال التي يقرّرها البشر ويمرّرها المستدعي — لا تُخمَّن داخل المحرّك. */
export interface RefundDecision {
  /**
   * `NONE` = لا يُردّ شيء الآن: المقبوضُ يبقى **رصيداً دائناً للعميل** (يلزمه عميلٌ مسجَّل) —
   * وهو معنى `refund: null` في المرتجع التاريخيّ. لا يُقبَل لزبونٍ عابر.
   */
  method: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET" | "NONE";
  /**
   * المبلغُ المردود بهذه الطريقة — الافتراضُ كاملُ المتبقّي. الأقلُّ منه يترك الباقي رصيداً
   * دائناً للعميل بأثرٍ مفتوحٍ مُسجَّل (المرتجعُ الجزئيّ الردّ لعميلٍ مسجَّل).
   */
  amount?: Decimal | null;
  /** جملةٌ تُلحَق بوصف إيصال الردّ النقديّ (سببُ مرتجع الزبون العابر). */
  descriptionNote?: string | null;
  /** مرجعُ جهاز الدفع — إلزاميٌّ للبطاقة (إثباتٌ لا إقفال). */
  reference?: string | null;
  /**
   * مصدرُ النقد المقفولُ سلفاً في بداية المعاملة (ترتيبُ الأقفال: المصدر قبل الفاتورة).
   * `null` لغير النقد. الخدمةُ هي التي تقفله لأنّ ترتيبَ الأقفال قرارُها لا قرارُ المنفّذ.
   */
  cashSource?: { shiftId: number | null; cashBucket: "DRAWER" | "TREASURY" } | null;
  /** بصمةُ الطلب — تدخل في مرجع الإيصال المعلَّق كي يبقى فريداً لكلّ محاولة. */
  requestFingerprint?: string | null;
}

/**
 * القراراتُ البشريّة التي تصل المحرّكَ صريحةً. كلُّ حقلٍ اختياريّ: المنفّذ الذي يلزمه حقلٌ
 * غائب يرمي `PRECONDITION_FAILED` بمخرجٍ لا يُكمل صامتاً.
 */
export interface ReversalDecisions {
  /** نكهةُ العمليّة — تقرّر نصوصَ القيود ومفاتيحَ التكرار واستثناءَ الخزينة. */
  flavor?: "CANCEL" | "RETURN";
  /** سببٌ حرٌّ يظهر في نصوص القيود. */
  reasonNote?: string | null;
  /** مصيرُ البضاعة: تعود للرفّ (الافتراض) أم تالفة فلا تعود ولا تُعكَس كلفتها. */
  restock?: boolean;
  refund?: RefundDecision | null;
}

/**
 * سياقُ تشغيلٍ واحد لـ`reverse()` — يعبر كلَّ المنفّذين بالترتيب. `state` ذاكرةٌ مشتركة
 * بينهم (منفّذُ المخزون يترك فيها ما أعاده فعلاً ليقرأه منفّذُ القيد ويحسب الكلفة).
 */
export interface ReversalRun {
  documentType: DocumentType;
  documentId: number;
  reason: string;
  actor: Actor;
  decisions: ReversalDecisions;
  state: Map<string, unknown>;
}

/**
 * المنفّذ: دفعةٌ من آثار النوع نفسه (بترتيب `id` التصاعديّ) ⇒ نتيجةٌ لكلّ أثرٍ **بنفس
 * الترتيب والطول**. طولٌ مختلف = خللٌ برمجيّ يرفضه المحرّك.
 */
export type EffectExecutor = (
  tx: Tx,
  effects: readonly PendingEffect[],
  run: ReversalRun,
) => Promise<ExecutionOutcome[]>;

export type ExecutorRegistry = Partial<Record<DocumentEffectKind, EffectExecutor>>;

/**
 * ترتيبُ تنفيذ الأنواع — ماليٌّ لا اعتباطيّ: المخزون أوّلاً (تُعرف كلفةُ ما عاد)، ثمّ التزامُ
 * الأمانة، ثمّ قيدُ البيع (يحتاج الكلفة)، ثمّ الهدايا والتقريب، ثمّ ردُّ المال (يقرّر ما يُنقَص
 * من المدفوع)، ثمّ الذمّة (تحتاج ما رُدّ فعلاً)، ثمّ الكوبون. ما ليس هنا يُنفَّذ آخراً.
 */
export const EFFECT_KIND_EXECUTION_ORDER: readonly DocumentEffectKind[] = [
  "INVENTORY",
  "CONSIGNMENT",
  "SUPPLIER_BALANCE",
  "LEDGER_ENTRY",
  "GIFT",
  "ROUNDING",
  "PAID_AMOUNT",
  "CUSTOMER_BALANCE",
  "COUPON",
  "DELIVERY_CUSTODY",
  "DEPOSIT",
  "COMMISSION",
  "INSTALLMENT",
  "CARD",
  "OFFLINE",
];

export function executionRank(kind: DocumentEffectKind): number {
  const idx = EFFECT_KIND_EXECUTION_ORDER.indexOf(kind);
  return idx < 0 ? EFFECT_KIND_EXECUTION_ORDER.length : idx;
}
