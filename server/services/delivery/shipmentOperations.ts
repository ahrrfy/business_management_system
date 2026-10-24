import { returnFulfillmentRequestConsignmentTx } from "../fulfillment/requestSources";
import { loadRefundCaps } from "../returns/refundCaps";
import { routeAftercareDeliveryResultTx } from "../fulfillment/aftercareDelivery";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryParties,
  deliveryShipmentMembers,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { withTx } from "../tx";
import {
  lockCashSourceForUpdate,
  MATERIALIZED_RECEIPT_STATUSES,
} from "../cash/cashAvailability";
import { resolveBranchCashShiftTx } from "../shiftService";
import { cancelDeliveryAssignmentInTx } from "./cancellation";
import { confirmConsignmentDelivery } from "./courier";
import { reassignDeliveryConsignment } from "./parties";
import { allocateProportionally } from "./remittance";
import { refundHeldDeliveryFeeForReturnTx, returnConsignment } from "./returns";
import {
  loadShipmentMembersTx,
  operationalShipmentMembers,
  shipmentCurrentPartyMembers,
} from "./shipments";
import { staffMarkFailed } from "./staffTransition";
import type { DeliveryTxActor } from "./types";
import { declareConsignmentReturn } from "./declaredReturn";
import { physicalReturnReceiptTx } from "./workflow/returnReceipt";

type Member = typeof deliveryConsignments.$inferSelect;
export interface ShipmentOperationInput {
  consignmentId: number;
  clientRequestId: string;
}
type ShipmentRequest = Pick<ShipmentOperationInput, "consignmentId"> & {
  clientRequestId?: string | null;
};
export interface ShipmentOperationResult {
  consignmentId: number;
  consignmentIds: number[];
  idempotentReplay: boolean;
}
export interface ConfirmShipmentDeliveryInput extends ShipmentOperationInput {
  collectedAmount: string;
  evidence: string;
  shortfallReason?: string;
}
export interface ShipmentReasonInput extends ShipmentOperationInput {
  reason: string;
}
export interface DeclareShipmentReturnInput extends Omit<
  ShipmentReasonInput,
  "clientRequestId"
> {
  clientRequestId?: string | null;
  statementNumber?: string | null;
}
export interface ReturnShipmentInput extends ShipmentReasonInput {
  refundShiftId?: number | null;
}
export interface ReassignShipmentDriverInput extends ShipmentOperationInput {
  assignedUserId?: number | null;
}

function reject(
  why: string,
  doThis = "افتح تفاصيل الشحنة وراجع جميع فواتيرها ثم أعد المحاولة",
): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: appErrorMessage({ what: "تعذر تنفيذ إجراء الشحنة", why, doThis }),
  });
}

function assertScope(actor: DeliveryTxActor, rows: Member[]) {
  if (
    actor.role !== "admin" &&
    (actor.branchId == null ||
      rows.some((row) => Number(row.branchId) !== Number(actor.branchId)))
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذر الوصول إلى الشحنة",
        why: "الشحنة خارج فرع الموظف المسند",
        doThis: "افتح الشحنة من فرعها الصحيح",
      }),
    });
  }
}

