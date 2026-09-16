/**
 * ═══ سجلُّ الأثر — أوّليّات الكتابة والقراءة على `documentEffects` ═══
 *
 * مفصولةٌ عن `reversalEngine.ts` كي يستوردها المنفّذون بلا دورة استيراد (المحرّك يستورد
 * السجلَّ والمنفّذين، والمنفّذون يستوردون السجلَّ وحده).
 *
 * الثابتُ المحروس: Σ signedAmount وΣ signedQuantity لكل (documentType, documentId, effectKind)
 * في النطاق المعكوس = 0 بعد اكتمال العكس. ⭐ **العكسُ الجزئيّ مسموح**: لصفّ APPLY أكثرُ من
 * صفِّ REVERSE واحد (لا قيدَ UNIQUE على `reversalOfEffectId` — هجرة 0329)، و«المتبقّي» =
 * APPLY + Σ أبنائه. مرتجعٌ جزئيٌّ سابق يصير ابناً جزئياً، والإلغاء يعكس ما بقي.
 *
 * قواعدُ ملزمة (§٥): كلُّ شيء داخل `Tx`، المالُ عبر `decimal.js` حصراً، ولا `parseFloat`/`Number`
 * على مبلغ.
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { appErrorMessage } from "@shared/errors";
import type {
  DocumentEffectKind,
  DocumentType,
  ReversalScope,
} from "@shared/documentEffects";

import { documentEffects, type InsertDocumentEffect } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import type { Actor } from "../tx";
import type { PendingEffect } from "./types";

/**
 * حمولةُ تسجيل أثرٍ جديد (APPLY). `signedAmount` قد يكون سلسلةَ عملة ("1450.99") أو Decimal،
 * ويُحوَّل إلى تمثيلٍ نصّيٍّ آمنٍ للتخزين عند الكتابة.
 */
export interface RecordEffectInput {
  documentType: DocumentType;
  documentId: number;
  effectKind: DocumentEffectKind;
  effectTable?: string | null;
  effectRowId?: number | null;
  /** موقَّع: موجب زيادة، سالب نقصان. الصفرُ مسموحٌ لأثرٍ رمزيّ. */
  signedAmount?: string | number | Decimal;
  /** موقَّع لحركات المخزون بوحدة الأساس. */
  signedQuantity?: number;
  branchId?: number | null;
  reason?: string | null;
  scope?: string | null;
  payloadJson?: unknown;
}

/**
 * يحوّل قيمةً ماليةً إلى تمثيلٍ نصّيٍّ بدقّةٍ آمنة (٤ منازل — عمود `decimal(15,4)`).
 * يرفض NaN وغيرَ المنتهي، ولا يستعمل `parseFloat`/`Number`.
 */
export function toEffectAmountString(value: string | number | Decimal | undefined | null): string {
  if (value === undefined || value === null || value === "") return "0.0000";
  const dec = value instanceof Decimal ? value : new Decimal(value as string | number);
  if (!dec.isFinite()) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "مبلغُ أثرٍ غيرُ منتهٍ — لا يمكن تسجيله",
    });
  }
  return dec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

/** ينحت قيمةً صحيحةً موقَّعة لحركة المخزون. يرفض غير الأعداد الصحيحة. */
export function toEffectQuantity(value: number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "كمّيةُ أثرٍ ليست عدداً صحيحاً موقَّعاً",
    });
  }
  return value;
}

/** يسجّل صفَّ APPLY داخل المعاملة الحاليّة ويُرجع مُعرِّفه. */
export async function recordEffect(
  tx: Tx,
  input: RecordEffectInput,
  actor: Actor,
): Promise<number> {
  const row: InsertDocumentEffect = {
    documentType: input.documentType,
    documentId: input.documentId,
    effectKind: input.effectKind,
    phase: "APPLY",
    effectTable: input.effectTable ?? null,
    effectRowId: input.effectRowId ?? null,
    signedAmount: toEffectAmountString(input.signedAmount),
    signedQuantity: toEffectQuantity(input.signedQuantity),
    branchId: input.branchId ?? actor.branchId ?? null,
    actorUserId: actor.userId ?? null,
    reversalOfEffectId: null,
    reason: input.reason ?? null,
    scope: input.scope ?? null,
    payloadJson: (input.payloadJson ?? null) as InsertDocumentEffect["payloadJson"],
  };
  const insertResult = await tx.insert(documentEffects).values(row);
  return extractInsertId(insertResult);
}

/** هويّةُ صفّ APPLY الذي يُكتب له ابنُ REVERSE. */
export interface ReverseTarget {
  id: number;
  documentType: DocumentType;
  documentId: number;
  effectKind: DocumentEffectKind;
  effectTable: string | null;
  effectRowId: number | null;
  branchId: number | null;
  scope: string | null;
  payloadJson: unknown;
}

