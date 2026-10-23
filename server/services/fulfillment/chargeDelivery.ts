import Decimal from "decimal.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryEvents,
  deliveryLedgerEntries,
  deliveryParties,
  deliveryShipmentMembers,
  invoices,
} from "../../../drizzle/schema";
import {
  fulfillmentCharges,
  fulfillmentChargePayments,
} from "../../../drizzle/fulfillmentSchema";
import type { Tx } from "../../db";
import type { Actor } from "../tx";
import { money, toDbMoney } from "../money";
import {
  postEntry,
  adjustCustomerBalance,
  adjustDeliveryBalance,
  computeInvoiceStatus,
} from "../ledgerService";
import {
  createPostingIntent,
  debitLine,
  creditLine,
} from "../accounting/postingEngine";
import {
  deliveryCustomerCollectionIntent,
  deliveryDispatchMemoIntent,
} from "../delivery/posting";
import {
  appendDeliveryEvent,
  appendDeliveryLedgerEntry,
} from "../delivery/lifecycle";
import {
  assertFulfillmentBranch,
  fulfillmentError,
  fulfillmentFingerprint,
  loadFulfillmentRequestTx,
} from "./core";
import { chargeCustodyIntent } from "./chargePosting";
import { assertFloatLimitTx } from "../delivery/parties";

function chargeIds(payload: unknown): number[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("chargeIds" in payload) ||
    !Array.isArray(payload.chargeIds)
  )
    return [];
  return payload.chargeIds.filter(
    (id): id is number =>
      typeof id === "number" && Number.isSafeInteger(id) && id > 0,
  );
}
export async function loadAssignedChargeClaimsTx(
  tx: Tx,
  consignmentId: number,
) {
  const [event] = await tx
    .select()
    .from(deliveryEvents)
    .where(
      and(
        eq(deliveryEvents.consignmentId, consignmentId),
        eq(deliveryEvents.eventType, "FULFILLMENT_CHARGES_ASSIGNED"),
      ),
    )
    .for("share")
    .limit(1);
  const ids = chargeIds(event?.payload);
  const rows = ids.length
    ? await tx
        .select()
        .from(fulfillmentCharges)
        .where(inArray(fulfillmentCharges.id, ids))
        .orderBy(asc(fulfillmentCharges.id))
        .for("update")
    : [];
  if (rows.length !== ids.length)
    throw fulfillmentError(
      "إحدى مطالبات أجر الإرسالية مفقودة؛ لم ينفذ التحصيل",
    );
  return {
    event,
    rows,
    remaining: rows.reduce(
      (s, r) =>
        s.plus(
          r.status === "APPROVED"
            ? Decimal.max(0, money(r.amount).minus(r.paidAmount))
            : money(0),
        ),
      money(0),
    ),
  };
}
/** Assignment contains source IDs only; the financial amount remains in CN/ledger columns. */
export async function attachFulfillmentRequestClaimsTx(
  tx: Tx,
  input: {
    requestId: number;
    consignmentId: number;
    partyId: number;
    branchId: number;
    clientRequestId: string;
  },
  actor: Actor,
): Promise<{ chargeCodAmount: string }> {
  const request = await loadFulfillmentRequestTx(tx, input.requestId, actor, {
    lock: true,
  });
  if (request.branchId !== input.branchId)
    throw fulfillmentError("فرع طلب التوصيل لا يطابق إسناد الأجور");
  const eventKey = `FULFILLMENT_CHARGES_ASSIGNED:${request.id}`;
  const [prior] = await tx
    .select()
    .from(deliveryEvents)
    .where(eq(deliveryEvents.eventKey, eventKey))
    .for("update")
    .limit(1);
  if (prior) {
    const [ledger] = await tx
      .select({ amount: deliveryLedgerEntries.amount })
      .from(deliveryLedgerEntries)
      .where(eq(deliveryLedgerEntries.eventKey, eventKey))
      .limit(1);
    return {
      chargeCodAmount:
        prior.consignmentId === input.consignmentId
          ? (ledger?.amount ?? "0.00")
          : "0.00",
    };
  }
  const [cn] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, input.consignmentId))
    .for("update")
    .limit(1);
  if (
    !cn ||
    cn.branchId !== input.branchId ||
    cn.partyId !== input.partyId ||
    !["DISPATCHED", "PARTIAL"].includes(cn.status)
  )
    throw fulfillmentError(
      "إرسالية إسناد الأجور غير صالحة أو تتبع فرعاً أو جهة أخرى",
    );
  const rows = await tx
    .select()
    .from(fulfillmentCharges)
    .where(
      and(
        eq(fulfillmentCharges.requestId, input.requestId),
        eq(fulfillmentCharges.status, "APPROVED"),
      ),
    )
    .orderBy(asc(fulfillmentCharges.id))
    .for("update");
  if (
    rows.some(
      (r) =>
        r.branchId !== input.branchId || r.customerId !== request.customerId,
    )
  )
    throw fulfillmentError("مطالبات الأجور لا تطابق عميل وفرع الطلب");
  const open = rows.filter((r) => money(r.amount).gt(money(r.paidAmount))),
    total = open.reduce(
      (s, r) => s.plus(money(r.amount).minus(r.paidAmount)),
      money(0),
    );
  const [party] = await tx
    .select()
    .from(deliveryParties)
    .where(eq(deliveryParties.id, cn.partyId))
    .for("update")
    .limit(1);
  if (!party?.isActive) throw fulfillmentError("جهة التوصيل غير نشطة");
  await assertFloatLimitTx(tx, party, total);
  await tx
    .update(deliveryConsignments)
    .set({
      codAmount: toDbMoney(money(cn.codAmount).plus(total)),
      fulfillmentRequestId: request.id,
      codClaimVersion: cn.codClaimVersion + (total.gt(0) ? 1 : 0),
      ...(total.gt(0)
        ? { moneyStatus: "UNSETTLED" as const, settledAt: null }
        : {}),
    })
    .where(eq(deliveryConsignments.id, cn.id));
  const members = await tx
    .select({ invoiceId: deliveryConsignments.invoiceId })
    .from(deliveryShipmentMembers)
    .innerJoin(
      deliveryConsignments,
      eq(deliveryConsignments.id, deliveryShipmentMembers.consignmentId),
    )
    .where(eq(deliveryShipmentMembers.leaderConsignmentId, cn.id))
    .for("share");
  const invoiceIds = Array.from(
    new Set(
      [cn.invoiceId, ...members.map((m) => m.invoiceId)].filter(
        (id): id is number => id != null,
      ),
    ),
  );
  await appendDeliveryEvent(tx, {
    eventKey,
    consignmentId: cn.id,
    eventType: "FULFILLMENT_CHARGES_ASSIGNED",
    actorUserId: actor.userId,
    payload: {
      requestId: request.id,
      customerId: request.customerId,
      invoiceIds,
      chargeIds: open.map((r) => r.id),
    },
  });
  if (total.gt(0))
    await appendDeliveryLedgerEntry(tx, {
      eventKey,
      consignmentId: cn.id,
      partyId: input.partyId,
      branchId: input.branchId,
      entryType: "COD_ASSIGNED",
      amount: toDbMoney(total),
      actorUserId: actor.userId,
    });
  return { chargeCodAmount: toDbMoney(total) };
}

