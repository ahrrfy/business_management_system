// محرّك القيود المزدوجة (P1، قرار المالك ٢٧/٧) — **وحدة نقيّة**: تُترجم حدثاً مالياً (نظير accountingEntry)
// إلى أسطر مدين/دائن متوازنة عبر «الدور النظاميّ» (systemRole → الحساب، ربط P0). **لا كتابة ولا مسّ حالة**
// — P2 يوصّلها لاحقاً (كتابة مزدوجة صامتة). كل خريطة مُثبَتٌ توازنها (Σمدين=Σدائن) باختبارٍ صارم.
//
// الأساس المعماريّ (مُتحقَّقٌ من الكود): كل حدثٍ ماليّ قيدٌ منفصل، ومجموعُها يطابق الأرصدة المشتقّة الحالية
// للفلس. مثال البيع: SALE يَمدين AR بالكامل + PAYMENT_IN يَدين النقد ويُدائن AR بالمدفوع ⇒ صافي AR = الآجل.
import { money, round2 } from "../money";
import type { Decimal } from "decimal.js";

/** دورٌ نظاميّ = accounts.systemRole (ربط P0). */
export type AccountRole =
  | "CASH" | "CARD_BANK" | "INVENTORY" | "AR" | "EMPLOYEE_ADVANCES" | "FIXED_ASSETS"
  | "AP" | "CONSIGNMENT_PAYABLE" | "ACCRUED_SALARY" | "OTHER_LIABILITY"
  | "CAPITAL" | "RETAINED_EARNINGS" | "OPENING_EQUITY"
  | "SALES_STATIONERY" | "SALES_PRINT" | "SALES_FLEX" | "DELIVERY_REVENUE" | "EXCHANGE_COMMISSION" | "OTHER_REVENUE"
  | "COGS" | "SALARIES" | "RENT" | "UTILITIES" | "OPERATING_EXPENSE" | "LOSSES" | "OTHER_EXPENSE";

/** سطر قيدٍ مزدوج: مدين أو دائن (أحدهما صفر) على دورٍ نظاميّ. */
export interface JournalLine {
  role: AccountRole;
  debit: string;
  credit: string;
}

/** حدثٌ ماليّ مُطبَّع (مشتقٌّ من accountingEntry + ما يلزم من مرجعه). القيم كما تُخزَّن (RETURN موقَّعٌ سالباً). */
export interface PostingInput {
  entryType: string;
  revenue?: string | number;
  cost?: string | number;
  amount?: string | number;
  taxAmount?: string | number;
  /** الطرف المقابل — يحدّد AR (عميل) أو AP (مورّد). */
  party?: "CUSTOMER" | "SUPPLIER" | null;
  /** دلو النقد للمدفوعات (CASH افتراضيّ / CARD_BANK للبطاقة). */
  cashRole?: "CASH" | "CARD_BANK";
  /** حساب المبيعات (قطاع البيع) — افتراضيّ قرطاسية. */
  salesRole?: AccountRole;
}

/** نوعٌ لم يُخطَّط بعد (تُكمَّل الخرائط تباعاً + مراجعة محاسبية قبل P2). */
export class UnmappedEntryTypeError extends Error {
  constructor(public readonly entryType: string) {
    super(`نوع قيدٍ غير مُخطَّطٍ بعد في محرّك الدفتر المزدوج: ${entryType}`);
    this.name = "UnmappedEntryTypeError";
  }
}

const dr = (role: AccountRole, amt: Decimal): JournalLine => ({ role, debit: round2(amt).toFixed(2), credit: "0.00" });
const cr = (role: AccountRole, amt: Decimal): JournalLine => ({ role, debit: "0.00", credit: round2(amt).toFixed(2) });

/** الأنواع المُخطَّطة في هذه المرحلة (الأساسية). الباقي يُكمَّل لاحقاً بمراجعة. */
export const MAPPED_ENTRY_TYPES = new Set([
  "SALE", "RETURN", "PURCHASE", "PAYMENT_IN", "PAYMENT_OUT", "OPENING",
]);

/**
 * أسطر القيد المزدوج لحدثٍ ماليّ — متوازنةٌ دائماً (Σمدين=Σدائن، يفرضه assertBalanced).
 * يرمي UnmappedEntryTypeError للأنواع غير المُخطَّطة بعد (لا تخمين على النواة المالية).
 */
