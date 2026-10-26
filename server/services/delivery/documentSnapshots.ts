import {
  and,
  asc,
  desc,
  eq,
  inArray,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryEvents,
  deliveryParties,
  deliveryRemittanceLines,
  deliveryRemittances,
  deliveryShipmentMembers,
  invoices,
} from "../../../drizzle/schema";
import {
  aftercareExecutions,
  deliveryDocumentPrints,
  deliveryDocumentSnapshots,
} from "../../../drizzle/fulfillmentSchema";
import type { WorkflowDocumentType } from "../../../shared/deliveryWorkflow";
import type { Tx } from "../../db";
import { fulfillmentError } from "../fulfillment/core";
import { idempotencyHash } from "../idempotency";
import { money, toDbMoney } from "../money";

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
  documentTypes?: Array<
    "DISPATCH_SLIP" | "SHIPPING_LABEL" | "DELIVERY_MANIFEST"
  >;
}

/** Thermal/A4 operational document: all values are frozen source facts, never a new posting. */
export interface GenericWorkflowDocumentPayload {
  schemaVersion: 1;
  title: string;
  documentNumber: string;
  eventOccurredAt: string;
  rows: Array<{ label: string; value: string }>;
  totals: Array<{ label: string; value: string }>;
  notice: string;
}

export type WorkflowDocumentBody = Omit<
  GenericWorkflowDocumentPayload,
  "schemaVersion" | "eventOccurredAt"
>;

function shipmentManifest(
  payload: ShipmentDispatchDocumentPayload,
): GenericWorkflowDocumentPayload {
  return {
    schemaVersion: 1,
    title: "محضر تسليم طرود لجهة التوصيل",
    documentNumber: payload.shipment.consignmentNumber,
    eventOccurredAt: payload.eventOccurredAt,
    rows: [
      { label: "جهة التوصيل", value: payload.party.name },
      {
        label: "المستلم",
        value: payload.recipient.name ?? "غير متاح في دليل الحدث",
      },
      ...payload.shipment.members.map((member) => ({
        label: "إرسالية",
        value: member.consignmentNumber,
      })),
    ],
    totals: [
      { label: "عدد الطرود", value: String(payload.shipment.members.length) },
      ...(payload.money.codAmount == null
        ? []
        : [
            {
              label: "مطالبة العميل عند الإسناد",
              value: payload.money.codAmount,
            },
          ]),
      ...(payload.money.deliveryFee == null
        ? []
        : [{ label: "أجرة التوصيل", value: payload.money.deliveryFee }]),
    ],
    notice:
      payload.evidence?.notice ??
      "يثبت تسليم الطرود لجهة التوصيل؛ لا يثبت قبض العميل أو توريد النقد إلى المكتبة. الاسم: __________ التوقيع: __________",
  };
}

