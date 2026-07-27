// محرّك القيود المزدوجة (P1، قرار المالك ٢٧/٧) — **وحدة نقيّة**: تُترجم حدثاً مالياً (نظير accountingEntry)
// إلى أسطر مدين/دائن متوازنة عبر «الدور النظاميّ» (systemRole → الحساب، ربط P0). **لا كتابة ولا مسّ حالة**
// — P2 يوصّلها لاحقاً (كتابة مزدوجة صامتة). كل خريطة مُثبَتٌ توازنها (Σمدين=Σدائن) باختبارٍ صارم.
//
// الأساس المعماريّ (مُتحقَّقٌ من الكود): كل حدثٍ ماليّ قيدٌ منفصل، ومجموعُها يطابق الأرصدة المشتقّة الحالية
// للفلس. مثال البيع: SALE يَمدين AR بالكامل + PAYMENT_IN يَدين النقد ويُدائن AR بالمدفوع ⇒ صافي AR = الآجل.
//
// ── النطاق والحدود (أساسٌ فقط — ٦ خرائط من ٢٢، الباقي مؤجَّل بمراجعة محاسبية قبل P2) ──────────────
// المبدأ الحاكم: **لا تخمين على النواة المالية.** أنواع الأحداث في هذا النظام **محمَّلة بأكثر من معنى**
// (نفس entryType يخدم أطرافاً/أغراضاً مختلفة)، فيقتصر المحرّك على الحالة الأحاديّة الواضحة ويَرمي صراحةً
// على ما عداها (بدل تخمينٍ صامتٍ يُفسد الأرصدة). ما يُغطّيه اليوم وما يُؤجَّل (كشفته مراجعة Codex ٢٧/٧):
//   • SALE   — بيع بضاعة العميل. الإيراد يُعامَل كإيراد قطاع البيع بالكامل؛ **رسوم التوصيل** (DELIVERY_REVENUE)
//              يجب أن تُفصَل في P2 (sale/create يخلطها في revenue). الضريبة (amount−revenue) تُدائن التزاماً
//              (٠ لنشاطٍ بلا VAT — الافتراض).
//   • RETURN — مرتجع بيع **العميل** فقط. مرتجع الشراء (party=SUPPLIER) ⇒ يَرمي (يحتاج خريطة عكس شراء).
//   • PURCHASE — شراء **بضاعة تجارية** على ذمّة المورّد فقط. شراء **أصل ثابت** (FIXED_ASSETS) وPO **بضريبة**
//              (فصل cost/taxAmount) ⇒ مؤجَّلان (لا يملك المدخل ما يميّزهما ⇒ يُوصَّلان بمدخلٍ مخصّص في P2).
//   • PAYMENT_IN  — قبض من **عميل** (Cr AR) فقط. ردّ مورّد / أيّ قابضٍ آخر ⇒ يَرمي.
//   • PAYMENT_OUT — دفع لـ**مورّد** (Dr AP) فقط. ردّ عميل / مصروف / راتب ⇒ يَرمي (تحتاج حساب الغرض المقابل).
//   • OPENING — رصيد افتتاحيّ لـ**عميل أو مورّد** فقط. رصيد صيرفة/غيره (بلا طرف) ⇒ يَرمي (لا افتراض AR صامت).
//   • المبالغ **السالبة** (عكوسٌ مخزَّنة سالبةً مثل PURCHASE/PAYMENT_OUT سالب) ⇒ تَرمي؛ تُمرَّر العكوس
//              كقيودٍ عكسيّة صريحة في P2 (لئلّا يحمل السطرُ مديناً/دائناً سالباً).
import { money, round2 } from "../money";
import type { Decimal } from "decimal.js";

/** دورٌ نظاميّ = accounts.systemRole (ربط P0). */
export type AccountRole =
  | "CASH" | "CARD_BANK" | "INVENTORY" | "AR" | "EMPLOYEE_ADVANCES" | "FIXED_ASSETS"
  | "AP" | "CONSIGNMENT_PAYABLE" | "ACCRUED_SALARY" | "OTHER_LIABILITY"
  | "CAPITAL" | "RETAINED_EARNINGS" | "OPENING_EQUITY"
  | "SALES_STATIONERY" | "SALES_PRINT" | "SALES_FLEX" | "DELIVERY_REVENUE" | "EXCHANGE_COMMISSION" | "OTHER_REVENUE"
  | "COGS" | "SALARIES" | "RENT" | "UTILITIES" | "OPERATING_EXPENSE" | "LOSSES" | "OTHER_EXPENSE";

