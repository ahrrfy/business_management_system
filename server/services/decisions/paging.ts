import { createHash } from "node:crypto";
import { z } from "zod";
import { decisionSpec, type DecisionInboxFilter, type DecisionRowModel } from "@shared/decisionRegistry";
import type { DecisionActor } from "./types";
import type { SourceCursor } from "./scan";

export const MAX_DELIVERED_KEYS = 10_000;
const deliveredKindSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9.]+$/)
  .refine(kind => decisionSpec(kind) != null, "Unknown decision kind");
export const pageCursorSchema = z.object({
  userId: z.number().int().positive().safe(),
  actorBranchId: z.number().int().positive().nullable(),
  crossBranch: z.boolean(),
  branchId: z.number().int().positive().nullable(),
  kind: z.string().min(1).max(80).nullable(),
  minAgeHours: z.number().min(0).max(8760).nullable(),
  parentSource: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  delivered: z.array(z.tuple([deliveredKindSchema, z.number().int().positive().safe()]))
    .min(1).max(MAX_DELIVERED_KEYS)
    .refine(keys => new Set(keys.map(([kind, id]) => `${kind}:${id}`)).size === keys.length, "Duplicate delivered keys"),
}).strict();
export type PageCursor = z.infer<typeof pageCursorSchema>;

/** Progress only: these keys never authorize a read or load arbitrary records. */
export function pageBinding(actor: DecisionActor, filter: DecisionInboxFilter, source?: SourceCursor) {
  const parentSource = source ? createHash("sha256").update(JSON.stringify({ ...source,
    positions: Object.fromEntries(Object.entries(source.positions).sort(([a], [b]) => a.localeCompare(b))),
  })).digest("hex") : null;
  return { userId: actor.userId, actorBranchId: actor.branchId, crossBranch: actor.crossBranch,
    branchId: filter.branchId ?? null, kind: filter.kind ?? null, minAgeHours: filter.minAgeHours ?? null, parentSource };
}

export function samePageBinding(cursor: PageCursor, binding: ReturnType<typeof pageBinding>) {
  return Object.entries(binding).every(([key, value]) => cursor[key as keyof typeof binding] === value);
}

export const decisionKey = (row: Pick<DecisionRowModel, "kind" | "id">) => `${row.kind}:${row.id}`;
