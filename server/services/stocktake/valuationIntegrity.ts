import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  productVariants,
  products,
  stocktakeItemReviewEvents,
  stocktakeItems,
  stocktakeSessions,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { redactAuditValue } from "../auditService";
import { money, toDbMoney } from "../money";
import { withTx } from "../tx";
import { chunk, lockSession, type DbLike } from "./internal";
import { loadReviewCore, type ReviewRow } from "./reviewCore";
import type { StkActor } from "./types";

const MATERIAL_RATIO = money(10);
const RATIO_MATERIAL_FLOOR = money(100_000);
const ABSOLUTE_VALUE_DELTA_CAP = money(10_000_000);

type SessionForValuation = {
  id: number | bigint;
  sessionType: "NORMAL" | "OPENING";
  status: "COUNTING" | "REVIEW" | "APPROVED" | "CANCELLED";
  firstSignBy?: number | bigint | null;
  firstSignAt?: Date | null;
};

export type OpeningValuationRow = {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  rawCount: number | null;
  adjustedCount: number | null;
  diff: number | null;
  snapshotUnitCost: string;
  currentBaseUnitCost: string;
  snapshotValue: string;
  currentBaseValue: string;
  valueDelta: string;
  costRatio: string | null;
  blocking: boolean;
  reason:
    | "ZERO_BASE_COST"
    | "MATERIAL_UNIT_BASIS_MISMATCH"
    | "MATERIAL_AGGREGATE_MISMATCH"
    | "COST_CHANGED";
};

export type OpeningValuationIntegrity = {
  applies: boolean;
  digest: string;
  mismatchCount: number;
  blockingCount: number;
  snapshotNetValue: string;
  currentBaseNetValue: string;
  inflationDelta: string;
  snapshotAbsValue: string;
  currentBaseAbsValue: string;
  inflationRatio: string | null;
  rows: OpeningValuationRow[];
};

function canonicalMoney(value: string | number): string {
  return toDbMoney(money(String(value)));
}

/**
 * يقارن لقطة الجرد الافتتاحي بتكلفة وحدة الأساس الحية، من دون تغيير سياسة اللقطة للجرد الدوري.
 * الاختلاف العادي يبقى للمراجعة؛ الحجب يقتصر على انحراف مادي بنسبة كبيرة (بصمة خلط وحدة)
 * أو تكلفة أساس صفرية لكمية ذات أثر. الإجمالي وحده لا يحجب افتتاحاً مشروعاً كبيراً.
 */
