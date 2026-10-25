import { and, asc, eq, inArray } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryEvents,
  deliveryShipmentMembers,
  inventoryMovements,
  invoiceItemBundleComponents,
  invoiceItems,
  invoices,
  productVariants,
  products,
  workOrders,
} from "../../../drizzle/schema";
import {
  aftercareExecutionLines,
  deliveryCustodyEvents,
  deliveryCustodyItems,
  fulfillmentRequestItems,
  type DeliveryCustodyItem,
  DELIVERY_CUSTODY_STATES,
} from "../../../drizzle/fulfillmentSchema";
import { componentRightsAdjustments } from "../../../drizzle/fulfillmentRightsSchema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { fulfillmentError } from "../fulfillment/core";
import { money, toDbMoney } from "../money";

export type DeliveryCustodyState = (typeof DELIVERY_CUSTODY_STATES)[number];

interface InitializeCustodyInput {
  consignmentId: number;
  actorUserId: number | null;
  operationId: string;
  leaderConsignmentId?: number;
}

interface CustodyDraft {
  sourceLineKey: string;
  itemKind:
    | "STOCKED_ITEM"
    | "BUNDLE_COMPONENT"
    | "WORK_ORDER_OUTPUT"
    | "AFTERCARE_OUTPUT";
  invoiceItemId?: number | null;
  bundleComponentId?: number | null;
  variantId?: number | null;
  originalMovementId?: number | null;
  baseQuantity: number;
  originalIssueUnitCost?: string | null;
  originalIssueValue?: string | null;
  reviewStatus: "VERIFIED" | "REVIEW_REQUIRED";
  reviewReason?: string | null;
}

function assertPositiveBaseQuantity(value: number, sourceLineKey: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw fulfillmentError(
      `كمية عهدة غير صالحة في السطر ${sourceLineKey}؛ راجع المستند الأصلي`,
      "CONFLICT",
    );
}

function initialState(
  row: typeof deliveryConsignments.$inferSelect,
): DeliveryCustodyState {
  if (row.parcelStatus === "DELIVERED" || row.courierDeliveredAt != null)
    return "CUSTOMER_DELIVERED";
  if (
    ["ASSIGNED", "ACCEPTED", "FAILED"].includes(row.parcelStatus) &&
    row.pickedUpAt == null &&
    row.outForDeliveryAt == null
  )
    return "PREPARED_HELD";
  return "CARRIER_CUSTODY";
}

async function movementIdsByVariantTx(
  tx: Tx,
  invoiceId: number,
  variantIds: number[],
) {
  const map = new Map<number, number[]>();
  if (!variantIds.length) return map;
  const rows = await tx
    .select({
      id: inventoryMovements.id,
      variantId: inventoryMovements.variantId,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.referenceType, "INVOICE"),
        eq(inventoryMovements.referenceId, invoiceId),
        eq(inventoryMovements.movementType, "OUT"),
        inArray(inventoryMovements.variantId, Array.from(new Set(variantIds))),
      ),
    );
  for (const row of rows) {
    const id = Number(row.variantId);
    map.set(id, [...(map.get(id) ?? []), Number(row.id)]);
  }
  return map;
}

