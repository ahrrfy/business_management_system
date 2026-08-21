import type Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  accountingEntries,
  customers,
  deliveryParties,
  exchangeHouses,
  receipts,
  suppliers,
  users,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { shadowPost } from "./accounting/shadowHook";
import { getDoubleEntryRuntime } from "./accounting/journalStore";
import type {
  PostingIntent,
  PostingSourceComponents,
} from "./accounting/postingEngine";
import { createPostingIntentEvidence } from "./accounting/postingEngine";
import { money, toDbMoney } from "./money";
import { assertPeriodOpen } from "./periodLockService";
import { lockFinancialPostingGate } from "./reports/monthCloseGate";

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
  | "CASH_HANDOVER" // تسليم وردية → خزينة (نقل بين دلوَين داخل نفس الفرع)
  | "CASH_TRANSFER_OUT" // تحويل نقدي بين الفروع — الإرسال
  | "CASH_TRANSFER_IN" // تحويل نقدي بين الفروع — الاستلام
  // العهدة الوسيطة (imprest، ٢٨/٧/٢٦): حركات نقد لا تَمسّ revenue/cost (تُستثنى من الإيراد).
  | "SHIFT_FLOAT_OUT" // عهدة افتتاح وردية: سحبٌ من الخزينة → درج الكاشير (خزينة−، درج+ ضمنيّ)
  | "TREASURY_FUNDING" // تمويل الخزينة (إيداع رأس مال / رصيد افتتاحيّ للخزينة): مصدر خارجيّ → الخزينة
  // delivery-cod: عهدة جهة التوصيل (COD). DISPATCH/REMIT حركات عهدة (revenue=cost=0، تُستثنى من الإيراد).
  | "DELIVERY_DISPATCH" // إيقاف COD على عهدة الجهة عند الإرسال (+float)
  | "DELIVERY_REMIT" // خفض العهدة عند التوريد/التسوية/الإرجاع (−float)
  | "DELIVERY_FEE" // مصروف أجرة التوصيل (cost-only، خصم الأجرة وتوريد الصافي)
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
  /**
   * Explicit, audited double-entry map for multi-purpose operational events.
   * It is consumed only by the shadow/active journal writer and never changes
   * the simplified accountingEntries payload or its existing business effect.
   */
  postingIntent?: PostingIntent;
  /** Independently derived document facts; never copied from postingIntent. */
  postingSourceComponents?: PostingSourceComponents;
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
  /**
   * طريقة الدفع الخام (قيمة `receipts.paymentMethod`) — **لا تُخزَّن** (لا عمود لها في
   * `accountingEntries`). يستهلكها خطّاف الدفتر المزدوج وحده ليحدّد دلو النقد المحاسبيّ
   * (نقد ⇔ بنك)، فتبقى الترجمة في مكانٍ واحد بدل منطقٍ محاسبيٍّ مكرَّرٍ في مواضع القبض التسعة.
   * غيابها على PAYMENT_IN/PAYMENT_OUT ⇒ **فجوة موسومة** لا افتراضَ نقد (لا تخمين على النواة المالية).
   */
  paymentMethod?: string | null;
}

const ACTOR_ATTRIBUTED_ENTRY_TYPES = new Set<EntryType>([
  "PAYMENT_IN",
  "PAYMENT_OUT",
  "RETURN",
]);

/**
 * يثبّت هوية منفّذ الحركات التي تغيّر نقداً/ذمّةً في لحظة الترحيل:
 * - الكاتب المباشر يمرّر createdBy، فنلتقط الاسم الحالي لقطةً غير متأثرة بتعديل المستخدم لاحقاً.
 * - مسار Maker/Checker يرحّل عند الاعتماد ولا يمرّر actor إلى postEntry؛ عندئذٍ يكون
 *   receipts.approvedBy هو المنفّذ الفعلي، مع fallback إلى منشئ السند للسند المعتمد مباشرةً.
 * لا نفرض تخميناً من الفاتورة/أمر الشراء عند غياب المصدرين: منشئ المستند ليس بالضرورة منفّذ
 * الدفع أو المرتجع، فتبقى الفجوة NULL بدلاً من إسناد جنائي كاذب.
 */
