/**
 * ═══ المُصالِح — أوّليّة التجسيد المشتركة لكلّ أنواع المستندات ═══
 *
 * يُصالح أثراً واحداً مع الحقيقة: يُنشئ صفَّ APPLY إن غاب، ثمّ يكتب ابنَ REVERSE **بالفرق** حين
 * يخالف المتبقّي في السجلّ ما تقوله القاعدة. دلتا لا نسخ: يعمل على مستندٍ سُجّل أصلاً أو لم
 * يُسجَّل، ولا يكرّر صفّاً، وأثرٌ صفريٌّ بلا صفٍّ سابق لا يُمثَّل (صفٌّ بلا معنى).
 *
 * يستعمله مُجسِّدُ فاتورة البيع (`materialize/invoice.ts`) ومُجسِّدُ تسليم أمر الشغل
 * (`materialize/workOrderDelivery.ts`) — مصدرٌ واحد لقاعدة المصالحة.
 */
import type Decimal from "decimal.js";

import type { DocumentEffectKind, DocumentType } from "@shared/documentEffects";

import type { Tx } from "../../../db";
import { loadApplyEffects, recordEffect, recordReverseRow } from "../effectLedger";
import type { PendingEffect, ReversalRun } from "../types";

export const MATERIALIZE_REASON = "تجسيدٌ من الحقيقة قبل العكس";

export type EffectKey = string;
export function keyOf(kind: DocumentEffectKind, table: string, rowId: number): EffectKey {
  return `${kind}|${table}|${rowId}`;
}

export interface TruthEffect {
  kind: DocumentEffectKind;
  table: string;
  rowId: number;
  /** قيمةُ APPLY حين يُنشأ الصفُّ لأوّل مرّة. */
  applyAmount: Decimal;
  applyQuantity: number;
  /** ما يجب أن يكون متبقّياً الآن بحسب الحقيقة. */
  targetAmount: Decimal;
  targetQuantity: number;
  payload: unknown;
}

/** سجلُّ الآثار القائمة للمستند في نطاقٍ واحد — مُفهرَسٌ بهويّة الأثر، تحت قفل. */
export async function loadExistingEffects(
  tx: Tx,
  documentType: DocumentType,
  documentId: number,
  scope: string,
): Promise<Map<EffectKey, PendingEffect>> {
  const existing = new Map<EffectKey, PendingEffect>();
  for (const row of await loadApplyEffects(tx, documentType, documentId, { kind: "ALL", operationScopes: [scope] }, { onlyOutstanding: false })) {
    if (row.effectTable && row.effectRowId != null) existing.set(keyOf(row.effectKind, row.effectTable, row.effectRowId), row);
  }
  return existing;
}

export async function reconcile(
  tx: Tx,
  run: ReversalRun,
  args: { scope: string; branchId: number; existing: Map<EffectKey, PendingEffect> },
  truth: TruthEffect,
): Promise<void> {
  const key = keyOf(truth.kind, truth.table, truth.rowId);
  let current = args.existing.get(key);
  // أثرٌ صفريٌّ بلا صفٍّ سابق (مثل مساهمةٍ صفريّة في الذمّة لفاتورةٍ مسدَّدة) لا يُمثَّل: صفٌّ بلا معنى.
  if (!current && truth.applyAmount.isZero() && truth.applyQuantity === 0 && truth.targetAmount.isZero() && truth.targetQuantity === 0) return;
  if (!current) {
    const id = await recordEffect(
      tx,
      {
        documentType: run.documentType,
        documentId: run.documentId,
        effectKind: truth.kind,
        effectTable: truth.table,
        effectRowId: truth.rowId,
        signedAmount: truth.applyAmount,
        signedQuantity: truth.applyQuantity,
        branchId: args.branchId,
        reason: MATERIALIZE_REASON,
        scope: args.scope,
        payloadJson: truth.payload,
      },
      run.actor,
    );
    current = {
      id,
      documentType: run.documentType,
      documentId: run.documentId,
      effectKind: truth.kind,
      effectTable: truth.table,
      effectRowId: truth.rowId,
      branchId: args.branchId,
      scope: args.scope,
      payloadJson: truth.payload,
      signedAmount: truth.applyAmount,
      signedQuantity: truth.applyQuantity,
      outstandingAmount: truth.applyAmount,
      outstandingQuantity: truth.applyQuantity,
    };
    args.existing.set(key, current);
  }
  const deltaAmount = truth.targetAmount.minus(current.outstandingAmount);
  const deltaQuantity = truth.targetQuantity - current.outstandingQuantity;
  if (deltaAmount.isZero() && deltaQuantity === 0) return;
  await recordReverseRow(
    tx,
    current,
    {
      signedAmount: deltaAmount,
      signedQuantity: deltaQuantity,
      reason: MATERIALIZE_REASON,
      payloadJson: { reconciled: true, from: current.outstandingAmount.toFixed(4), to: truth.targetAmount.toFixed(4), fromQty: current.outstandingQuantity, toQty: truth.targetQuantity },
    },
    run.actor,
  );
  current.outstandingAmount = truth.targetAmount;
  current.outstandingQuantity = truth.targetQuantity;
}