async function invoiceDraftsTx(
  tx: Tx,
  invoiceId: number,
  keyPrefix = "",
): Promise<CustodyDraft[]> {
  const items = await tx
    .select({
      id: invoiceItems.id,
      variantId: invoiceItems.variantId,
      baseQuantity: invoiceItems.baseQuantity,
      unitCost: invoiceItems.unitCost,
      lineCost: invoiceItems.lineCost,
      isService: products.isService,
      isBundle: products.isBundle,
      productType: products.productType,
    })
    .from(invoiceItems)
    .innerJoin(productVariants, eq(productVariants.id, invoiceItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(invoiceItems.invoiceId, invoiceId));
  const itemIds = items.map((item) => Number(item.id));
  const components = itemIds.length
    ? await tx
        .select()
        .from(invoiceItemBundleComponents)
        .where(inArray(invoiceItemBundleComponents.invoiceItemId, itemIds))
    : [];
  const movementMap = await movementIdsByVariantTx(tx, invoiceId, [
    ...items.map((item) => Number(item.variantId)),
    ...components.map((component) => Number(component.componentVariantId)),
  ]);
  const drafts: CustodyDraft[] = [];
  for (const item of items) {
    if (item.isService || item.productType === "DIGITAL_CARD") continue;
    if (item.isBundle) {
      for (const component of components.filter(
        (row) => Number(row.invoiceItemId) === Number(item.id),
      )) {
        const baseQuantity =
          Number(component.componentBaseQuantity) * Number(item.baseQuantity);
        assertPositiveBaseQuantity(
          baseQuantity,
          `${keyPrefix}BC:${component.id}`,
        );
        const movementIds =
          movementMap.get(Number(component.componentVariantId)) ?? [];
        const valued =
          component.issueUnitCost != null && component.issueLineCost != null;
        const verified = valued && movementIds.length === 1;
        drafts.push({
          sourceLineKey: `${keyPrefix}BC:${component.id}`,
          itemKind: "BUNDLE_COMPONENT",
          invoiceItemId: Number(item.id),
          bundleComponentId: Number(component.id),
          variantId: Number(component.componentVariantId),
          originalMovementId: movementIds.length === 1 ? movementIds[0]! : null,
          baseQuantity,
          originalIssueUnitCost: component.issueUnitCost,
          originalIssueValue: component.issueLineCost,
          reviewStatus: verified ? "VERIFIED" : "REVIEW_REQUIRED",
          reviewReason: verified
            ? null
            : !valued
              ? "لقطة تكلفة مكوّن البكج التاريخية مفقودة؛ يمنع التخمين بسعر اليوم"
              : "تعذر ربط حركة صرف مكوّن البكج الأصلية الوحيدة؛ يلزم تدقيق",
        });
      }
      continue;
    }
    const baseQuantity = Number(item.baseQuantity);
    assertPositiveBaseQuantity(baseQuantity, `${keyPrefix}II:${item.id}`);
    const movementIds = movementMap.get(Number(item.variantId)) ?? [];
    const verified = movementIds.length === 1;
    drafts.push({
      sourceLineKey: `${keyPrefix}II:${item.id}`,
      itemKind: "STOCKED_ITEM",
      invoiceItemId: Number(item.id),
      variantId: Number(item.variantId),
      originalMovementId: verified ? movementIds[0]! : null,
      baseQuantity,
      originalIssueUnitCost: item.unitCost,
      originalIssueValue: item.lineCost,
      reviewStatus: verified ? "VERIFIED" : "REVIEW_REQUIRED",
      reviewReason: verified
        ? null
        : "تعذر ربط حركة الصرف الأصلية الوحيدة؛ يمنع أي إرجاع مخزني آلي",
    });
  }
  return drafts;
}

async function workOrderDraftTx(
  tx: Tx,
  workOrderId: number,
  keyPrefix = "",
): Promise<CustodyDraft> {
  const [row] = await tx
    .select({
      id: workOrders.id,
      quantity: workOrders.quantity,
      invoiceId: workOrders.invoiceId,
      costTotal: invoices.costTotal,
    })
    .from(workOrders)
    .leftJoin(invoices, eq(invoices.id, workOrders.invoiceId))
    .where(eq(workOrders.id, workOrderId))
    .limit(1);
  if (!row)
    throw fulfillmentError(
      "أمر الشغل المرتبط بإرسالية العهدة غير موجود",
      "CONFLICT",
    );
  const baseQuantity = Number(row.quantity);
  assertPositiveBaseQuantity(baseQuantity, `${keyPrefix}WO:${row.id}:OUTPUT`);
  const lineCost = money(row.costTotal ?? "0");
  return {
    sourceLineKey: `${keyPrefix}WO:${row.id}:OUTPUT`,
    itemKind: "WORK_ORDER_OUTPUT",
    baseQuantity,
    originalIssueUnitCost: toDbMoney(lineCost.div(baseQuantity)),
    originalIssueValue: toDbMoney(lineCost),
    reviewStatus: "VERIFIED",
  };
}

async function sourceDraftsTx(
  tx: Tx,
  consignment: typeof deliveryConsignments.$inferSelect,
): Promise<CustodyDraft[]> {
  if (
    consignment.sourceType === "WORK_ORDER" &&
    consignment.workOrderId != null
  )
    return [await workOrderDraftTx(tx, Number(consignment.workOrderId))];
  if (
    consignment.sourceType === "AFTERCARE_EXECUTION" &&
    consignment.aftercareExecutionId != null
  ) {
    const lines = await tx
      .select()
      .from(aftercareExecutionLines)
      .where(
        and(
          eq(
            aftercareExecutionLines.executionId,
            Number(consignment.aftercareExecutionId),
          ),
          eq(aftercareExecutionLines.kind, "OUTPUT"),
        ),
      );
    return lines.map((line) => {
      const baseQuantity = Number(line.baseQuantity);
      assertPositiveBaseQuantity(baseQuantity, `AE:${line.id}`);
      const requiresMovement =
        line.variantId != null && money(line.lineCost).gt(0);
      const verified = !requiresMovement || line.movementId != null;
      return {
        sourceLineKey: `AE:${line.id}`,
        itemKind: "AFTERCARE_OUTPUT" as const,
        variantId: line.variantId == null ? null : Number(line.variantId),
        originalMovementId:
          line.movementId == null ? null : Number(line.movementId),
        baseQuantity,
        originalIssueUnitCost: line.unitCost,
        originalIssueValue: line.lineCost,
        reviewStatus: verified ? "VERIFIED" : "REVIEW_REQUIRED",
        reviewReason: verified
          ? null
          : "دفعة معالجة مادية بلا حركة صرف أصلية؛ يلزم تدقيق قبل الإرجاع",
      };
    });
  }
  if (
    consignment.sourceType === "FULFILLMENT_REQUEST" &&
    consignment.fulfillmentRequestId != null
  ) {
    const members = await tx
      .select()
      .from(fulfillmentRequestItems)
      .where(
        and(
          eq(
            fulfillmentRequestItems.requestId,
            Number(consignment.fulfillmentRequestId),
          ),
          eq(fulfillmentRequestItems.isActive, true),
        ),
      );
    const drafts: CustodyDraft[] = [];
    for (const member of members) {
      const prefix = `FRI:${member.id}:`;
      const invoiceId = member.invoiceId ?? member.materializedInvoiceId;
      if (invoiceId != null)
        drafts.push(...(await invoiceDraftsTx(tx, Number(invoiceId), prefix)));
      else if (member.workOrderId != null)
        drafts.push(
          await workOrderDraftTx(tx, Number(member.workOrderId), prefix),
        );
    }
    return drafts;
  }
  if (consignment.invoiceId != null)
    return invoiceDraftsTx(tx, Number(consignment.invoiceId));
  return [];
}

/**
 * Materializes physical custody only.  It deliberately writes no stock movement,
 * receipt, customer balance or accounting entry.
 */
export async function initializeConsignmentCustodyTx(
  tx: Tx,
  input: InitializeCustodyInput,
) {
  const [consignment] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, input.consignmentId))
    .for("update")
    .limit(1);
  if (!consignment)
    throw fulfillmentError("الإرسالية غير موجودة لإنشاء عهدتها", "NOT_FOUND");
  const [membership] = await tx
    .select({
      leaderConsignmentId: deliveryShipmentMembers.leaderConsignmentId,
    })
    .from(deliveryShipmentMembers)
    .where(eq(deliveryShipmentMembers.consignmentId, consignment.id))
    .limit(1);
  const leaderConsignmentId =
    input.leaderConsignmentId ??
    (membership?.leaderConsignmentId == null
      ? Number(consignment.id)
      : Number(membership.leaderConsignmentId));
  const existing = await tx
    .select()
    .from(deliveryCustodyItems)
    .where(eq(deliveryCustodyItems.consignmentId, consignment.id))
    .for("update");
  if (existing.length) {
    if (
      existing.some(
        (row) => Number(row.leaderConsignmentId) !== leaderConsignmentId,
      )
    )
      await tx
        .update(deliveryCustodyItems)
        .set({ leaderConsignmentId, updatedBy: input.actorUserId })
        .where(eq(deliveryCustodyItems.consignmentId, consignment.id));
    return existing;
  }
  const drafts = await sourceDraftsTx(tx, consignment);
  if (!drafts.length) return [];
  const state = initialState(consignment);
  await tx.insert(deliveryCustodyItems).values(
    drafts.map((draft) => ({
      consignmentId: Number(consignment.id),
      leaderConsignmentId,
      branchId: Number(consignment.branchId),
      sourceType: consignment.sourceType,
      sourceId: Number(consignment.sourceId),
      sourceLineKey: draft.sourceLineKey,
      itemKind: draft.itemKind,
      invoiceItemId: draft.invoiceItemId ?? null,
      bundleComponentId: draft.bundleComponentId ?? null,
      variantId: draft.variantId ?? null,
      originalMovementId: draft.originalMovementId ?? null,
      baseQuantity: draft.baseQuantity,
      originalIssueUnitCost: draft.originalIssueUnitCost ?? null,
      originalIssueValue: draft.originalIssueValue ?? null,
      preparedHeldBaseQuantity:
        state === "PREPARED_HELD" ? draft.baseQuantity : 0,
      carrierCustodyBaseQuantity:
        state === "CARRIER_CUSTODY" ? draft.baseQuantity : 0,
      customerDeliveredBaseQuantity:
        state === "CUSTOMER_DELIVERED" ? draft.baseQuantity : 0,
      reviewStatus: draft.reviewStatus,
      reviewReason: draft.reviewReason ?? null,
      createdBy: input.actorUserId,
      updatedBy: input.actorUserId,
    })),
  );
  const rows = await tx
    .select()
    .from(deliveryCustodyItems)
    .where(eq(deliveryCustodyItems.consignmentId, consignment.id))
    .for("update");
  for (const row of rows)
    await tx.insert(deliveryCustodyEvents).values({
      eventKey: `CUSTODY:${row.id}:INIT`,
      custodyItemId: Number(row.id),
      consignmentId: Number(consignment.id),
      operationId: input.operationId,
      eventType: "CUSTODY_INITIALIZED",
      fromState: null,
      toState: state,
      baseQuantity: Number(row.baseQuantity),
      evidence: {
        sourceLineKey: row.sourceLineKey,
        reviewStatus: row.reviewStatus,
      },
      actorUserId: input.actorUserId,
    });
  return rows;
}

