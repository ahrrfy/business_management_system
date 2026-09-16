/**
 * الحالةُ المشتركة لردّ المال بين منفّذ `PAID_AMOUNT` ومنفّذ `CUSTOMER_BALANCE`.
 *
 * مفتاحٌ واحد في `run.state` بدل تمرير أرقامٍ عبر مصفوفات: المنفّذُ الأوّل يكتب ما رُدّ فوراً
 * وما بقي معلَّقاً، والثاني يقرأ المعلَّق ليُبقيه رصيداً دائناً للعميل.
 */
import Decimal from "decimal.js";

import type { ReversalRun } from "../types";

export const REFUND_STATE_KEY = "refund";

export interface RefundRunState {
  /** ما خرج فعلاً الآن (نقد/بطاقة). */
  materialized: Decimal;
  /** ما بقي بانتظار اعتماد سندٍ غير نقديّ — رصيدٌ دائنٌ للعميل حتى يُصرَف. */
  deferred: { amount: Decimal; receiptId: number | null; method: string } | null;
  refundReceiptId: number | null;
  pendingVoucherNumber: string | null;
}

export function writeRefundState(run: ReversalRun, state: RefundRunState): void {
  run.state.set(REFUND_STATE_KEY, state);
}

export function readRefundState(run: ReversalRun): RefundRunState {
  const state = run.state.get(REFUND_STATE_KEY) as RefundRunState | undefined;
  return state ?? { materialized: new Decimal(0), deferred: null, refundReceiptId: null, pendingVoucherNumber: null };
}

