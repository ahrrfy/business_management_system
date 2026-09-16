/**
 * negativeCashDiagnosis — مفرداتُ **تشخيص الرصيد النقديّ السالب** في وردية الكاشير (٢/٩/٢٦).
 *
 * ═══════════════════════ ما هذا المفهوم ═══════════════════════
 * حين يهبط الرصيد الجاري للدرج تحت الصفر في وردية، فالسالبُ ليس رقماً يُصحَّح بل **سؤالٌ عن
 * دينارٍ خرج**: أدُفِع من الخزينة فعلاً؟ أدفعه الموظّف من جيبه؟ أنقصَ تحويلٌ داخليّ؟ أهو تكرارٌ
 * يلزمه عكس؟ ولكلِّ جوابٍ **أثرٌ ماليٌّ مختلف** (درج/خزينة/ذمّة موظّف/مصروف).
 *
 * ولذلك ثلاثةُ محاورَ لا محورٌ واحد، وهي مجموعةً واحدةً هنا لأنّها **تُقرأ معاً في صفٍّ واحد**:
 *  ١) **التصنيف** — أيُّ جوابٍ يقترحه المحرّك، وأيُّها يختاره المشخِّص للمحاكاة.
 *  ٢) **الثقة** — كم يسند الدليلُ القائم ذلك الاقتراح.
 *  ٣) **الأدلّة الناقصة** — ما الذي يلزم إحضارُه ليصير الاقتراح قراراً.
 * فصلُها في ثلاثة ملفّات يفصل ما لا يُقرأ منفصلاً.
 *
 * ═══════════════════════ مصدرُ المفاتيح ═══════════════════════
 * التعدادات مملوكةٌ للخادم في [`server/services/cashRemediation/types.ts`]
 * (`SuggestedClassification` · `ClassificationConfidence` · `EvidenceMissing`)، وهذا الملفّ
 * **يُسمّيها بالعربية لا غير**. والشاشةُ تربط الاثنين بإسنادٍ مُنمَّط
 * (`Record<SuggestedClassification, string> = …`) ⇒ أيُّ مفتاحٍ يُضاف في الخادم بلا تسميةٍ هنا
 * يُسقط `pnpm check` بدل أن يُنتج خانةً فارغةً في شاشةِ مالٍ.
 *
 * ⛔ **لا يُوحَّد مع قواميس فروق النقد الثلاثة** — تشابهُ الحقل لا يعني وحدة المفهوم:
 *  · [`shared/cashVariance.ts`](./cashVariance.ts) و[`shared/shiftCashGovernance.ts`](./shiftCashGovernance.ts)
 *    يصفان **سببَ فرقٍ عند عدٍّ** (معدودٌ مقابل دفتريّ)، ويُخزَّن كلٌّ منهما حرفياً في عمود
 *    `mysqlEnum` خاصٍّ به. وهذا الملفّ **لا يُخزَّن أصلاً**: مخرجُ محرّك تشخيصٍ للقراءة فقط
 *    (`DRY_RUN_READ_ONLY`) لا يُنشئ إيصالاً ولا قيداً ولا حركة درج.
 *  · و«الثقة» هنا (`HIGH`/`MEDIUM`/`LOW`) **ليست** «الخطورة» في
 *    [`client/src/components/purchases/PurchaseIntegrityPanel.tsx`] (`CRITICAL`/`HIGH`/
 *    `MEDIUM`/`INFO`): تصادفَ مفتاحان نصّاً لا أكثر. الثقةُ تقيس **قوّة الدليل خلف اقتراح**،
 *    والخطورةُ تقيس **أثرَ ملاحظةٍ مؤكَّدة**. توحيدُهما يجعل «متوسط» يعني شيئين في شاشتَي مال.
 */

/**
 * التصنيفُ المقترَح لحركة الصرف. الأربعةُ الأولى **قابلةٌ للاختيار** في المحاكاة
 * (`REMEDIATION_CLASSIFICATIONS` في الخادم)، والبقيّةُ **حالاتٌ مقروءة** يستنتجها المحرّك
 * ولا يُحاكيها المشخِّص: ما ثبت إثباتُه لا يُعاد افتراضُه، وما لم يُحسَم يبقى معلَناً.
 */
