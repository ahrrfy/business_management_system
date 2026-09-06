/**
 * لوحة الخمسة أعمدة لجهات التوصيل — المنطق النقيّ (برنامج v2 م١ PR-C، ٥/٩/٢٦).
 *
 * لكلّ جهةٍ خمسة أعمدة نقّالة (مُسنَد · بالطريق · سُلِّم ولم يُورَّد · رجع · أُلغي) + الأعمدة الماليّة
 * (نقدٌ بيده من الدفتر مع **شارة انحراف** حين يخالف المخزَّن — «الظلّ» — · أجورٌ له · الصافي) + شارة
 * الطرود المتأخّرة (SLA). التسميات من `shared/deliveryTerminology` و`shared/partyExposure` وحدهما
 * (⛔ لا قاموس محلّيّ). النقر على عمودٍ يفتح الطرود المطابقة في «إدارة التوصيل ← قيد التوصيل»؛ والعمودان
 * المُغلَقان (رجع · أُلغي) يفتحان تفاصيل الجهة — طردٌ مُغلَق لا يظهر في قائمة «قيد التوصيل» أصلاً.
 *
 * الأنواع من العقد المشترك `shared/deliveryBoard.ts` (م١-خادم PR-2) حرفياً — تُعاد هنا لمستهلكي المكوّنات.
 */
import { DELIVERY_TERMS, type DeliveryTermKey } from "@shared/deliveryTerminology";
import { PARTY_EXPOSURE_LABEL_AR } from "@shared/partyExposure";
import { hasOpenBalance } from "@shared/predicates";
import type { ConsignmentViewKey } from "@shared/consignmentView";

import type { PartyBoardBucket, PartyBoardRow } from "@shared/deliveryBoard";
export type { PartyBoardBucket, PartyBoardRow };

export type BoardBucketKey = "assigned" | "inTransit" | "deliveredUnremitted" | "returned" | "cancelled";
export type BoardTone = "neutral" | "warning" | "danger" | "muted";

export interface BoardBucketColumn {
  key: BoardBucketKey;
  /** مفتاح المصطلح في `DELIVERY_TERMS` (الرأس/التلميح). */
  term: DeliveryTermKey;
  /** فلتر «قيد التوصيل» المطابق؛ null ⇒ طرودٌ مُغلَقة لا تظهر هناك ⇒ الرابط إلى تفاصيل الجهة. */
  view: ConsignmentViewKey | null;
  tone: BoardTone;
}

/** الأعمدة الخمسة بترتيب دورة حياة الطرد. */
export const BOARD_BUCKETS: readonly BoardBucketColumn[] = Object.freeze([
  { key: "assigned", term: "assigned", view: "ASSIGNED", tone: "neutral" },
  { key: "inTransit", term: "outForDelivery", view: "IN_TRANSIT", tone: "warning" },
  { key: "deliveredUnremitted", term: "awaitingRemittance", view: "DELIVERED_AWAITING_REMIT", tone: "danger" },
  { key: "returned", term: "returned", view: null, tone: "muted" },
  { key: "cancelled", term: "cancelled", view: null, tone: "muted" },
]);

/** الأعمدة الماليّة — تسمياتها من `partyExposure` (المصدر الوحيد). */
export const BOARD_MONEY_LABEL = Object.freeze({
  cashInHand: PARTY_EXPOSURE_LABEL_AR.cashInHand,
  shortfallOwed: PARTY_EXPOSURE_LABEL_AR.shortfallOwed,
  feesOwed: PARTY_EXPOSURE_LABEL_AR.feesOwedToThem,
  net: PARTY_EXPOSURE_LABEL_AR.netResponsibility,
});

/**
 * «نقد بيده» بالمصدر الفعّال (Codex #1012 P2): الخادمُ يحسب `net` من الدفتر حين `courierLedgerDerived=ON`
 * ومن المخزَّن (`currentBalance`) حين OFF (الافتراض). فالعمودُ المعروضُ يتبع العلَمَ نفسَه كي يطابق `net` —
 * وإلّا ظهرت جهةٌ لها ٥٠٬٠٠٠ مخزَّنة بلا دفترٍ كاملٍ «صفراً» بينما صافيها يشملها. كلاهما بعد طرح العجز.
 */
export function effectiveCashInHand(row: Pick<PartyBoardRow, "cashInHandLedger" | "cashInHandStored">, ledgerDerived: boolean): string {
  return ledgerDerived ? row.cashInHandLedger : row.cashInHandStored;
}

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
  /** الدفتر ≠ المخزَّن — انحرافٌ يستحقّ تحقيقاً لا تسويةً صامتة. مُعتبَرٌ فقط حين الدفترُ مصدرُ الحقيقة. */
  drift: boolean;
  /** طرودٌ مفتوحة أقدم من عتبة الجهة (SLA) — الإسناد الجديد محجوبٌ خادمياً. */
  stale: boolean;
  /** طرودٌ لم تُغلق بعد (مُسنَد/بالطريق/سُلِّم لم يُورَّد). */
  hasOpenParcels: boolean;
  /**
   * تسويةٌ يوميّة مُتاحة: طردٌ **سُلِّم ولم يُورَّد** واحدٌ فأكثر (Codex #1012 P2). `settleDailyTx` لا
   * يُسوّي إلّا أسطرَ الطرود، فرصيدٌ سائبٌ (تاريخيّ/سالب) بلا طردٍ مُسلَّمٍ ينتج معاينةً فارغةً ورفضاً —
   * يُسوَّى بفعل «تسوية عهدة سائبة» لا بهذا. الرصيدُ لم يعد شرطاً هنا.
   */
  settleReady: boolean;
}

