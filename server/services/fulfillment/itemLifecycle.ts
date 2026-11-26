import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  fulfillmentRequestItems,
  fulfillmentRequests,
} from "../../../drizzle/fulfillmentSchema";
import type { Tx } from "../../db";

/**
 * Leaf helper for `fulfillmentRequestItems.isActive` transitions.
 * Imports ONLY schema + drizzle-orm + db types to avoid circular dependencies
 * between `fulfillment/*`, `delivery/*`, and `workOrder/*`.
 *
 * Matches member items strictly by their own source document (`invoiceId` /
 * `materializedInvoiceId` / `workOrderId`), NEVER blindly by `consignmentId`
 * alone (because grouped shipments stamp `leaderId` across all member items).
 */
export async function deactivateReleasedFulfillmentItemForConsignmentTx(
  tx: Tx,
  cn: {
    id: number;
    fulfillmentRequestId?: number | null;
    invoiceId?: number | null;
    workOrderId?: number | null;
  },
): Promise<number> {
  const sourceConds = [
    ...(cn.invoiceId != null
      ? [
          eq(fulfillmentRequestItems.invoiceId, Number(cn.invoiceId)),
          eq(
            fulfillmentRequestItems.materializedInvoiceId,
            Number(cn.invoiceId),
          ),
        ]
      : []),
    ...(cn.workOrderId != null
      ? [eq(fulfillmentRequestItems.workOrderId, Number(cn.workOrderId))]
      : []),
  ];
  if (!sourceConds.length) {
    if (cn.fulfillmentRequestId == null) return 0;
    const rows = await tx
      .select({ id: fulfillmentRequestItems.id })
      .from(fulfillmentRequestItems)
      .where(
        and(
          eq(
            fulfillmentRequestItems.requestId,
            Number(cn.fulfillmentRequestId),
          ),
          eq(fulfillmentRequestItems.consignmentId, Number(cn.id)),
          eq(fulfillmentRequestItems.status, "RELEASED"),
          eq(fulfillmentRequestItems.isActive, true),
        ),
      )
      .for("update");
    if (!rows.length) return 0;
    await tx
      .update(fulfillmentRequestItems)
      .set({ isActive: false })
      .where(
        inArray(
          fulfillmentRequestItems.id,
          rows.map((r) => Number(r.id)),
        ),
      );
    return rows.length;
  }

  const rows = await tx
    .select({ id: fulfillmentRequestItems.id })
    .from(fulfillmentRequestItems)
    .where(
      and(
        ...(cn.fulfillmentRequestId != null
          ? [
              eq(
                fulfillmentRequestItems.requestId,
                Number(cn.fulfillmentRequestId),
              ),
            ]
          : []),
        eq(fulfillmentRequestItems.status, "RELEASED"),
        eq(fulfillmentRequestItems.isActive, true),
        or(...sourceConds),
      ),
    )
    .for("update");
  if (!rows.length) return 0;
  await tx
    .update(fulfillmentRequestItems)
    .set({ isActive: false })
    .where(
      inArray(
        fulfillmentRequestItems.id,
        rows.map((r) => Number(r.id)),
      ),
    );
  return rows.length;
}

/**
 * Detaches a work order (and its linked invoice, if any) from all active
 * `fulfillmentRequestItems` when switching to direct pickup, delivering at
 * the counter, cancelling, or reversing delivery.
 * Respects `chk_fri_active`:
 * - `RELEASED` -> `isActive = false` (retains `status = 'RELEASED'`)
 * - `WAITING` / `READY` -> `status = 'CANCELLED', isActive = false`
 */
