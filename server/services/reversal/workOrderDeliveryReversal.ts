/**
 * ═══ عكسُ تسليم أمر الشغل عبر المحرّك — المدخلُ الواحد لِـ`reverseWorkOrderDeliveryInTx` ═══
 *
 * الخدمةُ تُبقي حرّاسَها وأقفالَها وحالةَ المستندات؛ وتُفوّض الأثرَ الماليّ (قيدُ العكس والهدر ·
 * الذمّة · ردُّ المقبوضات مصدراً مصدراً) إلى هنا: تجسيدٌ من الحقيقة ⇒ `reverse()` بمنفّذي أمر
 * الشغل ⇒ ملخّصٌ بما رُدّ نقداً وما بقي سنداً معلَّقاً.
 */
import type Decimal from "decimal.js";

import type { ReversalScope } from "@shared/documentEffects";

import type { Tx } from "../../db";
import { money } from "../money";
import { reverse, type OpenEffectReport } from "../reversalEngine";
import type { Actor } from "../tx";
import type { WorkOrderRefundSourcePlan } from "../workOrder/reverseDelivery";
import { DEFAULT_EXECUTORS } from "./registry";
import {
  readWorkOrderRefundState,
  workOrderDeliveryFigures,
  workOrderDeliveryLedgerExecutor,
  workOrderDeliveryRefundExecutor,
  writeWorkOrderDeliveryContext,
  type WorkOrderDeliveryContext,
} from "./executors/workOrderDelivery";
import {
  WORK_ORDER_DELIVERY_SCOPE,
  materializeWorkOrderDeliveryEffects,
  type CollectionSourceTruth,
} from "./materialize/workOrderDelivery";
import type { ExecutorRegistry, ReversalRun } from "./types";

export const WORK_ORDER_DELIVERY_EXECUTORS: ExecutorRegistry = {
  ...DEFAULT_EXECUTORS,
  LEDGER_ENTRY: workOrderDeliveryLedgerExecutor,
  PAID_AMOUNT: workOrderDeliveryRefundExecutor,
};

export const WORK_ORDER_DELIVERY_REVERSAL_SCOPE: ReversalScope = { kind: "ALL", operationScopes: [WORK_ORDER_DELIVERY_SCOPE] };

export interface ReverseWorkOrderDeliveryEffectsInput extends WorkOrderDeliveryContext {
  /** مصادرُ القبض بمتبقّيها — من أدلّة `reverseEvidence` نفسها التي بُنيت عليها الخطّة. */
  sources: readonly CollectionSourceTruth[];
  plans: readonly WorkOrderRefundSourcePlan[];
}

export interface ReverseWorkOrderDeliveryEffectsSummary {
  immediateCashRefund: Decimal;
  pendingRefundReceiptIds: number[];
  safeUnpaid: Decimal;
  total: Decimal;
  leftOpen: OpenEffectReport[];
  reversedEffectIds: number[];
}

export async function reverseWorkOrderDeliveryEffectsInTx(
  tx: Tx,
  input: ReverseWorkOrderDeliveryEffectsInput,
  actor: Actor,
): Promise<ReverseWorkOrderDeliveryEffectsSummary> {
  const state = new Map<string, unknown>();
  const run: ReversalRun = {
    documentType: "WORK_ORDER",
    documentId: Number(input.wo.id),
    reason: input.reason,
    actor,
    decisions: { flavor: "CANCEL", reasonNote: input.reason },
    state,
  };
  const { sources, ...ctx } = input;
  writeWorkOrderDeliveryContext(run, ctx);
  await materializeWorkOrderDeliveryEffects(tx, run, sources);
  const result = await reverse(tx, "WORK_ORDER", Number(input.wo.id), WORK_ORDER_DELIVERY_REVERSAL_SCOPE, input.reason, actor, {
    mode: "EXECUTE",
    executors: WORK_ORDER_DELIVERY_EXECUTORS,
    decisions: run.decisions,
    state,
  });
  const refund = readWorkOrderRefundState(result.run);
  const figures = workOrderDeliveryFigures(ctx);
  return {
    immediateCashRefund: refund.immediateCashRefund ?? money(0),
    pendingRefundReceiptIds: refund.pendingRefundReceiptIds,
    safeUnpaid: figures.safeUnpaid,
    total: figures.total,
    leftOpen: result.leftOpen,
    reversedEffectIds: result.reversedEffectIds,
  };
}
