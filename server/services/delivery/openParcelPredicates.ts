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
import { and, eq, sql, type SQL } from "drizzle-orm";
import type Decimal from "decimal.js";
import { deliveryConsignments, deliveryLedgerEntries } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2 } from "../money";

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
export const consignmentShortfallAssignedSql = sql<string>`(SELECT COALESCE(SUM(dle.amount), 0)
  FROM deliveryLedgerEntries dle
  WHERE dle.consignmentId = deliveryConsignments.id AND dle.entryType = 'SHORTFALL_ASSIGNED')`;

/** نفس المعنى لطردٍ واحدٍ داخل معاملة (حلقة التوريد تقرأ الطرود واحداً واحداً تحت القفل). */
export async function shortfallAssignedForConsignmentTx(tx: Tx, consignmentId: number): Promise<Decimal> {
  const row = (
    await tx
      .select({ v: sql<string>`COALESCE(SUM(${deliveryLedgerEntries.amount}), 0)` })
      .from(deliveryLedgerEntries)
      .where(and(
        eq(deliveryLedgerEntries.consignmentId, consignmentId),
        eq(deliveryLedgerEntries.entryType, "SHORTFALL_ASSIGNED"),
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
