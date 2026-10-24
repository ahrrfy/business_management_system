import { and, eq, inArray, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import {
  customers,
  suppliers,
  users,
  deliveryParties,
  deliveryConsignments,
  deliveryEvents,
  accountingEntries,
  receipts,
  shifts,
} from "../../../drizzle/schema";
import {
  fulfillmentCharges,
  fulfillmentChargePayments,
  fulfillmentRequestItems,
  fulfillmentRequests,
  type FulfillmentCharge,
} from "../../../drizzle/fulfillmentSchema";
import type {
  FulfillmentChargeCategory,
  FulfillmentMutationIdentity,
} from "../../../shared/fulfillment";
import { moduleAccessAllowed } from "../../../shared/permissions";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { retryOnDup } from "../../lib/retryDup";
import { assertCreditLimit } from "../../lib/credit";
import { withTx, type Actor } from "../tx";
import { money, toDbMoney } from "../money";
import { logAuditTx } from "../auditService";
import { reserveExternalRefundConfirmationTx } from "../externalRefundConfirmation";
import { assertOperationAuthorityTx } from "../authorization/operationAuthority";
import {
  adjustCustomerBalance,
  adjustDeliveryBalance,
  adjustSupplierBalance,
  postEntry,
} from "../ledgerService";
import {
  assertCashOutAvailable,
  lockMaterializedCashReceiptSourceForWrite,
  authorizeExternalTreasuryDisbursement,
  assertApprovedTreasuryOutAvailable,
} from "../cash/cashAvailability";
import {
  lockConfirmedExternalPaymentAttempt,
  consumeExternalReceiptAllocationsTx,
} from "../posExternalPayment";
import { shortfallAssignedForConsignmentTx } from "../delivery/openParcelPredicates";
import { deliveryRemitIntent } from "../delivery/posting";
import { settleAssignedChargeAtCounterTx } from "./chargeDelivery";
import {
  appendDeliveryEvent,
  appendDeliveryLedgerEntry,
  assertConsignmentStatusTransition,
} from "../delivery/lifecycle";
import {
  assertFulfillmentBranch,
  assertFulfillmentVersion,
  fulfillmentError,
  fulfillmentMutationContext,
  findFulfillmentReplayTx,
  recordFulfillmentMutationTx,
  loadFulfillmentChargeTx,
  loadFulfillmentRequestTx,
} from "./core";
import {
  chargeAccrualIntent,
  chargeCollectionIntent,
  chargeCostIntent,
  chargeCreditIntent,
  chargeRefundIntent,
  chargePayeeIntent,
  chargePayableRole,
  chargeCustodyIntent,
  immediateServiceIntent,
} from "./chargePosting";
import type {
  CheckoutServiceCharge,
  CheckoutChargeAllocation,
} from "../../../shared/checkoutCharges";
import {
  authorizeCheckoutServicesTx,
  assertCheckoutAuthorityTx,
  type CheckoutAuthorityPath,
} from "../checkoutChargesPolicy";
import {
  fulfillmentCostVisibleTx,
  projectFulfillmentChargeCost,
} from "./visibility";

export type ChargeTender = {
  method: "CASH" | "CARD" | "TRANSFER" | "WALLET";
  cashBucket?: "DRAWER" | "TREASURY" | null;
  shiftId?: number | null;
  reference?: string | null;
  externalPaymentAttemptId?: number | null;
  externalPaymentDeviceId?: string | null;
};
export type CreateFulfillmentChargeInput = {
  branchId: number;
  requestId?: number | null;
  customerId?: number | null;
  category: FulfillmentChargeCategory;
  description: string;
  amount: string;
  externalCost: string;
  payeeSupplierId?: number | null;
  payeePartyId?: number | null;
  payeeUserId?: number | null;
  payeeName?: string | null;
  payeePhone?: string | null;
  reason?: string | null;
  clientRequestId: string;
};
type Transition = FulfillmentMutationIdentity & { id: number };
export type ChargeAllocation = {
  chargeId: number;
  expectedVersion: number;
  amount: string;
};
export type CollectFulfillmentChargesInput = {
  branchId: number;
  clientRequestId: string;
  allocations: ChargeAllocation[];
  amount: string;
  tender: ChargeTender;
};
type CourierCollection = {
  branchId: number;
  clientRequestId: string;
  allocations: ChargeAllocation[];
  partyId: number;
  consignmentId: number;
};

const zero = () => money("0");
function positive(raw: string): Decimal {
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(raw))
    throw fulfillmentError("المبلغ غير صالح أو يتجاوز دقة الدينار المعتمدة");
  const value = money(raw);
  if (!value.gt(0)) throw fulfillmentError("المبلغ يجب أن يكون موجباً");
  return value;
}
/** Refunds cancel the refunded part of the claim; they never reopen it for collection. */
export function chargeRemaining(
  row: Pick<FulfillmentCharge, "amount" | "paidAmount">,
): string {
  return toDbMoney(money(row.amount).minus(row.paidAmount));
}
export function assertChargeClassification(
  input: CreateFulfillmentChargeInput,
): void {
  const amount = money(input.amount),
    cost = money(input.externalCost);
  if (
    !amount.isFinite() ||
    !cost.isFinite() ||
    amount.lt(0) ||
    cost.lt(0) ||
    amount.decimalPlaces() > 2 ||
    cost.decimalPlaces() > 2
  )
    throw fulfillmentError("قيمة الأجر أو تكلفة الجهة غير صالحة");
  if (!input.description.trim() || input.description.length > 2000)
    throw fulfillmentError("بيان الأجر مطلوب ولا يتجاوز 2000 محرف");
  if (
    input.category === "SHOP_EXPENSE"
      ? !amount.isZero() || !cost.gt(0)
      : !amount.gt(0) || !input.customerId
  )
    throw fulfillmentError(
      "مصروف المكتبة بلا مطالبة عميل؛ بقية الأجور تحتاج مبلغاً موجباً وعميلاً معروفاً",
    );
  if (input.category === "SERVICE" && !cost.isZero())
    throw fulfillmentError(
      "أجر خدمة المكتبة لا يحمل تكلفة متعهد؛ اختر خدمة منفذة خارجياً",
    );
  if (input.category === "OUTSOURCED" && !cost.gt(0))
    throw fulfillmentError("الخدمة الخارجية تحتاج تكلفة متعهد موجبة");
  if (input.category === "PASS_THROUGH" && (!amount.eq(cost) || !cost.gt(0)))
    throw fulfillmentError(
      "التحصيل بالنيابة يساوي استحقاق المستفيد بالضبط؛ افصل هامش المكتبة في أجر خدمة",
    );
  const identities = [
    input.payeeSupplierId,
    input.payeePartyId,
    input.payeeUserId,
    input.payeeName?.trim(),
  ].filter(Boolean).length;
  if (cost.gt(0) && identities !== 1)
    throw fulfillmentError(
      "حدد مستفيداً واحداً من تكلفة الجهة: مورد أو ناقل أو موظف أو اسم خارجي موثق",
    );
  if (cost.gt(0) && input.payeeName?.trim() && !input.payeePhone?.trim())
    throw fulfillmentError("المستفيد الخارجي المسمى يحتاج هاتفاً موثقاً");
}
export async function assertChargeOperationTx(
  tx: Tx,
  actor: Actor,
  action: string,
  manager = false,
  read = false,
) {
  await assertOperationAuthorityTx(
    tx,
    actor,
    `delivery.fulfillment.charges.${action}`,
    (current) =>
      moduleAccessAllowed(
        current.role ?? "",
        current.persistedPermissionsOverride,
        "store",
        read ? "READ" : "FULL",
        manager ? ["manager"] : ["cashier", "manager"],
      ),
  );
}
function context(
  action: string,
  input: { clientRequestId: string },
  actor: Actor,
  branchId: number,
) {
  return fulfillmentMutationContext(
    `charge.${action}.${branchId}`,
    input,
    input,
    actor,
    branchId,
  );
}
async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  row: FulfillmentCharge,
  value: unknown,
) {
  await logAuditTx(
    tx,
    { userId: actor.userId, branchId: row.branchId },
    {
      action: `delivery.fulfillment.charges.${action}`,
      entityType: "fulfillmentCharge",
      entityId: row.id,
      newValue: value,
    },
  );
}
async function checkPayeeTx(
  tx: Tx,
  input: CreateFulfillmentChargeInput,
  actor: Actor,
) {
  if (
    input.payeeSupplierId &&
    !(
      await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(eq(suppliers.id, input.payeeSupplierId))
        .for("update")
        .limit(1)
    )[0]
  )
    throw fulfillmentError("المورد المستفيد غير موجود");
  if (input.payeePartyId) {
    const [party] = await tx
      .select()
      .from(deliveryParties)
      .where(eq(deliveryParties.id, input.payeePartyId))
      .for("update")
      .limit(1);
    if (!party || !party.isActive)
      throw fulfillmentError("جهة التوصيل المستفيدة غير متاحة");
    if (party.branchId != null)
      assertFulfillmentBranch(
        { ...actor, branchId: input.branchId, role: "cashier", isOwner: false },
        party.branchId,
      );
  }
  if (input.payeeUserId) {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, input.payeeUserId))
      .limit(1);
    if (!user?.isActive || user.branchId !== input.branchId)
      throw fulfillmentError("الموظف المستفيد غير نشط أو يتبع فرعاً آخر");
  }
}
export function createFulfillmentCharge(
  input: CreateFulfillmentChargeInput,
  actor: Actor,
) {
  assertFulfillmentBranch(actor, input.branchId);
  assertChargeClassification(input);
  return retryOnDup(() =>
    withTx(async (tx) => {
      await assertChargeOperationTx(tx, actor, "create");
      const ctx = context("create", input, actor, input.branchId);
      if (input.requestId) {
        const request = await loadFulfillmentRequestTx(
          tx,
          input.requestId,
          actor,
          { lock: true },
        );
        if (
          request.branchId !== input.branchId ||
          request.status === "CANCELLED" ||
          (input.customerId && request.customerId !== input.customerId)
        )
          throw fulfillmentError(
            "عميل أو فرع مستند الأجر لا يطابق طلب التوصيل الحي",
          );
      }
      if (
        input.customerId &&
        !(
          await tx
            .select({ id: customers.id })
            .from(customers)
            .where(eq(customers.id, input.customerId))
            .for("update")
            .limit(1)
        )[0]
      )
        throw fulfillmentError("العميل غير موجود");
      const replay = await findFulfillmentReplayTx(tx, ctx);
      if (replay)
        return projectFulfillmentChargeCost(
          await loadFulfillmentChargeTx(tx, replay, actor),
          await fulfillmentCostVisibleTx(tx, actor),
        );
      await checkPayeeTx(tx, input, actor);
      const result = await tx.insert(fulfillmentCharges).values({
        ...input,
        description: input.description.trim(),
        payeeName: input.payeeName?.trim() || null,
        payeePhone: input.payeePhone?.trim() || null,
        amount: toDbMoney(money(input.amount)),
        externalCost: toDbMoney(money(input.externalCost)),
        createdBy: actor.userId,
        sourceHash: ctx.sourceHash,
      });
      const row = await loadFulfillmentChargeTx(
        tx,
        extractInsertId(result),
        actor,
      );
      await recordFulfillmentMutationTx(tx, ctx, row.id);
      await audit(tx, actor, "create", row, {
        category: row.category,
        amount: row.amount,
        externalCost: row.externalCost,
      });
      return projectFulfillmentChargeCost(
        row,
        await fulfillmentCostVisibleTx(tx, actor),
      );
    }),
  );
}
export function approveFulfillmentCharge(input: Transition, actor: Actor) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      await assertChargeOperationTx(tx, actor, "approve", true);
      if (!(await fulfillmentCostVisibleTx(tx, actor)))
        throw fulfillmentError(
          "اعتماد الأجر يتطلب صلاحية عرض التكلفة والربح الحالية",
          "FORBIDDEN",
        );
      const row = await loadFulfillmentChargeTx(tx, input.id, actor, {
        lock: true,
      });
      const ctx = context("approve", input, actor, row.branchId);
      if (await findFulfillmentReplayTx(tx, ctx)) return row;
      assertFulfillmentVersion(row, input.expectedVersion);
      if (row.status !== "DRAFT")
        throw fulfillmentError("مستند الأجر ليس مسودة قابلة للاعتماد");
      if (money(row.externalCost).gt(0) && row.createdBy === actor.userId)
        throw fulfillmentError(
          "اعتماد المصروف أو استحقاق الجهة يحتاج مسؤولاً مستقلاً عن منشئه",
          "FORBIDDEN",
        );
      assertChargeClassification({
        ...row,
        clientRequestId: input.clientRequestId,
      });
      if (money(row.amount).gt(0)) {
        // The request proves COD eligibility; standalone/deferred claims always follow the existing credit policy.
        let cod = false;
        if (row.requestId) {
          const request = await loadFulfillmentRequestTx(
            tx,
            row.requestId,
            actor,
            { lock: true },
          );
          const [assigned] = await tx
            .select({ id: deliveryEvents.id })
            .from(deliveryEvents)
            .where(
              eq(
                deliveryEvents.eventKey,
                `FULFILLMENT_CHARGES_ASSIGNED:${request.id}`,
              ),
            )
            .for("share")
            .limit(1);
          if (assigned)
            throw fulfillmentError(
              "انطلقت مطالبة هذا الطلب؛ أضف الأجر الجديد بمستند مستقل أو طلب لاحق حتى لا تتغير مطالبة الناقل دون إقرار",
            );
          cod =
            request.status !== "CANCELLED" &&
            request.customerId === row.customerId;
        }
        await assertCreditLimit(
          tx,
          row.customerId!,
          row.amount,
          row.branchId,
          cod ? "COD" : "CREDIT",
        );
        const intent = chargeAccrualIntent(row.category, money(row.amount));
        const revenue =
          row.category === "PASS_THROUGH" ? zero() : money(row.amount);
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId: row.branchId,
          customerId: row.customerId,
          amount: money(row.amount),
          revenue,
          profit: revenue,
          createdBy: actor.userId,
          dedupeKey: `FULFILLMENT_CHARGE_ACCRUAL:${row.id}`,
          notes: row.description,
          postingIntent: intent,
          postingSourceComponents: {
            roleDebits: { AR: row.amount },
            roleCredits: {
              [row.category === "PASS_THROUGH"
                ? "OTHER_LIABILITY"
                : "OTHER_REVENUE"]: row.amount,
            },
          },
        });
        await adjustCustomerBalance(tx, row.customerId!, money(row.amount));
      }
      if (money(row.externalCost).gt(0) && row.category !== "PASS_THROUGH") {
        const payable = chargePayableRole(row),
          intent = chargeCostIntent(money(row.externalCost), payable);
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId: row.branchId,
          supplierId: row.payeeSupplierId,
          deliveryPartyId: row.payeePartyId,
          amount: money(row.externalCost),
          cost: money(row.externalCost),
          profit: money(row.externalCost).negated(),
          createdBy: actor.userId,
          dedupeKey: `FULFILLMENT_CHARGE_COST:${row.id}`,
          notes: row.description,
          postingIntent: intent,
          postingSourceComponents: {
            roleDebits: { OPERATING_EXPENSE: row.externalCost },
            roleCredits: { [payable]: row.externalCost },
          },
        });
        if (row.payeeSupplierId)
          await adjustSupplierBalance(
            tx,
            row.payeeSupplierId,
            money(row.externalCost),
          );
      }
      await tx
        .update(fulfillmentCharges)
        .set({
          status: "APPROVED",
          approvedBy: actor.userId,
          approvedAt: new Date(),
          version: row.version + 1,
        })
        .where(eq(fulfillmentCharges.id, row.id));
      await recordFulfillmentMutationTx(tx, ctx, row.id);
      await audit(tx, actor, "approve", row, { approvedBy: actor.userId });
      return loadFulfillmentChargeTx(tx, row.id, actor);
    }),
  );
}

