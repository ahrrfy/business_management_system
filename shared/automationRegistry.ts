/**
 * **سجلّ الأتمتة** — «الأتمتة أوّلاً» (§٣ من برنامج v2 «السهل الممتنع»).
 *
 * ## القانون الحاكم
 * > كل خطوةٍ يملك النظام دليلها ويستطيع تنفيذها بأمان: **يُنفّذها ويُسجّلها ويُبلِغ بعدها**
 * > — ولا يعرضها كزرّ. والخطوة اليدوية = **قرارٌ بشريٌّ حقيقيّ فقط**.
 *
 * ## لماذا سجلٌّ تصريحيّ لا تعليقٌ في الخدمة
 * الزرُّ الزائد لا يُكلّف شاشةً واحدة: يُكلّف **قراراً يوميّاً** على موظّفٍ لا يملك ما يقرّره به.
 * وهو لا يظهر في أيّ فحصٍ ولا اختبار — الخدمةُ تعمل، والشاشة تعرض، والموظّف وحده يدفع الثمن.
 * فالعلاجُ أن تُجبَر كلّ خطوةٍ على **إعلان طبيعتها** في موضعٍ واحدٍ يُقرأ ويُحرَس:
 *   · `AUTO`   ⇐ يلزمه `evidence` **يُسمّي مصدر الدليل** (حقلٌ أو حدثٌ أو مستند). لا «واضح».
 *   · `MANUAL` ⇐ يلزمه `because` **يكتب الحكم البشريّ المُتَّخذ هنا**. «يدويّ لأنّه يدويّ» مرفوض.
 *
 * ## الحالات تُقرأ ولا تُخترَع
 * المفاتيح مُركَّبةٌ من قاموسَي الحالة القائمَين وحدهما — [`workOrderStatus.ts`](./workOrderStatus.ts)
 * و[`invoiceStatus.ts`](./invoiceStatus.ts) — والنوع `KnownTransitionKey` **يمنع** حالةً مخترَعة
 * أو خطأً إملائياً زمنَ الترجمة، قبل أن يصل الأمر إلى الحارس.
 *
 * ## ⛔ ما لا يدّعيه هذا الملفّ
 * ليس مُحرّكَ حالاتٍ ولا بوّابةَ تفويض: **لا ينفّذ انتقالاً ولا يمنعه**. الإنفاذُ يبقى حيث هو
 * (`server/services/**` داخل `withTx`، وحرّاس `server/trpc.ts`). هذا **إعلانُ نيّة** يُقرأ
 * عند بناء الشاشة وعند مراجعتها: ما كان `AUTO` لا يُرسَم له زرّ.
 *
 * ⚠️ وتغطيتُه اليوم **نوعان فقط** (أمر الشغل وفاتورة البيع). بقيّةُ الكيانات غير مُسجَّلة —
 * وغيابُ مفتاحٍ هنا يعني «لم يُسأل بعد» لا «يدويّ بقرار».
 */

import { WORK_ORDER_STATUSES, type WorkOrderStatus } from "./workOrderStatus";
import { INVOICE_STATUSES, type InvoiceStatus } from "./invoiceStatus";

/**
 * طبيعةُ الانتقال.
 *  · `AUTO.evidence`   — الدليل الذي يكفي للتنفيذ الذاتيّ، **مُسمّىً** لا مبهماً.
 *  · `MANUAL.because`  — ⭐ مبرّرُ الحكم البشريّ، **إلزاميّ**.
 */
export type AutomationMode =
  | { kind: "AUTO"; evidence: string }
  | { kind: "MANUAL"; because: string };

/** مثال: `"workOrder:IN_PROGRESS->DELIVERED"`. */
export type TransitionKey = `${string}:${string}->${string}`;

/** الكيانات المُغطّاة اليوم. إضافةُ كيانٍ ثالثٍ تلزمها إضافةُ قاموسه هنا وفي الحارس معاً. */
export const AUTOMATION_ENTITIES = ["workOrder", "invoice"] as const;
export type AutomationEntity = (typeof AUTOMATION_ENTITIES)[number];

