/* «التغيير الكبير» (§٧.١ من وثيقة تصميم أسعار بداية اليوم) — كشف ومقارنة الحصص. */
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
): BigChangeLine[] {
  const out: BigChangeLine[] = [];
  for (const o of offerings) {
    const next = newShareByOffering.get(o.offeringId);
    if (next == null) continue;
    const current = currentShareByOffering.get(o.offeringId);
    if (current == null) continue; // بلا سعر نافذ ⇒ لا أساس للمقارنة

    const cur = money(current);
    const nxt = money(next);
    if (cur.eq(nxt)) continue;

    if (cur.isZero()) {
      out.push({
        offeringId: o.offeringId, name: o.name,
        currentShare: toDbMoney(cur), newShare: toDbMoney(nxt), changePercent: "100.00",
      });
      continue;
    }
    const pct = nxt.minus(cur).abs().div(cur).mul(100);
    if (pct.gte(BIG_CHANGE_THRESHOLD_PERCENT)) {
      out.push({
        offeringId: o.offeringId, name: o.name,
        currentShare: toDbMoney(cur), newShare: toDbMoney(nxt),
        changePercent: pct.toFixed(2),
      });
    }
  }
  return out;
}

/** الحصص النافذة حالياً لبطاقات الفرع — أساس مقارنة «التغيير الكبير». */
export async function currentSharesFor(runner: DB | Tx, branchId: number, offeringIds: number[]) {
  if (!offeringIds.length) return new Map<number, string>();
  const rows = await runner
    .select({
      offeringId: digitalCurrentPrices.offeringId,
      providerShare: digitalPriceVersions.providerShare,
    })
    .from(digitalCurrentPrices)
    .innerJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
    .where(and(eq(digitalCurrentPrices.branchId, branchId), inArray(digitalCurrentPrices.offeringId, offeringIds)));
  return new Map(rows.map((r) => [Number(r.offeringId), r.providerShare]));
}
