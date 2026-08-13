import { TRPCError } from "@trpc/server";
import { and, desc, eq, exists, inArray, isNull, notExists, notInArray, or, sql } from "drizzle-orm";
import {
  auditLogs,
  customers,
  deliveryConsignments,
  deliveryParties,
  deliveryPartyMembers,
  deliveryRemittanceLines,
  invoices,
  onlineOrders,
  receipts,
  users,
  workOrders,
} from "../../drizzle/schema";
import type { TrpcContext } from "../context";
import { getDb, type Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { logAuditTx } from "./auditService";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "./idempotency";
import { adjustCustomerBalance } from "./ledgerService";
import { money, round2, toDbMoney } from "./money";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./delivery/lifecycle";
import { nextConsignmentNumber } from "./delivery/numbering";
import { assertFloatLimitTx } from "./delivery/parties";
import { withTx } from "./tx";

export const DELIVERY_LEGACY_REPAIR_ACTIONS = [
  "CREATE_MISSING_CONSIGNMENT",
  "RECORD_PREPAID_DELIVERY_PROOF",
  "REOPEN_PREPAID_CONSIGNMENT",
  "ACKNOWLEDGE_PARTIAL_OUTSTANDING",
  "LINK_GATEWAY_ACCOUNT",
  "CONFIRM_EXTERNAL_WITHOUT_GATEWAY",
  "RESTORE_INVOICE_CUSTOMER",
] as const;

export type DeliveryLegacyRepairAction = (typeof DELIVERY_LEGACY_REPAIR_ACTIONS)[number];

export type DeliveryLegacyRepairInput = {
  action: DeliveryLegacyRepairAction;
  targetId: number;
  confirmation: string;
  note: string;
  partyId?: number | null;
  deliveryFee?: string | null;
  gatewayUserId?: number | null;
  deliveredAt?: string | null;
  evidenceRef?: string | null;
  feeSettlementAction?: "EARN_ONLY" | "EARN_AND_DIRECT_PAID" | null;
  customerBalanceAction?: "IDENTITY_ONLY" | "ADD_OUTSTANDING" | null;
};

const IDEMPOTENCY_OPERATION = "delivery.legacy.repair";
const REVIEW_ACTIONS = [
  "delivery.legacy.partialReviewed",
  "delivery.legacy.externalGatewayConfirmed",
] as const;

/**
 * تقرير إنقاذ بيانات التوصيل القديمة. كل الاستعلامات قراءة فقط، ومطابقة مباشرة للاستعلامات
 * التشغيلية الخمسة في docs/delivery-system-rescue-2026-08-12.md.
 */
export async function getDeliveryLegacyFindings(input: { branchId?: number | null }) {
  const db = getDb();
  if (!db) {
    return {
      closedWithoutConsignment: [],
      prepaidClosedWithoutProof: [],
      partialOutstanding: [],
      openPartiesWithoutGateway: [],
      invoicesMissingCustomer: [],
      options: { parties: [], courierAccounts: [] },
    };
  }
  const branchId = input.branchId ?? null;

  const closedWithoutConsignmentWhere = [
    eq(workOrders.hasDelivery, true),
    eq(workOrders.status, "DELIVERED"),
    notInArray(invoices.status, ["CANCELLED", "RETURNED"]),
    isNull(deliveryConsignments.id),
  ];
  if (branchId != null) closedWithoutConsignmentWhere.push(eq(workOrders.branchId, branchId));
  const closedWithoutConsignment = await db
    .select({
      id: workOrders.id,
      orderNumber: workOrders.orderNumber,
      branchId: workOrders.branchId,
      invoiceId: workOrders.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      customerId: workOrders.customerId,
      contactName: workOrders.contactName,
      deliveredAt: workOrders.deliveredAt,
      deliveryAddress: workOrders.deliveryAddress,
      deliveryCost: workOrders.deliveryCost,
    })
    .from(workOrders)
    .innerJoin(invoices, eq(invoices.id, workOrders.invoiceId))
    .leftJoin(deliveryConsignments, or(
      eq(deliveryConsignments.workOrderId, workOrders.id),
      eq(deliveryConsignments.invoiceId, workOrders.invoiceId),
    ))
    .where(and(...closedWithoutConsignmentWhere))
    .orderBy(desc(workOrders.id));

  const createdByLegacyRepair = db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.action, "delivery.legacy.createConsignment"),
      eq(auditLogs.entityType, "workOrder"),
      sql`CAST(${auditLogs.entityId} AS UNSIGNED) = ${deliveryConsignments.workOrderId}`,
      sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${auditLogs.newValue}, '$.consignmentId')) AS UNSIGNED) = ${deliveryConsignments.id}`,
    ));
  const prepaidWhere = [
    sql`${deliveryConsignments.codAmount} = 0`,
    isNull(deliveryConsignments.courierDeliveredAt),
    or(
      eq(deliveryConsignments.parcelStatus, "DELIVERED"),
      and(eq(deliveryConsignments.parcelStatus, "ASSIGNED"), exists(createdByLegacyRepair)),
    )!,
  ];
  if (branchId != null) prepaidWhere.push(eq(deliveryConsignments.branchId, branchId));
  const prepaidClosedWithoutProof = await db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      branchId: deliveryConsignments.branchId,
      workOrderId: deliveryConsignments.workOrderId,
      orderNumber: workOrders.orderNumber,
      partyId: deliveryConsignments.partyId,
      partyName: deliveryParties.name,
      status: deliveryConsignments.status,
      parcelStatus: deliveryConsignments.parcelStatus,
      moneyStatus: deliveryConsignments.moneyStatus,
      deliveryFee: deliveryConsignments.deliveryFee,
      feeCollection: deliveryConsignments.feeCollection,
      dispatchedAt: deliveryConsignments.dispatchedAt,
      settledAt: deliveryConsignments.settledAt,
    })
    .from(deliveryConsignments)
    .leftJoin(workOrders, eq(workOrders.id, deliveryConsignments.workOrderId))
    .innerJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
    .where(and(...prepaidWhere))
    .orderBy(desc(deliveryConsignments.id));

  const partialWhere = [
    eq(deliveryConsignments.moneyStatus, "PARTIAL"),
    sql`${deliveryConsignments.codAmount} > ${deliveryConsignments.collectedAmount}`,
  ];
  if (branchId != null) partialWhere.push(eq(deliveryConsignments.branchId, branchId));
  const partialRows = await db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      branchId: deliveryConsignments.branchId,
      partyId: deliveryConsignments.partyId,
      partyName: deliveryParties.name,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      remittanceId: deliveryConsignments.remittanceId,
      allocationLineCount: sql<number>`COUNT(${deliveryRemittanceLines.id})`,
      dispatchedAt: deliveryConsignments.dispatchedAt,
    })
    .from(deliveryConsignments)
    .innerJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
    .leftJoin(deliveryRemittanceLines, eq(deliveryRemittanceLines.consignmentId, deliveryConsignments.id))
    .where(and(...partialWhere))
    .groupBy(
      deliveryConsignments.id,
      deliveryConsignments.consignmentNumber,
      deliveryConsignments.branchId,
      deliveryConsignments.partyId,
      deliveryParties.name,
      deliveryConsignments.codAmount,
      deliveryConsignments.collectedAmount,
      deliveryConsignments.remittanceId,
      deliveryConsignments.dispatchedAt,
    )
    .orderBy(desc(deliveryConsignments.id));

  const activeLegacyGateway = db
    .select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.id, deliveryParties.userId),
      eq(users.role, "courier"),
      eq(users.isActive, true),
    ));
  const activeGatewayMember = db
    .select({ id: deliveryPartyMembers.id })
    .from(deliveryPartyMembers)
    .innerJoin(users, eq(users.id, deliveryPartyMembers.userId))
    .where(and(
      eq(deliveryPartyMembers.partyId, deliveryParties.id),
      eq(deliveryPartyMembers.isActive, true),
      eq(users.role, "courier"),
      eq(users.isActive, true),
    ));
  const gatewayWhere = [
    notExists(activeLegacyGateway),
    notExists(activeGatewayMember),
    sql`(${deliveryConsignments.parcelStatus} NOT IN ('DELIVERED','RETURNED') OR ${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL'))`,
  ];
  if (branchId != null) gatewayWhere.push(eq(deliveryConsignments.branchId, branchId));
  const openConsignmentPartyRows = await db
    .select({
      id: deliveryParties.id,
      name: deliveryParties.name,
      partyType: deliveryParties.partyType,
      branchId: deliveryParties.branchId,
      openCount: sql<number>`COUNT(*)`,
      oldestOpenAt: sql<Date | null>`MIN(${deliveryConsignments.dispatchedAt})`,
    })
    .from(deliveryParties)
    .innerJoin(deliveryConsignments, eq(deliveryConsignments.partyId, deliveryParties.id))
    .where(and(...gatewayWhere))
    .groupBy(deliveryParties.id, deliveryParties.name, deliveryParties.partyType, deliveryParties.branchId)
    .orderBy(desc(sql`COUNT(*)`));

  const storeGatewayWhere = [
    notExists(activeLegacyGateway),
    notExists(activeGatewayMember),
    eq(onlineOrders.status, "SHIPPED"),
  ];
  if (branchId != null) storeGatewayWhere.push(eq(onlineOrders.branchId, branchId));
  const openStorePartyRows = await db
    .select({
      id: deliveryParties.id,
      name: deliveryParties.name,
      partyType: deliveryParties.partyType,
      branchId: deliveryParties.branchId,
      openCount: sql<number>`COUNT(*)`,
      oldestOpenAt: sql<Date | null>`MIN(${onlineOrders.orderDate})`,
    })
    .from(deliveryParties)
    .innerJoin(onlineOrders, eq(onlineOrders.deliveryPartyId, deliveryParties.id))
    .where(and(...storeGatewayWhere))
    .groupBy(deliveryParties.id, deliveryParties.name, deliveryParties.partyType, deliveryParties.branchId)
    .orderBy(desc(sql`COUNT(*)`));
  const openPartyMap = new Map<number, (typeof openConsignmentPartyRows)[number]>();
  for (const row of [...openConsignmentPartyRows, ...openStorePartyRows]) {
    const id = Number(row.id);
    const current = openPartyMap.get(id);
    if (!current) {
      openPartyMap.set(id, { ...row, openCount: Number(row.openCount) });
      continue;
    }
    const currentOldest = current.oldestOpenAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const rowOldest = row.oldestOpenAt?.getTime() ?? Number.POSITIVE_INFINITY;
    openPartyMap.set(id, {
      ...current,
      openCount: Number(current.openCount) + Number(row.openCount),
      oldestOpenAt: rowOldest < currentOldest ? row.oldestOpenAt : current.oldestOpenAt,
    });
  }
  const openPartiesRows = Array.from(openPartyMap.values())
    .sort((a, b) => Number(b.openCount) - Number(a.openCount));

  const intentionalPartyOwnedCod = db
    .select({ id: deliveryConsignments.id })
    .from(deliveryConsignments)
    .where(and(
      eq(deliveryConsignments.invoiceId, invoices.id),
      eq(deliveryConsignments.workOrderId, workOrders.id),
      eq(deliveryConsignments.endCustomerId, workOrders.customerId),
      sql`${deliveryConsignments.codAmount} > 0`,
    ));
  const missingCustomerWhere = [
    eq(workOrders.hasDelivery, true),
    sql`${workOrders.customerId} IS NOT NULL`,
    isNull(invoices.customerId),
    notExists(intentionalPartyOwnedCod),
  ];
  if (branchId != null) missingCustomerWhere.push(eq(workOrders.branchId, branchId));
  const invoicesMissingCustomer = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      branchId: invoices.branchId,
      orderId: workOrders.id,
      orderNumber: workOrders.orderNumber,
      customerId: workOrders.customerId,
      customerName: customers.name,
      customerCurrentBalance: customers.currentBalance,
      total: invoices.total,
      paidAmount: invoices.paidAmount,
      returnedTotal: invoices.returnedTotal,
      status: invoices.status,
    })
    .from(workOrders)
    .innerJoin(invoices, eq(invoices.id, workOrders.invoiceId))
    .innerJoin(customers, eq(customers.id, workOrders.customerId))
    .where(and(...missingCustomerWhere))
    .orderBy(desc(invoices.id));

  const reviewRows = await db
    .select({ action: auditLogs.action, entityId: auditLogs.entityId, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(inArray(auditLogs.action, [...REVIEW_ACTIONS]));
  const reviewMap = new Map(reviewRows.map((row) => [`${row.action}:${row.entityId}`, row.createdAt]));

  const partyOptionWhere = branchId == null
    ? eq(deliveryParties.isActive, true)
    : and(
        eq(deliveryParties.isActive, true),
        sql`(${deliveryParties.branchId} IS NULL OR ${deliveryParties.branchId} = ${branchId})`,
      );
  const parties = await db
    .select({
      id: deliveryParties.id,
      name: deliveryParties.name,
      branchId: deliveryParties.branchId,
      userId: deliveryParties.userId,
    })
    .from(deliveryParties)
    .where(partyOptionWhere)
    .orderBy(deliveryParties.name);
  const courierAccounts = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      branchId: users.branchId,
      isActive: users.isActive,
    })
    .from(users)
    .where(and(eq(users.role, "courier"), eq(users.isActive, true)))
    .orderBy(users.name);
  const [legacyAccountLinks, memberAccountLinks] = await Promise.all([
    db.select({ userId: deliveryParties.userId, partyId: deliveryParties.id })
      .from(deliveryParties)
      .where(sql`${deliveryParties.userId} IS NOT NULL`),
    db.select({ userId: deliveryPartyMembers.userId, partyId: deliveryPartyMembers.partyId })
      .from(deliveryPartyMembers),
  ]);
  const linkedPartyByUser = new Map<number, number>();
  for (const link of [...legacyAccountLinks, ...memberAccountLinks]) {
    if (link.userId != null) linkedPartyByUser.set(Number(link.userId), Number(link.partyId));
  }

  return {
    closedWithoutConsignment: closedWithoutConsignment.map(normalizeIds),
    prepaidClosedWithoutProof: prepaidClosedWithoutProof.map(normalizeIds),
    partialOutstanding: partialRows.map((row) => ({
      ...normalizeIds(row),
      remainingAmount: toDbMoney(round2(money(row.codAmount).minus(money(row.collectedAmount)))),
      allocationLineCount: Number(row.allocationLineCount),
      remittanceTraceMissing: Number(row.allocationLineCount) === 0,
      reviewedAt: reviewMap.get(`delivery.legacy.partialReviewed:${row.id}`) ?? null,
    })),
    openPartiesWithoutGateway: openPartiesRows.map((row) => ({
      ...normalizeIds(row),
      openCount: Number(row.openCount),
      reviewedAt: reviewMap.get(`delivery.legacy.externalGatewayConfirmed:${row.id}`) ?? null,
    })),
    invoicesMissingCustomer: invoicesMissingCustomer.map((row) => ({
      ...normalizeIds(row),
      outstandingAmount: toDbMoney(DecimalMaxZero(
        money(row.total).minus(money(row.paidAmount)).minus(money(row.returnedTotal ?? "0")),
      )),
    })),
    options: {
      parties: parties.map(normalizeIds),
      courierAccounts: courierAccounts.map((account) => normalizeIds({
        ...account,
        linkedPartyId: linkedPartyByUser.get(Number(account.id)) ?? null,
      })),
    },
  };
}

