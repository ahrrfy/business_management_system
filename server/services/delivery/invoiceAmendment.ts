import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, eq, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryLedgerEntries,
  deliveryParties,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { adjustDeliveryBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";
import { deliveryCustodyReturnIntent } from "./posting";
import { allocateCorrectionRefunds } from "../sale/correctionReceiptSettlement";
import {
  createPostingIntent,
  signedPostingLines,
} from "../accounting/postingEngine";

/** Caller holds source → party → consignment locks before the invoice lock. */
export async function invoiceDeliveryAmendmentTx(tx: Tx, invoiceId: number) {
  const cn = (
    await tx
      .select()
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.invoiceId, invoiceId))
      .for("update")
      .limit(1)
  )[0];
  if (!cn) return null;
  const rows = await tx
    .select({
      type: deliveryLedgerEntries.entryType,
      amount: deliveryLedgerEntries.amount,
    })
    .from(deliveryLedgerEntries)
    .where(eq(deliveryLedgerEntries.consignmentId, Number(cn.id)))
    .for("update");
  const sum = (...types: string[]) =>
    round2(
      rows.reduce(
        (total, row) =>
          types.includes(row.type) ? total.plus(money(row.amount)) : total,
        money(0),
      ),
    );
  const grossSettled = round2(
    sum("COD_COLLECTED", "SHORTFALL_ASSIGNED").minus(
      sum("COD_RETURNED", "SHORTFALL_SETTLED"),
    ),
  );
  const rawCustody = round2(
    grossSettled.minus(sum("COD_REMITTED", "COD_WRITTEN_OFF")),
  );
  const outstanding = round2(
    sum("COD_ASSIGNED").minus(
      sum("COD_COLLECTED", "SHORTFALL_ASSIGNED", "COD_RELEASED"),
    ),
  );
  if (
    rawCustody.lt(0) ||
    outstanding.lt(0) ||
    money(cn.collectedAmount ?? "0").gt(sum("COD_COLLECTED", "COD_REMITTED"))
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `تعذر تعديل أو إلغاء الفاتورة المرتبطة بالإرسالية ${cn.consignmentNumber}`,
        why: "تحصيل الإرسالية أو عهدتها لا يطابق دفتر التوصيل المثبت",
        doThis:
          "راجع مطابقة جهة التوصيل وأصلح اختلاف المستندات ثم أعد العملية؛ لم يتغير المال أو المخزون",
      }),
    });
  }
  const custody = round2(Decimal.max(0, rawCustody));
  const invoice = (
    await tx
      .select({ customerId: invoices.customerId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1)
  )[0];
  const materializedReceipts = await tx
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.invoiceId, invoiceId),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.approvalStatus, "APPROVED"),
        sql`(${receipts.internalNote} IS NULL OR ${receipts.internalNote} NOT LIKE 'SALE_CORRECTION_REVERSAL:%')`,
        sql`NOT EXISTS (SELECT 1 FROM accountingEntries ae WHERE ae.receiptId=${receipts.id} AND ae.entryType='DELIVERY_FEE_HELD')`,
      ),
    )
    .for("update");
  const allocation = allocateCorrectionRefunds(materializedReceipts.filter(row => row.direction === "IN"),
    materializedReceipts.filter(row => row.direction === "OUT"), grossSettled);
  return {
    cn,
    customerId: invoice?.customerId == null ? null : Number(invoice.customerId),
    grossSettled,
    settled: round2(grossSettled.minus(allocation.courierRefundAmount)),
    custody,
    shortfall: round2(
      Decimal.min(
        custody,
        Decimal.max(
          0,
          sum("SHORTFALL_ASSIGNED").minus(sum("SHORTFALL_SETTLED")),
        ),
      ),
    ),
    outstanding,
  };
}
export type InvoiceDeliveryAmendment = NonNullable<
  Awaited<ReturnType<typeof invoiceDeliveryAmendmentTx>>
>;

