import type Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { accountingEntries, customers, deliveryParties, exchangeHouses, suppliers } from "../../drizzle/schema";
import type { Tx } from "../db";
import { money, toDbMoney } from "./money";
import { assertPeriodOpen } from "./periodLockService";

export type EntryType =
  | "SALE"
  | "PURCHASE"
  | "PAYMENT_IN"
  | "PAYMENT_OUT"
  | "RETURN"
  | "ADJUST"
  | "OPENING"
  | "INTERNAL_USE" // نثرية داخلية: صرف مخزون كمصروف بالكلفة (بلا نقد)
  | "WASTAGE" // تلف/هدر: صرف مخزون كخسارة بالكلفة (بلا نقد)
  // treasury-stage2: حركات نقد لا تَمسّ revenue/cost (يَجِب على تقارير الإيراد استثناءها).
  | "CASH_HANDOVER"     // تسليم وردية → خزينة (نقل بين دلوَين داخل نفس الفرع)
  | "CASH_TRANSFER_OUT" // تحويل نقدي بين الفروع — الإرسال
  | "CASH_TRANSFER_IN"  // تحويل نقدي بين الفروع — الاستلام
  // العهدة الوسيطة (imprest، ٢٨/٧/٢٦): حركات نقد لا تَمسّ revenue/cost (تُستثنى من الإيراد).
  | "SHIFT_FLOAT_OUT"   // عهدة افتتاح وردية: سحبٌ من الخزينة → درج الكاشير (خزينة−، درج+ ضمنيّ)
  | "TREASURY_FUNDING"  // تمويل الخزينة (إيداع رأس مال / رصيد افتتاحيّ للخزينة): مصدر خارجيّ → الخزينة
  // delivery-cod: عهدة جهة التوصيل (COD). DISPATCH/REMIT حركات عهدة (revenue=cost=0، تُستثنى من الإيراد).
  | "DELIVERY_DISPATCH" // إيقاف COD على عهدة الجهة عند الإرسال (+float)
  | "DELIVERY_REMIT"    // خفض العهدة عند التوريد/التسوية/الإرجاع (−float)
  | "DELIVERY_FEE"      // مصروف أجرة التوصيل (cost-only، خصم الأجرة وتوريد الصافي)
  // ٥/٨ — أجرة توصيل مقبوضة/مصروفة **أمانةً** للمندوب: تمريرٌ نقديّ بلا إيراد ولا مصروف
  // (amount فقط). يقابله دائماً إيصالٌ في الدرج (IN عند القبض في الاستقبال، OUT عند صرفها
  // للمندوب) فيبقى النقد المتوقّع مطابقاً، ولا تتلوّث الأرباح بمالٍ ليس لنا.
  | "DELIVERY_FEE_HELD"
  | "DELIVERY_WRITEOFF" // شطب عجز عهدة كمصروف (cost-only، بلا نقد)
  // exchange-house (٣٠/٦): حركات الصيرفة. DEPOSIT/WITHDRAW/FX_BUY/SETTLE = حركات أصل (revenue=cost=profit=0).
  | "EXCHANGE_DEPOSIT" // إيداع نقد (دينار) من الخزينة → محفظة الصيرفة
  | "EXCHANGE_WITHDRAW" // سحب نقد (دينار) من محفظة الصيرفة → الخزينة
  | "EXCHANGE_FX_BUY" // شراء دولار: تحويل دينار→دولار داخل الصيرفة (يُحدّث WAVG)
  | "EXCHANGE_SETTLE" // تسديد ذمّة مورد عبر الصيرفة (يخفض المحفظة ودين المورد)
  | "EXCHANGE_FEE" // عمولة الصيرفة (مصروف P&L، cost=amount)
  | "EXCHANGE_FX_DIFF" // فرق صرف محقَّق عند التسديد (amount موقَّع، معزول عن إيراد البيع)
  // gifts (G-م٢، ٢٧/٧): هدية صادرة للعميل — صرف مخزون كمصروف ترويجيّ بالكلفة (revenue=0, profit=-cost)،
  // بلا invoiceId ⇒ خارج وعاء العمولة تلقائياً. مُضاف لـ P&L bucket «هدايا وترويج» (فخّ §٦ #1).
  | "GIFT_OUT"
  // البطاقات الرقمية (§٥.١٢، ٢٩/٧): حركات **أصل** على أرصدتنا لدى مزوّدي الكروت —
  // revenue = cost = profit = 0 دائماً، ولا تدخل تقارير الإيراد ولا المصروف.
  | "DIGITAL_WALLET_DEPOSIT"
  | "DIGITAL_WALLET_WITHDRAWAL"
  | "DIGITAL_WALLET_CONSUMPTION"
  | "DIGITAL_WALLET_REVERSAL"
  | "DIGITAL_WALLET_ADJUSTMENT"
  // شطب نيّةٍ عالقة (٣٠/٧/٢٦، هجرة 0129): كرتٌ صدر ولم يُبَع ⇒ دفعنا الحصة بلا مقابل.
  // **ليس** حركة أصلٍ صفرية كإخوته أعلاه، بل مصروفٌ بلا نقد على نمط `DELIVERY_WRITEOFF`:
  // revenue=0، cost=الحصة، profit=−الحصة. وبلا invoiceId ⇒ خارج وعاء العمولة تلقائياً.
  | "DIGITAL_WRITEOFF";