export function postingLinesFor(i: PostingInput): JournalLine[] {
  const revenue = money(i.revenue ?? "0");
  const cost = money(i.cost ?? "0");
  const amount = money(i.amount ?? "0");
  const cashRole = i.cashRole ?? "CASH";
  const salesRole = i.salesRole ?? "SALES_STATIONERY";
  const lines: JournalLine[] = [];

  switch (i.entryType) {
    case "SALE": {
      // بيع: مدين ذمم العميل بالإجمالي، دائن المبيعات بالإيراد (+ فرقٌ التزاميّ للضريبة إن وُجدت)،
      // ثم تكلفة المبيعات مقابل المخزون. (النقد يُلتقط بقيد PAYMENT_IN منفصل ⇒ صافي AR = الآجل.)
      lines.push(dr("AR", amount));
      lines.push(cr(salesRole, revenue));
      const taxLike = round2(amount.minus(revenue)); // = الضريبة (0 لنشاطٍ بلا VAT) — يُبقي التوازن.
      if (taxLike.gt(0)) lines.push(cr("OTHER_LIABILITY", taxLike));
      if (cost.gt(0)) {
        lines.push(dr("COGS", cost));
        lines.push(cr("INVENTORY", cost));
      }
      break;
    }
    case "RETURN": {
      // مرتجع بيع: عكس البيع (القيم مخزَّنةٌ سالبةً). عكس الإيراد (مدين المبيعات) وإنقاص ذمّة العميل،
      // وإعادة البضاعة للمخزون مقابل عكس تكلفة المبيعات.
      const revAbs = revenue.abs();
      const amtAbs = amount.abs();
      const costAbs = cost.abs();
      lines.push(dr(salesRole, revAbs));
      const taxLike = round2(amtAbs.minus(revAbs));
      if (taxLike.gt(0)) lines.push(dr("OTHER_LIABILITY", taxLike));
      lines.push(cr("AR", amtAbs));
      if (costAbs.gt(0)) {
        lines.push(dr("INVENTORY", costAbs));
        lines.push(cr("COGS", costAbs));
      }
      break;
    }
    case "PURCHASE": {
      // شراء بضاعة: مدين المخزون، دائن ذمم المورّد.
      lines.push(dr("INVENTORY", amount));
      lines.push(cr("AP", amount));
      break;
    }
    case "PAYMENT_IN": {
      // قبضٌ من عميل: مدين النقد/البطاقة، دائن ذمم العميل.
      lines.push(dr(cashRole, amount));
      lines.push(cr("AR", amount));
      break;
    }
    case "PAYMENT_OUT": {
      // صرفٌ لمورّد: مدين ذمم المورّد، دائن النقد/البطاقة.
      lines.push(dr("AP", amount));
      lines.push(cr(cashRole, amount));
      break;
    }
    case "OPENING": {
      // رصيدٌ افتتاحيّ (amount موقَّع كـcurrentBalance): العميل موجب=AR مدين، المورّد موجب=AP دائن،
      // مقابل حساب «رصيد افتتاحيّ». السالب يعكس الاتجاه.
      const partyRole: AccountRole = i.party === "SUPPLIER" ? "AP" : "AR";
      const abs = amount.abs();
      const customerLikeDebit = i.party === "SUPPLIER" ? amount.isNegative() : amount.gte(0);
      // العميل: موجب ⇒ مدين AR / دائن الافتتاحيّ. المورّد: موجب ⇒ دائن AP / مدين الافتتاحيّ.
      if (customerLikeDebit) {
        lines.push(dr(partyRole, abs));
        lines.push(cr("OPENING_EQUITY", abs));
      } else {
        lines.push(cr(partyRole, abs));
        lines.push(dr("OPENING_EQUITY", abs));
      }
      break;
    }
    default:
      throw new UnmappedEntryTypeError(i.entryType);
  }

  assertBalanced(lines, i.entryType);
  return lines;
}

/** الثابت الحاكم: Σمدين = Σدائن لكل قيد. يرمي إن اختلّ (حارس دفاعيّ ضد خريطةٍ خاطئة). */
export function assertBalanced(lines: JournalLine[], entryType = ""): void {
  let d = money(0), c = money(0);
  for (const l of lines) { d = d.plus(money(l.debit)); c = c.plus(money(l.credit)); }
  if (!round2(d).eq(round2(c))) {
    throw new Error(`قيدٌ غير متوازن (${entryType}): Σمدين=${round2(d).toFixed(2)} ≠ Σدائن=${round2(c).toFixed(2)}`);
  }
}