function normalizeIds<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const [key, value] of Object.entries(out)) {
    if ((key === "id" || key.endsWith("Id")) && value != null) out[key] = Number(value);
  }
  return out as T;
}

function requireConfirmation(actual: string, supplied: string) {
  if (supplied.trim() !== actual.trim()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `التأكيد غير مطابق — اكتب «${actual}» حرفياً`,
    });
  }
}

function requireEvidence(input: DeliveryLegacyRepairInput) {
  if (!input.evidenceRef?.trim()) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مرجع إثبات التسليم مطلوب ولا يُستنتج آلياً" });
  }
}

async function beginDecision(tx: Tx, input: DeliveryLegacyRepairInput) {
  const decisionKey = `${input.action}:${input.targetId}`;
  const hash = idempotencyHash({
    action: input.action,
    targetId: input.targetId,
    note: input.note.trim(),
    partyId: input.partyId ?? null,
    deliveryFee: input.deliveryFee ?? null,
    gatewayUserId: input.gatewayUserId ?? null,
    deliveredAt: input.deliveredAt ?? null,
    evidenceRef: input.evidenceRef?.trim() ?? null,
    feeSettlementAction: input.feeSettlementAction ?? null,
    customerBalanceAction: input.customerBalanceAction ?? null,
  });
  const replay = await checkIdempotency(tx, IDEMPOTENCY_OPERATION, decisionKey, hash);
  return { decisionKey, hash, replay: replay != null };
}

