/**
 * التسوية اليوميّة بتأكيدٍ واحد — المنطق النقيّ (برنامج v2 م١ PR-C، ٥/٩/٢٦).
 *
 * الخادم يحسب المعاينة سلفاً (`delivery.settlementPreview`): المتوقَّع · المرتجعات المُعلَنة · الأجرة ·
 * الصافي · الأسطر. الشاشة تعرضها وتسأل سؤالاً واحداً: «كم عُدّ فعلاً؟» (مُملأٌ بالصافي).
 *   طابق ⇒ زرّ «إقفال» واحد · نقص ⇒ سبب العجز إلزاميّ من `shared/shortfallReason` (يُقيَّد ذمّةً على
 *   الجهة خادمياً) · زاد ⇒ يُرسَل كما هو ورسالة الخادم تُعرض كما هي (لا حكمَ محلّيّ على الزيادة).
 *
 * الأنواع من العقد المشترك `shared/deliveryBoard.ts` (م١-خادم PR-2) حرفياً — تُعاد هنا لمستهلكي المكوّنات.
 */
import { SHORTFALL_REASONS, SHORTFALL_REASON_LABEL_AR, type ShortfallReason } from "@shared/shortfallReason";
import { fmt } from "@/lib/money";

import type { SettlementPreview, SettlementPreviewLine, SettleDailyResult } from "@shared/deliveryBoard";
export type { SettlementPreview, SettlementPreviewLine, SettleDailyResult };

export type SettlementVerdictKind = "EMPTY" | "INVALID" | "BALANCED" | "SHORT" | "OVER";
export interface SettlementVerdict {
  kind: SettlementVerdictKind;
  /** المعدود − الصافي (منزلتان)؛ "0.00" حين لا يُقارَن. */
  diff: string;
  net: string;
  counted: string | null;
}

const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const toNum = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const money2 = (n: number): string => n.toFixed(2);

/** الحكم المحلّيّ على المعدود مقابل الصافي المحسوب سلفاً. */
export function settlementVerdict(preview: Pick<SettlementPreview, "net">, countedRaw: string): SettlementVerdict {
  const net = money2(toNum(preview.net));
  const raw = countedRaw.trim();
  if (!raw) return { kind: "EMPTY", diff: "0.00", net, counted: null };
  if (!MONEY_RE.test(raw)) return { kind: "INVALID", diff: "0.00", net, counted: null };
  const counted = money2(toNum(raw));
  const diff = toNum(counted) - toNum(net);
  const kind: SettlementVerdictKind = Math.abs(diff) < 0.005 ? "BALANCED" : diff < 0 ? "SHORT" : "OVER";
  return { kind, diff: money2(Math.abs(diff) < 0.005 ? 0 : diff), net, counted };
}

/** هل يُقبل «إقفال» الآن؟ العجز يلزمه سبب؛ الزيادة تُرسَل والخادم يجيب. */
export function canSettle(verdict: SettlementVerdict, reason: ShortfallReason | null): boolean {
  if (verdict.kind === "BALANCED" || verdict.kind === "OVER") return true;
  if (verdict.kind === "SHORT") return reason != null;
  return false;
}

export interface SettleDailyPayload {
  partyId: number;
  branchId: number;
  countedCash: string;
  shortfallReason?: ShortfallReason;
  /** ملاحظةٌ اختياريّة مع العجز (مرجع المكالمة/المحضر) — تُحفظ على قيد الذمّة خادمياً. */
  shortfallNotes?: string;
  shiftType: "RETAIL" | "RECEPTION";
  clientRequestId: string;
}

export function buildSettleDailyPayload(
  preview: Pick<SettlementPreview, "partyId" | "branchId" | "net">,
  verdict: SettlementVerdict,
  reason: ShortfallReason | null,
  shiftType: "RETAIL" | "RECEPTION",
  clientRequestId: string,
  shortfallNotes = "",
): SettleDailyPayload | null {
  if (!canSettle(verdict, reason) || verdict.counted == null) return null;
  const notes = shortfallNotes.trim();
  return {
    partyId: preview.partyId,
    branchId: preview.branchId,
    countedCash: verdict.counted,
    ...(verdict.kind === "SHORT" && reason ? { shortfallReason: reason, ...(notes ? { shortfallNotes: notes } : {}) } : {}),
    shiftType,
    clientRequestId,
  };
}

/** خيارات سبب العجز — من المصدر المشترك حرفياً (⛔ لا قاموس محلّيّ). */
export const SHORTFALL_OPTIONS: ReadonlyArray<{ value: ShortfallReason; label: string }> = SHORTFALL_REASONS.map((r) => ({
  value: r,
  label: SHORTFALL_REASON_LABEL_AR[r],
}));

export interface PreviewTotals {
  lines: number;
  codTotal: string;
  collectedTotal: string;
  remainingTotal: string;
}

export function previewTotals(preview: Pick<SettlementPreview, "lines">): PreviewTotals {
  let cod = 0, collected = 0, remaining = 0;
  for (const l of preview.lines) {
    cod += toNum(l.codAmount);
    collected += toNum(l.collectedAmount);
    remaining += toNum(l.remaining);
  }
  return { lines: preview.lines.length, codTotal: money2(cod), collectedTotal: money2(collected), remainingTotal: money2(remaining) };
}

/** النتيجة مُهيكَلةً للعرض بعد الإقفال — لا نصّاً حرّاً من الخادم. */
export function settleResultSummary(result: SettleDailyResult): { title: string; lines: string[] } {
  const lines = [
    `سند التوريد #${result.remittanceId}`,
    result.receiptId != null ? `إيصال القبض #${result.receiptId} (النقد دخل الدرج)` : "بلا إيصال قبض — لم يدخل نقدٌ الدرج",
  ];
  if (result.status === "SHORT") {
    lines.unshift(`العجز ${fmt(result.shortfallTotal)} د.ع قُيِّد ذمّةً فوريّة على الجهة (SHORTFALL_ASSIGNED) — يظهر في كشفها`);
    return { title: "أُقفل اليوم بعجزٍ مُصنَّف", lines };
  }
  return { title: "أُقفل اليوم مطابقاً", lines };
}