function quantities(row: DeliveryCustodyItem) {
  return {
    PREPARED_HELD: Number(row.preparedHeldBaseQuantity),
    CARRIER_CUSTODY: Number(row.carrierCustodyBaseQuantity),
    CUSTOMER_DELIVERED: Number(row.customerDeliveredBaseQuantity),
    RETURNED_PENDING_INSPECTION: Number(
      row.returnedPendingInspectionBaseQuantity,
    ),
    CUSTOMER_OWNED_HELD: Number(row.customerOwnedHeldBaseQuantity),
    REWORK_WIP: Number(row.reworkWipBaseQuantity),
    RESTOCKED_CLOSED: Number(row.restockedClosedBaseQuantity),
    DAMAGED_CLOSED: Number(row.damagedClosedBaseQuantity),
  } satisfies Record<DeliveryCustodyState, number>;
}

export interface TransitionDeliveryCustodyInput {
  custodyItemId: number;
  expectedVersion: number;
  fromState: DeliveryCustodyState;
  toState: DeliveryCustodyState;
  baseQuantity: number;
  operationId: string;
  eventKey: string;
  eventType: string;
  evidence: Record<string, unknown>;
  actorUserId: number | null;
}

/** Quantity-only custody transition.  Stock restoration remains a separate valued command. */
export async function transitionDeliveryCustodyTx(
  tx: Tx,
  input: TransitionDeliveryCustodyInput,
) {
  if (input.fromState === input.toState)
    throw fulfillmentError(
      "حالة العهدة المصدر والهدف متطابقتان",
      "BAD_REQUEST",
    );
  assertPositiveBaseQuantity(input.baseQuantity, String(input.custodyItemId));
  const [row] = await tx
    .select()
    .from(deliveryCustodyItems)
    .where(eq(deliveryCustodyItems.id, input.custodyItemId))
    .for("update")
    .limit(1);
  if (!row) throw fulfillmentError("سطر العهدة غير موجود", "NOT_FOUND");
  const [prior] = await tx
    .select()
    .from(deliveryCustodyEvents)
    .where(eq(deliveryCustodyEvents.eventKey, input.eventKey))
    .limit(1);
  if (prior) {
    if (
      Number(prior.custodyItemId) !== input.custodyItemId ||
      prior.operationId !== input.operationId ||
      prior.fromState !== input.fromState ||
      prior.toState !== input.toState ||
      Number(prior.baseQuantity) !== input.baseQuantity
    )
      throw fulfillmentError(
        "مفتاح تكرار انتقال العهدة استُعمل بحمولة مختلفة",
        "CONFLICT",
      );
    return { item: row, eventId: Number(prior.id), replay: true };
  }
  if (Number(row.version) !== input.expectedVersion)
    throw fulfillmentError(
      "تغيرت عهدة الطرد منذ المعاينة؛ حدّث البطاقة وأعد المحاولة",
      "CONFLICT",
    );
  if (
    input.toState === "RESTOCKED_CLOSED" &&
    row.reviewStatus === "REVIEW_REQUIRED"
  )
    throw fulfillmentError(
      row.reviewReason ??
        "لا توجد لقطة تكلفة تاريخية موثوقة؛ راجع مسؤول المخزون قبل الإرجاع",
      "CONFLICT",
    );
  const next = quantities(row);
  if (next[input.fromState] < input.baseQuantity)
    throw fulfillmentError(
      "الكمية المطلوبة أكبر من الكمية الموجودة في حالة العهدة الحالية",
      "CONFLICT",
    );
  next[input.fromState] -= input.baseQuantity;
  next[input.toState] += input.baseQuantity;
  const conserved = Object.values(next).reduce((sum, value) => sum + value, 0);
  if (conserved !== Number(row.baseQuantity))
    throw fulfillmentError(
      "تعذر حفظ انتقال العهدة لأن مجموع مصائر الكمية غير متوازن",
      "CONFLICT",
    );
  await tx
    .update(deliveryCustodyItems)
    .set({
      preparedHeldBaseQuantity: next.PREPARED_HELD,
      carrierCustodyBaseQuantity: next.CARRIER_CUSTODY,
      customerDeliveredBaseQuantity: next.CUSTOMER_DELIVERED,
      returnedPendingInspectionBaseQuantity: next.RETURNED_PENDING_INSPECTION,
      customerOwnedHeldBaseQuantity: next.CUSTOMER_OWNED_HELD,
      reworkWipBaseQuantity: next.REWORK_WIP,
      restockedClosedBaseQuantity: next.RESTOCKED_CLOSED,
      damagedClosedBaseQuantity: next.DAMAGED_CLOSED,
      version: Number(row.version) + 1,
      updatedBy: input.actorUserId,
      closedAt:
        next.RESTOCKED_CLOSED + next.DAMAGED_CLOSED === Number(row.baseQuantity)
          ? new Date()
          : null,
    })
    .where(
      and(
        eq(deliveryCustodyItems.id, row.id),
        eq(deliveryCustodyItems.version, input.expectedVersion),
      ),
    );
  const eventId = extractInsertId(
    await tx.insert(deliveryCustodyEvents).values({
      eventKey: input.eventKey,
      custodyItemId: Number(row.id),
      consignmentId: Number(row.consignmentId),
      operationId: input.operationId,
      eventType: input.eventType,
      fromState: input.fromState,
      toState: input.toState,
      baseQuantity: input.baseQuantity,
      evidence: input.evidence,
      actorUserId: input.actorUserId,
    }),
  );
  const [updated] = await tx
    .select()
    .from(deliveryCustodyItems)
    .where(eq(deliveryCustodyItems.id, row.id))
    .limit(1);
  return { item: updated!, eventId, replay: false };
}