async function resolveEntryActor(
  tx: Tx,
  e: EntryInput,
): Promise<{ createdBy: number | null; createdByNameSnapshot: string | null }> {
  let createdBy = e.createdBy ?? null;
  // لا نقبل لقطة اسم يتيمة بلا actorId؛ فقد تخص مستخدماً مختلفاً عن actor المستعاد من السند.
  let createdByNameSnapshot =
    createdBy == null ? null : e.createdByNameSnapshot?.trim() || null;
  if (!ACTOR_ATTRIBUTED_ENTRY_TYPES.has(e.entryType)) {
    return { createdBy, createdByNameSnapshot };
  }

  if (createdBy == null && e.receiptId != null) {
    const receiptActor = alias(users, "ledgerReceiptActor");
    const row = (
      await tx
        .select({
          createdBy: sql<
            number | null
          >`COALESCE(${receipts.approvedBy}, ${receipts.createdBy})`,
          createdByNameSnapshot: sql<
            string | null
          >`COALESCE(${receiptActor.name}, ${receiptActor.username})`,
        })
        .from(receipts)
        .leftJoin(
          receiptActor,
          eq(
            receiptActor.id,
            sql`COALESCE(${receipts.approvedBy}, ${receipts.createdBy})`,
          ),
        )
        .where(eq(receipts.id, e.receiptId))
        .limit(1)
    )[0];
    createdBy = row?.createdBy == null ? null : Number(row.createdBy);
    createdByNameSnapshot = row?.createdByNameSnapshot ?? null;
  }

  if (createdBy != null && createdByNameSnapshot == null) {
    const row = (
      await tx
        .select({
          name: sql<string | null>`COALESCE(${users.name}, ${users.username})`,
        })
        .from(users)
        .where(eq(users.id, createdBy))
        .limit(1)
    )[0];
    createdByNameSnapshot = row?.name ?? null;
  }

  return { createdBy, createdByNameSnapshot };
}

/** Insert one ledger entry. RETURN entries carry negative values by convention.
 *  حارس Period-Lock: يرفض القيود بـentryDate ≤ أحدث cutoffDate نشِط (assertPeriodOpen). */
export async function postEntry(tx: Tx, e: EntryInput): Promise<void> {
  const entryDate = e.entryDate ?? new Date();
  // One company-wide lock order for branch and branchless postings:
  // close gate (shared writer) -> active period -> double-entry settings.
  await lockFinancialPostingGate(tx);
  await assertPeriodOpen(tx, entryDate);
  // القفل المشترك يُؤخذ قبل إدراج المصدر: انتقال OFF→SHADOW/ACTIVE ينتظر
  // المعاملة المالية، فلا تقع الحركة على جانبي تاريخ القطع بوضعين مختلفين.
  const runtime = await getDoubleEntryRuntime(tx);
  const source = {
    amount: toDbMoney(e.amount ?? 0),
    revenue: toDbMoney(e.revenue ?? 0),
    cost: toDbMoney(e.cost ?? 0),
    profit: toDbMoney(e.profit ?? 0),
    taxAmount: toDbMoney(e.taxAmount ?? 0),
    ...(e.postingSourceComponents ?? {}),
  };
  let evidence: ReturnType<typeof createPostingIntentEvidence> | null = null;
  let postingValidationError: unknown = null;
  if (runtime.mode !== "OFF" && e.postingIntent) {
    try {
      evidence = createPostingIntentEvidence(e.postingIntent, source);
    } catch (error) {
      if (runtime.mode === "ACTIVE") throw error;
      postingValidationError = error;
    }
  }
  const actorAttribution = await resolveEntryActor(tx, e);
  const res = await tx.insert(accountingEntries).values({
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
    revenue: source.revenue,
    cost: source.cost,
    profit: source.profit,
    taxAmount: source.taxAmount,
    amount: source.amount,
    postingCycleId: runtime.mode === "OFF" ? null : runtime.cycleId,
    postingProfile: evidence?.postingProfile ?? null,
    postingIntentJson: evidence?.postingIntentJson ?? null,
    postingIntentHash: evidence?.postingIntentHash ?? null,
    entryDate,
    notes: e.notes,
    createdBy: actorAttribution.createdBy,
    createdByNameSnapshot: actorAttribution.createdByNameSnapshot,
  });
  // نقطة الحقن الوحيدة للدفتر المزدوج (P2). داخل **نفس المعاملة** ⇒ تراجعُ العملية يتراجع معه
  // القيد. في SHADOW يبقى النشر best-effort: الخلل يُوسَم فجوةً ولا يفشل عملية الأعمال؛
  // أمّا ACTIVE فيعمل fail-closed ويرمي كي لا تنجح عملية بلا يومية معتمدة.
  await shadowPost(tx, extractInsertId(res), e, {
    runtime,
    postingValidationError,
  });
}

