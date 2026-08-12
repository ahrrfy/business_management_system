import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  auditLogs,
  customers,
  deliveryConsignments,
  deliveryParties,
  invoices,
  users,
  workOrders,
} from "../../drizzle/schema";
import type { TrpcContext } from "../context";
import { getDb, type Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { logAuditTx } from "./auditService";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "./idempotency";
import { adjustCustomerBalance, adjustDeliveryBalance, postEntry } from "./ledgerService";
import { money, round2, toDbMoney } from "./money";
import { nextConsignmentNumber } from "./delivery/numbering";
import { assertFloatLimit } from "./delivery/parties";
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
    .leftJoin(deliveryConsignments, eq(deliveryConsignments.workOrderId, workOrders.id))
    .leftJoin(invoices, eq(invoices.id, workOrders.invoiceId))
    .where(and(...closedWithoutConsignmentWhere))
    .orderBy(desc(workOrders.id));

  const prepaidWhere = [
    sql`${deliveryConsignments.codAmount} = 0`,
    eq(deliveryConsignments.status, "DELIVERED"),
    isNull(deliveryConsignments.courierDeliveredAt),
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
      dispatchedAt: deliveryConsignments.dispatchedAt,
      settledAt: deliveryConsignments.settledAt,
    })
    .from(deliveryConsignments)
    .leftJoin(workOrders, eq(workOrders.id, deliveryConsignments.workOrderId))
    .innerJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
    .where(and(...prepaidWhere))
    .orderBy(desc(deliveryConsignments.id));

  const partialWhere = [
    eq(deliveryConsignments.status, "PARTIAL"),
    sql`${deliveryConsignments.remittanceId} IS NOT NULL`,
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
      dispatchedAt: deliveryConsignments.dispatchedAt,
    })
    .from(deliveryConsignments)
    .innerJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
    .where(and(...partialWhere))
    .orderBy(desc(deliveryConsignments.id));

  const gatewayWhere = [
    isNull(deliveryParties.userId),
    inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]),
  ];
  if (branchId != null) gatewayWhere.push(eq(deliveryConsignments.branchId, branchId));
  const openPartiesRows = await db
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

  const missingCustomerWhere = [
    eq(workOrders.hasDelivery, true),
    sql`${workOrders.customerId} IS NOT NULL`,
    isNull(invoices.customerId),
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
      linkedPartyId: deliveryParties.id,
      isActive: users.isActive,
    })
    .from(users)
    .leftJoin(deliveryParties, eq(deliveryParties.userId, users.id))
    .where(and(eq(users.role, "courier"), eq(users.isActive, true)))
    .orderBy(users.name);

  return {
    closedWithoutConsignment: closedWithoutConsignment.map(normalizeIds),
    prepaidClosedWithoutProof: prepaidClosedWithoutProof.map(normalizeIds),
    partialOutstanding: partialRows.map((row) => ({
      ...normalizeIds(row),
      remainingAmount: toDbMoney(round2(money(row.codAmount).minus(money(row.collectedAmount)))),
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
      courierAccounts: courierAccounts.map(normalizeIds),
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
  if (!invoice || invoice.status === "CANCELLED") {
    throw new TRPCError({ code: "CONFLICT", message: "فاتورة الأمر غير موجودة أو ملغاة" });
  }
  const codAmount = DecimalMaxZero(
    money(invoice.total).minus(money(invoice.paidAmount)).minus(money(invoice.returnedTotal ?? "0")),
  );
  const fee = round2(money(input.deliveryFee));
  if (fee.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "أجرة التوصيل لا تكون سالبة" });
  if (codAmount.gt(0)) assertFloatLimit(party, codAmount);

  const consignmentNumber = await nextConsignmentNumber(tx, Number(wo.branchId));
  const inserted = await tx.insert(deliveryConsignments).values({
    consignmentNumber,
    branchId: Number(wo.branchId),
    partyId: input.partyId,
    invoiceId: Number(invoice.id),
    workOrderId: Number(wo.id),
    endCustomerId: wo.customerId ?? null,
    codAmount: toDbMoney(codAmount),
    collectedAmount: "0.00",
    deliveryFee: toDbMoney(fee),
    feeCollection: wo.deliveryFeeCollection ?? "COURIER",
    recipientName: wo.contactName ?? null,
    recipientPhone: wo.deliveryPhone ?? wo.contactPhone ?? null,
    deliveryAddress: wo.deliveryAddress ?? null,
    // لا نعدّ الدفع الكامل إثبات تسليم: الإرسالية تبدأ مفتوحة دائماً.
    status: "DISPATCHED",
    settledAt: codAmount.isZero() ? new Date() : null,
    dispatchedBy: ctx.user?.id ?? null,
    notes: input.note.trim(),
  });
  const consignmentId = extractInsertId(inserted);
  if (codAmount.gt(0)) {
    await adjustDeliveryBalance(tx, input.partyId, codAmount);
    await postEntry(tx, {
      entryType: "DELIVERY_DISPATCH",
      dedupeKey: `DELIVERY_DISPATCH:${consignmentId}`,
      branchId: Number(wo.branchId),
      invoiceId: Number(invoice.id),
      deliveryPartyId: input.partyId,
      amount: codAmount,
      notes: `إصلاح إرسالية قديمة ${consignmentNumber}`,
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
  if (!money(row.codAmount).isZero() || row.status !== "DELIVERED" || row.courierDeliveredAt != null) {
    throw new TRPCError({ code: "CONFLICT", message: "الإرسالية لم تعد ضمن حالة مدفوعة مغلقة بلا إثبات" });
  }
  await tx.update(deliveryConsignments).set({ courierDeliveredAt: deliveredAt }).where(eq(deliveryConsignments.id, row.id));
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.prepaidProof",
    entityType: "deliveryConsignment",
    entityId: row.id,
    oldValue: { status: row.status, courierDeliveredAt: null },
    newValue: { courierDeliveredAt: deliveredAt, evidenceRef: input.evidenceRef!.trim(), decisionNote: input.note.trim() },
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
  if (!money(row.codAmount).isZero() || row.status !== "DELIVERED" || row.courierDeliveredAt != null) {
    throw new TRPCError({ code: "CONFLICT", message: "الإرسالية لم تعد ضمن حالة مدفوعة مغلقة بلا إثبات" });
  }
  await tx.update(deliveryConsignments).set({ status: "DISPATCHED" }).where(eq(deliveryConsignments.id, row.id));
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.prepaidReopened",
    entityType: "deliveryConsignment",
    entityId: row.id,
    oldValue: { status: row.status, courierDeliveredAt: null },
    newValue: { status: "DISPATCHED", courierDeliveredAt: null, decisionNote: input.note.trim() },
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
  if (row.status !== "PARTIAL" || row.remittanceId == null || remaining.lte(0)) {
    throw new TRPCError({ code: "CONFLICT", message: "الإرسالية لم تعد PARTIAL برصيد مفتوح" });
  }
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.partialReviewed",
    entityType: "deliveryConsignment",
    entityId: row.id,
    oldValue: { status: row.status, codAmount: row.codAmount, collectedAmount: row.collectedAmount, remittanceId: row.remittanceId },
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
  if (party.userId != null) throw new TRPCError({ code: "CONFLICT", message: "الجهة مرتبطة بحساب بالفعل" });
  const account = (await tx.select().from(users).where(eq(users.id, input.gatewayUserId)).for("update").limit(1))[0];
  if (!account || account.role !== "courier" || !account.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الحساب المختار ليس حساب مندوب نشطاً" });
  }
  const linked = (await tx.select({ id: deliveryParties.id }).from(deliveryParties).where(eq(deliveryParties.userId, account.id)).limit(1))[0];
  if (linked) throw new TRPCError({ code: "CONFLICT", message: "حساب المندوب مرتبط بجهة أخرى" });
  await tx.update(deliveryParties).set({ userId: account.id }).where(eq(deliveryParties.id, party.id));
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.gatewayLinked",
    entityType: "deliveryParty",
    entityId: party.id,
    oldValue: { userId: null },
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
  if (party.userId != null) throw new TRPCError({ code: "CONFLICT", message: "الجهة مرتبطة بحساب بالفعل" });
  const open = (await tx
    .select({ count: sql<number>`COUNT(*)` })
    .from(deliveryConsignments)
    .where(and(eq(deliveryConsignments.partyId, party.id), inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]))))[0];
  if (Number(open?.count ?? 0) === 0) throw new TRPCError({ code: "CONFLICT", message: "لا توجد إرساليات مفتوحة لهذه الجهة" });
  await logAuditTx(tx, ctx, {
    action: "delivery.legacy.externalGatewayConfirmed",
    entityType: "deliveryParty",
    entityId: party.id,
    oldValue: { userId: null, openCount: Number(open?.count ?? 0) },
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