type DeliveryCustodyLifecycleEvent = {
  eventId: number;
  eventKey: string;
  consignmentId: number;
  eventType: string;
  actorUserId?: number | null;
  payload?: Record<string, unknown>;
};

type CustodyLifecycleRule = {
  fromStates: DeliveryCustodyState[];
  toState: DeliveryCustodyState;
};

const COMMERCIAL_RETURN_EVENT_TYPES = new Set([
  "RETURNED",
  "PARCEL_RETURNED",
  "RETURN_SETTLEMENT",
]);

const COMMERCIAL_RETURN_SOURCE_STATES: DeliveryCustodyState[] = [
  "RETURNED_PENDING_INSPECTION",
  "CUSTOMER_OWNED_HELD",
  "CUSTOMER_DELIVERED",
  "CARRIER_CUSTODY",
  "PREPARED_HELD",
];

async function reconcileCommercialReturnCustodyTx(
  tx: Tx,
  input: DeliveryCustodyLifecycleEvent,
) {
  const invoiceId = Number(input.payload?.invoiceId);
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0)
    return { initialized: 0, transitioned: 0 };
  const actorUserId = input.actorUserId ?? null;
  const rows = await initializeConsignmentCustodyTx(tx, {
    consignmentId: input.consignmentId,
    actorUserId,
    operationId: `delivery.event:${input.eventId}`,
  });
  const itemIds = Array.from(
    new Set(
      rows
        .map((row) => row.invoiceItemId)
        .filter((id): id is number => id != null),
    ),
  );
  if (!itemIds.length) return { initialized: rows.length, transitioned: 0 };
  const counters = await tx
    .select({
      id: invoiceItems.id,
      invoiceId: invoiceItems.invoiceId,
      baseQuantity: invoiceItems.baseQuantity,
      returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
      returnedRestockedBaseQuantity:
        invoiceItems.returnedRestockedBaseQuantity,
    })
    .from(invoiceItems)
    .where(inArray(invoiceItems.id, itemIds))
    .for("share");
  const counterByItem = new Map(
    counters
      .filter((counter) => Number(counter.invoiceId) === invoiceId)
      .map((counter) => [Number(counter.id), counter]),
  );
  const componentAdjustedItems = new Set(
    (
      await tx
        .select({ invoiceItemId: componentRightsAdjustments.invoiceItemId })
        .from(componentRightsAdjustments)
        .where(inArray(componentRightsAdjustments.invoiceItemId, itemIds))
        .for("share")
    ).map((row) => Number(row.invoiceItemId)),
  );
  let transitioned = 0;
  for (const original of [...rows].sort(
    (a, b) => Number(a.id) - Number(b.id),
  )) {
    if (
      original.itemKind !== "STOCKED_ITEM" &&
      original.itemKind !== "BUNDLE_COMPONENT"
    )
      continue;
    const counter = counterByItem.get(Number(original.invoiceItemId));
    if (!counter) continue;
    if (
      original.itemKind === "BUNDLE_COMPONENT" &&
      componentAdjustedItems.has(Number(original.invoiceItemId))
    ) {
      if (original.reviewStatus !== "REVIEW_REQUIRED")
        await tx
          .update(deliveryCustodyItems)
          .set({
            reviewStatus: "REVIEW_REQUIRED",
            reviewReason:
              "مرتجع حقوق مكوّنات البكج لا يحدد مصير بقية المكونات؛ يلزم تدقيق الكميات قبل إغلاق العهدة",
            version: Number(original.version) + 1,
            updatedBy: actorUserId,
          })
          .where(
            and(
              eq(deliveryCustodyItems.id, original.id),
              eq(deliveryCustodyItems.version, original.version),
            ),
          );
      continue;
    }
    const itemBaseQuantity = Number(counter.baseQuantity);
    const factor = Number(original.baseQuantity) / itemBaseQuantity;
    const desiredReturned = Number(counter.returnedBaseQuantity ?? 0) * factor;
    const desiredRestocked =
      Number(counter.returnedRestockedBaseQuantity ?? 0) * factor;
    const desiredDamaged = desiredReturned - desiredRestocked;
    if (
      !Number.isSafeInteger(itemBaseQuantity) ||
      itemBaseQuantity <= 0 ||
      !Number.isSafeInteger(desiredReturned) ||
      !Number.isSafeInteger(desiredRestocked) ||
      !Number.isSafeInteger(desiredDamaged) ||
      desiredRestocked < 0 ||
      desiredDamaged < 0 ||
      desiredReturned > Number(original.baseQuantity)
    )
      throw fulfillmentError(
        `عدادات المرتجع لا تطابق كمية عهدة السطر ${original.sourceLineKey}`,
        "CONFLICT",
      );
    let row = original;
    for (const [toState, desired] of [
      ["RESTOCKED_CLOSED", desiredRestocked],
      ["DAMAGED_CLOSED", desiredDamaged],
    ] as const) {
      let missing = desired - quantities(row)[toState];
      if (missing < 0)
        throw fulfillmentError(
          `عداد المرتجع تراجع عن مصير عهدة مثبت للسطر ${row.sourceLineKey}`,
          "CONFLICT",
        );
      for (const fromState of COMMERCIAL_RETURN_SOURCE_STATES) {
        if (missing === 0) break;
        const available = quantities(row)[fromState];
        if (available <= 0) continue;
        const baseQuantity = Math.min(missing, available);
        const result = await transitionDeliveryCustodyTx(tx, {
          custodyItemId: Number(row.id),
          expectedVersion: Number(row.version),
          fromState,
          toState,
          baseQuantity,
          operationId: `delivery.event:${input.eventId}`,
          eventKey: `CUSTODY:DE:${input.eventId}:I:${row.id}:${fromState}:${toState}`,
          eventType: `DELIVERY_${input.eventType}`,
          evidence: {
            ...(input.payload ?? {}),
            deliveryEventId: input.eventId,
            deliveryEventKey: input.eventKey,
            invoiceItemId: Number(row.invoiceItemId),
            returnedBaseQuantity: Number(
              counter.returnedBaseQuantity ?? 0,
            ),
            returnedRestockedBaseQuantity: Number(
              counter.returnedRestockedBaseQuantity ?? 0,
            ),
          },
          actorUserId,
        });
        row = result.item;
        missing -= baseQuantity;
        transitioned += result.replay ? 0 : 1;
      }
      if (missing !== 0)
        throw fulfillmentError(
          `لا تكفي كمية العهدة المفتوحة لإغلاق مرتجع السطر ${row.sourceLineKey}`,
          "CONFLICT",
        );
    }
  }
  return { initialized: rows.length, transitioned };
}