export type WorkOrderTransitionKey = `workOrder:${WorkOrderStatus}->${WorkOrderStatus}`;
export type InvoiceTransitionKey = `invoice:${InvoiceStatus}->${InvoiceStatus}`;
/** ⭐ الاتحادُ الضيّق: كلّ طرفٍ من قاموسه. مفتاحٌ خارجه = خطأُ ترجمة، لا اكتشافٌ متأخّر. */
export type KnownTransitionKey = WorkOrderTransitionKey | InvoiceTransitionKey;

/**
 * الحدّ الأدنى لطول التبرير. ليس مقياسَ جودة — **مقياسُ وجود**: يمنع `because: "يدويّ"`.
 * ⛔ ولا يدّعي أكثر: أنّ التبرير ليس إعادةَ صياغةٍ للاسم حكمٌ لا يقيسه عدّادُ محارف
 * ولا حارس — يقيسه قارئُ المراجعة وحده.
 */
export const MIN_JUSTIFICATION_LENGTH = 20;

/**
 * ## السجلّ
 *
 * كلّ مفتاحٍ هنا **انتقالٌ يقع فعلاً في الشيفرة اليوم** — لا جدولُ إمكاناتٍ نظريّ. مصدرُ كلٍّ
 * منها مذكورٌ في تبريره. والانتقالُ الذي لا يقع لا يُسجَّل: سجلٌّ يعِد بما لا يحدث يُقرأ
 * فيُبنى عليه فيَكذب.
 */