async function lockTenderTx(
  tx: Tx,
  tender: ChargeTender,
  branchId: number,
  actor: Actor,
  direction: "IN" | "OUT",
  amount: Decimal,
) {
  const bucket =
    tender.method === "CASH" ? (tender.cashBucket ?? "DRAWER") : null;
  if (bucket === "TREASURY")
    await assertChargeOperationTx(
      tx,
      actor,
      direction === "OUT" ? "settlePayee" : "collect",
      true,
    );
  if (bucket === "DRAWER") {
    const [shift] = await tx
      .select()
      .from(shifts)
      .where(eq(shifts.id, tender.shiftId ?? -1))
      .for("update")
      .limit(1);
    if (
      !shift ||
      shift.status !== "OPEN" ||
      shift.branchId !== branchId ||
      shift.userId !== actor.userId
    )
      throw fulfillmentError(
        "اختر ورديتك المفتوحة في فرع المستند لتنفيذ حركة الدرج",
      );
  }
  if (bucket) {
    await lockMaterializedCashReceiptSourceForWrite(tx, {
      branchId,
      shiftId: tender.shiftId,
      paymentMethod: "CASH",
      cashBucket: bucket,
      status: "COMPLETED",
    });
    if (direction === "OUT" && bucket === "TREASURY") {
      const approval = await authorizeExternalTreasuryDisbursement(tx, {
        actor,
        makerUserIds: [],
        branchIds: [branchId],
        operation: "صرف مستند أجور",
      });
      await assertApprovedTreasuryOutAvailable(
        tx,
        { branchId, amount, operation: "صرف مستند أجور" },
        approval,
      );
    } else if (direction === "OUT")
      await assertCashOutAvailable(tx, {
        branchId,
        shiftId: tender.shiftId,
        cashBucket: bucket,
        amount,
        operation: "صرف مستند أجور",
      });
  }
  if (tender.method !== "CASH" && !tender.reference?.trim())
    throw fulfillmentError("مرجع العملية غير النقدية الفعلي مطلوب");
  return bucket;
}
async function writeReceiptTx(
  tx: Tx,
  row: Pick<
    FulfillmentCharge,
    | "id"
    | "branchId"
    | "customerId"
    | "payeeSupplierId"
    | "payeeName"
    | "approvedBy"
  >,
  tender: ChargeTender,
  amount: Decimal,
  actor: Actor,
  direction: "IN" | "OUT",
  description: string,
  customer = true,
) {
  const bucket = await lockTenderTx(
    tx,
    tender,
    row.branchId,
    actor,
    direction,
    amount,
  );
  const result = await tx.insert(receipts).values({
    branchId: row.branchId,
    shiftId: bucket === "DRAWER" ? tender.shiftId : null,
    direction,
    amount: toDbMoney(amount),
    paymentMethod: tender.method,
    cashBucket: bucket,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    partyType: customer
      ? "CUSTOMER"
      : row.payeeSupplierId
        ? "SUPPLIER"
        : "OTHER",
    partyId: customer ? row.customerId : row.payeeSupplierId,
    counterpartyName: customer ? null : row.payeeName,
    referenceNumber: tender.reference?.trim() || `FC-${row.id}`,
    internalNote:
      tender.method === "CASH"
        ? null
        : JSON.stringify({
            externalPaymentReference: tender.reference?.trim(),
            externalPaymentAttemptId: tender.externalPaymentAttemptId ?? null,
          }),
    description,
    createdBy: actor.userId,
    executedBy: actor.userId,
    executedAt: new Date(),
    approvedBy: direction === "OUT" ? row.approvedBy : null,
  });
  return { receiptId: extractInsertId(result), bucket };
}
/** Internal checkout composition. No router accepts policy evidence or posting lines. */
export async function createCheckoutServicesInTx(
  tx: Tx,
  input: {
    branchId: number;
    customerId?: number | null;
    clientRequestId: string;
    services: CheckoutServiceCharge[];
    authorityPath?: CheckoutAuthorityPath;
  },
  actor: Actor,
) {
  const proof = await authorizeCheckoutServicesTx(
    tx,
    actor,
    input.branchId,
    input.services,
    input.authorityPath,
  );
  const rows: FulfillmentCharge[] = [];
  if (
    input.customerId &&
    !(
      await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .for("update")
        .limit(1)
    )[0]
  )
    throw fulfillmentError("العميل غير موجود");
  for (let index = 0; index < input.services.length; index++) {
    const line = input.services[index];
    const identity = { ...input, index };
    const ctx = context("checkoutService", identity, actor, input.branchId);
    const result = await tx.insert(fulfillmentCharges).values({
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      category: "SERVICE",
      status: "APPROVED",
      description: line.description.trim(),
      amount: toDbMoney(money(line.amount)),
      externalCost: "0.00",
      // Guests can exist only as fully collected immediate services, within this transaction.
      paidAmount: input.customerId ? "0.00" : toDbMoney(money(line.amount)),
      createdBy: actor.userId,
      approvedBy: actor.userId,
      approvedAt: new Date(),
      clientRequestId: `CHK-SVC:${ctx.sourceHash}`,
      sourceHash: ctx.sourceHash,
    });
    const row = await loadFulfillmentChargeTx(
      tx,
      extractInsertId(result),
      actor,
      { lock: true },
    );
    if (row.customerId) {
      const amount = money(row.amount);
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: row.branchId,
        customerId: row.customerId,
        amount,
        revenue: amount,
        profit: amount,
        createdBy: actor.userId,
        dedupeKey: `FULFILLMENT_CHARGE_ACCRUAL:${row.id}`,
        notes: row.description,
        postingIntent: chargeAccrualIntent("SERVICE", amount),
        postingSourceComponents: {
          roleDebits: { AR: row.amount },
          roleCredits: { OTHER_REVENUE: row.amount },
        },
      });
      await adjustCustomerBalance(tx, row.customerId, amount);
    }
    await audit(tx, actor, "checkoutService", row, {
      ...proof,
      description: row.description,
      amount: row.amount,
    });
    rows.push(row);
  }
  return rows;
}

