/**
 * لوحة الخمسة أعمدة لجهات التوصيل — المنطق النقيّ (برنامج v2 م١ PR-C، ٥/٩/٢٦).
 *
 * لكلّ جهةٍ خمسة أعمدة نقّالة (مُسنَد · بالطريق · سُلِّم ولم يُورَّد · رجع · أُلغي) + الأعمدة الماليّة
 * (نقدٌ بيده من الدفتر مع **شارة انحراف** حين يخالف المخزَّن — «الظلّ» — · أجورٌ له · الصافي) + شارة
 * الطرود المتأخّرة (SLA). التسميات من `shared/deliveryTerminology` و`shared/partyExposure` وحدهما
 * (⛔ لا قاموس محلّيّ). النقر على عمودٍ يفتح الطرود المطابقة في «إدارة التوصيل ← قيد التوصيل».
 *
 * ⚠️ الأنواع أدناه نسخةٌ حرفيّة من عقد `shared/deliveryBoard.ts` (م١-خادم PR-2) ريثما يُدمج فرعه —
 * عندها تُستبدل بالاستيراد من `@shared/deliveryBoard` بلا تغييرٍ في المستهلكين.
 */
import { DELIVERY_TERMS, type DeliveryTermKey } from "@shared/deliveryTerminology";
import { PARTY_EXPOSURE_LABEL_AR } from "@shared/partyExposure";
import type { ConsignmentViewKey } from "@shared/consignmentView";

export type PartyBoardBucket = { count: number; amount: string };
export type PartyBoardRow = {
  partyId: number;
  partyName: string;
  partyType: "INDIVIDUAL" | "COMPANY";
  assigned: PartyBoardBucket;
  inTransit: PartyBoardBucket;
  deliveredUnremitted: PartyBoardBucket;
  returned: PartyBoardBucket;
  cancelled: PartyBoardBucket;
  /** نقدٌ بيد المندوب بحساب الدفتر (Σ قيود COD). */
  cashInHandLedger: string;
  /** نقدٌ بيده كما هو مخزَّن على الجهة (`deliveryParties.currentBalance`). */
  cashInHandStored: string;
  /** الفرق بين الدفتر والمخزَّن — «الظلّ»؛ غير الصفر انحرافٌ يستحقّ شارة. */
  cashInHandDrift: string;
  feesOwed: string;
  net: string;
  staleOpenParcels: number;
};

export type BoardBucketKey = "assigned" | "inTransit" | "deliveredUnremitted" | "returned" | "cancelled";
export type BoardTone = "neutral" | "warning" | "danger" | "muted";

export interface BoardBucketColumn {
  key: BoardBucketKey;
  /** مفتاح المصطلح في `DELIVERY_TERMS` (الرأس/التلميح). */
  term: DeliveryTermKey;
  /** فلتر «قيد التوصيل» المطابق؛ null ⇒ لا فلتر (رابطٌ عامّ). */
  view: ConsignmentViewKey | null;
  tone: BoardTone;
}

/** الأعمدة الخمسة بترتيب دورة حياة الطرد. */
export const BOARD_BUCKETS: readonly BoardBucketColumn[] = Object.freeze([
  { key: "assigned", term: "assigned", view: "ASSIGNED", tone: "neutral" },
  { key: "inTransit", term: "outForDelivery", view: "IN_TRANSIT", tone: "warning" },
  { key: "deliveredUnremitted", term: "awaitingRemittance", view: "DELIVERED_AWAITING_REMIT", tone: "danger" },
  { key: "returned", term: "returned", view: "RETURN_DECLARED", tone: "muted" },
  { key: "cancelled", term: "cancelled", view: "CLOSED", tone: "muted" },
]);

/** الأعمدة الماليّة الثلاثة — تسمياتها من `partyExposure` (المصدر الوحيد). */
export const BOARD_MONEY_LABEL = Object.freeze({
  cashInHand: PARTY_EXPOSURE_LABEL_AR.cashInHand,
  feesOwed: PARTY_EXPOSURE_LABEL_AR.feesOwedToThem,
  net: PARTY_EXPOSURE_LABEL_AR.netResponsibility,
});

export const toNum = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const money2 = (n: number): string => n.toFixed(2);

export function bucketColumnLabel(col: BoardBucketColumn): { compact: string; tooltip: string } {
  const t = DELIVERY_TERMS[col.term];
  return { compact: t.compact, tooltip: t.tooltip };
}

