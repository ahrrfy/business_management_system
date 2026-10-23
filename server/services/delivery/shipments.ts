import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { DEAD_INVOICE_STATUSES } from "@shared/invoiceStatus";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  auditLogs,
  customers,
  deliveryConsignments,
  deliveryParties,
  deliveryShipmentMembers,
  invoices,
  type DeliveryConsignment,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { canonicalIraqiMobile } from "../../lib/phone";
import { publishRealtimeEvent } from "../../realtime";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { enqueuePostCommit, requireDb, withTx } from "../tx";
import {
  dispatchInvoiceInTx,
  type DispatchInvoiceInput,
} from "./dispatchInvoice";
import { deliverySearchSql } from "./readSearch";
import { normalizeExternalTrackingRef } from "./trackingRefPolicy";
import type { DeliveryTxActor } from "./types";

const SHIPMENT_OPERATION = "delivery.dispatchInvoiceShipment";
const MAX_SHIPMENT_INVOICES = 30;

function shipmentError(
  what: string,
  why: string,
  doThis: string,
  code:
    | "BAD_REQUEST"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "PRECONDITION_FAILED" = "BAD_REQUEST",
): never {
  throw new TRPCError({
    code,
    message: appErrorMessage({ what, why, doThis }),
  });
}

function assertBranch(branchId: number, actor: DeliveryTxActor) {
  if (
    actor.role !== "admin" &&
    (actor.branchId == null || Number(actor.branchId) !== branchId)
  ) {
    shipmentError(
      "تعذر فتح شحنة التوصيل",
      "الشحنة أو الفاتورة تخص فرعاً آخر أو لا يوجد فرع مسند للموظف",
      "افتح المستند من فرعه الصحيح",
      "FORBIDDEN",
    );
  }
}

/** Preview is unlocked. Use currentRead only after the party/cash-source lock. */
export async function loadShipmentMembersTx(
  tx: Tx,
  consignmentId: number,
  options: { currentRead?: boolean } = {},
): Promise<DeliveryConsignment[]> {
  const membershipQuery = tx
    .select()
    .from(deliveryShipmentMembers)
    .where(eq(deliveryShipmentMembers.consignmentId, consignmentId));
  const membership = (
    await (
      options.currentRead ? membershipQuery.for("share") : membershipQuery
    ).limit(1)
  )[0];
  if (!membership) {
    const singleton = tx
      .select()
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.id, consignmentId))
      .orderBy(asc(deliveryConsignments.id));
    return options.currentRead ? singleton.for("share") : singleton;
  }
  const query = tx
    .select({ cn: deliveryConsignments })
    .from(deliveryShipmentMembers)
    .innerJoin(
      deliveryConsignments,
      eq(deliveryConsignments.id, deliveryShipmentMembers.consignmentId),
    )
    .where(
      eq(
        deliveryShipmentMembers.leaderConsignmentId,
        Number(membership.leaderConsignmentId),
      ),
    )
    .orderBy(asc(deliveryConsignments.id));
  const rows = await (options.currentRead ? query.for("share") : query);
  return rows.map((row) => row.cn);
}

export async function assertStandaloneConsignmentTx(
  tx: Tx,
  consignmentId: number,
  action = "تنفيذ الإجراء",
  options: { currentRead?: boolean } = {},
) {
  const query = tx
    .select()
    .from(deliveryShipmentMembers)
    .where(eq(deliveryShipmentMembers.consignmentId, consignmentId));
  const member = (
    await (options.currentRead ? query.for("share") : query).limit(1)
  )[0];
  if (member)
    shipmentError(
      `تعذر ${action} على فاتورة منفردة من الشحنة`,
      "الإرسالية جزء من شحنة تضم عدة فواتير",
      "افتح تفاصيل الشحنة ونفّذ الإجراء على الشحنة كاملة",
      "PRECONDITION_FAILED",
    );
}

