/**
 * deliveryEventType — مفردات سجلّ أحداث الإرسالية (`deliveryEvents`): **نوع الحدث** و**سلطته**.
 *
 * لماذا وُجد الملفّ (موجة D6، ٢/٩/٢٦): القاموسان كانا مُعرَّفَين **داخل مكوّن واحد**
 * (`client/src/components/delivery/ConsignmentTimelineDrawer.tsx`)، فلا يراهما أحدٌ غيره
 * ولا يحرسهما اختبار. والقياسُ على الشيفرة أظهر أنّهما انحرفا عن الكاتب فعلاً لا نظرياً:
 *   · **ستّةُ مفاتيح ميتة** لا يكتبها أيُّ مسارٍ قطّ (`DISPATCHED` · `CANCELLED` · `REMITTED`
 *     · `WRITTEN_OFF` · `RECOVERED` · `FEE_PAID`) — أربعةٌ منها أسماءُ **قيود الدفتر** لا
 *     أسماءُ أحداث (فخّ «تشابُهِ المفاتيح ليس وحدةَ المفهوم»: `deliveryLedgerEntries.entryType`
 *     جدولٌ آخر بمفهومٍ آخر — انظر `deliveryLedgerEntryType.ts`).
 *   · **ثمانيةُ أنواعٍ حيّة بلا تسمية** ⇒ تُعرَض للموظّف رمزاً إنجليزياً خامّاً على شاشةٍ
 *     عربيّة (`PARCEL_FAILED` · `MONEY_WRITTEN_OFF` · `SUPPLEMENTARY_COLLECTION` …).
 *
 * ⛔ لا شاشة تُعيد تعريف أيٍّ من القاموسَين محلّياً — يحرسه `localizationDictionaries.test.ts`.
 *
 * **العمود `varchar(60)` لا `enum`** ([drizzle/schema.ts] `deliveryEvents.eventType`) ⇒ القاعدة
 * لا تحرس القيمة، وهذا الملفّ هو الحارس الوحيد على مستوى النوع. القائمة أدناه **مشتقّة من
 * كتّابها** لا من التخمين: كلُّ قيمةٍ مُوثَّقٌ بجانبها المسار الذي يكتبها.
 *
 * 📌 متابعةٌ لمالك `server/services/delivery/lifecycle.ts`: تضييق معامل `appendDeliveryEvent`
 *    إلى `DeliveryEventType` يجعل الانحراف يسقط عند `pnpm check` بدل أن يظهر على شاشة —
 *    نفسُ ما فعله `workOrderEventType.ts` مع `recordWorkOrderEvent`.
 *
 * ⛔ بلا تشكيل في التسميات (حارس `check:tashkeel`): خطّ الواجهة تحت 14px يرسم «سُلِّم» كأنّها
 *    «شلَم» و«مُسنَد» كأنّها «فسند». الشرحُ الأدبيّ مكانُه `tooltip` لا الشارة.
 */

/* ══════════════════════ ١) نوع الحدث ══════════════════════ */

