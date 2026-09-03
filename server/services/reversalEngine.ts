/**
 * ═══ محرّك العكس الواحد — القانون ق٧ ═══
 *
 * ما قبل هذا الملفّ: ٢٠+ تنفيذاً يدوياً للعكس منتشرة في الخدمات (`sale/cancel`،
 * `returnService`، `purchase/*`، `installment/*`، `digitalSale/*`، …) بلا تجريدٍ مشترك.
 * `cancel` نسخةٌ يدوية من `returnService` وقد اختلفتا: الكوبون لا يُحرَّر، وحارس الإرسالية
 * تعليقٌ يصف سلوكاً غير موجود ويرمي بعد الكتابات.
 *
 * هذا المحرّك جسرٌ ظلّيّ: يعمل بجانب التنفيذات القائمة (لا يحلّ محلّها في هذه الشريحة)،
 * ويكتب صفَّ APPLY لكلّ أثرٍ ماليٍّ يقع في مستند، وصفَّ REVERSE مقابلاً عند العكس. الثابت
 * المحروس بعد اكتمال العكس:
 *
 *   Σ signedAmount   لكل (documentType,documentId,effectKind) = 0
 *   Σ signedQuantity لكل (documentType,documentId,effectKind) = 0
 *
 * قواعدُ ملزمة:
 *   - كلّ عمليّةٍ داخل معاملةٍ قائمة (`Tx`). الخدمةُ **لا تقرأ `ctx`** — تستقبل `Actor`.
 *   - المال عبر `decimal.js` + `money.ts` حصراً. ⛔ ممنوع `parseFloat`/`Number`.
 *   - كلّ صفٍّ يحمل مرجع الجدول والصفّ الأصليَّين (`effectTable`,`effectRowId`) كي يبقى
 *     الأثر قابلاً للمطابقة مع الحقيقة على القاعدة، وليس مجرَّد رقمٍ منفصل.
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";

import { documentEffects, type InsertDocumentEffect } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
// عرضٌ فقط — الحسابُ الفعليّ يتمّ عبر Decimal مباشرةً، وMoney لا تُحمَّل هنا كي لا يوسم
// الملفَّ استيرادٌ بلا استعمال (المدقّق `check` يرفض ذلك).
import type { Actor } from "./tx";
import type {
  DocumentEffectKind,
  DocumentType,
  ReversalScope,
} from "@shared/documentEffects";

/**
 * حمولةُ تسجيل أثرٍ جديد (APPLY). النطاقُ رقميٌّ صريح: `signedAmount` قد يكون سلسلةَ عملة
 * ("1450.99") أو Decimal، ويُحوَّل إلى تمثيلٍ نصّيٍّ آمنٍ للتخزين عند الكتابة.
 */
export interface RecordEffectInput {
  documentType: DocumentType;
  documentId: number;
  effectKind: DocumentEffectKind;
  effectTable?: string | null;
  effectRowId?: number | null;
  /** موقَّع: موجب زيادة، سالب نقصان. الصفرُ مسموحٌ لأثرٍ رمزيّ (تعقّبٌ للتوصيل مثلاً). */
  signedAmount?: string | number | Decimal;
  /** موقَّع لحركات المخزون بوحدة الأساس. الصفرُ الافتراضيّ للأثر غير المخزنيّ. */
  signedQuantity?: number;
  branchId?: number | null;
  reason?: string | null;
  scope?: string | null;
  payloadJson?: unknown;
}

/**
 * يحوّل قيمةً ماليةً إلى تمثيلٍ نصّيٍّ بدقّةٍ آمنة (٤ منازل عشرية — يوافق عمود
 * `decimal(15,4)`). يرفض NaN وغيرَ المنتهي، ولا يستعمل `parseFloat`/`Number`.
 */
function toEffectAmountString(value: string | number | Decimal | undefined): string {
  if (value === undefined || value === null || value === "") return "0.0000";
  const dec = value instanceof Decimal ? value : new Decimal(value as string | number);
  if (!dec.isFinite()) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "مبلغُ أثرٍ غيرُ منتهٍ — لا يمكن تسجيله",
    });
  }
  // MySQL يقبل نصّاً بدقّةٍ أعلى ثمّ يقصّه إلى تعريف العمود؛ نضبطه صراحةً كي لا نُفاجأ
  // بتقريبِ مورّدٍ آخر في الطريق (نمط ثابت مع `toDbMoney`).
  return dec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