async function completeDecision(
  tx: Tx,
  input: DeliveryLegacyRepairInput,
  decision: { decisionKey: string; hash: string },
) {
  await recordIdempotencyKey(tx, IDEMPOTENCY_OPERATION, decision.decisionKey, input.targetId, decision.hash);
}

/** إصلاحٌ صفّي واحد. لا bulk update، وكل قرارٍ يُقفل صفّه ويُدقَّق داخل المعاملة نفسها. */
export async function repairDeliveryLegacyRow(
  input: DeliveryLegacyRepairInput,
  auditContext: Pick<TrpcContext, "user" | "req">,
) {
  return withTx(async (tx) => {
    const decision = await beginDecision(tx, input);
    if (decision.replay) return { action: input.action, targetId: input.targetId, idempotentReplay: true as const };

    let result: Record<string, unknown> = { action: input.action, targetId: input.targetId };
    switch (input.action) {
      case "CREATE_MISSING_CONSIGNMENT":
        result = { ...result, ...(await createMissingConsignment(tx, input, auditContext)) };
        break;
      case "RECORD_PREPAID_DELIVERY_PROOF":
        result = { ...result, ...(await recordPrepaidProof(tx, input, auditContext)) };
        break;
      case "REOPEN_PREPAID_CONSIGNMENT":
        result = { ...result, ...(await reopenPrepaidConsignment(tx, input, auditContext)) };
        break;
      case "ACKNOWLEDGE_PARTIAL_OUTSTANDING":
        await acknowledgePartial(tx, input, auditContext);
        break;
      case "LINK_GATEWAY_ACCOUNT":
        result = { ...result, ...(await linkGatewayAccount(tx, input, auditContext)) };
        break;
      case "CONFIRM_EXTERNAL_WITHOUT_GATEWAY":
        await confirmExternalWithoutGateway(tx, input, auditContext);
        break;
      case "RESTORE_INVOICE_CUSTOMER":
        result = { ...result, ...(await restoreInvoiceCustomer(tx, input, auditContext)) };
        break;
    }

    await completeDecision(tx, input, decision);
    return { ...result, idempotentReplay: false as const };
  });
}