/**
 * يكتب صفَّ REVERSE ابناً لصفّ APPLY. **جزئيٌّ مسموح** — الابنُ يحمل ما عُكس فعلاً لا كاملَ الأصل.
 * `effectTable/effectRowId` مرجعُ صفِّ التعويض الحقيقيّ إن عُرف، وإلّا مرجعُ الأصل.
 */
export async function recordReverseRow(
  tx: Tx,
  target: ReverseTarget,
  input: {
    signedAmount: Decimal | string | number;
    signedQuantity: number;
    reason: string;
    effectTable?: string | null;
    effectRowId?: number | null;
    payloadJson?: unknown;
  },
  actor: Actor,
): Promise<number> {
  const reverseRow: InsertDocumentEffect = {
    documentType: target.documentType,
    documentId: target.documentId,
    effectKind: target.effectKind,
    phase: "REVERSE",
    effectTable: input.effectTable === undefined ? target.effectTable : input.effectTable,
    effectRowId: input.effectRowId === undefined ? target.effectRowId : input.effectRowId,
    signedAmount: toEffectAmountString(input.signedAmount),
    signedQuantity: toEffectQuantity(input.signedQuantity),
    branchId: target.branchId ?? null,
    actorUserId: actor.userId ?? null,
    reversalOfEffectId: Number(target.id),
    reason: input.reason,
    scope: target.scope ?? null,
    payloadJson: (input.payloadJson === undefined ? target.payloadJson : input.payloadJson) as InsertDocumentEffect["payloadJson"],
  };
  const result = await tx.insert(documentEffects).values(reverseRow);
  return extractInsertId(result);
}

/** mysql2 يُعيد `[rows, fields]` من `execute` الخامّ؛ نمسك rows بأمانٍ لكلا الصيغتَين. */
function rowsOf<T>(execResult: unknown): T[] {
  if (Array.isArray(execResult)) return (execResult[0] as T[]) ?? [];
  return ((execResult as { rows?: T[] })?.rows ?? []) as T[];
}

function parsePayload(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value ?? null;
}

interface RawApplyRow {
  id: number | string;
  documentType: string;
  documentId: number | string;
  effectKind: string;
  effectTable: string | null;
  effectRowId: number | string | null;
  branchId: number | string | null;
  scope: string | null;
  payloadJson: unknown;
  signedAmount: string | number;
  signedQuantity: number | string;
  reversedAmount: string | number | null;
  reversedQuantity: number | string | null;
}

function scopeFilters(scope: ReversalScope) {
  const kindFilter =
    scope.kind === "ONLY"
      ? sql`AND a.effectKind IN (${sql.join(scope.effectKinds.map((k) => sql`${k}`), sql`, `)})`
      : sql``;
  const opScopeFilter =
    scope.operationScopes && scope.operationScopes.length > 0
      ? sql`AND a.scope IN (${sql.join(scope.operationScopes.map((s) => sql`${s}`), sql`, `)})`
      : sql``;
  return { kindFilter, opScopeFilter };
}

/**
 * يقرأ صفوفَ APPLY للمستند **مع متبقّيها** (APPLY + Σ أبناء REVERSE) تحت قفل `FOR UPDATE`.
 * `onlyOutstanding = true` يقصرها على ما لم يُعكَس كلّياً بعد.
 *
 * Codex #957: قائمةُ أنواعٍ فارغةٌ في `ONLY` **قصدٌ صريحٌ بلا انتقاء**، لا فتحةً إلى ALL —
 * التوسيعُ الصامت كان يُنفّذ عكساً ماليّاً كاملاً.
 */