/** ينحت قيمةً صحيحةً موقَّعة لحركة المخزون. يرفض غير الأعداد الصحيحة. */
function toEffectQuantity(value: number | undefined): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "كمّيةُ أثرٍ ليست عدداً صحيحاً موقَّعاً",
    });
  }
  return value;
}

/**
 * يسجّل صفَّ APPLY لأثرٍ ماليٍّ داخل المعاملة الحاليّة. يُرجع مُعرِّف الصفّ حتّى يمكن للعاكس
 * الإشارةَ إليه لاحقاً عبر `reversalOfEffectId`.
 */
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

/**
 * يعكس آثار المستند: يقرأ صفوف APPLY التي لم يُكتَب لها REVERSE بعد، ويُدخل صفَّ REVERSE
 * لكلّ صفٍّ منها بقيمٍ معاكسة. الفعلُ ذرّيّ ضمن المعاملة نفسها.
 *
 * `scope` يقصر العكسَ على أنواعٍ محدَّدة (مثلاً «الأمانة والعمولة» في تسوية جزئية)؛ الغيابُ
 * (`{kind:"ALL"}`) يعكس الكلّ. الاستدعاءُ على مستندٍ مكتمل العكس فعلاً لا يفعل شيئاً.
 */
export async function reverse(
  tx: Tx,
  documentType: DocumentType,
  documentId: number,
  scope: ReversalScope,
  reason: string,
  actor: Actor,
): Promise<{ reversedCount: number; reversedEffectIds: number[] }> {
  if (!reason || !reason.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سببُ العكس مطلوب — لا عكسَ صامتاً",
    });
  }

  const pending = await loadPendingApplyEffects(tx, documentType, documentId, scope);
  if (pending.length === 0) {
    return { reversedCount: 0, reversedEffectIds: [] };
  }

  const insertedIds: number[] = [];
  for (const original of pending) {
    const negatedAmount = new Decimal(original.signedAmount).negated();
    const negatedQuantity = -Number(original.signedQuantity);
    const reverseRow: InsertDocumentEffect = {
      documentType: original.documentType,
      documentId: original.documentId,
      effectKind: original.effectKind,
      phase: "REVERSE",
      effectTable: original.effectTable ?? null,
      effectRowId: original.effectRowId ?? null,
      signedAmount: toEffectAmountString(negatedAmount),
      signedQuantity: toEffectQuantity(negatedQuantity),
      branchId: original.branchId ?? null,
      actorUserId: actor.userId ?? null,
      reversalOfEffectId: Number(original.id),
      reason,
      scope: original.scope ?? null,
      payloadJson: original.payloadJson as InsertDocumentEffect["payloadJson"],
    };
    const result = await tx.insert(documentEffects).values(reverseRow);
    insertedIds.push(extractInsertId(result));
  }

  await assertReversalBalancedTx(tx, documentType, documentId, scope);

  return { reversedCount: pending.length, reversedEffectIds: insertedIds };
}

/**
 * يقرأ صفوفَ APPLY التي **لم يُكتَب لها REVERSE بعد** للمستند المحدَّد (ونطاقه اختيارياً).
 * القيدُ 1↔1 محفوظٌ بحقل `reversalOfEffectId` (UNIQUE أنتجه CHECK+FK غير مطلوبٌ لأنّ صفَّ
 * REVERSE يتولَّد داخل معاملةٍ واحدة، وسنقفل استعلام القراءة بـ`FOR UPDATE`).
 */