/** سطر قيدٍ مزدوج: مدين أو دائن (أحدهما صفر) على دورٍ نظاميّ. القيم غير سالبة دائماً. */
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
  /** الطرف المقابل — يحدّد AR (عميل) أو AP (مورّد)؛ إلزاميّ للمدفوعات والرصيد الافتتاحيّ. */
  party?: "CUSTOMER" | "SUPPLIER" | null;
  /** دلو النقد للمدفوعات (CASH افتراضيّ / CARD_BANK للبطاقة). */
  cashRole?: "CASH" | "CARD_BANK";
  /** حساب المبيعات (قطاع البيع) — افتراضيّ قرطاسية. */
  salesRole?: AccountRole;
}

/** نوعٌ (أو حالةٌ محمَّلة من نوعٍ) لم يُخطَّط بعد (تُكمَّل الخرائط تباعاً + مراجعة محاسبية قبل P2). */
export class UnmappedEntryTypeError extends Error {
  constructor(public readonly entryType: string) {
    super(`نوع قيدٍ غير مُخطَّطٍ بعد في محرّك الدفتر المزدوج: ${entryType}`);
    this.name = "UnmappedEntryTypeError";
  }
}

/** يمنع السطر السالب (دفاعٌ عن سلامة القيد: لا مدين/دائن سالب — العكوس تُمرَّر كقيود عكسيّة صريحة). */
function nonNeg(amt: Decimal, role: AccountRole, entryType: string): Decimal {
  if (amt.isNegative()) {
    throw new UnmappedEntryTypeError(`${entryType}(مبلغٌ سالبٌ على ${role} — مرّر العكس كقيدٍ عكسيّ صريح)`);
  }
  return amt;
}

const dr = (role: AccountRole, amt: Decimal, et: string): JournalLine =>
  ({ role, debit: round2(nonNeg(amt, role, et)).toFixed(2), credit: "0.00" });
const cr = (role: AccountRole, amt: Decimal, et: string): JournalLine =>
  ({ role, debit: "0.00", credit: round2(nonNeg(amt, role, et)).toFixed(2) });

/** الأنواع المُخطَّطة في هذه المرحلة (الأساسية). الباقي يُكمَّل لاحقاً بمراجعة. */
export const MAPPED_ENTRY_TYPES = new Set([
  "SALE", "RETURN", "PURCHASE", "PAYMENT_IN", "PAYMENT_OUT", "OPENING",
]);

/**
 * أسطر القيد المزدوج لحدثٍ ماليّ — متوازنةٌ دائماً (Σمدين=Σدائن، يفرضه assertBalanced).
 * يرمي UnmappedEntryTypeError للأنواع/الحالات غير المُخطَّطة بعد (لا تخمين على النواة المالية — راجع «النطاق والحدود» أعلاه).
 */
