import { z } from "zod";
import { WORKFLOW_SOURCE_KINDS } from "../../../../../shared/deliveryWorkflow";
import type { WorkflowReturnScope } from "./workflowReturnRecovery";

const id = z.number().int().positive();
const nativeInput = z
  .object({
    consignmentId: id,
    wholeShipment: z.boolean(),
    returnReason: z.string().min(3).max(255),
    refundShiftId: id.optional(),
    clientRequestId: z.string().min(8).max(64),
  })
  .strict();
const common = {
  scope: z
    .object({
      actorId: id,
      branchId: id,
      source: z.object({ kind: z.enum(WORKFLOW_SOURCE_KINDS), id }).strict(),
    })
    .strict(),
  phase: z.enum(["PENDING", "COMMITTED", "REJECTED"]),
  memberIds: z
    .array(id)
    .min(1)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length),
};
const legacySchema = z
  .object({
    version: z.literal(1),
    ...common,
    input: nativeInput,
  })
  .strict();
const snapshotSchema = z.union([
  legacySchema,
  z
    .object({
      version: z.literal(2),
      ...common,
      route: z.literal("CONSIGNMENT"),
      input: nativeInput,
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      ...common,
      route: z.literal("BARCODE"),
      consignmentId: id,
      wholeShipment: z.boolean(),
      input: z
        .object({
          barcode: z.string().trim().min(1).max(200),
          returnReason: z.string().min(3).max(255),
          refundShiftId: id.optional(),
          clientRequestId: z.string().min(8).max(64),
        })
        .strict(),
    })
    .strict(),
]);
export type WorkflowCommercialSnapshot = z.infer<typeof snapshotSchema>;
export function workflowCommercialRoute(snapshot: WorkflowCommercialSnapshot) {
  return snapshot.version === 1 ? "CONSIGNMENT" : snapshot.route;
}
export function chooseWorkflowCommercialRoute(
  allowBarcode: boolean,
  allowConsignment: boolean,
) {
  return allowBarcode ? "BARCODE" : allowConsignment ? "CONSIGNMENT" : null;
}
function command(snapshot: WorkflowCommercialSnapshot) {
  return {
    version: snapshot.version,
    route: workflowCommercialRoute(snapshot),
    ...(snapshot.version === 2 && snapshot.route === "BARCODE"
      ? {
          consignmentId: snapshot.consignmentId,
          wholeShipment: snapshot.wholeShipment,
        }
      : {}),
    input: snapshot.input,
    memberIds: snapshot.memberIds,
  };
}
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type WorkflowCommercialRecovery =
  | { state: "EMPTY" }
  | { state: "INVALID" | "UNAVAILABLE" }
  | { state: "SAVED"; snapshot: WorkflowCommercialSnapshot };
export function workflowCommercialKey(scope: WorkflowReturnScope) {
  return `erp:workflow-commercial-return:v1:${scope.actorId}:${scope.branchId}:${scope.source.kind}:${scope.source.id}`;
}
export function parseWorkflowCommercialSnapshot(
  raw: string,
  scope: WorkflowReturnScope,
): WorkflowCommercialSnapshot | null {
  if (raw.length > 30000) return null;
  try {
    const value = snapshotSchema.safeParse(JSON.parse(raw));
    if (
      !value.success ||
      value.data.scope.actorId !== scope.actorId ||
      value.data.scope.branchId !== scope.branchId ||
      value.data.scope.source.kind !== scope.source.kind ||
      value.data.scope.source.id !== scope.source.id ||
      !value.data.memberIds.includes(
        value.data.version === 2 && value.data.route === "BARCODE"
          ? value.data.consignmentId
          : value.data.input.consignmentId,
      ) ||
      (value.data.version === 2 && value.data.route === "BARCODE"
        ? value.data.wholeShipment
        : value.data.input.wholeShipment) !==
        value.data.memberIds.length > 1
    )
      return null;
    return value.data;
  } catch {
    return null;
  }
}
export function readWorkflowCommercial(
  storage: StoragePort,
  scope: WorkflowReturnScope,
): WorkflowCommercialRecovery {
  try {
    const raw = storage.getItem(workflowCommercialKey(scope));
    if (raw == null) return { state: "EMPTY" };
    const snapshot = parseWorkflowCommercialSnapshot(raw, scope);
    return snapshot ? { state: "SAVED", snapshot } : { state: "INVALID" };
  } catch {
    return { state: "UNAVAILABLE" };
  }
}
export function persistWorkflowCommercial(
  storage: StoragePort,
  snapshot: WorkflowCommercialSnapshot,
) {
  const safe = parseWorkflowCommercialSnapshot(
    JSON.stringify(snapshot),
    snapshot.scope,
  );
  if (!safe) return false;
  const raw = JSON.stringify(safe);
  try {
    const existing = readWorkflowCommercial(storage, snapshot.scope);
    if (existing.state === "INVALID" || existing.state === "UNAVAILABLE")
      return false;
    if (
      existing.state === "SAVED" &&
      (JSON.stringify(command(existing.snapshot)) !==
        JSON.stringify(command(safe)) ||
        (existing.snapshot.phase === "COMMITTED" &&
          snapshot.phase !== "COMMITTED") ||
        (existing.snapshot.phase !== "PENDING" && snapshot.phase === "PENDING"))
    )
      return false;
    const key = workflowCommercialKey(snapshot.scope);
    storage.setItem(key, raw);
    return storage.getItem(key) === raw;
  } catch {
    return false;
  }
}
export function clearWorkflowCommercial(
  storage: StoragePort,
  snapshot: WorkflowCommercialSnapshot,
) {
  const safe = parseWorkflowCommercialSnapshot(
    JSON.stringify(snapshot),
    snapshot.scope,
  );
  if (!safe) return false;
  try {
    const existing = readWorkflowCommercial(storage, snapshot.scope);
    if (existing.state === "EMPTY") return true;
    if (
      existing.state !== "SAVED" ||
      JSON.stringify(command(existing.snapshot)) !==
        JSON.stringify(command(safe))
    )
      return false;
    const key = workflowCommercialKey(snapshot.scope);
    storage.removeItem(key);
    return storage.getItem(key) == null;
  } catch {
    return false;
  }
}
