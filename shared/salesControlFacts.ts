/**
 * حقائقُ حمولة طلب التحكّم بالبيع — **مصدرٌ واحد** تعرضه الشاشتان (ويب وأندرويد).
 *
 * ## لماذا وُجد هذا الملف
 *
 * التدقيقُ الجنائيّ (١/٩/٢٦) وجد أنّ شاشة الاعتماد الويب كانت تعرض «بنود الإرجاع: 4» عدداً
 * مجرَّداً بلا اسم صنفٍ ولا كمّية — «مراجعٌ لا يرى ما يراجعه ليس مراجعاً». ثمّ حين أُضيف
 * اعتمادُ طلبات البيع إلى صندوق موافقات أندرويد، أعادت المراجعةُ العدائيّة (Codex على PR #932)
 * إنتاجَ العطب نفسه من بابٍ آخر: `approvalDetail` كان يُرجع السببَ وإجماليَّ الفاتورة وحدهما،
 * فينفّذ المُعتمِدُ على الجوّال حركةَ نقدٍ ومخزونٍ ودفترٍ **بلا رؤية أيّ رقمٍ ماليّ للطلب**.
 *
 * فالاشتقاقُ هنا لا في شاشة: الويب يعرضه، والخادمُ يُرسله لأندرويد. تعريفٌ واحد لا اثنان
 * ينجرفان — نفس علّة «مصير البضاعة» التي كانت تُعرَض معكوسةً لأنّ الشاشة أعادت تعريفها محلّياً.
 */

/** سطرُ حقيقةٍ معروضٌ للمراجع. */
export interface SalesControlFact {
  label: string;
  value: string;
}

export type SalesControlFactsType =
  | "SALES_RETURN"
  | "SALES_CANCEL"
  | "SALES_REISSUE"
  | "SALES_EXCHANGE"
  | "SALES_DUE_DATE_CHANGE";

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * مصيرُ البضاعة له **مصدران**: `restock` للعميل المسجَّل، و`resolution.disposition` للزبون
 * العابر (الشاشةُ لا ترسل `restock` له إطلاقاً). فحصُ `restock === false` وحده كان يُقيَّم
 * `undefined !== false` ⇒ «سليمة — تعاد للمخزون» **دائماً** لكلّ مرتجعات العابر، حتى حين
 * اختار الطالبُ «تالفة» — وهي الحالةُ الوحيدة التي تُنتج خسارةً حقيقية.
 */
export function deriveDisposition(payload: unknown): "RESTOCK" | "DAMAGED" | "UNKNOWN" {
  const p = asRecord(payload);
  const resolution = asRecord(p.resolution);
  if (p.restock === false || resolution.disposition === "DAMAGED") return "DAMAGED";
  if (p.restock === true || resolution.disposition === "RESTOCK") return "RESTOCK";
  return "UNKNOWN";
}

const DISPOSITION_LABEL: Record<"RESTOCK" | "DAMAGED" | "UNKNOWN", string> = {
  RESTOCK: "سليمة — تعاد للمخزون",
  DAMAGED: "تالفة — لا تعاد للمخزون",
  UNKNOWN: "غير محدَّد",
};

/**
 * يبني حقائقَ الحمولة. `formatMoney` يُمرَّر من المستدعي كي يبقى هذا الملفّ بلا اعتماديّات
 * (الويب يمرّر `fmt`، والخادمُ يمرّر تنسيقاً بسيطاً لأندرويد).
 */
export function salesControlFacts(
  type: SalesControlFactsType,
  payload: unknown,
  formatMoney: (value: string) => string = (value) => value,
): SalesControlFact[] {
  const p = asRecord(payload);
  const lines = Array.isArray(p.lines) ? p.lines : [];

  if (type === "SALES_DUE_DATE_CHANGE") {
    return [{
      label: "تاريخ الاستحقاق المطلوب",
      value: p.dueDate == null ? "إزالة تاريخ الاستحقاق" : String(p.dueDate),
    }];
  }
  if (type === "SALES_CANCEL") {
    return [
      { label: "جهة الاسترداد", value: String(p.refundPaymentMethod ?? "غير محددة") },
      {
        label: "مرجع جهاز الدفع",
        value: p.reference == null || String(p.reference).trim() === ""
          ? "لم يُدخَل بعد — يُدخله أو يؤكّده المُعتمِد"
          : String(p.reference),
      },
    ];
  }
  if (type === "SALES_RETURN") {
    // `refund` للعميل المسجَّل و`resolution` للزبون العابر — أحدهما يحمل المبلغ والطريقة.
    const refund = p.refund && typeof p.refund === "object"
      ? asRecord(p.refund)
      : p.resolution && typeof p.resolution === "object"
        ? asRecord(p.resolution)
        : null;
    const quantity = lines.reduce((sum: number, line: unknown) => {
      const l = asRecord(line);
      return sum + (Number(l.baseQuantity) || 0);
    }, 0);
    return [
      { label: "بنود الإرجاع", value: String(lines.length) },
      { label: "الكمية بالوحدة الأساس", value: String(quantity) },
      { label: "مصير البضاعة", value: DISPOSITION_LABEL[deriveDisposition(payload)] },
      {
        label: "مبلغ الرد",
        value: refund?.amount == null ? "لا يوجد رد فوري" : `${formatMoney(String(refund.amount))} د.ع`,
      },
      { label: "طريقة الرد", value: String(refund?.method ?? "—") },
    ];
  }

  const payment = p.additionalPayment && typeof p.additionalPayment === "object"
    ? asRecord(p.additionalPayment)
    : null;
  return [
    { label: "بنود الفاتورة البديلة", value: String(lines.length) },
    { label: "العميل البديل", value: p.customerId == null ? "كما هو/عابر" : `#${String(p.customerId)}` },
    {
      label: "تحصيل فرق الآن",
      value: payment?.amount == null
        ? "لا يوجد"
        : `${formatMoney(String(payment.amount))} د.ع — ${String(payment.method ?? "")}`,
    },
    {
      label: "معالجة الزيادة",
      value: p.overpayHandling === "CASH_REFUND"
        ? "رد نقدي"
        : p.overpayHandling === "CREDIT" ? "رصيد دائن" : "حسب النتيجة",
    },
  ];
}
