import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  auditLogs,
  deliveryConsignments,
  deliveryParties,
  deliveryShipmentMembers,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  createPostingIntent,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { assertOperationAuthorityTx } from "../authorization/operationAuthority";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { adjustCustomerBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { closeDeferredSaleRefundEffectsTx } from "../reversal/deferredRefund";
import { loadRefundCaps } from "../returns/refundCaps";
import { loadExcessFeeSourceTx } from "./excessFeeRefund";
import { reserveExternalRefundConfirmationTx } from "../externalRefundConfirmation";
import { resolveBranchCashShiftTx } from "../shiftService";
import {
  assertNonPhysicalOutReceipt,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { type Actor, withTx } from "../tx";
import { allocateVoucherToInvoiceTx } from "../voucher/invoiceAllocation";
import { paymentAccountRole } from "./posting";
import { refundHeldDeliveryFeeForReturnTx } from "./returns";
import type { DeliveryTxActor } from "./types";

type NonCashRail = "CARD" | "TRANSFER" | "WALLET" | "CHECK";
type RefundNote = {
  kind: "FEE" | "GOODS";
  consignmentId: number | null;
  invoiceId: number;
  purpose?: "CONSOLIDATION";
  sourceReceiptIds: number[];
  providerReference?: string;
};
export function deliveryRefundError(why: string) {
  return new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذّر رد مقبوضات التوصيل",
      why,
      doThis:
        "راجع إيصالات القبض والرد الأصلية وحالة الإرسالية قبل إعادة المحاولة؛ لا تنفذ استرداداً خارجياً مكرراً",
    }),
  });
}
function parseNote(raw: string | null): RefundNote | null {
  try {
    const v: unknown = JSON.parse(raw ?? "null");
    if (v && typeof v === "object" && "deliveryRefund" in v) {
      const n = v.deliveryRefund as RefundNote;
      return n &&
        (n.kind === "FEE" || n.kind === "GOODS") &&
        (Number.isInteger(n.consignmentId) ||
          (n.consignmentId === null &&
            n.purpose === "CONSOLIDATION" &&
            n.kind === "FEE")) &&
        Number.isInteger(n.invoiceId) &&
        Array.isArray(n.sourceReceiptIds)
        ? n
        : null;
    }
  } catch {}
  return null;
}
function scope(actor: DeliveryTxActor, branchId: number) {
  if (actor.role !== "admin" && actor.branchId !== branchId)
    throw deliveryRefundError("الإرسالية أو الإيصال يتبع فرعاً آخر");
}

/** Pending is a reserved refund request, never evidence that money has left. */
export async function createPendingDeliveryRefundTx(
  tx: Tx,
  input: {
    cn?: typeof deliveryConsignments.$inferSelect;
    invoiceSource?: {
      invoiceId: number;
      branchId: number;
      sourceNumber: string;
    };
    kind: "FEE" | "GOODS";
    method: NonCashRail;
    amount: string;
    sourceReceiptIds: number[];
    customerId: number | null;
  },
  actor: DeliveryTxActor,
) {
  const invoiceId = input.cn?.invoiceId ?? input.invoiceSource?.invoiceId;
  const branchId = input.cn?.branchId ?? input.invoiceSource?.branchId;
  const consignmentId = input.cn == null ? null : Number(input.cn.id);
  if (invoiceId == null || branchId == null)
    throw deliveryRefundError(
      "مصدر الإرسالية لا يحمل فاتورة؛ استخدم مسار مصدر المعالجة المخصص",
    );
  const rows = await tx
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.invoiceId, Number(invoiceId)),
        eq(receipts.direction, "OUT"),
        inArray(receipts.status, ["PENDING", "COMPLETED"]),
      ),
    )
    .for("update");
  const matching = rows.find((r) => {
    const n = parseNote(r.internalNote);
    return (
      n?.consignmentId === consignmentId &&
      n.kind === input.kind &&
      r.paymentMethod === input.method
    );
  });
  if (matching) {
    if (!money(matching.amount).eq(money(input.amount)))
      throw deliveryRefundError(
        "مبلغ طلب الاسترداد السابق يختلف عن تخصيص القبض الحالي",
      );
    return Number(matching.id);
  }
  const note: RefundNote = {
    kind: input.kind,
    consignmentId,
    ...(consignmentId == null ? { purpose: "CONSOLIDATION" as const } : {}),
    invoiceId: Number(invoiceId),
    sourceReceiptIds: input.sourceReceiptIds,
  };
  assertNonPhysicalOutReceipt({
    classification: "NON_CASH_METHOD",
    paymentMethod: input.method,
    cashBucket: null,
    approvalStatus: "PENDING_APPROVAL",
    operation: "طلب رد مقبوضات توصيل غير نقدي",
  });
  const inserted = await tx.insert(receipts).values({
    branchId: Number(branchId),
    invoiceId: Number(invoiceId),
    shiftId: null,
    direction: "OUT",
    amount: input.amount,
    paymentMethod: input.method,
    cashBucket: null,
    status: "PENDING",
    approvalStatus: "PENDING_APPROVAL",
    partyType: input.kind === "FEE" || input.customerId == null ? "OTHER" : "CUSTOMER",
    partyId: input.kind === "FEE" ? null : input.customerId,
    referenceNumber:
      input.kind === "FEE"
        ? `DLV-FEE-INV-${Number(invoiceId)}`
        : `DLV-GOODS-REFUND-${consignmentId}`,
    internalNote: JSON.stringify({ deliveryRefund: note }),
    description: `طلب استرداد ${input.kind === "FEE" ? "أمانة الأجرة" : "البضاعة"} — ${input.cn?.consignmentNumber ?? input.invoiceSource?.sourceNumber} — بانتظار اعتماد التنفيذ الخارجي`,
    createdBy: actor.userId,
  });
  return extractInsertId(inserted);
}

