import { appErrorMessage } from "../../../shared/errors";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { digitalSaleIntents, externalPaymentAttempts, auditLogs, shifts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import { lockConfirmedExternalPaymentAttempt } from "../posExternalPayment";
import type { Actor } from "../tx";
import { checkoutRequestFingerprint } from "./mixedCartService";
import type { PrepareInput } from "./intentService";
import { loadDigitalIntentScopeTx, assertDigitalIntentScope } from "./intentOperationScope";

function invalid(): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({what:"تعذّر ربط القبض قبل قبول البيع الرقمي",why:"إثبات القبض أو الجهاز أو صاحب الوردية لا يطابق الأمر المحفوظ",doThis:"استعد أمر البيع من الجهاز والحساب الأصليين؛ لا تُعد القبض أو الإصدار"}) });
}

/** Only a failed new admission can reach the header-only review state. Its savepoint rolls back
 * all preparation effects. An existing intent (including UNKNOWN) is only ever replayed. */
export async function prepareCapturedDigitalSale(tx: Tx, input: PrepareInput, actor: Actor,
  fingerprint: string, admit: (inner: Tx, currentReplay?: boolean) => Promise<{ intentId: number; replay: boolean; expiresAt: Date }>) {
  const capture = input.capturedDigitalPayment;
  const reception = input.sourceType === "RECEPTION";
  const posCard = input.sourceType === "POS" && input.paymentMethod === "CARD";
  if ((!reception && !posCard) || !capture?.confirmed || !capture.deviceId?.trim() || capture.deviceId.length > 64 ||
      !/^\d+(?:\.\d{1,2})?$/.test(capture.amount) || money(capture.amount).lt(0) || !input.lines.length ||
      !["CARD","CASH"].includes(input.paymentMethod)) invalid();
  // Serialize identical commands BEFORE a consistent snapshot is established under REPEATABLE READ.
  const [shift] = await tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).for("update").limit(1);
  if (!shift || shift.branchId !== input.branchId || shift.userId !== actor.userId || shift.shiftType !== (reception ? "RECEPTION" : "RETAIL")) invalid();
  const authority = await loadDigitalIntentScopeTx(tx, actor, "digitalCards.sales.prepare");
  assertDigitalIntentScope(authority, { createdBy: actor.userId, branchId: input.branchId });
  const [prior] = await tx.select().from(digitalSaleIntents).where(eq(digitalSaleIntents.clientRequestId,input.clientRequestId)).for("update").limit(1);
  if (prior) {
    if (Number(prior.createdBy) !== actor.userId || !money(prior.expectedTotal).eq(capture.amount) ||
        (input.paymentMethod === "CARD" && input.externalPaymentDeviceId !== capture.deviceId)) invalid();
    return admit(tx, true);
  }
  if (input.paymentMethod === "CARD") {
    if (!input.externalPaymentAttemptId || input.externalPaymentDeviceId !== capture.deviceId) invalid();
    const proof = await lockConfirmedExternalPaymentAttempt(tx, { branchId: input.branchId, channel: reception ? "PRINT_POS" : "POS", method: "CARD",
      amount: capture.amount, attemptId: input.externalPaymentAttemptId, deviceId: capture.deviceId }, actor);
    if (proof.requestId !== input.clientRequestId + ":card" || proof.createdBy !== actor.userId || proof.confirmedBy !== actor.userId) invalid();
  } else if (input.externalPaymentAttemptId != null || input.externalPaymentDeviceId != null) invalid();
  try { return await tx.transaction(admit); } catch (error) {
    if (!(error instanceof TRPCError) || !["BAD_REQUEST","CONFLICT","PRECONDITION_FAILED","NOT_FOUND","FORBIDDEN"].includes(error.code) || !money(capture.amount).gt(0)) throw error;
    const requestFingerprint = checkoutRequestFingerprint(input);
    const expiresAt = new Date();
    const command = { clientRequestId:input.clientRequestId, branchId:input.branchId, shiftId:input.shiftId, paymentMethod:input.paymentMethod,
      cartFingerprint:input.cartFingerprint, lines:input.lines, regularLines:input.regularLines ?? [], customerId:input.customerId ?? null,
      priceTier:input.priceTier ?? null, sourceType:input.sourceType, sourcePayload:input.sourcePayload, notes:input.notes ?? null, dueDate:input.dueDate ?? null,
      attemptId:input.externalPaymentAttemptId ?? null, capture };
    const inserted = await tx.insert(digitalSaleIntents).values({ branchId:input.branchId, shiftId:input.shiftId, createdBy:actor.userId,
      clientRequestId:input.clientRequestId, cartFingerprint:fingerprint, paymentMethod:input.paymentMethod,
      externalPaymentAttemptId:input.externalPaymentAttemptId ?? null, externalPaymentDeviceId:input.externalPaymentDeviceId ?? null,
      status:"NEEDS_REVIEW", expectedTotal:toDbMoney(capture.amount), expiresAt,
      checkoutSnapshot:{ version:1, requestFingerprint, customerId:input.customerId ?? null, priceTier:input.priceTier ?? "RETAIL",
        sourceType:reception ? "RECEPTION" : "POS", sourcePayload:input.sourcePayload, regularLines:[], expectedSubtotal:"0.00",
        unadmittedCapture:{ deviceId:capture.deviceId, reason:error.message.slice(0,500), command } } });
    return { intentId:extractInsertId(inserted), expiresAt, replay:false };
  }
}


