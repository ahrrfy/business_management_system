import { and, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  inventoryMovements,
  stocktakeCounts,
  stocktakeDecisions,
  stocktakeItems,
  stocktakeSessions,
  users,
} from "../../../drizzle/schema";
import type { DB } from "../../db";

export interface MovementStocktakeSource {
  sessionId: number;
  code: string;
  sessionType: "NORMAL" | "OPENING";
  approvedByName: string | null;
  decidedByName: string | null;
  countedByName: string | null;
  autoApplied: boolean | null;
}

/** Read provenance for this page only. Two batched queries; at most three counts per source. */
export async function loadMovementStocktakeSources(
  db: DB,
  movements: readonly {
    id: number;
    referenceType: string | null;
    referenceId: number | null;
  }[],
): Promise<Map<number, MovementStocktakeSource>> {
  const ids = movements
    .filter(
      (r) =>
        r.referenceId != null &&
        (r.referenceType === "STOCKTAKE" || r.referenceType === "OPENING"),
    )
    .map((r) => r.id);
  const result = new Map<number, MovementStocktakeSource>();
  if (!ids.length) return result;

  const approver = alias(users, "movementStocktakeApprover");
  const decider = alias(users, "movementStocktakeDecider");
  const sources = await db
    .selectDistinct({
      movementId: inventoryMovements.id,
      variantId: inventoryMovements.variantId,
      sessionId: stocktakeSessions.id,
      code: stocktakeSessions.code,
      sessionType: stocktakeSessions.sessionType,
      approvedByName: approver.name,
      decidedByName: decider.name,
      autoApplied: stocktakeDecisions.autoApplied,
    })
    .from(inventoryMovements)
    .innerJoin(
      stocktakeSessions,
      and(
        eq(stocktakeSessions.id, inventoryMovements.referenceId),
        eq(stocktakeSessions.branchId, inventoryMovements.branchId),
        eq(stocktakeSessions.status, "APPROVED"),
        or(
          and(
            eq(inventoryMovements.referenceType, "STOCKTAKE"),
            eq(stocktakeSessions.sessionType, "NORMAL"),
          ),
          and(
            eq(inventoryMovements.referenceType, "OPENING"),
            eq(stocktakeSessions.sessionType, "OPENING"),
          ),
        ),
      ),
    )
    .innerJoin(
      stocktakeItems,
      and(
        eq(stocktakeItems.sessionId, stocktakeSessions.id),
        eq(stocktakeItems.variantId, inventoryMovements.variantId),
      ),
    )
    .leftJoin(
      stocktakeDecisions,
      and(
        eq(stocktakeDecisions.sessionId, stocktakeSessions.id),
        eq(stocktakeDecisions.variantId, inventoryMovements.variantId),
      ),
    )
    .leftJoin(approver, eq(approver.id, stocktakeSessions.approvedBy))
    .leftJoin(decider, eq(decider.id, stocktakeDecisions.decidedBy))
    .where(inArray(inventoryMovements.id, ids));
  if (!sources.length) return result;

  const pairs = new Map(
    sources.map((r) => [`${r.sessionId}:${r.variantId}`, r]),
  );
  const ranked = db
    .select({
      sessionId: stocktakeCounts.sessionId,
      variantId: stocktakeCounts.variantId,
      kind: stocktakeCounts.kind,
      countedByName: stocktakeCounts.countedByName,
      isConflict: stocktakeCounts.isConflict,
      resolvedPick: stocktakeCounts.resolvedPick,
      rank: sql<number>`row_number() over (partition by ${stocktakeCounts.sessionId}, ${stocktakeCounts.variantId}, ${stocktakeCounts.kind} order by ${stocktakeCounts.countedAt} desc, ${stocktakeCounts.id} desc)`.as(
        "countRank",
      ),
    })
    .from(stocktakeCounts)
    .where(
      or(
        ...Array.from(pairs.values()).map((r) =>
          and(
            eq(stocktakeCounts.sessionId, r.sessionId),
            eq(stocktakeCounts.variantId, r.variantId),
          ),
        ),
      ),
    )
    .as("latestMovementStocktakeCounts");
  const counts = await db.select().from(ranked).where(eq(ranked.rank, 1));
  const countsByPair = new Map<string, Map<string, (typeof counts)[number]>>();
  for (const count of counts) {
    const key = `${count.sessionId}:${count.variantId}`;
    const kinds = countsByPair.get(key) ?? new Map();
    kinds.set(count.kind, count);
    countsByPair.set(key, kinds);
  }
  for (const source of sources) {
    const kinds = countsByPair.get(`${source.sessionId}:${source.variantId}`);
    const recount = kinds?.get("RECOUNT");
    const first = kinds?.get("FIRST");
    const verify = kinds?.get("VERIFY");
    // Same effective-count rule as reviewCore: latest RECOUNT, else FIRST/selected VERIFY.
    const used =
      recount ??
      (first
        ? verify?.isConflict && verify.resolvedPick === "VERIFY"
          ? verify
          : first
        : null);
    result.set(Number(source.movementId), {
      sessionId: Number(source.sessionId),
      code: source.code,
      sessionType: source.sessionType,
      approvedByName: source.approvedByName,
      decidedByName: source.decidedByName,
      countedByName: used?.countedByName ?? null,
      autoApplied: source.autoApplied,
    });
  }
  return result;
}
