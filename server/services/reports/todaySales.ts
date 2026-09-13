import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { baghdadTodayUtcRange } from "../businessDay";

/**
 * One authoritative definition of today's sales for operational surfaces.
 *
 * The ERP stores timestamps in UTC while this mobile/executive label follows
 * the Baghdad civil date. We therefore compare against the half-open UTC
 * instants enclosing that Baghdad day. Returns reduce revenue without allowing
 * a negative invoice contribution, and cancelled invoices never contribute.
 */
export async function getTodayNetSales(branchId?: number, now: Date = new Date()): Promise<{
  total: string;
  invoiceCount: number;
  generatedAt: string;
}> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const { start, endExclusive } = baghdadTodayUtcRange(now);

  const result = await db.execute(sql`
    SELECT COUNT(*) AS invoiceCount,
      CAST(COALESCE(SUM(GREATEST(total - COALESCE(returnedTotal, 0), 0)), 0) AS CHAR) AS total
    FROM invoices
    WHERE invoiceDate >= ${start}
      AND invoiceDate < ${endExclusive}
      AND invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED')
      ${branchId != null ? sql`AND branchId = ${branchId}` : sql``}
  `);
  const rows = (result as unknown as [Array<Record<string, unknown>>])[0] ?? [];
  return {
    total: toDbMoney(money(String(rows[0]?.total ?? 0))),
    invoiceCount: Number(rows[0]?.invoiceCount ?? 0),
    generatedAt: now.toISOString(),
  };
}

/**
 * تركيب مبيعات اليوم — جسر «لماذا لا تساوي المبيعاتُ النقدَ في الدرج».
 *
 * إجماليُّ المبيعات (نفس getTodayNetSales حرفياً ⇒ يطابق بطاقة اللوحة) يتفكّك إلى:
 *   نقد الدرج (cash) + نقد الخزينة (treasuryCash) + غير نقديّ (بطاقة/تحويل/محفظة) +
 *   آجل لم يُقبض (credit)، مع فصل ردٍّ معلّق/تحصيلٍ زائد (pendingRefund) كي لا يُوسَم آجلاً.
 * الثابت: total = cash + treasuryCash + nonCash + credit − pendingRefund (credit,pendingRefund ≥ 0).
 *
 * «المُحصَّل» = مصدران بلا ازدواج: (أ) إيصالاتٌ مرتبطةٌ بفاتورة اليوم مباشرةً، صافيةً (IN − OUT)
 * بحالة COMPLETED/REVERSED معتمدة، مُبوَّبةً حسب (الطريقة، دلو النقد) — فنقدُ الخزينة (ردٌّ من
 * الخزينة حين لا درج) لا يُخصَم من نقد الدرج المعروض؛ (ب) تطبيقات دفعةٍ مُوزَّعةٍ على عدّة أوامر
 * شغل (`orderPayments`) التي يُترك إيصالُها invoiceId=NULL عمداً لكنها داخلةٌ في paidAmount
 * للفاتورة المُسلَّمة اليوم — يُسقطها الـJOIN المباشر فتظهر آجلاً زوراً، فنضمّها من طريقة الأب.
 */