export const DELIVERY_EVENT_TYPES = [
  // ── الإسناد وتحويله ──
  /** `dispatch.ts` + `dispatchInvoice.ts` — أوّلُ إسنادٍ للطرد إلى جهة. */
  "ASSIGNED",
  /** `dispatchInvoice.ts` — إسنادٌ ثانٍ لإرساليةٍ قائمة (رجعت ثمّ خرجت من جديد). */
  "ASSIGNMENT_REACTIVATED",
  /** `parties.ts` — الطرد انتقل إلى **جهةٍ أخرى**. */
  "REASSIGNED",
  /** `cancellation.ts` — أُلغي الإسناد قبل خروج الطرد. */
  "ASSIGNMENT_CANCELLED",

  // ── حركة الطرد (تكتبها بوّابة المندوب بقيمة `toStatus`، وجسرُ الموظّف) ──
  "ACCEPTED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  /** `courier.ts` — وصل الزبون وانتقلت المسؤوليّة. */
  "DELIVERED",
  /** بوّابة المندوب / `staffTransition.ts` — حاول فتعذّر. */
  "FAILED",

  // ── الرجوع ──
  /** `returns.ts` — الموظّف سحب الطرد من عهدة السائق (الحالة تصير FAILED). */
  "PARCEL_FAILED",
  /** `declaredReturn.ts` — شركةُ التوصيل أعلنت الرجوع، والطرد لم يُستلَم بعد. */
  "RETURN_DECLARED",
  /** `returns.ts` — استُلم المرتجع وأُغلقت الإرسالية. */
  "RETURNED",

  // ── المال ──
  /** `counterCollection.ts` — الزبون سدّد على الكاونتر لا للمندوب. */
  "COUNTER_SETTLED",
  /** `courier.ts` — تحصيلٌ لاحقٌ ظهر في كشف الشركة بعد تسليمٍ سابق. */
  "SUPPLEMENTARY_COLLECTION",
  /** `remittance.ts` — توريدُ نقدٍ لا يُغلق الطرد (بقي متبقٍّ). */
  "MONEY_PARTIAL",
  /** `remittance.ts` — توريدٌ أغلق مال الطرد. */
  "MONEY_SETTLED",
  /** `settle.ts` — شُطب العجز باعتمادٍ ثانٍ. */
  "MONEY_WRITTEN_OFF",

  // ── النظام ──
  /** `staleSweep.ts` — شاهدُ جمودٍ لا حركة: الطرد تجاوز عتبة الركود بلا تقدّم. */
  "STALE_ESCALATED",
] as const;

export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

/**
 * التسمية العربيّة الرسميّة — تظهر شارةً على كلّ سطرٍ في خطّ زمن الطرد.
 *
 * الصيغة **فعلُ ما حدث** لا اسمُ الحالة: «سلم» حدثٌ وقع في لحظة، بينما «سلم — بانتظار
 * التوريد» في `consignmentView` حالةٌ مستمرّة. المفهومان متجاوران لا مترادفان، ولذلك لا
 * يستوردُ هذا القاموس من `deliveryTerminology` رغم تشابه بعض الألفاظ.
 */
export const DELIVERY_EVENT_LABEL: Readonly<Record<DeliveryEventType, string>> = Object.freeze({
  ASSIGNED: "أسند",
  ASSIGNMENT_REACTIVATED: "أعيد تنشيط الإسناد",
  REASSIGNED: "نقل لجهة أخرى",
  ASSIGNMENT_CANCELLED: "ألغي الإسناد",
  ACCEPTED: "قبل السائق",
  PICKED_UP: "التقط الطرد",
  OUT_FOR_DELIVERY: "خرج للتوصيل",
  DELIVERED: "سلم",
  FAILED: "تعذر التسليم",
  PARCEL_FAILED: "أرجع الطرد من عهدة السائق",
  RETURN_DECLARED: "أعلنت الشركة رجوعه",
  RETURNED: "استلم المرتجع",
  COUNTER_SETTLED: "سدده الزبون بالكاونتر",
  SUPPLEMENTARY_COLLECTION: "تحصيل لاحق بالكشف",
  MONEY_PARTIAL: "توريد جزئي للنقد",
  MONEY_SETTLED: "توريد كامل للنقد",
  MONEY_WRITTEN_OFF: "شطب عجزه",
  STALE_ESCALATED: "متصعد لركوده",
});

