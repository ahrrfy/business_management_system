import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import type { DB } from "../../db";
import { verifyPostingIntentEvidence } from "../accounting/postingEngine";
import { money, toDbMoney } from "../money";

/** Read the separate consignor COGS once; amount also contains gifts and is not a cost basis. */
export async function readConsignmentCogs(db: DB, from: string, to: string, branchId?: number) {
  const result = await db.execute(sql`
    SELECT ae.id, ae.dedupeKey, ae.postingProfile, ae.postingIntentJson, ae.postingIntentHash,
      CAST(ae.amount AS CHAR) AS amount, CAST(ae.cost AS CHAR) AS cost,
      CAST(original.amount AS CHAR) AS originalAmount, CAST(original.cost AS CHAR) AS originalCost,
      original.notes AS originalNotes,
      (EXISTS(SELECT 1 FROM invoiceItems giftItem WHERE giftItem.invoiceId=ae.invoiceId AND giftItem.isGift=TRUE)
        AND NOT EXISTS(SELECT 1 FROM invoiceItems paidItem WHERE paidItem.invoiceId=ae.invoiceId AND paidItem.isGift=FALSE)) AS originalGiftOnly
    FROM accountingEntries ae
    LEFT JOIN accountingEntries original ON original.entryType='PURCHASE'
      AND original.dedupeKey=CONCAT('CONSIG:',ae.invoiceId,':',ae.supplierId)
      AND original.branchId=ae.branchId
    WHERE ae.entryType='PURCHASE' AND ae.supplierId IS NOT NULL
      AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
      ${branchId ? sql`AND ae.branchId=${branchId}` : sql``}
      AND (ae.postingProfile='PURCHASE_CONSIGNMENT' OR (ae.postingProfile IS NULL AND (
        ae.dedupeKey REGEXP '^CONSIG:[0-9]+:[0-9]+$'
        OR ae.dedupeKey LIKE 'CONSIG:DELIVERY_RETURN:%'
        OR (ae.invoiceId IS NOT NULL AND ae.purchaseOrderId IS NULL)
        OR ae.notes LIKE 'عكس استحقاق أمانة%'
        OR ae.notes LIKE 'استحقاق تلف مرتجع أمانة%'
      )))
  `);
  const rows = ((result as unknown[][])[0] ?? result) as Array<{
    id: number; dedupeKey: string | null; postingProfile: string | null;
    postingIntentJson: unknown; postingIntentHash: string | null;
    amount: string; cost: string; originalAmount: string | null; originalCost: string | null;
    originalNotes: string | null; originalGiftOnly: number;
  }>;
  let total = money(0);
  for (const row of rows) {
    if (row.postingIntentJson != null || row.postingIntentHash != null) {
      const intent = verifyPostingIntentEvidence({ expectedEntryType: "PURCHASE",
        postingProfile: row.postingProfile, postingIntentJson: row.postingIntentJson,
        postingIntentHash: row.postingIntentHash, source: { amount: row.amount } });
      for (const line of intent.lines) if (line.role === "COGS")
        total = total.plus(money(line.debit).minus(line.credit));
      continue;
    }
    let cost = money(row.cost);
    // The OFF delivery-return writer saved zero cost. Its full reversal has a
    // unique source key; only replay the original recorded paid share, never amount.
    if (row.dedupeKey?.startsWith("CONSIG:DELIVERY_RETURN:") && cost.isZero()) {
      const provenGiftZero = Number(row.originalGiftOnly) === 1 || (row.originalAmount != null
        && row.originalNotes === `استحقاق أمانة؛ COGS مبسّط=0.00؛ هدايا=${toDbMoney(money(row.originalAmount))}`);
      if (row.originalCost == null || (money(row.originalCost).isZero() && !provenGiftZero)
        || row.originalAmount == null || money(row.originalAmount).lte(0)
        || money(row.originalCost).lt(0) || money(row.originalCost).gt(row.originalAmount)
        || !money(row.amount).equals(money(row.originalAmount).neg())) {
        throw new TRPCError({ code: "PRECONDITION_FAILED",
          message: appErrorMessage({ what: "تعذر إثبات تكلفة عكس الأمانة",
            why: `القيد ${row.id} لا يملك لقطة أصل مكتملة ومطابقة لإعادة بناء التكلفة`,
            doThis: "افتح قيد الأمانة الأصلي والمستند المرتبط وطابق التكلفة مع المحاسب قبل اعتماد قائمة الدخل" }) });
      }
      cost = money(row.originalCost).neg();
    }
    total = total.plus(cost);
  }
  return toDbMoney(total);
}