/** Parent owns membership, CN lock and idempotency. One actual collection, allocated to live claims. */
export async function collectAssignedConsignmentClaimsTx(
  tx: Tx,
  input: {
    consignmentId: number;
    actualAmount: string;
    eventKey: string;
    shortfallReason?: string | null;
    leaveRemainderOnCustomer?: boolean;
    supplementary?: boolean;
  },
  actor: Actor,
) {
  const [cn] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, input.consignmentId))
    .for("update")
    .limit(1);
  if (!cn) throw fulfillmentError("إرسالية التحصيل غير موجودة");
  assertFulfillmentBranch(actor, cn.branchId);
  const assigned = await loadAssignedChargeClaimsTx(tx, cn.id);
  if (!cn.fulfillmentRequestId) return null;
  const request = await loadFulfillmentRequestTx(
    tx,
    cn.fulfillmentRequestId,
    actor,
    { lock: true },
  );
  if (
    !request.customerId ||
    request.branchId !== cn.branchId ||
    (cn.endCustomerId != null && cn.endCustomerId !== request.customerId)
  )
    throw fulfillmentError("عميل وفرع الطلب لا يطابقان إرسالية التحصيل");
  if (
    assigned.rows.some(
      (r) =>
        r.branchId !== cn.branchId || r.requestId !== cn.fulfillmentRequestId,
    )
  )
    throw fulfillmentError("مصدر مطالبة الأجر لا يطابق إرسالية التحصيل");
  const [invoice] = cn.invoiceId
    ? await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, cn.invoiceId))
        .for("update")
        .limit(1)
    : [];
  if (
    invoice &&
    (["CANCELLED", "RETURNED", "SUPERSEDED"].includes(invoice.status) ||
      invoice.branchId !== cn.branchId)
  )
    throw fulfillmentError("الفاتورة الأصلية غير قابلة للتحصيل");
  const goods = invoice
    ? Decimal.max(
        0,
        money(invoice.total)
          .minus(invoice.returnedTotal)
          .minus(invoice.paidAmount),
      )
    : money(0);
  const actual = money(input.actualAmount),
    due = goods.plus(assigned.remaining);
  if (!actual.isFinite() || actual.lt(0))
    throw fulfillmentError("المقبوض الفعلي يجب أن يكون مبلغاً غير سالب");
  const shortfall = Decimal.max(0, due.minus(actual));
  if (
    shortfall.gt(0) &&
    !input.leaveRemainderOnCustomer &&
    !input.shortfallReason
  )
    throw fulfillmentError(
      "القبض الفعلي أقل من المطالبات؛ حدد سبب العجز على الجهة أو أثبته بكشف يترك المتبقي على العميل",
    );
  const settled = Decimal.min(
    due,
    actual.plus(input.shortfallReason ? shortfall : 0),
  );
  const goodsPaid = Decimal.min(goods, settled),
    chargePaid = Decimal.max(0, settled.minus(goodsPaid)),
    excess = Decimal.max(0, actual.minus(due));
  const hash = fulfillmentFingerprint({
    eventKey: input.eventKey,
    consignmentId: cn.id,
    actualAmount: input.actualAmount,
  });
  const paymentKey = `cn:${cn.id}:${hash.slice(0, 40)}`;
  const customerId = request.customerId;
  if (
    assigned.rows.some((r) => r.customerId !== customerId) ||
    (invoice && invoice.customerId !== customerId)
  )
    throw fulfillmentError("مطالبات الإرسالية لا تخص عميل الطلب الحقيقي");
  if (goodsPaid.gt(0) && invoice) {
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: cn.branchId,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      deliveryPartyId: cn.partyId,
      amount: goodsPaid,
      createdBy: actor.userId,
      dedupeKey: input.supplementary
        ? `PAYMENT_IN:COURIER_DELIVERY_SUPP:${cn.id}:${hash.slice(0, 32)}`
        : `PAYMENT_IN:COURIER_DELIVERY:${cn.id}`,
      postingIntent: deliveryCustomerCollectionIntent(goodsPaid),
      postingSourceComponents: {
        roleDebits: { DELIVERY_FLOAT: toDbMoney(goodsPaid) },
        roleCredits: { AR: toDbMoney(goodsPaid) },
      },
      notes: `تحصيل بضاعة ضمن ${cn.consignmentNumber}`,
    });
    const paid = money(invoice.paidAmount).plus(goodsPaid);
    await tx
      .update(invoices)
      .set({
        paidAmount: toDbMoney(paid),
        status: computeInvoiceStatus(
          invoice.total,
          toDbMoney(paid),
          invoice.returnedTotal,
        ),
        paymentDate: new Date(),
      })
      .where(eq(invoices.id, invoice.id));
    if (invoice.customerId)
      await adjustCustomerBalance(tx, invoice.customerId, goodsPaid.negated());
  }
  let remainingChargePaid = chargePaid;
  let actualChargePaid = Decimal.max(0, actual.minus(goodsPaid).minus(excess));
  for (const charge of assigned.rows) {
    const amount = Decimal.min(
      remainingChargePaid,
      Decimal.max(0, money(charge.amount).minus(charge.paidAmount)),
    );
    if (amount.lte(0)) continue;
    remainingChargePaid = remainingChargePaid.minus(amount);
    const actualAllocation = Decimal.min(actualChargePaid, amount);
    actualChargePaid = actualChargePaid.minus(actualAllocation);
    if (actualAllocation.gt(0))
      await tx.insert(fulfillmentChargePayments).values({
        chargeId: charge.id,
        branchId: charge.branchId,
        kind: "COURIER_COLLECTION",
        consignmentId: cn.id,
        partyId: cn.partyId,
        amount: toDbMoney(actualAllocation),
        createdBy: actor.userId,
        clientRequestId: paymentKey,
        sourceHash: hash,
      });
    await tx
      .update(fulfillmentCharges)
      .set({
        paidAmount: toDbMoney(money(charge.paidAmount).plus(amount)),
        version: charge.version + 1,
      })
      .where(eq(fulfillmentCharges.id, charge.id));
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: cn.branchId,
      customerId: charge.customerId,
      deliveryPartyId: cn.partyId,
      amount,
      createdBy: actor.userId,
      dedupeKey: `FULFILLMENT_CHARGE_CUSTODY:${cn.id}:${charge.id}:${hash.slice(0, 32)}`,
      postingIntent: chargeCustodyIntent(amount),
      postingSourceComponents: {
        roleDebits: { DELIVERY_FLOAT: toDbMoney(amount) },
        roleCredits: { AR: toDbMoney(amount) },
      },
      notes: `تحصيل أجر ${charge.id} ضمن ${cn.consignmentNumber}`,
    });
    await adjustCustomerBalance(tx, charge.customerId!, amount.negated());
  }
  if (excess.gt(0)) {
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: cn.branchId,
      customerId,
      deliveryPartyId: cn.partyId,
      amount: excess,
      createdBy: actor.userId,
      dedupeKey: `FULFILLMENT_COURIER_EXCESS:${cn.id}:${hash.slice(0, 32)}`,
      notes: `أمانة قبض زائد ضمن ${cn.consignmentNumber}`,
      postingIntent: createPostingIntent(
        "FULFILLMENT_COURIER_EXCESS",
        "PAYMENT_IN",
        [
          debitLine("DELIVERY_FLOAT", excess),
          creditLine("OTHER_LIABILITY", excess),
        ],
        {
          roleDebits: { DELIVERY_FLOAT: excess },
          roleCredits: { OTHER_LIABILITY: excess },
        },
      ),
      postingSourceComponents: {
        roleDebits: { DELIVERY_FLOAT: toDbMoney(excess) },
        roleCredits: { OTHER_LIABILITY: toDbMoney(excess) },
      },
    });
    // Keep the original claim snapshot; the extra real cash has its own remit-able exposure.
    await tx
      .update(deliveryConsignments)
      .set({
        codAmount: toDbMoney(money(cn.codAmount).plus(excess)),
        codClaimVersion: cn.codClaimVersion + 1,
      })
      .where(eq(deliveryConsignments.id, cn.id));
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${cn.id}:EXCESS_ASSIGNED:${hash.slice(0, 24)}`,
      partyId: cn.partyId,
      consignmentId: cn.id,
      branchId: cn.branchId,
      entryType: "COD_ASSIGNED",
      amount: toDbMoney(excess),
      actorUserId: actor.userId,
    });
    await appendDeliveryEvent(tx, {
      eventKey: `CN:${cn.id}:EXCESS:${hash.slice(0, 24)}`,
      consignmentId: cn.id,
      eventType: "CUSTOMER_EXCESS_HELD",
      actorUserId: actor.userId,
      payload: {
        requestId: cn.fulfillmentRequestId,
        chargeIds: assigned.rows.map((r) => r.id),
      },
    });
  }
  const partyRise = actual.plus(input.shortfallReason ? shortfall : 0);
  if (partyRise.gt(0)) {
    await adjustDeliveryBalance(tx, cn.partyId, partyRise);
    if (actual.gt(0))
      await appendDeliveryLedgerEntry(tx, {
        eventKey: input.supplementary
          ? `CN:${cn.id}:COD_COLLECTED_SUPP:${hash.slice(0, 32)}`
          : `CN:${cn.id}:COD_COLLECTED`,
        partyId: cn.partyId,
        consignmentId: cn.id,
        branchId: cn.branchId,
        entryType: "COD_COLLECTED",
        amount: toDbMoney(actual),
        actorUserId: actor.userId,
      });
    if (input.shortfallReason && shortfall.gt(0))
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `CN:${cn.id}:SHORTFALL_ASSIGNED`,
        partyId: cn.partyId,
        consignmentId: cn.id,
        branchId: cn.branchId,
        entryType: "SHORTFALL_ASSIGNED",
        amount: toDbMoney(shortfall),
        shortfallReason: input.shortfallReason,
        actorUserId: actor.userId,
      });
    await postEntry(tx, {
      entryType: "DELIVERY_DISPATCH",
      branchId: cn.branchId,
      invoiceId: cn.invoiceId,
      deliveryPartyId: cn.partyId,
      amount: partyRise,
      createdBy: actor.userId,
      dedupeKey: input.supplementary
        ? `DELIVERY_CUSTODY_SUPP:${cn.id}:${hash.slice(0, 32)}`
        : `DELIVERY_CUSTODY:${cn.id}`,
      postingIntent: deliveryDispatchMemoIntent(),
      notes: `عهدة مطالبات مصنفة ${cn.consignmentNumber}`,
    });
  }
  return {
    chargeAmount: toDbMoney(chargePaid),
    invoiceAmount: toDbMoney(goodsPaid),
    excessAmount: toDbMoney(excess),
    shortfallAmount: input.shortfallReason ? toDbMoney(shortfall) : "0.00",
  };
}

/** Reassignment restores only the original, still-open charge claims, never a new sale. */
export async function restoreFulfillmentRequestClaimsTx(
  tx: Tx,
  input: {
    requestId: number;
    consignmentId: number;
    partyId: number;
    branchId: number;
    clientRequestId: string;
  },
  actor: Actor,
): Promise<{ chargeCodAmount: string }> {
  const request = await loadFulfillmentRequestTx(tx, input.requestId, actor, {
    lock: true,
  });
  const assigned = await loadAssignedChargeClaimsTx(tx, input.consignmentId);
  if (!assigned.event)
    return attachFulfillmentRequestClaimsTx(tx, input, actor);
  const eventKey = `FULFILLMENT_CHARGES_RESTORED:${request.id}:${fulfillmentFingerprint(input.clientRequestId).slice(0, 40)}`;
  const [prior] = await tx
    .select({ amount: deliveryLedgerEntries.amount })
    .from(deliveryLedgerEntries)
    .where(eq(deliveryLedgerEntries.eventKey, eventKey))
    .limit(1);
  if (prior) return { chargeCodAmount: prior.amount };
  const [cn] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, input.consignmentId))
    .for("update")
    .limit(1);
  if (
    !cn ||
    cn.partyId !== input.partyId ||
    cn.branchId !== input.branchId ||
    request.branchId !== cn.branchId ||
    assigned.rows.some((r) => r.requestId !== request.id)
  )
    throw fulfillmentError("إعادة إسناد مطالبات الأجر لا تطابق مصدرها الأصلي");
  if (assigned.remaining.lte(0)) return { chargeCodAmount: "0.00" };
  const [party] = await tx
    .select()
    .from(deliveryParties)
    .where(eq(deliveryParties.id, cn.partyId))
    .for("update")
    .limit(1);
  if (!party?.isActive) throw fulfillmentError("جهة التوصيل غير نشطة");
  await assertFloatLimitTx(tx, party, assigned.remaining);
  await tx
    .update(deliveryConsignments)
    .set({
      codAmount: toDbMoney(money(cn.codAmount).plus(assigned.remaining)),
      codClaimVersion: cn.codClaimVersion + 1,
      moneyStatus: "UNSETTLED",
      settledAt: null,
    })
    .where(eq(deliveryConsignments.id, cn.id));
  await appendDeliveryLedgerEntry(tx, {
    eventKey,
    consignmentId: cn.id,
    partyId: cn.partyId,
    branchId: cn.branchId,
    entryType: "COD_ASSIGNED",
    amount: toDbMoney(assigned.remaining),
    actorUserId: actor.userId,
  });
  await appendDeliveryEvent(tx, {
    eventKey,
    consignmentId: cn.id,
    eventType: "COD_CLAIM_CHANGED",
    actorUserId: actor.userId,
    payload: {
      requestId: request.id,
      chargeIds: assigned.rows.map((r) => r.id),
      claimVersion: cn.codClaimVersion + 1,
      ackRequired: true,
    },
  });
  return { chargeCodAmount: toDbMoney(assigned.remaining) };
}

/** Allocate actual remitted cash to its original custody rows. No AR or party mutation here. */
export async function recordAssignedChargeRemittanceTx(
  tx: Tx,
  input: {
    consignmentId: number;
    receiptId: number;
    amount: string;
    eventKey: string;
  },
  actor: Actor,
) {
  const collections = await tx
    .select()
    .from(fulfillmentChargePayments)
    .where(
      and(
        eq(fulfillmentChargePayments.consignmentId, input.consignmentId),
        eq(fulfillmentChargePayments.kind, "COURIER_COLLECTION"),
      ),
    )
    .orderBy(asc(fulfillmentChargePayments.id))
    .for("update");
  if (!collections.length) return { allocatedAmount: "0.00" };
  const sourceHash = fulfillmentFingerprint(input),
    key = `rm:${sourceHash.slice(0, 48)}`;
  const previous = await tx
    .select()
    .from(fulfillmentChargePayments)
    .where(
      and(
        eq(fulfillmentChargePayments.consignmentId, input.consignmentId),
        eq(fulfillmentChargePayments.kind, "COURIER_REMITTANCE"),
      ),
    );
  let left = money(input.amount),
    allocated = money(0);
  for (const chargeId of Array.from(
    new Set(collections.map((p) => p.chargeId)),
  )) {
    const originals = collections.filter((p) => p.chargeId === chargeId),
      original = originals[0];
    const used = previous
      .filter((p) => p.chargeId === chargeId)
      .reduce((s, p) => s.plus(money(p.amount)), money(0));
    const amount = Decimal.min(
      left,
      Decimal.max(
        0,
        originals
          .reduce((s, p) => s.plus(money(p.amount)), money(0))
          .minus(used),
      ),
    );
    if (amount.lte(0)) continue;
    left = left.minus(amount);
    allocated = allocated.plus(amount);
    await tx.insert(fulfillmentChargePayments).values({
      chargeId: original.chargeId,
      branchId: original.branchId,
      kind: "COURIER_REMITTANCE",
      originalPaymentId: originals.length === 1 ? original.id : null,
      partyId: original.partyId,
      consignmentId: original.consignmentId,
      receiptId: input.receiptId,
      amount: toDbMoney(amount),
      createdBy: actor.userId,
      clientRequestId: key,
      sourceHash,
    });
  }
  return { allocatedAmount: toDbMoney(allocated) };
}

/** Called after the real counter receipt and allocation. Update the original live claim, request an ACK. */
export async function settleAssignedChargeAtCounterTx(
  tx: Tx,
  input: { chargeId: number; amount: string; receiptId: number },
  actor: Actor,
) {
  const [charge] = await tx
    .select({ requestId: fulfillmentCharges.requestId })
    .from(fulfillmentCharges)
    .where(eq(fulfillmentCharges.id, input.chargeId))
    .limit(1);
  if (!charge?.requestId) return;
  const [assignment] = await tx
    .select()
    .from(deliveryEvents)
    .where(
      eq(
        deliveryEvents.eventKey,
        `FULFILLMENT_CHARGES_ASSIGNED:${charge.requestId}`,
      ),
    )
    .for("share")
    .limit(1);
  if (!assignment || !chargeIds(assignment.payload).includes(input.chargeId))
    return;
  const [cn] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, assignment.consignmentId))
    .for("update")
    .limit(1);
  if (!cn || !["DISPATCHED", "PARTIAL"].includes(cn.status)) return;
  assertFulfillmentBranch(actor, cn.branchId);
  await tx
    .update(deliveryConsignments)
    .set({
      counterSettledAmount: toDbMoney(
        money(cn.counterSettledAmount).plus(input.amount),
      ),
      codClaimVersion: cn.codClaimVersion + 1,
    })
    .where(eq(deliveryConsignments.id, cn.id));
  await appendDeliveryLedgerEntry(tx, {
    eventKey: `CN:${cn.id}:CHARGE_COUNTER:${input.receiptId}:${input.chargeId}`,
    partyId: cn.partyId,
    consignmentId: cn.id,
    branchId: cn.branchId,
    entryType: "COD_RELEASED",
    amount: input.amount,
    actorUserId: actor.userId,
  });
  await appendDeliveryEvent(tx, {
    eventKey: `CN:${cn.id}:CHARGE_COUNTER:${input.receiptId}:${input.chargeId}`,
    consignmentId: cn.id,
    eventType: "COD_CLAIM_CHANGED",
    actorUserId: actor.userId,
    payload: {
      chargeId: input.chargeId,
      receiptId: input.receiptId,
      claimVersion: cn.codClaimVersion + 1,
      ackRequired: true,
    },
  });
}