export function postingLinesFor(i: PostingInput): JournalLine[] {
  const et = i.entryType;
  const revenue = money(i.revenue ?? "0");
  const cost = money(i.cost ?? "0");
  const amount = money(i.amount ?? "0");
  const cashRole = i.cashRole ?? "CASH";
  const salesRole = i.salesRole ?? "SALES_STATIONERY";
  const lines: JournalLine[] = [];

  switch (et) {
    case "SALE": {
      // بيع: مدين ذمم العميل بالإجمالي، دائن المبيعات بالإيراد (+ فرقٌ التزاميّ للضريبة إن وُجدت)،
      // ثم تكلفة المبيعات مقابل المخزون. (النقد يُلتقط بقيد PAYMENT_IN منفصل ⇒ صافي AR = الآجل.)
      lines.push(dr("AR", amount, et));
      lines.push(cr(salesRole, revenue, et));
      const taxLike = round2(amount.minus(revenue)); // = الضريبة (0 لنشاطٍ بلا VAT) — يُبقي التوازن.
      if (taxLike.gt(0)) lines.push(cr("OTHER_LIABILITY", taxLike, et));
      if (cost.gt(0)) {
        lines.push(dr("COGS", cost, et));
        lines.push(cr("INVENTORY", cost, et));
      }
      break;
    }
    case "RETURN": {
      // مرتجع بيع **العميل** فقط. مرتجع الشراء (party=SUPPLIER) مؤجَّل (عكس شراء ≠ عكس بيع).
      if (i.party === "SUPPLIER") throw new UnmappedEntryTypeError("RETURN(SUPPLIER — مرتجع شراء مؤجَّل)");
      // عكس البيع (القيم مخزَّنةٌ سالبةً): عكس الإيراد (مدين المبيعات) وإنقاص ذمّة العميل،
      // وإعادة البضاعة للمخزون مقابل عكس تكلفة المبيعات.
      const revAbs = revenue.abs();
      const amtAbs = amount.abs();
      const costAbs = cost.abs();
      lines.push(dr(salesRole, revAbs, et));
      const taxLike = round2(amtAbs.minus(revAbs));
      if (taxLike.gt(0)) lines.push(dr("OTHER_LIABILITY", taxLike, et));
      lines.push(cr("AR", amtAbs, et));
      if (costAbs.gt(0)) {
        lines.push(dr("INVENTORY", costAbs, et));
        lines.push(cr("COGS", costAbs, et));
      }
      break;
    }
    case "PURCHASE": {
      // شراء **بضاعة تجارية**: مدين المخزون، دائن ذمم المورّد. (أصلٌ ثابت / PO بضريبة مؤجَّلان — راجع الحدود.)
      lines.push(dr("INVENTORY", amount, et));
      lines.push(cr("AP", amount, et));
      break;
    }
    case "PAYMENT_IN": {
      // قبضٌ من **عميل** فقط: مدين النقد/البطاقة، دائن ذمم العميل. أيّ قابضٍ آخر (ردّ مورّد…) مؤجَّل.
      if (i.party !== "CUSTOMER") throw new UnmappedEntryTypeError(`PAYMENT_IN(طرفٌ غير عميل: ${i.party ?? "بلا طرف"})`);
      lines.push(dr(cashRole, amount, et));
      lines.push(cr("AR", amount, et));
      break;
    }
    case "PAYMENT_OUT": {
      // صرفٌ لـ**مورّد** فقط: مدين ذمم المورّد، دائن النقد/البطاقة. مصروف/راتب/ردّ عميل مؤجَّل (يحتاج حساب الغرض).
      if (i.party !== "SUPPLIER") throw new UnmappedEntryTypeError(`PAYMENT_OUT(طرفٌ غير مورّد: ${i.party ?? "بلا طرف"})`);
      lines.push(dr("AP", amount, et));
      lines.push(cr(cashRole, amount, et));
      break;
    }
    case "OPENING": {
      // رصيدٌ افتتاحيّ لـ**عميل أو مورّد** فقط (amount موقَّع كـcurrentBalance) مقابل حساب «رصيد افتتاحيّ».
      // بلا طرفٍ صريح ⇒ يَرمي (لا افتراض AR صامت — رصيد الصيرفة مثلاً يحمل exchangeHouseId بلا عميل/مورّد).
      if (i.party !== "CUSTOMER" && i.party !== "SUPPLIER") {
        throw new UnmappedEntryTypeError(`OPENING(طرفٌ غير مدعوم: ${i.party ?? "بلا طرف عميل/مورّد"})`);
      }
      const partyRole: AccountRole = i.party === "SUPPLIER" ? "AP" : "AR";
      const abs = amount.abs();
      // العميل: موجب ⇒ مدين AR / دائن الافتتاحيّ. المورّد: موجب ⇒ دائن AP / مدين الافتتاحيّ. والسالب يعكس.
      const customerLikeDebit = i.party === "SUPPLIER" ? amount.isNegative() : amount.gte(0);
      if (customerLikeDebit) {
        lines.push(dr(partyRole, abs, et));
        lines.push(cr("OPENING_EQUITY", abs, et));
      } else {
        lines.push(cr(partyRole, abs, et));
        lines.push(dr("OPENING_EQUITY", abs, et));
      }
      break;
    }
    default:
      throw new UnmappedEntryTypeError(et);
  }

  assertBalanced(lines, et);
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