export const AUTOMATION_REGISTRY: Record<TransitionKey, AutomationMode> = {
  // ───────────────────────── أمر الشغل (workOrders.status) ─────────────────────────
  // المسارُ الأماميّ الثلاثيّ — هو نفسه `WO_NEXT_STATUS` في `workOrderStatus.ts`.

  "workOrder:RECEIVED->IN_PROGRESS": {
    kind: "MANUAL",
    because:
      "بدءُ التنفيذ يخصم الخامات من المخزن فعلياً، ولا يملك النظام ما يُثبت أنّ الفنّيّ وضع المادة في الماكينة — إعلانُه هو الدليل الوحيد، وخصمٌ قبل الوضع يُنتج عجزاً كاذباً في الجرد.",
  },
  "workOrder:IN_PROGRESS->READY": {
    kind: "MANUAL",
    because:
      "الحكمُ بأنّ المطبوع مطابقٌ للتصميم وسليمُ الألوان والقصّ والتجليد يحتاج معاينةً بصريّةً للمنتَج — لا حقلَ في النظام يحمل جودةَ ورقةٍ خرجت من الماكينة.",
  },
  "workOrder:READY->DELIVERED": {
    kind: "MANUAL",
    because:
      "التسليمُ مناولةٌ ماديّةٌ تُصدِر الفاتورة وتُنشئ الذمّة؛ وحضورُ المستلِم وهويّتُه وأحقّيّتُه بالاستلام وقائعُ خارج النظام لا أثرَ لها فيه قبل إقرار الموظّف.",
  },

  // إعادةُ العمل بعد تصميمٍ أحدث — الأتمتة الوحيدة في هذا الكيان.
  "workOrder:READY->IN_PROGRESS": {
    kind: "AUTO",
    evidence:
      "نسخةُ تصميمٍ أحدث محفوظة على الأمر: `workOrder.setDesign` يُنشئ مراجعةً بـ`revision` أعلى ويُحدّث `customizationText` (server/services/workOrder/design.ts) ⇒ المنتَجُ الجاهز لم يعد يطابق المعتمَد، فيعود قيد التنفيذ بحالةٍ داخليّة BLOCKED.",
  },

  // الإلغاء — مسارُ `workOrders.cancel` بسببٍ إلزاميّ (server/services/workOrder/cancel.ts).
  "workOrder:RECEIVED->CANCELLED": {
    kind: "MANUAL",
    because:
      "السببُ يُميّز تراجُعَ الزبون من خطأ موظّف الاستقبال، والتمييزُ يحدّد وجهةَ ردّ العربون وهل يتحمّل المحلّ فرقاً — قرارٌ لا يشتقّه أيّ حقلٍ على الأمر.",
  },
  "workOrder:IN_PROGRESS->CANCELLED": {
    kind: "MANUAL",
    because:
      "الإلغاءُ أثناء التنفيذ يقتضي تقديرَ ما استُهلك فعلاً من الخامات وما يُهدَر منها، وهو تقديرٌ يحتاج معاينةَ ما على الماكينة — والإقرارُ التصريحيّ به هو ما يُقيَّد هدراً.",
  },
  "workOrder:READY->CANCELLED": {
    kind: "MANUAL",
    because:
      "المنتَجُ جاهزٌ على الرفّ: قرارُ إتلافه أو حفظِه لطلبٍ مشابه أو إعادةِ تدوير مادّته حكمٌ تشغيليّ يوازن كلفةً بفرصة — لا يشتقّه حقلٌ ولا مضيُّ وقت.",
  },
  "workOrder:DELIVERED->CANCELLED": {
    kind: "MANUAL",
    because:
      "عكسُ تسليمٍ وقع فعلاً يقتضي إقرارَ مراجعٍ مستقلٍّ بواقعتين ماديّتين: أنّ البضاعة رجعت، وأنّ ردّ المال مستحقّ ومقدارُه — والنظام لا يرى شيئاً منهما.",
  },
  "workOrder:DELIVERED->READY": {
    kind: "MANUAL",
    because:
      "إعادةُ الفتح تدّعي أنّ المنتَج ما زال صالحاً للتسليم ثانيةً بعد رجوعه من عند الزبون — ادّعاءٌ يلزمه فحصُ حالته المادّيّة، وخطؤه يبيع تالفاً لزبونٍ ثانٍ.",
  },

  // ─────────────────────── فاتورة البيع (invoices.status) ───────────────────────
  // ⭐ محورُ المال كلُّه `AUTO`: `computeInvoiceStatus` (server/services/ledgerService.ts)
  // يُعيد اشتقاق الحالة من الأرقام عند كلّ إيصالٍ أو تخصيصِ سندٍ أو ردّ. زرُّ «حدّث الحالة»
  // هنا ليس تسهيلاً بل بابُ انحراف: يسمح بحالةٍ تخالف رصيدَها.

  "invoice:PENDING->PARTIALLY_PAID": {
    kind: "AUTO",
    evidence:
      "`invoices.paidAmount` صار موجباً وأقلَّ من الصافي (`total − returnedTotal`) — يُعيد `computeInvoiceStatus` اشتقاقَ الحالة داخل معاملة القبض (server/services/sale/payment.ts و voucher/invoiceAllocation.ts).",
  },
  "invoice:PENDING->PAID": {
    kind: "AUTO",
    evidence:
      "`invoices.paidAmount` بلغ الصافي (`total − returnedTotal`) أو تجاوزه في قبضةٍ واحدة — نفسُ اشتقاق `computeInvoiceStatus` داخل معاملة القبض.",
  },
  "invoice:PARTIALLY_PAID->PAID": {
    kind: "AUTO",
    evidence:
      "قبضةٌ لاحقة رفعت `invoices.paidAmount` إلى الصافي — `computeInvoiceStatus` تُقفل الفاتورة، و`voucher/invoiceAllocation.ts` هو الكاتبُ الوحيد لـ`paidAmount` من مسار السندات تحت قفل `FOR UPDATE`.",
  },
  "invoice:PAID->PARTIALLY_PAID": {
    kind: "AUTO",
    evidence:
      "ردٌّ أو عكسُ تخصيصٍ أنقص `invoices.paidAmount` دون تصفيره بينما بقي صافٍ مستحقّ — إعادةُ اشتقاق `computeInvoiceStatus` بعد الإنقاص (returnService.ts / invoiceAllocation.ts).",
  },
  "invoice:PARTIALLY_PAID->PENDING": {
    kind: "AUTO",
    evidence:
      "ردُّ ما قُبض بالكامل صفّر `invoices.paidAmount` مع بقاء صافٍ مستحقّ — `computeInvoiceStatus` تُرجع PENDING حين `paid ≤ 0` والصافي موجب.",
  },
  "invoice:PAID->PENDING": {
    kind: "AUTO",
    evidence:
      "عكسُ سندِ القبض المخصَّص أعاد `invoices.paidAmount` إلى صفر بينما الصافي ما زال موجباً — نفسُ اشتقاق `computeInvoiceStatus`؛ والإنقاصُ لا تحجبه حالةٌ أبداً (مالٌ خرج له مسارُ رجوع).",
  },

  // المرتجع الكامل — الحالةُ نتيجةٌ حسابيّة لمستندٍ اعتمده بشرٌ، لا قراراً ثانياً.
  "invoice:PENDING->RETURNED": {
    kind: "AUTO",
    evidence:
      "مستندُ المرتجع بلغ بـ`invoices.returnedTotal` قيمةَ `total` كاملةً (`fullyReturned` في server/services/returnService.ts) — البضاعةُ رجعت كلُّها بمستندٍ مُعتمَد.",
  },
  "invoice:PARTIALLY_PAID->RETURNED": {
    kind: "AUTO",
    evidence:
      "نفسُ دليل `fullyReturned` في returnService.ts؛ وما قُبض جزئياً يُردّ أو يُرحَّل إلى الذمّة في المعاملة نفسها قبل ضبط الحالة.",
  },
  "invoice:PAID->RETURNED": {
    kind: "AUTO",
    evidence:
      "`fullyReturned` في returnService.ts، أو عكسُ تسليم أمر شغلٍ مُعتمَد (server/services/workOrder/reverseDelivery.ts) الذي يضبط RETURNED ويُسوّي `paidAmount` في المعاملة نفسها.",
  },

  // الإبطال — القرار البشريّ الوحيد على الفاتورة.
  "invoice:PENDING->CANCELLED": {
    kind: "MANUAL",
    because:
      "الإلغاءُ حكمٌ على واقعةٍ خارج النظام: هل تراجع الزبون أم أُخطئ في تحرير المستند؟ لا أثرَ في البيانات يُميّزهما، والتمييزُ يحدّد من يتحمّل الكلفة وكيف يُبلَّغ الزبون.",
  },
  "invoice:PARTIALLY_PAID->CANCELLED": {
    kind: "MANUAL",
    because:
      "فوق حكمِ الإلغاء نفسِه، يلزم قرارُ مصير ما قُبض: يُردّ نقداً أم يبقى رصيداً للزبون أم يُطفأ بذمّةٍ أخرى — ثلاثةُ مساراتٍ ماليّة مختلفة لا يختار بينها حقل.",
  },
  "invoice:PAID->CANCELLED": {
    kind: "MANUAL",
    because:
      "إلغاءُ فاتورةٍ مقبوضةٍ بالكامل يُخرج مالاً من الدرج فعلياً، فيلزمه إقرارُ مراجعٍ بأنّ البضاعة رجعت وأنّ الردّ مستحقّ — وهو فصلُ مهامٍ مقصود لا حاشيةٌ إجرائية.",
  },

  // الاستبدال بفاتورةٍ مصحَّحة — البديلةُ نفسُها هي الدليل.
  "invoice:PENDING->SUPERSEDED": {
    kind: "AUTO",
    evidence:
      "الفاتورةُ البديلة صدرت: `sale/correct.ts` يكتب `invoices.correctedByInvoiceId` على الأصل داخل المعاملة نفسها ⇒ الالتزامُ انتقل إلى مستندٍ آخر يُحتسب بذاته.",
  },
  "invoice:PARTIALLY_PAID->SUPERSEDED": {
    kind: "AUTO",
    evidence:
      "نفسُ دليل `correctedByInvoiceId` في sale/correct.ts؛ ويُصفّر الأصلَ بـ`paidAmount = 0` و`returnedTotal = 0` وينقل المقبوض إلى البديلة في المعاملة نفسها.",
  },
  "invoice:PAID->SUPERSEDED": {
    kind: "AUTO",
    evidence:
      "نفسُ دليل `correctedByInvoiceId` في sale/correct.ts — والأصلُ يخرج من الإيراد بـ`VOIDED_INVOICE_STATUSES` فلا يُحتسب البيعُ مرّتين.",
  },
} satisfies Partial<Record<KnownTransitionKey, AutomationMode>>;