export interface EntryInput {
  entryType: EntryType;
  branchId?: number | null;
  invoiceId?: number | null;
  purchaseOrderId?: number | null;
  receiptId?: number | null;
  customerId?: number | null;
  supplierId?: number | null;
  deliveryPartyId?: number | null;
  exchangeHouseId?: number | null;
  /** البطاقات الرقمية (§٥.١٢): محفظة المزوّد لقيود حركة الأصل (DIGITAL_WALLET_*) — بصفر أثر P&L. */
  digitalWalletId?: number | null;
  revenue?: Decimal;
  cost?: Decimal;
  profit?: Decimal;
  taxAmount?: Decimal;
  amount?: Decimal;
  entryDate?: Date;
  notes?: string;
  /** حارس بنيوي ضدّ التكرار (مثل «SALE:<invoiceId>») ⇒ ER_DUP_ENTRY عند قيد مزدوج. فارغ للقيود المتكرّرة مشروعاً. */
  dedupeKey?: string | null;
  createdBy?: number | null;
  createdByNameSnapshot?: string | null;
}

/** Insert one ledger entry. RETURN entries carry negative values by convention.
 *  حارس Period-Lock: يرفض القيود بـentryDate ≤ أحدث cutoffDate نشِط (assertPeriodOpen). */
export async function postEntry(tx: Tx, e: EntryInput): Promise<void> {
  const entryDate = e.entryDate ?? new Date();
  await assertPeriodOpen(tx, entryDate);
  await tx.insert(accountingEntries).values({
    entryType: e.entryType,
    dedupeKey: e.dedupeKey ?? null,
    branchId: e.branchId ?? null,
    invoiceId: e.invoiceId ?? null,
    purchaseOrderId: e.purchaseOrderId ?? null,
    receiptId: e.receiptId ?? null,
    customerId: e.customerId ?? null,
    supplierId: e.supplierId ?? null,
    deliveryPartyId: e.deliveryPartyId ?? null,
    exchangeHouseId: e.exchangeHouseId ?? null,
    digitalWalletId: e.digitalWalletId ?? null,
    revenue: toDbMoney(e.revenue ?? 0),
    cost: toDbMoney(e.cost ?? 0),
    profit: toDbMoney(e.profit ?? 0),
    taxAmount: toDbMoney(e.taxAmount ?? 0),
    amount: toDbMoney(e.amount ?? 0),
    entryDate,
    notes: e.notes,
    createdBy: e.createdBy ?? null,
    createdByNameSnapshot: e.createdByNameSnapshot ?? null,
  });
}