/** Lock approved sources once before receipts or sale effects. Deferred charges always have a real customer. */
export async function lockCheckoutChargeAllocationsTx(
  tx: Tx,
  input: {
    branchId: number;
    customerId?: number | null;
    allocations: ChargeAllocation[];
    authorityPath?: CheckoutAuthorityPath;
  },
  actor: Actor,
) {
  if (!input.allocations.length) return [];
  await assertCheckoutAuthorityTx(
    tx,
    actor,
    input.authorityPath ?? "sales.create",
  );
  const rows = await lockAllocationsTx(
    tx,
    input.allocations,
    actor,
    input.branchId,
  );
  assertAllocations(rows, input.allocations);
  if (rows.some((row) => row.customerId !== input.customerId))
    throw fulfillmentError("أجور القبض المعتمدة يجب أن تخص عميل العملية نفسه");
  return rows;
}

/** Creates a real retained receipt; provider consumption belongs to the whole checkout orchestrator. */
export async function collectCheckoutChargePortionTx(
  tx: Tx,
  input: {
    branchId: number;
    customerId?: number | null;
    clientRequestId: string;
    sourceHash: string;
    paymentIndex: number;
    tender: ChargeTender;
    allocations: Array<{
      row: FulfillmentCharge;
      amount: string;
      immediateGuest?: boolean;
    }>;
  },
  actor: Actor,
): Promise<{ receiptId: number; allocations: CheckoutChargeAllocation[] }> {
  const amount = input.allocations.reduce(
    (sum, item) => sum.plus(positive(item.amount)),
    zero(),
  );
  const first = input.allocations[0]?.row;
  if (!first || !amount.gt(0)) throw fulfillmentError("تخصيص الأجور فارغ");
  const { receiptId, bucket } = await writeReceiptTx(
    tx,
    first,
    input.tender,
    amount,
    actor,
    "IN",
    `قبض أجور العملية ${input.clientRequestId}`,
  );
  const result: CheckoutChargeAllocation[] = [];
  for (const item of input.allocations) {
    const row = await loadFulfillmentChargeTx(tx, item.row.id, actor, {
      lock: true,
    });
    const value = positive(item.amount),
      guest = item.immediateGuest === true;
    if (
      row.branchId !== input.branchId ||
      row.customerId !== (input.customerId ?? null) ||
      row.status !== "APPROVED" ||
      (guest
        ? row.customerId != null ||
          row.category !== "SERVICE" ||
          !money(row.externalCost).isZero()
        : value.gt(money(chargeRemaining(row))))
    )
      throw fulfillmentError("تغير مصدر الأجر أو تجاوز تخصيص القبض المتبقي");
    const cash = paymentAccountRole(input.tender.method, bucket, "IN");
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: row.branchId,
      customerId: row.customerId,
      receiptId,
      amount: value,
      revenue: guest ? value : zero(),
      profit: guest ? value : zero(),
      paymentMethod: input.tender.method,
      createdBy: actor.userId,
      dedupeKey: `CHECKOUT_CHARGE:${row.id}:R:${receiptId}`,
      notes: row.description,
      postingIntent: guest
        ? immediateServiceIntent(value, input.tender.method, bucket)
        : chargeCollectionIntent(value, value, input.tender.method, bucket),
      postingSourceComponents: {
        roleDebits: { [cash]: item.amount },
        roleCredits: { [guest ? "OTHER_REVENUE" : "AR"]: item.amount },
      },
    });
    if (row.customerId)
      await adjustCustomerBalance(tx, row.customerId, value.negated());
    const inserted = await tx
      .insert(fulfillmentChargePayments)
      .values({
        chargeId: row.id,
        branchId: row.branchId,
        kind: "COLLECTION",
        receiptId,
        amount: toDbMoney(value),
        createdBy: actor.userId,
      clientRequestId: `CHK:${input.sourceHash}:${input.paymentIndex}`,
        sourceHash: input.sourceHash,
      });
    if (!guest)
      await tx
        .update(fulfillmentCharges)
        .set({
          paidAmount: toDbMoney(money(row.paidAmount).plus(value)),
          version: row.version + 1,
        })
        .where(eq(fulfillmentCharges.id, row.id));
    await settleAssignedChargeAtCounterTx(
      tx,
      { chargeId: row.id, amount: toDbMoney(value), receiptId },
      actor,
    );
    result.push({
      chargeId: row.id,
      paymentId: extractInsertId(inserted),
      receiptId,
      paymentIndex: input.paymentIndex,
      amount: toDbMoney(value),
    });
  }
  await tx.update(receipts).set({internalNote:JSON.stringify({
    externalPaymentReference:input.tender.reference??null,externalPaymentAttemptId:input.tender.externalPaymentAttemptId??null,
    checkoutChargeCollection:{requestId:input.clientRequestId,sourceHash:input.sourceHash,allocatedAmount:toDbMoney(amount),allocations:result},
  })}).where(eq(receipts.id,receiptId));
  return { receiptId, allocations: result };
}
/** Reserve the actual OUT receipt globally before any refund ledger/allocation effect. */
async function reserveChargeRefundConfirmationTx(
  tx: Tx,
  receiptId: number,
  tender: ChargeTender,
) {
  if (tender.method === "CASH") return;
  const reference = tender.reference?.trim();
  if (!reference)
    throw fulfillmentError(
      "سجل مرجع رد المزوّد المنفذ على وسيلة القبض الأصلية",
    );
  await reserveExternalRefundConfirmationTx(tx, {
    receiptId,
    method: tender.method,
    reference,
  });
}
async function lockAllocationsTx(
  tx: Tx,
  allocations: ChargeAllocation[],
  actor: Actor,
  branchId: number,
) {
  if (
    !allocations.length ||
    allocations.length > 50 ||
    new Set(allocations.map((a) => a.chargeId)).size !== allocations.length
  )
    throw fulfillmentError("حدد من 1 إلى 50 مطالبة دون تكرار");
  const rows: FulfillmentCharge[] = [];
  for (const id of allocations.map((a) => a.chargeId).sort((a, b) => a - b)) {
    const row = await loadFulfillmentChargeTx(tx, id, actor, { lock: true });
    if (row.branchId !== branchId)
      throw fulfillmentError("كل تخصيصات القبض يجب أن تتبع الفرع نفسه");
    rows.push(row);
  }
  if (new Set(rows.map((r) => r.customerId)).size !== 1 || !rows[0].customerId)
    throw fulfillmentError("تخصيصات القبض تحتاج عميلاً معروفاً واحداً");
  return rows;
}
function assertAllocations(
  rows: FulfillmentCharge[],
  allocations: ChargeAllocation[],
) {
  for (const row of rows) {
    const allocation = allocations.find((a) => a.chargeId === row.id)!;
    assertFulfillmentVersion(row, allocation.expectedVersion);
    if (
      row.status !== "APPROVED" ||
      positive(allocation.amount).gt(money(chargeRemaining(row)))
    )
      throw fulfillmentError(
        "تخصيص القبض يتجاوز المتبقي أو يستهدف مستنداً غير معتمد",
      );
  }
}
export function collectFulfillmentCharges(
  input: CollectFulfillmentChargesInput,
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      await assertChargeOperationTx(tx, actor, "collect");
      assertFulfillmentBranch(actor, input.branchId);
      const rows = await lockAllocationsTx(
          tx,
          input.allocations,
          actor,
          input.branchId,
        ),
        first = rows[0];
      const ctx = context("collect", input, actor, input.branchId);
      const replay = await findFulfillmentReplayTx(tx, ctx);
      if (replay) return { receiptId: replay, replayed: true };
      assertAllocations(rows, input.allocations);
      const allocated = input.allocations.reduce(
          (sum, a) => sum.plus(positive(a.amount)),
          zero(),
        ),
        amount = positive(input.amount);
      if (amount.lt(allocated))
        throw fulfillmentError("المقبوض الفعلي أقل من مجموع التخصيصات");
      let tender = input.tender;
      if (tender.method !== "CASH") {
        const proof = await lockConfirmedExternalPaymentAttempt(
          tx,
          {
            branchId: input.branchId,
            channel: "SALES_COLLECTION",
            method: tender.method,
            amount: toDbMoney(amount),
            attemptId: tender.externalPaymentAttemptId,
            deviceId: tender.externalPaymentDeviceId,
          },
          actor,
        );
        tender = { ...tender, reference: proof.externalReference };
      }
      const { receiptId, bucket } = await writeReceiptTx(
        tx,
        first,
        tender,
        amount,
        actor,
        "IN",
        `قبض أجور الطلب — ${input.allocations.map((a) => a.chargeId).join(", ")}`,
      );
      const cash = paymentAccountRole(tender.method, bucket, "IN");
      const excess = amount.minus(allocated),
        intent = chargeCollectionIntent(
          amount,
          allocated,
          tender.method,
          bucket,
        );
      await tx
        .update(receipts)
        .set({
          internalNote: JSON.stringify({
            externalPaymentReference: tender.reference ?? null,
            externalPaymentAttemptId: tender.externalPaymentAttemptId ?? null,
            fulfillmentChargeCollection: {
              allocatedAmount: toDbMoney(allocated),
              excessLiabilityAmount: toDbMoney(excess),
            },
          }),
        })
        .where(eq(receipts.id, receiptId));
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        customerId: first.customerId,
        receiptId,
        amount,
        paymentMethod: tender.method,
        createdBy: actor.userId,
        dedupeKey: `FULFILLMENT_CHARGE_COLLECTION:R:${receiptId}`,
        notes: `قبض أجور؛ فائض أمانة عميل ${toDbMoney(excess)}`,
        postingIntent: intent,
        postingSourceComponents: {
          roleDebits: { [cash]: input.amount },
          roleCredits: {
            AR: toDbMoney(allocated),
            ...(excess.gt(0) ? { OTHER_LIABILITY: toDbMoney(excess) } : {}),
          },
        },
      });
      await adjustCustomerBalance(tx, first.customerId!, allocated.negated());
      for (const row of rows) {
        const amount = positive(
          input.allocations.find((a) => a.chargeId === row.id)!.amount,
        );
        await tx.insert(fulfillmentChargePayments).values({
          chargeId: row.id,
          branchId: row.branchId,
          kind: "COLLECTION",
          receiptId,
          amount: toDbMoney(amount),
          createdBy: actor.userId,
          clientRequestId: input.clientRequestId,
          sourceHash: ctx.sourceHash,
        });
        await tx
          .update(fulfillmentCharges)
          .set({
            paidAmount: toDbMoney(money(row.paidAmount).plus(amount)),
            version: row.version + 1,
          })
          .where(eq(fulfillmentCharges.id, row.id));
        await settleAssignedChargeAtCounterTx(
          tx,
          { chargeId: row.id, amount: toDbMoney(amount), receiptId },
          actor,
        );
        await audit(tx, actor, "collect", row, {
          receiptId,
          amount: toDbMoney(amount),
          excess: toDbMoney(excess),
        });
      }
      if (tender.method !== "CASH")
        await consumeExternalReceiptAllocationsTx(
          tx,
          {
            branchId: input.branchId,
            channel: "SALES_COLLECTION",
            method: tender.method,
            amount: toDbMoney(amount),
            attemptId: tender.externalPaymentAttemptId,
            deviceId: tender.externalPaymentDeviceId,
          },
          [receiptId],
          actor,
        );
      await recordFulfillmentMutationTx(tx, ctx, receiptId);
      return { receiptId, replayed: false };
    }),
  );
}