export async function buildOpeningValuationIntegrity(
  db: DbLike,
  session: SessionForValuation,
  rows: ReviewRow[],
): Promise<OpeningValuationIntegrity> {
  if (session.sessionType !== "OPENING") {
    return {
      applies: false,
      digest: createHash("sha256")
        .update(`stocktake-valuation:none:${session.id}`)
        .digest("hex"),
      mismatchCount: 0,
      blockingCount: 0,
      snapshotNetValue: "0.00",
      currentBaseNetValue: "0.00",
      inflationDelta: "0.00",
      snapshotAbsValue: "0.00",
      currentBaseAbsValue: "0.00",
      inflationRatio: null,
      rows: [],
    };
  }

  const ids = rows.map((row) => row.variantId);
  const liveCosts = new Map<number, string>();
  for (const part of chunk(ids)) {
    const costRows = await db
      .select({ id: productVariants.id, costPrice: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, part));
    for (const row of costRows)
      liveCosts.set(
        Number(row.id),
        canonicalMoney(String(row.costPrice ?? "0")),
      );
  }

  let snapshotNet = money(0);
  let currentNet = money(0);
  let snapshotAbs = money(0);
  let currentAbs = money(0);
  const mismatches: OpeningValuationRow[] = [];

  for (const row of rows) {
    const snapshotCost = money(row.unitCost || "0");
    const currentCost = money(liveCosts.get(row.variantId) ?? "0");
    const quantity = row.diff ?? 0;
    const snapshotValue = snapshotCost.times(quantity);
    const currentValue = currentCost.times(quantity);
    snapshotNet = snapshotNet.plus(snapshotValue);
    currentNet = currentNet.plus(currentValue);
    snapshotAbs = snapshotAbs.plus(snapshotValue.abs());
    currentAbs = currentAbs.plus(currentValue.abs());

    const costsDiffer = !snapshotCost.eq(currentCost);
    // A positive snapshot must never be refreshed to zero while the item is
    // still uncounted. If both costs are already zero, the row becomes blocking
    // as soon as a non-zero effective difference exists.
    const zeroBaseCost =
      currentCost.lte(0) && (snapshotCost.gt(0) || quantity !== 0);
    if (!costsDiffer && !zeroBaseCost) continue;
    const delta = snapshotValue.minus(currentValue);
    const ratio = currentCost.gt(0) ? snapshotCost.div(currentCost) : null;
    const extremeRatio =
      ratio != null &&
      (ratio.gte(MATERIAL_RATIO) || ratio.lte(money(1).div(MATERIAL_RATIO)));
    const absoluteMaterialMismatch = delta.abs().gte(ABSOLUTE_VALUE_DELTA_CAP);
    const ratioMaterialMismatch =
      extremeRatio && delta.abs().gte(RATIO_MATERIAL_FLOOR);
    const blocking =
      zeroBaseCost ||
      (quantity !== 0 && (absoluteMaterialMismatch || ratioMaterialMismatch));
    mismatches.push({
      variantId: row.variantId,
      productName: row.productName,
      variantName: row.variantName,
      sku: row.sku,
      rawCount: row.rawCount,
      adjustedCount: row.adjustedCount,
      diff: row.diff,
      snapshotUnitCost: toDbMoney(snapshotCost),
      currentBaseUnitCost: toDbMoney(currentCost),
      snapshotValue: toDbMoney(snapshotValue),
      currentBaseValue: toDbMoney(currentValue),
      valueDelta: toDbMoney(delta),
      costRatio: ratio == null ? null : ratio.toDecimalPlaces(4).toFixed(4),
      blocking,
      reason: zeroBaseCost
        ? "ZERO_BASE_COST"
        : blocking
          ? "MATERIAL_UNIT_BASIS_MISMATCH"
          : "COST_CHANGED",
    });
  }

  // Distributed inflation must not evade a per-row cap. Once the sum of
  // absolute valuation deltas is material, every contributing counted row is
  // explicitly review-blocking until the controlled refresh is performed.
  const aggregateMismatchAbs = mismatches.reduce(
    (sum, row) => sum.plus(money(row.valueDelta).abs()),
    money(0),
  );
  if (aggregateMismatchAbs.gte(ABSOLUTE_VALUE_DELTA_CAP)) {
    for (const row of mismatches) {
      if (row.diff === 0 || row.blocking) continue;
      row.blocking = true;
      row.reason = "MATERIAL_AGGREGATE_MISMATCH";
    }
  }

  mismatches.sort((a, b) =>
    money(b.valueDelta).abs().comparedTo(money(a.valueDelta).abs()),
  );
  const digestPayload = {
    version: 1,
    purpose: "OPENING_COST_BASIS_REFRESH",
    sessionId: Number(session.id),
    status: session.status,
    firstSignBy:
      session.firstSignBy == null ? null : Number(session.firstSignBy),
    firstSignAt: session.firstSignAt?.toISOString() ?? null,
    // Digest the complete scope, not only mismatch rows: displayed totals and
    // approvals must remain identical between preview and apply.
    rows: rows
      .map((row) => ({
        variantId: row.variantId,
        snapshotUnitCost: canonicalMoney(row.unitCost),
        currentBaseUnitCost: canonicalMoney(
          liveCosts.get(row.variantId) ?? "0",
        ),
        rawCount: row.rawCount,
        diff: row.diff,
        latestCountOperationId: row.latestCountOperationId,
        reviewApproved:
          row.reviewApproved == null
            ? null
            : {
                byUserId: row.reviewApproved.byUserId,
                at: row.reviewApproved.at.toISOString(),
                isCurrent: row.reviewApproved.isCurrent,
              },
      }))
      .sort((a, b) => a.variantId - b.variantId),
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(digestPayload), "utf8")
    .digest("hex");
  return {
    applies: true,
    digest,
    mismatchCount: mismatches.length,
    blockingCount: mismatches.filter((row) => row.blocking).length,
    snapshotNetValue: toDbMoney(snapshotNet),
    currentBaseNetValue: toDbMoney(currentNet),
    inflationDelta: toDbMoney(snapshotNet.minus(currentNet)),
    snapshotAbsValue: toDbMoney(snapshotAbs),
    currentBaseAbsValue: toDbMoney(currentAbs),
    inflationRatio: currentAbs.gt(0)
      ? snapshotAbs.div(currentAbs).toDecimalPlaces(4).toFixed(4)
      : null,
    rows: mismatches,
  };
}