/** Lock all historical members: the original fee owner may no longer be the active leader. */
async function assertReturnEligibleTx(
  tx: Tx,
  cn: typeof deliveryConsignments.$inferSelect,
  wholeShipment = true,
) {
  if (cn.invoiceId == null)
    throw deliveryRefundError("الإرسالية تحتاج مسار رد مصدر المعالجة المخصص");
  const membership = wholeShipment
    ? (
        await tx
          .select()
          .from(deliveryShipmentMembers)
          .where(eq(deliveryShipmentMembers.consignmentId, Number(cn.id)))
          .limit(1)
      )[0]
    : null;
  const leader = membership?.leaderConsignmentId ?? Number(cn.id);
  const members = wholeShipment
    ? await tx
        .select({ id: deliveryShipmentMembers.consignmentId })
        .from(deliveryShipmentMembers)
        .where(eq(deliveryShipmentMembers.leaderConsignmentId, leader))
    : [];
  const ids = Array.from(
    new Set([leader, Number(cn.id), ...members.map((m) => Number(m.id))]),
  ).sort((a, b) => a - b);
  const rows = await tx
    .select()
    .from(deliveryConsignments)
    .where(inArray(deliveryConsignments.id, ids))
    .orderBy(deliveryConsignments.id)
    .for("update");
  const invoiceIds = rows
    .flatMap((r) => (r.invoiceId == null ? [] : [Number(r.invoiceId)]))
    .sort((a, b) => a - b);
  const invoiceRows = invoiceIds.length
    ? await tx
        .select()
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds))
        .orderBy(invoices.id)
        .for("update")
    : [];
  const byInvoice = new Map(invoiceRows.map((r) => [Number(r.id), r]));
  if (
    rows.length !== ids.length ||
    rows.some((r) => {
      const invoice = byInvoice.get(Number(r.invoiceId));
      return (
        r.branchId !== cn.branchId ||
        r.partyId !== cn.partyId ||
        !invoice ||
        (!["RETURNED", "CANCELLED"].includes(r.status) &&
          !["RETURNED", "CANCELLED"].includes(invoice.status))
      );
    })
  )
    throw deliveryRefundError(
      "ما زال عضو من الإرسالية أو بضاعته نشطاً؛ لا ترد أجرة الإرسالية كاملة قبل اكتمال الرجوع",
    );
}

