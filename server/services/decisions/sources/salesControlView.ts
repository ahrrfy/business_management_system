/**
 * عرضُ طلب ضبط البيع في الصندوق — **دوالّ نقيّة** (بلا قاعدة، بلا `Date.now()`) تُختبَر بلا قاعدة
 * (`vitest.unit.config.ts`). المصدرُ `sales.ts` يقرأ ما يلزم ثمّ يستدعيها.
 *
 * ## العلّتان المقيستان (Codex على #1004)
 *
 * ١) **المبلغُ المعروض كان إجماليَّ الفاتورة كاملاً** أيّاً كان نوعُ الطلب وحمولتُه: مرتجعٌ جزئيّ
 *    بـ10,000 على فاتورة 100,000 يُعرَض قراراً بـ100,000، وإلغاءُ فاتورةٍ غير مقبوضة يُعرَض إجمالياً
 *    لا يخرج منه دينار. `salesControlAffectedAmount` يشتقّ **ما يمسّه القرار فعلاً** من الحمولة
 *    والمقبوض الحاليّ — بـ`decimal.js` لا `Number()`.
 *
 * ٢) **زرُّ اعتمادٍ نشطٌ يفشل عند التنفيذ**: `salesControl.approve` الأصليّ يقبل `cashRouting`
 *    (مرجعُ جهاز البطاقة لحظةَ الاعتماد، أو درجٌ مفتوحٌ بديلٌ عن درجٍ أُقفل بعد الطلب) والصندوقُ
 *    يمرّر `null`. `salesControlInlineBlock` يقول متى يكون التنفيذُ بلا ذلك التوجيه **فاشلاً حتماً**
 *    فيُوسَم الصفُّ محجوباً بسببه ورابطِ الشاشة الكاملة — لا زرَّ اعتمادٍ يكذب. ويُنفَّذ الحجبُ
 *    خادمياً عند الحسم أيضاً لا في الشاشة وحدها.
 */