export function isDeliveryEventType(v: unknown): v is DeliveryEventType {
  return typeof v === "string" && (DELIVERY_EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * نوعٌ مجهول (صفٌّ قديم أو مسارٌ جديد لم يُسجَّل هنا) ⇒ يُعرَض **خامّاً** لا يُطوى إلى «أخرى»:
 * الرمزُ الإنجليزيّ قبيحٌ لكنّه يقود المطوّر إلى الفجوة، بينما «أخرى» تُخفيها إلى الأبد.
 */
export function deliveryEventLabel(eventType: string | null | undefined): string {
  if (!eventType) return "—";
  return isDeliveryEventType(eventType) ? DELIVERY_EVENT_LABEL[eventType] : eventType;
}

/* ══════════════════════ ٢) سلطة الحدث ══════════════════════ */

/**
 * **من أثبت الحدث** — مفهومٌ مستقلٌّ عن نوعه: الحدثُ نفسُه («سلم») قد يثبت ببوّابة المندوب،
 * أو بكشف الشركة، أو بإثباتٍ يدويٍّ بموافقة مدير. القيمةُ تُكتَب في `payload.source`.
 */
export const DELIVERY_EVENT_SOURCES = [
  /** `courier.ts` — المندوب نفسُه من بوّابته. */
  "COURIER_PORTAL",
  /** `companyStatement.ts` — كشفُ شركة التوصيل المستنديّ. */
  "COMPANY_STATEMENT",
  /** `companyStatement.ts` — موظّفٌ أكّد التسليم على جهةٍ بلا بوّابة. */
  "STAFF_CONFIRMED",
  /** `companyStatement.ts` — إثباتٌ استثنائيّ بموافقة مدير ودليلٍ مكتوب. */
  "MANUAL_PROOF",
  /** `staffTransition.ts` — الموظّف سلّم الطرد بيده للسائق. */
  "STAFF_HANDOVER",
  /** `staffTransition.ts` — قرارُ موظّفٍ على حالة الطرد. */
  "STAFF",
  /** `returns.ts` — الموظّف سحب الطرد راجعاً. */
  "STAFF_RETURN",
  /** `counterCollection.ts` — قبضٌ على كاونتر المكتبة. */
  "COUNTER",
  /**
   * `staleSweep.ts` — الماسحُ الدوريّ.
   * ⚠️ **غيرُ قابلٍ للعرض اليوم**: الكنّاس يكتبها في `payload.authority` لا `payload.source`،
   * والقارئُ الوحيد (درجُ خطّ الزمن) يقرأ `source` وحدها ⇒ شارةُ السلطة تبقى فارغةً على
   * أحداث الركود. تُترَك التسميةُ هنا لأنّ المفهوم قائم؛ توحيدُ اسم الحقل قرارُ مالك
   * `server/services/delivery/staleSweep.ts` لا قرارُ قاموس.
   */
  "SYSTEM_STALE_SWEEP",
] as const;

export type DeliveryEventSource = (typeof DELIVERY_EVENT_SOURCES)[number];

export const DELIVERY_EVENT_SOURCE_LABEL: Readonly<Record<DeliveryEventSource, string>> =
  Object.freeze({
    COURIER_PORTAL: "بوابة المندوب",
    COMPANY_STATEMENT: "كشف الشركة",
    STAFF_CONFIRMED: "تأكيد الموظف",
    MANUAL_PROOF: "إثبات يدوي (بموافقة مدير)",
    STAFF_HANDOVER: "تسليم الموظف للسائق",
    STAFF: "قرار موظف",
    STAFF_RETURN: "إرجاع بقرار موظف",
    COUNTER: "قبض كاونتري",
    SYSTEM_STALE_SWEEP: "الكناس الدوري",
  });

export function isDeliveryEventSource(v: unknown): v is DeliveryEventSource {
  return typeof v === "string" && (DELIVERY_EVENT_SOURCES as readonly string[]).includes(v);
}

/**
 * سلسلةٌ فارغة للفارغ **وللمجهول** معاً — بخلاف تسمية النوع: هذه شارةٌ ثانويّة تُعرَض حين
 * تُعرَف السلطة فقط، وعرضُ رمزٍ خامّ فيها يزاحم الفعلَ نفسَه بلا فائدة. (السلوك مطابقٌ عمداً
 * لما كان في الدرج: `source && SOURCE_AR[source] && …` — الشارةُ تختفي على المجهول.)
 */
export function deliveryEventSourceLabel(source: string | null | undefined): string {
  return isDeliveryEventSource(source) ? DELIVERY_EVENT_SOURCE_LABEL[source] : "";
}