async function shipmentDetailsTx(
  tx: Tx,
  consignmentId: number,
  actor: DeliveryTxActor,
) {
  const source = (
    await tx
      .select()
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.id, consignmentId))
      .limit(1)
  )[0];
  if (!source)
    shipmentError(
      "تعذر فتح الشحنة",
      "الإرسالية غير موجودة",
      "حدّث قائمة التوصيل واختر إرسالية موجودة",
      "NOT_FOUND",
    );
  assertBranch(Number(source.branchId), actor);
  const membership = (
    await tx
      .select()
      .from(deliveryShipmentMembers)
      .where(eq(deliveryShipmentMembers.consignmentId, consignmentId))
      .limit(1)
  )[0];
  const leaderConsignmentId = Number(
    membership?.leaderConsignmentId ?? source.id,
  );
  const rows = await loadShipmentMembersTx(tx, consignmentId);
  const leader = rows.find((row) => Number(row.id) === leaderConsignmentId);
  if (
    !leader ||
    rows.some(
      (row) =>
        Number(row.branchId) !== Number(source.branchId) ||
        Number(row.partyId) !== Number(source.partyId),
    )
  ) {
    shipmentError(
      "تعذر فتح الشحنة",
      "روابط الشحنة لا تطابق قائدها أو فرعها أو جهة توصيلها",
      "أبلغ المدير لمراجعة روابط الشحنة قبل المتابعة",
      "PRECONDITION_FAILED",
    );
  }
  const invoiceRows = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      total: invoices.total,
      paidAmount: invoices.paidAmount,
      returnedTotal: invoices.returnedTotal,
    })
    .from(invoices)
    .where(
      inArray(
        invoices.id,
        rows.map((row) => Number(row.invoiceId)),
      ),
    );
  const numbers = new Map(
    invoiceRows.map((row) => [Number(row.id), row.invoiceNumber]),
  );
  const remaining = new Map(
    invoiceRows.map((row) => {
      const amount = round2(
        money(row.total)
          .minus(money(row.returnedTotal ?? "0"))
          .minus(money(row.paidAmount ?? "0")),
      );
      return [
        Number(row.id),
        toDbMoney(amount.lt(0) ? money(0) : amount),
      ] as const;
    }),
  );
  const members = rows.map((row) => ({
    ...row,
    invoiceNumber: numbers.get(Number(row.invoiceId)) ?? "",
    invoiceRemaining: remaining.get(Number(row.invoiceId)) ?? "0.00",
  }));
  return {
    leaderConsignmentId,
    consignmentNumber: leader.consignmentNumber,
    memberCount: members.length,
    remainingAmount: toDbMoney(
      round2(
        members.reduce(
          (sum, row) => sum.plus(money(row.invoiceRemaining)),
          money(0),
        ),
      ),
    ),
    codAmount: toDbMoney(
      round2(
        members.reduce((sum, row) => sum.plus(money(row.codAmount)), money(0)),
      ),
    ),
    deliveryFee: toDbMoney(
      round2(
        members.reduce(
          (sum, row) => sum.plus(money(row.deliveryFee)),
          money(0),
        ),
      ),
    ),
    members,
  };
}

export async function getShipmentDetails(
  consignmentId: number,
  actor: DeliveryTxActor,
) {
  return withTx((tx) => shipmentDetailsTx(tx, consignmentId, actor), {
    gate: "NONE",
  });
}

/** Registered identity wins; an anonymous invoice must have a valid Iraqi mobile. */
function sameRecipient(
  anchor: typeof invoices.$inferSelect,
  invoice: typeof invoices.$inferSelect,
) {
  if (anchor.customerId != null)
    return (
      invoice.customerId != null &&
      Number(anchor.customerId) === Number(invoice.customerId)
    );
  const phone = canonicalIraqiMobile(anchor.contactPhone);
  return (
    invoice.customerId == null &&
    phone != null &&
    canonicalIraqiMobile(invoice.contactPhone) === phone
  );
}

export interface DispatchInvoiceShipmentInput extends DispatchInvoiceInput {
  invoiceIds: number[];
}