import Decimal from "decimal.js";
import { invoiceRemaining } from "@shared/predicates";

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function dec(v: unknown): Decimal {
  if (v === null || v === undefined || v === "") return new Decimal(0);
  try {
    const d = new Decimal(typeof v === "number" ? v : String(v).trim());
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

const fix2 = (d: Decimal): string => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** بندُ الفاتورة كما يلزم اشتقاقُ قيمة المرتجع: الإجماليّ والكمّية بالوحدة الأساس. */
export interface SalesControlItemView {
  id: number;
  total: string | number | null | undefined;
  baseQuantity: number;
}

export interface SalesControlInvoiceView {
  total: string | number | null | undefined;
  paidAmount: string | number | null | undefined;
  returnedTotal?: string | number | null | undefined;
}

export interface SalesControlAffectedAmount {
  /** نصٌّ عشريّ بمنزلتين، أو `null` حين لا مبلغَ يُشتقّ بصدق. */
  amount: string | null;
  /** ما يعنيه الرقم — يُعرَض بنداً في `summaryItems` كي لا يُقرأ إجماليّاً. */
  label: string;
}

/** مرجعُ الردّ في حمولة المرتجع: `refund` للعميل المسجَّل و`resolution` للزبون العابر. */
function returnRefundOf(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload.refund && typeof payload.refund === "object") return asRecord(payload.refund);
  if (payload.resolution && typeof payload.resolution === "object") return asRecord(payload.resolution);
  return null;
}

/**
 * المبلغُ الذي يمسّه القرار فعلاً.
 *
 *  · مرتجع: مبلغُ الردّ الفوريّ إن وُجد، وإلّا قيمةُ البنود المرتجعة (حصّةُ الكمّية من إجماليّ
 *    البند — الصيغةُ نفسها في `returnSaleInTx`) تُقيَّد لحساب العميل.
 *  · إلغاء: **المقبوضُ القابل للردّ** (إيصالاتُ القبض المُتحقّقة − ما رُدّ منها) — صفرٌ لفاتورةٍ
 *    غير مقبوضة، لا إجماليّها.
 *  · إعادة إصدار/استبدال: الدفعةُ الإضافية التي تُحصَّل الآن إن وُجدت، وإلّا المقبوضُ الذي يُعاد
 *    تخصيصه على الفاتورة البديلة.
 *  · تغيير الاستحقاق: المتبقّي الذي يتغيّر استحقاقه.
 */
export function salesControlAffectedAmount(args: {
  requestType: string;
  payload: unknown;
  invoice: SalesControlInvoiceView | null | undefined;
  items: SalesControlItemView[];
  /** المقبوضُ القابل للردّ من الإيصالات (IN − OUT المُتحقّقة) — يحسبه المصدر. */
  refundable: string | number | null | undefined;
}): SalesControlAffectedAmount {
  const payload = asRecord(args.payload);
  const refundable = dec(args.refundable);
  switch (args.requestType) {
    case "SALES_RETURN": {
      const refund = returnRefundOf(payload);
      if (refund && refund.amount != null && refund.amount !== "") {
        return { amount: fix2(dec(refund.amount)), label: "مبلغ الرد الفوري" };
      }
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      const byId = new Map(args.items.map((i) => [Number(i.id), i]));
      let value = new Decimal(0);
      let matched = 0;
      for (const raw of lines) {
        const line = asRecord(raw);
        const item = byId.get(Number(line.invoiceItemId));
        const qty = Number(line.baseQuantity);
        if (!item || !Number.isFinite(qty) || qty <= 0 || !(item.baseQuantity > 0)) continue;
        matched += 1;
        value = value.plus(dec(item.total).times(new Decimal(qty).dividedBy(item.baseQuantity)));
      }
      if (!matched) return { amount: null, label: "قيمة البنود المرتجعة غير محدَّدة — البنود لا تطابق الفاتورة" };
      return { amount: fix2(value), label: "قيمة البنود المرتجعة (تُقيَّد لحساب العميل)" };
    }
    case "SALES_CANCEL":
      return refundable.gt(0)
        ? { amount: fix2(refundable), label: "المقبوض القابل للرد عند الالغاء" }
        : { amount: "0.00", label: "فاتورة غير مقبوضة — لا مال يخرج عند الالغاء" };
    case "SALES_REISSUE":
    case "SALES_EXCHANGE": {
      const payment = payload.additionalPayment && typeof payload.additionalPayment === "object" ? asRecord(payload.additionalPayment) : null;
      if (payment && payment.amount != null && payment.amount !== "" && dec(payment.amount).gt(0)) {
        return { amount: fix2(dec(payment.amount)), label: "دفعة اضافية تُحصَّل الآن" };
      }
      return refundable.gt(0)
        ? { amount: fix2(refundable), label: "المقبوض الذي يُعاد تخصيصه على الفاتورة البديلة" }
        : { amount: "0.00", label: "لا مقبوض يُعاد تخصيصه" };
    }
    case "SALES_DUE_DATE_CHANGE": {
      if (!args.invoice) return { amount: null, label: "المتبقي غير محدَّد" };
      const remaining = invoiceRemaining(args.invoice);
      return { amount: fix2(remaining.lt(0) ? new Decimal(0) : remaining), label: "المتبقي الذي يتغير استحقاقه" };
    }
    default:
      return { amount: null, label: "نوع طلب غير معروف" };
  }
}

/** معرّفاتُ الدرج التي تحملها حمولةُ المرتجع — يقرؤها المصدر ليعرف أيُّها ما زال مفتوحاً. */
export function salesControlShiftIds(payload: unknown): number[] {
  const p = asRecord(payload);
  const out = new Set<number>();
  for (const key of ["refund", "resolution"] as const) {
    const part = p[key];
    if (part && typeof part === "object") {
      const id = Number(asRecord(part).shiftId);
      if (Number.isInteger(id) && id > 0) out.add(id);
    }
  }
  return Array.from(out);
}

/** إلى أين يُرسَل المُعتمِد حين يُحجَب الاعتمادُ السطريّ. */
export const SALES_CONTROL_FULL_SCREEN_HINT = "يقع من شاشة طلبات ضبط البيع (تحمل توجيه النقد لحظة الاعتماد)";

/**
 * لماذا لا يُعتمَد الطلبُ سطرياً (بلا `cashRouting`)، أو `null` حين يكفي ما في الحمولة:
 *  · ردٌّ/إلغاءٌ بالبطاقة **بلا مرجع جهاز** — `cancelSaleInTx`/`returnSaleInTx` يفرضان المرجع
 *    إلزامياً لـCARD، والمرجعُ قرارُ المُعتمِد لحظةَ الاعتماد (Codex على #988).
 *  · درجٌ مُجمَّد في الحمولة **أُقفل** بعد الطلب — التنفيذ يفشل بلا مخرج إلّا باختيار درجٍ مفتوح.
 */
export function salesControlInlineBlock(
  requestType: string,
  payload: unknown,
  shiftStatusById: ReadonlyMap<number, string | null | undefined>,
): string | null {
  const p = asRecord(payload);
  const missing = (v: unknown) => v == null || String(v).trim() === "";
  if (requestType === "SALES_CANCEL") {
    if (p.refundPaymentMethod === "CARD" && missing(p.reference)) {
      return `الالغاء ببطاقة يلزمه مرجع عملية جهاز الدفع لحظة الاعتماد — ${SALES_CONTROL_FULL_SCREEN_HINT}`;
    }
    return null;
  }
  if (requestType === "SALES_RETURN") {
    const refund = returnRefundOf(p);
    if (!refund) return null;
    if (refund.method === "CARD" && missing(refund.reference)) {
      return `الرد بالبطاقة يلزمه مرجع عملية جهاز الدفع لحظة الاعتماد — ${SALES_CONTROL_FULL_SCREEN_HINT}`;
    }
    const shiftId = Number(refund.shiftId);
    if (Number.isInteger(shiftId) && shiftId > 0) {
      const status = shiftStatusById.get(shiftId);
      if (status !== "OPEN") {
        return `الدرج المختار وقت الطلب (#${shiftId}) ${status == null ? "لم يعد موجوداً" : "أُقفل"} — اختر درجاً مفتوحاً الآن؛ ${SALES_CONTROL_FULL_SCREEN_HINT}`;
      }
    }
  }
  return null;
}