export async function requestReturnedInvoiceFeeRefund(
  input: {
    consignmentId: number;
    reason: string;
    clientRequestId: string;
    refundShiftId?: number | null;
  },
  actor: Actor,
) {
  return withTx(async (tx) => {
    await assertOperationAuthorityTx(
      tx,
      actor,
      "delivery.returnConsignment",
      true,
    );
    const preview = (
      await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, input.consignmentId))
        .limit(1)
    )[0];
    if (!preview) throw deliveryRefundError("الإرسالية غير موجودة");
    scope(actor, Number(preview.branchId));
    if (input.reason.trim().length < 3)
      throw deliveryRefundError("اكتب سبب رد أجرة التوصيل بعد المرتجع");
    const fingerprint = idempotencyHash(input),
      replay = await checkIdempotency(
        tx,
        "delivery.feeRefund.request",
        input.clientRequestId,
        fingerprint,
      );
    if (replay != null) {
      const refunds = await tx
        .select({ id: receipts.id, note: receipts.internalNote })
        .from(receipts)
        .where(
          and(
            eq(receipts.invoiceId, Number(preview.invoiceId)),
            eq(receipts.direction, "OUT"),
          ),
        );
      return {
        consignmentId: input.consignmentId,
        pendingFeeRefundReceiptId:
          refunds.find((r) => {
            const n = parseNote(r.note);
            return n?.kind === "FEE" && n.consignmentId === input.consignmentId;
          })?.id ?? null,
        feeAlreadyPaidToCourier: preview.feeSettledAt != null,
        replayed: true,
      };
    }
    const original =
      preview.invoiceId == null
        ? []
        : await tx
            .select({ method: receipts.paymentMethod })
            .from(receipts)
            .where(
              and(
                eq(receipts.invoiceId, Number(preview.invoiceId)),
                eq(
                  receipts.referenceNumber,
                  `DLV-FEE-INV-${Number(preview.invoiceId)}`,
                ),
                eq(receipts.direction, "IN"),
                eq(receipts.status, "COMPLETED"),
              ),
            );
    let cashSource: { shiftId: number } | null = null;
    if (original.some((r) => r.method === "CASH")) {
      cashSource = await resolveBranchCashShiftTx(
        tx,
        Number(preview.branchId),
        input.refundShiftId ?? null,
      );
      await lockCashSourceForUpdate(tx, {
        branchId: Number(preview.branchId),
        cashBucket: "DRAWER",
        shiftId: cashSource.shiftId,
      });
    }
    await tx
      .select({ id: deliveryParties.id })
      .from(deliveryParties)
      .where(eq(deliveryParties.id, Number(preview.partyId)))
      .for("update");
    await assertReturnEligibleTx(tx, preview);
    const cn = (
      await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, input.consignmentId))
        .for("update")
        .limit(1)
    )[0]!;
    if (
      cn.invoiceId !== preview.invoiceId ||
      cn.partyId !== preview.partyId ||
      cn.branchId !== preview.branchId
    )
      throw deliveryRefundError(
        "تغيّر مصدر الإرسالية أثناء طلب الرد؛ حدّث المستند وأعد المحاولة",
      );
    const result = await refundHeldDeliveryFeeForReturnTx(
      tx,
      cn,
      actor,
      cashSource,
    );
    await recordIdempotencyKey(
      tx,
      "delivery.feeRefund.request",
      input.clientRequestId,
      input.consignmentId,
      fingerprint,
    );
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(cn.branchId),
      action: "delivery.feeRefund.request",
      entityType: "deliveryConsignment",
      entityId: String(cn.id),
      newValue: JSON.stringify({ reason: input.reason, ...result }),
    });
    return { consignmentId: input.consignmentId, ...result, replayed: false };
  });
}

