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
  | "COGS" | "SALARIES" | "RENT" | "UTILITIES" | "OPERATING_EXPENSE" | "LOSSES" | "OTHER_EXPENSE"
  // ── الدفعة الكاملة (١٢/٨): أصولٌ وسيطة وحسابات فرعية تلزمها الأنواع الـ٢٥ الباقية ──
  // كلها **أصولٌ حقيقية يتتبّعها النظام بأعمدة رصيدٍ مستقلّة** (treasury / deliveryParties /
  // exchangeHouses / digitalWallets) — لا حسابات وهمية. القيدُ يعكس مكان المال فعلاً.
  | "TREASURY_CASH"        // الخزينة الإدارية (مقابل CASH = درج الكاشير)
  | "CASH_IN_TRANSIT"      // نقدٌ في الطريق بين الفروع (بين OUT وIN)
  | "DELIVERY_FLOAT"       // عهدة المناديب (deliveryParties.currentBalance)
  | "COURIER_PAYABLE"      // التزامٌ للمندوب بأجرته (تمريرٌ لا مصروف — قرار المالك ٩/٨)
  | "EXCHANGE_WALLET_IQD"  // رصيدنا بالدينار لدى الصيرفة
  | "EXCHANGE_WALLET_USD"  // رصيدنا بالدولار لدى الصيرفة (متوسّط تكلفةٍ مرجّح)
  | "DIGITAL_WALLET"       // رصيدنا لدى مزوّدي الكروت
  | "FX_GAIN_LOSS"         // أرباح/خسائر الصرف المحقَّقة (حسابٌ مستقلّ — مطلبُ ميزانٍ رسميّ)
  | "GIFTS_PROMO"          // هدايا وترويج (بندٌ رقابيّ للمالك، له ميزانية حملات)
  | "ROUNDING_DIFF"        // فروق تقريب الدينار العراقي
  | "OWNER_CURRENT";       // جاري المالك (التزامٌ قابلٌ للردّ — لا رأس مال)

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
  /**
   * مميِّزاتٌ بنيويّة (وجودُها لا قيمتُها): نفس نوع القيد يخدم مساراتٍ مختلفة، والتمييز الوحيد
   * المتاح هو أيّ طرفٍ يحمله الصفّ. مثال حاسم: `PAYMENT_IN` بمندوبٍ = تحصيلُ COD والنقد **بيد
   * المندوب لا عندنا** (delivery/courier.ts:280) ⇒ لا يُرحَّل نقداً بحال.
   */
  hasDeliveryParty?: boolean;
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
  // الدفعة الكاملة (١٢/٨) — كل أنواع EntryType الـ٣١ صارت مُخطَّطة.
  "ADJUST", "INTERNAL_USE", "WASTAGE", "GIFT_OUT",
  "CASH_HANDOVER", "CASH_TRANSFER_OUT", "CASH_TRANSFER_IN", "SHIFT_FLOAT_OUT", "TREASURY_FUNDING",
  "DELIVERY_DISPATCH", "DELIVERY_REMIT", "DELIVERY_FEE", "DELIVERY_WRITEOFF",
  "EXCHANGE_DEPOSIT", "EXCHANGE_WITHDRAW", "EXCHANGE_FX_BUY", "EXCHANGE_SETTLE",
  "EXCHANGE_FEE", "EXCHANGE_FX_DIFF",
  "DIGITAL_WALLET_DEPOSIT", "DIGITAL_WALLET_WITHDRAWAL", "DIGITAL_WALLET_CONSUMPTION",
  "DIGITAL_WALLET_REVERSAL", "DIGITAL_WALLET_ADJUSTMENT", "DIGITAL_WRITEOFF",
]);

/** حركةٌ بين حسابين بمبلغٍ واحد — القالب الغالب في نقل الأصول. */
function move(from: AccountRole, to: AccountRole, amt: Decimal, et: string): JournalLine[] {
  return [dr(to, amt, et), cr(from, amt, et)];
}