/**
 * حالاتٌ في الـenum بلا انتقالٍ مُسجَّل — **يلزمها تبريرٌ كتبريرِ `MANUAL`**، وإلّا صارت
 * الحالةُ غير المُغطّاة تمرّ بالصمت وهو بالضبط ما بُني السجلّ ليمنعه.
 */
export const STATES_WITHOUT_TRANSITIONS: Partial<
  Record<`workOrder:${WorkOrderStatus}` | `invoice:${InvoiceStatus}`, string>
> = {
  "invoice:CONFIRMED":
    "قيمةٌ باقيةٌ في الـenum لا يكتبها أيّ مسارِ بيعٍ اليوم: حالةُ الفاتورة مشتقّةٌ من المال وحده (PENDING/PARTIALLY_PAID/PAID) أو من إبطالٍ موثَّق. وُصفت في Invoices.tsx بـ«رمزٌ ميت»، وتبقى في INVOICE_STATUS_AR كي لا يتسرّب رمزٌ إنجليزيّ لو ظهرت في بياناتٍ قديمة.",
};

/** يُفكّك المفتاح إلى أطرافه، أو `null` إن لم يكن على الشكل `كيان:من->إلى`. */
export function parseTransitionKey(
  key: string,
): { entity: string; from: string; to: string } | null {
  const m = /^([A-Za-z][A-Za-z0-9]*):([A-Z][A-Z0-9_]*)->([A-Z][A-Z0-9_]*)$/.exec(key);
  if (!m) return null;
  return { entity: m[1], from: m[2], to: m[3] };
}