async function createMissingConsignment(
  tx: Tx,
  input: DeliveryLegacyRepairInput,
  ctx: Pick<TrpcContext, "user" | "req">,
) {
  if (input.partyId == null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "اختر جهة التوصيل صراحةً" });
  }
  if (input.deliveryFee == null || input.deliveryFee === "") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "أدخل أجرة التوصيل صراحةً، ولو كانت صفراً" });
  }
  const wo = (await tx.select().from(workOrders).where(eq(workOrders.id, input.targetId)).for("update").limit(1))[0];
  if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشغل غير موجود" });
  requireConfirmation(wo.orderNumber, input.confirmation);
  if (!wo.hasDelivery || wo.status !== "DELIVERED" || wo.invoiceId == null) {
    throw new TRPCError({ code: "CONFLICT", message: "الصف لم يعد طلب توصيل مغلقاً قابلاً لهذا الإصلاح" });
  }
  const existing = (await tx
    .select({ id: deliveryConsignments.id })
    .from(deliveryConsignments)
    .where(sql`${deliveryConsignments.workOrderId} = ${wo.id} OR ${deliveryConsignments.invoiceId} = ${wo.invoiceId}`)
    .limit(1))[0];
  if (existing) throw new TRPCError({ code: "CONFLICT", message: "للأمر أو فاتورته إرسالية بالفعل" });

  const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
  if (!party || !party.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل المختارة غير متاحة" });
  if (party.branchId != null && Number(party.branchId) !== Number(wo.branchId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل لا تخص فرع أمر الشغل" });
  }
  const invoice = (await tx.select().from(invoices).where(eq(invoices.id, Number(wo.invoiceId))).for("update").limit(1))[0];
  if (!invoice || invoice.status === "CANCELLED" || invoice.status === "RETURNED") {
    throw new TRPCError({ code: "CONFLICT", message: "فاتورة الأمر غير موجودة أو ملغاة" });
  }
  const codAmount = DecimalMaxZero(
    money(invoice.total).minus(money(invoice.paidAmount)).minus(money(invoice.returnedTotal ?? "0")),
  );
  const fee = round2(money(input.deliveryFee));
  if (fee.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "أجرة التوصيل لا تكون سالبة" });
  const feeCollection = (wo.deliveryFeeCollection ?? "COURIER") as "COURIER" | "COUNTER" | "SHOP";
  let counterFeeHeld = money(0);
  if (feeCollection === "COUNTER") {
    const heldRow = (await tx
      .select({
        amount: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)`,
      })
      .from(receipts)
      .where(and(
        eq(receipts.workOrderId, Number(wo.id)),
        eq(receipts.referenceNumber, `DLV-FEE-WO-${wo.id}`),
        eq(receipts.status, "COMPLETED"),
      )))[0];
    counterFeeHeld = round2(money(heldRow?.amount ?? "0"));
    if (counterFeeHeld.lte(0) || !counterFeeHeld.eq(fee)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `صافي أمانة أجرة التوصيل المقبوضة (${counterFeeHeld.toFixed(2)}) يجب أن يساوي الأجرة المختارة (${fee.toFixed(2)}) قبل الترميم`,
      });
    }
  }
  if (codAmount.gt(0)) await assertFloatLimitTx(tx, party, codAmount);

  const consignmentNumber = await nextConsignmentNumber(tx, Number(wo.branchId));
  const inserted = await tx.insert(deliveryConsignments).values({
    consignmentNumber,
    branchId: Number(wo.branchId),
    partyId: input.partyId,
    invoiceId: Number(invoice.id),
    workOrderId: Number(wo.id),
    sourceType: "WORK_ORDER",
    sourceId: Number(wo.id),
    endCustomerId: wo.customerId ?? null,
    codAmount: toDbMoney(codAmount),
    collectedAmount: "0.00",
    deliveryFee: toDbMoney(fee),
    feeCollection,
    recipientName: wo.contactName ?? null,
    recipientPhone: wo.deliveryPhone ?? wo.contactPhone ?? null,
    deliveryAddress: wo.deliveryAddress ?? null,
    // لا نعدّ الدفع الكامل إثبات تسليم: الإرسالية تبدأ مفتوحة دائماً.
    parcelStatus: "ASSIGNED",
    moneyStatus: codAmount.gt(0) ? "UNSETTLED" : "NOT_APPLICABLE",
    status: "DISPATCHED",
    settledAt: codAmount.isZero() ? new Date() : null,
    dispatchedBy: ctx.user?.id ?? null,
    notes: input.note.trim(),
  });
  const consignmentId = extractInsertId(inserted);
  await appendDeliveryEvent(tx, {
    eventKey: `CN:${consignmentId}:LEGACY_ASSIGNED`,
    consignmentId,
    eventType: "ASSIGNED",
    toParcelStatus: "ASSIGNED",
    toMoneyStatus: codAmount.gt(0) ? "UNSETTLED" : "NOT_APPLICABLE",
    actorUserId: ctx.user?.id ?? null,
    payload: { legacyRepair: true, sourceType: "WORK_ORDER", sourceId: Number(wo.id), decisionNote: input.note.trim() },
  });
  if (codAmount.gt(0)) {
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${consignmentId}:COD_ASSIGNED`,
      partyId: input.partyId,
      consignmentId,
      branchId: Number(wo.branchId),
      entryType: "COD_ASSIGNED",
      amount: toDbMoney(codAmount),
      notes: `Legacy repair ${consignmentNumber}`,
      actorUserId: ctx.user?.id ?? null,
    });
  }
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.createConsignment",
    entityType: "workOrder",
    entityId: wo.id,
    oldValue: { hasDelivery: wo.hasDelivery, status: wo.status, consignmentId: null },
    newValue: {
      consignmentId,
      consignmentNumber,
      partyId: input.partyId,
      codAmount: toDbMoney(codAmount),
      deliveryFee: toDbMoney(fee),
      feeCollection,
      counterFeeHeld: toDbMoney(counterFeeHeld),
      parcelStatus: "ASSIGNED",
      moneyStatus: codAmount.gt(0) ? "UNSETTLED" : "NOT_APPLICABLE",
      courierDeliveredAt: null,
      decisionNote: input.note.trim(),
    },
  });
  return { consignmentId, consignmentNumber };
}