/** Cash source → party → every consignment → every invoice, always ascending within a set. */
async function lockShipmentTx(
  tx: Tx,
  input: Pick<ShipmentOperationInput, "consignmentId">,
  actor: DeliveryTxActor,
  beforeParty?: (rows: Member[]) => Promise<void>,
) {
  const preview = await loadShipmentMembersTx(tx, input.consignmentId);
  if (!preview.length) reject("الشحنة غير موجودة");
  assertScope(actor, preview);
  await beforeParty?.(preview);
  const [membership] = await tx
    .select()
    .from(deliveryShipmentMembers)
    .where(eq(deliveryShipmentMembers.consignmentId, input.consignmentId))
    .limit(1);
  const leaderId = Number(membership?.leaderConsignmentId ?? preview[0].id);
  const previewLeader = preview.find((row) => Number(row.id) === leaderId);
  if (!previewLeader) reject("قائد الشحنة غير موجود ضمن فواتيرها");
  const partyId = Number(previewLeader.partyId);
  const [party] = await tx
    .select({ id: deliveryParties.id })
    .from(deliveryParties)
    .where(eq(deliveryParties.id, partyId))
    .for("update")
    .limit(1);
  if (!party) reject("جهة الشحنة غير موجودة");
  const current = await loadShipmentMembersTx(tx, input.consignmentId, {
    currentRead: true,
  });
  if (
    current.map((row) => Number(row.id)).join(",") !==
    preview.map((row) => Number(row.id)).join(",")
  )
    reject("تغيرت فواتير الشحنة أثناء التنفيذ");
  const rows = await tx
    .select()
    .from(deliveryConsignments)
    .where(
      inArray(
        deliveryConsignments.id,
        current.map((row) => Number(row.id)),
      ),
    )
    .orderBy(asc(deliveryConsignments.id))
    .for("update");
  assertScope(actor, rows);
  const leader = rows.find((row) => Number(row.id) === leaderId);
  if (
    rows.length !== preview.length ||
    !leader ||
    Number(leader.partyId) !== partyId ||
    rows.some(
      (row) => Number(row.branchId) !== Number(previewLeader.branchId),
    ) ||
    shipmentCurrentPartyMembers(rows).some(
      (row) => Number(row.partyId) !== partyId,
    )
  )
    reject("أطراف الشحنة غير متسقة");
  return {
    rows,
    partyId,
    leaderId,
  };
}

async function executeShipment<I extends ShipmentRequest>(
  namespace: string,
  input: I,
  actor: DeliveryTxActor,
  apply: (tx: Tx, rows: Member[], partyId: number) => Promise<void>,
  prelock?: (tx: Tx, rows: Member[]) => Promise<void>,
  sourceRoute?: (tx: Tx) => Promise<ShipmentOperationResult | null>,
): Promise<ShipmentOperationResult> {
  return withTx(async (tx) => {
    const routed = await sourceRoute?.(tx);
    if (routed) return routed;
    const { rows, partyId, leaderId } = await lockShipmentTx(
      tx,
      input,
      actor,
      prelock ? (rows) => prelock(tx, rows) : undefined,
    );
    const hash = idempotencyHash({ ...input, consignmentId: leaderId });
    const replay = await checkIdempotency(
      tx,
      namespace,
      input.clientRequestId,
      hash,
      { forUpdate: true },
    );
    const result = {
      consignmentId: leaderId,
      consignmentIds: rows.map((row) => Number(row.id)),
      idempotentReplay: replay != null,
    };
    if (replay != null) {
      if (Number(replay) !== leaderId) reject("مفتاح العملية مرتبط بشحنة أخرى");
      return result;
    }
    const operational = operationalShipmentMembers(rows);
    if (namespace === "delivery.returnShipment") {
      const inspected = new Set<number>();
      for (const row of rows)
        if (await physicalReturnReceiptTx(tx, row)) inspected.add(row.id);
      if (inspected.size > 0) {
        const invoiceIds = rows.flatMap((row) =>
          row.invoiceId == null ? [] : [row.invoiceId],
        );
        const currentInvoices = invoiceIds.length
          ? await tx
              .select({ id: invoices.id, status: invoices.status })
              .from(invoices)
              .where(inArray(invoices.id, invoiceIds))
              .for("update")
          : [];
        const pending = rows.filter(
          (row) =>
            row.invoiceId != null &&
            currentInvoices.some(
              (invoice) =>
                invoice.id === row.invoiceId &&
                !["CANCELLED", "RETURNED", "SUPERSEDED"].includes(
                  invoice.status,
                ),
            ),
        );
        if (pending.some((row) => !inspected.has(row.id)))
          reject(
            "استلم وافحص كل طرد تجاري متبق قبل إرجاع المجموعة كاملة؛ الاستلام الجزئي لا يجيز عكس بيع أو مخزون طرود لم تصل",
          );
      }
      for (const row of rows)
        if (row.status === "DISPATCHED" && inspected.has(row.id))
          operational.push(row);
    }
    if (!operational.length)
      reject("لا توجد فواتير متبقية ضمن دورة توصيل الشحنة");
    await apply(tx, operational, partyId);
    if (input.clientRequestId)
      await recordIdempotencyKey(
        tx,
        namespace,
        input.clientRequestId,
        leaderId,
        hash,
      );
    return result;
  });
}