/**
 * Mirrors already-authorized physical delivery events into quantity custody.
 * The event writer remains the operational authority; this hook adds no stock,
 * sale, collection, receipt or accounting effect.
 */
function custodyRuleForEvent(eventType: string): CustodyLifecycleRule | null {
  if (
    [
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "REASSIGNED",
      "ASSIGNMENT_REACTIVATED",
    ].includes(eventType)
  )
    return {
      fromStates: ["PREPARED_HELD", "CUSTOMER_OWNED_HELD"],
      toState: "CARRIER_CUSTODY",
    };
  if (["DELIVERED", "AFTERCARE_DELIVERED"].includes(eventType))
    return {
      fromStates: ["PREPARED_HELD", "CARRIER_CUSTODY"],
      toState: "CUSTOMER_DELIVERED",
    };
  if (["WORKFLOW_RETURN_RECEIVED", "AFTERCARE_RETURNED"].includes(eventType))
    return {
      // Both events are emitted only by the existing staff-authorized, physically
      // received and inspected workflows. A declaration/failure event never enters here.
      fromStates: ["PREPARED_HELD", "CARRIER_CUSTODY", "CUSTOMER_DELIVERED"],
      toState: "CUSTOMER_OWNED_HELD",
    };
  return null;
}

export async function applyDeliveryCustodyEventTx(
  tx: Tx,
  input: DeliveryCustodyLifecycleEvent,
) {
  if (COMMERCIAL_RETURN_EVENT_TYPES.has(input.eventType))
    return reconcileCommercialReturnCustodyTx(tx, input);
  const rule = custodyRuleForEvent(input.eventType);
  if (!rule) return { initialized: 0, transitioned: 0 };
  const actorUserId = input.actorUserId ?? null;
  const rows = await initializeConsignmentCustodyTx(tx, {
    consignmentId: input.consignmentId,
    actorUserId,
    operationId: `delivery.event:${input.eventId}`,
  });
  let transitioned = 0;
  for (const original of [...rows].sort(
    (a, b) => Number(a.id) - Number(b.id),
  )) {
    let row = original;
    for (const fromState of rule.fromStates) {
      const baseQuantity = quantities(row)[fromState];
      if (baseQuantity <= 0) continue;
      const result = await transitionDeliveryCustodyTx(tx, {
        custodyItemId: Number(row.id),
        expectedVersion: Number(row.version),
        fromState,
        toState: rule.toState,
        baseQuantity,
        operationId: `delivery.event:${input.eventId}`,
        eventKey: `CUSTODY:DE:${input.eventId}:I:${row.id}:${fromState}:${rule.toState}`,
        eventType: `DELIVERY_${input.eventType}`,
        evidence: {
          ...(input.payload ?? {}),
          deliveryEventId: input.eventId,
          deliveryEventKey: input.eventKey,
          deliveryEventType: input.eventType,
        },
        actorUserId,
      });
      row = result.item;
      transitioned += result.replay ? 0 : 1;
    }
  }
  return { initialized: rows.length, transitioned };
}