export function refundFulfillmentCharge(
  input: Transition & {
    originalPaymentId: number;
    amount: string;
    reason: string;
    reference?: string | null;
  },
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      await assertChargeOperationTx(tx, actor, "refund", true);
      const row = await loadFulfillmentChargeTx(tx, input.id, actor, {
          lock: true,
        }),
        ctx = context("refund", input, actor, row.branchId);
      const replay = await findFulfillmentReplayTx(tx, ctx);
      if (replay) return { receiptId: replay };
      assertFulfillmentVersion(row, input.expectedVersion);
      if (row.status !== "APPROVED" || input.reason.trim().length < 5)
        throw fulfillmentError("الرد يحتاج أجرًا معتمداً وسبباً موثقاً");
      const [original] = await tx
        .select()
        .from(fulfillmentChargePayments)
        .where(eq(fulfillmentChargePayments.id, input.originalPaymentId))
        .for("update")
        .limit(1);
      if (
        !original ||
        original.chargeId !== row.id ||
        !["COLLECTION", "COURIER_REMITTANCE"].includes(original.kind) ||
        !original.receiptId
      )
        throw fulfillmentError(
          "الرد يحتاج تخصيص قبض أصلياً؛ ورد عهدة المندوب أولاً إن لم يكن قد وردها",
        );
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, original.receiptId))
        .limit(1);
      if (
        !receipt ||
        receipt.branchId !== row.branchId ||
        receipt.direction !== "IN" ||
        receipt.status !== "COMPLETED" ||
        receipt.approvalStatus !== "APPROVED"
      )
        throw fulfillmentError("إيصال القبض الأصلي غير صالح للرد");
      const previous = await tx
        .select({ amount: fulfillmentChargePayments.amount })
        .from(fulfillmentChargePayments)
        .where(
          and(
            eq(fulfillmentChargePayments.originalPaymentId, original.id),
            eq(fulfillmentChargePayments.kind, "REFUND"),
          ),
        );
      const amount = positive(input.amount),
        refunded = previous.reduce((s, p) => s.plus(money(p.amount)), zero());
      if (
        amount.plus(refunded).gt(money(original.amount)) ||
        amount.plus(money(row.refundedAmount)).gt(money(row.paidAmount))
      )
        throw fulfillmentError("مبلغ الرد يتجاوز صافي تخصيص القبض الأصلي");
      if (
        row.category === "PASS_THROUGH" &&
        money(row.externalCost)
          .minus(row.payeePaidAmount)
          .lt(amount.plus(row.refundedAmount))
      )
        throw fulfillmentError(
          "دُفع هذا الجزء للمستفيد؛ وثق استعادته من الجهة قبل رد الأمانة",
        );
      if (
        !["CASH", "CARD", "TRANSFER", "WALLET"].includes(receipt.paymentMethod)
      )
        throw fulfillmentError("وسيلة القبض الأصلية تحتاج مسار رد متخصص");
      let shiftId: number | null = null;
      if (receipt.paymentMethod === "CASH" && receipt.cashBucket === "DRAWER") {
        const [shift] = await tx
          .select({ id: shifts.id })
          .from(shifts)
          .where(
            and(
              eq(shifts.userId, actor.userId),
              eq(shifts.branchId, row.branchId),
              eq(shifts.status, "OPEN"),
            ),
          )
          .orderBy(shifts.id)
          .limit(1);
        shiftId = shift?.id ?? null;
      }
      const tender: ChargeTender = {
        method: receipt.paymentMethod as ChargeTender["method"],
        cashBucket: receipt.cashBucket,
        shiftId,
        reference: input.reference,
      };
      if (tender.method !== "CASH" && !input.reference?.trim())
        throw fulfillmentError(
          "سجل مرجع رد المزوّد المنفذ على وسيلة القبض الأصلية",
        );
      const { receiptId, bucket } = await writeReceiptTx(
        tx,
        row,
        tender,
        amount,
        actor,
        "OUT",
        `رد أجر ${row.id} من تخصيص ${original.id} / إيصال ${receipt.id}: ${input.reason}`,
      );
      await reserveChargeRefundConfirmationTx(tx, receiptId, tender);
      const debit =
        row.category === "PASS_THROUGH" ? "OTHER_LIABILITY" : "OTHER_REVENUE";
      const credit = chargeCreditIntent(row.category, amount),
        intent = chargeRefundIntent(amount, tender.method, bucket);
      const revenue =
        row.category === "PASS_THROUGH" ? zero() : amount.negated();
      if (!row.customerId) {
        if (row.category !== "SERVICE" || !money(row.externalCost).isZero())
          throw fulfillmentError(
            "رد أجر عابر يتطلب خدمة مكتبة مدفوعة بلا تكلفة خارجية",
          );
        const cash = paymentAccountRole(tender.method, bucket, "OUT");
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: row.branchId,
          receiptId,
          amount,
          revenue,
          profit: revenue,
          paymentMethod: tender.method,
          createdBy: actor.userId,
          dedupeKey: `FULFILLMENT_SERVICE_REFUND:R:${receiptId}`,
          notes: input.reason,
          postingIntent: immediateServiceIntent(
            amount,
            tender.method,
            bucket,
            true,
          ),
          postingSourceComponents: {
            roleDebits: { OTHER_REVENUE: input.amount },
            roleCredits: { [cash]: input.amount },
          },
        });
      } else {
        await postEntry(tx, {
        entryType: "ADJUST",
        branchId: row.branchId,
        customerId: row.customerId,
        amount: amount.negated(),
        revenue,
        profit: revenue,
        createdBy: actor.userId,
        dedupeKey: `FULFILLMENT_CHARGE_CREDIT:R:${receiptId}`,
        notes: input.reason,
        postingIntent: credit,
        postingSourceComponents: {
          roleDebits: { [debit]: input.amount },
          roleCredits: { AR: input.amount },
        },
      });
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: row.branchId,
        customerId: row.customerId,
        receiptId,
        amount,
        paymentMethod: tender.method,
        createdBy: actor.userId,
        dedupeKey: `FULFILLMENT_CHARGE_REFUND:R:${receiptId}`,
        notes: input.reason,
        postingIntent: intent,
        postingSourceComponents: {
          roleDebits: { AR: input.amount },
          roleCredits: {
            [paymentAccountRole(tender.method, bucket, "OUT")]: input.amount,
          },
        },
      });
      }
      await tx.insert(fulfillmentChargePayments).values({
        chargeId: row.id,
        branchId: row.branchId,
        kind: "REFUND",
        originalPaymentId: original.id,
        receiptId,
        amount: toDbMoney(amount),
        createdBy: actor.userId,
        clientRequestId: input.clientRequestId,
        sourceHash: ctx.sourceHash,
      });
      await tx
        .update(fulfillmentCharges)
        .set({
          refundedAmount: toDbMoney(money(row.refundedAmount).plus(amount)),
          version: row.version + 1,
        })
        .where(eq(fulfillmentCharges.id, row.id));
      await recordFulfillmentMutationTx(tx, ctx, receiptId);
      await audit(tx, actor, "refund", row, {
        originalPaymentId: original.id,
        receiptId,
        amount: input.amount,
        reason: input.reason,
      });
      return { receiptId };
    }),
  );
}