function memberKey(input: ShipmentRequest, id: number) {
  return `shipment:${id}:${idempotencyHash(input).slice(0, 48)}`;
}

export async function confirmShipmentDelivery(
  input: ConfirmShipmentDeliveryInput,
  actor: DeliveryTxActor,
) {
  const evidence = input.evidence.trim();
  if (evidence.length < 3)
    reject(
      "مصدر تأكيد التسليم مطلوب",
      "اكتب مصدر التأكيد مثل اتصال المندوب أو رسالة العميل",
    );
  const collected = round2(money(input.collectedAmount));
  if (!collected.isFinite() || collected.lt(0))
    reject("مبلغ التحصيل يجب أن يكون صفراً أو مبلغاً موجباً");
  return executeShipment(
    "delivery.confirmShipment",
    { ...input, evidence, collectedAmount: toDbMoney(collected) },
    actor,
    async (tx, rows, partyId) => {
      if (rows.every((row) => row.parcelStatus === "DELIVERED"))
        reject(
          "الشحنة مسلمة بالفعل",
          "راجع التحصيل المسجل؛ استخدم التحصيل المتمم عند الحاجة",
        );
      if (rows.some((row) => row.parcelStatus === "DELIVERED"))
        reject("تضم الشحنة حالة تسليم جزئية غير متسقة");
      const invoiceIds = rows.map((row) => Number(row.invoiceId));
      const invoiceRows = await tx
        .select()
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds))
        .orderBy(asc(invoices.id))
        .for("update");
      const invoiceById = new Map(
        invoiceRows.map((invoice) => [Number(invoice.id), invoice]),
      );
      const weights = rows.map((row) => {
        const invoice = invoiceById.get(Number(row.invoiceId));
        if (!invoice) reject("إحدى فواتير الشحنة غير موجودة");
        const liveRemaining = Decimal.max(
          round2(
            money(invoice.total)
              .minus(money(invoice.returnedTotal ?? "0"))
              .minus(money(invoice.paidAmount)),
          ),
          0,
        );
        const codRemaining = round2(
          money(row.codAmount).minus(money(row.collectedAmount ?? "0")),
        );
        if (codRemaining.lt(0))
          reject("تحصيل إحدى فواتير الشحنة يتجاوز مبلغها الأصلي");
        return Decimal.min(liveRemaining, codRemaining);
      });
      const due = round2(
        weights.reduce((sum, value) => sum.plus(value), money(0)),
      );
      if (collected.gt(due))
        reject(
          `المقبوض ${collected.toFixed(2)} يتجاوز المتبقي ${due.toFixed(2)} بفارق ${collected.minus(due).toFixed(2)}`,
          "أدخل المقبوض ضمن المبلغ المتبقي الظاهر في تفاصيل الشحنة",
        );
      const allocations = allocateProportionally(collected, weights);
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        await confirmConsignmentDelivery(
          {
            consignmentId: Number(row.id),
            clientRequestId: memberKey(input, Number(row.id)),
            statementWitness: {
              partyId,
              statementNumber: `STAFF:${evidence}`.slice(0, 160),
              kind: "STAFF_CONFIRMED",
              collectedAmount: toDbMoney(allocations[index]),
              shortfallReason: input.shortfallReason,
            },
          },
          actor,
          tx,
          { shipmentMember: true },
        );
      }
    },
  );
}

