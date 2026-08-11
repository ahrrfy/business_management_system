import { createHash } from "node:crypto";

/** الحقول التي تغيّر المعنى الإداري لقرار اعتماد منتج واحد. */
export type ReviewSnapshotInput = {
  variantId: number;
  rawCount: number;
  kindUsed: "FIRST" | "RECOUNT";
  diff: number;
  countOperationId: number | null;
  /** تكلفة وحدة الأساس المطبّعة وقيمة الفرق — تغيّرهما يبطل الاعتماد الإداري حكماً. */
  unitCost: string;
  value: string;
  decision: {
    action: "ADJUST" | "KEEP";
    reason: string;
    note: string | null;
  } | null;
};

type LegacyReviewSnapshotInput = Omit<
  ReviewSnapshotInput,
  "unitCost" | "value"
>;

function canonicalDecision(input: LegacyReviewSnapshotInput) {
  return input.decision
    ? {
        action: input.decision.action,
        reason: input.decision.reason,
        note: input.decision.note ?? null,
      }
    : null;
}

/** بصمة v1 للقراءة الانتقالية فقط؛ لا تُكتب لاعتمادات جديدة. */
export function stocktakeReviewSnapshotLegacyHash(
  input: LegacyReviewSnapshotInput,
): string {
  const canonical = JSON.stringify({
    version: 1,
    variantId: input.variantId,
    rawCount: input.rawCount,
    kindUsed: input.kindUsed,
    diff: input.diff,
    countOperationId: input.countOperationId,
    decision: canonicalDecision(input),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * بصمة مستقرة للإصدار الأول من عقد المراجعة.
 * لا نضمّن bookNow/adjustedCount لأن حركة بيع/شراء صحيحة بعد العد تغيّرهما معاً
 * بينما يبقى فرق الجرد نفسه؛ أما تغيّر العد أو الفرق أو القرار فيبطل البصمة.
 */
export function stocktakeReviewSnapshotHash(
  input: ReviewSnapshotInput,
): string {
  const canonical = JSON.stringify({
    version: 2,
    purpose: "STOCKTAKE_REVIEW_BASE_UNIT_VALUATION",
    variantId: input.variantId,
    rawCount: input.rawCount,
    kindUsed: input.kindUsed,
    diff: input.diff,
    countOperationId: input.countOperationId,
    unitCost: input.unitCost,
    value: input.value,
    decision: canonicalDecision(input),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
