/**
 * **مصدرُ «النقد بيد الجهة»** — علَمُ الإطفاء لموجة م١ (PR-3، الخطّة §١٠).
 *
 * العلَم القائم `courierLedgerDerived` (`shared/rolloutFlags.ts`، البيئة
 * `ROLLOUT_COURIER_LEDGER_DERIVED`) هو الثابت الوحيد — لا متغيّرَ بيئةٍ ثانٍ:
 *   · `OFF`    (الافتراض) ⇒ `stored`: العمود المخزَّن `deliveryParties.currentBalance` هو المرجع.
 *   · `SHADOW`             ⇒ `stored` مرجعاً، والدفترُ يُحسَب ويُعرَض جانبه (شارة الانحراف).
 *   · `ON`                 ⇒ `ledger`: المشتقّ من `deliveryLedgerEntries` هو المرجع — يُقلَب
 *     بقرار المالك بعد أيامٍ متطابقة (`cashInHandDrift = 0` على كلّ الجهات).
 *
 * مَن يقرؤه: لوحة الجهات (`board.ts`)، سقفُ التوريد (`remittance.ts`)، حارسُ سقف العهدة
 * (`parties.assertFloatLimitTx`)، والتسويةُ الحرّة (`settle.ts`) — كلُّها تقرأ المصدرَ من هنا لا
 * من العلَم مباشرةً، كي يبقى الانتقالُ قلبةً واحدة.
 */
import type Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { deriveCashInHandFromLedger } from "@shared/partyExposure";
import { deliveryLedgerEntries } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { rolloutMode } from "../../config/rolloutFlags";
import { money, round2 } from "../money";

export type DeliveryCashSource = "ledger" | "stored";

export interface PartyCashInHand {
  /** المشتقّ من الدفتر الإلحاقيّ. */
  ledger: Decimal;
  /** العمود المخزَّن `deliveryParties.currentBalance`. */
  stored: Decimal;
  /** المرجعُ الفعليّ بحسب العلَم — هو ما تقرّر به الحرّاس (سقف التوريد/سقف العهدة/التسوية الحرّة). */
  effective: Decimal;
  source: DeliveryCashSource;
}

/**
 * «النقد بيد الجهة» بمصدرَيه داخل معاملة — يقرؤه كلُّ حارسٍ يقرّر بالعهدة كي لا يقرّر حارسٌ
 * بالمخزَّن وآخرُ بالدفتر بعد القلب. الدفترُ يُجمَع لكلّ نوعٍ ثمّ تُطبَّق الدالّةُ النقيّة
 * (`deriveCashInHandFromLedger`) — الصيغةُ واحدة مع اللوحة والمطابقة.
 */
export async function partyCashInHandTx(
  tx: Tx,
  party: { id: number | string; currentBalance?: string | null },
): Promise<PartyCashInHand> {
  const agg = await tx
    .select({
      entryType: deliveryLedgerEntries.entryType,
      total: sql<string>`COALESCE(SUM(${deliveryLedgerEntries.amount}), 0)`,
    })
    .from(deliveryLedgerEntries)
    .where(eq(deliveryLedgerEntries.partyId, Number(party.id)))
    .groupBy(deliveryLedgerEntries.entryType);
  const ledger = round2(money(deriveCashInHandFromLedger(agg.map((r) => ({ entryType: r.entryType, amount: String(r.total ?? "0") })))));
  const stored = round2(money(party.currentBalance ?? "0"));
  const source = deliveryCashSource();
  return { ledger, stored, effective: source === "ledger" ? ledger : stored, source };
}

export function deliveryCashSource(): DeliveryCashSource {
  return rolloutMode("courierLedgerDerived") === "ON" ? "ledger" : "stored";
}

/** هل يُحسَب الدفترُ جانب المخزَّن (SHADOW أو ON)؟ للعرض لا للقرار. */
export function deliveryCashShadowEnabled(): boolean {
  const mode = rolloutMode("courierLedgerDerived");
  return mode === "SHADOW" || mode === "ON";
}