/** Refund an overcollection liability, without changing the claim or AR a second time. */
export function refundFulfillmentChargeExcess(
  input: Transition & {
    originalReceiptId: number;
    amount: string;
    reason: string;
    reference?: string | null;
  },
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      await assertChargeOperationTx(tx, actor, "refundExcess", true);
      const row = await loadFulfillmentChargeTx(tx, input.id, actor, {
          lock: true,
        }),
        ctx = context("excessRefund", input, actor, row.branchId);
      const replay = await findFulfillmentReplayTx(tx, ctx);
      if (replay) return { receiptId: replay };
      assertFulfillmentVersion(row, input.expectedVersion);
      const [source] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, input.originalReceiptId))
        .for("update")
        .limit(1);
      if (
        !source ||
        source.branchId !== row.branchId ||
        source.partyType !== "CUSTOMER" ||
        source.partyId !== row.customerId ||
        source.direction !== "IN" ||
        source.status !== "COMPLETED" ||
        source.approvalStatus !== "APPROVED"
      )
        throw fulfillmentError(
          "حدد إيصال قبض الأجور الأصلي لهذا العميل والفرع",
        );
      const allocated = await tx
        .select()
        .from(fulfillmentChargePayments)
        .where(
          and(
            eq(fulfillmentChargePayments.receiptId, source.id),
            eq(fulfillmentChargePayments.kind, "COLLECTION"),
          ),
        );
      if (!allocated.some((a) => a.chargeId === row.id))
        throw fulfillmentError("الإيصال لا يتضمن تخصيصاً لهذا الأجر");
      const prior = await tx
        .select({ amount: receipts.amount })
        .from(receipts)
        .where(
          and(
            eq(receipts.referenceNumber, `FC-EXCESS-${source.id}`),
            eq(receipts.direction, "OUT"),
            eq(receipts.status, "COMPLETED"),
          ),
        );
      const amount = positive(input.amount),
        excess = money(source.amount)
          .minus(allocated.reduce((s, a) => s.plus(money(a.amount)), zero()))
          .minus(prior.reduce((s, a) => s.plus(money(a.amount)), zero()));
      if (amount.gt(excess) || input.reason.trim().length < 5)
        throw fulfillmentError(
          "الرد يتجاوز فائض القبض غير المردود أو يفتقد سبباً موثقاً",
        );
      if (
        !["CASH", "CARD", "TRANSFER", "WALLET"].includes(source.paymentMethod)
      )
        throw fulfillmentError("وسيلة الأصل تحتاج مسار رد متخصص");
      const [shift] =
        source.paymentMethod === "CASH" && source.cashBucket === "DRAWER"
          ? await tx
              .select({ id: shifts.id })
              .from(shifts)
              .where(
                and(
                  eq(shifts.branchId, row.branchId),
                  eq(shifts.userId, actor.userId),
                  eq(shifts.status, "OPEN"),
                ),
              )
              .orderBy(shifts.id)
              .limit(1)
          : [];
      const tender: ChargeTender = {
        method: source.paymentMethod as ChargeTender["method"],
        cashBucket: source.cashBucket,
        shiftId: shift?.id ?? null,
        reference: input.reference,
      };
      const { receiptId, bucket } = await writeReceiptTx(
        tx,
        row,
        tender,
        amount,
        actor,
        "OUT",
        `رد فائض إيصال ${source.id}: ${input.reason}`,
        false,
      );
      await reserveChargeRefundConfirmationTx(tx, receiptId, tender);
      await tx
        .update(receipts)
        .set({
          partyType: "OTHER",
          partyId: null,
          referenceNumber: `FC-EXCESS-${source.id}`,
          counterpartyName: `عميل ${row.customerId}`,
          internalNote: JSON.stringify({
            originalReceiptId: source.id,
            providerRefundReference: input.reference ?? null,
          }),
        })
        .where(eq(receipts.id, receiptId));
      const cash = paymentAccountRole(tender.method, bucket, "OUT");
      const intent = createPostingIntent(
        "FULFILLMENT_CHARGE_EXCESS_REFUND",
        "PAYMENT_OUT",
        [debitLine("OTHER_LIABILITY", amount), creditLine(cash, amount)],
        {
          roleDebits: { OTHER_LIABILITY: amount },
          roleCredits: { [cash]: amount },
        },
      );
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: row.branchId,
        customerId: row.customerId,
        receiptId,
        amount,
        createdBy: actor.userId,
        paymentMethod: tender.method,
        dedupeKey: `FULFILLMENT_CHARGE_EXCESS_REFUND:R:${receiptId}`,
        notes: `FC-EXCESS-${source.id}: ${input.reason}`,
        postingIntent: intent,
        postingSourceComponents: {
          roleDebits: { OTHER_LIABILITY: input.amount },
          roleCredits: { [cash]: input.amount },
        },
      });
      await tx
        .update(fulfillmentCharges)
        .set({ version: row.version + 1 })
        .where(eq(fulfillmentCharges.id, row.id));
      await recordFulfillmentMutationTx(tx, ctx, receiptId);
      await audit(tx, actor, "refundExcess", row, {
        originalReceiptId: source.id,
        receiptId,
        amount: input.amount,
      });
      return { receiptId };
    }),
  );
}