async function recordPrepaidProof(
  tx: Tx,
  input: DeliveryLegacyRepairInput,
  ctx: Pick<TrpcContext, "user" | "req">,
) {
  requireEvidence(input);
  if (!input.deliveredAt) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وقت التسليم المثبت مطلوب" });
  }
  const deliveredAt = new Date(input.deliveredAt);
  if (Number.isNaN(deliveredAt.getTime()) || deliveredAt.getTime() > Date.now() + 60_000) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "وقت التسليم غير صالح أو يقع في المستقبل" });
  }
  const row = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, input.targetId)).for("update").limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
  requireConfirmation(row.consignmentNumber, input.confirmation);
  const createdByRepair = row.workOrderId == null ? null : (await tx
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.action, "delivery.legacy.createConsignment"),
      eq(auditLogs.entityType, "workOrder"),
      eq(auditLogs.entityId, String(row.workOrderId)),
      sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${auditLogs.newValue}, '$.consignmentId')) AS UNSIGNED) = ${row.id}`,
    ))
    .limit(1))[0];
  if (
    !money(row.codAmount).isZero()
    || row.courierDeliveredAt != null
    || (row.parcelStatus !== "DELIVERED" && (row.parcelStatus !== "ASSIGNED" || !createdByRepair))
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "الإرسالية لم تعد ضمن حالة مدفوعة مغلقة بلا إثبات" });
  }
  await tx.update(deliveryConsignments).set({
    courierDeliveredAt: deliveredAt,
    parcelStatus: "DELIVERED",
    moneyStatus: "NOT_APPLICABLE",
    status: "DELIVERED",
    settledAt: row.settledAt ?? deliveredAt,
  }).where(eq(deliveryConsignments.id, row.id));
  await appendDeliveryEvent(tx, {
    eventKey: `CN:${row.id}:LEGACY_DELIVERY_PROOF`,
    consignmentId: Number(row.id),
    eventType: "DELIVERED",
    fromParcelStatus: row.parcelStatus,
    toParcelStatus: "DELIVERED",
    fromMoneyStatus: row.moneyStatus,
    toMoneyStatus: "NOT_APPLICABLE",
    actorUserId: ctx.user?.id ?? null,
    payload: { legacyRepair: true, evidenceRef: input.evidenceRef!.trim(), decisionNote: input.note.trim() },
  });
  const fee = round2(money(row.deliveryFee));
  if (fee.gt(0)) {
    if (input.feeSettlementAction == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "حدد صراحةً هل ثبت استحقاق الأجرة فقط أم ثبت أيضاً أن المندوب قبضها مباشرة",
      });
    }
    if (input.feeSettlementAction === "EARN_AND_DIRECT_PAID" && row.feeCollection !== "COURIER") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يمكن إثبات قبض مباشر للمندوب إلا عندما تكون طريقة قبض الأجرة COURIER",
      });
    }
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${row.id}:FEE_EARNED`,
      partyId: Number(row.partyId),
      consignmentId: Number(row.id),
      branchId: Number(row.branchId),
      entryType: "FEE_EARNED",
      amount: toDbMoney(fee),
      notes: "Legacy delivery proof",
      actorUserId: ctx.user?.id ?? null,
      occurredAt: deliveredAt,
    });
    if (input.feeSettlementAction === "EARN_AND_DIRECT_PAID") {
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `CN:${row.id}:FEE_PAID_DIRECT`,
        partyId: Number(row.partyId),
        consignmentId: Number(row.id),
        branchId: Number(row.branchId),
        entryType: "FEE_PAID",
        amount: toDbMoney(fee),
        notes: "Direct payment explicitly confirmed in legacy repair",
        actorUserId: ctx.user?.id ?? null,
        occurredAt: deliveredAt,
      });
      await tx.update(deliveryConsignments).set({ feeSettledAt: deliveredAt }).where(eq(deliveryConsignments.id, row.id));
    }
  }
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.prepaidProof",
    entityType: "deliveryConsignment",
    entityId: row.id,
    oldValue: { status: row.status, parcelStatus: row.parcelStatus, moneyStatus: row.moneyStatus, courierDeliveredAt: null },
    newValue: {
      status: "DELIVERED",
      parcelStatus: "DELIVERED",
      moneyStatus: "NOT_APPLICABLE",
      courierDeliveredAt: deliveredAt,
      evidenceRef: input.evidenceRef!.trim(),
      deliveryFee: toDbMoney(fee),
      feeSettlementAction: fee.isZero() ? "NOT_APPLICABLE" : input.feeSettlementAction,
      decisionNote: input.note.trim(),
    },
  });
  return { courierDeliveredAt: deliveredAt };
}

