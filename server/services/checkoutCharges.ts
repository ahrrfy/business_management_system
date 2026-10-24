import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { receipts,invoices } from "../../drizzle/schema";
import { fulfillmentCharges } from "../../drizzle/fulfillmentSchema";
import type { FulfillmentCharge } from "../../drizzle/fulfillmentSchema";
import { positiveMoneyString } from "../lib/schemas";
import { nonNegMoneyString } from "../lib/schemas";
import { withTx } from "./tx";
import { retryOnDup } from "../lib/retryDup";
import type { Tx } from "../db";
import type { Actor } from "./tx";
import type {
  CheckoutChargesInput,
  CheckoutChargesResult,
  CheckoutReceiptAllocation,
} from "../../shared/checkoutCharges";
import { money, toDbMoney } from "./money";
import {
  createCheckoutServicesInTx,
  lockCheckoutChargeAllocationsTx,
  collectCheckoutChargePortionTx,
} from "./fulfillment/charges";
import {
  fulfillmentError,
  fulfillmentMutationContext,
  findFulfillmentReplayTx,
  recordFulfillmentMutationTx,
} from "./fulfillment/core";
import {
  lockConfirmedExternalPaymentAttempt,
  consumeExternalReceiptAllocationsTx,
  type PosExternalPaymentChannel,
} from "./posExternalPayment";
import {
  assertCheckoutAuthorityTx,
  type CheckoutAuthorityPath,
} from "./checkoutChargesPolicy";
import { assertFulfillmentBranch } from "./fulfillment/core";
import {findIdempotentRefId,idempotencyHash} from "./idempotency";
const proofMarker=Symbol("checkout-allocation-proof");
export interface CheckoutAllocationProof {readonly [proofMarker]:true}
const activeProofs=new WeakMap<CheckoutAllocationProof,{tx:Tx;userId:number;branchId:number;requestId:string;legsHash:string;fee:string;references:ReadonlyMap<number,string>}>();
function proofLegsHash(input:CheckoutCompositionInput){
  return idempotencyHash((input.payments?.length?input.payments:input.payment?[input.payment]:[]).map(leg=>({method:leg.method,amount:toDbMoney(money(leg.amount)),attemptId:leg.externalPaymentAttemptId??null,deviceId:leg.externalPaymentDeviceId??input.deviceId??null})));
}
/** Private capability issued only while the genuine whole-checkout composer is executing. */
export function checkoutAllocationReferences(tx:Tx,actor:Actor,input:CheckoutCompositionInput,proof:CheckoutAllocationProof){
  const stored=activeProofs.get(proof);
  if(!stored||stored.tx!==tx||stored.userId!==actor.userId||stored.branchId!==input.branchId||stored.requestId!==input.clientRequestId||stored.legsHash!==proofLegsHash(input)||stored.fee!==toDbMoney(money(input.deliveryFeeHeld??"0")))
    throw fulfillmentError("تفويض تخصيص القبض لا يطابق المعاملة أو الفاعل أو الدفعات الحالية","FORBIDDEN");
  return stored.references;
}
export async function readCheckoutChargesMetadataTx(tx:Tx,input:{branchId:number;clientRequestId:string},actor:Actor,authorityPath:CheckoutAuthorityPath="workOrders.receptionCheckout"):Promise<Partial<CheckoutChargesResult>>{
  await assertCheckoutAuthorityTx(tx,actor,authorityPath);assertFulfillmentBranch(actor,input.branchId);
  const ref=await findIdempotentRefId(tx,`fulfillment.checkout.PRINT_POS.${input.branchId}`,input.clientRequestId);
  if(!ref)return {};
  const [receipt]=await tx.select().from(receipts).where(and(eq(receipts.id,ref),eq(receipts.branchId,input.branchId))).limit(1);
  let saved:{checkoutResult?:CheckoutChargesResult}|null=null;
  try{saved=receipt?.internalNote?JSON.parse(receipt.internalNote):null;}catch{throw fulfillmentError("دليل استرجاع تخصيص الأجور غير صالح؛ راجع الإيصال الأصلي","CONFLICT");}
  if(!saved?.checkoutResult)throw fulfillmentError("إيصال التثبيت الأصلي لا يحمل تخصيصات الأجور المحفوظة","CONFLICT");
  const {checkoutReceipts,checkoutPaymentSummary,chargeAllocations}=saved.checkoutResult;
  return {checkoutReceipts,checkoutPaymentSummary,chargeAllocations};
}
export const checkoutChargeOptionsSchema = z.object({
  branchId: z.number().int().positive(),
  customerId: z.number().int().positive(),
});
export function listCheckoutChargeOptions(
  input: z.infer<typeof checkoutChargeOptionsSchema>,
  actor: Actor,
  path: CheckoutAuthorityPath,
) {
  return withTx(
    async (tx) => {
      await assertCheckoutAuthorityTx(tx, actor, path);
      assertFulfillmentBranch(actor, input.branchId);
      const rows = await tx
        .select({
          id: fulfillmentCharges.id,
          version: fulfillmentCharges.version,
          description: fulfillmentCharges.description,
          amount: fulfillmentCharges.amount,
          paidAmount: fulfillmentCharges.paidAmount,
        })
        .from(fulfillmentCharges)
        .where(
          and(
            eq(fulfillmentCharges.branchId, input.branchId),
            eq(fulfillmentCharges.customerId, input.customerId),
            eq(fulfillmentCharges.status, "APPROVED"),
          ),
        )
        .limit(100);
      return rows
        .filter((row) => money(row.amount).gt(money(row.paidAmount)))
        .map((row) => ({
          id: row.id,
          version: row.version,
          description: row.description,
          remainingAmount: toDbMoney(money(row.amount).minus(row.paidAmount)),
        }));
    },
    { gate: "NONE" },
  );
}