export function boardFlags(row: PartyBoardRow, ledgerDerived: boolean): BoardFlags {
  const open = row.assigned.count + row.inTransit.count + row.deliveredUnremitted.count;
  return {
    // الانحرافُ (دفتر ≠ مخزَّن) لا معنى له حين المخزَّنُ مصدرُ الحقيقة (OFF): الدفترُ قد يكون ناقصاً
    // فيُنتج «انحرافاً» كاذباً على كلّ جهة. يُعرَض فقط حين الدفترُ هو الأساس (Codex #1012 P2).
    drift: ledgerDerived && Math.abs(toNum(row.cashInHandDrift)) >= 0.005,
    stale: row.staleOpenParcels > 0,
    hasOpenParcels: open > 0,
    settleReady: row.deliveredUnremitted.count > 0,
  };
}

export interface BoardTotals {
  parties: number;
  cashInHand: string;
  shortfallOwed: string;
  feesOwed: string;
  net: string;
  staleParties: number;
  driftParties: number;
  buckets: Record<BoardBucketKey, PartyBoardBucket>;
}

/**
 * مجاميع اللوحة — تُشتقّ من الصفوف المعروضة (المفلترة) لا من الأصل، كي يصدق الرأس مع الجدول.
 * «نقد بيده» يُجمَع بالمصدر الفعّال (`ledgerDerived`) كي يطابق مجموعُ الرأس أعمدةَ الصفوف (Codex #1012 P2).
 */
export function boardTotals(rows: PartyBoardRow[], ledgerDerived: boolean): BoardTotals {
  const buckets = Object.fromEntries(BOARD_BUCKETS.map((c) => [c.key, { count: 0, amount: 0 }])) as Record<BoardBucketKey, { count: number; amount: number }>;
  let cashInHand = 0, shortfallOwed = 0, feesOwed = 0, net = 0, staleParties = 0, driftParties = 0;
  for (const row of rows) {
    for (const c of BOARD_BUCKETS) {
      buckets[c.key].count += row[c.key].count;
      buckets[c.key].amount += toNum(row[c.key].amount);
    }
    cashInHand += toNum(effectiveCashInHand(row, ledgerDerived));
    shortfallOwed += toNum(row.shortfallOwed);
    feesOwed += toNum(row.feesOwed);
    net += toNum(row.net);
    const f = boardFlags(row, ledgerDerived);
    if (f.stale) staleParties++;
    if (f.drift) driftParties++;
  }
  return {
    parties: rows.length,
    cashInHand: money2(cashInHand),
    shortfallOwed: money2(shortfallOwed),
    feesOwed: money2(feesOwed),
    net: money2(net),
    staleParties,
    driftParties,
    buckets: Object.fromEntries(
      BOARD_BUCKETS.map((c) => [c.key, { count: buckets[c.key].count, amount: money2(buckets[c.key].amount) }]),
    ) as Record<BoardBucketKey, PartyBoardBucket>,
  };
}

/** رابط عمودٍ ⇒ طرود الجهة المطابقة في «قيد التوصيل» (الفلتر + بحث باسم الجهة)؛ والمُغلَق ⇒ تفاصيل الجهة. */
export function hubLinkFor(row: Pick<PartyBoardRow, "partyName" | "partyId">, col: BoardBucketColumn): string {
  if (!col.view) return partyDetailLinkFor(row);
  const params = new URLSearchParams({ tab: "transit", q: row.partyName, view: col.view });
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

/**
 * فلترة «ذمّة قائمة فقط» — صفٌّ عليه التزامٌ حيّ: طرودٌ مفتوحة، أو نقدٌ بيده (بالمصدر الفعّال)، أو
 * عجزٌ محمَّل، أو أجورٌ مستحقّة. النقدُ يبقى معياراً هنا (خلافاً لـ`settleReady`) لأنّ جهةً تمسك نقداً
 * لم تُورَّده ذمّةٌ قائمة وإن أُغلقت طرودُها (Codex #1012 P2).
 */
export function filterOutstanding(rows: PartyBoardRow[], ledgerDerived: boolean): PartyBoardRow[] {
  return rows.filter((r) => {
    const f = boardFlags(r, ledgerDerived);
    return f.hasOpenParcels
      || hasOpenBalance({ currentBalance: effectiveCashInHand(r, ledgerDerived) })
      || toNum(r.shortfallOwed) > 0
      || hasOpenBalance({ currentBalance: r.feesOwed });
  });
}