/** AR: positive = customer owes us. Applied atomically via SQL increment. */
export async function adjustCustomerBalance(tx: Tx, customerId: number, delta: Decimal): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(customers)
    .set({ currentBalance: sql`${customers.currentBalance} + ${toDbMoney(delta)}` })
    .where(eq(customers.id, customerId));
}

/** AP: positive = we owe the supplier. */
export async function adjustSupplierBalance(tx: Tx, supplierId: number, delta: Decimal): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(suppliers)
    .set({ currentBalance: sql`${suppliers.currentBalance} + ${toDbMoney(delta)}` })
    .where(eq(suppliers.id, supplierId));
}

/** ذمة المورد الأصلية بالدولار لفواتير USD. منفصلة عن القيمة الدفترية الدينارية. */
export async function adjustSupplierBalanceUsd(tx: Tx, supplierId: number, delta: Decimal): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(suppliers)
    .set({ currentBalanceUsd: sql`${suppliers.currentBalanceUsd} + ${toDbMoney(delta)}` })
    .where(eq(suppliers.id, supplierId));
}

/** عهدة جهة التوصيل (COD float): positive = الجهة مدينة للمتجر. تُطبَّق ذرّياً بزيادة SQL نسبية. */
export async function adjustDeliveryBalance(tx: Tx, partyId: number, delta: Decimal): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(deliveryParties)
    .set({ currentBalance: sql`${deliveryParties.currentBalance} + ${toDbMoney(delta)}` })
    .where(eq(deliveryParties.id, partyId));
}

/** محفظة الدينار للصيرفة (exchange-house): positive = الصيرفة مدينة لنا. تُطبَّق ذرّياً بزيادة SQL نسبية.
 *  ⚠️ يجب أن يسبقها قفل صفّ الصيرفة (.for("update")) في الخدمة لمنع سباق الخصم. */
export async function adjustExchangeBalanceIqd(tx: Tx, exchangeHouseId: number, delta: Decimal): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(exchangeHouses)
    .set({ balanceIqd: sql`${exchangeHouses.balanceIqd} + ${toDbMoney(delta)}` })
    .where(eq(exchangeHouses.id, exchangeHouseId));
}

/** محفظة الدولار للصيرفة (exchange-house): positive = الصيرفة مدينة لنا بالدولار. تُطبَّق ذرّياً تحت قفل الصفّ. */
export async function adjustExchangeBalanceUsd(tx: Tx, exchangeHouseId: number, delta: Decimal): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(exchangeHouses)
    .set({ balanceUsd: sql`${exchangeHouses.balanceUsd} + ${toDbMoney(delta)}` })
    .where(eq(exchangeHouses.id, exchangeHouseId));
}

export function computeInvoiceStatus(
  total: string,
  paid: string,
  returnedTotal: string = "0",
): "PENDING" | "PARTIALLY_PAID" | "PAID" {
  // INVOICE-STATUS (تدقيق ٢/٧): الحالة تُحسب على **الصافي بعد المرتجعات** (total − returnedTotal)
  // لا الإجمالي الخام. فاتورة مُرتجَعة جزئياً وسُدّد صافيها كان يبقى «PARTIALLY_PAID» (مستحقّة) أبداً
  // لأن paid < total الخام. الافتراضي returnedTotal="0" ⇒ سلوك متطابق للفواتير بلا مرتجعات.
  const net = money(total).minus(money(returnedTotal));
  const p = money(paid);
  if (net.lte(0)) return "PAID"; // الصافي المستحقّ صفر أو أقل (عُوّض بالمرتجعات) — الإرجاع الكامل يضبط RETURNED في مساره
  if (p.lte(0)) return "PENDING";
  if (p.gte(net)) return "PAID";
  return "PARTIALLY_PAID";
}
