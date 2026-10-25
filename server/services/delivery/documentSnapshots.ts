import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryEvents,
  deliveryShipmentMembers,
} from "../../../drizzle/schema";
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

export interface ShipmentDispatchDocumentPayload {
  schemaVersion: 1;
  operationId: string;
  eventOccurredAt: string;
  evidence: {
    mode: "COMMITTED_DISPATCH_EVENT" | "HISTORICAL_ORIGINAL_EVIDENCE";
    eventId?: number;
    eventKey: string;
    unavailableFields: string[];
    notice?: string;
  };
  shipment: {
    consignmentId: number;
    consignmentNumber: string;
    fulfillmentRequestId: number | null;
    branchId: number;
    partyId: number;
    assignedUserId: number | null;
    sourceType: string;
    sourceId: number;
    members: Array<{
      id: number;
      consignmentNumber: string;
      invoiceId: number | null;
      sourceType: string;
      sourceId: number;
    }>;
  };
  party: { id: number; name: string };
  recipient: {
    name: string | null;
    phone: string | null;
    address: string | null;
    governorate: string | null;
  };
  money: {
    codAmount: string | null;
    deliveryFee: string | null;
    feeCollection: "COURIER" | "COUNTER" | "SHOP" | null;
    customerCollectionAtDispatch: "0.00";
    currentTotal: string | null;
    paidAmount: string | null;
  };
  invoiceIds: number[];
  invoices: Array<{
    id: number;
    invoiceNumber: string;
    total: string | null;
    paidAmount?: string | null;
    returnedTotal?: string | null;
    status?: string | null;
    identityEvidence?: "EVENT_TIME_RECORD" | "INTERNAL_ID_ONLY";
  }>;
  aftercareNotice: string | null;
}

export interface CreateShipmentDispatchDocumentsInput {
  consignmentId: number;
  branchId: number;
  shiftId?: number | null;
  eventKey: string;
  eventOccurredAt: Date;
  createdBy: number;
  payload: ShipmentDispatchDocumentPayload;
  sourceVersion?: string;
  documentTypes?: Array<"DISPATCH_SLIP" | "SHIPPING_LABEL">;
}

function documentNumber(
  input: CreateDeliveryDocumentSnapshotInput,
  hash: string,
) {
  const kind = input.documentType.replaceAll("_", "-");
  return `DDS-${kind}-${input.sourceId}-${hash.slice(0, 12)}`.slice(0, 80);
}

function timestampSecond(value: Date): number {
  return Math.floor(value.getTime() / 1_000) * 1_000;
}

