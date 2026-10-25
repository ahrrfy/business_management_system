import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  deliveryDocumentPrints,
  deliveryDocumentSnapshots,
} from "../../../drizzle/fulfillmentSchema";
import type { WorkflowDocumentType } from "../../../shared/deliveryWorkflow";
import type { Tx } from "../../db";
import { fulfillmentError } from "../fulfillment/core";
import { idempotencyHash } from "../idempotency";

export type DeliveryDocumentLayout =
  | "A4_12MM"
  | "THERMAL_80_CONTENT_72"
  | "LABEL_80X120_SAFE_3"
  | "LABEL_100X150_SAFE_3"
  | "MULTIPAGE_PACK";

export type DeliveryDocumentSourceType =
  | "INVOICE"
  | "CONSIGNMENT"
  | "SHIPMENT"
  | "REMITTANCE"
  | "RETURN_RECEIPT"
  | "AFTERCARE_EXECUTION"
  | "AFTERCARE_SETTLEMENT"
  | "PARTY_SETTLEMENT";

export interface CreateDeliveryDocumentSnapshotInput {
  documentType: WorkflowDocumentType;
  layout: DeliveryDocumentLayout;
  sourceType: DeliveryDocumentSourceType;
  sourceId: number;
  sourceVersion: string;
  branchId: number;
  shiftId?: number | null;
  eventKey: string;
  eventOccurredAt: Date;
  payload: unknown;
  createdBy: number;
}

function documentNumber(
  input: CreateDeliveryDocumentSnapshotInput,
  hash: string,
) {
  const kind = input.documentType.replaceAll("_", "-");
  return `DDS-${kind}-${input.sourceId}-${hash.slice(0, 12)}`.slice(0, 80);
}

function assertSameSnapshot(
  row: typeof deliveryDocumentSnapshots.$inferSelect,
  input: CreateDeliveryDocumentSnapshotInput,
  payloadHash: string,
) {
  if (
    row.payloadHash !== payloadHash ||
    row.sourceType !== input.sourceType ||
    row.sourceId !== input.sourceId ||
    row.sourceVersion !== input.sourceVersion ||
    row.branchId !== input.branchId ||
    (row.shiftId ?? null) !== (input.shiftId ?? null) ||
    row.layout !== input.layout ||
    row.eventOccurredAt.getTime() !== input.eventOccurredAt.getTime()
  )
    throw fulfillmentError(
      "لقطة المستند موجودة ببيانات مختلفة؛ لا يجوز استبدال أثر الطباعة الأصلي",
      "CONFLICT",
    );
}

/**
 * Creates one immutable event snapshot. A replay returns the original row; it
 * never refreshes payload from live invoice/consignment values.
 */
export async function createDeliveryDocumentSnapshotTx(
  tx: Tx,
  input: CreateDeliveryDocumentSnapshotInput,
) {
  const payloadHash = idempotencyHash(input.payload);
  const existing = (
    await tx
      .select()
      .from(deliveryDocumentSnapshots)
      .where(
        and(
          eq(deliveryDocumentSnapshots.eventKey, input.eventKey),
          eq(deliveryDocumentSnapshots.documentType, input.documentType),
        ),
      )
      .for("update")
      .limit(1)
  )[0];
  if (existing) {
    assertSameSnapshot(existing, input, payloadHash);
    return { snapshot: existing, idempotentReplay: true };
  }

  await tx
    .insert(deliveryDocumentSnapshots)
    .values({
      documentNumber: documentNumber(input, payloadHash),
      documentType: input.documentType,
      layout: input.layout,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      eventKey: input.eventKey,
      eventOccurredAt: input.eventOccurredAt,
      payload: input.payload,
      payloadHash,
      createdBy: input.createdBy,
    })
    // Concurrency loses to the unique event key but never mutates the snapshot.
    .onDuplicateKeyUpdate({
      set: { id: sql`${deliveryDocumentSnapshots.id}` },
    });

  const snapshot = (
    await tx
      .select()
      .from(deliveryDocumentSnapshots)
      .where(
        and(
          eq(deliveryDocumentSnapshots.eventKey, input.eventKey),
          eq(deliveryDocumentSnapshots.documentType, input.documentType),
        ),
      )
      .limit(1)
  )[0];
  if (!snapshot) throw fulfillmentError("تعذر تثبيت لقطة المستند", "CONFLICT");
  assertSameSnapshot(snapshot, input, payloadHash);
  return { snapshot, idempotentReplay: false };
}

export interface RequestDeliveryDocumentPrintInput {
  snapshotId: number;
  branchId: number;
  clientRequestId: string;
  copyType: "ORIGINAL" | "REPRINT";
  reason?: string | null;
  printerKey?: string | null;
  requestedBy: number;
}