/** The courier's excess remains an asset until remittance, even if the shop refunds the customer first. */
export function refundFulfillmentCourierExcess(
  input: Omit<Transition, "id"> & {
    id?: number;
    fulfillmentRequestId?: number;
    originalExcessEntryId: number;
    consignmentId: number;
    amount: string;
    reason: string;
    tender: ChargeTender;
  },
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      await assertChargeOperationTx(tx, actor, "refundCourierExcess", true);
      if ((input.id == null) === (input.fulfillmentRequestId == null))
        throw fulfillmentError("حدد مصدر رد واحداً: أجر أو طلب توصيل حقيقي");
      const charge =
        input.id != null
          ? await loadFulfillmentChargeTx(tx, input.id, actor, { lock: true })
          : null;
      const request =
        input.fulfillmentRequestId != null
          ? await loadFulfillmentRequestTx(
              tx,
              input.fulfillmentRequestId,
              actor,
              { lock: true },
            )
          : null;
      const source = charge ?? request;
      if (!source) throw fulfillmentError("مصدر رد الأمانة غير موجود");
      const requestId = charge?.requestId ?? request?.id;
      if (!requestId)
        throw fulfillmentError("رد الأمانة يتطلب طلب توصيل حقيقياً");
      const row = {
        id: source.id,
        branchId: source.branchId,
        customerId: source.customerId,
        payeeSupplierId: null,
        payeeName: null,
        approvedBy: charge?.approvedBy ?? null,
      };
      const ctx = context("courierExcessRefund", input, actor, row.branchId);
      const replay = await findFulfillmentReplayTx(tx, ctx);
      if (replay) return { receiptId: replay };
      assertFulfillmentVersion(source, input.expectedVersion);
      if (input.tender.method !== "CASH" || input.reason.trim().length < 5)
        throw fulfillmentError(
          "أصل القبض الزائد بعهدة المندوب نقدي؛ الرد يحتاج مصدراً نقدياً متاحاً وسبباً موثقاً",
        );
      const [cn] = await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, input.consignmentId))
        .for("update")
        .limit(1);
      const [evidence] = await tx
        .select()
        .from(accountingEntries)
        .where(eq(accountingEntries.id, input.originalExcessEntryId))
        .for("update")
        .limit(1);
      if (
        !cn ||
        cn.branchId !== row.branchId ||
        cn.fulfillmentRequestId !== requestId ||
        (cn.endCustomerId != null && cn.endCustomerId !== row.customerId) ||
        !evidence ||
        evidence.entryType !== "PAYMENT_IN" ||
        evidence.branchId !== row.branchId ||
        evidence.customerId !== row.customerId ||
        !evidence.dedupeKey?.startsWith(
          `FULFILLMENT_COURIER_EXCESS:${cn.id}:`,
        ) ||
        !money(evidence.amount).gt(0) ||
        evidence.entryDate.getTime() > Date.now()
      )
        throw fulfillmentError(
          "قيد القبض الزائد الأصلي لا يطابق العميل أو الفرع أو الإرسالية أو التاريخ",
        );
      const ref = `FC-COURIER-EXCESS:${evidence.id}`;
      const previous = await tx
        .select({ amount: receipts.amount })
        .from(receipts)
        .where(
          and(
            eq(receipts.referenceNumber, ref),
            eq(receipts.direction, "OUT"),
            sql`${receipts.status} IN ('COMPLETED','REVERSED')`,
          ),
        );
      const amount = positive(input.amount),
        refunded = previous.reduce(
          (sum, p) => sum.plus(money(p.amount)),
          zero(),
        );
      if (amount.plus(refunded).gt(money(evidence.amount)))
        throw fulfillmentError("الرد يتجاوز صافي أمانة القبض الزائد الأصلية");
      const { receiptId, bucket } = await writeReceiptTx(
        tx,
        row,
        input.tender,
        amount,
        actor,
        "OUT",
        `رد أمانة قبض زائد / إرسالية ${cn.consignmentNumber} / قيد ${evidence.id}: ${input.reason}`,
        false,
      );
      await tx
        .update(receipts)
        .set({
          partyType: "OTHER",
          partyId: null,
          counterpartyName:
            request?.recipientName ??
            cn.recipientName ??
            `مستلم ${cn.consignmentNumber}`,
          referenceNumber: ref,
          internalNote: JSON.stringify({
            originalExcessEntryId: evidence.id,
            fulfillmentRequestId: requestId,
            consignmentId: cn.id,
            originalPaymentMethod: "CASH",
            reason: input.reason,
          }),
        })
        .where(eq(receipts.id, receiptId));
      const cash = paymentAccountRole("CASH", bucket, "OUT");
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: row.branchId,
        customerId: row.customerId,
        receiptId,
        amount,
        createdBy: actor.userId,
        paymentMethod: "CASH",
        dedupeKey: `FULFILLMENT_CHARGE_EXCESS_REFUND:R:${receiptId}`,
        notes: `${ref}: ${input.reason}`,
        postingIntent: createPostingIntent(
          "FULFILLMENT_CHARGE_EXCESS_REFUND",
          "PAYMENT_OUT",
          [debitLine("OTHER_LIABILITY", amount), creditLine(cash, amount)],
          {
            roleDebits: { OTHER_LIABILITY: amount },
            roleCredits: { [cash]: amount },
          },
        ),
        postingSourceComponents: {
          roleDebits: { OTHER_LIABILITY: input.amount },
          roleCredits: { [cash]: input.amount },
        },
      });
      if (charge)
        await tx
          .update(fulfillmentCharges)
          .set({ version: charge.version + 1 })
          .where(eq(fulfillmentCharges.id, charge.id));
      else if (request)
        await tx
          .update(fulfillmentRequests)
          .set({ version: request.version + 1 })
          .where(eq(fulfillmentRequests.id, request.id));
      await recordFulfillmentMutationTx(tx, ctx, receiptId);
      await logAuditTx(
        tx,
        { userId: actor.userId, branchId: row.branchId },
        {
          action: "delivery.fulfillment.charges.refundCourierExcess",
          entityType: charge ? "fulfillmentCharge" : "fulfillmentRequest",
          entityId: source.id,
          newValue: {
            receiptId,
            originalExcessEntryId: evidence.id,
            consignmentId: cn.id,
            amount: input.amount,
            reason: input.reason,
          },
        },
      );
      return { receiptId };
    }),
  );
}