/** قفل تكاليف الكتالوج بعد قفل الجلسة (وفي finalize: بعد branchStock) لمنع خليط قديم/جديد. */
export async function lockOpeningValuationVariants(
  tx: Tx,
  sessionId: number,
): Promise<void> {
  const ids = (
    await tx
      .select({ variantId: stocktakeItems.variantId })
      .from(stocktakeItems)
      .where(eq(stocktakeItems.sessionId, sessionId))
      .orderBy(asc(stocktakeItems.variantId))
  ).map((row) => Number(row.variantId));
  for (const part of chunk(ids)) {
    await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(inArray(productVariants.id, part))
      .orderBy(asc(productVariants.id))
      .for("update");
  }
}

export function assertOpeningValuationSafe(
  integrity: OpeningValuationIntegrity,
): void {
  if (integrity.blockingCount === 0) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      `حُجب الاعتماد: يوجد ${integrity.blockingCount} تضخم تكلفة/وحدة مادّي. ` +
      "راجع تقرير سلامة التقييم ونفّذ تحديث أساس التكلفة الموثّق قبل المتابعة.",
  });
}

export type RefreshOpeningValuationResult = {
  ok: true;
  changedCount: number;
  reopenedCount: number;
  oldNetValue: string;
  newNetValue: string;
  digest: string;
};

/**
 * إنقاذ صريح للجرد الافتتاحي فقط: يعيد أساس كل اللقطات المختلفة إلى تكلفة وحدة الأساس الحية.
 * لا يقبل أسعاراً أو قائمة أصناف من العميل، ولا يلمس العدّ/الرصيد/الحركات/الدفتر/النقد.
 */