export const NEGATIVE_CASH_CLASSIFICATIONS = [
  "TREASURY_PAID",
  "EMPLOYEE_PERSONAL_PAID",
  "MISSING_INTERNAL_TRANSFER",
  "DUPLICATE_OR_ERROR",
  "VERIFIED_INTERNAL_TRANSFER",
  "UNVERIFIED_INTERNAL_TRANSFER",
  "VERIFIED_REVERSAL",
  "UNVERIFIED_REVERSAL",
  "UNRESOLVED",
] as const;

export type NegativeCashClassification =
  (typeof NEGATIVE_CASH_CLASSIFICATIONS)[number];

/** التسميات منقولةٌ حرفياً من قاموس الشاشة الذي حلّت محلّه — بلا تغيير لفظٍ يراه الموظّف. */
export const NEGATIVE_CASH_CLASSIFICATION_LABEL_AR: Readonly<
  Record<NegativeCashClassification, string>
> = Object.freeze({
  TREASURY_PAID: "دفع فعلي من الخزينة",
  EMPLOYEE_PERSONAL_PAID: "دفع شخصي للموظف",
  MISSING_INTERNAL_TRANSFER: "تحويل داخلي مفقود",
  DUPLICATE_OR_ERROR: "تكرار أو خطأ يحتاج عكساً",
  VERIFIED_INTERNAL_TRANSFER: "تحويل داخلي مثبت",
  UNVERIFIED_INTERNAL_TRANSFER: "تحويل داخلي غير مكتمل الإثبات",
  VERIFIED_REVERSAL: "عكس نظامي متصافر",
  UNVERIFIED_REVERSAL: "عكس غير مكتمل الإثبات",
  UNRESOLVED: "غير محسوم",
});

/** قوّةُ الدليل خلف الاقتراح — لا خطورةُ الملاحظة (انظر التحذير في رأس الملفّ). */
export const NEGATIVE_CASH_CONFIDENCE_LEVELS = [
  "HIGH",
  "MEDIUM",
  "LOW",
] as const;

export type NegativeCashConfidence =
  (typeof NEGATIVE_CASH_CONFIDENCE_LEVELS)[number];

export const NEGATIVE_CASH_CONFIDENCE_LABEL_AR: Readonly<
  Record<NegativeCashConfidence, string>
> = Object.freeze({
  HIGH: "عالٍ",
  MEDIUM: "متوسط",
  LOW: "منخفض",
});

/**
 * ما ينقص الصفَّ ليصير الاقتراحُ قراراً. القائمةُ **مغلقة** عمداً: «ناقصٌ» بنصٍّ حرٍّ لا يُنتج
 * تقريرَ «ما الذي يعطّل الحسم غالباً»، والقائمةُ الثابتة تُنتجه.
 */
export const NEGATIVE_CASH_EVIDENCE_KINDS = [
  "SOURCE_DOCUMENT",
  "COUNTERPARTY",
  "PAYMENT_PROOF",
  "LEDGER_ENTRY",
  "EMPLOYEE_DECLARATION",
  "TREASURY_HANDOVER_OR_FUNDING_PROOF",
  "PHYSICAL_CASH_COUNT",
  "CONFIRM_SINGLE_PHYSICAL_PAYMENT",
  "MANAGER_DECISION",
] as const;

export type NegativeCashEvidenceKind =
  (typeof NEGATIVE_CASH_EVIDENCE_KINDS)[number];

export const NEGATIVE_CASH_EVIDENCE_LABEL_AR: Readonly<
  Record<NegativeCashEvidenceKind, string>
> = Object.freeze({
  SOURCE_DOCUMENT: "المستند المصدر",
  COUNTERPARTY: "الطرف",
  PAYMENT_PROOF: "إثبات الدفع/المرفق",
  LEDGER_ENTRY: "القيد المرتبط",
  EMPLOYEE_DECLARATION: "إقرار الموظف",
  TREASURY_HANDOVER_OR_FUNDING_PROOF: "سند خزينة/تحويل",
  PHYSICAL_CASH_COUNT: "محضر عد النقد",
  CONFIRM_SINGLE_PHYSICAL_PAYMENT: "تأكيد دفعة فعلية واحدة",
  MANAGER_DECISION: "اعتماد المدير",
});