/** Explicit cashier attestation is additional to server proof of rejected admission, never inferred from an absent journal. */
export async function closeRejectedDigitalSale(tx: Tx, input: PrepareInput, actor: Actor, fingerprint: string,
  admit: (inner: Tx) => Promise<{ intentId: number; replay: boolean; expiresAt: Date }>) {
  if (input.capturedDigitalPayment || input.externalPaymentAttemptId || input.externalPaymentDeviceId ||
      !((input.sourceType === "POS" && input.paymentMethod === "CASH") ||
        (input.sourceType === "INVOICE" && ["CASH","CREDIT"].includes(input.paymentMethod)))) invalid();
  const [shift] = await tx.select().from(shifts).where(eq(shifts.id,input.shiftId)).for("update").limit(1);
  if (!shift || shift.branchId !== input.branchId || shift.userId !== actor.userId) invalid();
  const authority = await loadDigitalIntentScopeTx(tx,actor,"digitalCards.sales.prepare");
  assertDigitalIntentScope(authority,{createdBy:actor.userId,branchId:input.branchId});
  const [prior] = await tx.select().from(digitalSaleIntents).where(eq(digitalSaleIntents.clientRequestId,input.clientRequestId)).for("update").limit(1);
  // Even PREPARED / UNKNOWN / lost responses are recovered, never tombstoned.
  if (prior) return admit(tx);
  const [proof] = await tx.select({id:externalPaymentAttempts.id}).from(externalPaymentAttempts)
    .where(eq(externalPaymentAttempts.requestId,input.clientRequestId+":card")).for("update").limit(1);
  if (proof) invalid();
  const admissible = new Error("admission would succeed");
  let rejection: string;
  try {
    await tx.transaction(async inner=>{await admit(inner);throw admissible;});
    throw admissible;
  } catch(error) {
    if (error === admissible) throw new TRPCError({code:"CONFLICT",message:appErrorMessage({what:"الطلب قابل للقبول حالياً",why:"لا يوجد رفض خادمي يبرر إغلاقه بلا أثر",doThis:"استعد الطلب الأصلي وأكمل البيع دون إصدار أو قبض مكرر"})});
    if (!(error instanceof TRPCError) || !["BAD_REQUEST","CONFLICT","PRECONDITION_FAILED","NOT_FOUND","FORBIDDEN"].includes(error.code)) throw error;
    rejection=error.message.slice(0,500);
  }
  const expiresAt=new Date();
  const inserted=await tx.insert(digitalSaleIntents).values({branchId:input.branchId,shiftId:input.shiftId,createdBy:actor.userId,
    clientRequestId:input.clientRequestId,cartFingerprint:fingerprint,paymentMethod:input.paymentMethod,status:"CANCELLED",expectedTotal:"0.00",expiresAt,
    checkoutSnapshot:{version:1,requestFingerprint:checkoutRequestFingerprint(input),customerId:input.customerId??null,priceTier:input.priceTier??"RETAIL",
      sourceType:input.sourceType,sourcePayload:input.sourcePayload,regularLines:[],expectedSubtotal:"0.00",
      noAdmissionClosed:{reason:rejection,confirmedNoPaymentBy:actor.userId,closedAt:expiresAt.toISOString()}}});
  const intentId=extractInsertId(inserted);
  await tx.insert(auditLogs).values({userId:actor.userId,action:"digitalCards.admission.closedWithoutPayment",entityType:"digitalSaleIntent",entityId:String(intentId),
    branchId:input.branchId,newValue:{reason:rejection,confirmedNoPayment:true,clientRequestId:input.clientRequestId}});
  return {intentId,replay:false,expiresAt};
}
