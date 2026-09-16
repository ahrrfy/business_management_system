/**
 * ═══ تجسيدُ آثار **تسليم أمر الشغل** من الحقيقة — المُصالِح ═══
 *
 * التسليمُ (`workOrder/deliver.ts`) يكتب: قيدَ SALE خدميّاً على فاتورة الأمر، ذمّةً على العميل
 * بغير المسدَّد، ومقبوضاتٍ (عربونٌ سابق + دفعةُ التسليم + توريدُ المندوب). كاتبُه ملكُ فريقٍ آخر،
 * وكلُّ تسليمٍ قائم كُتب قبل المحرّك ⇒ يُصالَح السجلُّ من الحقيقة قبل العكس (نطاق `delivery`).
 *
 *  · `LEDGER_ENTRY` = قيد SALE للفاتورة؛ متبقّيه `SALE.amount + Σ RETURN.amount`.
 *  · `CUSTOMER_BALANCE` = غيرُ المسدَّد (`total − المقبوض الأصليّ قبل ردوده`) — ما أضافه التسليم إلى الذمّة.
 *  · `PAID_AMOUNT` لكلّ **مصدر قبضٍ** (إيصالُ IN بهويّته): APPLY = ما قُبض به، ومتبقّيه = ما تبقّى
 *    يُردّ منه بعد الردود السابقة — كما تحسبه أدلّةُ `reverseEvidence` (خطّةُ الردّ لكلّ مصدر).
 */
import type Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";

import { accountingEntries } from "../../../../drizzle/schema";
import type { Tx } from "../../../db";
import { money, round2 } from "../../money";
import { readWorkOrderDeliveryContext, workOrderDeliveryFigures } from "../executors/workOrderDelivery";
import type { ReversalRun } from "../types";
import { loadExistingEffects, reconcile } from "./reconcile";

export const WORK_ORDER_DELIVERY_SCOPE = "delivery";

export interface CollectionSourceTruth {
  receiptId: number;
  /** ما قُبض بهذا الإيصال على هذا الأمر/الفاتورة. */
  amount: Decimal;
  method: string;
  /** ما تبقّى يُردّ منه بعد الردود السابقة (Σ خطّة الردّ له). */
  remaining: Decimal;
}

export async function materializeWorkOrderDeliveryEffects(
  tx: Tx,
  run: ReversalRun,
  sources: readonly CollectionSourceTruth[],
): Promise<void> {
  const ctx = readWorkOrderDeliveryContext(run);
  const invoiceId = Number(ctx.inv.id);
  const branchId = Number(ctx.wo.branchId);
  const existing = await loadExistingEffects(tx, run.documentType, run.documentId, WORK_ORDER_DELIVERY_SCOPE);
  const args = { scope: WORK_ORDER_DELIVERY_SCOPE, branchId, existing };
  const { safeUnpaid } = workOrderDeliveryFigures(ctx);

  // ═══ قيدُ البيع الخدميّ ═══
  const entries = await tx
    .select({ id: accountingEntries.id, entryType: accountingEntries.entryType, amount: accountingEntries.amount })
    .from(accountingEntries)
    .where(and(eq(accountingEntries.invoiceId, invoiceId), sql`${accountingEntries.entryType} IN ('SALE', 'RETURN')`));
  const saleEntry = entries.find((e) => e.entryType === "SALE");
  if (saleEntry) {
    const returnSum = entries.filter((e) => e.entryType === "RETURN").reduce((s, e) => s.plus(money(e.amount)), money(0));
    await reconcile(tx, run, args, {
      kind: "LEDGER_ENTRY",
      table: "accountingEntries",
      rowId: Number(saleEntry.id),
      applyAmount: money(saleEntry.amount),
      applyQuantity: 0,
      targetAmount: round2(money(saleEntry.amount).plus(returnSum)),
      targetQuantity: 0,
      payload: { entryType: "SALE", invoiceId },
    });
  }

  // ═══ ذمّةُ العميل — ما أضافه التسليم (غيرُ المسدَّد) ═══
  if (ctx.wo.customerId != null) {
    await reconcile(tx, run, args, {
      kind: "CUSTOMER_BALANCE",
      table: "customers",
      rowId: Number(ctx.wo.customerId),
      applyAmount: safeUnpaid,
      applyQuantity: 0,
      targetAmount: safeUnpaid,
      targetQuantity: 0,
      payload: { customerId: Number(ctx.wo.customerId), invoiceId },
    });
  }

  // ═══ المقبوضات مصدراً مصدراً ═══
  for (const source of sources) {
    await reconcile(tx, run, args, {
      kind: "PAID_AMOUNT",
      table: "receipts",
      rowId: source.receiptId,
      applyAmount: round2(source.amount),
      applyQuantity: 0,
      targetAmount: round2(source.remaining),
      targetQuantity: 0,
      payload: { invoiceId, method: source.method, collected: source.amount.toFixed(2) },
    });
  }
}
