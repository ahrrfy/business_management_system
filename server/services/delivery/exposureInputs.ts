/**
 * **مدخلاتُ الدالّة النقيّة `computePartyExposure` من القاعدة** — م١ (PR-3).
 *
 * الخادم كان يعيد كتابة صيغ الأعمدة الأربعة SQL في ثلاثة مواضع (`parties.ts` و`queries.ts` و
 * `board.ts`) بينما الدالّةُ النقيّة في `shared/partyExposure.ts` تُختبَر وحدها ولا تُستدعى.
 * هنا الموضعُ الواحد الذي يجمع **المدخلات فقط**:
 *   · الطرود الحيّة (`status ∈ DISPATCHED/PARTIAL`، غيرُ مُعلَنةِ الرجوع) مع عهدة كلّ طردٍ من الدفتر
 *     (`ledgerCustody` — كي لا يُحسب الطردُ المقبوض غير المورَّد مرّتين).
 *   · مجاميعُ الدفتر لكلّ (جهة × نوع) — الدالّة خطّيّة في المبالغ فالمجموع يكفي.
 *   · «النقد بيد الجهة» مشتقّاً (`deriveCashInHandFromLedger`).
 * والحسابُ كلُّه في الدالّة النقيّة — فما يُختبَر هو ما يُعرَض.
 */
import { and, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { DELIVERY_CASH_CUSTODY_SIGN } from "@shared/deliveryLedgerEntryType";
import {
  deriveCashInHandFromLedger,
  type PartyExposureLedgerEntry,
  type PartyExposureParcelSnapshot,
} from "@shared/partyExposure";
import { deliveryConsignments, deliveryLedgerEntries } from "../../../drizzle/schema";
import type { Tx } from "../../db";

/**
 * عهدةُ النقد لكلّ طرد — `CASE` مبنيٌّ من الثابت الواحد `DELIVERY_CASH_CUSTODY_SIGN` (لا صيغةَ
 * مكتوبةً بيد تنجرف عن `deriveCashInHandFromLedger`).
 */
export const ledgerCustodySumSql: SQL<string> = sql<string>`COALESCE(SUM(CASE ${sql.join(
  Object.entries(DELIVERY_CASH_CUSTODY_SIGN).map(
    ([entryType, sign]) =>
      sql`WHEN ${deliveryLedgerEntries.entryType} = ${entryType} THEN ${sign > 0 ? sql`` : sql`-`}${deliveryLedgerEntries.amount}`,
  ),
  sql` `,
)} ELSE 0 END), 0)`;

export interface PartyExposureInputs {
  parcels: PartyExposureParcelSnapshot[];
  /** مجاميعُ الدفتر لكلّ نوعٍ (على مستوى الجهة كلّها — العمودُ المخزَّن جهويٌّ لا فرعيّ). */
  ledger: PartyExposureLedgerEntry[];
  /** «النقد بيد الجهة» من الدفتر — `deriveCashInHandFromLedger(ledger)`. */
  cashInHandLedger: string;
}

const EMPTY: PartyExposureInputs = Object.freeze({ parcels: [], ledger: [], cashInHandLedger: "0.00" });

/** المدخلاتُ لعدّة جهاتٍ بثلاثة استعلاماتٍ مجمَّعة — لا استعلامَ لكلّ جهة. */
export async function loadPartyExposureInputsTx(
  tx: Tx,
  partyIds: number[],
  /** فرعُ الطرود (`null` = كلّ الفروع). الدفترُ جهويٌّ دائماً. */
  branchId: number | null,
): Promise<Map<number, PartyExposureInputs>> {
  const out = new Map<number, PartyExposureInputs>();
  if (!partyIds.length) return out;

  const liveParcels = await tx
    .select({
      id: deliveryConsignments.id,
      partyId: deliveryConsignments.partyId,
      parcelStatus: deliveryConsignments.parcelStatus,
      moneyStatus: deliveryConsignments.moneyStatus,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      counterSettledAmount: deliveryConsignments.counterSettledAmount,
    })
    .from(deliveryConsignments)
    .where(and(
      inArray(deliveryConsignments.partyId, partyIds),
      inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]),
      isNull(deliveryConsignments.returnDeclaredAt),
      branchId == null ? undefined : sql`${deliveryConsignments.branchId} = ${branchId}`,
    ));
  const liveIds = liveParcels.map((p) => Number(p.id));
  const custodyRows = liveIds.length
    ? await tx
        .select({ consignmentId: deliveryLedgerEntries.consignmentId, custody: ledgerCustodySumSql })
        .from(deliveryLedgerEntries)
        .where(and(isNotNull(deliveryLedgerEntries.consignmentId), inArray(deliveryLedgerEntries.consignmentId, liveIds)))
        .groupBy(deliveryLedgerEntries.consignmentId)
    : [];
  const custodyByCn = new Map(custodyRows.map((r) => [Number(r.consignmentId), String(r.custody ?? "0")]));

  const ledgerAgg = await tx
    .select({
      partyId: deliveryLedgerEntries.partyId,
      entryType: deliveryLedgerEntries.entryType,
      total: sql<string>`COALESCE(SUM(${deliveryLedgerEntries.amount}), 0)`,
    })
    .from(deliveryLedgerEntries)
    .where(inArray(deliveryLedgerEntries.partyId, partyIds))
    .groupBy(deliveryLedgerEntries.partyId, deliveryLedgerEntries.entryType);

  const ensure = (partyId: number): PartyExposureInputs => {
    let cur = out.get(partyId);
    if (!cur) {
      cur = { parcels: [], ledger: [], cashInHandLedger: "0.00" };
      out.set(partyId, cur);
    }
    return cur;
  };
  for (const p of liveParcels) {
    ensure(Number(p.partyId)).parcels.push({
      parcelStatus: p.parcelStatus,
      moneyStatus: p.moneyStatus,
      codAmount: String(p.codAmount ?? "0"),
      collectedAmount: String(p.collectedAmount ?? "0"),
      counterSettledAmount: String(p.counterSettledAmount ?? "0"),
      ledgerCustody: custodyByCn.get(Number(p.id)) ?? "0",
    });
  }
  for (const r of ledgerAgg) {
    ensure(Number(r.partyId)).ledger.push({ entryType: r.entryType, amount: String(r.total ?? "0") });
  }
  for (const inputs of Array.from(out.values())) inputs.cashInHandLedger = deriveCashInHandFromLedger(inputs.ledger);
  for (const id of partyIds) if (!out.has(id)) out.set(id, { ...EMPTY, parcels: [], ledger: [] });
  return out;
}