/** A return notice releases expected COD, while stock, invoices and cash await physical receipt. */
export async function declareShipmentReturn(
  input: DeclareShipmentReturnInput,
  actor: DeliveryTxActor,
) {
  const normalized = {
    ...input,
    reason: input.reason.trim(),
    statementNumber: input.statementNumber?.trim() || null,
  };
  return executeShipment(
    "delivery.declareShipmentReturn",
    normalized,
    actor,
    async (tx, rows) => {
      if (
        rows.some(
          (row) =>
            row.parcelStatus === "DELIVERED" ||
            row.courierDeliveredAt != null ||
            money(row.counterSettledAmount ?? "0").gt(0),
        )
      ) {
        reject(
          "تضم الشحنة طرداً ثبت تسليمه أو سداداً بعد التسليم",
          "راجع تفاصيل الشحنة واستخدم مرتجع المبيعات للبضاعة المسلمة",
        );
      }
      for (const row of rows)
        await declareConsignmentReturn(
          {
            ...normalized,
            consignmentId: Number(row.id),
            clientRequestId: normalized.clientRequestId
              ? memberKey(normalized, Number(row.id))
              : null,
          },
          actor,
          tx,
          { shipmentMember: true },
        );
    },
  );
}

export async function cancelShipmentAssignment(
  input: ShipmentReasonInput,
  actor: DeliveryTxActor,
) {
  return executeShipment(
    "delivery.cancelShipment",
    input,
    actor,
    async (tx, rows) => {
      for (const row of rows)
        await cancelDeliveryAssignmentInTx(
          tx,
          {
            ...input,
            consignmentId: Number(row.id),
            clientRequestId: memberKey(input, Number(row.id)),
          },
          actor,
          { shipmentMember: true },
        );
    },
  );
}