export function settleFulfillmentChargePayee(
  input: Transition & { amount: string; tender: ChargeTender },
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      await assertChargeOperationTx(tx, actor, "settlePayee");
      if (!(await fulfillmentCostVisibleTx(tx, actor)))
        throw fulfillmentError(
          "سداد المستفيد يتطلب صلاحية عرض التكلفة والربح الحالية",
          "FORBIDDEN",
        );
      const row = await loadFulfillmentChargeTx(tx, input.id, actor, {
          lock: true,
        }),
        ctx = context("payee", input, actor, row.branchId);
      const replay = await findFulfillmentReplayTx(tx, ctx);
      if (replay) return { receiptId: replay };
      assertFulfillmentVersion(row, input.expectedVersion);
      if (
        row.status !== "APPROVED" ||
        !row.approvedBy ||
        row.approvedBy === row.createdBy
      )
        throw fulfillmentError(
          "سداد الجهة يحتاج استحقاقاً معتمداً من مسؤول مستقل عن منشئه",
        );
      const amount = positive(input.amount),
        available = money(row.externalCost)
          .minus(row.payeePaidAmount)
          .minus(row.category === "PASS_THROUGH" ? row.refundedAmount : "0");
      if (amount.gt(available))
        throw fulfillmentError("السداد يتجاوز استحقاق المستفيد غير المبرأ");
      if (
        row.category === "PASS_THROUGH" &&
        amount.gt(
          money(row.paidAmount)
            .minus(row.refundedAmount)
            .minus(row.payeePaidAmount),
        )
      )
        throw fulfillmentError("لا تسدد أمانة لم تُقبض فعلياً من العميل");
      const { receiptId, bucket } = await writeReceiptTx(
        tx,
        row,
        input.tender,
        amount,
        actor,
        "OUT",
        `سداد مستفيد أجر ${row.id}: ${row.description}`,
        false,
      );
      const payable =
        row.category === "PASS_THROUGH"
          ? "OTHER_LIABILITY"
          : chargePayableRole(row);
      // The pass-through liability belongs to the charge's named payee, never to supplier trade AP.
      const intent =
        row.category === "PASS_THROUGH"
          ? chargePassThroughPayeeIntent(amount, input.tender.method, bucket)
          : chargePayeeIntent(
              amount,
              chargePayableRole(row),
              input.tender.method,
              bucket,
            );
      const cash = paymentAccountRole(input.tender.method, bucket, "OUT");
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: row.branchId,
        receiptId,
        supplierId:
          row.category === "PASS_THROUGH" ? null : row.payeeSupplierId,
        deliveryPartyId: row.payeePartyId,
        amount,
        paymentMethod: input.tender.method,
        createdBy: actor.userId,
        dedupeKey: `FULFILLMENT_CHARGE_PAYEE:R:${receiptId}`,
        notes: row.description,
        postingIntent: intent,
        postingSourceComponents: {
          roleDebits: { [payable]: input.amount },
          roleCredits: { [cash]: input.amount },
        },
      });
      if (row.payeeSupplierId && row.category !== "PASS_THROUGH")
        await adjustSupplierBalance(tx, row.payeeSupplierId, amount.negated());
      await tx.insert(fulfillmentChargePayments).values({
        chargeId: row.id,
        branchId: row.branchId,
        kind: "PAYEE_PAYMENT",
        receiptId,
        amount: toDbMoney(amount),
        createdBy: actor.userId,
        clientRequestId: input.clientRequestId,
        sourceHash: ctx.sourceHash,
      });
      await tx
        .update(fulfillmentCharges)
        .set({
          payeePaidAmount: toDbMoney(money(row.payeePaidAmount).plus(amount)),
          version: row.version + 1,
        })
        .where(eq(fulfillmentCharges.id, row.id));
      await recordFulfillmentMutationTx(tx, ctx, receiptId);
      await audit(tx, actor, "settlePayee", row, {
        receiptId,
        amount: input.amount,
      });
      return { receiptId };
    }),
  );
}

import {
  createPostingIntent,
  debitLine,
  creditLine,
} from "../accounting/postingEngine";
import { paymentAccountRole } from "../delivery/posting";
function chargePassThroughPayeeIntent(
  amount: Decimal,
  method: string,
  bucket: "DRAWER" | "TREASURY" | null,
) {
  const cash = paymentAccountRole(method, bucket, "OUT");
  return createPostingIntent(
    "FULFILLMENT_CHARGE_PAYEE",
    "PAYMENT_OUT",
    [debitLine("OTHER_LIABILITY", amount), creditLine(cash, amount)],
    {
      roleDebits: { OTHER_LIABILITY: amount },
      roleCredits: { [cash]: amount },
    },
  );
}