export async function approveDeliveryPaymentRefund(
  input: {
    receiptId: number;
    providerReference: string;
    clientRequestId: string;
  },
  actor: Actor,
) {
  return withTx(async (tx) => {
    assertApprover({
      actor: await resolveApprovalActor(tx, actor),
      trigger: "MONEY_OUT",
      subject: `رد مقبوضات توصيل #${input.receiptId}`,
      legacy: () => {
        throw deliveryRefundError(
          "اعتماد التنفيذ الخارجي محصور بحساب مالك نشط",
        );
      },
    });
    let refund = (
      await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, input.receiptId))
        .limit(1)
    )[0];
    const note = refund ? parseNote(refund.internalNote) : null;
    if (!refund || !note)
      throw deliveryRefundError("الإيصال ليس طلب رد مقبوضات توصيل موثق المصدر");
    scope(actor, Number(refund.branchId));
    const reference = input.providerReference.trim();
    if (reference.length < 3 || reference.length > 100)
      throw deliveryRefundError(
        "مرجع نجاح الاسترداد لدى المزوّد مطلوب (3–100 محرف)",
      );
    const requestHash = idempotencyHash({
      ...input,
      providerReference: reference,
    });
    const requestReplay = await checkIdempotency(
      tx,
      "delivery.refund.execute",
      input.clientRequestId,
      requestHash,
    );
    if (requestReplay != null)
      return { receiptId: input.receiptId, replayed: true };
    if (refund.status === "COMPLETED" && refund.approvalStatus === "APPROVED") {
      if (note.providerReference !== reference)
        throw deliveryRefundError("طلب الرد منفذ سابقاً بمرجع خارجي مختلف");
      return { receiptId: input.receiptId, replayed: true };
    }
    if (
      refund.status !== "PENDING" ||
      refund.approvalStatus !== "PENDING_APPROVAL" ||
      refund.direction !== "OUT" ||
      refund.cashBucket != null ||
      !["CARD", "TRANSFER", "WALLET", "CHECK"].includes(refund.paymentMethod)
    )
      throw deliveryRefundError(
        "حالة طلب الرد أو وسيلته لا تسمح بتنفيذ استرداد غير نقدي",
      );
    let cn: typeof deliveryConsignments.$inferSelect | undefined;
    if (note.purpose === "CONSOLIDATION") {
      const source = await loadExcessFeeSourceTx(
        tx,
        { sourceKind: "INVOICE", sourceId: note.invoiceId },
        actor,
        { lock: true, allowedPendingReceiptId: input.receiptId },
      );
      if (
        source.receipt.id !== note.sourceReceiptIds[0] ||
        !money(source.amount).eq(money(refund.amount))
      )
        throw deliveryRefundError(
          "تغير مصدر الأجرة الزائدة منذ تقديم طلب الرد",
        );
    } else {
      cn = (
        await tx
          .select()
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, note.consignmentId!))
          .limit(1)
      )[0];
      if (
        !cn ||
        Number(cn.invoiceId) !== note.invoiceId ||
        Number(cn.branchId) !== Number(refund.branchId) ||
        Number(refund.invoiceId) !== note.invoiceId
      )
        throw deliveryRefundError(
          "مصدر طلب الرد لم يعد يطابق الإرسالية والفاتورة",
        );
      await tx
        .select({ id: deliveryParties.id })
        .from(deliveryParties)
        .where(eq(deliveryParties.id, Number(cn.partyId)))
        .for("update");
      await assertReturnEligibleTx(tx, cn, note.kind === "FEE");
      cn = (
        await tx
          .select()
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, note.consignmentId!))
          .for("update")
          .limit(1)
      )[0];
      if (
        !cn ||
        Number(cn.invoiceId) !== note.invoiceId ||
        Number(cn.branchId) !== Number(refund.branchId)
      )
        throw deliveryRefundError("تغيّر مصدر الإرسالية أثناء اعتماد الرد");
    }
    const currentRefund = (
      await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, input.receiptId))
        .for("update")
        .limit(1)
    )[0];
    if (
      !currentRefund ||
      currentRefund.status !== "PENDING" ||
      currentRefund.approvalStatus !== "PENDING_APPROVAL" ||
      currentRefund.internalNote !== refund.internalNote ||
      currentRefund.amount !== refund.amount ||
      currentRefund.paymentMethod !== refund.paymentMethod ||
      currentRefund.branchId !== refund.branchId ||
      currentRefund.invoiceId !== refund.invoiceId
    )
      throw deliveryRefundError(
        "تغير طلب الرد بالتوازي؛ حدّث حالته قبل إعادة التنفيذ",
      );
    refund = currentRefund;
    assertNonPhysicalOutReceipt({
      classification: "NON_CASH_METHOD",
      paymentMethod: refund.paymentMethod,
      cashBucket: refund.cashBucket,
      approvalStatus: refund.approvalStatus,
      operation: "اعتماد رد توصيل غير نقدي",
    });
    const inv = (
      await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, note.invoiceId))
        .for("update")
        .limit(1)
    )[0]!;
    const amount = round2(money(refund.amount));
    if (note.kind === "FEE") {
      if (cn?.feeSettledAt != null)
        throw deliveryRefundError(
          "أجرة الناقل سددت فعلياً؛ ردها للعميل يحتاج قرار مصروف مستقل",
        );
      const sources = await tx
        .select()
        .from(receipts)
        .where(
          and(
            inArray(receipts.id, note.sourceReceiptIds),
            eq(receipts.invoiceId, note.invoiceId),
            eq(receipts.direction, "IN"),
            eq(receipts.status, "COMPLETED"),
            eq(receipts.approvalStatus, "APPROVED"),
          ),
        )
        .for("update");
      const outs = await tx
        .select({ amount: receipts.amount })
        .from(receipts)
        .where(
          and(
            eq(receipts.invoiceId, note.invoiceId),
            inArray(receipts.referenceNumber, [
              `DLV-FEE-INV-${note.invoiceId}`,
              ...(cn == null ? [] : [String(cn.consignmentNumber)]),
            ]),
            eq(receipts.direction, "OUT"),
            eq(receipts.status, "COMPLETED"),
            eq(receipts.approvalStatus, "APPROVED"),
          ),
        )
        .for("update");
      if (
        sources.length !== new Set(note.sourceReceiptIds).size ||
        sources.some(
          (r) =>
            r.referenceNumber !== `DLV-FEE-INV-${note.invoiceId}` ||
            r.paymentMethod !== refund.paymentMethod ||
            r.branchId !== refund.branchId,
        ) ||
        amount.gt(
          sources
            .reduce((s, r) => s.plus(money(r.amount)), money(0))
            .minus(outs.reduce((s, r) => s.plus(money(r.amount)), money(0))),
        )
      )
        throw deliveryRefundError(
          "الرد يتجاوز صافي أمانة الأجرة أو يخالف وسيلة القبض الأصلية",
        );
    } else {
      const cap = await loadRefundCaps(tx, note.invoiceId, { lock: true });
      if (
        amount.gt(cap.pool) ||
        amount.gt(
          cap.netByMethod.get(refund.paymentMethod as NonCashRail) ?? money(0),
        ) ||
        amount.gt(money(inv.paidAmount))
      )
        throw deliveryRefundError(
          "الرد يتجاوز صافي مقبوضات البضاعة غير المردودة على الوسيلة الأصلية",
        );
    }
    await reserveExternalRefundConfirmationTx(tx, {
      receiptId: input.receiptId,
      method: refund.paymentMethod,
      reference,
    });
    await tx
      .update(receipts)
      .set({
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
        executedBy: actor.userId,
        executedAt: new Date(),
        ...(note.kind === "FEE" ? { partyType: "OTHER" as const, partyId: null } : {}),
        internalNote: JSON.stringify({
          deliveryRefund: { ...note, providerReference: reference },
        }),
      })
      .where(eq(receipts.id, input.receiptId));
    const asset = paymentAccountRole(refund.paymentMethod, null, "OUT"),
      counter = note.kind === "FEE" ? "COURIER_PAYABLE" : "AR",
      type = note.kind === "FEE" ? "DELIVERY_FEE_HELD" : "PAYMENT_OUT";
    const components = {
      roleDebits: { [counter]: amount },
      roleCredits: { [asset]: amount },
    };
    await postEntry(tx, {
      entryType: type,
      branchId: Number(refund.branchId),
      invoiceId: note.invoiceId,
      receiptId: input.receiptId,
      customerId: inv.customerId,
      amount: note.kind === "FEE" ? amount.neg() : amount,
      paymentMethod: refund.paymentMethod,
      dedupeKey: `DELIVERY_PAYMENT_REFUND:${input.receiptId}`,
      notes: `استرداد ${note.kind} ${cn?.consignmentNumber ?? `INV-${note.invoiceId}`} — مرجع المزوّد ${reference}`,
      postingIntent: createPostingIntent(
        note.kind === "FEE"
          ? "DELIVERY_FEE_HELD_PAYOUT"
          : "PAYMENT_OUT_CUSTOMER_REFUND",
        type,
        [debitLine(counter, amount), creditLine(asset, amount)],
        components,
      ),
      postingSourceComponents: components,
    });
    if (note.kind === "GOODS") {
      await allocateVoucherToInvoiceTx(tx, {
        invoiceId: note.invoiceId,
        amount,
        direction: "OUT",
        paymentMethod: refund.paymentMethod,
        voucherBranchId: Number(refund.branchId),
      });
      if (inv.customerId != null)
        await adjustCustomerBalance(tx, Number(inv.customerId), amount);
      await closeDeferredSaleRefundEffectsTx(
        tx,
        {
          invoiceId: note.invoiceId,
          receiptId: input.receiptId,
          amount,
          reason: `تنفيذ رد توصيل بمرجع ${reference}`,
        },
        actor,
      );
    }
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(refund.branchId),
      action: "delivery.refund.execute",
      entityType: "receipt",
      entityId: String(input.receiptId),
      newValue: JSON.stringify({
        kind: note.kind,
        providerReference: reference,
        amount: toDbMoney(amount),
        makerUserId: refund.createdBy,
        approverUserId: actor.userId,
      }),
    });
    await recordIdempotencyKey(
      tx,
      "delivery.refund.execute",
      input.clientRequestId,
      input.receiptId,
      requestHash,
    );
    return { receiptId: input.receiptId, replayed: false };
  });
}