export async function loadApplyEffects(
  tx: Tx,
  documentType: DocumentType,
  documentId: number,
  scope: ReversalScope,
  opts: { onlyOutstanding: boolean },
): Promise<PendingEffect[]> {
  if (scope.kind === "ONLY" && scope.effectKinds.length === 0) return [];
  const { kindFilter, opScopeFilter } = scopeFilters(scope);
  const having = opts.onlyOutstanding
    ? sql`HAVING (a.signedAmount + reversedAmount) <> 0 OR (a.signedQuantity + reversedQuantity) <> 0`
    : sql``;
  const execResult = (await tx.execute(sql`
    SELECT a.id, a.documentType, a.documentId, a.effectKind, a.effectTable, a.effectRowId,
           a.branchId, a.scope, a.payloadJson, a.signedAmount, a.signedQuantity,
           COALESCE((SELECT SUM(r.signedAmount) FROM ${documentEffects} AS r
                     WHERE r.reversalOfEffectId = a.id AND r.phase = 'REVERSE'), 0) AS reversedAmount,
           COALESCE((SELECT SUM(r.signedQuantity) FROM ${documentEffects} AS r
                     WHERE r.reversalOfEffectId = a.id AND r.phase = 'REVERSE'), 0) AS reversedQuantity
    FROM ${documentEffects} AS a
    WHERE a.documentType = ${documentType}
      AND a.documentId = ${documentId}
      AND a.phase = 'APPLY'
      ${kindFilter}
      ${opScopeFilter}
    ${having}
    ORDER BY a.id ASC
    FOR UPDATE
  `)) as unknown;
  return rowsOf<RawApplyRow>(execResult).map((r) => {
    const signedAmount = new Decimal(r.signedAmount ?? 0);
    const signedQuantity = Number(r.signedQuantity ?? 0);
    return {
      id: Number(r.id),
      documentType: r.documentType as DocumentType,
      documentId: Number(r.documentId),
      effectKind: r.effectKind as DocumentEffectKind,
      effectTable: r.effectTable ?? null,
      effectRowId: r.effectRowId == null ? null : Number(r.effectRowId),
      branchId: r.branchId == null ? null : Number(r.branchId),
      scope: r.scope ?? null,
      payloadJson: parsePayload(r.payloadJson),
      signedAmount,
      signedQuantity,
      outstandingAmount: signedAmount.plus(new Decimal(r.reversedAmount ?? 0)),
      outstandingQuantity: signedQuantity + Number(r.reversedQuantity ?? 0),
    };
  });
}

/**
 * ثابتُ العكس: بعد نهاية `reverse` يجب أن يكون Σ signedAmount و Σ signedQuantity لكل
 * (documentType, documentId, effectKind) في **النطاق المعكوس** = 0. يفشل صريحاً إن وُجد تسريب.
 */
export async function assertReversalBalancedTx(
  tx: Tx,
  documentType: DocumentType,
  documentId: number,
  scope: ReversalScope,
): Promise<void> {
  if (scope.kind === "ONLY" && scope.effectKinds.length === 0) return;
  const { kindFilter, opScopeFilter } = scopeFilters(scope);
  const execResult = (await tx.execute(sql`
    SELECT a.effectKind,
           SUM(a.signedAmount)   AS sumAmount,
           SUM(a.signedQuantity) AS sumQuantity
    FROM ${documentEffects} AS a
    WHERE a.documentType = ${documentType}
      AND a.documentId   = ${documentId}
      ${kindFilter}
      ${opScopeFilter}
    GROUP BY a.effectKind
    HAVING SUM(a.signedAmount)   <> 0
        OR SUM(a.signedQuantity) <> 0
    LIMIT 1
  `)) as unknown;
  const row = rowsOf<{ effectKind: string; sumAmount: string | number | null; sumQuantity: string | number | null }>(execResult)[0];
  if (row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: `عكسٌ غيرُ متوازن — بقايا في ${row.effectKind}: مبلغ ${row.sumAmount ?? "?"}، كمّية ${row.sumQuantity ?? "?"}`,
        why: "مجموعُ آثار هذا النوع على المستند لم يعد صفراً بعد العكس، أي أنّ تعويضاً كُتب بغير ما سُجّل — أُرجعت المعاملة كاملةً فلم يتغيّر شيء",
        doThis: "أعد المحاولة مرّةً واحدة؛ وإن تكرّر فأبلغ مسؤول النظام برقم المستند ونوع الأثر المذكور",
      }),
    });
  }
}

/** قراءةٌ ملخّصة لأثر مستند (تدقيق/عرض) — لا تُستعمل داخل الكتابة. */
export async function summarizeEffects(
  tx: Tx,
  documentType: DocumentType,
  documentId: number,
) {
  const execResult = (await tx.execute(sql`
    SELECT effectKind,
           phase,
           COUNT(*)            AS rowCount,
           SUM(signedAmount)   AS sumAmount,
           SUM(signedQuantity) AS sumQuantity
    FROM ${documentEffects}
    WHERE documentType = ${documentType}
      AND documentId   = ${documentId}
    GROUP BY effectKind, phase
    ORDER BY effectKind, phase
  `)) as unknown;
  return rowsOf<{
    effectKind: string;
    phase: string;
    rowCount: string | number;
    sumAmount: string | number | null;
    sumQuantity: string | number | null;
  }>(execResult).map((r) => ({
    effectKind: r.effectKind,
    phase: r.phase,
    rowCount: Number(r.rowCount ?? 0),
    sumAmount: new Decimal(r.sumAmount ?? 0)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      .toFixed(4),
    sumQuantity: Number(r.sumQuantity ?? 0),
  }));
}