export async function returnShipment(
  input: ReturnShipmentInput,
  actor: DeliveryTxActor,
) {
  if (input.reason.trim().length < 2)
    reject("سبب رجوع الشحنة مطلوب", "اكتب سبب الرجوع بعد استلام الشحنة وفحصها");
  let refundShiftId: number | null = null;
  return executeShipment(
    "delivery.returnShipment",
    input,
    actor,
    async (tx, rows) => {
      const original = await loadShipmentMembersTx(tx, input.consignmentId, {
        currentRead: true,
      });
      const invoiceRows = await tx
        .select({ returnedTotal: invoices.returnedTotal })
        .from(invoices)
        .where(
          inArray(
            invoices.id,
            rows.map((row) => Number(row.invoiceId)),
          ),
        )
        .for("update");
      if (
        invoiceRows.some((invoice) => money(invoice.returnedTotal ?? "0").gt(0))
      )
        reject(
          "إحدى الفواتير المتبقية سبق إرجاع جزء منها",
          "استكمل مرتجع كل فاتورة من صفحة الفاتورة لحفظ الكميات والمبالغ المتبقية",
        );
      for (const row of rows)
        await returnConsignment(
          Number(row.id),
          {
            ...actor,
            returnReason: input.reason,
            refundShiftId: input.refundShiftId,
            clientRequestId: memberKey(input, Number(row.id)),
          },
          tx,
          { shipmentMember: true },
        );
      for (const source of original.filter((row) =>
        money(row.deliveryFee).gt(0),
      ))
        await refundHeldDeliveryFeeForReturnTx(
          tx,
          source,
          actor,
          refundShiftId == null ? null : { shiftId: refundShiftId },
        );
    },
    async (tx, rows) => {
      const invoiceIds = rows.map((row) => Number(row.invoiceId));
      const invoiceRows = await tx
        .select({ id: invoices.id, paidAmount: invoices.paidAmount })
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds));
      const unsettledFees = rows.filter((row) => row.feeSettledAt == null);
      const feeRows = await tx
        .select({
          invoiceId: receipts.invoiceId,
          amount: receipts.amount,
          direction: receipts.direction,
          paymentMethod: receipts.paymentMethod,
        })
        .from(receipts)
        .where(
          and(
            inArray(
              receipts.invoiceId,
              unsettledFees.map((row) => Number(row.invoiceId)),
            ),
            inArray(
              receipts.referenceNumber,
              unsettledFees.flatMap((row) => [
                `DLV-FEE-INV-${row.invoiceId}`,
                row.consignmentNumber,
              ]),
            ),
            inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
            eq(receipts.approvalStatus, "APPROVED"),
          ),
        );
      const feeByInvoice = new Map<number, Decimal>();
      for (const row of feeRows.filter((r) => r.paymentMethod === "CASH")) {
        const id = Number(row.invoiceId);
        feeByInvoice.set(
          id,
          (feeByInvoice.get(id) ?? money(0)).plus(
            row.direction === "IN"
              ? money(row.amount)
              : money(row.amount).neg(),
          ),
        );
      }
      const cashCaps = await Promise.all(
        invoiceRows
          .filter((invoice) => money(invoice.paidAmount).gt(0))
          .map((invoice) => loadRefundCaps(tx, Number(invoice.id))),
      );
      if (
        cashCaps.some((cap) =>
          (cap.netByMethod.get("CASH") ?? money(0)).gt(0),
        ) ||
        Array.from(feeByInvoice.values()).some((fee) => fee.gt(0))
      ) {
        const cash = await resolveBranchCashShiftTx(
          tx,
          Number(rows[0].branchId),
          input.refundShiftId ?? null,
        );
        refundShiftId = cash.shiftId;
        await lockCashSourceForUpdate(tx, {
          branchId: Number(rows[0].branchId),
          cashBucket: "DRAWER",
          shiftId: cash.shiftId,
        });
      }
    },
    async (tx) => {
      const source = (
        await tx
          .select({
            sourceType: deliveryConsignments.sourceType,
            invoiceId: deliveryConsignments.invoiceId,
          })
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, input.consignmentId))
          .limit(1)
      )[0];
      if (source?.sourceType === "AFTERCARE_EXECUTION") {
        const routed = await routeAftercareDeliveryResultTx(
          tx,
          {
            consignmentId: input.consignmentId,
            result: "RETURNED",
            proof: input.reason,
            clientRequestId: input.clientRequestId,
            authorization: {
              kind: "STAFF",
              operationPath: "delivery.returnConsignment",
              operationAuthority: actor.operationAuthority,
            },
          },
          actor,
        );
        if (routed.handled)
          return {
            consignmentId: input.consignmentId,
            consignmentIds: [input.consignmentId],
            idempotentReplay: routed.replay,
          };
      }
      if (
        source?.sourceType === "FULFILLMENT_REQUEST" &&
        source.invoiceId == null
      ) {
        const requestSource = await returnFulfillmentRequestConsignmentTx(
          tx,
          {
            consignmentId: input.consignmentId,
            reason: input.reason,
            clientRequestId: input.clientRequestId,
          },
          actor,
        );
        if (requestSource.handled)
          return {
            consignmentId: input.consignmentId,
            consignmentIds: [input.consignmentId],
            idempotentReplay: false,
          };
      }
      return null;
    },
  );
}

export async function reassignShipmentDriver(
  input: ReassignShipmentDriverInput,
  actor: DeliveryTxActor,
) {
  return executeShipment(
    "delivery.reassignShipment",
    input,
    actor,
    async (tx, rows, partyId) => {
      for (const row of rows)
        await reassignDeliveryConsignment(
          {
            partyId,
            consignmentId: Number(row.id),
            assignedUserId: input.assignedUserId,
            clientRequestId: memberKey(input, Number(row.id)),
          },
          actor,
          tx,
          { shipmentMember: true },
        );
    },
  );
}

export async function markShipmentFailed(
  input: ShipmentReasonInput,
  actor: DeliveryTxActor,
) {
  return executeShipment(
    "delivery.failShipment",
    input,
    actor,
    async (tx, rows) => {
      for (const row of rows)
        await staffMarkFailed(
          {
            ...input,
            consignmentId: Number(row.id),
            clientRequestId: memberKey(input, Number(row.id)),
          },
          actor,
          tx,
          { shipmentMember: true },
        );
    },
  );
}
