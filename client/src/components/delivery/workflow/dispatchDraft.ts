import { z } from "zod";
import { WORKFLOW_SOURCE_KINDS } from "@shared/deliveryWorkflow";
import type {
  WorkflowDispatchBatchResult,
  WorkflowScanPreview,
} from "@shared/deliveryWorkflow";

const money = z
  .string()
  .regex(/^\d+(?:\.\d{1,2})?$/)
  .max(24);
const pending = z.object({
  sources: z
    .array(
      z.object({
        kind: z.enum(WORKFLOW_SOURCE_KINDS),
        id: z.number().int().positive(),
        expectedVersion: z.string().min(1).max(128),
      }),
    )
    .min(1)
    .max(30),
  branchId: z.number().int().positive().optional(),
  partyId: z.number().int().positive(),
  assignedUserId: z.number().int().positive().optional(),
  collectCreditOnDelivery: z.boolean().optional(),
  deliveryFee: money,
  feeCollection: z.enum(["COURIER", "COUNTER", "SHOP"]),
  recipientName: z.string().max(255),
  recipientPhone: z.string().max(32),
  deliveryAddress: z.string().max(2000),
  externalTrackingRef: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  clientRequestId: z.string().min(8).max(56),
});
const committed = z.object({
  branchId: z.number().int().positive(),
  partyName: z.string().max(255),
  result: z.object({
    operationId: z.string().min(1).max(160),
    consignmentId: z.number().int().positive(),
    consignmentNumber: z.string().min(1).max(100),
    fulfillmentRequestId: z.number().int().positive().nullable(),
    invoiceIds: z.array(z.number().int().positive()).max(30),
    newVersion: z.string().min(1).max(128),
    nextAction: z.enum([
      "dispatch",
      "collect",
      "cancelAssignment",
      "return",
      "edit",
      "aftercare",
      "reassign",
      "declareReturn",
      "print",
      "monitor",
    ]),
    documentSnapshotIds: z.array(z.number().int().positive()).max(20),
    actualEffects: z.object({
      saleCreated: z.boolean(),
      inventoryIssued: z.boolean(),
      customerCollectionCreated: z.boolean(),
      deliveryFeePosted: z.boolean(),
    }),
    idempotentReplay: z.boolean(),
  }),
});
const schema = z.object({
  version: z.literal(1),
  savedAt: z.number(),
  codes: z.array(z.string().min(1).max(2048)).max(30),
  partyId: z.string().max(24),
  driverId: z.string().max(24),
  name: z.string().max(255),
  phone: z.string().max(32),
  address: z.string().max(2000),
  deliveryFee: money,
  feeCollection: z.enum(["COURIER", "COUNTER", "SHOP"]),
  tracking: z.string().max(100),
  collectCreditOnDelivery: z.boolean().optional(),
  notes: z.string().max(2000),
  pending: pending.nullable(),
  lastCommitted: committed.nullable().default(null),
});
export type WorkflowDispatchDraft = z.infer<typeof schema>;
export const dispatchDraftKey = (userId: number, branchId: number) =>
  `erp:workflow-dispatch:${userId}:${branchId}`;
export function emptyDispatchDraft(): WorkflowDispatchDraft {
  return {
    version: 1,
    savedAt: Date.now(),
    codes: [],
    partyId: "",
    driverId: "",
    name: "",
    phone: "",
    address: "",
    deliveryFee: "0",
    feeCollection: "COURIER",
    tracking: "",
    notes: "",
    pending: null,
    lastCommitted: null,
  };
}
export function parseDispatchDraft(
  raw: string | null,
  branchId: number,
  now = Date.now(),
): WorkflowDispatchDraft | null {
  if (!raw || raw.length > 100_000) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      now - parsed.data.savedAt > 24 * 60 * 60_000 ||
      parsed.data.savedAt > now + 60_000
    )
      return null;
    if (
      parsed.data.pending?.branchId != null &&
      parsed.data.pending.branchId !== branchId
    )
      return null;
    if (
      parsed.data.lastCommitted != null &&
      parsed.data.lastCommitted.branchId !== branchId
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Pending proof is recovered as one command; saved codes are never reposted as fresh work. */
export function dispatchRestoreCodes(draft: WorkflowDispatchDraft): string[] {
  return draft.pending ? [] : Array.from(new Set(draft.codes));
}
export function dispatchRestorePlan(
  restoredGeneration: number | null,
  generation: number,
  draft: WorkflowDispatchDraft,
) {
  return restoredGeneration === generation
    ? null
    : {
        generation,
        codes: dispatchRestoreCodes(draft),
        requiresRecovery: draft.pending != null,
      };
}

/** Keep queued, unresolved scans durable even while earlier FIFO reads are still running. */
export function appendDispatchDraftCode(
  draft: WorkflowDispatchDraft,
  raw: string,
): WorkflowDispatchDraft {
  const code = raw.trim();
  if (
    !code ||
    draft.pending ||
    draft.codes.includes(code) ||
    draft.codes.length >= 30
  )
    return draft;
  return { ...draft, codes: [...draft.codes, code], collectCreditOnDelivery: undefined };
}

export function commitDispatchDraft(
  draft: WorkflowDispatchDraft,
  result: WorkflowDispatchBatchResult,
  branchId: number,
  partyName: string,
): WorkflowDispatchDraft {
  return {
    ...draft,
    codes: [],
    pending: null,
    name: "",
    phone: "",
    address: "",
    tracking: "",
    notes: "",
    deliveryFee: "0",
    feeCollection: "COURIER",
    collectCreditOnDelivery: undefined,
    lastCommitted: { branchId, result, partyName },
  };
}

/** Printing uses the server's actual source projection, including after a browser reload. */
export function dispatchPrintIdentity(
  preview: Pick<WorkflowScanPreview, "printSource">,
) {
  const source = preview.printSource;
  const orderKind =
    source.sourceType === "AFTERCARE_EXECUTION"
      ? ("aftercare" as const)
      : source.sourceType === "FULFILLMENT_REQUEST"
        ? ("fulfillmentRequest" as const)
        : source.sourceType === "WORK_ORDER"
          ? ("workOrder" as const)
          : source.sourceType === "ONLINE_ORDER"
            ? ("onlineOrder" as const)
            : source.sourceType === "INVOICE"
              ? ("invoice" as const)
              : undefined;
  return {
    orderNumber: source.number,
    orderKind,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    invoiceId: source.invoiceId ?? null,
    invoiceNumber: source.invoiceNumber,
    workOrderId: source.workOrderId,
    fulfillmentRequestId: source.fulfillmentRequestId,
    aftercareExecutionId: source.aftercareExecutionId,
  };
}
export function readDispatchDraft(
  userId: number,
  branchId: number,
): WorkflowDispatchDraft {
  try {
    return (
      parseDispatchDraft(
        sessionStorage.getItem(dispatchDraftKey(userId, branchId)),
        branchId,
      ) ?? emptyDispatchDraft()
    );
  } catch {
    return emptyDispatchDraft();
  }
}
export function writeDispatchDraft(
  userId: number,
  branchId: number,
  draft: WorkflowDispatchDraft,
): void {
  try {
    sessionStorage.setItem(
      dispatchDraftKey(userId, branchId),
      JSON.stringify({ ...draft, savedAt: Date.now() }),
    );
  } catch {
    /* Storage availability never changes a server posting result. */
  }
}