export async function listDeliveryPaymentRefunds(
  input: { branchId?: number | null },
  actor: Actor,
) {
  return withTx(async (tx) => {
    const branch =
      actor.role === "admin" ? (input.branchId ?? null) : actor.branchId;
    if (actor.role !== "admin" && branch == null)
      throw deliveryRefundError("لا فرع مسند للمستخدم");
    const pending = await tx
      .select({
        id: receipts.id,
        invoiceId: receipts.invoiceId,
        workOrderId: receipts.workOrderId,
        amount: receipts.amount,
        method: receipts.paymentMethod,
        status: receipts.status,
        approvalStatus: receipts.approvalStatus,
        description: receipts.description,
        note: receipts.internalNote,
        createdBy: receipts.createdBy,
      })
      .from(receipts)
      .where(
        and(
          or(
            like(receipts.internalNote, '{"deliveryRefund":%'),
            like(receipts.internalNote, "WORK_ORDER_CUSTOMER_REFUND:FEE:%"),
          ),
          ...(branch == null ? [] : [eq(receipts.branchId, branch)]),
        ),
      )
      .orderBy(desc(receipts.id))
      .limit(100);
    const candidates = await tx
      .select({
        consignmentId: deliveryConsignments.id,
        consignmentNumber: deliveryConsignments.consignmentNumber,
        invoiceId: deliveryConsignments.invoiceId,
        invoiceNumber: invoices.invoiceNumber,
        fee: deliveryConsignments.deliveryFee,
        feeSettledAt: deliveryConsignments.feeSettledAt,
      })
      .from(deliveryConsignments)
      .innerJoin(invoices, eq(invoices.id, deliveryConsignments.invoiceId))
      .where(
        and(
          or(
            inArray(deliveryConsignments.status, ["RETURNED", "CANCELLED"]),
            inArray(invoices.status, ["RETURNED", "CANCELLED"]),
          ),
          ...(branch == null
            ? []
            : [eq(deliveryConsignments.branchId, branch)]),
        ),
      )
      .orderBy(desc(deliveryConsignments.id))
      .limit(100);
    return {
      pending: pending.map((r) => ({
        ...r,
        consignmentId: parseNote(r.note)?.consignmentId ?? null,
        kind:
          parseNote(r.note)?.kind ??
          (r.note?.startsWith("WORK_ORDER_CUSTOMER_REFUND:FEE:")
            ? "FEE"
            : null),
        providerReference:
          parseNote(r.note)?.providerReference ??
          (r.note?.startsWith("WORK_ORDER_CUSTOMER_REFUND:FEE:")
            ? decodeURIComponent(r.note.split(":")[4] ?? "")
            : null),
      })),
      candidates: candidates.filter(
        (r) => money(r.fee).gt(0) && r.feeSettledAt == null,
      ),
    };
  });
}