const RECORDED_CUSTODY_EVENT_TYPES = [
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "REASSIGNED",
  "ASSIGNMENT_REACTIVATED",
  "DELIVERED",
  "AFTERCARE_DELIVERED",
  "WORKFLOW_RETURN_RECEIVED",
  "AFTERCARE_RETURNED",
  "RETURNED",
  "PARCEL_RETURNED",
  "RETURN_SETTLEMENT",
] as const;

/**
 * Repairs custody only from definitive physical/commercial-return events which
 * already committed in this consignment's append-only history. Used by command
 * replay paths which return before writing the event again. It never infers a
 * return from cancellation/declaration and never writes stock or finance.
 */
export async function repairDeliveryCustodyFromRecordedEventsTx(
  tx: Tx,
  consignmentId: number,
) {
  const events = await tx
    .select({
      id: deliveryEvents.id,
      eventKey: deliveryEvents.eventKey,
      eventType: deliveryEvents.eventType,
      actorUserId: deliveryEvents.actorUserId,
      payload: deliveryEvents.payload,
    })
    .from(deliveryEvents)
    .where(
      and(
        eq(deliveryEvents.consignmentId, consignmentId),
        inArray(deliveryEvents.eventType, [...RECORDED_CUSTODY_EVENT_TYPES]),
      ),
    )
    .orderBy(asc(deliveryEvents.id))
    .for("share");
  let initialized = 0;
  let transitioned = 0;
  for (const event of events) {
    const result = await applyDeliveryCustodyEventTx(tx, {
      eventId: Number(event.id),
      eventKey: event.eventKey,
      consignmentId,
      eventType: event.eventType,
      actorUserId: event.actorUserId,
      payload: (event.payload ?? {}) as Record<string, unknown>,
    });
    initialized = Math.max(initialized, result.initialized);
    transitioned += result.transitioned;
  }
  return { initialized, transitioned, custodyEventCount: events.length };
}