/** Registers an operational print attempt only; no accounting or inventory rows. */
export async function requestDeliveryDocumentPrintTx(
  tx: Tx,
  input: RequestDeliveryDocumentPrintInput,
) {
  const reason = input.reason?.trim() || null;
  if (input.copyType === "REPRINT" && (!reason || reason.length < 3))
    throw fulfillmentError("سبب إعادة الطباعة مطلوب", "BAD_REQUEST");
  const requestHash = idempotencyHash({
    snapshotId: input.snapshotId,
    branchId: input.branchId,
    copyType: input.copyType,
    reason,
    printerKey: input.printerKey ?? null,
  });
  const previous = (
    await tx
      .select()
      .from(deliveryDocumentPrints)
      .where(eq(deliveryDocumentPrints.clientRequestId, input.clientRequestId))
      .for("update")
      .limit(1)
  )[0];
  if (previous) {
    if (previous.requestHash !== requestHash)
      throw fulfillmentError("مفتاح الطباعة مستخدم لطلب مختلف", "CONFLICT");
    return { print: previous, idempotentReplay: true };
  }
  const snapshot = (
    await tx
      .select({
        id: deliveryDocumentSnapshots.id,
        branchId: deliveryDocumentSnapshots.branchId,
      })
      .from(deliveryDocumentSnapshots)
      .where(eq(deliveryDocumentSnapshots.id, input.snapshotId))
      .limit(1)
  )[0];
  if (!snapshot) throw fulfillmentError("لقطة المستند غير موجودة", "NOT_FOUND");
  if (snapshot.branchId !== input.branchId)
    throw fulfillmentError("المستند خارج نطاق الفرع الحالي", "FORBIDDEN");
  await tx
    .insert(deliveryDocumentPrints)
    .values({
      snapshotId: input.snapshotId,
      clientRequestId: input.clientRequestId,
      requestHash,
      copyType: input.copyType,
      reason,
      printerKey: input.printerKey ?? null,
      requestedBy: input.requestedBy,
    })
    .onDuplicateKeyUpdate({ set: { id: sql`${deliveryDocumentPrints.id}` } });
  const print = (
    await tx
      .select()
      .from(deliveryDocumentPrints)
      .where(eq(deliveryDocumentPrints.clientRequestId, input.clientRequestId))
      .limit(1)
  )[0]!;
  if (print.requestHash !== requestHash)
    throw fulfillmentError("مفتاح الطباعة مستخدم لطلب مختلف", "CONFLICT");
  return { print, idempotentReplay: false };
}

export async function completeDeliveryDocumentPrintTx(
  tx: Tx,
  input: {
    printId: number;
    branchId: number;
    status: "SENT" | "FAILED" | "CANCELLED";
    errorMessage?: string | null;
  },
) {
  const row = (
    await tx
      .select()
      .from(deliveryDocumentPrints)
      .where(eq(deliveryDocumentPrints.id, input.printId))
      .for("update")
      .limit(1)
  )[0];
  if (!row) throw fulfillmentError("طلب الطباعة غير موجود", "NOT_FOUND");
  const snapshot = (
    await tx
      .select({ branchId: deliveryDocumentSnapshots.branchId })
      .from(deliveryDocumentSnapshots)
      .where(eq(deliveryDocumentSnapshots.id, row.snapshotId))
      .limit(1)
  )[0];
  if (!snapshot || snapshot.branchId !== input.branchId)
    throw fulfillmentError("طلب الطباعة خارج نطاق الفرع الحالي", "FORBIDDEN");
  const errorMessage = input.errorMessage?.trim() || null;
  if (input.status === "FAILED" && !errorMessage)
    throw fulfillmentError("سبب فشل الطباعة مطلوب", "BAD_REQUEST");
  if (input.status !== "FAILED" && errorMessage)
    throw fulfillmentError(
      "لا يسجل خطأ لعملية طباعة ناجحة أو ملغاة",
      "BAD_REQUEST",
    );
  if (row.status !== "REQUESTED") {
    if (row.status === input.status && row.errorMessage === errorMessage)
      return { print: row, idempotentReplay: true };
    throw fulfillmentError("طلب الطباعة منتهٍ بنتيجة مختلفة", "CONFLICT");
  }
  const completedAt = new Date();
  await tx
    .update(deliveryDocumentPrints)
    .set({ status: input.status, errorMessage, completedAt })
    .where(eq(deliveryDocumentPrints.id, row.id));
  return {
    print: {
      ...row,
      status: input.status,
      errorMessage,
      completedAt,
    },
    idempotentReplay: false,
  };
}

export async function listDeliveryDocumentSnapshotsTx(
  tx: Tx,
  input: {
    sourceType: DeliveryDocumentSourceType;
    sourceId: number;
    branchId: number;
  },
) {
  const snapshots = await tx
    .select()
    .from(deliveryDocumentSnapshots)
    .where(
      and(
        eq(deliveryDocumentSnapshots.sourceType, input.sourceType),
        eq(deliveryDocumentSnapshots.sourceId, input.sourceId),
        eq(deliveryDocumentSnapshots.branchId, input.branchId),
      ),
    )
    .orderBy(desc(deliveryDocumentSnapshots.createdAt));
  if (!snapshots.length) return [];
  const prints = await tx
    .select()
    .from(deliveryDocumentPrints)
    .where(
      inArray(
        deliveryDocumentPrints.snapshotId,
        snapshots.map((snapshot) => Number(snapshot.id)),
      ),
    )
    .orderBy(desc(deliveryDocumentPrints.requestedAt));
  return snapshots.map((snapshot) => ({
    ...snapshot,
    printHistory: prints.filter(
      (print) => Number(print.snapshotId) === Number(snapshot.id),
    ),
  }));
}
