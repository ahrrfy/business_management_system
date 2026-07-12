// تقرير أداء المناديب / جهات التوصيل — لطلبات المتجر الإلكتروني (B2C COD).
//
// لكل جهة توصيل (مندوب داخلي أو شركة) خلال فترة [from, to] بتاريخ الطلب (orderDate):
//   • المُسنَد / المُسلَّم / قيد التوصيل / المتعذّر (رُفض).
//   • قيمة المُسلَّم + النقد المُحصَّل (COD) — من الفاتورة المرتبطة.
//   • معدّل التعذّر % = المتعذّر ÷ (المُسلَّم + المتعذّر).
//   • العهدة القائمة الآن (currentBalance) — نقدٌ حصّله ولم يُورّده بعد (لقطة لحظية لا فترة).
//
// «المتعذّر» = طلب CANCELLED يحمل cancelReason (أي أُلغي عبر «تعذّر التسليم» للمندوب) — يميّزه
// عن إلغاء الموظّف قبل الإرسال (بلا سبب مُسجَّل، وغالباً بلا جهة مُسنَدة). المصدر الوحيد للحقيقة
// المالية يبقى الدفتر؛ هذا تقرير تشغيليّ للعدّ والقيمة يقرأ حالة الطلب وفاتورته فقط (بلا كتابة).
import { and, eq, isNotNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { deliveryParties, invoices, onlineOrders, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { localDayStart, localNextDayStart } from "../dateRange";
import { money, round2, toDbMoney } from "../money";

export interface CourierPerfRow {
  partyId: number;
  partyName: string;
  partyType: "INDIVIDUAL" | "COMPANY";
  phone: string | null;
  linkedUser: string | null;
  isActive: boolean;
  assigned: number;
  delivered: number;
  inTransit: number;
  failed: number;
  /** معدّل التعذّر % (خانتان) = failed ÷ (delivered + failed)؛ "0" حين لا مُنجَز بعد. */
  failRate: string;
  deliveredValue: string;
  codCollected: string;
  custodyOutstanding: string;
}

export interface CourierPerfSummary {
  parties: number;
  assigned: number;
  delivered: number;
  inTransit: number;
  failed: number;
  failRate: string;
  deliveredValue: string;
  codCollected: string;
  custodyOutstanding: string;
}

export interface CourierPerformanceInput {
  from?: string;
  to?: string;
  branchId?: number;
}

function pct(failed: number, delivered: number): string {
  const done = failed + delivered;
  if (done <= 0) return "0";
  return round2(new Decimal(failed).dividedBy(done).times(100)).toFixed(2);
}

export async function getCourierPerformance(
  input: CourierPerformanceInput = {},
): Promise<{ rows: CourierPerfRow[]; summary: CourierPerfSummary }> {
  const empty: CourierPerfSummary = {
    parties: 0, assigned: 0, delivered: 0, inTransit: 0, failed: 0,
    failRate: "0", deliveredValue: "0.00", codCollected: "0.00", custodyOutstanding: "0.00",
  };
  const db = getDb();
  if (!db) return { rows: [], summary: empty };

  // تجميع طلبات المتجر المُسنَدة لجهة توصيل ضمن الفترة (بتاريخ الطلب)، مع قيمة/تحصيل الفاتورة.
  const conds = [isNotNull(onlineOrders.deliveryPartyId)];
  if (input.from) conds.push(sql`${onlineOrders.orderDate} >= ${localDayStart(input.from)}`);
  if (input.to) conds.push(sql`${onlineOrders.orderDate} < ${localNextDayStart(input.to)}`);
  if (input.branchId) conds.push(eq(onlineOrders.branchId, input.branchId));

  const agg = await db
    .select({
      partyId: onlineOrders.deliveryPartyId,
      assigned: sql<number>`COUNT(*)`,
      delivered: sql<number>`SUM(CASE WHEN ${onlineOrders.status} = 'DELIVERED' THEN 1 ELSE 0 END)`,
      inTransit: sql<number>`SUM(CASE WHEN ${onlineOrders.status} = 'SHIPPED' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${onlineOrders.status} = 'CANCELLED' AND ${onlineOrders.cancelReason} IS NOT NULL THEN 1 ELSE 0 END)`,
      deliveredValue: sql<string>`COALESCE(SUM(CASE WHEN ${onlineOrders.status} = 'DELIVERED' THEN CAST(${invoices.total} AS DECIMAL(15,2)) ELSE 0 END), 0)`,
      codCollected: sql<string>`COALESCE(SUM(CASE WHEN ${onlineOrders.status} = 'DELIVERED' THEN CAST(${invoices.paidAmount} AS DECIMAL(15,2)) ELSE 0 END), 0)`,
    })
    .from(onlineOrders)
    .leftJoin(invoices, eq(onlineOrders.invoiceId, invoices.id))
    .where(and(...conds))
    .groupBy(onlineOrders.deliveryPartyId);

  if (!agg.length) return { rows: [], summary: empty };

  // بيانات الجهات (الاسم/النوع/الهاتف/العهدة الحالية/حساب الدخول المرتبط) للجهات الظاهرة في التجميع.
  const partyIds = agg.map((a) => Number(a.partyId));
  const parties = await db
    .select({
      id: deliveryParties.id,
      name: deliveryParties.name,
      partyType: deliveryParties.partyType,
      phone: deliveryParties.phone,
      currentBalance: deliveryParties.currentBalance,
      isActive: deliveryParties.isActive,
      userName: users.name,
    })
    .from(deliveryParties)
    .leftJoin(users, eq(deliveryParties.userId, users.id))
    .where(sql`${deliveryParties.id} IN (${sql.join(partyIds, sql`, `)})`);
  const partyMap = new Map(parties.map((p) => [Number(p.id), p]));

  const rows: CourierPerfRow[] = agg.map((a) => {
    const partyId = Number(a.partyId);
    const p = partyMap.get(partyId);
    const delivered = Number(a.delivered);
    const failed = Number(a.failed);
    return {
      partyId,
      partyName: p?.name ?? `#${partyId}`,
      partyType: (p?.partyType as "INDIVIDUAL" | "COMPANY") ?? "INDIVIDUAL",
      phone: p?.phone ?? null,
      linkedUser: p?.userName ?? null,
      isActive: p?.isActive ?? true,
      assigned: Number(a.assigned),
      delivered,
      inTransit: Number(a.inTransit),
      failed,
      failRate: pct(failed, delivered),
      deliveredValue: toDbMoney(money(a.deliveredValue ?? "0")),
      codCollected: toDbMoney(money(a.codCollected ?? "0")),
      custodyOutstanding: toDbMoney(money(p?.currentBalance ?? "0")),
    };
  });

  // ترتيب: الأكثر تسليماً أولاً، ثم الأعلى قيمةً — يبرز أنشط المناديب.
  rows.sort((x, y) => y.delivered - x.delivered || money(y.deliveredValue).comparedTo(money(x.deliveredValue)));

  // الإجماليات (المال عبر decimal — قاعدة §٥).
  const totals = rows.reduce(
    (acc, r) => {
      acc.assigned += r.assigned;
      acc.delivered += r.delivered;
      acc.inTransit += r.inTransit;
      acc.failed += r.failed;
      acc.deliveredValue = acc.deliveredValue.plus(money(r.deliveredValue));
      acc.codCollected = acc.codCollected.plus(money(r.codCollected));
      acc.custodyOutstanding = acc.custodyOutstanding.plus(money(r.custodyOutstanding));
      return acc;
    },
    { assigned: 0, delivered: 0, inTransit: 0, failed: 0, deliveredValue: new Decimal(0), codCollected: new Decimal(0), custodyOutstanding: new Decimal(0) },
  );

  return {
    rows,
    summary: {
      parties: rows.length,
      assigned: totals.assigned,
      delivered: totals.delivered,
      inTransit: totals.inTransit,
      failed: totals.failed,
      failRate: pct(totals.failed, totals.delivered),
      deliveredValue: toDbMoney(totals.deliveredValue),
      codCollected: toDbMoney(totals.codCollected),
      custodyOutstanding: toDbMoney(totals.custodyOutstanding),
    },
  };
}