export async function dispatchInvoiceShipment(
  input: DispatchInvoiceShipmentInput,
  actor: DeliveryTxActor,
) {
  const ids = [...input.invoiceIds].sort((a, b) => a - b);
  if (
    ids.length < 2 ||
    ids.length > MAX_SHIPMENT_INVOICES ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    !ids.includes(input.invoiceId)
  ) {
    shipmentError(
      "تعذر إسناد الشحنة",
      "اختر من فاتورتين إلى 30 فاتورة مختلفة، متضمنة الفاتورة المفتوحة",
      "راجع الفواتير المختارة ثم أعد الإسناد",
    );
  }
  if (!input.clientRequestId?.trim())
    shipmentError(
      "تعذر إسناد الشحنة",
      "معرف العملية مفقود",
      "أعد فتح نافذة التوصيل ثم احفظ الشحنة",
    );
  if (input.onlineOrderId != null)
    shipmentError(
      "تعذر إسناد الشحنة",
      "طلبات المتجر الإلكتروني لها مسار توصيل مستقل",
      "أسند طلب المتجر من شاشة طلبات المتجر",
    );
  const hash = idempotencyHash({
    invoiceId: input.invoiceId,
    invoiceIds: ids,
    partyId: input.partyId,
    deliveryFee:
      input.deliveryFee == null
        ? null
        : toDbMoney(round2(money(input.deliveryFee))),
    feeCollection: input.feeCollection ?? "COURIER",
    recipientName: input.recipientName ?? null,
    recipientPhone: input.recipientPhone ?? null,
    deliveryAddress: input.deliveryAddress ?? null,
    governorate: input.governorate ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    assignedUserId: input.assignedUserId ?? null,
    externalTrackingRef: normalizeExternalTrackingRef(
      input.externalTrackingRef,
    ),
    notes: input.notes ?? null,
    partialDispatchConfirmed: input.partialDispatchConfirmed === true,
  });
  return withTx(async (tx) => {
    const party = (
      await tx
        .select()
        .from(deliveryParties)
        .where(eq(deliveryParties.id, input.partyId))
        .for("update")
        .limit(1)
    )[0];
    if (!party)
      shipmentError(
        "تعذر إسناد الشحنة",
        "جهة التوصيل غير موجودة أو معطلة",
        "اختر جهة توصيل نشطة",
      );
    // Current reads after the party lock avoid stale replay snapshots under InnoDB REPEATABLE READ.
    // Scope is still enforced before revealing a previously committed shipment.
    const lockedInvoices = await tx
      .select()
      .from(invoices)
      .where(inArray(invoices.id, ids))
      .orderBy(asc(invoices.id))
      .for("update");
    for (const row of lockedInvoices) assertBranch(Number(row.branchId), actor);
    if (lockedInvoices.length !== ids.length)
      shipmentError(
        "تعذر إسناد الشحنة",
        "إحدى الفواتير غير موجودة",
        "حدّث القائمة وأعد اختيار الفواتير",
        "NOT_FOUND",
      );
    if (new Set(lockedInvoices.map((row) => Number(row.branchId))).size !== 1)
      shipmentError(
        "تعذر إسناد الشحنة",
        "الفواتير تخص أكثر من فرع",
        "اجمع فواتير الفرع الواحد في شحنة مستقلة",
      );
    const replay = await checkIdempotency(
      tx,
      SHIPMENT_OPERATION,
      input.clientRequestId,
      hash,
      { forUpdate: true },
    );
    if (replay != null)
      return {
        ...(await shipmentDetailsTx(tx, replay, actor)),
        consignmentId: replay,
        invoiceId: ids[0],
        idempotentReplay: true,
      };
    if (!party.isActive)
      shipmentError(
        "تعذر إسناد الشحنة",
        "جهة التوصيل معطلة",
        "اختر جهة توصيل نشطة",
      );
    const anchor = lockedInvoices[0];
    for (const invoice of lockedInvoices) {
      assertBranch(Number(invoice.branchId), actor);
      if (
        Number(invoice.branchId) !== Number(anchor.branchId) ||
        !sameRecipient(anchor, invoice)
      ) {
        shipmentError(
          "تعذر إسناد الشحنة",
          "الفواتير لا تخص العميل نفسه والفرع نفسه، أو لا يوجد هاتف موحد للزبون العابر",
          "اختر فواتير عميل واحد أو صحّح هاتف المستلم على الفواتير",
        );
      }
    }
    const existing = await tx
      .select()
      .from(deliveryConsignments)
      .where(inArray(deliveryConsignments.invoiceId, ids))
      .orderBy(asc(deliveryConsignments.id))
      .for("update");
    const memberships = existing.length
      ? await tx
          .select()
          .from(deliveryShipmentMembers)
          .where(
            inArray(
              deliveryShipmentMembers.consignmentId,
              existing.map((row) => Number(row.id)),
            ),
          )
          .for("update")
      : [];
    let leaderId: number | undefined;
    if (memberships.length) {
      leaderId = Number(memberships[0].leaderConsignmentId);
      const oldMembers = await loadShipmentMembersTx(tx, leaderId);
      const oldInvoiceIds = oldMembers
        .map((row) => Number(row.invoiceId))
        .sort((a, b) => a - b);
      if (
        memberships.length !== ids.length ||
        oldInvoiceIds.join(",") !== ids.join(",") ||
        memberships.some((row) => Number(row.leaderConsignmentId) !== leaderId)
      ) {
        shipmentError(
          "تعذر تغيير فواتير الشحنة",
          "بعض الفواتير مرتبطة بشحنة قائمة ذات أعضاء مختلفين",
          "أعد إسناد الشحنة الأصلية بجميع فواتيرها",
          "PRECONDITION_FAILED",
        );
      }
      if (
        Number(
          oldMembers.find((row) => Number(row.invoiceId) === ids[0])?.id,
        ) !== leaderId
      )
        shipmentError(
          "تعذر إسناد الشحنة",
          "قائد الشحنة لا يطابق الفاتورة الأولى",
          "راجع تفاصيل الشحنة مع المدير",
          "PRECONDITION_FAILED",
        );
    }
    const dispatched: Awaited<ReturnType<typeof dispatchInvoiceInTx>>[] = [];
    for (const invoiceId of ids) {
      const isLeader = invoiceId === ids[0];
      const row = await dispatchInvoiceInTx(
        tx,
        {
          ...input,
          invoiceId,
          clientRequestId: null,
          ...(isLeader
            ? {}
            : {
                deliveryFee: "0.00",
                feeCollection: "COURIER" as const,
                externalTrackingRef: null,
              }),
        },
        actor,
        leaderId == null
          ? undefined
          : {
              shipmentLeaderConsignmentId: leaderId,
              ...(isLeader ? {} : { sharedTrackingLeaderId: leaderId }),
            },
      );
      leaderId ??= row.consignmentId;
      if (!memberships.length)
        await tx.insert(deliveryShipmentMembers).values({
          consignmentId: row.consignmentId,
          leaderConsignmentId: leaderId,
          createdBy: actor.userId,
        });
      dispatched.push(row);
    }
    const details = await shipmentDetailsTx(tx, leaderId!, actor);
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(anchor.branchId),
      action: "delivery.dispatchInvoiceShipment",
      entityType: "deliveryShipment",
      entityId: String(leaderId),
      newValue: {
        invoiceIds: ids,
        consignmentIds: dispatched.map((row) => row.consignmentId),
        partyId: input.partyId,
        codAmount: details.codAmount,
        deliveryFee: details.deliveryFee,
        notes: input.notes ?? null,
      },
    });
    await recordIdempotencyKey(
      tx,
      SHIPMENT_OPERATION,
      input.clientRequestId!,
      leaderId!,
      hash,
    );
    for (const row of dispatched)
      enqueuePostCommit(tx, () => {
        publishRealtimeEvent(
          REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED,
          {
            deliveryId: row.consignmentId,
            invoiceId: row.invoiceId,
            trackingNumber: row.consignmentNumber,
            driverId: input.assignedUserId ?? input.partyId,
            branchId: Number(anchor.branchId),
          },
          { branchId: Number(anchor.branchId) },
        );
      });
    return {
      ...details,
      consignmentId: leaderId!,
      invoiceId: ids[0],
      idempotentReplay: false,
    };
  });
}

