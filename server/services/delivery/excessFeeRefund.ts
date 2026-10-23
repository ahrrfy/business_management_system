import { and, eq, inArray, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { normalizeBarcodeScannerInput } from "@shared/barcodeScanner";
import {
  auditLogs,
  accountingEntries,
  deliveryConsignments,
  deliveryLedgerEntries,
  invoices,
  receipts,
  shifts,
  users,
  workOrders,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { type Actor, withTx } from "../tx";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { resolveBranchCashShiftTx } from "../shiftService";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import { refundWorkOrderDeliveryFeeHeld } from "../workOrder/deliveryFeeRefund";
import { refundHeldInvoiceFeeTx } from "./returns";
import { deliveryRefundError } from "./paymentRefunds";
import { assertOperationAuthorityTx } from "../authorization/operationAuthority";

export type ExcessFeeSource = {
  sourceKind: "INVOICE" | "WORK_ORDER";
  sourceId: number;
};

/** Source rows are the mutex shared with dispatch. No consignment is synthesized. */
export async function loadExcessFeeSourceTx(
  tx: Tx,
  input: ExcessFeeSource,
  actor: Actor,
  options: { lock?: boolean; allowedPendingReceiptId?: number } = {},
) {
  const linkedQuery = tx
    .select()
    .from(workOrders)
    .where(
      input.sourceKind === "WORK_ORDER"
        ? eq(workOrders.id, input.sourceId)
        : eq(workOrders.invoiceId, input.sourceId),
    )
    .orderBy(workOrders.id);
  const linked = await (options.lock ? linkedQuery.for("update") : linkedQuery);
  const wo = input.sourceKind === "WORK_ORDER" ? linked[0] : undefined;
  const invoiceId =
    input.sourceKind === "INVOICE" ? input.sourceId : (wo?.invoiceId ?? null);
  const invoiceQuery =
    invoiceId == null
      ? null
      : tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  const inv = invoiceQuery
    ? (await (options.lock ? invoiceQuery.for("update") : invoiceQuery))[0]
    : undefined;
  if (input.sourceKind === "WORK_ORDER" ? !wo : !inv)
    throw deliveryRefundError("المصدر غير موجود");
  const branchId = Number(wo?.branchId ?? inv?.branchId);
  if (branchId !== actor.branchId)
    throw deliveryRefundError(
      "المصدر يتبع فرعاً آخر؛ اختر رقمه من الفرع الصحيح",
    );
  if (wo && wo.status !== "READY")
    throw deliveryRefundError("رد الأجرة قبل التجميع متاح لأمر شغل جاهز فقط");
  if (inv && ["CANCELLED", "RETURNED", "SUPERSEDED"].includes(inv.status))
    throw deliveryRefundError("الفاتورة مغلقة؛ استخدم رد الأجرة بعد المرتجع");
  const woIds = linked.map((r) => Number(r.id));
  const sourcePredicates = [
    ...(invoiceId == null
      ? []
      : [eq(deliveryConsignments.invoiceId, invoiceId)]),
    ...(woIds.length ? [inArray(deliveryConsignments.workOrderId, woIds)] : []),
  ];
  const cnQuery = tx
    .select()
    .from(deliveryConsignments)
    .where(or(...sourcePredicates));
  const consignments = await (options.lock ? cnQuery.for("update") : cnQuery);
  if (
    consignments.some(
      (c) =>
        !["CANCELLED", "RETURNED"].includes(c.status) || c.feeSettledAt != null,
    )
  )
    throw deliveryRefundError(
      "المصدر له إرسالية حية أو أجرة ناقل مصروفة؛ ألغ الإسناد غير المنفذ أولاً أو استخدم مسار التسوية",
    );
  if (consignments.length) {
    const earned = await tx
      .select({ id: deliveryLedgerEntries.id })
      .from(deliveryLedgerEntries)
      .where(
        and(
          inArray(
            deliveryLedgerEntries.consignmentId,
            consignments.map((c) => Number(c.id)),
          ),
          inArray(deliveryLedgerEntries.entryType, ["FEE_EARNED", "FEE_PAID"]),
        ),
      )
      .limit(1);
    if (earned.length)
      throw deliveryRefundError(
        "أجرة المصدر استحقت أو صُرفت بالفعل؛ لا ترد كأجرة زائدة قبل التجميع",
      );
  }
  const refs = [
    ...(invoiceId == null ? [] : [`DLV-FEE-INV-${invoiceId}`]),
    ...woIds.map((id) => `DLV-FEE-WO-${id}`),
  ];
  const receiptQuery = tx
    .select()
    .from(receipts)
    .where(
      and(
        inArray(receipts.referenceNumber, refs),
        or(
          ...[
            ...(invoiceId == null ? [] : [eq(receipts.invoiceId, invoiceId)]),
            ...(woIds.length ? [inArray(receipts.workOrderId, woIds)] : []),
          ],
        ),
      ),
    );
  const feeRows = await (options.lock
    ? receiptQuery.for("update")
    : receiptQuery);
  const sources = feeRows.filter(
    (r) =>
      r.direction === "IN" &&
      r.status === "COMPLETED" &&
      r.approvalStatus === "APPROVED",
  );
  if (sources.length !== 1 || Number(sources[0].branchId) !== branchId)
    throw deliveryRefundError(
      "يجب تحديد إيصال أمانة أصلي واحد مثبت في فرع المصدر",
    );
  if (
    feeRows.some(
      (r) =>
        r.direction === "OUT" &&
        ((r.status === "PENDING" &&
          r.approvalStatus === "PENDING_APPROVAL" &&
          Number(r.id) !== options.allowedPendingReceiptId) ||
          (r.status === "COMPLETED" && r.approvalStatus === "APPROVED")),
    )
  )
    throw deliveryRefundError(
      "الأجرة لها طلب رد معلق أو رد منفذ؛ راجع الإيصالات ولا تنشئ رداً مكرراً",
    );
  const receipt = sources[0],
    amount = round2(money(receipt.amount));
  const evidence = await tx
    .select({ amount: accountingEntries.amount })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.receiptId, Number(receipt.id)),
        eq(accountingEntries.entryType, "DELIVERY_FEE_HELD"),
        eq(accountingEntries.branchId, branchId),
      ),
    );
  if (
    !evidence.reduce((sum, e) => sum.plus(money(e.amount)), money(0)).eq(amount)
  )
    throw deliveryRefundError(
      "إيصال الأجرة لا يطابق قيد أمانة مثبتاً؛ اطلب مراجعة المصدر المحاسبي قبل الرد",
    );
  if (
    receipt.workOrderId != null &&
    linked.find((w) => Number(w.id) === Number(receipt.workOrderId))?.status !==
      "READY"
  )
    throw deliveryRefundError(
      "أمر الشغل صاحب الأجرة ليس جاهزاً؛ راجع مصدر الخدمة قبل الرد",
    );
  if (!amount.gt(0)) throw deliveryRefundError("رصيد الأجرة الأصلي غير موجب");
  if (!["CASH", "CARD", "TRANSFER", "WALLET"].includes(receipt.paymentMethod))
    throw deliveryRefundError("وسيلة الأجرة لا تدعم الرد قبل التجميع");
  const collectingShift =
    receipt.shiftId == null
      ? undefined
      : (
          await tx
            .select()
            .from(shifts)
            .where(eq(shifts.id, Number(receipt.shiftId)))
        )[0];
  return {
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    number: String(wo?.orderNumber ?? inv?.invoiceNumber),
    branchId,
    customerId: wo?.customerId ?? inv?.customerId ?? null,
    state: String(wo?.status ?? inv?.status),
    invoiceId,
    workOrderId:
      receipt.workOrderId == null ? null : Number(receipt.workOrderId),
    receipt,
    amount: toDbMoney(amount),
    needsManagerApproval:
      receipt.paymentMethod === "CASH" &&
      !(
        collectingShift?.status === "OPEN" &&
        Number(collectingShift.userId) === actor.userId
      ),
  };
}