export async function refreshOpeningValuationBasis(
  args: { sessionId: number; expectedDigest: string; reason: string },
  actor: StkActor,
): Promise<RefreshOpeningValuationResult> {
  return withTx(async (tx) => {
    const session = await lockSession(tx, args.sessionId);
    if (session.sessionType !== "OPENING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تحديث أساس التقييم مخصص للجرد الافتتاحي فقط",
      });
    }
    if (session.status !== "COUNTING" && session.status !== "REVIEW") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يمكن تغيير تقييم جلسة معتمدة أو ملغاة",
      });
    }
    await lockOpeningValuationVariants(tx, args.sessionId);
    const { rows } = await loadReviewCore(tx, args.sessionId, true);
    const integrity = await buildOpeningValuationIntegrity(tx, session, rows);
    if (integrity.digest !== args.expectedDigest) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "تغيّرت بيانات الجرد أو التكلفة بعد المعاينة — أعد فتح التقرير وراجعه من جديد",
      });
    }
    const missingBaseCosts = integrity.rows.filter(
      (row) => row.reason === "ZERO_BASE_COST",
    );
    if (missingBaseCosts.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          `تعذر الإنقاذ: ${missingBaseCosts.length} صنف بتكلفة أساس صفرية وله كمية مؤثرة. ` +
          "صحح تكلفة وحدة الأساس في الكتالوج أولاً ثم أعد المعاينة؛ لن يحوّل النظام قيمة المخزون إلى صفر.",
      });
    }
    if (integrity.mismatchCount === 0) {
      return {
        ok: true as const,
        changedCount: 0,
        reopenedCount: 0,
        oldNetValue: integrity.snapshotNetValue,
        newNetValue: integrity.currentBaseNetValue,
        digest: integrity.digest,
      };
    }

    const changedIds = integrity.rows
      .map((row) => row.variantId)
      .sort((a, b) => a - b);
    const items = await tx
      .select({
        id: stocktakeItems.id,
        variantId: stocktakeItems.variantId,
        reviewApprovedAt: stocktakeItems.reviewApprovedAt,
        reviewApprovedOperationId: stocktakeItems.reviewApprovedOperationId,
        reviewApprovedQty: stocktakeItems.reviewApprovedQty,
        reviewApprovedSnapshotHash: stocktakeItems.reviewApprovedSnapshotHash,
      })
      .from(stocktakeItems)
      .where(
        and(
          eq(stocktakeItems.sessionId, args.sessionId),
          inArray(stocktakeItems.variantId, changedIds),
        ),
      )
      .orderBy(asc(stocktakeItems.variantId))
      .for("update");
    const costById = new Map(
      integrity.rows.map((row) => [row.variantId, row.currentBaseUnitCost]),
    );
    const now = new Date();
    let reopenedCount = 0;
    for (const item of items) {
      const variantId = Number(item.variantId);
      const nextCost = costById.get(variantId);
      if (nextCost == null)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "تعذر تثبيت تكلفة صنف",
        });
      if (item.reviewApprovedAt != null) {
        reopenedCount++;
        await tx.insert(stocktakeItemReviewEvents).values({
          sessionId: args.sessionId,
          variantId,
          action: "REOPEN",
          snapshotOperationId:
            item.reviewApprovedOperationId == null
              ? null
              : Number(item.reviewApprovedOperationId),
          snapshotQty: item.reviewApprovedQty,
          snapshotHash: item.reviewApprovedSnapshotHash,
          reason: `تحديث أساس تكلفة افتتاحي: ${args.reason}`.slice(0, 255),
          actedBy: actor.userId,
        });
      }
      await tx
        .update(stocktakeItems)
        .set({
          unitCost: nextCost,
          reviewApprovedBy: null,
          reviewApprovedAt: null,
          reviewApprovedOperationId: null,
          reviewApprovedQty: null,
          reviewApprovedSnapshotHash: null,
          ...(item.reviewApprovedAt != null
            ? {
                reviewReopenedBy: actor.userId,
                reviewReopenedAt: now,
                reviewReopenReason:
                  `تحديث أساس تكلفة افتتاحي: ${args.reason}`.slice(0, 255),
              }
            : {}),
        })
        .where(eq(stocktakeItems.id, Number(item.id)));
    }
    await tx
      .update(stocktakeSessions)
      .set({ firstSignBy: null, firstSignAt: null })
      .where(eq(stocktakeSessions.id, args.sessionId));

    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(session.branchId),
      action: "stocktake.refreshOpeningValuationBasis",
      entityType: "stocktake",
      entityId: String(args.sessionId),
      oldValue: redactAuditValue({
        digest: integrity.digest,
        netValue: integrity.snapshotNetValue,
        mismatchCount: integrity.mismatchCount,
      }),
      newValue: redactAuditValue({
        reason: args.reason,
        valuationAsOf: now,
        netValue: integrity.currentBaseNetValue,
        changedCount: integrity.mismatchCount,
        reopenedCount,
        topDeltas: integrity.rows.slice(0, 12).map((row) => ({
          variantId: row.variantId,
          oldCost: row.snapshotUnitCost,
          newCost: row.currentBaseUnitCost,
          delta: row.valueDelta,
        })),
      }),
    });

    const { rows: refreshedRows } = await loadReviewCore(
      tx,
      args.sessionId,
      true,
    );
    const refreshed = await buildOpeningValuationIntegrity(
      tx,
      session,
      refreshedRows,
    );
    if (refreshed.mismatchCount !== 0) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "لم تتطابق كل تكاليف الأساس — أُلغي التحديث كاملاً",
      });
    }
    return {
      ok: true as const,
      changedCount: integrity.mismatchCount,
      reopenedCount,
      oldNetValue: integrity.snapshotNetValue,
      newNetValue: refreshed.snapshotNetValue,
      digest: refreshed.digest,
    };
  });
}