export async function listShipmentInvoiceCandidates(
  invoiceId: number,
  actor: DeliveryTxActor,
) {
  const db = requireDb();
  const anchor = (
    await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1)
  )[0];
  if (!anchor)
    shipmentError(
      "تعذر اختيار فواتير الشحنة",
      "الفاتورة غير موجودة",
      "حدّث قائمة الفواتير",
      "NOT_FOUND",
    );
  assertBranch(Number(anchor.branchId), actor);
  const selection = {
    id: invoices.id,
    invoiceId: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
    total: invoices.total,
    paidAmount: invoices.paidAmount,
    returnedTotal: invoices.returnedTotal,
    status: invoices.status,
    customerId: invoices.customerId,
    customerName: sql<
      string | null
    >`COALESCE(${customers.name}, ${invoices.contactName})`,
    customerPhone: sql<
      string | null
    >`COALESCE(${customers.phone}, ${invoices.contactPhone})`,
  };
  const anchorRow = (
    await db
      .select(selection)
      .from(invoices)
      .leftJoin(customers, eq(customers.id, invoices.customerId))
      .where(eq(invoices.id, invoiceId))
      .limit(1)
  )[0]!;
  const membership = (
    await db
      .select({ leaderId: deliveryShipmentMembers.leaderConsignmentId })
      .from(deliveryConsignments)
      .innerJoin(
        deliveryShipmentMembers,
        eq(deliveryShipmentMembers.consignmentId, deliveryConsignments.id),
      )
      .where(eq(deliveryConsignments.invoiceId, invoiceId))
      .limit(1)
  )[0];
  if (membership) {
    const original = await db
      .select({
        invoice: selection,
        cn: {
          branchId: deliveryConsignments.branchId,
          partyId: deliveryConsignments.partyId,
          status: deliveryConsignments.status,
          parcelStatus: deliveryConsignments.parcelStatus,
          moneyStatus: deliveryConsignments.moneyStatus,
        },
      })
      .from(deliveryShipmentMembers)
      .innerJoin(
        deliveryConsignments,
        eq(deliveryConsignments.id, deliveryShipmentMembers.consignmentId),
      )
      .innerJoin(invoices, eq(invoices.id, deliveryConsignments.invoiceId))
      .leftJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        eq(
          deliveryShipmentMembers.leaderConsignmentId,
          Number(membership.leaderId),
        ),
      )
      .orderBy(asc(invoices.id));
    for (const row of original) assertBranch(Number(row.cn.branchId), actor);
    if (
      original.some(
        (row) => Number(row.cn.branchId) !== Number(anchor.branchId),
      )
    )
      shipmentError(
        "تعذر فتح فواتير الشحنة",
        "روابط الشحنة تتضمن أكثر من فرع",
        "اطلب من المدير مراجعة روابط الشحنة",
        "PRECONDITION_FAILED",
      );
    const cancelled =
      original.length >= 2 &&
      original.every(
        (row) =>
          row.cn.status === "CANCELLED" &&
          row.cn.parcelStatus === "CANCELLED" &&
          row.cn.moneyStatus === "CANCELLED",
      );
    return {
      anchor: anchorRow,
      candidates: cancelled
        ? original
            .filter((row) => Number(row.invoice.id) !== invoiceId)
            .map((row) => row.invoice)
        : [],
      requiredInvoiceIds: cancelled
        ? original.map((row) => Number(row.invoice.id))
        : [],
    };
  }
  const phone = canonicalIraqiMobile(anchor.contactPhone);
  const identity =
    anchor.customerId != null
      ? eq(invoices.customerId, Number(anchor.customerId))
      : phone
        ? and(
            isNull(invoices.customerId),
            sql`${deliverySearchSql(phone, { phones: [invoices.contactPhone] }).score} >= 800`,
          )
        : sql`FALSE`;
  const rows = await db
    .select(selection)
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(
      deliveryConsignments,
      eq(deliveryConsignments.invoiceId, invoices.id),
    )
    .leftJoin(
      deliveryShipmentMembers,
      eq(deliveryShipmentMembers.consignmentId, deliveryConsignments.id),
    )
    .where(
      and(
        eq(invoices.branchId, Number(anchor.branchId)),
        ne(invoices.id, invoiceId),
        identity,
        notInArray(invoices.status, [...DEAD_INVOICE_STATUSES]),
        ne(invoices.sourceType, "ONLINE"),
        sql`CAST(${invoices.total} AS DECIMAL(15,2)) - CAST(COALESCE(${invoices.returnedTotal}, 0) AS DECIMAL(15,2)) - CAST(${invoices.paidAmount} AS DECIMAL(15,2)) >= 0`,
        isNull(deliveryShipmentMembers.consignmentId),
        or(
          isNull(deliveryConsignments.id),
          and(
            eq(deliveryConsignments.status, "CANCELLED"),
            eq(deliveryConsignments.parcelStatus, "CANCELLED"),
            eq(deliveryConsignments.moneyStatus, "CANCELLED"),
            isNull(deliveryConsignments.remittanceId),
            sql`${deliveryConsignments.collectedAmount} = 0`,
          ),
        ),
      ),
    )
    .orderBy(desc(invoices.id))
    .limit(MAX_SHIPMENT_INVOICES - 1);
  return {
    anchor: anchorRow,
    candidates: rows,
    requiredInvoiceIds: [] as number[],
  };
}