async function reopenPrepaidConsignment(
  tx: Tx,
  input: DeliveryLegacyRepairInput,
  ctx: Pick<TrpcContext, "user" | "req">,
) {
  const row = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, input.targetId)).for("update").limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
  requireConfirmation(row.consignmentNumber, input.confirmation);
  if (!money(row.codAmount).isZero() || row.parcelStatus !== "DELIVERED" || row.courierDeliveredAt != null) {
    throw new TRPCError({ code: "CONFLICT", message: "الإرسالية لم تعد ضمن حالة مدفوعة مغلقة بلا إثبات" });
  }
  await tx.update(deliveryConsignments).set({
    status: "DISPATCHED",
    parcelStatus: "ASSIGNED",
    moneyStatus: "NOT_APPLICABLE",
  }).where(eq(deliveryConsignments.id, row.id));
  await appendDeliveryEvent(tx, {
    eventKey: `CN:${row.id}:LEGACY_REOPENED`,
    consignmentId: Number(row.id),
    eventType: "REASSIGNED",
    fromParcelStatus: row.parcelStatus,
    toParcelStatus: "ASSIGNED",
    fromMoneyStatus: row.moneyStatus,
    toMoneyStatus: "NOT_APPLICABLE",
    actorUserId: ctx.user?.id ?? null,
    payload: { legacyRepair: true, decisionNote: input.note.trim() },
  });
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.prepaidReopened",
    entityType: "deliveryConsignment",
    entityId: row.id,
    oldValue: { status: row.status, parcelStatus: row.parcelStatus, moneyStatus: row.moneyStatus, courierDeliveredAt: null },
    newValue: {
      status: "DISPATCHED",
      parcelStatus: "ASSIGNED",
      moneyStatus: "NOT_APPLICABLE",
      courierDeliveredAt: null,
      decisionNote: input.note.trim(),
    },
  });
  return { status: "DISPATCHED" };
}