/** Only proven custody is reversed; no drawer money or receipt is created. */
export async function reverseInvoiceDeliveryExcessTx(
  tx: Tx,
  state: InvoiceDeliveryAmendment,
  amount: Decimal,
  actor: Actor,
  key: string,
): Promise<Decimal> {
  const reversed = round2(Decimal.min(Decimal.max(0, amount), state.custody));
  if (reversed.isZero()) return reversed;
  const party = (
    await tx
      .select({ balance: deliveryParties.currentBalance })
      .from(deliveryParties)
      .where(eq(deliveryParties.id, Number(state.cn.partyId)))
      .for("update")
      .limit(1)
  )[0];
  if (!party || money(party.balance ?? "0").lt(reversed)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذر عكس عهدة التوصيل المرتبطة بالفاتورة",
        why: "رصيد الجهة المخزن أقل من العهدة المثبتة في دفتر الإرسالية",
        doThis:
          "نفذ مطابقة رصيد جهة التوصيل ثم أعد التصحيح أو الإلغاء؛ لم يخرج أي نقد",
      }),
    });
  }
  const shortfall = round2(Decimal.min(reversed, state.shortfall));
  const cash = round2(reversed.minus(shortfall));
  for (const [entryType, value] of [
    ["SHORTFALL_SETTLED", shortfall],
    ["COD_RETURNED", cash],
  ] as const) {
    if (value.lte(0)) continue;
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${state.cn.id}:${entryType}:AMEND:${key}`,
      consignmentId: Number(state.cn.id),
      partyId: Number(state.cn.partyId),
      branchId: Number(state.cn.branchId),
      entryType,
      amount: toDbMoney(value),
      actorUserId: actor.userId,
      notes: "تسوية الجزء الزائد بعكس الفاتورة دون نقد من الدرج",
    });
  }
  await adjustDeliveryBalance(tx, Number(state.cn.partyId), reversed.neg());
  await postEntry(tx, {
    entryType: "DELIVERY_REMIT",
    dedupeKey: `INVOICE_AMEND_CUSTODY:${state.cn.id}:${key.slice(0, 32)}`,
    branchId: Number(state.cn.branchId),
    invoiceId: Number(state.cn.invoiceId),
    customerId: state.customerId,
    createdBy: actor.userId,
    deliveryPartyId: Number(state.cn.partyId),
    amount: reversed,
    postingIntent: deliveryCustodyReturnIntent(reversed),
    postingSourceComponents: {
      roleDebits: { AR: reversed },
      roleCredits: { DELIVERY_FLOAT: reversed },
    },
    notes: "عكس عهدة التوصيل الزائدة عند تصحيح أو إلغاء الفاتورة",
  });
  state.custody = round2(state.custody.minus(reversed));
  state.settled = round2(state.settled.minus(reversed));
  state.shortfall = round2(state.shortfall.minus(shortfall));
  return reversed;
}

/** Rebind the original parcel, ledger and remittance allocations to the replacement. */
export async function rebindCorrectedInvoiceDeliveryTx(
  tx: Tx,
  state: InvoiceDeliveryAmendment,
  invoiceId: number,
  actor: Actor,
  key: string,
  retainedRefundIds: number[] = [],
) {
  const invoice = (
    await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1)
  )[0];
  const remaining = round2(
    Decimal.max(0, money(invoice.total).minus(money(invoice.paidAmount))),
  );
  if (
    state.settled.gt(0) &&
    Number(state.customerId ?? 0) !== Number(invoice.customerId ?? 0)
  ) {
    for (const [suffix, customerId, signed] of [
      ["FROM", state.customerId, state.settled],
      ["TO", invoice.customerId, state.settled.neg()],
    ] as const) {
      // Source-typed noncash reclassification; the bridge cancels in this tx.
      // Both original collection and its customer remain immutable evidence.
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(state.cn.branchId),
        invoiceId: suffix === "FROM" ? Number(state.cn.invoiceId) : invoiceId,
        customerId,
        amount: signed,
        createdBy: actor.userId,
        dedupeKey: `INVOICE_CORRECTION_CUSTOMER_RECLASS:${state.cn.invoiceId}:${invoiceId}:${suffix}`,
        notes: `نقل نسبة تحصيل التوصيل من الفاتورة ${state.cn.invoiceId} إلى ${invoice.invoiceNumber} بالتصحيح الموثق`,
        postingIntent: createPostingIntent(
          "ADJUST_AR",
          "ADJUST",
          signedPostingLines("AR", "OPENING_EQUITY", signed),
        ),
      });
    }
  }
  const targetExposure = state.cn.status === "CANCELLED" ? money(0) : remaining;
  const delta = round2(targetExposure.minus(state.outstanding));
  if (!delta.isZero()) {
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${state.cn.id}:COD_AMENDED:${key}`,
      consignmentId: Number(state.cn.id),
      partyId: Number(state.cn.partyId),
      branchId: Number(state.cn.branchId),
      entryType: delta.gt(0) ? "COD_ASSIGNED" : "COD_RELEASED",
      amount: toDbMoney(delta.abs()),
      actorUserId: actor.userId,
      notes: `تعديل تعرّض التوصيل للفاتورة البديلة ${invoice.invoiceNumber}`,
    });
  }
  // collectedAmount is remitted gross, not the cash proved at delivery. Historical
  // remittances and counter payments remain intact; only the live obligation changes.
  const cod = round2(
    money(state.cn.collectedAmount ?? "0")
      .plus(money(state.cn.counterSettledAmount ?? "0"))
      .plus(state.custody)
      .plus(targetExposure),
  );
  await tx
    .update(deliveryConsignments)
    .set({
      invoiceId,
      ...(state.cn.sourceType === "INVOICE" ? { sourceId: invoiceId } : {}),
      endCustomerId: invoice.customerId,
      codAmount: toDbMoney(cod),
      ...(state.cn.status === "CANCELLED"
        ? {}
        : {
            ...(state.cn.status === "DELIVERED" && remaining.gt(0)
              ? { status: "PARTIAL" as const, settledAt: null }
              : {}),
            moneyStatus: state.custody.gt(0)
              ? ("UNSETTLED" as const)
              : remaining.gt(0)
                ? ("UNSETTLED" as const)
                : ("SETTLED" as const),
          }),
    })
    .where(eq(deliveryConsignments.id, Number(state.cn.id)));
  // Keep prior actual refunds in the same paid pool as the carried collection.
  // Compensation receipts remain on their originals to balance the original IN.
  await tx
    .update(receipts)
    .set({ invoiceId })
    .where(
      and(
        eq(receipts.invoiceId, Number(state.cn.invoiceId)),
        eq(receipts.direction, "OUT"),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.approvalStatus, "APPROVED"),
      retainedRefundIds.length ? sql`${receipts.id} NOT IN (${sql.join(retainedRefundIds.map(id => sql`${id}`), sql`, `)})` : undefined,
        sql`(${receipts.internalNote} IS NULL OR ${receipts.internalNote} NOT LIKE 'SALE_CORRECTION_REVERSAL:%')`,
        sql`NOT EXISTS (SELECT 1 FROM accountingEntries ae WHERE ae.receiptId=${receipts.id} AND ae.entryType='DELIVERY_FEE_HELD')`,
      ),
    );
  await appendDeliveryEvent(tx, {
    eventKey: `CN:${state.cn.id}:INVOICE_CORRECTED:${key}`,
    consignmentId: Number(state.cn.id),
    eventType: "RETURN_SETTLEMENT",
    actorUserId: actor.userId,
    payload: {
      source: "INVOICE_CORRECTION",
      originalInvoiceId: state.cn.invoiceId,
      invoiceId,
      remaining: toDbMoney(remaining),
      custody: toDbMoney(state.custody),
    },
  });
}

