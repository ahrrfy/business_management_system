/* «التغيير الكبير» (§٧.١ من وثيقة تصميم أسعار بداية اليوم) — كشف ومقارنة الحصص. */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { digitalCurrentPrices, digitalPriceVersions } from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money, toDbMoney } from "../money";

/**
 * عتبة التغيير الكبير في **حصة المزوّد** نسبةً إلى السعر النافذ — قرار المالك ٣٠/٧/٢٦.
 * تجاوزُها في بطاقةٍ واحدة يوقف نشر الدُفعة كلّها على اعتماد مديرٍ آخر.
 */
export const BIG_CHANGE_THRESHOLD_PERCENT = 50;

export interface BigChangeLine {
  offeringId: number;
  name: string;
  currentShare: string;
  newShare: string;
  /** نسبة التغيّر المطلقة بالمئة، مقرّبة لخانتين. */
  changePercent: string;
  changeKinds?: ("PROVIDER_SHARE" | "SELL_PRICE")[];
  currentSellPrice?: string;
  newSellPrice?: string;
  providerShareChangePercent?: string;
  sellPriceChangePercent?: string;
}

export interface CurrentPriceBaseline {
  offeringId: number;
  priceVersionId: number;
  providerShare: string;
  sellPrice: string;
}

export interface ApprovalPriceLine {
  offeringId: number;
  providerShare: string;
  sellPrice: string;
  editedBy: number;
}

export const APPROVAL_SNAPSHOT_VERSION = 1;

function changePercent(current: string, next: string): string | null {
  const cur = money(current);
  const nxt = money(next);
  if (cur.eq(nxt)) return null;
  if (cur.isZero()) return "100.00";
  return nxt.minus(cur).abs().div(cur).mul(100).toFixed(2);
}

/**
 * يقارن الحصص المقترحة بالسعر **النافذ** (لا بالمسودّة السابقة).
 *
 * حالتان حدّيتان مقصودتان:
 *  • **لا سعر نافذ** (بطاقة جديدة/أوّل تسعير) ⇒ ليست تغييراً كبيراً؛ لا أساس للنسبة،
 *    ولو عُدّت كبيرةً لاحتاج كلُّ تسعيرٍ أوّل اعتماداً ثانياً بلا معنى.
 *  • **الحصة النافذة صفر** وجديدُها موجب ⇒ تُعدّ كبيرة: النسبة غير محسوبة (قسمة على صفر)
 *    والتغيّر مادّيّ، فالتحفّظ أسلم من تمريره صامتاً.
 */
export function detectBigChanges(
  offerings: { offeringId: number; name: string }[],
  currentShareByOffering: Map<number, string>,
  newShareByOffering: Map<number, string>,
  currentSellByOffering: Map<number, string> = new Map(),
  newSellByOffering: Map<number, string> = new Map(),
): BigChangeLine[] {
  const out: BigChangeLine[] = [];
  for (const o of offerings) {
    const next = newShareByOffering.get(o.offeringId);
    const current = currentShareByOffering.get(o.offeringId);
    if (next == null || current == null) continue; // بلا سعر نافذ ⇒ لا أساس للمقارنة

    const sharePct = changePercent(current, next);
    const currentSell = currentSellByOffering.get(o.offeringId);
    const nextSell = newSellByOffering.get(o.offeringId);
    const sellPct = currentSell != null && nextSell != null ? changePercent(currentSell, nextSell) : null;
    const shareBig = sharePct != null && money(sharePct).gte(BIG_CHANGE_THRESHOLD_PERCENT);
    const sellBig = sellPct != null && money(sellPct).gte(BIG_CHANGE_THRESHOLD_PERCENT);
    if (shareBig || sellBig) {
      const kinds: ("PROVIDER_SHARE" | "SELL_PRICE")[] = [];
      if (shareBig) kinds.push("PROVIDER_SHARE");
      if (sellBig) kinds.push("SELL_PRICE");
      const maxPct = [sharePct, sellPct]
        .filter((v): v is string => v != null)
        .reduce((max, value) => money(value).gt(max) ? money(value) : max, money(0));
      out.push({
        offeringId: o.offeringId, name: o.name,
        currentShare: toDbMoney(current), newShare: toDbMoney(next),
        currentSellPrice: currentSell != null ? toDbMoney(currentSell) : undefined,
        newSellPrice: nextSell != null ? toDbMoney(nextSell) : undefined,
        providerShareChangePercent: sharePct ?? undefined,
        sellPriceChangePercent: sellPct ?? undefined,
        changePercent: maxPct.toFixed(2),
        changeKinds: kinds,
      });
    }
  }
  return out;
}

export function approvalSnapshotFor(
  batchId: number,
  offeringIds: number[],
  baselineByOffering: Map<number, CurrentPriceBaseline>,
  proposed: ApprovalPriceLine[],
) {
  const baseline = [...offeringIds]
    .sort((a, b) => a - b)
    .map((offeringId) => {
      const row = baselineByOffering.get(offeringId);
      return row
        ? {
            offeringId,
            priceVersionId: row.priceVersionId,
            providerShare: toDbMoney(row.providerShare),
            sellPrice: toDbMoney(row.sellPrice),
          }
        : { offeringId, priceVersionId: null, providerShare: null, sellPrice: null };
    });
  const proposal = [...proposed]
    .sort((a, b) => a.offeringId - b.offeringId)
    .map((line) => ({
      offeringId: line.offeringId,
      providerShare: toDbMoney(line.providerShare),
      sellPrice: toDbMoney(line.sellPrice),
      editedBy: line.editedBy,
    }));
  return { version: APPROVAL_SNAPSHOT_VERSION, batchId, baseline, proposal };
}

export function approvalFingerprint(snapshot: ReturnType<typeof approvalSnapshotFor>): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

/** الحصص النافذة حالياً لبطاقات الفرع — أساس مقارنة «التغيير الكبير». */
export async function currentSharesFor(runner: DB | Tx, branchId: number, offeringIds: number[]) {
  const rows = await currentPricesFor(runner, branchId, offeringIds);
  return new Map(rows.map((r) => [r.offeringId, r.providerShare]));
}

export async function currentPricesFor(
  runner: DB | Tx,
  branchId: number,
  offeringIds: number[],
): Promise<CurrentPriceBaseline[]> {
  if (!offeringIds.length) return [];
  const rows = await runner
    .select({
      offeringId: digitalCurrentPrices.offeringId,
      priceVersionId: digitalCurrentPrices.priceVersionId,
      providerShare: digitalPriceVersions.providerShare,
      sellPrice: digitalPriceVersions.sellPrice,
    })
    .from(digitalCurrentPrices)
    .innerJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
    .where(and(eq(digitalCurrentPrices.branchId, branchId), inArray(digitalCurrentPrices.offeringId, offeringIds)));
  return rows.map((r) => ({
    offeringId: Number(r.offeringId),
    priceVersionId: Number(r.priceVersionId),
    providerShare: r.providerShare,
    sellPrice: r.sellPrice,
  }));
}