export const checkoutChargesFields = {
  serviceCharges: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(2000),
        amount: positiveMoneyString,
      }).strict(),
    )
    .max(50)
    .optional(),
  approvedChargeAllocations: z
    .array(
      z.object({
        chargeId: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        amount: positiveMoneyString,
      }),
    )
    .max(50)
    .optional(),
  chargePayments: z
    .array(
      z.object({
        paymentIndex: z.number().int().min(0).max(9),
        amount: positiveMoneyString,
      }),
    )
    .max(10)
    .optional(),
};
export const checkoutChargesIntentSchema=z.object({
  serviceCharges:checkoutChargesFields.serviceCharges.default([]),
  approvedChargeAllocations:checkoutChargesFields.approvedChargeAllocations.default([]),
}).strict();
export function normalizeCheckoutChargesIntent(value:unknown){
  if(value==null)return null;
  const parsed=checkoutChargesIntentSchema.safeParse(value);
  if(!parsed.success)throw fulfillmentError("بيان الأجور المحفوظة أو مبالغها غير صالح؛ راجع خدمات الطلب قبل الحفظ");
  return parsed.data.serviceCharges.length||parsed.data.approvedChargeAllocations.length?parsed.data:null;
}
export const chargeOnlyCheckoutSchema = z.object({
  ...checkoutChargesFields,
  branchId: z.number().int().positive(),
  customerId: z.number().int().positive().nullish(),
  shiftId: z.number().int().positive().nullish(),
  clientRequestId: z.string().min(8).max(80),
  deviceId: z.string().trim().min(1).max(64).nullish(),
  payments: z
    .array(
      z.object({
        amount: nonNegMoneyString,
        method: z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]),
        externalPaymentAttemptId: z.number().int().positive().nullish(),
        externalPaymentDeviceId: z.string().trim().min(1).max(64).nullish(),
      }),
    )
    .min(1)
    .max(10),
});
export function createChargeOnlyCheckout(
  input: z.infer<typeof chargeOnlyCheckoutSchema>,
  actor: Actor,
  channel: PosExternalPaymentChannel,
  authorityPath?:CheckoutAuthorityPath,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      const composed = await composeCheckoutChargesInTx(
        tx,
        input,
        actor,
        channel,
        async () => ({
          result: {
            mode: "CHARGES" as const,
            recoveryToken: input.clientRequestId,
          },
          receiptIds: [],
        }),authorityPath,
      );
      return {
        ...composed.result,
        checkoutReceipts: composed.checkoutReceipts,
        checkoutPaymentSummary: composed.checkoutPaymentSummary,
        chargeAllocations: composed.chargeAllocations,
      };
    }),
  );
}
type Leg = {
  amount: string;
  method: string;
  reference?: string | null;
  externalPaymentAttemptId?: number | null;
  externalPaymentDeviceId?: string | null;
};
export type CheckoutCompositionInput = CheckoutChargesInput & {
  branchId: number;
  customerId?: number | null;
  shiftId?: number | null;
  clientRequestId?: string | null;
  deviceId?: string | null;
  payment?: Leg | null;
  payments?: Leg[] | null;
  deliveryFeeHeld?: string | null;
  deliveryFeeTender?: {
    method: string;
    reference?: string | null;
    externalPaymentAttemptId?: number | null;
    externalPaymentDeviceId?: string | null;
    combinedWithPaymentIndex?: number | null;
  } | null;
};
export function hasCheckoutCharges(input: CheckoutChargesInput) {
  return Boolean(
    input.serviceCharges?.length ||
    input.approvedChargeAllocations?.length ||
    input.chargePayments?.length,
  );
}

