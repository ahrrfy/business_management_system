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
 *   نقداً (cash) + غير نقديّ (بطاقة/تحويل/محفظة) + آجل لم يُقبض (credit).
 * الثلاثة تجمع إلى الإجمالي **بالبناء** (credit = الإجمالي − المُحصَّل، فهو الباقي).
 *
 * «المُحصَّل» يُشتقّ من `receipts` (سجلّ الحركة الفعليّة) المرتبطة بفواتير اليوم، صافياً
 * (IN − OUT بنفس الطريقة) بحالة COMPLETED/REVERSED معتمدة — فالردّ النقديّ على بيعِ اليوم
 * يَخفض نقدَه. النقد وحده هو ما قد يصل الدرج؛ البطاقة/التحويل للبنك، والآجل دينٌ لم يُقبض.
 */
export async function getTodaySalesComposition(
  branchId?: number,
  now: Date = new Date(),
): Promise<{
  total: string;
  invoiceCount: number;
  cash: string;
  nonCash: string;
  credit: string;
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

  // المُحصَّل على فواتير اليوم، صافياً حسب طريقة الدفع (receipts هي سجلّ الحركة الفعليّة).
  const res = await db.execute(sql`
    SELECT r.paymentMethod AS method,
      CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END), 0) AS CHAR) AS collected
    FROM receipts r
    INNER JOIN invoices i ON i.id = r.invoiceId
    WHERE i.invoiceDate >= ${start}
      AND i.invoiceDate < ${endExclusive}
      AND i.invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED')
      AND r.receiptStatus IN ('COMPLETED', 'REVERSED')
      AND r.receiptApprovalStatus = 'APPROVED'
      ${branchId != null ? sql`AND i.branchId = ${branchId}` : sql``}
    GROUP BY r.paymentMethod
  `);
  const rows = (res as unknown as [Array<Record<string, unknown>>])[0] ?? [];

  let cash = money(0);
  let card = money(0);
  let transfer = money(0);
  let wallet = money(0);
  let otherMethod = money(0);
  for (const r of rows) {
    const amt = money(String(r.collected ?? 0));
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
  // credit = الباقي غير المُحصَّل. قد يكون سالباً لو زاد التحصيل عن صافي المبيعات (دفعة مقدّمة/زائدة)؛
  // نتركه على حقيقته كي يبقى cash + nonCash + credit = total دائماً.
  const credit = total.sub(cash).sub(nonCash);
  return {
    total: totals.total,
    invoiceCount: totals.invoiceCount,
    cash: toDbMoney(cash),
    nonCash: toDbMoney(nonCash),
    credit: toDbMoney(credit),
    card: toDbMoney(card),
    transfer: toDbMoney(transfer),
    wallet: toDbMoney(wallet),
    otherMethod: toDbMoney(otherMethod),
    generatedAt: totals.generatedAt,
  };
}