export interface BoardFlags {
  /** الدفتر ≠ المخزَّن — انحرافٌ يستحقّ تحقيقاً لا تسويةً صامتة. */
  drift: boolean;
  /** طرودٌ مفتوحة أقدم من عتبة الجهة (SLA) — الإسناد الجديد محجوبٌ خادمياً. */
  stale: boolean;
  /** طرودٌ لم تُغلق بعد (مُسنَد/بالطريق/سُلِّم لم يُورَّد). */
  hasOpenParcels: boolean;
  /** يوجد ما يُسوّى اليوم: نقدٌ بيده أو طرودٌ سُلِّمت ولم تُورَّد. */
  settleReady: boolean;
}

export function boardFlags(row: PartyBoardRow): BoardFlags {
  const open = row.assigned.count + row.inTransit.count + row.deliveredUnremitted.count;
  return {
    drift: Math.abs(toNum(row.cashInHandDrift)) >= 0.005,
    stale: row.staleOpenParcels > 0,
    hasOpenParcels: open > 0,
    settleReady: row.deliveredUnremitted.count > 0 || toNum(row.cashInHandLedger) >= 0.005,
  };
}

export interface BoardTotals {
  parties: number;
  cashInHand: string;
  feesOwed: string;
  net: string;
  staleParties: number;
  driftParties: number;
  buckets: Record<BoardBucketKey, PartyBoardBucket>;
}

/** مجاميع اللوحة — تُشتقّ من الصفوف المعروضة (المفلترة) لا من الأصل، كي يصدق الرأس مع الجدول. */
export function boardTotals(rows: PartyBoardRow[]): BoardTotals {
  const buckets = Object.fromEntries(BOARD_BUCKETS.map((c) => [c.key, { count: 0, amount: 0 }])) as Record<BoardBucketKey, { count: number; amount: number }>;
  let cashInHand = 0, feesOwed = 0, net = 0, staleParties = 0, driftParties = 0;
  for (const row of rows) {
    for (const c of BOARD_BUCKETS) {
      buckets[c.key].count += row[c.key].count;
      buckets[c.key].amount += toNum(row[c.key].amount);
    }
    cashInHand += toNum(row.cashInHandLedger);
    feesOwed += toNum(row.feesOwed);
    net += toNum(row.net);
    const f = boardFlags(row);
    if (f.stale) staleParties++;
    if (f.drift) driftParties++;
  }
  return {
    parties: rows.length,
    cashInHand: money2(cashInHand),
    feesOwed: money2(feesOwed),
    net: money2(net),
    staleParties,
    driftParties,
    buckets: Object.fromEntries(
      BOARD_BUCKETS.map((c) => [c.key, { count: buckets[c.key].count, amount: money2(buckets[c.key].amount) }]),
    ) as Record<BoardBucketKey, PartyBoardBucket>,
  };
}

/** رابط عمودٍ ⇒ طرود الجهة المطابقة في «قيد التوصيل» (الفلتر + بحث باسم الجهة). */
export function hubLinkFor(row: Pick<PartyBoardRow, "partyName">, col: BoardBucketColumn): string {
  const params = new URLSearchParams({ tab: "transit", q: row.partyName });
  if (col.view) params.set("view", col.view);
  return `/delivery?${params.toString()}`;
}

/** رابط «تسوية المناديب» للجهة (إيقاع الشركة بالكشف: نفس التبويب بوضع الكشف). */
export function settleLinkFor(row: Pick<PartyBoardRow, "partyId">): string {
  return `/delivery?tab=settle&party=${row.partyId}`;
}

export function partyDetailLinkFor(row: Pick<PartyBoardRow, "partyId">): string {
  return `/delivery?tab=parties&detail=${row.partyId}`;
}

/** الترتيب التشغيليّ: المتأخّرة (SLA) أوّلاً، ثمّ الأعلى صافياً، ثمّ الاسم. */
export function sortBoardRows(rows: PartyBoardRow[]): PartyBoardRow[] {
  return [...rows].sort((a, b) => {
    const sa = a.staleOpenParcels > 0 ? 1 : 0;
    const sb = b.staleOpenParcels > 0 ? 1 : 0;
    if (sa !== sb) return sb - sa;
    const dn = toNum(b.net) - toNum(a.net);
    if (dn !== 0) return dn;
    return a.partyName.localeCompare(b.partyName, "ar");
  });
}

/** فلترة «ذمّة قائمة فقط» — صفٌّ له ما يُسوّى أو طرودٌ مفتوحة. */
export function filterOutstanding(rows: PartyBoardRow[]): PartyBoardRow[] {
  return rows.filter((r) => {
    const f = boardFlags(r);
    return f.settleReady || f.hasOpenParcels || toNum(r.feesOwed) >= 0.005;
  });
}