export async function getTodaySalesComposition(
  branchId?: number,
  now: Date = new Date(),
): Promise<{
  total: string;
  invoiceCount: number;
  cash: string;
  treasuryCash: string;
  nonCash: string;
  credit: string;
  pendingRefund: string;
  card: string;
  transfer: string;
  wallet: string;
  otherMethod: string;
  generatedAt: string;
}> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const { start, endExclusive } = baghdadTodayUtcRange(now);
  // الإجماليّ وعدد الفواتير من التعريف الحاكم نفسه ⇒ رأس الجسر == بطاقة «مبيعات اليوم».
  const totals = await getTodayNetSales(branchId, now);

  // (أ) المُحصَّل عبر إيصالٍ مرتبطٍ بفاتورة اليوم مباشرةً، صافياً حسب (الطريقة، دلو النقد).
  const resA = await db.execute(sql`
    SELECT r.paymentMethod AS method,
      r.cashBucket AS bucket,
      CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END), 0) AS CHAR) AS collected
    FROM receipts r
    INNER JOIN invoices i ON i.id = r.invoiceId
    WHERE i.invoiceDate >= ${start}
      AND i.invoiceDate < ${endExclusive}
      AND i.invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED')
      AND r.receiptStatus IN ('COMPLETED', 'REVERSED')
      AND r.receiptApprovalStatus = 'APPROVED'
      ${branchId != null ? sql`AND i.branchId = ${branchId}` : sql``}
    GROUP BY r.paymentMethod, r.cashBucket
  `);
  const rowsA = (resA as unknown as [Array<Record<string, unknown>>])[0] ?? [];

  // (ب) تطبيقات دفعةٍ مُوزَّعةٍ على أوامر الشغل (invoiceId على الإيصال = NULL عمداً). نضمّ المبلغ
  //     المُطبَّق من طريقة الأب (orderPayMethod)، ونمنع الازدواج باستبعاد ما إيصالُ أبيه مربوطٌ
  //     بالفاتورة أصلاً (فقد احتُسب في أ). أسماء أعمدة enum الخام: orderPayKind/orderPayMethod/…
  const resB = await db.execute(sql`
    SELECT p.orderPayMethod AS method,
      CAST(COALESCE(SUM(a.amount), 0) AS CHAR) AS applied
    FROM orderPayments a
    JOIN workOrders wo ON wo.id = a.appliedId
    JOIN invoices i ON i.id = wo.invoiceId
    JOIN orderPayments p ON p.id = a.parentPaymentId
    LEFT JOIN receipts pr ON pr.id = p.receiptId
    WHERE a.orderPayKind = 'APPLICATION'
      AND a.orderPayAppliedKind = 'WORKORDER'
      AND i.invoiceDate >= ${start}
      AND i.invoiceDate < ${endExclusive}
      AND i.invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED')
      AND (pr.invoiceId IS NULL OR pr.invoiceId <> i.id)
      ${branchId != null ? sql`AND i.branchId = ${branchId}` : sql``}
    GROUP BY p.orderPayMethod
  `);
  const rowsB = (resB as unknown as [Array<Record<string, unknown>>])[0] ?? [];

  let cash = money(0); // نقد الدرج (DRAWER أو NULL القديم)
  let treasuryCash = money(0); // نقدٌ حُصِّل/رُدّ عبر الخزينة الإدارية — ليس درجاً
  let card = money(0);
  let transfer = money(0);
  let wallet = money(0);
  let otherMethod = money(0);
  for (const r of rowsA) {
    const amt = money(String(r.collected ?? 0));
    const method = String(r.method);
    const bucket = r.bucket == null ? null : String(r.bucket);
    switch (method) {
      case "CASH":
        if (bucket === "TREASURY") treasuryCash = treasuryCash.add(amt);
        else cash = cash.add(amt);
        break;
      case "CARD": card = card.add(amt); break;
      case "TRANSFER": transfer = transfer.add(amt); break;
      case "WALLET": wallet = wallet.add(amt); break;
      default: otherMethod = otherMethod.add(amt); break;
    }
  }
  // تطبيقات الدفعات المُوزَّعة عربونٌ مقبوضٌ سلفاً (يصل الدرج/البنك عند القبض)؛ نقدُها درجٌ.
  for (const r of rowsB) {
    const amt = money(String(r.applied ?? 0));
    switch (String(r.method)) {
      case "CASH": cash = cash.add(amt); break;
      case "CARD": card = card.add(amt); break;
      case "TRANSFER": transfer = transfer.add(amt); break;
      case "WALLET": wallet = wallet.add(amt); break;
      default: otherMethod = otherMethod.add(amt); break;
    }
  }
  const total = money(totals.total);
  const nonCash = card.add(transfer).add(wallet).add(otherMethod);
  // الباقي بعد كلّ المُحصَّل. الموجب = آجلٌ لم يُقبض؛ السالب = ردٌّ معلّقٌ/تحصيلٌ زائد (مالٌ يُردّ
  // للعميل، لا دينٌ عليه) — يُفصَل في pendingRefund كي لا يُعرَض «آجل — لم يُقبض» على قيمةٍ سالبة.
  const residual = total.sub(cash).sub(treasuryCash).sub(nonCash);
  const credit = residual.gt(0) ? residual : money(0);
  const pendingRefund = residual.lt(0) ? residual.neg() : money(0);
  return {
    total: totals.total,
    invoiceCount: totals.invoiceCount,
    cash: toDbMoney(cash),
    treasuryCash: toDbMoney(treasuryCash),
    nonCash: toDbMoney(nonCash),
    credit: toDbMoney(credit),
    pendingRefund: toDbMoney(pendingRefund),
    card: toDbMoney(card),
    transfer: toDbMoney(transfer),
    wallet: toDbMoney(wallet),
    otherMethod: toDbMoney(otherMethod),
    generatedAt: totals.generatedAt,
  };
}
