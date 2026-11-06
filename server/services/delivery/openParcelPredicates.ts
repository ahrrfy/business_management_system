/**
 * مسانِدُ SQL المشتركة لـ«الطرد المفتوح المتأخّر» — م١ (PR-2).
 *
 * التعريف الواحد (Slice DFP1، قرار المالك ٣٠/٨): طردٌ للجهة مضى على إسناده أكثر من
 * `maxOpenParcelAgeDays` يوماً ولم يُحسَم ماليّاً — `moneyStatus ∈ (UNSETTLED, PARTIAL)` وليس
 * مُرجَعاً ولا ملغى. حالتُه الفيزيائيّة لا تنقض ذلك: المُسلَّم بنقدٍ لم يُورَّد متأخّرٌ.
 *
 * يقرؤه حارسُ الإسناد (`parties.assertNoStaleOpenParcelsTx`) وعدّادُ اللوحة (`board.ts`) — صيغةٌ
 * واحدة، وإلّا عرضت اللوحة «0 متأخّر» على جهةٍ يرفض الحارسُ إسنادَها.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { deliveryConsignments, deliveryLedgerEntries } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2 } from "../money";
import { effectiveDeliveryLedgerEntrySql, verifiedConsignmentLedgerRows } from "./legacyLedger";

/**
 * م١ (PR-2) — **عجزُ التسليم المُقيَّد على الطرد** (`SHORTFALL_ASSIGNED` بمرجع الطرد، Slice DFP1):
 * حين يُختَم التسليم بعجزٍ مصنَّف تُقفَل الفاتورة كاملةً ويُحمَّل الفرقُ على الجهة، لكنّ
 * `codAmount` يبقى كاملاً و`collectedAmount` صفراً ⇒ كلُّ من يحسب «المتبقّي الحيّ» بـ
 * `codAmount − collectedAmount − counterSettledAmount` يطالب الجهةَ بنقدٍ لم تقبضه قطّ، فيعلق
 * الطردُ PARTIAL إلى الأبد أو يُقيَّد العجزُ مرّتين. المتبقّي الحيّ الصحيح يطرح هذا العجز.
 *
 * صيغةٌ واحدة يقرؤها التوريد (`remittance.ts`) والتسوية اليوميّة (`dailySettlement.ts`) واللوحة.
 * المرجعُ الخارجيّ يُكتب باسم الجدول حرفياً: تأهيلُ Drizzle للعمود داخل استعلامٍ مترابط لا يُعتمَد
 * عليه ([[drizzle-correlated-subquery-column-qualification]]).
 */
export const consignmentShortfallAssignedSql = sql<string>`(SELECT COALESCE(SUM(CASE
    WHEN dle.entryType = 'SHORTFALL_ASSIGNED' THEN dle.amount
    WHEN dle.entryType = 'SHORTFALL_SETTLED' THEN -dle.amount
    ELSE 0 END), 0)
  FROM deliveryLedgerEntries dle
  WHERE dle.consignmentId = deliveryConsignments.id
    AND ${effectiveDeliveryLedgerEntrySql("dle")}
    AND dle.entryType IN ('SHORTFALL_ASSIGNED','SHORTFALL_SETTLED'))`;

/** Open carrier exposure, distinct from both customer credit and cash already in custody. */
export const consignmentOpenCodDueSql = sql<string>`CASE
  WHEN ${deliveryConsignments.status} IN ('DISPATCHED','PARTIAL') AND ${deliveryConsignments.returnDeclaredAt} IS NULL
  THEN GREATEST(${deliveryConsignments.codAmount} - ${deliveryConsignments.collectedAmount}
    - ${deliveryConsignments.counterSettledAmount} - ${consignmentShortfallAssignedSql}, 0)
  ELSE 0 END`;

/** نفس المعنى لطردٍ واحدٍ داخل معاملة (حلقة التوريد تقرأ الطرود واحداً واحداً تحت القفل). */
export async function shortfallAssignedForConsignmentTx(
  tx: Pick<Tx, "select">, consignmentId: number, identity?: { partyId: number; branchId: number },
): Promise<Decimal> {
  if (identity) {
    const rows = await tx.select().from(deliveryLedgerEntries).where(and(
      eq(deliveryLedgerEntries.consignmentId, consignmentId),
      inArray(deliveryLedgerEntries.entryType, ["SHORTFALL_ASSIGNED", "SHORTFALL_SETTLED"]),
    )).for("share");
    const effective = verifiedConsignmentLedgerRows({ id: consignmentId, ...identity }, rows, "تعذر مطابقة عجز الشحنة");
    const amount = round2(effective.reduce((sum, row) => row.entryType === "SHORTFALL_ASSIGNED"
      ? sum.plus(money(row.amount)) : sum.minus(money(row.amount)), money(0)));
    if (amount.lt(0)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
      what: "تعذر مطابقة عجز الشحنة", why: "تسوية العجز تتجاوز العجز المسجل",
      doThis: "راجع قيود العجز قبل التوريد",
    }) });
    return amount;
  }
  const row = (
    await tx
      .select({ v: sql<string>`COALESCE(SUM(CASE
        WHEN ${deliveryLedgerEntries.entryType} = 'SHORTFALL_ASSIGNED' THEN ${deliveryLedgerEntries.amount}
        WHEN ${deliveryLedgerEntries.entryType} = 'SHORTFALL_SETTLED' THEN -${deliveryLedgerEntries.amount}
        ELSE 0 END), 0)` })
      .from(deliveryLedgerEntries)
      .where(and(
        eq(deliveryLedgerEntries.consignmentId, consignmentId),
        effectiveDeliveryLedgerEntrySql(),
        inArray(deliveryLedgerEntries.entryType, ["SHORTFALL_ASSIGNED", "SHORTFALL_SETTLED"]),
      ))
  )[0];
  return round2(money(row?.v ?? "0"));
}

export function staleOpenParcelCondition(daysExpr: SQL | number): SQL {
  const days = typeof daysExpr === "number" ? sql`${daysExpr}` : daysExpr;
  return sql`${deliveryConsignments.dispatchedAt} IS NOT NULL
    AND TIMESTAMPDIFF(DAY, ${deliveryConsignments.dispatchedAt}, NOW()) > ${days}
    AND ${deliveryConsignments.moneyStatus} IN ('UNSETTLED', 'PARTIAL')
    AND ${deliveryConsignments.parcelStatus} NOT IN ('RETURNED', 'CANCELLED')`;
}