export async function previewExcessFeeRefund(
  input: { documentNumber: string },
  actor: Actor,
) {
  return withTx(async (tx) => {
    const text = normalizeBarcodeScannerInput(input.documentNumber).trim();
    const variants = Array.from(new Set([text, text.replace(/^(?:INV|WO)[-|]/i, "")]));
    const inv = await tx
      .select({
        id: invoices.id,
        number: invoices.invoiceNumber,
        state: invoices.status,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.branchId, actor.branchId),
          inArray(invoices.invoiceNumber, variants),
        ),
      );
    const wo = await tx
      .select({
        id: workOrders.id,
        number: workOrders.orderNumber,
        state: workOrders.status,
      })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.branchId, actor.branchId),
          inArray(workOrders.orderNumber, variants),
        ),
      );
    const choices = [
      ...(/^WO[-|]/i.test(text)
        ? []
        : inv.map((i) => ({
            sourceKind: "INVOICE" as const,
            sourceId: Number(i.id),
          }))),
      ...(/^INV[-|]/i.test(text)
        ? []
        : wo.map((w) => ({
            sourceKind: "WORK_ORDER" as const,
            sourceId: Number(w.id),
          }))),
    ];
    if (choices.length !== 1)
      throw deliveryRefundError(
        choices.length
          ? "الرقم المطبوع يطابق أكثر من مصدر؛ امسح باركود INV أو WO الكامل"
          : "لا يوجد مصدر بهذا الرقم المطبوع في الفرع؛ لا يُفسر الرقم كمعرف داخلي",
      );
    const selected = choices[0];
    try {
      const source = await loadExcessFeeSourceTx(tx, selected, actor);
      return {
        ...source,
        eligible: true as const,
        blockReason: null,
        receipt: {
          id: Number(source.receipt.id),
          amount: source.receipt.amount,
          method: source.receipt.paymentMethod,
          reference: source.receipt.referenceNumber,
          shiftId: source.receipt.shiftId,
        },
      };
    } catch (error) {
      if (!(error instanceof TRPCError)) throw error;
      const document = (selected.sourceKind === "INVOICE" ? inv : wo).find(
        (r) => Number(r.id) === selected.sourceId,
      )!;
      return {
        ...selected,
        number: document.number,
        state: document.state,
        eligible: false as const,
        blockReason: error.message,
        receipt: null,
      };
    }
  });
}