/** Cancels the document and its live responsibility under the same locks. */
export async function cancelInvoiceDeliveryTx(
  tx: Tx,
  state: InvoiceDeliveryAmendment,
  actor: Actor,
  key: string,
  reason: string,
) {
  const reversedCustody = await reverseInvoiceDeliveryExcessTx(
    tx,
    state,
    state.custody,
    actor,
    key,
  );
  if (state.outstanding.gt(0)) {
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${state.cn.id}:COD_RELEASED:INVOICE_CANCEL:${key}`,
      consignmentId: Number(state.cn.id),
      partyId: Number(state.cn.partyId),
      branchId: Number(state.cn.branchId),
      entryType: "COD_RELEASED",
      amount: toDbMoney(state.outstanding),
      actorUserId: actor.userId,
      notes: reason,
    });
  }
  await tx
    .update(deliveryConsignments)
    .set({
      status: "CANCELLED",
      parcelStatus: "CANCELLED",
      moneyStatus: "CANCELLED",
      assignedUserId: null,
      cancelledAt: new Date(),
      cancelledBy: actor.userId,
      cancellationReason: reason,
      settledAt: new Date(),
      counterSettledAmount: toDbMoney(
        money(state.cn.counterSettledAmount ?? "0").plus(
          Decimal.max(0, state.outstanding),
        ),
      ),
    })
    .where(eq(deliveryConsignments.id, Number(state.cn.id)));
  await appendDeliveryEvent(tx, {
    eventKey: `CN:${state.cn.id}:INVOICE_CANCELLED:${key}`,
    consignmentId: Number(state.cn.id),
    eventType: "ASSIGNMENT_CANCELLED",
    actorUserId: actor.userId,
    fromParcelStatus: state.cn.parcelStatus,
    toParcelStatus: "CANCELLED",
    fromMoneyStatus: state.cn.moneyStatus,
    toMoneyStatus: "CANCELLED",
    payload: {
      invoiceId: state.cn.invoiceId,
      reason,
      reversedCustody: toDbMoney(reversedCustody),
    },
  });
  if (reversedCustody.gt(0)) {
    await tx
      .update(invoices)
      .set({
        paidAmount: sql`GREATEST(${invoices.paidAmount} - ${toDbMoney(reversedCustody)}, 0)`,
      })
      .where(eq(invoices.id, Number(state.cn.invoiceId)));
  }
  return reversedCustody;
}
