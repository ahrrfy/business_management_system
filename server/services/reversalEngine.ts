/**
 * ═══ محرّك العكس الواحد — القانون ق٧ ═══
 *
 * ما قبل هذا الملفّ: ٢٠+ تنفيذاً يدوياً للعكس منتشرة في الخدمات (`sale/cancel`،
 * `returnService`، `purchase/*`، `installment/*`، `digitalSale/*`، …) بلا تجريدٍ مشترك.
 * `cancel` نسخةٌ يدوية من `returnService` وقد اختلفتا: الكوبون لا يُحرَّر، وحارس الإرسالية
 * تعليقٌ يصف سلوكاً غير موجود.
 *
 * **م٢ (هذه الشريحة): من سجلّ مرآةٍ إلى منفّذِ تعويض.** كان `reverse()` يكتب صفوف REVERSE بلا
 * أن يمسّ مخزوناً ولا قيداً ولا رصيداً (ملاحظة Codex LC06). الآن:
 *
 *   ١) يقرأ آثارَ APPLY **بمتبقّيها** (APPLY + Σ أبناء REVERSE) تحت قفل — العكسُ الجزئيّ مسموح.
 *   ٢) يجمعها حسب النوع ويُمرّرها بترتيبٍ ماليّ ثابت (`EFFECT_KIND_EXECUTION_ORDER`) إلى
 *      **منفّذي التعويض** (`server/services/reversal/executors/*`) الذين يُجرون الفعلَ الحقيقيّ:
 *      حركةُ مخزون عبر `applyMovement` · قيدٌ عبر `postEntry` · رصيدٌ عبر `adjust*Balance` ·
 *      ردُّ مالٍ بإيصالٍ وقيد · تحريرُ كوبون.
 *   ٣) يكتب صفَّ REVERSE **من نتيجة المنفّذ فعلاً** (مرجعُ صفّ التعويض، والمبلغُ المعكوس).
 *   ٤) يفرض الثابت Σ = 0 على كلّ نوعٍ عُكس كاملاً، ويُعيد للمستدعي ما تُرك مفتوحاً بقصدٍ معلن.
 *
 * نوعٌ بلا منفّذ **يرمي `NOT_IMPLEMENTED`** — لا مرآةَ صامتة. والوضعُ `MIRROR` يبقى للاختبارات
 * الاصطناعيّة ولمن يريد التوثيقَ بلا تنفيذ **صراحةً**.
 *
 * قواعدُ ملزمة: كلُّ عمليّةٍ داخل معاملةٍ قائمة (`Tx`)، الخدمةُ لا تقرأ `ctx` — تستقبل `Actor`،
 * والمالُ عبر `decimal.js` حصراً.
 */
import { TRPCError } from "@trpc/server";

import { appErrorMessage } from "@shared/errors";
import type {
  DocumentEffectKind,
  DocumentType,
  ReversalScope,
} from "@shared/documentEffects";

import type { Tx } from "../db";
import {
  assertReversalBalancedTx,
  loadApplyEffects,
  recordEffect,
  recordReverseRow,
  summarizeEffects,
} from "./reversal/effectLedger";
import { resolveExecutor } from "./reversal/registry";
import {
  executionRank,
  type ExecutionOutcome,
  type ExecutorRegistry,
  type PendingEffect,
  type ReversalDecisions,
  type ReversalRun,
} from "./reversal/types";
import type { Actor } from "./tx";

export { recordEffect, assertReversalBalancedTx, summarizeEffects };
export type { RecordEffectInput } from "./reversal/effectLedger";

export interface ReverseOptions {
  /**
   * `EXECUTE` (الافتراض): تعويضٌ فعليٌّ عبر المنفّذين ثمّ تسجيل.
   * `MIRROR`: تسجيلُ صفوف REVERSE فقط — للاختبارات الاصطناعيّة ولمستدعٍ نفّذ التعويضَ بيده
   * ويريد توثيقَه (استعمالٌ صريحٌ لا افتراض).
   */
  mode?: "EXECUTE" | "MIRROR";
  /** منفّذون يخصّون المستند — يعلون على السجلّ الافتراضيّ. */
  executors?: ExecutorRegistry;
  /** القراراتُ البشريّة (رافدُ الردّ، مصيرُ البضاعة، النكهة). */
  decisions?: ReversalDecisions;
  /** ذاكرةٌ مشتركة بين المنفّذين — يُمرّرها المستدعي ليقرأ ما تركوه فيها بعد العكس. */
  state?: Map<string, unknown>;
}

export interface OpenEffectReport {
  effectId: number;
  effectKind: DocumentEffectKind;
  status: "LEFT_OPEN" | "PARTIAL";
  why: string;
}

export interface ReverseResult {
  reversedCount: number;
  reversedEffectIds: number[];
  /** ما بقي مفتوحاً بقصدٍ معلن — لا صمت. */
  leftOpen: OpenEffectReport[];
  run: ReversalRun;
}