async function acknowledgePartial(
  tx: Tx,
  input: DeliveryLegacyRepairInput,
  ctx: Pick<TrpcContext, "user" | "req">,
) {
  const row = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, input.targetId)).for("update").limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
  requireConfirmation(row.consignmentNumber, input.confirmation);
  const remaining = round2(money(row.codAmount).minus(money(row.collectedAmount)));
  if (row.moneyStatus !== "PARTIAL" || remaining.lte(0)) {
    throw new TRPCError({ code: "CONFLICT", message: "الإرسالية لم تعد PARTIAL برصيد مفتوح" });
  }
  const allocationLines = await tx
    .select({ id: deliveryRemittanceLines.id, remittanceId: deliveryRemittanceLines.remittanceId })
    .from(deliveryRemittanceLines)
    .where(eq(deliveryRemittanceLines.consignmentId, row.id))
    .for("update");
  if (allocationLines.length === 0) {
    throw new TRPCError({ code: "CONFLICT", message: "الإرسالية PARTIAL لكن أثر التوريد مفقود؛ لا يمكن تسجيل المراجعة بأمان" });
  }
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.partialReviewed",
    entityType: "deliveryConsignment",
    entityId: row.id,
    oldValue: {
      status: row.status,
      moneyStatus: row.moneyStatus,
      codAmount: row.codAmount,
      collectedAmount: row.collectedAmount,
      remittanceId: row.remittanceId,
      allocationLineCount: allocationLines.length,
    },
    newValue: { decision: "KEEP_OPEN_FOR_COLLECTION", remainingAmount: toDbMoney(remaining), decisionNote: input.note.trim() },
  });
}

async function linkGatewayAccount(
  tx: Tx,
  input: DeliveryLegacyRepairInput,
  ctx: Pick<TrpcContext, "user" | "req">,
) {
  if (input.gatewayUserId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "اختر حساب البوابة صراحةً" });
  const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.targetId)).for("update").limit(1))[0];
  if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
  requireConfirmation(party.name, input.confirmation);
  if (!party.isActive) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "أعد تفعيل جهة التوصيل بقرار مستقل قبل ربط حساب البوابة" });
  const legacyAccount = party.userId == null ? null : (await tx
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, party.userId))
    .for("update")
    .limit(1))[0];
  const legacyGatewayValid = Boolean(legacyAccount?.isActive && legacyAccount.role === "courier");
  if (legacyGatewayValid) throw new TRPCError({ code: "CONFLICT", message: "الجهة مرتبطة بحساب بوابة نشط بالفعل" });
  const memberLinks = await tx
    .select({
      id: deliveryPartyMembers.id,
      userId: deliveryPartyMembers.userId,
      membershipActive: deliveryPartyMembers.isActive,
      userRole: users.role,
      userActive: users.isActive,
    })
    .from(deliveryPartyMembers)
    .innerJoin(users, eq(users.id, deliveryPartyMembers.userId))
    .where(eq(deliveryPartyMembers.partyId, party.id))
    .for("update");
  const activeMember = memberLinks.find((link) => link.membershipActive && link.userRole === "courier" && link.userActive);
  if (activeMember) throw new TRPCError({ code: "CONFLICT", message: "الجهة مرتبطة بحساب بوابة نشط بالفعل" });
  const account = (await tx.select().from(users).where(eq(users.id, input.gatewayUserId)).for("update").limit(1))[0];
  if (!account || account.role !== "courier" || !account.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الحساب المختار ليس حساب مندوب نشطاً" });
  }
  const linked = (await tx.select({ id: deliveryParties.id }).from(deliveryParties).where(eq(deliveryParties.userId, account.id)).limit(1))[0];
  if (linked) throw new TRPCError({ code: "CONFLICT", message: "حساب المندوب مرتبط بجهة أخرى" });
  const memberLink = (await tx
    .select({ id: deliveryPartyMembers.id, partyId: deliveryPartyMembers.partyId })
    .from(deliveryPartyMembers)
    .where(eq(deliveryPartyMembers.userId, account.id))
    .for("update")
    .limit(1))[0];
  if (memberLink && Number(memberLink.partyId) !== Number(party.id)) {
    throw new TRPCError({ code: "CONFLICT", message: "حساب المندوب عضو في جهة توصيل أخرى" });
  }
  await tx.update(deliveryParties).set({ userId: account.id }).where(eq(deliveryParties.id, party.id));
  if (memberLink) {
    await tx.update(deliveryPartyMembers).set({ isActive: true }).where(eq(deliveryPartyMembers.id, memberLink.id));
  } else {
    await tx.insert(deliveryPartyMembers).values({
      partyId: Number(party.id),
      userId: Number(account.id),
      memberRole: party.partyType === "COMPANY" ? "MANAGER" : "DRIVER",
      createdBy: ctx.user?.id ?? null,
    });
  }
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.gatewayLinked",
    entityType: "deliveryParty",
    entityId: party.id,
    oldValue: { userId: party.userId },
    newValue: { userId: account.id, accountName: account.name ?? account.username, decisionNote: input.note.trim() },
  });
  return { gatewayUserId: Number(account.id) };
}