async function loadPendingApplyEffects(
  tx: Tx,
  documentType: DocumentType,
  documentId: number,
  scope: ReversalScope,
) {
  // Codex #957: قائمةُ أنواعٍ فارغةٌ في `ONLY` **قصدٌ صريحٌ بلا انتقاء**، لا فتحةً إلى ALL.
  // (لو حصل عبر تصفيةٍ ديناميكية) — التوسيعُ الصامت كان يُنفّذ **عكساً ماليّاً كاملاً** ويُرضي
  // ثابتَ التوازن لأنّه يقلب كلَّ الآثار. نتصرّف كأنّ لا صفوفَ مطابقة قبل مسّ القاعدة.
  if (scope.kind === "ONLY" && scope.effectKinds.length === 0) {
    return [];
  }
  const conditions = [
    eq(documentEffects.documentType, documentType),
    eq(documentEffects.documentId, documentId),
    eq(documentEffects.phase, "APPLY"),
    sql`NOT EXISTS (
      SELECT 1 FROM ${documentEffects} AS reverse_child
      WHERE reverse_child.reversalOfEffectId = ${documentEffects.id}
        AND reverse_child.phase = 'REVERSE'
    )`,
  ];
  if (scope.kind === "ONLY") {
    conditions.push(
      sql`${documentEffects.effectKind} IN (${sql.join(
        scope.effectKinds.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
  }
  // Codex #957: يفصل هويّة العكس عندما يشترك مستندان في `(documentType, documentId,
  // effectKind)` نفسها — كإلغاءٍ يقع بعد مرتجعٍ جزئيّ سابق على نفس الفاتورة (كلاهما
  // يكتب INVENTORY على INVOICE). بلا هذا القيد، عكسُ الإلغاء يبتلع أثرَ المرتجع أيضاً.
  if (scope.operationScopes && scope.operationScopes.length > 0) {
    conditions.push(
      sql`${documentEffects.scope} IN (${sql.join(
        scope.operationScopes.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  }
  const rows = await tx
    .select()
    .from(documentEffects)
    .where(and(...conditions))
    .for("update");

  return rows;
}

/**
 * ثابتُ العكس: بعد نهاية `reverse` يجب أن يكون Σ signedAmount و Σ signedQuantity
 * لكل (documentType, documentId, effectKind) في **النطاق المعكوس** = 0. يفشل صريحاً إن
 * وُجد تسريب. تُستدعى داخل نفس المعاملة كي تُلغي أيَّ خللٍ في التنفيذ فوراً.
 */
export async function assertReversalBalancedTx(
  tx: Tx,
  documentType: DocumentType,
  documentId: number,
  scope: ReversalScope,
): Promise<void> {
  // Codex #957: قائمةُ أنواعٍ فارغة في ONLY لا تُوسَّع صامتاً — نطاقٌ فارغٌ لا يُنتج
  // عكساً، فليس ثمّة ما يُتحقَّق منه. يوافق سلوك `loadPendingApplyEffects` أعلاه.
  if (scope.kind === "ONLY" && scope.effectKinds.length === 0) {
    return;
  }
  const kindFilter =
    scope.kind === "ONLY"
      ? sql`AND effectKind IN (${sql.join(
          scope.effectKinds.map((k) => sql`${k}`),
          sql`, `,
        )})`
      : sql``;
  const opScopeFilter =
    scope.operationScopes && scope.operationScopes.length > 0
      ? sql`AND scope IN (${sql.join(
          scope.operationScopes.map((s) => sql`${s}`),
          sql`, `,
        )})`
      : sql``;

  const execResult = (await tx.execute(sql`
    SELECT effectKind,
           SUM(signedAmount)   AS sumAmount,
           SUM(signedQuantity) AS sumQuantity
    FROM ${documentEffects}
    WHERE documentType = ${documentType}
      AND documentId   = ${documentId}
      ${kindFilter}
      ${opScopeFilter}
    GROUP BY effectKind
    HAVING SUM(signedAmount)   <> 0
        OR SUM(signedQuantity) <> 0
    LIMIT 1
  `)) as unknown;
  // mysql2 raw execute يُرجع [rows, fields]؛ نمسك rows بأمانٍ لكلا الصيغتَين.
  const rows = Array.isArray(execResult)
    ? (execResult[0] as Array<{
        effectKind: string;
        sumAmount: string | number | null;
        sumQuantity: string | number | null;
      }>)
    : ((execResult as { rows?: unknown[] })?.rows as Array<{
        effectKind: string;
        sumAmount: string | number | null;
        sumQuantity: string | number | null;
      }>) ?? [];
  const row = rows?.[0];

  if (row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `عكسٌ غيرُ متوازن — بقايا في ${row.effectKind}: مبلغ ${
        row.sumAmount ?? "?"
      }، كمّية ${row.sumQuantity ?? "?"}`,
    });
  }
}

/**
 * قراءةٌ ملخّصة لأثر مستند (تدقيق/عرض). لا تُستعمل داخل الكتابة — تنفعُ لبناء لوحة عرضٍ
 * تُظهر ما وقع وما عُكس.
 */
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
  const rows = (
    Array.isArray(execResult)
      ? (execResult[0] as unknown[])
      : ((execResult as { rows?: unknown[] })?.rows ?? [])
  ) as Array<{
    effectKind: string;
    phase: string;
    rowCount: string | number;
    sumAmount: string | number | null;
    sumQuantity: string | number | null;
  }>;

  return rows.map((r) => ({
    effectKind: r.effectKind,
    phase: r.phase,
    rowCount: Number(r.rowCount ?? 0),
    sumAmount: new Decimal(r.sumAmount ?? 0)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      .toFixed(4),
    sumQuantity: Number(r.sumQuantity ?? 0),
  }));
}