function assertSameSnapshot(
  row: typeof deliveryDocumentSnapshots.$inferSelect,
  input: CreateDeliveryDocumentSnapshotInput,
  payloadHash: string,
) {
  const mismatches = [
    row.payloadHash !== payloadHash ? "payload" : null,
    row.sourceType !== input.sourceType ? "sourceType" : null,
    row.sourceId !== input.sourceId ? "sourceId" : null,
    row.sourceVersion !== input.sourceVersion ? "sourceVersion" : null,
    row.branchId !== input.branchId ? "branchId" : null,
    (row.shiftId ?? null) !== (input.shiftId ?? null) ? "shiftId" : null,
    row.layout !== input.layout ? "layout" : null,
    row.eventOccurredAt.getTime() !== timestampSecond(input.eventOccurredAt)
      ? "eventOccurredAt"
      : null,
  ].filter((value): value is string => value != null);
  if (mismatches.length)
    throw fulfillmentError(
      `لقطة المستند موجودة ببيانات مختلفة (${mismatches.join("، ")})؛ لا يجوز استبدال أثر الطباعة الأصلي`,
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
      // MySQL TIMESTAMP without FSP can round fractional seconds. Normalize
      // deliberately so event identity is stable across insert and replay.
      eventOccurredAt: new Date(timestampSecond(input.eventOccurredAt)),
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

/**
 * Persists the two documents emitted by a committed dispatch event. The input
 * is the caller's event-time evidence; this helper never reloads invoice money
 * or replaces it with later live values.
 */
export async function createShipmentDispatchDocumentSnapshotsTx(
  tx: Tx,
  input: CreateShipmentDispatchDocumentsInput,
) {
  if (
    !Number.isSafeInteger(input.consignmentId) ||
    input.consignmentId <= 0 ||
    !Number.isSafeInteger(input.createdBy) ||
    input.createdBy <= 0 ||
    !Number.isFinite(input.eventOccurredAt.getTime())
  )
    throw fulfillmentError(
      "دليل حدث الإسناد غير صالح لإنشاء المطبوعات",
      "BAD_REQUEST",
    );
  if (
    input.payload.shipment.consignmentId !== input.consignmentId ||
    input.payload.shipment.branchId !== input.branchId ||
    input.payload.eventOccurredAt !== input.eventOccurredAt.toISOString() ||
    input.payload.evidence.eventKey !== input.eventKey
  )
    throw fulfillmentError(
      "هوية لقطة الإسناد لا تطابق دليل الحدث الأصلي",
      "CONFLICT",
    );

  const sourceVersion = input.sourceVersion ?? idempotencyHash(input.payload);
  const snapshotIds: number[] = [];
  const requestedTypes = new Set(
    input.documentTypes ?? ["DISPATCH_SLIP", "SHIPPING_LABEL"],
  );
  for (const document of [
    {
      documentType: "DISPATCH_SLIP" as const,
      layout: "THERMAL_80_CONTENT_72" as const,
    },
    {
      documentType: "SHIPPING_LABEL" as const,
      layout: "LABEL_100X150_SAFE_3" as const,
    },
  ]) {
    if (!requestedTypes.has(document.documentType)) continue;
    const created = await createDeliveryDocumentSnapshotTx(tx, {
      documentType: document.documentType,
      layout: document.layout,
      sourceType: "SHIPMENT",
      sourceId: input.consignmentId,
      sourceVersion,
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      eventKey: input.eventKey,
      eventOccurredAt: input.eventOccurredAt,
      payload: { ...input.payload, documentType: document.documentType },
      createdBy: input.createdBy,
    });
    snapshotIds.push(Number(created.snapshot.id));
  }
  return snapshotIds.sort((a, b) => a - b);
}

const assignmentEventTypes = [
  "OUT_FOR_DELIVERY",
  "ASSIGNMENT_REACTIVATED",
  "REASSIGNED",
] as const;

function eventPayload(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Explicit, authorized bootstrap for shipments created before document
 * snapshots existed. It requires an immutable assignment event whose party and
 * source identity still match the recorded consignment. Mutable invoice totals,
 * payment state and directory labels are deliberately recorded as unavailable.
 */
export async function bootstrapHistoricalShipmentDocumentSnapshotsTx(
  tx: Tx,
  input: { consignmentId: number; branchId: number },
) {
  const existing = await tx
    .select()
    .from(deliveryDocumentSnapshots)
    .where(
      and(
        eq(deliveryDocumentSnapshots.sourceType, "SHIPMENT"),
        eq(deliveryDocumentSnapshots.sourceId, input.consignmentId),
        eq(deliveryDocumentSnapshots.branchId, input.branchId),
        inArray(deliveryDocumentSnapshots.documentType, [
          "DISPATCH_SLIP",
          "SHIPPING_LABEL",
        ]),
      ),
    );
  const [membership] = await tx
    .select({ leaderId: deliveryShipmentMembers.leaderConsignmentId })
    .from(deliveryShipmentMembers)
    .where(eq(deliveryShipmentMembers.consignmentId, input.consignmentId))
    .limit(1);
  if (membership && Number(membership.leaderId) !== Number(input.consignmentId))
    throw fulfillmentError(
      "اطبع الشحنة من باركود الإرسالية القائدة؛ لا تُنشأ لقطة تاريخية لعضو منفرد",
      "CONFLICT",
    );

  const [leader] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, input.consignmentId))
    .for("update")
    .limit(1);
  if (!leader) throw fulfillmentError("الإرسالية غير موجودة", "NOT_FOUND");
  if (Number(leader.branchId) !== input.branchId)
    throw fulfillmentError("الإرسالية خارج نطاق الفرع الحالي", "FORBIDDEN");

  const events = await tx
    .select()
    .from(deliveryEvents)
    .where(
      and(
        eq(deliveryEvents.consignmentId, input.consignmentId),
        or(
          ...assignmentEventTypes.map((type) =>
            eq(deliveryEvents.eventType, type),
          ),
        ),
      ),
    )
    .orderBy(desc(deliveryEvents.occurredAt), desc(deliveryEvents.id));
  const originalEvent = events.find((event) => {
    const payload = eventPayload(event.payload);
    return (
      event.actorUserId != null &&
      Number(payload?.partyId) === Number(leader.partyId) &&
      String(payload?.sourceType ?? "") === leader.sourceType &&
      Number(payload?.sourceId) === Number(leader.sourceId)
    );
  });
  if (!originalEvent || originalEvent.actorUserId == null)
    throw fulfillmentError(
      "لا تتوفر واقعة إسناد أصلية متطابقة؛ لا يمكن إنشاء نسخة تاريخية من القيم الحية",
      "CONFLICT",
    );

  const memberRows = membership
    ? await tx
        .select({
          id: deliveryConsignments.id,
          consignmentNumber: deliveryConsignments.consignmentNumber,
          invoiceId: deliveryConsignments.invoiceId,
          sourceType: deliveryConsignments.sourceType,
          sourceId: deliveryConsignments.sourceId,
        })
        .from(deliveryShipmentMembers)
        .innerJoin(
          deliveryConsignments,
          eq(deliveryConsignments.id, deliveryShipmentMembers.consignmentId),
        )
        .where(
          eq(deliveryShipmentMembers.leaderConsignmentId, input.consignmentId),
        )
    : [
        {
          id: leader.id,
          consignmentNumber: leader.consignmentNumber,
          invoiceId: leader.invoiceId,
          sourceType: leader.sourceType,
          sourceId: leader.sourceId,
        },
      ];
  const members = memberRows.length ? memberRows : [leader];
  const invoiceIds = Array.from(
    new Set(
      members.flatMap((member) =>
        member.invoiceId == null ? [] : [Number(member.invoiceId)],
      ),
    ),
  );
  const eventOccurredAt = originalEvent.occurredAt;
  const eventKey = `legacy-document:${idempotencyHash({
    eventId: Number(originalEvent.id),
    eventKey: originalEvent.eventKey,
  }).slice(0, 40)}`;
  const sameEventExisting = existing.filter((row) => {
    const payload = eventPayload(row.payload);
    const evidence = eventPayload(payload?.evidence);
    return (
      row.eventKey === eventKey ||
      Number(evidence?.eventId) === Number(originalEvent.id)
    );
  });
  const existingTypes = new Set(
    sameEventExisting.map((row) => row.documentType),
  );
  if (existingTypes.has("DISPATCH_SLIP") && existingTypes.has("SHIPPING_LABEL"))
    return sameEventExisting.map((row) => Number(row.id)).sort((a, b) => a - b);

  // A prior failure may have persisted only one document for this exact
  // assignment. Complete the pair from that immutable row itself.
  const immutablePeer = sameEventExisting[0];
  if (immutablePeer) {
    const missingTypes = (["DISPATCH_SLIP", "SHIPPING_LABEL"] as const).filter(
      (type) => !existingTypes.has(type),
    );
    const created: number[] = [];
    for (const documentType of missingTypes) {
      const peerPayload = eventPayload(immutablePeer.payload);
      const row = await createDeliveryDocumentSnapshotTx(tx, {
        documentType,
        layout:
          documentType === "DISPATCH_SLIP"
            ? "THERMAL_80_CONTENT_72"
            : "LABEL_100X150_SAFE_3",
        sourceType: "SHIPMENT",
        sourceId: input.consignmentId,
        sourceVersion: immutablePeer.sourceVersion,
        branchId: input.branchId,
        shiftId: immutablePeer.shiftId,
        eventKey: immutablePeer.eventKey,
        eventOccurredAt: immutablePeer.eventOccurredAt,
        payload: {
          ...(peerPayload ?? { immutablePayload: immutablePeer.payload }),
          documentType,
        },
        createdBy: immutablePeer.createdBy,
      });
      created.push(Number(row.snapshot.id));
    }
    return Array.from(
      new Set([...sameEventExisting.map((row) => Number(row.id)), ...created]),
    ).sort((a, b) => a - b);
  }
  const payload: ShipmentDispatchDocumentPayload = {
    schemaVersion: 1,
    operationId: `historical:${originalEvent.eventKey}`,
    eventOccurredAt: eventOccurredAt.toISOString(),
    evidence: {
      mode: "HISTORICAL_ORIGINAL_EVIDENCE",
      eventId: Number(originalEvent.id),
      eventKey,
      unavailableFields: [
        "party.nameAtDispatch",
        "recipient.atDispatch",
        "shipment.assignedUserAtDispatch",
        "invoice.numberAtDispatch",
        "invoice.totalAtDispatch",
        "money.codAmountAtDispatch",
        "money.deliveryFeeAtDispatch",
        "money.feeCollectionAtDispatch",
        "money.currentTotalAtDispatch",
        "money.paidAmountAtDispatch",
      ],
      notice:
        "نسخة تاريخية: وقت الإسناد وهوية المصدر من الحدث الأصلي؛ بيانات المستلم من سجل الإرسالية الحالي؛ المبالغ واسم الجهة وقت الإسناد غير متاحة.",
    },
    shipment: {
      consignmentId: Number(leader.id),
      consignmentNumber: leader.consignmentNumber,
      fulfillmentRequestId: leader.fulfillmentRequestId,
      branchId: Number(leader.branchId),
      partyId: Number(leader.partyId),
      assignedUserId: leader.assignedUserId,
      sourceType: leader.sourceType,
      sourceId: Number(leader.sourceId),
      members: members.map((member) => ({
        id: Number(member.id),
        consignmentNumber: member.consignmentNumber,
        invoiceId: member.invoiceId == null ? null : Number(member.invoiceId),
        sourceType: member.sourceType,
        sourceId: Number(member.sourceId),
      })),
    },
    party: {
      id: Number(leader.partyId),
      name: `جهة التوصيل #${Number(leader.partyId)} (الاسم وقت الإسناد غير متاح)`,
    },
    recipient: {
      name: leader.recipientName,
      phone: leader.recipientPhone,
      address: leader.deliveryAddress,
      governorate: leader.governorate,
    },
    money: {
      codAmount: null,
      deliveryFee: null,
      feeCollection: null,
      customerCollectionAtDispatch: "0.00",
      currentTotal: null,
      paidAmount: null,
    },
    invoiceIds,
    invoices: invoiceIds.map((id) => ({
      id,
      invoiceNumber: `#${id}`,
      total: null,
      identityEvidence: "INTERNAL_ID_ONLY",
    })),
    aftercareNotice:
      leader.sourceType === "AFTERCARE_EXECUTION"
        ? "تحصيل العميل صفر — الأجرة على المكتبة"
        : null,
  };
  const created = await createShipmentDispatchDocumentSnapshotsTx(tx, {
    consignmentId: Number(leader.id),
    branchId: Number(leader.branchId),
    eventKey,
    eventOccurredAt,
    createdBy: Number(originalEvent.actorUserId),
    payload,
    documentTypes: ["DISPATCH_SLIP", "SHIPPING_LABEL"],
  });
  return created;
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
    .orderBy(
      desc(deliveryDocumentSnapshots.createdAt),
      desc(deliveryDocumentSnapshots.id),
    );
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