async function confirmExternalWithoutGateway(
  tx: Tx,
  input: DeliveryLegacyRepairInput,
  ctx: Pick<TrpcContext, "user" | "req">,
) {
  const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.targetId)).for("update").limit(1))[0];
  if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
  requireConfirmation(party.name, input.confirmation);
  const legacyAccount = party.userId == null ? null : (await tx
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, party.userId))
    .for("update")
    .limit(1))[0];
  const legacyGatewayValid = Boolean(legacyAccount?.isActive && legacyAccount.role === "courier");
  if (legacyGatewayValid) throw new TRPCError({ code: "CONFLICT", message: "الجهة مرتبطة بحساب بوابة نشط بالفعل" });
  const memberLinks = await tx
    .select({
      id: deliveryPartyMembers.id,
      userId: deliveryPartyMembers.userId,
      membershipActive: deliveryPartyMembers.isActive,
      userRole: users.role,
      userActive: users.isActive,
    })
    .from(deliveryPartyMembers)
    .innerJoin(users, eq(users.id, deliveryPartyMembers.userId))
    .where(eq(deliveryPartyMembers.partyId, party.id))
    .for("update");
  const activeMember = memberLinks.find((link) => link.membershipActive && link.userRole === "courier" && link.userActive);
  if (activeMember) throw new TRPCError({ code: "CONFLICT", message: "الجهة مرتبطة بحساب بوابة نشط بالفعل" });
  const openConsignments = (await tx
    .select({ count: sql<number>`COUNT(*)` })
    .from(deliveryConsignments)
    .where(and(
      eq(deliveryConsignments.partyId, party.id),
      sql`(${deliveryConsignments.parcelStatus} NOT IN ('DELIVERED','RETURNED') OR ${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL'))`,
    )))[0];
  const openStoreOrders = (await tx
    .select({ count: sql<number>`COUNT(*)` })
    .from(onlineOrders)
    .where(and(eq(onlineOrders.deliveryPartyId, party.id), eq(onlineOrders.status, "SHIPPED"))))[0];
  const consignmentCount = Number(openConsignments?.count ?? 0);
  const storeOrderCount = Number(openStoreOrders?.count ?? 0);
  const openCount = consignmentCount + storeOrderCount;
  if (openCount === 0) throw new TRPCError({ code: "CONFLICT", message: "لا توجد أعمال توصيل مفتوحة لهذه الجهة" });
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.externalGatewayConfirmed",
    entityType: "deliveryParty",
    entityId: party.id,
    oldValue: {
      userId: party.userId,
      legacyGatewayValid,
      memberLinks: memberLinks.map((link) => ({
        userId: Number(link.userId),
        membershipActive: link.membershipActive,
        userRole: link.userRole,
        userActive: link.userActive,
        validGatewayMember: link.membershipActive && link.userRole === "courier" && link.userActive,
      })),
      openCount,
      consignmentCount,
      storeOrderCount,
    },
    newValue: { decision: "EXTERNAL_NO_PORTAL", decisionNote: input.note.trim() },
  });
}

async function restoreInvoiceCustomer(
  tx: Tx,
  input: DeliveryLegacyRepairInput,
  ctx: Pick<TrpcContext, "user" | "req">,
) {
  if (input.customerBalanceAction == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "حدّد صراحةً هل الذمة مسجلة مسبقاً أم يجب إضافة المتبقي",
    });
  }
  const wo = (await tx.select().from(workOrders).where(eq(workOrders.invoiceId, input.targetId)).for("update").limit(1))[0];
  if (!wo || !wo.hasDelivery || wo.customerId == null) {
    throw new TRPCError({ code: "CONFLICT", message: "لا يوجد أمر توصيل بعميل معروف لهذه الفاتورة" });
  }
  const invoice = (await tx.select().from(invoices).where(eq(invoices.id, input.targetId)).for("update").limit(1))[0];
  if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  requireConfirmation(invoice.invoiceNumber, input.confirmation);
  if (invoice.customerId != null) throw new TRPCError({ code: "CONFLICT", message: "الفاتورة منسوبة إلى عميل بالفعل" });
  const intentionalPartyOwnedCod = (await tx
    .select({ id: deliveryConsignments.id })
    .from(deliveryConsignments)
    .where(and(
      eq(deliveryConsignments.invoiceId, invoice.id),
      eq(deliveryConsignments.workOrderId, wo.id),
      eq(deliveryConsignments.endCustomerId, wo.customerId),
      sql`${deliveryConsignments.codAmount} > 0`,
    ))
    .limit(1))[0];
  if (intentionalPartyOwnedCod) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "الفاتورة مرتبطة عمداً بعهدة COD لجهة التوصيل؛ لا تُنسب ذمتها إلى العميل",
    });
  }
  const customer = (await tx.select().from(customers).where(eq(customers.id, Number(wo.customerId))).for("update").limit(1))[0];
  if (!customer) throw new TRPCError({ code: "CONFLICT", message: "عميل أمر الشغل غير موجود" });
  const outstanding = DecimalMaxZero(
    money(invoice.total).minus(money(invoice.paidAmount)).minus(money(invoice.returnedTotal ?? "0")),
  );
  if (input.customerBalanceAction === "ADD_OUTSTANDING" && invoice.status === "CANCELLED") {
    throw new TRPCError({ code: "CONFLICT", message: "لا تُضاف ذمة لفاتورة ملغاة؛ اختر استعادة الهوية فقط" });
  }
  const amountToAdd = input.customerBalanceAction === "ADD_OUTSTANDING" ? outstanding : money(0);
  await tx.update(invoices).set({ customerId: Number(customer.id) }).where(eq(invoices.id, invoice.id));
  if (amountToAdd.gt(0)) await adjustCustomerBalance(tx, Number(customer.id), amountToAdd);
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.invoiceCustomerRestored",
    entityType: "invoice",
    entityId: invoice.id,
    oldValue: { customerId: null },
    newValue: {
      customerId: Number(customer.id),
      customerName: customer.name,
      balanceDecision: input.customerBalanceAction,
      outstandingObserved: toDbMoney(outstanding),
      outstandingAddedToCustomer: toDbMoney(amountToAdd),
      decisionNote: input.note.trim(),
    },
  });
  return {
    customerId: Number(customer.id),
    outstandingObserved: toDbMoney(outstanding),
    outstandingAdded: toDbMoney(amountToAdd),
  };
}

function DecimalMaxZero(value: ReturnType<typeof money>) {
  const rounded = round2(value);
  return rounded.isNegative() ? money(0) : rounded;
}
