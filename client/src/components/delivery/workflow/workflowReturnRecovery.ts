import { z } from "zod";
import { WORKFLOW_SOURCE_KINDS } from "../../../../../shared/deliveryWorkflow";

const id = z.number().int().positive();
const key = z.string().min(8).max(56);
const sourceIdentity = z
  .object({ kind: z.enum(WORKFLOW_SOURCE_KINDS), id })
  .strict();
const scopeSchema = z
  .object({ actorId: id, branchId: id, source: sourceIdentity })
  .strict();
const reason = z.string().min(3).max(255);
const commandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("declare"),
      input: z
        .object({
          source: sourceIdentity
            .extend({ expectedVersion: z.string().min(1).max(128) })
            .strict(),
          action: z.literal("declareReturn"),
          reason,
          branchId: id,
          clientRequestId: key,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("receive"),
      input: z
        .object({
          source: sourceIdentity
            .extend({ expectedVersion: z.string().min(1).max(128) })
            .strict(),
          branchId: id,
          evidence: z.string().min(5).max(255),
          inspected: z.literal(true),
          receivedConsignmentIds: z
            .array(id)
            .min(1)
            .max(30)
            .refine((ids) => new Set(ids).size === ids.length)
            .optional(),
          clientRequestId: key,
        })
        .strict(),
    })
    .strict(),
]);
const snapshotSchema = z
  .object({
    version: z.literal(2),
    scope: scopeSchema,
    phase: z.enum(["PENDING", "COMMITTED", "REJECTED"]),
    savedAt: z.number().int().nonnegative(),
    command: commandSchema,
  })
  .strict();

export type WorkflowReturnScope = z.infer<typeof scopeSchema>;
export type WorkflowReturnCommand = z.infer<typeof commandSchema>;
export type WorkflowReturnSnapshot = z.infer<typeof snapshotSchema>;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type WorkflowReturnRecovery =
  | { state: "EMPTY" }
  | { state: "SAVED"; snapshot: WorkflowReturnSnapshot }
  | { state: "INVALID" | "UNAVAILABLE" | "LEGACY" };

export function workflowReturnStorageKey(scope: WorkflowReturnScope) {
  return `erp:workflow-return:v2:${scope.actorId}:${scope.branchId}:${scope.source.kind}:${scope.source.id}`;
}
function matchingScope(a: WorkflowReturnScope, b: WorkflowReturnScope) {
  return (
    a.actorId === b.actorId &&
    a.branchId === b.branchId &&
    a.source.kind === b.source.kind &&
    a.source.id === b.source.id
  );
}
export function parseWorkflowReturnSnapshot(
  raw: string,
  scope: WorkflowReturnScope,
): WorkflowReturnSnapshot | null {
  if (raw.length > 8192 || !scopeSchema.safeParse(scope).success) return null;
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || !matchingScope(parsed.data.scope, scope))
      return null;
    const command = parsed.data.command;
    if (
      command.input.branchId !== scope.branchId ||
      command.input.source.kind !== scope.source.kind ||
      command.input.source.id !== scope.source.id
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}
export function readWorkflowReturnRecovery(
  storage: StoragePort,
  scope: WorkflowReturnScope,
): WorkflowReturnRecovery {
  try {
    const raw = storage.getItem(workflowReturnStorageKey(scope));
    if (raw == null)
      return storage.getItem(
        workflowReturnStorageKey(scope).replace(":v2:", ":v1:"),
      ) == null
        ? { state: "EMPTY" }
        : { state: "LEGACY" };
    const snapshot = parseWorkflowReturnSnapshot(raw, scope);
    return snapshot ? { state: "SAVED", snapshot } : { state: "INVALID" };
  } catch {
    return { state: "UNAVAILABLE" };
  }
}
/** Persist a strict field allowlist before sending. Never replace another unresolved command. */
export function persistWorkflowReturnSnapshot(
  storage: StoragePort,
  snapshot: WorkflowReturnSnapshot,
): boolean {
  const raw = JSON.stringify(snapshot);
  const safe = parseWorkflowReturnSnapshot(raw, snapshot.scope);
  if (!safe) return false;
  try {
    const existing = readWorkflowReturnRecovery(storage, snapshot.scope);
    if (
      existing.state === "INVALID" ||
      existing.state === "UNAVAILABLE" ||
      existing.state === "LEGACY"
    )
      return false;
    if (
      existing.state === "SAVED" &&
      JSON.stringify(existing.snapshot.command) !== JSON.stringify(safe.command)
    )
      return false;
    if (
      existing.state === "SAVED" &&
      existing.snapshot.phase !== "PENDING" &&
      snapshot.phase === "PENDING"
    )
      return false;
    if (
      existing.state === "SAVED" &&
      existing.snapshot.phase === "COMMITTED" &&
      snapshot.phase !== "COMMITTED"
    )
      return false;
    const key = workflowReturnStorageKey(snapshot.scope);
    storage.setItem(key, raw);
    return storage.getItem(key) === raw;
  } catch {
    return false;
  }
}
export function clearWorkflowReturnSnapshot(
  storage: StoragePort,
  snapshot: WorkflowReturnSnapshot,
): boolean {
  const safe = parseWorkflowReturnSnapshot(
    JSON.stringify(snapshot),
    snapshot.scope,
  );
  if (!safe) return false;
  try {
    const current = readWorkflowReturnRecovery(storage, snapshot.scope);
    if (current.state === "EMPTY") return true;
    if (
      current.state !== "SAVED" ||
      JSON.stringify(current.snapshot.command) !== JSON.stringify(safe.command)
    )
      return false;
    const key = workflowReturnStorageKey(snapshot.scope);
    storage.removeItem(key);
    return storage.getItem(key) == null;
  } catch {
    return false;
  }
}
export function definitiveWorkflowReturnRejection(error: unknown) {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  return (
    code != null &&
    [
      "BAD_REQUEST",
      "FORBIDDEN",
      "UNAUTHORIZED",
      "NOT_FOUND",
      "CONFLICT",
      "PRECONDITION_FAILED",
    ].includes(code)
  );
}
