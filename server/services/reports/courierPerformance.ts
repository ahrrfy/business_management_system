// تقرير أداء المناديب / جهات التوصيل — لطلبات المتجر الإلكتروني (B2C COD).
//
// لكل جهة توصيل (مندوب داخلي أو شركة) خلال فترة [from, to] بتاريخ الطلب (orderDate):
//   • المُسنَد / المُسلَّم / قيد التوصيل / المتعذّر (رُفض).
//   • قيمة المُسلَّم + النقد المُحصَّل (COD) — من الفاتورة المرتبطة.
//   • معدّل التعذّر % = المتعذّر ÷ (المُسلَّم + المتعذّر).
//   • العهدة القائمة الآن من دفتر التوصيل، مفلترةً بالفرع عند طلب تقرير فرع.
//
// «المتعذّر» = طلب CANCELLED يحمل cancelReason (أي أُلغي عبر «تعذّر التسليم» للمندوب) — يميّزه
// عن إلغاء الموظّف قبل الإرسال (بلا سبب مُسجَّل، وغالباً بلا جهة مُسنَدة). المصدر الوحيد للحقيقة
// المالية يبقى الدفتر؛ هذا تقرير تشغيليّ للعدّ والقيمة يقرأ حالة الطلب وفاتورته فقط (بلا كتابة).
import { and, eq, isNotNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { deliveryConsignments, deliveryLedgerEntries, deliveryParties, deliveryRemittances, invoices, onlineOrders, users } from "../../../drizzle/schema";
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
  /** ١٠/٨ — قناة إرساليات الاستقبال (كان التقرير أعمى عنها فيظلم من يعمل عليها أكثر): */
  cnAssigned: number;
  cnDelivered: number;
  cnReturned: number;
  cnWrittenOff: number;
  cnFailed: number;
  cnOpen: number;
  cnValue: string;
  /** متوسط زمن الدوران بالساعات (الإرسال → التوريد) للمُسوّاة من إرساليات الفترة. */
  cnAvgTurnHours: number | null;
  /** توريدات الفترة وعجوزها (من deliveryRemittances). */
  remitCount: number;
  remitShortCount: number;
  remitShortfall: string;
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
  cnAssigned: number;
  cnDelivered: number;
  cnFailed: number;
  cnOpen: number;
  cnValue: string;
  remitShortfall: string;
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

/** أعمار الإرساليات المفتوحة (١٠/٨) — نظير «أعمار الذمم» لكن لعُهد المناديب: دلاء زمنية
 *  من dispatchedAt لكل جهة عبر الفروع، والقيمة = متبقّي COD. الموجود سابقاً «أقدم مستحق»
 *  لكل جهة فقط — لا توزيع أعمار مركزي. */
export interface ConsignmentAgingRow {
  partyId: number;
  partyName: string;
  partyType: "INDIVIDUAL" | "COMPANY";
  openCount: number;
  d0_7: string;
  d8_14: string;
  d15_30: string;
  d31p: string;
  totalOutstanding: string;
  oldestDays: number;
}

export async function getConsignmentAging(input: { branchId?: number } = {}): Promise<{
  rows: ConsignmentAgingRow[];
  totals: { openCount: number; d0_7: string; d8_14: string; d15_30: string; d31p: string; totalOutstanding: string };
}> {
  const empty = { rows: [], totals: { openCount: 0, d0_7: "0.00", d8_14: "0.00", d15_30: "0.00", d31p: "0.00", totalOutstanding: "0.00" } };
  const db = getDb();
  if (!db) return empty;
  const conds = [sql`${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL')`];
  if (input.branchId) conds.push(eq(deliveryConsignments.branchId, input.branchId));
  const age = sql<number>`TIMESTAMPDIFF(DAY, ${deliveryConsignments.dispatchedAt}, NOW())`;
  const remaining = sql`GREATEST(CAST(${deliveryConsignments.codAmount} AS DECIMAL(15,2)) - CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2)), 0)`;
  const agg = await db
    .select({
      partyId: deliveryConsignments.partyId,
      partyName: deliveryParties.name,
      partyType: deliveryParties.partyType,
      openCount: sql<number>`COUNT(*)`,
      d0_7: sql<string>`COALESCE(SUM(CASE WHEN ${age} <= 7 THEN ${remaining} ELSE 0 END), 0)`,
      d8_14: sql<string>`COALESCE(SUM(CASE WHEN ${age} BETWEEN 8 AND 14 THEN ${remaining} ELSE 0 END), 0)`,
      d15_30: sql<string>`COALESCE(SUM(CASE WHEN ${age} BETWEEN 15 AND 30 THEN ${remaining} ELSE 0 END), 0)`,
      d31p: sql<string>`COALESCE(SUM(CASE WHEN ${age} > 30 THEN ${remaining} ELSE 0 END), 0)`,
      totalOutstanding: sql<string>`COALESCE(SUM(${remaining}), 0)`,
      oldestDays: sql<number>`COALESCE(MAX(${age}), 0)`,
    })
    .from(deliveryConsignments)
    .leftJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
    .where(and(...conds))
    .groupBy(deliveryConsignments.partyId, deliveryParties.name, deliveryParties.partyType);

  const rows: ConsignmentAgingRow[] = agg
    .map((r) => ({
      partyId: Number(r.partyId),
      partyName: r.partyName ?? `#${r.partyId}`,
      partyType: (r.partyType as "INDIVIDUAL" | "COMPANY") ?? "INDIVIDUAL",
      openCount: Number(r.openCount),
      d0_7: toDbMoney(money(r.d0_7 ?? "0")),
      d8_14: toDbMoney(money(r.d8_14 ?? "0")),
      d15_30: toDbMoney(money(r.d15_30 ?? "0")),
      d31p: toDbMoney(money(r.d31p ?? "0")),
      totalOutstanding: toDbMoney(money(r.totalOutstanding ?? "0")),
      oldestDays: Number(r.oldestDays ?? 0),
    }))
    .sort((x, y) => y.oldestDays - x.oldestDays || money(y.totalOutstanding).comparedTo(money(x.totalOutstanding)));

  const t = rows.reduce(
    (acc, r) => {
      acc.openCount += r.openCount;
      acc.d0_7 = acc.d0_7.plus(money(r.d0_7));
      acc.d8_14 = acc.d8_14.plus(money(r.d8_14));
      acc.d15_30 = acc.d15_30.plus(money(r.d15_30));
      acc.d31p = acc.d31p.plus(money(r.d31p));
      acc.total = acc.total.plus(money(r.totalOutstanding));
      return acc;
    },
    { openCount: 0, d0_7: new Decimal(0), d8_14: new Decimal(0), d15_30: new Decimal(0), d31p: new Decimal(0), total: new Decimal(0) },
  );
  return {
    rows,
    totals: {
      openCount: t.openCount,
      d0_7: toDbMoney(t.d0_7),
      d8_14: toDbMoney(t.d8_14),
      d15_30: toDbMoney(t.d15_30),
      d31p: toDbMoney(t.d31p),
      totalOutstanding: toDbMoney(t.total),
    },
  };
}

export async function getCourierPerformance(
  input: CourierPerformanceInput = {},
): Promise<{ rows: CourierPerfRow[]; summary: CourierPerfSummary }> {
  const empty: CourierPerfSummary = {
    parties: 0, assigned: 0, delivered: 0, inTransit: 0, failed: 0,
    failRate: "0", deliveredValue: "0.00", codCollected: "0.00", custodyOutstanding: "0.00",
    cnAssigned: 0, cnDelivered: 0, cnFailed: 0, cnOpen: 0, cnValue: "0.00", remitShortfall: "0.00",
  };
  const db = getDb();
  if (!db) return { rows: [], summary: empty };

  // تجميع طلبات المتجر المُسنَدة لجهة توصيل ضمن الفترة (بتاريخ الطلب)، مع قيمة/تحصيل الفاتورة.
  const conds = [isNotNull(onlineOrders.deliveryPartyId)];
  conds.push(sql`NOT EXISTS (SELECT 1 FROM deliveryConsignments dc WHERE dc.sourceType = 'ONLINE_ORDER' AND dc.sourceId = ${onlineOrders.id})`);
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
      // Legacy online deliveries predate the operational delivery ledger. Count their
      // invoice payment only when no instrumented COD_COLLECTED event exists; newer
      // rows are counted below from the ledger by the actual collection timestamp.
      codCollected: sql<string>`COALESCE(SUM(CASE WHEN ${onlineOrders.status} = 'DELIVERED'
        AND NOT EXISTS (
          SELECT 1
          FROM deliveryLedgerEntries dle
          WHERE dle.eventKey = CONCAT('ONLINE:', ${onlineOrders.id}, ':COD_COLLECTED')
        )
        THEN CAST(${invoices.paidAmount} AS DECIMAL(15,2)) ELSE 0 END), 0)`,
    })
    .from(onlineOrders)
    .leftJoin(invoices, eq(onlineOrders.invoiceId, invoices.id))
    .where(and(...conds))
    .groupBy(onlineOrders.deliveryPartyId);

  // ١٠/٨ — قناة إرساليات الاستقبال (بتاريخ الإرسال): كان التقرير يعدّ طلبات المتجر فقط،
  // فمندوبٌ سلّم ٨٠ إرسالية استقبال و٥٠ طلب متجر يظهر بـ٥٠ — المقارنة تظلم قناة الاستقبال.
  const cnConds = [sql`1=1`];
  if (input.from) cnConds.push(sql`${deliveryConsignments.dispatchedAt} >= ${localDayStart(input.from)}`);
  if (input.to) cnConds.push(sql`${deliveryConsignments.dispatchedAt} < ${localNextDayStart(input.to)}`);
  if (input.branchId) cnConds.push(eq(deliveryConsignments.branchId, input.branchId));
  const cnAgg = await db
    .select({
      partyId: deliveryConsignments.partyId,
      cnAssigned: sql<number>`COUNT(*)`,
      cnDelivered: sql<number>`SUM(CASE WHEN ${deliveryConsignments.parcelStatus} = 'DELIVERED' THEN 1 ELSE 0 END)`,
      cnReturned: sql<number>`SUM(CASE WHEN ${deliveryConsignments.parcelStatus} = 'RETURNED' THEN 1 ELSE 0 END)`,
      cnWrittenOff: sql<number>`SUM(CASE WHEN ${deliveryConsignments.moneyStatus} = 'WRITTEN_OFF' THEN 1 ELSE 0 END)`,
      cnFailed: sql<number>`SUM(CASE WHEN ${deliveryConsignments.parcelStatus} = 'FAILED' THEN 1 ELSE 0 END)`,
      cnOpen: sql<number>`SUM(CASE WHEN ${deliveryConsignments.parcelStatus} NOT IN ('DELIVERED','RETURNED') THEN 1 ELSE 0 END)`,
      cnValue: sql<string>`COALESCE(SUM(CAST(${deliveryConsignments.codAmount} AS DECIMAL(15,2))), 0)`,
      // GREATEST(...,0): توريدٌ مختومٌ بلحظةٍ سابقة للإرسال (انحراف ساعة الجهاز/بيانات قديمة) كان
      // يعطي فرقاً سالباً يجرّ المتوسط لأسفل زوراً — نحصره بصفر (مراجعة نهائية ١٠/٨).
      cnAvgTurnHours: sql<string | null>`AVG(CASE WHEN ${deliveryConsignments.courierDeliveredAt} IS NOT NULL THEN GREATEST(TIMESTAMPDIFF(HOUR, ${deliveryConsignments.dispatchedAt}, ${deliveryConsignments.courierDeliveredAt}), 0) END)`,
    })
    .from(deliveryConsignments)
    .where(and(...cnConds))
    .groupBy(deliveryConsignments.partyId);

  // توريدات الفترة وعجوزها (بتاريخ الاستلام).
  const rmConds = [sql`1=1`];
  if (input.from) rmConds.push(sql`${deliveryRemittances.receivedAt} >= ${localDayStart(input.from)}`);
  if (input.to) rmConds.push(sql`${deliveryRemittances.receivedAt} < ${localNextDayStart(input.to)}`);
  if (input.branchId) rmConds.push(eq(deliveryRemittances.branchId, input.branchId));
  const rmAgg = await db
    .select({
      partyId: deliveryRemittances.partyId,
      remitCount: sql<number>`COUNT(*)`,
      remitShortCount: sql<number>`SUM(CASE WHEN ${deliveryRemittances.status} = 'SHORT' THEN 1 ELSE 0 END)`,
      remitShortfall: sql<string>`COALESCE(SUM(CAST(${deliveryRemittances.shortfallTotal} AS DECIMAL(15,2))), 0)`,
    })
    .from(deliveryRemittances)
    .where(and(...rmConds))
    .groupBy(deliveryRemittances.partyId);

  const cnMap = new Map(cnAgg.map((a) => [Number(a.partyId), a]));
  const rmMap = new Map(rmAgg.map((a) => [Number(a.partyId), a]));
  const onlineMap = new Map(agg.map((a) => [Number(a.partyId), a]));
  if (!agg.length && !cnAgg.length && !rmAgg.length) return { rows: [], summary: empty };

  // بيانات الجهات (الاسم/النوع/الهاتف/العهدة الحالية/حساب الدخول المرتبط) للجهات الظاهرة في أي قناة.
  const partyIds = Array.from(new Set(
    Array.from(onlineMap.keys()).concat(Array.from(cnMap.keys()), Array.from(rmMap.keys())),
  ));
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
  const custodyConds = [sql`${deliveryLedgerEntries.entryType} IN ('COD_COLLECTED','COD_REMITTED','COD_WRITTEN_OFF')`];
  if (input.branchId) custodyConds.push(eq(deliveryLedgerEntries.branchId, input.branchId));
  const custodyAgg = await db.select({
    partyId: deliveryLedgerEntries.partyId,
    value: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_COLLECTED' THEN ${deliveryLedgerEntries.amount} ELSE -${deliveryLedgerEntries.amount} END),0)`,
  }).from(deliveryLedgerEntries).where(and(...custodyConds)).groupBy(deliveryLedgerEntries.partyId);
  const custodyMap = new Map(custodyAgg.map((r) => [Number(r.partyId), String(r.value)]));
  const collectedConds = [eq(deliveryLedgerEntries.entryType, "COD_COLLECTED")];
  if (input.from) collectedConds.push(sql`${deliveryLedgerEntries.occurredAt} >= ${localDayStart(input.from)}`);
  if (input.to) collectedConds.push(sql`${deliveryLedgerEntries.occurredAt} < ${localNextDayStart(input.to)}`);
  if (input.branchId) collectedConds.push(eq(deliveryLedgerEntries.branchId, input.branchId));
  const collectedAgg = await db.select({
    partyId: deliveryLedgerEntries.partyId,
    value: sql<string>`COALESCE(SUM(${deliveryLedgerEntries.amount}),0)`,
  }).from(deliveryLedgerEntries).where(and(...collectedConds)).groupBy(deliveryLedgerEntries.partyId);
  const collectedMap = new Map(collectedAgg.map((r) => [Number(r.partyId), String(r.value)]));

  const rows: CourierPerfRow[] = partyIds.map((partyId) => {
    const a = onlineMap.get(partyId);
    const c = cnMap.get(partyId);
    const m = rmMap.get(partyId);
    const p = partyMap.get(partyId);
    const delivered = Number(a?.delivered ?? 0);
    const failed = Number(a?.failed ?? 0);
    const cnFailed = Number(c?.cnFailed ?? 0);
    const avgTurn = c?.cnAvgTurnHours == null ? null : Math.round(Number(c.cnAvgTurnHours));
    return {
      partyId,
      partyName: p?.name ?? `#${partyId}`,
      partyType: (p?.partyType as "INDIVIDUAL" | "COMPANY") ?? "INDIVIDUAL",
      phone: p?.phone ?? null,
      linkedUser: p?.userName ?? null,
      isActive: p?.isActive ?? true,
      assigned: Number(a?.assigned ?? 0),
      delivered,
      inTransit: Number(a?.inTransit ?? 0),
      failed,
      failRate: pct(failed + cnFailed, delivered + Number(c?.cnDelivered ?? 0)),
      deliveredValue: toDbMoney(money(a?.deliveredValue ?? "0")),
      codCollected: toDbMoney(money(a?.codCollected ?? "0").plus(money(collectedMap.get(partyId) ?? "0"))),
      custodyOutstanding: toDbMoney(money(custodyMap.get(partyId) ?? "0")),
      cnAssigned: Number(c?.cnAssigned ?? 0),
      cnDelivered: Number(c?.cnDelivered ?? 0),
      cnReturned: Number(c?.cnReturned ?? 0),
      cnWrittenOff: Number(c?.cnWrittenOff ?? 0),
      cnFailed,
      cnOpen: Number(c?.cnOpen ?? 0),
      cnValue: toDbMoney(money(c?.cnValue ?? "0")),
      cnAvgTurnHours: avgTurn,
      remitCount: Number(m?.remitCount ?? 0),
      remitShortCount: Number(m?.remitShortCount ?? 0),
      remitShortfall: toDbMoney(money(m?.remitShortfall ?? "0")),
    };
  });

  // ترتيب: الأكثر إنجازاً عبر القناتين أولاً، ثم الأعلى قيمةً — يبرز أنشط المناديب.
  rows.sort((x, y) => (y.delivered + y.cnDelivered) - (x.delivered + x.cnDelivered)
    || money(y.deliveredValue).plus(money(y.cnValue)).comparedTo(money(x.deliveredValue).plus(money(x.cnValue))));

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
      acc.cnAssigned += r.cnAssigned;
      acc.cnDelivered += r.cnDelivered;
      acc.cnFailed += r.cnFailed;
      acc.cnOpen += r.cnOpen;
      acc.cnValue = acc.cnValue.plus(money(r.cnValue));
      acc.remitShortfall = acc.remitShortfall.plus(money(r.remitShortfall));
      return acc;
    },
    { assigned: 0, delivered: 0, inTransit: 0, failed: 0, deliveredValue: new Decimal(0), codCollected: new Decimal(0), custodyOutstanding: new Decimal(0), cnAssigned: 0, cnDelivered: 0, cnFailed: 0, cnOpen: 0, cnValue: new Decimal(0), remitShortfall: new Decimal(0) },
  );

  return {
    rows,
    summary: {
      parties: rows.length,
      assigned: totals.assigned,
      delivered: totals.delivered,
      inTransit: totals.inTransit,
      failed: totals.failed,
      failRate: pct(totals.failed + totals.cnFailed, totals.delivered + totals.cnDelivered),
      deliveredValue: toDbMoney(totals.deliveredValue),
      codCollected: toDbMoney(totals.codCollected),
      custodyOutstanding: toDbMoney(totals.custodyOutstanding),
      cnAssigned: totals.cnAssigned,
      cnDelivered: totals.cnDelivered,
      cnFailed: totals.cnFailed,
      cnOpen: totals.cnOpen,
      cnValue: toDbMoney(totals.cnValue),
      remitShortfall: toDbMoney(totals.remitShortfall),
    },
  };
}