/** One local transaction and one provider proof per genuine tender; no browser financial chaining. */
export async function composeCheckoutChargesInTx<T>(
  tx: Tx,
  input: CheckoutCompositionInput,
  actor: Actor,
  channel: PosExternalPaymentChannel,
  executeGoods: (resolved: {
    payment?: Leg | null;
    payments?: Leg[] | null;
    deliveryFeeTender?: CheckoutCompositionInput["deliveryFeeTender"];
  },proof:CheckoutAllocationProof) => Promise<{ result: T; receiptIds: number[];receiptAllocations?:Array<{receiptId:number;paymentIndex:number;kind?:CheckoutReceiptAllocation["kind"]}> }>,
  authorityPath: CheckoutAuthorityPath = channel === "PRINT_POS"
    ? "printPos.createSale"
    : "sales.create",
): Promise<{ result: T } & CheckoutChargesResult> {
  if (!input.clientRequestId)
    throw fulfillmentError("القبض الموحد يحتاج مفتاح إعادة محاولة ثابتاً");
  await assertCheckoutAuthorityTx(tx, actor, authorityPath);
  const ctx = fulfillmentMutationContext(
    `checkout.${channel}.${input.branchId}`,
    { clientRequestId: input.clientRequestId },
    input,
    actor,
    input.branchId,
  );
  const replay = await findFulfillmentReplayTx(tx, ctx);
  if (replay) {
    const [row] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, replay))
      .for("update")
      .limit(1);
    let note:{checkoutResult?:{result:T}&CheckoutChargesResult}|null=null;
    try { note=row?.internalNote?JSON.parse(row.internalNote):null; }
    catch { throw fulfillmentError("دليل استرجاع القبض غير قابل للقراءة؛ راجع الإيصال الأصلي ولا تكرر الدفع","CONFLICT"); }
    if (!note?.checkoutResult)
      throw fulfillmentError(
        "تعذر استرجاع تخصيصات القبض الأصلية؛ راجع الإيصالات ولا تكرر الدفع",
        "CONFLICT",
      );
    const saved = note.checkoutResult as { result: T } & CheckoutChargesResult;
    await verifyCheckoutProofsTx(
      tx,
      input,
      actor,
      channel,
      saved.checkoutReceipts,
    );
    return { ...saved, result:saved.result&&typeof saved.result==="object"
      ? {...saved.result,idempotentReplay:true} : saved.result };
  }
  const [priorInvoice]=await tx.select({id:invoices.id}).from(invoices).where(eq(invoices.sourceId,input.clientRequestId)).for("update").limit(1);
  if(priorInvoice)throw fulfillmentError("مفتاح العملية مرتبط بفاتورة سابقة بلا تخصيصات قبض موحدة؛ افتح مستندها ولا تسجل قبضاً جديداً على المفتاح نفسه","CONFLICT");
  const services = input.serviceCharges ?? [],
    approved = input.approvedChargeAllocations ?? [],
    extras = input.chargePayments ?? [];
  const legs = input.payments?.length
    ? input.payments
    : input.payment
      ? [input.payment]
      : [];
  if (
    !legs.length ||
    legs.length > 10 ||
    new Set(extras.map((x) => x.paymentIndex)).size !== extras.length
  )
    throw fulfillmentError("حدد دفعات القبض وتخصيص أجر واحداً لكل دفعة");
  const requested = services
    .reduce((sum, x) => sum.plus(money(x.amount)), money("0"))
    .plus(approved.reduce((sum, x) => sum.plus(money(x.amount)), money("0")));
  const extraTotal = extras.reduce((sum, x) => {
    if (
      !Number.isInteger(x.paymentIndex) ||
      !legs[x.paymentIndex] ||
      !/^\d{1,13}(\.\d{1,2})?$/.test(x.amount) ||
      !money(x.amount).gt(0)
    )
      throw fulfillmentError("تخصيص دفع الأجر غير صالح");
    return sum.plus(money(x.amount));
  }, money("0"));
  if (!requested.gt(0) || !requested.eq(extraTotal))
    throw fulfillmentError(
      "مجموع قبض الأجور يجب أن يساوي قيمة الخدمات والمطالبات المختارة",
    );
  const approvedRows = await lockCheckoutChargeAllocationsTx(
    tx,
    {
      branchId: input.branchId,
      customerId: input.customerId,
      allocations: approved,
      authorityPath,
    },
    actor,
  );
  const groups = checkoutTenderGroups(input);
  const references = new Map<number, string>();
  const ids = new Set<number>();
  for (const group of [...groups].sort(
    (a, b) =>
      (a.leg.externalPaymentAttemptId ?? 0) -
      (b.leg.externalPaymentAttemptId ?? 0),
  )) {
    if (group.leg.method === "CASH") {
      if (group.leg.externalPaymentAttemptId != null)
        throw fulfillmentError("القبض النقدي لا يحمل إثبات دفع خارجي");
      continue;
    }
    if (
      group.leg.externalPaymentAttemptId == null ||
      ids.has(group.leg.externalPaymentAttemptId)
    )
      throw fulfillmentError(
        "كل عملية غير نقدية تحتاج إثباتاً مستقلاً؛ اربط الأجرة والأجر بدفعة البضاعة المشتركة",
      );
    ids.add(group.leg.externalPaymentAttemptId);
    const proof = await lockConfirmedExternalPaymentAttempt(
      tx,
      {
        branchId: input.branchId,
        channel,
        method: group.leg.method,
        amount: group.amount,
        attemptId: group.leg.externalPaymentAttemptId,
        deviceId: group.deviceId,
      },
      actor,
    );
    references.set(group.index, proof.externalReference);
  }
  const serviceRows = services.length
    ? await createCheckoutServicesInTx(
        tx,
        {
          branchId: input.branchId,
          customerId: input.customerId,
          clientRequestId: input.clientRequestId,
          services,
          authorityPath,
        },
        actor,
      )
    : [];
  const resolvedLegs = legs.map((leg, index) => ({
    ...leg,
    reference: references.get(index) ?? leg.reference,
  }));
  const feeIndex = input.deliveryFeeTender?.combinedWithPaymentIndex ?? -1;
  const resolvedFee = input.deliveryFeeTender
    ? {
        ...input.deliveryFeeTender,
        reference:
          references.get(feeIndex) ?? input.deliveryFeeTender.reference,
        externalPaymentAttemptId: feeIndex>=0
          ? legs[feeIndex].externalPaymentAttemptId
          : input.deliveryFeeTender.externalPaymentAttemptId,
        externalPaymentDeviceId:feeIndex>=0?legs[feeIndex].externalPaymentDeviceId??input.deviceId:input.deliveryFeeTender.externalPaymentDeviceId,
      }
    : undefined;
  const proof=Object.freeze({[proofMarker]:true as const});
  activeProofs.set(proof,{tx,userId:actor.userId,branchId:input.branchId,requestId:input.clientRequestId,legsHash:proofLegsHash(input),fee:toDbMoney(money(input.deliveryFeeHeld??"0")),references:new Map(references)});
  let goods:Awaited<ReturnType<typeof executeGoods>>;
  try {goods=await executeGoods({
    ...(input.payments?.length
      ? { payments: resolvedLegs }
      : { payment: resolvedLegs[0] }),
    deliveryFeeTender: resolvedFee,
  },proof);}finally{activeProofs.delete(proof);}
  const rawReceipts = goods.receiptIds.length
    ? await tx
        .select()
        .from(receipts)
        .where(inArray(receipts.id, goods.receiptIds))
        .orderBy(receipts.id)
    : [];
  const checkoutReceipts: CheckoutReceiptAllocation[] = [];
  let legIndex = 0;
  for (const receipt of rawReceipts) {
    const fee = receipt.referenceNumber?.startsWith("DLV-FEE-") === true;
    const mapped=goods.receiptAllocations?.find(row=>row.receiptId===receipt.id);
    if(goods.receiptAllocations&&!mapped)throw fulfillmentError("إيصال طلب الاستقبال غير موجود في تخصيص الدفعات الحقيقي");
    if(!receipt.branchId||receipt.branchId!==input.branchId||receipt.createdBy!==actor.userId||receipt.direction!=="IN"||receipt.status!=="COMPLETED"||receipt.approvalStatus!=="APPROVED")throw fulfillmentError("مصدر إيصال القبض لا يطابق الفرع والفاعل الحاليين");
    if (!fee&&!mapped) {
      while (
        legIndex < legs.length &&
        (!money(legs[legIndex].amount).gt(0) ||
          legs[legIndex].method !== receipt.paymentMethod)
      )
        legIndex++;
      if (legIndex >= legs.length)
        throw fulfillmentError("تعذر مطابقة إيصال البضاعة مع دفعة القبض");
    }
    checkoutReceipts.push({
      receiptId: receipt.id,
      paymentIndex:mapped?.paymentIndex??(fee ? feeIndex : legIndex++),
      method: receipt.paymentMethod,
      amount: receipt.amount,
      reference: receipt.referenceNumber,
      kind:mapped?.kind??(fee ? "HELD_DELIVERY" : "GOODS"),
    });
  }
  const pending: Array<{
    row: FulfillmentCharge;
    remaining: ReturnType<typeof money>;
    immediateGuest: boolean;
  }> = [
    ...serviceRows.map((row) => ({
      row,
      remaining: money(row.amount),
      immediateGuest: row.customerId == null,
    })),
    ...approvedRows.map((row) => ({
      row,
      remaining: money(approved.find((x) => x.chargeId === row.id)!.amount),
      immediateGuest: false,
    })),
  ];
  const chargeAllocations: CheckoutChargesResult["chargeAllocations"] = [];
  for (const extra of extras) {
    let remaining = money(extra.amount);
    const allocations: Array<{
      row: FulfillmentCharge;
      amount: string;
      immediateGuest: boolean;
    }> = [];
    for (const target of pending) {
      if (!remaining.gt(0)) break;
      if (!target.remaining.gt(0)) continue;
      const amount = remaining.lt(target.remaining)
        ? remaining
        : target.remaining;
      allocations.push({
        row: target.row,
        amount: toDbMoney(amount),
        immediateGuest: target.immediateGuest,
      });
      target.remaining = target.remaining.minus(amount);
      remaining = remaining.minus(amount);
    }
    const leg = resolvedLegs[extra.paymentIndex];
    if (!["CASH", "CARD", "TRANSFER", "WALLET"].includes(leg.method))
      throw fulfillmentError("طريقة القبض المختارة غير مفعلة للأجور");
    const collected = await collectCheckoutChargePortionTx(
      tx,
      {
        branchId: input.branchId,
        customerId: input.customerId,
        clientRequestId: input.clientRequestId,
        sourceHash: ctx.sourceHash,
        paymentIndex: extra.paymentIndex,
        tender: {
          method: leg.method as "CASH" | "CARD" | "TRANSFER" | "WALLET",
          shiftId: input.shiftId,
          reference: leg.reference,
          externalPaymentAttemptId: leg.externalPaymentAttemptId,
        },
        allocations,
      },
      actor,
    );
    chargeAllocations.push(...collected.allocations);
    checkoutReceipts.push({
      receiptId: collected.receiptId,
      paymentIndex: extra.paymentIndex,
      method: leg.method,
      amount: extra.amount,
      reference: leg.reference ?? null,
      kind: services.length ? "SERVICE" : "CHARGE",
    });
  }
  if (pending.some((x) => !x.remaining.isZero()))
    throw fulfillmentError("لم تكتمل تخصيصات قبض الأجور");
  await verifyCheckoutProofsTx(tx, input, actor, channel, checkoutReceipts);
  const tendered = groups.reduce(
    (sum, g) => sum.plus(money(g.amount)),
    money("0"),
  );
  const applied = checkoutReceipts.reduce(
    (sum, r) => sum.plus(money(r.amount)),
    money("0"),
  );
  if (applied.gt(tendered))
    throw fulfillmentError("الإيصالات تتجاوز مبلغ القبض الفعلي");
  const result = {
    result: goods.result,
    chargeAllocations,
    checkoutReceipts,
    checkoutPaymentSummary: {
      tenderedAmount: toDbMoney(tendered),
      appliedAmount: toDbMoney(applied),
      changeAmount: toDbMoney(tendered.minus(applied)),
    },
  };
  const primary = checkoutReceipts[0]?.receiptId;
  if (!primary) throw fulfillmentError("لا يوجد إيصال للقبض الموحد");
  const [primaryRow] = await tx
    .select({ internalNote: receipts.internalNote })
    .from(receipts)
    .where(eq(receipts.id, primary))
    .limit(1);
  let note: Record<string, unknown> = {};
  try {
    note = primaryRow.internalNote ? JSON.parse(primaryRow.internalNote) : {};
  } catch {
    throw fulfillmentError("دليل إيصال القبض الأصلي غير قابل للاسترجاع");
  }
  await tx
    .update(receipts)
    .set({ internalNote: JSON.stringify({ ...note, checkoutResult: result }) })
    .where(eq(receipts.id, primary));
  await recordFulfillmentMutationTx(tx, ctx, primary);
  return result;
}