function documentNumber(
  input: CreateDeliveryDocumentSnapshotInput,
  hash: string,
) {
  const kind = input.documentType.replaceAll("_", "-");
  // A manifest can render the same rows on two distinct assignment events.
  // Its immutable identity is the event plus payload, not the visible rows
  // alone; otherwise the number unique key silently aliases reassignments.
  const identityHash = idempotencyHash({ eventKey: input.eventKey, hash });
  return `DDS-${kind}-${input.sourceId}-${identityHash.slice(0, 12)}`.slice(
    0,
    80,
  );
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
  if (!snapshot) {
    const [numberCollision] = await tx
      .select({
        eventKey: deliveryDocumentSnapshots.eventKey,
        documentType: deliveryDocumentSnapshots.documentType,
      })
      .from(deliveryDocumentSnapshots)
      .where(
        eq(
          deliveryDocumentSnapshots.documentNumber,
          documentNumber(input, payloadHash),
        ),
      )
      .limit(1);
    throw fulfillmentError(
      numberCollision
        ? `رقم لقطة المستند مرتبط بحدث آخر (${numberCollision.documentType} / ${numberCollision.eventKey})`
        : "تعذر تثبيت لقطة المستند",
      "CONFLICT",
    );
  }
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

  let payload = input.payload;
  if (
    payload.evidence.mode === "COMMITTED_DISPATCH_EVENT" &&
    payload.evidence.eventId == null
  ) {
    const events = await tx
      .select()
      .from(deliveryEvents)
      .where(
        and(
          eq(deliveryEvents.consignmentId, input.consignmentId),
          inArray(deliveryEvents.eventType, [...assignmentEventTypes]),
        ),
      )
      .orderBy(desc(deliveryEvents.occurredAt), desc(deliveryEvents.id));
    const assignment = events.find(isAssignmentEvent);
    const identity = assignmentIdentity(assignment?.payload);
    if (
      !assignment ||
      assignment.actorUserId !== input.createdBy ||
      Number(identity?.partyId) !== payload.shipment.partyId ||
      identity?.sourceType !== payload.shipment.sourceType ||
      Number(identity?.sourceId) !== payload.shipment.sourceId
    )
      throw fulfillmentError(
        "حدث الإسناد لا يثبت الجهة والمصدر الحاليين",
        "CONFLICT",
      );
    payload = {
      ...payload,
      evidence: { ...payload.evidence, eventId: assignment.id },
    };
  }
  const sourceVersion = input.sourceVersion ?? idempotencyHash(payload);
  const snapshotIds: number[] = [];
  const requestedTypes = new Set(
    input.documentTypes ?? ["DISPATCH_SLIP", "SHIPPING_LABEL"],
  );
  requestedTypes.add("DELIVERY_MANIFEST");
  for (const document of [
    {
      documentType: "DISPATCH_SLIP" as const,
      layout: "THERMAL_80_CONTENT_72" as const,
    },
    {
      documentType: "SHIPPING_LABEL" as const,
      layout: "LABEL_100X150_SAFE_3" as const,
    },
    {
      documentType: "DELIVERY_MANIFEST" as const,
      layout: "THERMAL_80_CONTENT_72" as const,
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
      payload:
        document.documentType === "DELIVERY_MANIFEST"
          ? shipmentManifest(payload)
          : { ...payload, documentType: document.documentType },
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
  "AFTERCARE_DISPATCHED",
] as const;

function eventPayload(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assignmentIdentity(value: unknown): Record<string, unknown> | null {
  const payload = eventPayload(value);
  // Native charge-only dispatches recorded the request FK and carrier directly.
  // Normalize that immutable identity without reading today's request values.
  const requestId = Number(payload?.fulfillmentRequestId);
  return payload?.sourceType == null &&
    payload?.sourceId == null &&
    Number.isSafeInteger(requestId) &&
    requestId > 0
    ? { ...payload, sourceType: "FULFILLMENT_REQUEST", sourceId: requestId }
    : payload;
}

function isAssignmentEvent(event: typeof deliveryEvents.$inferSelect) {
  const payload = eventPayload(event.payload);
  return (
    event.eventType !== "OUT_FOR_DELIVERY" ||
    ["partyId", "sourceType", "sourceId"].some((key) =>
      Object.hasOwn(payload ?? {}, key),
    )
  );
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
          "DELIVERY_MANIFEST",
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
  // OUT_FOR_DELIVERY also records a later departure/retry, without assignment
  // identity. Do not let that hide the last actual assignment, or skip a newer
  // assignment merely because its identity conflicts with today's shipment.
  const originalEvent = events.find(isAssignmentEvent);
  let originalPayload = assignmentIdentity(originalEvent?.payload);
  // Native aftercare events originally saved the execution identity only.
  // Its persisted dispatch association must independently prove this carrier,
  // consignment and actor; never infer them from the current directory alone.
  if (
    originalEvent?.eventType === "AFTERCARE_DISPATCHED" &&
    originalPayload?.partyId == null &&
    originalPayload?.sourceType == null &&
    originalPayload?.sourceId == null &&
    Number.isSafeInteger(Number(originalPayload?.caseId)) &&
    Number(originalPayload?.caseId) > 0 &&
    leader.sourceType === "AFTERCARE_EXECUTION" &&
    Number(originalPayload?.aftercareExecutionId) === leader.sourceId
  ) {
    const [execution] = await tx
      .select({
        id: aftercareExecutions.id,
        partyId: aftercareExecutions.partyId,
      })
      .from(aftercareExecutions)
      .where(
        and(
          eq(aftercareExecutions.id, leader.sourceId),
          eq(aftercareExecutions.caseId, Number(originalPayload?.caseId)),
          eq(aftercareExecutions.consignmentId, leader.id),
          eq(aftercareExecutions.branchId, input.branchId),
          eq(aftercareExecutions.partyId, leader.partyId),
          eq(aftercareExecutions.dispatchedBy, originalEvent.actorUserId ?? 0),
        ),
      )
      .for("share")
      .limit(1);
    if (execution)
      originalPayload = {
        ...originalPayload,
        partyId: execution.partyId,
        sourceType: "AFTERCARE_EXECUTION",
        sourceId: execution.id,
      };
  }
  if (
    !originalEvent ||
    originalEvent.actorUserId == null ||
    Number(originalPayload?.partyId) !== Number(leader.partyId) ||
    String(originalPayload?.sourceType ?? "") !== leader.sourceType ||
    Number(originalPayload?.sourceId) !== Number(leader.sourceId)
  )
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
  const peerEventKeys = new Set(
    existing
      .filter((row) => {
        const payload = eventPayload(row.payload);
        const evidence = eventPayload(payload?.evidence);
        if (evidence?.eventId != null)
          return Number(evidence.eventId) === Number(originalEvent.id);
        if (row.eventKey === originalEvent.eventKey) return true;
        // Older committed group/workflow snapshots used their operation key.
        // Reuse them only when frozen source/actor identity identifies one
        // assignment, or its event second disambiguates repeated assignments.
        const shipment = eventPayload(payload?.shipment);
        if (
          evidence?.mode !== "COMMITTED_DISPATCH_EVENT" ||
          evidence.eventKey !== row.eventKey ||
          Number(shipment?.consignmentId) !== leader.id ||
          Number(shipment?.branchId) !== input.branchId
        )
          return false;
        const matches = events.filter((event) => {
          const identity = assignmentIdentity(event.payload);
          return (
            isAssignmentEvent(event) &&
            event.actorUserId === row.createdBy &&
            Number(identity?.partyId) === Number(shipment?.partyId) &&
            identity?.sourceType === shipment?.sourceType &&
            Number(identity?.sourceId) === Number(shipment?.sourceId)
          );
        });
        if (matches.length === 1) return matches[0].id === originalEvent.id;
        const simultaneous = matches.filter(
          (event) =>
            timestampSecond(event.occurredAt) ===
            timestampSecond(row.eventOccurredAt),
        );
        if (
          simultaneous.length > 1 &&
          simultaneous.some((event) => event.id === originalEvent.id)
        )
          throw fulfillmentError(
            "تعذر ربط لقطة الإسناد المحفوظة بواقعة واحدة؛ راجع دليل الإسناد الأصلي",
            "CONFLICT",
          );
        return (
          simultaneous.length === 1 && simultaneous[0].id === originalEvent.id
        );
      })
      .map((row) => row.eventKey),
  );
  let sameEventExisting = existing.filter((row) => {
    const payload = eventPayload(row.payload);
    const evidence = eventPayload(payload?.evidence);
    return (
      row.eventKey === eventKey ||
      peerEventKeys.has(row.eventKey) ||
      Number(evidence?.eventId) === Number(originalEvent.id)
    );
  });
  // Keep audit history, but repair/print one consistent committed pack ahead of
  // degraded historical copies which an older preparation may have appended.
  const committedPeer = sameEventExisting
    .filter(
      (row) =>
        row.documentType !== "DELIVERY_MANIFEST" &&
        eventPayload(eventPayload(row.payload)?.evidence)?.mode ===
          "COMMITTED_DISPATCH_EVENT",
    )
    .sort((a, b) => b.id - a.id)[0];
  if (committedPeer)
    sameEventExisting = sameEventExisting.filter(
      (row) => row.eventKey === committedPeer.eventKey,
    );
  const existingTypes = new Set(
    sameEventExisting.map((row) => row.documentType),
  );
  if (
    existingTypes.has("DISPATCH_SLIP") &&
    existingTypes.has("SHIPPING_LABEL") &&
    existingTypes.has("DELIVERY_MANIFEST")
  )
    return sameEventExisting.map((row) => Number(row.id)).sort((a, b) => a - b);

  // A prior failure may have persisted only one document for this exact
  // assignment. Complete the pair from that immutable row itself.
  const immutablePeer = sameEventExisting.find(
    (row) => row.documentType !== "DELIVERY_MANIFEST",
  );
  if (immutablePeer) {
    const missingTypes = (
      ["DISPATCH_SLIP", "SHIPPING_LABEL", "DELIVERY_MANIFEST"] as const
    ).filter((type) => !existingTypes.has(type));
    const created: number[] = [];
    for (const documentType of missingTypes) {
      const peerPayload = eventPayload(immutablePeer.payload);
      const row = await createDeliveryDocumentSnapshotTx(tx, {
        documentType,
        layout:
          documentType !== "SHIPPING_LABEL"
            ? "THERMAL_80_CONTENT_72"
            : "LABEL_100X150_SAFE_3",
        sourceType: "SHIPMENT",
        sourceId: input.consignmentId,
        sourceVersion: immutablePeer.sourceVersion,
        branchId: input.branchId,
        shiftId: immutablePeer.shiftId,
        eventKey: immutablePeer.eventKey,
        eventOccurredAt: immutablePeer.eventOccurredAt,
        payload:
          documentType === "DELIVERY_MANIFEST"
            ? eventPayload(peerPayload?.shipment) &&
              eventPayload(peerPayload?.party) &&
              eventPayload(peerPayload?.recipient) &&
              eventPayload(peerPayload?.money) &&
              Array.isArray(eventPayload(peerPayload?.shipment)?.members)
              ? shipmentManifest(
                  immutablePeer.payload as ShipmentDispatchDocumentPayload,
                )
              : {
                  schemaVersion: 1,
                  title: "محضر تسليم طرود لجهة التوصيل",
                  documentNumber: leader.consignmentNumber,
                  eventOccurredAt: immutablePeer.eventOccurredAt.toISOString(),
                  rows: [
                    {
                      label: "مصدر الدليل",
                      value: immutablePeer.documentNumber,
                    },
                  ],
                  totals: [],
                  notice:
                    "نسخة من دليل الإسناد المحفوظ؛ بيانات الحدث غير المتاحة لا تُستبدل بقيم اليوم.",
                }
            : {
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
      name:
        typeof eventPayload(originalEvent.payload)?.partyName === "string"
          ? String(eventPayload(originalEvent.payload)?.partyName)
          : `جهة التوصيل #${Number(leader.partyId)} (الاسم وقت الإسناد غير متاح)`,
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

/** Called only in the transaction which has just committed this assignment event. */
export async function captureShipmentAssignmentDocumentsTx(
  tx: Tx,
  input: { consignmentId: number; branchId: number; eventKey: string },
) {
  const [leader] = await tx
    .select()
    .from(deliveryConsignments)
    .where(
      and(
        eq(deliveryConsignments.id, input.consignmentId),
        eq(deliveryConsignments.branchId, input.branchId),
      ),
    )
    .for("update")
    .limit(1);
  if (!leader)
    throw fulfillmentError("الإرسالية خارج نطاق الفرع الحالي", "FORBIDDEN");
  const [event] = await tx
    .select()
    .from(deliveryEvents)
    .where(
      and(
        eq(deliveryEvents.consignmentId, leader.id),
        eq(deliveryEvents.eventKey, input.eventKey),
        inArray(deliveryEvents.eventType, [...assignmentEventTypes]),
      ),
    )
    .limit(1);
  const recorded = assignmentIdentity(event?.payload);
  if (
    !event?.actorUserId ||
    Number(recorded?.partyId) !== leader.partyId ||
    recorded?.sourceType !== leader.sourceType ||
    Number(recorded?.sourceId) !== leader.sourceId
  )
    throw fulfillmentError(
      "حدث الإسناد لا يثبت الجهة والمصدر الحاليين",
      "CONFLICT",
    );
  const [party] = await tx
    .select({ name: deliveryParties.name })
    .from(deliveryParties)
    .where(eq(deliveryParties.id, leader.partyId))
    .for("share")
    .limit(1);
  const grouped = await tx
    .select({ row: deliveryConsignments })
    .from(deliveryShipmentMembers)
    .innerJoin(
      deliveryConsignments,
      eq(deliveryConsignments.id, deliveryShipmentMembers.consignmentId),
    )
    .where(
      and(
        eq(deliveryShipmentMembers.leaderConsignmentId, leader.id),
        notInArray(deliveryConsignments.status, [
          "CANCELLED",
          "RETURNED",
          "WRITTEN_OFF",
        ]),
        notInArray(deliveryConsignments.parcelStatus, [
          "CANCELLED",
          "RETURNED",
        ]),
      ),
    )
    .orderBy(asc(deliveryConsignments.id));
  const members = grouped.length ? grouped.map(({ row }) => row) : [leader];
  const invoiceIds = Array.from(
    new Set(
      members.flatMap((row) => (row.invoiceId == null ? [] : [row.invoiceId])),
    ),
  );
  const originals = invoiceIds.length
    ? await tx
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          returnedTotal: invoices.returnedTotal,
          status: invoices.status,
        })
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds))
        .orderBy(asc(invoices.id))
        .for("share")
    : [];
  const payload: ShipmentDispatchDocumentPayload = {
    schemaVersion: 1,
    operationId: event.eventKey,
    eventOccurredAt: event.occurredAt.toISOString(),
    evidence: {
      mode: "COMMITTED_DISPATCH_EVENT",
      eventId: event.id,
      eventKey: event.eventKey,
      unavailableFields: [],
    },
    shipment: {
      consignmentId: leader.id,
      consignmentNumber: leader.consignmentNumber,
      fulfillmentRequestId: leader.fulfillmentRequestId,
      branchId: leader.branchId,
      partyId: leader.partyId,
      assignedUserId: leader.assignedUserId,
      sourceType: leader.sourceType,
      sourceId: leader.sourceId,
      members: members.map((row) => ({
        id: row.id,
        consignmentNumber: row.consignmentNumber,
        invoiceId: row.invoiceId,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
      })),
    },
    party: {
      id: leader.partyId,
      name: party?.name ?? `جهة التوصيل #${leader.partyId}`,
    },
    recipient: {
      name: leader.recipientName,
      phone: leader.recipientPhone,
      address: leader.deliveryAddress,
      governorate: leader.governorate,
    },
    money: {
      codAmount: toDbMoney(
        members.reduce((sum, row) => sum.plus(row.codAmount), money(0)),
      ),
      deliveryFee: leader.deliveryFee,
      feeCollection: leader.feeCollection,
      customerCollectionAtDispatch: "0.00",
      currentTotal: toDbMoney(
        originals.reduce(
          (sum, row) =>
            sum.plus(money(row.total).minus(row.returnedTotal ?? "0")),
          money(0),
        ),
      ),
      paidAmount: toDbMoney(
        originals.reduce((sum, row) => sum.plus(row.paidAmount), money(0)),
      ),
    },
    invoiceIds,
    invoices: originals,
    aftercareNotice:
      leader.sourceType === "AFTERCARE_EXECUTION"
        ? "تحصيل العميل صفر — الأجرة على المكتبة"
        : null,
  };
  return createShipmentDispatchDocumentSnapshotsTx(tx, {
    consignmentId: leader.id,
    branchId: leader.branchId,
    eventKey: event.eventKey,
    eventOccurredAt: event.occurredAt,
    createdBy: event.actorUserId,
    payload,
  });
}

/** Rebuild an operational page only from the immutable event's explicitly saved body. */
export async function createRecordedShipmentDocumentTx(
  tx: Tx,
  input: {
    consignmentId: number;
    branchId: number;
    eventKey: string;
    documentType: "PHYSICAL_RETURN_RECEIPT" | "DELIVERY_MANIFEST";
  },
) {
  const [event] = await tx
    .select()
    .from(deliveryEvents)
    .where(eq(deliveryEvents.eventKey, input.eventKey))
    .limit(1);
  const [leader] = await tx
    .select({ branchId: deliveryConsignments.branchId })
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, input.consignmentId))
    .limit(1);
  if (!leader || leader.branchId !== input.branchId)
    throw fulfillmentError(
      "المستند خارج نطاق الشحنة والفرع الحالي",
      "FORBIDDEN",
    );
  if (event && event.consignmentId !== input.consignmentId) {
    const [member] = await tx
      .select({ id: deliveryShipmentMembers.consignmentId })
      .from(deliveryShipmentMembers)
      .where(
        and(
          eq(deliveryShipmentMembers.leaderConsignmentId, input.consignmentId),
          eq(deliveryShipmentMembers.consignmentId, event.consignmentId),
        ),
      )
      .limit(1);
    if (!member)
      throw fulfillmentError(
        "حدث المستند لا ينتمي إلى أعضاء هذه الشحنة",
        "CONFLICT",
      );
  }
  const recorded = eventPayload(event?.payload);
  const body = eventPayload(recorded?.document);
  if (
    !event?.actorUserId ||
    Number(recorded?.branchId) !== input.branchId ||
    Number(recorded?.leaderConsignmentId) !== input.consignmentId ||
    !body ||
    recorded?.documentType !== input.documentType ||
    typeof body.title !== "string" ||
    typeof body.documentNumber !== "string" ||
    typeof body.notice !== "string" ||
    !Array.isArray(body.rows) ||
    !Array.isArray(body.totals) ||
    [...body.rows, ...body.totals].some(
      (row) =>
        !eventPayload(row) ||
        typeof row.label !== "string" ||
        typeof row.value !== "string",
    )
  )
    throw fulfillmentError(
      "لا يوجد دليل حدث أصلي صالح لمستند المحطة",
      "CONFLICT",
    );
  const payload: GenericWorkflowDocumentPayload = {
    schemaVersion: 1,
    title: body.title,
    documentNumber: body.documentNumber,
    eventOccurredAt: event.occurredAt.toISOString(),
    rows: body.rows as GenericWorkflowDocumentPayload["rows"],
    totals: body.totals as GenericWorkflowDocumentPayload["totals"],
    notice: body.notice,
  };
  const created = await createDeliveryDocumentSnapshotTx(tx, {
    documentType: input.documentType,
    layout: "THERMAL_80_CONTENT_72",
    sourceType: "SHIPMENT",
    sourceId: input.consignmentId,
    sourceVersion: idempotencyHash({ eventId: event.id, payload }),
    branchId: input.branchId,
    eventKey: event.eventKey,
    eventOccurredAt: event.occurredAt,
    payload,
    createdBy: event.actorUserId,
  });
  return Number(created.snapshot.id);
}

/** Prepare metadata-only pages for a real shipment and its persisted financial documents. */
export async function prepareShipmentWorkflowDocumentsTx(
  tx: Tx,
  input: { consignmentId: number; branchId: number },
) {
  const assignmentSnapshotIds = new Set(
    await bootstrapHistoricalShipmentDocumentSnapshotsTx(tx, input),
  );
  const grouped = await tx
    .select({ id: deliveryShipmentMembers.consignmentId })
    .from(deliveryShipmentMembers)
    .where(
      eq(deliveryShipmentMembers.leaderConsignmentId, input.consignmentId),
    );
  const memberIds = grouped.length
    ? grouped.map((row) => row.id)
    : [input.consignmentId];
  const events = await tx
    .select()
    .from(deliveryEvents)
    .where(inArray(deliveryEvents.consignmentId, memberIds))
    .orderBy(asc(deliveryEvents.id));
  for (const event of events) {
    const recorded = eventPayload(event.payload);
    if (
      Number(recorded?.leaderConsignmentId) !== input.consignmentId ||
      Number(recorded?.branchId) !== input.branchId ||
      !recorded?.document
    )
      continue;
    if (
      recorded.documentType === "PHYSICAL_RETURN_RECEIPT" ||
      recorded.documentType === "DELIVERY_MANIFEST"
    )
      await createRecordedShipmentDocumentTx(tx, {
        ...input,
        eventKey: event.eventKey,
        documentType: recorded.documentType,
      });
  }
  const relevant = await tx
    .select()
    .from(deliveryRemittanceLines)
    .where(inArray(deliveryRemittanceLines.consignmentId, memberIds))
    .orderBy(asc(deliveryRemittanceLines.id));
  const legacyBindings = await tx
    .select({ remittanceId: deliveryConsignments.remittanceId })
    .from(deliveryConsignments)
    .where(inArray(deliveryConsignments.id, memberIds));
  const remittanceIds = Array.from(
    new Set([
      ...relevant.map((row) => row.remittanceId),
      ...legacyBindings.flatMap((row) =>
        row.remittanceId == null ? [] : [row.remittanceId],
      ),
    ]),
  );
  const remittances = remittanceIds.length
    ? await tx
        .select()
        .from(deliveryRemittances)
        .where(
          and(
            inArray(deliveryRemittances.id, remittanceIds),
            eq(deliveryRemittances.branchId, input.branchId),
          ),
        )
        .orderBy(asc(deliveryRemittances.id))
    : [];
  for (const remittance of remittances) {
    if (remittance.receivedBy == null) continue; // No invented historical issuer.
    const allocation = relevant.filter(
      (row) => row.remittanceId === remittance.id,
    );
    for (const documentType of [
      "REMITTANCE_RECEIPT",
      "PARTY_SETTLEMENT",
    ] as const) {
      const payload: GenericWorkflowDocumentPayload = {
        schemaVersion: 1,
        title:
          documentType === "REMITTANCE_RECEIPT"
            ? "إيصال توريد جهة التوصيل"
            : "كشف تسوية جهة التوصيل",
        documentNumber: remittance.remittanceNumber,
        eventOccurredAt: remittance.receivedAt.toISOString(),
        rows: [
          { label: "معرف جهة التوصيل", value: String(remittance.partyId) },
          {
            label: "الوردية المستلمة",
            value:
              remittance.shiftId == null
                ? "غير مسجلة في سند التوريد"
                : String(remittance.shiftId),
          },
          ...allocation.map((line) => ({
            label: `حصة الإرسالية #${line.consignmentId}`,
            value: `مطبق ${line.grossApplied}؛ نقد ${line.cashReceived}؛ حسم أجور ${line.feeOffset}`,
          })),
        ],
        totals: [
          { label: "إجمالي تحصيلات الدفعة", value: remittance.collectedTotal },
          { label: "الأجور", value: remittance.feesTotal },
          { label: "الاستقطاعات", value: remittance.deductionsTotal },
          { label: "صافي التوريد", value: remittance.netRemitted },
          { label: "العجز المتبقي", value: remittance.shortfallTotal },
        ],
        notice:
          "نسخة من سند التوريد الفعلي بأرقامه ووقت استلامه. إجماليات الدفعة تخص جميع إرساليات السند؛ الصفوف تبين حصة هذه الشحنة فقط. لا يمثل تحصيلاً جديداً من العميل ولا يرحّل نقداً جديداً.",
      };
      await createDeliveryDocumentSnapshotTx(tx, {
        documentType,
        layout: "THERMAL_80_CONTENT_72",
        sourceType: "SHIPMENT",
        sourceId: input.consignmentId,
        sourceVersion: idempotencyHash(payload),
        branchId: input.branchId,
        shiftId: remittance.shiftId,
        eventKey: `SHIPMENT:${input.consignmentId}:REMITTANCE:${remittance.id}`,
        eventOccurredAt: remittance.receivedAt,
        payload,
        createdBy: remittance.receivedBy,
      });
    }
  }
  const documents = await listDeliveryDocumentSnapshotsTx(tx, {
    sourceType: "SHIPMENT",
    sourceId: input.consignmentId,
    branchId: input.branchId,
  });
  return documents.sort(
    (a, b) =>
      Number(assignmentSnapshotIds.has(b.id)) -
      Number(assignmentSnapshotIds.has(a.id)),
  );
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
  const [snapshot] = await tx
    .select({
      id: deliveryDocumentSnapshots.id,
      branchId: deliveryDocumentSnapshots.branchId,
      documentType: deliveryDocumentSnapshots.documentType,
    })
    .from(deliveryDocumentSnapshots)
    .where(eq(deliveryDocumentSnapshots.id, input.snapshotId))
    .for("update")
    .limit(1);
  if (!snapshot) throw fulfillmentError("لقطة المستند غير موجودة", "NOT_FOUND");
  if (snapshot.branchId !== input.branchId)
    throw fulfillmentError("المستند خارج نطاق الفرع الحالي", "FORBIDDEN");
  if (snapshot.documentType === "INVOICE")
    throw fulfillmentError(
      "طباعة الفاتورة تتطلب مسار الفواتير وصلاحيته المستقلة",
      "FORBIDDEN",
    );
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
  if (input.copyType === "ORIGINAL") {
    const existingOriginal = (
      await tx
        .select({
          id: deliveryDocumentPrints.id,
          status: deliveryDocumentPrints.status,
        })
        .from(deliveryDocumentPrints)
        .where(
          and(
            eq(deliveryDocumentPrints.snapshotId, input.snapshotId),
            eq(deliveryDocumentPrints.copyType, "ORIGINAL"),
            inArray(deliveryDocumentPrints.status, ["REQUESTED", "SENT"]),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    if (existingOriginal)
      throw fulfillmentError(
        existingOriginal.status === "SENT"
          ? "طُبعت النسخة الأصلية؛ استخدم إعادة الطباعة مع تسجيل السبب"
          : "طلب طباعة النسخة الأصلية ما زال قيد التنفيذ؛ أكمل نتيجته قبل إنشاء محاولة أخرى",
        "CONFLICT",
      );
  }
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
      .select({
        branchId: deliveryDocumentSnapshots.branchId,
        documentType: deliveryDocumentSnapshots.documentType,
      })
      .from(deliveryDocumentSnapshots)
      .where(eq(deliveryDocumentSnapshots.id, row.snapshotId))
      .limit(1)
  )[0];
  if (!snapshot || snapshot.branchId !== input.branchId)
    throw fulfillmentError("طلب الطباعة خارج نطاق الفرع الحالي", "FORBIDDEN");
  if (snapshot.documentType === "INVOICE")
    throw fulfillmentError(
      "طباعة الفاتورة تتطلب مسار الفواتير وصلاحيته المستقلة",
      "FORBIDDEN",
    );
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
        ne(deliveryDocumentSnapshots.documentType, "INVOICE"),
      ),
    )
    .orderBy(
      desc(deliveryDocumentSnapshots.eventOccurredAt),
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
