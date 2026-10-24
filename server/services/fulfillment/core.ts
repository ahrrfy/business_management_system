import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { appErrorMessage } from "../../../shared/errors";
import type { FulfillmentMutationIdentity } from "../../../shared/fulfillment";
import {
  aftercareCases,
  fulfillmentCharges,
  fulfillmentRequests,
} from "../../../drizzle/fulfillmentSchema";
import { canCrossBranches } from "../../lib/branchAuthority";
import type { Tx } from "../../db";
import type { Actor } from "../tx";
import { enqueuePostCommit } from "../tx";
import { publishRealtimeEvent } from "../../realtime";
import { REALTIME_EVENT_TYPES } from "../../../shared/realtimeEvents";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";

/** Scope checks supplement the router's existing module/operation permission gate. */
export function fulfillmentError(
  why: string,
  code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" = "BAD_REQUEST",
): TRPCError {
  return new TRPCError({
    code,
    message: appErrorMessage({
      what: "تعذّر إتمام إجراء التوصيل أو المعالجة",
      why,
      doThis:
        "حدّث المستند وراجع الفرع والكمية والمبالغ والأدلة، ثم أعد المحاولة؛ اطلب مراجعة المسؤول إن بقي التعارض",
    }),
  });
}

export function assertFulfillmentBranch(actor: Actor, branchId: number): void {
  if (!Number.isSafeInteger(branchId) || branchId <= 0)
    throw fulfillmentError("معرّف الفرع غير صالح");
  if (
    !Number.isSafeInteger(actor.userId) ||
    actor.userId <= 0 ||
    (!canCrossBranches(actor) && actor.branchId !== branchId)
  ) {
    throw fulfillmentError("المستند يخص فرعاً خارج نطاق حسابك", "FORBIDDEN");
  }
}

/** Reuses canonical JSON + SHA-256, including Date/undefined storage normalization. */
export function fulfillmentFingerprint(value: unknown): string {
  return idempotencyHash(value);
}

export function assertFulfillmentVersion(
  row: { version: number },
  expectedVersion: number,
): void {
  if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion <= 0 ||
    row.version !== expectedVersion
  ) {
    throw fulfillmentError(
      "تغيّر المستند منذ فتحه أو أن نسخته غير صالحة؛ لم يُنفذ الإجراء",
      "CONFLICT",
    );
  }
}

function assertId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0)
    throw fulfillmentError("معرّف المستند غير صالح");
}

export async function loadFulfillmentRequestTx(
  tx: Tx,
  id: number,
  actor: Actor,
  options: { lock?: boolean } = {},
) {
  assertId(id);
  const query = tx
    .select()
    .from(fulfillmentRequests)
    .where(eq(fulfillmentRequests.id, id));
  const [row] = options.lock
    ? await query.for("update").limit(1)
    : await query.limit(1);
  if (!row) throw fulfillmentError("طلب التوصيل غير موجود", "NOT_FOUND");
  assertFulfillmentBranch(actor, row.branchId);
  return row;
}

export async function loadAftercareCaseTx(
  tx: Tx,
  id: number,
  actor: Actor,
  options: { lock?: boolean } = {},
) {
  assertId(id);
  const query = tx
    .select()
    .from(aftercareCases)
    .where(eq(aftercareCases.id, id));
  const [row] = options.lock
    ? await query.for("update").limit(1)
    : await query.limit(1);
  if (!row) throw fulfillmentError("حالة المعالجة غير موجودة", "NOT_FOUND");
  assertFulfillmentBranch(actor, row.branchId);
  return row;
}

export async function loadFulfillmentChargeTx(
  tx: Tx,
  id: number,
  actor: Actor,
  options: { lock?: boolean } = {},
) {
  assertId(id);
  const query = tx
    .select()
    .from(fulfillmentCharges)
    .where(eq(fulfillmentCharges.id, id));
  const [row] = options.lock
    ? await query.for("update").limit(1)
    : await query.limit(1);
  if (!row) throw fulfillmentError("مستند الأجور غير موجود", "NOT_FOUND");
  assertFulfillmentBranch(actor, row.branchId);
  return row;
}

/** Bound identity excludes authorization flags; operation gate still runs on replay. */
export function fulfillmentMutationContext(
  operation: string,
  identity: Pick<FulfillmentMutationIdentity, "clientRequestId">,
  payload: unknown,
  actor: Actor,
  branchId: number,
) {
  assertFulfillmentBranch(actor, branchId);
  if (!/^[a-z][a-zA-Z0-9_.:-]*$/.test(operation) || `fulfillment.${operation}`.length > 40)
    throw fulfillmentError("اسم الإجراء غير صالح");
  if (
    identity.clientRequestId.trim().length < 8 ||
    identity.clientRequestId.length > 80
  )
    throw fulfillmentError(
      "معرّف إعادة المحاولة يجب أن يتراوح بين 8 و80 محرفاً",
    );
  return {
    operation: `fulfillment.${operation}`,
    branchId,
    clientRequestId: identity.clientRequestId,
    sourceHash: fulfillmentFingerprint({
      operation,
      actorId: actor.userId,
      branchId,
      payload,
    }),
  };
}
export type FulfillmentMutationContext = ReturnType<
  typeof fulfillmentMutationContext
>;

/** Call after the domain row lock and before expectedVersion/state validation. */
export function findFulfillmentReplayTx(
  tx: Tx,
  context: FulfillmentMutationContext,
): Promise<number | null> {
  return checkIdempotency(
    tx,
    context.operation,
    context.clientRequestId,
    context.sourceHash,
    { requireStoredHash: true, forUpdate: true },
  );
}

/** Same transaction as all domain effects; refId points to the original result. */
export async function recordFulfillmentMutationTx(
  tx: Tx,
  context: FulfillmentMutationContext,
  refId: number,
): Promise<void> {
  assertId(refId);
  await recordIdempotencyKey(
    tx,
    context.operation,
    context.clientRequestId,
    refId,
    context.sourceHash,
  );
  if (/^fulfillment\.(aftercare|charges?)\./.test(context.operation)) {
    enqueuePostCommit(tx, () => {
      publishRealtimeEvent(
        /\.(create|settlementRequest)$/.test(context.operation)
          ? REALTIME_EVENT_TYPES.PENDING_APPROVAL_CREATED
          : REALTIME_EVENT_TYPES.APPROVAL_RESOLVED,
        { entityType: context.operation, entityId: refId, branchId: context.branchId, action: context.operation },
        { branchId: context.branchId },
      );
    });
  }
}