export function recordFulfillmentChargeCourierCollection(
  input: CourierCollection,
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      await assertChargeOperationTx(tx, actor, "recordCourierCollection");
      const rows = await lockAllocationsTx(
          tx,
          input.allocations,
          actor,
          input.branchId,
        ),
        ctx = context("custody", input, actor, input.branchId);
      if (await findFulfillmentReplayTx(tx, ctx))
        return { chargeId: rows[0].id, replayed: true };
      assertAllocations(rows, input.allocations);
      const [consignment] = await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, input.consignmentId))
        .for("update")
        .limit(1);
      if (
        !consignment ||
        consignment.branchId !== input.branchId ||
        consignment.partyId !== input.partyId ||
        ["CANCELLED", "RETURNED"].includes(consignment.status)
      )
        throw fulfillmentError(
          "إرسالية التحصيل لا تطابق جهة التوصيل أو الفرع أو الحالة",
        );
      const links = await tx
        .select({ requestId: fulfillmentRequestItems.requestId })
        .from(fulfillmentRequestItems)
        .where(eq(fulfillmentRequestItems.consignmentId, input.consignmentId));
      const linked = new Set(links.map((l) => l.requestId));
      if (consignment.fulfillmentRequestId != null)
        linked.add(consignment.fulfillmentRequestId);
      if (rows.some((r) => !r.requestId || !linked.has(r.requestId)))
        throw fulfillmentError("مطالبة الأجر ليست من طلبات هذه الإرسالية");
      const total = input.allocations.reduce(
          (s, a) => s.plus(positive(a.amount)),
          zero(),
        ),
        intent = chargeCustodyIntent(total);
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        customerId: rows[0].customerId,
        deliveryPartyId: input.partyId,
        amount: total,
        createdBy: actor.userId,
        dedupeKey: `FULFILLMENT_CHARGE_CUSTODY:${input.branchId}:${input.clientRequestId}`,
        notes: `تحصيل أجور بعهدة الناقل / إرسالية ${input.consignmentId}`,
        postingIntent: intent,
        postingSourceComponents: {
          roleDebits: { DELIVERY_FLOAT: toDbMoney(total) },
          roleCredits: { AR: toDbMoney(total) },
        },
      });
      await adjustCustomerBalance(tx, rows[0].customerId!, total.negated());
      await adjustDeliveryBalance(tx, input.partyId, total);
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `CN:${input.consignmentId}:CHARGE_COLLECTED:${ctx.sourceHash.slice(0, 32)}`,
        partyId: input.partyId,
        consignmentId: input.consignmentId,
        branchId: input.branchId,
        entryType: "COD_COLLECTED",
        amount: toDbMoney(total),
        actorUserId: actor.userId,
      });
      await tx
        .update(deliveryConsignments)
        .set({
          custodyRecognizedAt: consignment.custodyRecognizedAt ?? new Date(),
        })
        .where(eq(deliveryConsignments.id, input.consignmentId));
      for (const row of rows) {
        const amount = positive(
          input.allocations.find((a) => a.chargeId === row.id)!.amount,
        );
        await tx.insert(fulfillmentChargePayments).values({
          chargeId: row.id,
          branchId: row.branchId,
          kind: "COURIER_COLLECTION",
          partyId: input.partyId,
          consignmentId: input.consignmentId,
          amount: toDbMoney(amount),
          createdBy: actor.userId,
          clientRequestId: input.clientRequestId,
          sourceHash: ctx.sourceHash,
        });
        await tx
          .update(fulfillmentCharges)
          .set({
            paidAmount: toDbMoney(money(row.paidAmount).plus(amount)),
            version: row.version + 1,
          })
          .where(eq(fulfillmentCharges.id, row.id));
        await audit(tx, actor, "recordCourierCollection", row, {
          partyId: input.partyId,
          consignmentId: input.consignmentId,
          amount: toDbMoney(amount),
        });
      }
      await recordFulfillmentMutationTx(tx, ctx, rows[0].id);
      return { chargeId: rows[0].id, replayed: false };
    }),
  );
}
export function remitFulfillmentChargeCourier(
  input: Transition & {
    originalPaymentId: number;
    amount: string;
    tender: ChargeTender;
  },
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      await assertChargeOperationTx(tx, actor, "remitCourier");
      const row = await loadFulfillmentChargeTx(tx, input.id, actor, {
          lock: true,
        }),
        ctx = context("remit", input, actor, row.branchId);
      const replay = await findFulfillmentReplayTx(tx, ctx);
      if (replay) return { receiptId: replay };
      assertFulfillmentVersion(row, input.expectedVersion);
      const [original] = await tx
        .select()
        .from(fulfillmentChargePayments)
        .where(eq(fulfillmentChargePayments.id, input.originalPaymentId))
        .for("update")
        .limit(1);
      if (
        !original ||
        original.chargeId !== row.id ||
        original.kind !== "COURIER_COLLECTION" ||
        !original.partyId
      )
        throw fulfillmentError("حدد تحصيل الجهة الأصلي قبل التوريد");
      const remittances = await tx
        .select({ amount: fulfillmentChargePayments.amount })
        .from(fulfillmentChargePayments)
        .where(
          and(
            eq(fulfillmentChargePayments.chargeId, row.id),
            eq(
              fulfillmentChargePayments.consignmentId,
              original.consignmentId!,
            ),
            eq(fulfillmentChargePayments.kind, "COURIER_REMITTANCE"),
          ),
        );
      const amount = positive(input.amount);
      const collections = await tx
        .select({ amount: fulfillmentChargePayments.amount })
        .from(fulfillmentChargePayments)
        .where(
          and(
            eq(fulfillmentChargePayments.chargeId, row.id),
            eq(
              fulfillmentChargePayments.consignmentId,
              original.consignmentId!,
            ),
            eq(fulfillmentChargePayments.kind, "COURIER_COLLECTION"),
          ),
        );
      if (
        amount
          .plus(remittances.reduce((s, r) => s.plus(money(r.amount)), zero()))
          .gt(collections.reduce((sum, p) => sum.plus(money(p.amount)), zero()))
      )
        throw fulfillmentError("التوريد يتجاوز العهدة غير الموردة");
      if (input.tender.method !== "CASH")
        throw fulfillmentError(
          "توريد المندوب يتطلب النقد الفعلي؛ التحويل يحتاج مسار إثبات مستقل",
        );
      const { receiptId, bucket } = await writeReceiptTx(
        tx,
        row,
        input.tender,
        amount,
        actor,
        "IN",
        `توريد عهدة أجور ${row.id} من الجهة ${original.partyId}`,
        false,
      );
      // Remittance is a transfer of custody. It never creates a second customer collection.
      await tx
        .update(receipts)
        .set({
          partyType: "OTHER",
          partyId: null,
          counterpartyName: `جهة توصيل ${original.partyId}`,
        })
        .where(eq(receipts.id, receiptId));
      const intent = deliveryRemitIntent(amount, bucket!);
      await postEntry(tx, {
        entryType: "DELIVERY_REMIT",
        branchId: row.branchId,
        deliveryPartyId: original.partyId,
        receiptId,
        amount,
        createdBy: actor.userId,
        dedupeKey: `FULFILLMENT_CHARGE_REMIT:R:${receiptId}`,
        notes: `توريد تخصيص أجر ${original.id}`,
        postingIntent: intent,
        postingSourceComponents: {
          roleDebits: {
            [bucket === "TREASURY" ? "TREASURY_CASH" : "CASH"]: input.amount,
          },
          roleCredits: { DELIVERY_FLOAT: input.amount },
        },
      });
      await adjustDeliveryBalance(tx, original.partyId, amount.negated());
      if (original.consignmentId != null) {
        const [cn] = await tx
          .select()
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, original.consignmentId))
          .for("update")
          .limit(1);
        if (
          !cn ||
          cn.branchId !== row.branchId ||
          cn.partyId !== original.partyId
        )
          throw fulfillmentError("مصدر عهدة الأجر لا يطابق جهة التوريد");
        const newCollected = money(cn.collectedAmount).plus(amount);
        const shortfallAssigned = await shortfallAssignedForConsignmentTx(
          tx,
          cn.id,
        );
        const financiallySettled = newCollected
          .plus(cn.counterSettledAmount ?? "0")
          .plus(shortfallAssigned)
          .gte(money(cn.codAmount));
        const nextStatus =
          financiallySettled && cn.parcelStatus === "DELIVERED"
            ? "DELIVERED"
            : "PARTIAL";
        assertConsignmentStatusTransition(cn.status, nextStatus);
        await tx
          .update(deliveryConsignments)
          .set({
            collectedAmount: toDbMoney(newCollected),
            status: nextStatus,
            moneyStatus: financiallySettled ? "SETTLED" : "PARTIAL",
            settledAt: financiallySettled ? (cn.settledAt ?? new Date()) : null,
          })
          .where(eq(deliveryConsignments.id, cn.id));
        await appendDeliveryLedgerEntry(tx, {
          eventKey: `CN:${cn.id}:CHARGE_REMITTED:${receiptId}`,
          partyId: cn.partyId,
          consignmentId: cn.id,
          branchId: cn.branchId,
          entryType: "COD_REMITTED",
          amount: toDbMoney(amount),
          actorUserId: actor.userId,
        });
      }
      await tx.insert(fulfillmentChargePayments).values({
        chargeId: row.id,
        branchId: row.branchId,
        kind: "COURIER_REMITTANCE",
        originalPaymentId: original.id,
        partyId: original.partyId,
        consignmentId: original.consignmentId,
        receiptId,
        amount: toDbMoney(amount),
        createdBy: actor.userId,
        clientRequestId: input.clientRequestId,
        sourceHash: ctx.sourceHash,
      });
      await tx
        .update(fulfillmentCharges)
        .set({ version: row.version + 1 })
        .where(eq(fulfillmentCharges.id, row.id));
      await recordFulfillmentMutationTx(tx, ctx, receiptId);
      await audit(tx, actor, "remitCourier", row, {
        receiptId,
        originalPaymentId: original.id,
        amount: input.amount,
      });
      return { receiptId };
    }),
  );
}