/** مبلغٌ موقَّع: يختار اتجاه القيد بإشارته ويستعمل القيمة المطلقة (لا مدين/دائن سالب). */
function signed(pos: AccountRole, neg: AccountRole, amt: Decimal, et: string): JournalLine[] {
  const abs = amt.abs();
  return amt.gte(0) ? [dr(pos, abs, et), cr(neg, abs, et)] : [dr(neg, abs, et), cr(pos, abs, et)];
}

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
      // مرتجع **شراء**: عكسُ شراءٍ لا عكسُ بيع ⇒ مدين ذمم المورّد، دائن المخزون (بالقيمة المطلقة —
      // القيم مخزَّنةٌ سالبةً في المرتجعات).
      if (i.party === "SUPPLIER") {
        lines.push(...move("INVENTORY", "AP", amount.abs(), et));
        break;
      }
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
      // ⚠️ تحصيل COD بيد المندوب (delivery/courier.ts:280-287): الذمّة تنخفض وعهدة المندوب ترتفع
      // معاً — **والنقد ليس عندنا**. ترحيلُه نقداً يُضخّم الصندوق بمالٍ لا نملكه. المميِّز الوحيد
      // المتاح هو وجود طرف التوصيل على الصفّ.
      if (i.hasDeliveryParty) {
        lines.push(...move("AR", "DELIVERY_FLOAT", amount, et));
        break;
      }
      // قبضٌ من **عميل**: مدين النقد/البطاقة، دائن ذمم العميل.
      if (i.party !== "CUSTOMER") throw new UnmappedEntryTypeError(`PAYMENT_IN(طرفٌ غير عميل: ${i.party ?? "بلا طرف"})`);
      lines.push(dr(cashRole, amount, et));
      lines.push(cr("AR", amount, et));
      break;
    }
    case "PAYMENT_OUT": {
      // صرفٌ لمورّد: مدين ذمم المورّد. ردٌّ لعميل: مدين ذمم العميل (تُزاد ذمّته بالمردود — نظير
      // adjustCustomerBalance الموجب في returnSale). وإلّا فمصروفٌ تشغيليّ (نثريات/رواتب نقدية).
      const outRole: AccountRole =
        i.party === "SUPPLIER" ? "AP" : i.party === "CUSTOMER" ? "AR" : "OPERATING_EXPENSE";
      lines.push(dr(outRole, amount, et));
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
    // ── حركات نقدٍ داخلية: نقلُ أصلٍ بين دلوين، بلا أثرٍ على النتيجة ─────────────────────────
    case "CASH_HANDOVER":      // تسليم وردية: الدرج → الخزينة
      lines.push(...move("CASH", "TREASURY_CASH", amount, et)); break;
    case "SHIFT_FLOAT_OUT":    // عهدة افتتاح وردية: الخزينة → الدرج
      lines.push(...move("TREASURY_CASH", "CASH", amount, et)); break;
    case "TREASURY_FUNDING":   // تمويلٌ خارجيّ للخزينة ⇒ **جاري المالك** لا رأس المال (التزامٌ يُردّ)
      lines.push(...move("OWNER_CURRENT", "TREASURY_CASH", amount, et)); break;
    case "CASH_TRANSFER_OUT":  // بين الفروع — الإرسال: يغادر الدرج ويصير «في الطريق»
      lines.push(...move("CASH", "CASH_IN_TRANSIT", amount, et)); break;
    case "CASH_TRANSFER_IN":   // الاستلام: يصل الدرج ويُغلق «في الطريق» (الاثنان يتصافران)
      lines.push(...move("CASH_IN_TRANSIT", "CASH", amount, et)); break;

    // ── صرفُ مخزونٍ بلا نقد: القيمة بالكلفة دائماً ──────────────────────────────────────────
    case "INTERNAL_USE":       // نثرية داخلية
      lines.push(...move("INVENTORY", "OPERATING_EXPENSE", cost.abs(), et)); break;
    case "WASTAGE":            // تلف/هدر
      lines.push(...move("INVENTORY", "LOSSES", cost.abs(), et)); break;
    case "GIFT_OUT":           // هدية للعميل — حسابٌ مستقلّ (بندٌ رقابيّ للمالك)
      lines.push(...move("INVENTORY", "GIFTS_PROMO", cost.abs(), et)); break;
    case "DIGITAL_WRITEOFF":   // كرتٌ صدر ولم يُبَع ⇒ حصةٌ دُفعت بلا مقابل
      lines.push(...move("INVENTORY", "LOSSES", cost.abs(), et)); break;

    // ── عهدة المناديب ──────────────────────────────────────────────────────────────────────
    // قرار المحاسب (١٢/٨) — تصحيحٌ لقرارٍ سابق في هذه الجلسة: `deliveryParties.currentBalance`
    // **سجلّ عهدةٍ تشغيليّ لا حسابٌ في الدفتر**، وخلطُ الاثنين هو ما أوهمني بانحرافٍ حتميّ.
    // عند الإرسال: البيع مُعترَفٌ به والعميل مَدين، والمندوب **وكيلٌ لم يقبض شيئاً** ⇒ لا أصلَ
    // جديد يُقيَّد ⇒ **لا قيد**. الأصل ينتقل لحظة التحصيل فقط (PAYMENT_IN بطرف توصيل).
    // وبهذا يمثّل حساب «عهدة المناديب» النقدَ المحصَّل غير المورَّد حصراً، فيزول الانحراف كلّياً.
    case "DELIVERY_DISPATCH":
      break; // بلا أسطر عمداً — يُسجَّل NO_ENTRY لا فجوة (فرقٌ جوهريّ: الفجوة تُقفل بوّابة ACTIVE)
    case "DELIVERY_REMIT":     // التوريد: النقد يصل صندوقنا وتنخفض العهدة
      lines.push(...move("DELIVERY_FLOAT", "CASH", amount, et)); break;
    case "DELIVERY_FEE":       // أجرة المندوب — **تمريرٌ لا مصروف** (قرار المالك ٩/٨)
      lines.push(...move("DELIVERY_FLOAT", "COURIER_PAYABLE", amount.abs(), et)); break;
    case "DELIVERY_WRITEOFF":  // شطب عجز العهدة خسارةً علينا
      lines.push(...move("DELIVERY_FLOAT", "LOSSES", cost.abs().gt(0) ? cost.abs() : amount.abs(), et)); break;

    // ── الصيرفة ────────────────────────────────────────────────────────────────────────────
    case "EXCHANGE_DEPOSIT":   // إيداع دينار: الخزينة → محفظة الصيرفة
      lines.push(...move("TREASURY_CASH", "EXCHANGE_WALLET_IQD", amount, et)); break;
    case "EXCHANGE_WITHDRAW":
      lines.push(...move("EXCHANGE_WALLET_IQD", "TREASURY_CASH", amount, et)); break;
    case "EXCHANGE_FX_BUY":    // تحويلٌ داخل المحفظة: دينار → دولار
      lines.push(...move("EXCHANGE_WALLET_IQD", "EXCHANGE_WALLET_USD", amount, et)); break;
    case "EXCHANGE_SETTLE":    // تسديد مورّد من محفظة الدولار
      lines.push(...move("EXCHANGE_WALLET_USD", "AP", amount, et)); break;
    case "EXCHANGE_FEE":       // عمولة الصيرفة — مصروف
      lines.push(...move("EXCHANGE_WALLET_IQD", "OPERATING_EXPENSE", amount.abs(), et)); break;
    case "EXCHANGE_FX_DIFF":   // فرق صرفٍ محقَّق (موقَّع) — حسابٌ مستقلّ لا يُدمَج بالإيراد
      lines.push(...signed("EXCHANGE_WALLET_IQD", "FX_GAIN_LOSS", amount, et)); break;

    // ── المحافظ الرقمية (أرصدتنا لدى مزوّدي الكروت) ────────────────────────────────────────
    case "DIGITAL_WALLET_DEPOSIT":
      lines.push(...move("TREASURY_CASH", "DIGITAL_WALLET", amount, et)); break;
    case "DIGITAL_WALLET_WITHDRAWAL":
      lines.push(...move("DIGITAL_WALLET", "TREASURY_CASH", amount, et)); break;
    case "DIGITAL_WALLET_CONSUMPTION": // كرتٌ صدر ⇒ الرصيد صار بضاعةً
      lines.push(...move("DIGITAL_WALLET", "INVENTORY", amount, et)); break;
    case "DIGITAL_WALLET_REVERSAL":    // عكس الاستهلاك
      lines.push(...move("INVENTORY", "DIGITAL_WALLET", amount.abs(), et)); break;
    case "DIGITAL_WALLET_ADJUSTMENT":  // فرقٌ مع طرفٍ خارجيّ (موقَّع) — لا خطأ جردٍ داخليّ
      lines.push(...signed("DIGITAL_WALLET", "OTHER_REVENUE", amount, et)); break;

    // ── فروق التقريب ───────────────────────────────────────────────────────────────────────
    // تقريب الدينار العراقي لأقرب ٢٥٠: موقَّع، والطرف المقابل حسابُ فروقٍ مستقلّ لا يُخلَط
    // بالإيراد (يُبقي تحليل الفروق ممكناً — ورقة المراجعة، السؤال ⑪).
    case "ADJUST":
      lines.push(...signed("CASH", "ROUNDING_DIFF", amount, et)); break;

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