/** طبيعةُ الانتقال، أو `undefined` إن لم يُسجَّل بعد (غيابٌ ≠ «يدويّ بقرار»). */
export function automationOf(key: TransitionKey): AutomationMode | undefined {
  return AUTOMATION_REGISTRY[key];
}

/**
 * المفاتيحُ اليدوية بلا مبرّرٍ كافٍ (فارغٌ أو أقصرُ من `MIN_JUSTIFICATION_LENGTH`).
 * تُرجع `[]` في الشيفرة السليمة — والنوعُ وحده لا يكفي: `because: ""` يمرّ بـTypeScript.
 */
export function manualTransitionsWithoutJustification(): TransitionKey[] {
  const out: TransitionKey[] = [];
  for (const [key, mode] of Object.entries(AUTOMATION_REGISTRY) as [
    TransitionKey,
    AutomationMode,
  ][]) {
    if (mode.kind !== "MANUAL") continue;
    if (mode.because.trim().length < MIN_JUSTIFICATION_LENGTH) out.push(key);
  }
  return out;
}

/** المفاتيحُ الآلية بلا دليلٍ مُسمّى — النظيرُ الآخر للفحص السابق. */
export function autoTransitionsWithoutEvidence(): TransitionKey[] {
  const out: TransitionKey[] = [];
  for (const [key, mode] of Object.entries(AUTOMATION_REGISTRY) as [
    TransitionKey,
    AutomationMode,
  ][]) {
    if (mode.kind !== "AUTO") continue;
    if (mode.evidence.trim().length < MIN_JUSTIFICATION_LENGTH) out.push(key);
  }
  return out;
}

/** كلّ حالات كيانٍ مُغطّى — يقرؤها الاختبار من القاموسَين لا من قائمةٍ مكتوبةٍ بيد. */
export const ENTITY_STATUSES: Record<AutomationEntity, readonly string[]> = {
  workOrder: WORK_ORDER_STATUSES,
  invoice: INVOICE_STATUSES,
};

/** حالاتُ الكيان التي لا يذكرها أيُّ مفتاحٍ (طرفاً أوّلَ أو ثانياً) ولا مُبرَّرٌ غيابُها. */
export function statesWithoutCoverage(): string[] {
  const seen = new Set<string>();
  for (const key of Object.keys(AUTOMATION_REGISTRY)) {
    const parsed = parseTransitionKey(key);
    if (!parsed) continue;
    seen.add(`${parsed.entity}:${parsed.from}`);
    seen.add(`${parsed.entity}:${parsed.to}`);
  }
  const out: string[] = [];
  for (const entity of AUTOMATION_ENTITIES) {
    for (const status of ENTITY_STATUSES[entity]) {
      const id = `${entity}:${status}`;
      if (seen.has(id)) continue;
      const excuse =
        STATES_WITHOUT_TRANSITIONS[id as keyof typeof STATES_WITHOUT_TRANSITIONS];
      if (excuse != null && excuse.trim().length >= MIN_JUSTIFICATION_LENGTH) continue;
      out.push(id);
    }
  }
  return out;
}
