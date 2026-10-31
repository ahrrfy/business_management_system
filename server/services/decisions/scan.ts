import { and, eq, gt, or, sql, type AnyColumn } from "drizzle-orm";
import { z } from "zod";
import type { DecisionScope } from "./types";

export const scanPositionSchema = z.object({ id: z.number().int().positive().safe(), at: z.string().datetime().optional() }).strict();
export type ScanPosition = z.infer<typeof scanPositionSchema>;
export const sourceCursorSchema = z.object({
  source: z.string().min(1).max(80), userId: z.number().int().positive(),
  actorBranchId: z.number().int().positive().nullable(), crossBranch: z.boolean(),
  branchId: z.number().int().positive().nullable(), kind: z.string().max(80).nullable(),
  minAgeHours: z.number().min(0).max(8760).nullable(),
  positions: z.record(z.string().regex(/^(all|[1-9][0-9]{0,14})$/), scanPositionSchema.nullable())
    .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 1000),
}).strict();
export type SourceCursor = z.infer<typeof sourceCursorSchema>;
const TIME_SOURCES = new Set(["purchase.integrity.resolution", "supplier.payment.refund", "treasury.voucher",
  "expense", "expense.accrualCorrection", "cash.variance", "hr.leave", "closing.monthClose", "gifts.request"]);
const BRANCH_PARTITIONS = new Set(["purchase.integrity.resolution", "supplier.payment.refund", "cash.variance"]);
export function validScanPositions(cursor: SourceCursor, branchId: number | null) {
  const entries = Object.entries(cursor.positions);
  return entries.some(([, position]) => position != null) && entries.every(([partition, position]) =>
    (BRANCH_PARTITIONS.has(cursor.source) ? partition !== "all" && (branchId == null || partition === String(branchId)) : partition === "all") &&
    (position == null || TIME_SOURCES.has(cursor.source) === (position.at != null)));
}

/** Narrow optional keyset predicate; ordinary domain list calls remain unchanged. */
export function scanAfter(id: AnyColumn, position?: ScanPosition | null, timestamp?: AnyColumn) {
  if (position === null) return sql`1 = 0`;
  if (!position) return undefined;
  if (!timestamp) return gt(id, position.id);
  if (!position.at) throw new Error("Missing timestamp in decision source cursor");
  const at = new Date(position.at);
  return or(gt(timestamp, at), and(eq(timestamp, at), gt(id, position.id)));
}
export function scanPosition(scope: DecisionScope, partition: string | number = "all") {
  return scope.scanPositions?.[String(partition)];
}
/** Report raw progress BEFORE row eligibility. A full page can be entirely ineligible. */
export function reportScan<T extends { id: number }>(scope: DecisionScope, rows: T[], limit: number,
  options: { hasMore?: boolean; partition?: string | number; time?: (row: T) => Date | string } = {}) {
  const hasMore = options.hasMore ?? rows.length >= limit;
  scope.reportLimit?.(rows.length, limit, hasMore);
  const last = rows.at(-1);
  scope.reportScan?.(String(options.partition ?? "all"), hasMore && last
    ? { id: last.id, ...(options.time ? { at: new Date(options.time(last)).toISOString() } : {}) } : null);
}