export async function detachWorkOrderFromOpenFulfillmentRequestsTx(
  tx: Tx,
  input: {
    workOrderId: number;
    invoiceId?: number | null;
    actorUserId?: number | null;
    reason?: string;
  },
): Promise<{ detachedCount: number }> {
  const sourceConds = [
    eq(fulfillmentRequestItems.workOrderId, Number(input.workOrderId)),
    ...(input.invoiceId != null
      ? [
          eq(fulfillmentRequestItems.invoiceId, Number(input.invoiceId)),
          eq(
            fulfillmentRequestItems.materializedInvoiceId,
            Number(input.invoiceId),
          ),
        ]
      : []),
  ];
  const activeItems = await tx
    .select()
    .from(fulfillmentRequestItems)
    .where(and(eq(fulfillmentRequestItems.isActive, true), or(...sourceConds)))
    .for("update");
  if (!activeItems.length) return { detachedCount: 0 };

  const releasedIds = activeItems
    .filter((item) => item.status === "RELEASED")
    .map((item) => Number(item.id));
  const pendingIds = activeItems
    .filter((item) => item.status === "WAITING" || item.status === "READY")
    .map((item) => Number(item.id));

  if (releasedIds.length) {
    await tx
      .update(fulfillmentRequestItems)
      .set({ isActive: false })
      .where(inArray(fulfillmentRequestItems.id, releasedIds));
  }
  if (pendingIds.length) {
    await tx
      .update(fulfillmentRequestItems)
      .set({ status: "CANCELLED", isActive: false })
      .where(inArray(fulfillmentRequestItems.id, pendingIds));
  }

  // If an unreleased DRAFT/PREPARING/PARTIALLY_RELEASED request now has zero active
  // unreleased items, transition its header cleanly so no empty shell stays open.
  const touchedRequestIds = Array.from(
    new Set(
      activeItems
        .filter((item) => item.status === "WAITING" || item.status === "READY")
        .map((item) => Number(item.requestId)),
    ),
  );
  for (const requestId of touchedRequestIds) {
    const [req] = await tx
      .select()
      .from(fulfillmentRequests)
      .where(eq(fulfillmentRequests.id, requestId))
      .for("update")
      .limit(1);
    if (!req) continue;
    const remaining = await tx
      .select({
        id: fulfillmentRequestItems.id,
        status: fulfillmentRequestItems.status,
        isActive: fulfillmentRequestItems.isActive,
      })
      .from(fulfillmentRequestItems)
      .where(eq(fulfillmentRequestItems.requestId, requestId))
      .for("update");
    const hasPending = remaining.some(
      (r) => r.isActive && (r.status === "WAITING" || r.status === "READY"),
    );
    const hasReleased = remaining.some((r) => r.status === "RELEASED");
    if (!hasPending) {
      if (
        (req.status === "DRAFT" || req.status === "PREPARING") &&
        !hasReleased
      ) {
        await tx
          .update(fulfillmentRequests)
          .set({
            status: "CANCELLED",
            cancelledBy: input.actorUserId ?? req.createdBy,
            cancelledAt: new Date(),
            cancellationReason:
              input.reason ?? "فُصل المستند للاستلام المباشر أو الإلغاء",
            version: sql`${fulfillmentRequests.version} + 1`,
          })
          .where(eq(fulfillmentRequests.id, requestId));
      } else if (req.status === "PARTIALLY_RELEASED" && hasReleased) {
        await tx
          .update(fulfillmentRequests)
          .set({
            status: "RELEASED",
            version: sql`${fulfillmentRequests.version} + 1`,
          })
          .where(eq(fulfillmentRequests.id, requestId));
      }
    }
  }

  return { detachedCount: activeItems.length };
}

/**
 * Re-claims `isActive = true` on the `RELEASED` items of a cancelled/returned
 * fulfillment shipment when `reassignFulfillmentRequestInTx` re-dispatches them.
 * Fails closed with a clear Arabic CONFLICT error if any item was already claimed
 * by a newer active fulfillment request.
 */
export async function reactivateFulfillmentItemsForReassignTx(
  tx: Tx,
  input: {
    requestId: number;
    leaderConsignmentId: number;
    invoiceIds: number[];
  },
): Promise<void> {
  const items = await tx
    .select()
    .from(fulfillmentRequestItems)
    .where(
      and(
        eq(fulfillmentRequestItems.requestId, input.requestId),
        eq(fulfillmentRequestItems.consignmentId, input.leaderConsignmentId),
        eq(fulfillmentRequestItems.status, "RELEASED"),
      ),
    )
    .for("update");
  const targetItems = items.filter((item) => {
    const invId = item.invoiceId ?? item.materializedInvoiceId;
    return invId == null || input.invoiceIds.includes(Number(invId));
  });
  const inactiveItems = targetItems.filter((item) => !item.isActive);
  if (!inactiveItems.length) return;

  const checkInvoiceIds = inactiveItems.flatMap((item) => {
    const invId = item.invoiceId ?? item.materializedInvoiceId;
    return invId != null ? [Number(invId)] : [];
  });
  const checkOrderIds = inactiveItems.flatMap((item) =>
    item.workOrderId != null ? [Number(item.workOrderId)] : [],
  );
  const conflictConds = [
    ...(checkInvoiceIds.length
      ? [inArray(fulfillmentRequestItems.activeInvoiceId, checkInvoiceIds)]
      : []),
    ...(checkOrderIds.length
      ? [inArray(fulfillmentRequestItems.activeWorkOrderId, checkOrderIds)]
      : []),
  ];
  if (conflictConds.length) {
    const [conflict] = await tx
      .select({ requestId: fulfillmentRequestItems.requestId })
      .from(fulfillmentRequestItems)
      .where(or(...conflictConds))
      .limit(1);
    if (conflict && Number(conflict.requestId) !== Number(input.requestId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذر إعادة إسناد طلب التجهيز القديم",
          why: `أحد مستندات الدفعة أُدرج بالفعل في طلب تجهيز نشط أحدث (#${conflict.requestId})`,
          doThis:
            "أكمل الإرسال من طلب التجهيز الأحدث بدلاً من إعادة تنشيط الدفعة القديمة",
        }),
      });
    }
  }

  await tx
    .update(fulfillmentRequestItems)
    .set({ isActive: true })
    .where(
      inArray(
        fulfillmentRequestItems.id,
        inactiveItems.map((item) => Number(item.id)),
      ),
    );
}
