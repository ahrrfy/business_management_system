import { and, eq, inArray } from "drizzle-orm";
import {
  deliveryConsignments,
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
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { fulfillmentError } from "../fulfillment/core";
import { money, toDbMoney } from "../money";

export type DeliveryCustodyState = (typeof DELIVERY_CUSTODY_STATES)[number];

interface InitializeCustodyInput {
  consignmentId: number;
  actorUserId: number;
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
  actorUserId: number;
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