export async function requestExcessFeeRefund(
  input: ExcessFeeSource & {
    reason: string;
    clientRequestId: string;
    expectedReceiptId: number;
    expectedAmount: string;
    refundShiftId?: number | null;
    approvedByManagerId?: number | null;
  },
  actor: Actor,
) {
  return withTx(async (tx) => {
    await assertOperationAuthorityTx(
      tx,
      actor,
      "delivery.paymentRefunds.requestExcess",
      ["admin", "manager", "cashier"].includes(actor.role ?? ""),
    );
    if (input.reason.trim().length < 3)
      throw deliveryRefundError("سبب رد الأجرة الزائدة مطلوب");
    // Scope before replay; replay needs no still-open drawer and never issues another receipt.
    const scopeRows =
      input.sourceKind === "INVOICE"
        ? await tx
            .select({ branchId: invoices.branchId })
            .from(invoices)
            .where(eq(invoices.id, input.sourceId))
        : await tx
            .select({ branchId: workOrders.branchId })
            .from(workOrders)
            .where(eq(workOrders.id, input.sourceId));
    if (scopeRows[0]?.branchId !== actor.branchId)
      throw deliveryRefundError("المصدر غير موجود في فرع المستخدم");
    const hash = idempotencyHash({ ...input, approvedByManagerId: undefined });
    const replay = await checkIdempotency(
      tx,
      "delivery.excessFeeRefund",
      input.clientRequestId,
      hash,
    );
    if (replay != null) return { receiptId: replay, replayed: true };
    const preview = await loadExcessFeeSourceTx(tx, input, actor);
    let cash: { shiftId: number } | null = null;
    if (preview.receipt.paymentMethod === "CASH") {
      cash = await resolveBranchCashShiftTx(
        tx,
        actor.branchId,
        input.refundShiftId ??
          (preview.receipt.shiftId == null
            ? null
            : Number(preview.receipt.shiftId)),
      );
      await lockCashSourceForUpdate(tx, {
        branchId: actor.branchId,
        cashBucket: "DRAWER",
        shiftId: cash.shiftId,
      });
    }
    const current = await loadExcessFeeSourceTx(tx, input, actor, {
      lock: true,
    });
    if (
      current.receipt.id !== input.expectedReceiptId ||
      !money(current.amount).eq(money(input.expectedAmount))
    )
      throw deliveryRefundError(
        "تغير إيصال الأجرة أو مبلغها منذ المعاينة؛ أعد مسح المصدر",
      );
    if (
      (current.needsManagerApproval ||
        cash?.shiftId !== current.receipt.shiftId) &&
      current.receipt.paymentMethod === "CASH"
    ) {
      const manager =
        input.approvedByManagerId == null
          ? undefined
          : (
              await tx
                .select()
                .from(users)
                .where(eq(users.id, input.approvedByManagerId))
            )[0];
      if (
        !manager?.isActive ||
        !["manager", "admin"].includes(manager.role) ||
        manager.id === actor.userId ||
        (manager.role !== "admin" && manager.branchId !== actor.branchId)
      )
        throw deliveryRefundError(
          "رد النقد خارج وردية قبضك يحتاج اعتماد مدير مختلف موثق",
        );
    }
    if (current.workOrderId != null) {
      await refundWorkOrderDeliveryFeeHeld(tx, {
        workOrderId: current.workOrderId,
        branchId: actor.branchId,
        actor,
        reason: input.reason,
        refundShiftId: cash?.shiftId,
        approvedByManagerId: input.approvedByManagerId,
      });
    } else if (current.invoiceId != null) {
      await refundHeldInvoiceFeeTx(
        tx,
        {
          invoiceId: current.invoiceId,
          branchId: actor.branchId,
          sourceNumber: current.number,
          reason: input.reason,
          purpose: "CONSOLIDATION",
          approvedByManagerId: input.approvedByManagerId,
        },
        actor,
        cash,
      );
    } else throw deliveryRefundError("تعذر تحديد رافد الأجرة الأصلي");
    const result = (
      await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(
          and(
            eq(receipts.referenceNumber, current.receipt.referenceNumber!),
            eq(receipts.direction, "OUT"),
            current.workOrderId == null
              ? eq(receipts.invoiceId, Number(current.invoiceId))
              : eq(receipts.workOrderId, current.workOrderId),
          ),
        )
        .orderBy(receipts.id)
    )[0];
    if (!result) throw new Error("Missing excess held-fee refund receipt");
    if (current.workOrderId != null && current.invoiceId != null)
      await tx
        .update(receipts)
        .set({ invoiceId: current.invoiceId })
        .where(eq(receipts.id, Number(result.id)));
    await recordIdempotencyKey(
      tx,
      "delivery.excessFeeRefund",
      input.clientRequestId,
      Number(result.id),
      hash,
    );
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action: "delivery.excessFeeRefund.request",
      entityType: input.sourceKind === "INVOICE" ? "invoice" : "workOrder",
      entityId: String(input.sourceId),
      newValue: JSON.stringify({
        sourceReceiptId: current.receipt.id,
        refundReceiptId: Number(result.id),
        amount: current.amount,
        method: current.receipt.paymentMethod,
        reason: input.reason,
        approvedByManagerId: input.approvedByManagerId ?? null,
      }),
    });
    return { receiptId: Number(result.id), replayed: false };
  });
}