/** AR: positive = customer owes us. Applied atomically via SQL increment. */
export async function adjustCustomerBalance(
  tx: Tx,
  customerId: number,
  delta: Decimal,
): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(customers)
    .set({
      currentBalance: sql`${customers.currentBalance} + ${toDbMoney(delta)}`,
    })
    .where(eq(customers.id, customerId));
}

/** AP: positive = we owe the supplier. */
export async function adjustSupplierBalance(
  tx: Tx,
  supplierId: number,
  delta: Decimal,
): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(suppliers)
    .set({
      currentBalance: sql`${suppliers.currentBalance} + ${toDbMoney(delta)}`,
    })
    .where(eq(suppliers.id, supplierId));
}

/** ذمة المورد الأصلية بالدولار لفواتير USD. منفصلة عن القيمة الدفترية الدينارية. */
export async function adjustSupplierBalanceUsd(
  tx: Tx,
  supplierId: number,
  delta: Decimal,
): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(suppliers)
    .set({
      currentBalanceUsd: sql`${suppliers.currentBalanceUsd} + ${toDbMoney(delta)}`,
    })
    .where(eq(suppliers.id, supplierId));
}

/** عهدة جهة التوصيل (COD float): positive = الجهة مدينة للمتجر. تُطبَّق ذرّياً بزيادة SQL نسبية. */
export async function adjustDeliveryBalance(
  tx: Tx,
  partyId: number,
  delta: Decimal,
): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(deliveryParties)
    .set({
      currentBalance: sql`${deliveryParties.currentBalance} + ${toDbMoney(delta)}`,
    })
    .where(eq(deliveryParties.id, partyId));
}

/** محفظة الدينار للصيرفة (exchange-house): positive = الصيرفة مدينة لنا. تُطبَّق ذرّياً بزيادة SQL نسبية.
 *  ⚠️ يجب أن يسبقها قفل صفّ الصيرفة (.for("update")) في الخدمة لمنع سباق الخصم. */
export async function adjustExchangeBalanceIqd(
  tx: Tx,
  exchangeHouseId: number,
  delta: Decimal,
): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(exchangeHouses)
    .set({
      balanceIqd: sql`${exchangeHouses.balanceIqd} + ${toDbMoney(delta)}`,
    })
    .where(eq(exchangeHouses.id, exchangeHouseId));
}

/** محفظة الدولار للصيرفة (exchange-house): positive = الصيرفة مدينة لنا بالدولار. تُطبَّق ذرّياً تحت قفل الصفّ. */
export async function adjustExchangeBalanceUsd(
  tx: Tx,
  exchangeHouseId: number,
  delta: Decimal,
): Promise<void> {
  if (delta.isZero()) return;
  await tx
    .update(exchangeHouses)
    .set({
      balanceUsd: sql`${exchangeHouses.balanceUsd} + ${toDbMoney(delta)}`,
    })
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