function checkoutTenderGroups(input: CheckoutCompositionInput) {
  const legs = input.payments?.length
    ? input.payments
    : input.payment
      ? [input.payment]
      : [];
  const groups = legs.map((leg, index) => ({
    leg,
    index,
    amount: toDbMoney(
      money(leg.amount).plus(
        input.chargePayments?.find((x) => x.paymentIndex === index)?.amount ??
          "0",
      ),
    ),
    deviceId: leg.externalPaymentDeviceId ?? input.deviceId,
  }));
  if (money(input.deliveryFeeHeld ?? "0").gt(0)) {
    const tender = input.deliveryFeeTender ?? { method: "CASH" };
    if (tender.combinedWithPaymentIndex != null) {
      const group = groups[tender.combinedWithPaymentIndex];
      if (
        !group ||
        group.leg.method !== tender.method ||
        (tender.externalPaymentAttemptId != null &&
          tender.externalPaymentAttemptId !==
            group.leg.externalPaymentAttemptId)
      )
        throw fulfillmentError("أمانة التوصيل لا تطابق دفعة القبض المرتبطة");
      group.amount = toDbMoney(
        money(group.amount).plus(input.deliveryFeeHeld!),
      );
    } else
      groups.push({
        index: -1,
        leg: { ...tender, amount: input.deliveryFeeHeld! },
        amount: toDbMoney(money(input.deliveryFeeHeld!)),
        deviceId: tender.externalPaymentDeviceId ?? input.deviceId,
      });
  }
  return groups;
}
async function verifyCheckoutProofsTx(
  tx: Tx,
  input: CheckoutCompositionInput,
  actor: Actor,
  channel: PosExternalPaymentChannel,
  allocations: CheckoutReceiptAllocation[],
) {
  for (const group of checkoutTenderGroups(input)) {
    const receiptIds = allocations
      .filter((r) => r.paymentIndex === group.index)
      .map((r) => r.receiptId);
    if (group.leg.method === "CASH") continue;
    await consumeExternalReceiptAllocationsTx(
      tx,
      {
        branchId: input.branchId,
        channel,
        method: group.leg.method,
        amount: group.amount,
        attemptId: group.leg.externalPaymentAttemptId,
        deviceId: group.deviceId,
      },
      receiptIds,
      actor,
    );
  }
}