function assertReason(reason: string): string {
  if (!reason || !reason.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "سببُ العكس مطلوب",
        why: "كلّ عكسٍ ماليٍّ يلزمه سببٌ موثَّق كي يظهر في سجلّ التدقيق — لا عكسَ صامتاً",
        doThis: "أدخل سبباً صريحاً في حقل «سبب العكس» ثمّ أعد المحاولة",
      }),
    });
  }
  return reason.trim();
}

function groupByKind(effects: readonly PendingEffect[]): Map<DocumentEffectKind, PendingEffect[]> {
  const groups = new Map<DocumentEffectKind, PendingEffect[]>();
  for (const effect of effects) {
    const list = groups.get(effect.effectKind) ?? [];
    list.push(effect);
    groups.set(effect.effectKind, list);
  }
  return new Map(
    Array.from(groups.entries()).sort(([a], [b]) => executionRank(a) - executionRank(b)),
  );
}

/**
 * يعكس آثار المستند: يقرأ صفوف APPLY التي بقي منها متبقٍّ، ويُنفّذ التعويض لكلّ نوعٍ عبر منفّذه،
 * ثمّ يكتب صفَّ REVERSE مقابلاً بما نُفّذ فعلاً. الفعلُ ذرّيّ ضمن المعاملة نفسها.
 *
 * `scope` يقصر العكسَ على أنواعٍ و/أو نطاقاتِ عمليّاتٍ محدَّدة. الاستدعاءُ على مستندٍ مكتمل
 * العكس لا يفعل شيئاً (idempotent).
 */
export async function reverse(
  tx: Tx,
  documentType: DocumentType,
  documentId: number,
  scope: ReversalScope,
  reason: string,
  actor: Actor,
  options: ReverseOptions = {},
): Promise<ReverseResult> {
  const cleanReason = assertReason(reason);
  const run: ReversalRun = {
    documentType,
    documentId,
    reason: cleanReason,
    actor,
    decisions: options.decisions ?? {},
    state: options.state ?? new Map<string, unknown>(),
  };
  const pending = await loadApplyEffects(tx, documentType, documentId, scope, { onlyOutstanding: true });
  if (pending.length === 0) {
    return { reversedCount: 0, reversedEffectIds: [], leftOpen: [], run };
  }

  const insertedIds: number[] = [];
  const leftOpen: OpenEffectReport[] = [];
  const mode = options.mode ?? "EXECUTE";

  if (mode === "MIRROR") {
    for (const effect of pending) {
      insertedIds.push(
        await recordReverseRow(
          tx,
          effect,
          {
            signedAmount: effect.outstandingAmount.negated(),
            signedQuantity: -effect.outstandingQuantity,
            reason: cleanReason,
          },
          actor,
        ),
      );
    }
  } else {
    for (const [kind, group] of Array.from(groupByKind(pending).entries())) {
      const executor = resolveExecutor(kind, options.executors);
      const outcomes: ExecutionOutcome[] = await executor(tx, group, run);
      if (outcomes.length !== group.length) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `منفّذ ${kind} أعاد ${outcomes.length} نتيجة لـ${group.length} أثراً — خللٌ برمجيّ`,
        });
      }
      for (let i = 0; i < group.length; i++) {
        const effect = group[i]!;
        const outcome = outcomes[i]!;
        if (outcome.status === "LEFT_OPEN") {
          leftOpen.push({ effectId: effect.id, effectKind: kind, status: "LEFT_OPEN", why: outcome.why });
          continue;
        }
        if (outcome.status === "PARTIAL") {
          leftOpen.push({ effectId: effect.id, effectKind: kind, status: "PARTIAL", why: outcome.why });
        }
        insertedIds.push(
          await recordReverseRow(
            tx,
            effect,
            {
              signedAmount: outcome.signedAmount ?? effect.outstandingAmount.negated(),
              signedQuantity: outcome.signedQuantity ?? -effect.outstandingQuantity,
              reason: cleanReason,
              effectTable: outcome.effectTable,
              effectRowId: outcome.effectRowId,
              payloadJson: outcome.payloadJson,
            },
            actor,
          ),
        );
      }
    }
  }

  // الثابتُ يُفرض على الأنواع التي عُكست كاملاً وحدها؛ المتروكُ مفتوحاً بقصدٍ معلن يُعاد للمستدعي.
  const openKinds = new Set(leftOpen.map((o) => o.effectKind));
  const balancedKinds = Array.from(new Set(pending.map((p) => p.effectKind))).filter((k) => !openKinds.has(k));
  const balanceScope: ReversalScope =
    scope.kind === "ONLY"
      ? { kind: "ONLY", effectKinds: scope.effectKinds.filter((k) => balancedKinds.includes(k)), operationScopes: scope.operationScopes }
      : { kind: "ONLY", effectKinds: balancedKinds, operationScopes: scope.operationScopes };
  await assertReversalBalancedTx(tx, documentType, documentId, balanceScope);

  return { reversedCount: insertedIds.length, reversedEffectIds: insertedIds, leftOpen, run };
}
