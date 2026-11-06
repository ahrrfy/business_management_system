import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { digitalIntentSettlements, digitalRefundPayments } from "../../../drizzle/digitalSettlementSchema";
import { accountingEntries, auditLogs, cashVarianceCases, cashVarianceCaseEvents, digitalOfferings, digitalSaleIntents, digitalSaleIntentItems, receipts, shifts } from "../../../drizzle/schema";
import { appErrorMessage } from "../../../shared/errors";
import { digitalRefundMethodAllowed, type DigitalCardRefundControl, type DigitalRefundMethod, type DigitalRefundTender } from "../../../shared/digitalPaymentSettlement";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { debitLine, creditLine, createPostingIntent } from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import { lockMaterializedCashReceiptSourceForWrite } from "../cash/cashAvailability";
import { bindExternalPaymentAttempt, lockConfirmedExternalPaymentAttempt } from "../posExternalPayment";
import type { Actor } from "../tx";
import { digitalPaymentChannel, parseReceptionSource } from "./receptionSource";
import { computeInvoiceIntentTotal, parseInvoiceSourcePayload } from "./intentSchemas";
import { digitalSettlementAmounts } from "./settlementMath";
import { controlDigitalCardRefund, executeDigitalRefund, intentDigitalRefundContext } from "./refundPayments";

function blocked(why: string): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
    what: "تعذّرت تسوية قبض الكروت", why,
    doThis: "طابق القبض ونتيجة كل كرت ثم اعتمد المبالغ المحسوبة؛ لا تقبض أو تصدر أو ترد المبلغ مرتين",
  }) });
}

export type SettlementOptions = { captureConfirmed: true; refundMethod: DigitalRefundMethod; regularDisposition: "SELL" | "RELEASE"; recovery?: { postingShiftId: number; cashCustodyReceiptId?: number; reason: string } };

async function quotedAllocation(tx: Tx, intent: typeof digitalSaleIntents.$inferSelect,
  details: (typeof digitalSaleIntentItems.$inferSelect)[], issued: (typeof digitalSaleIntentItems.$inferSelect)[], regularDisposition: SettlementOptions["regularDisposition"]) {
  const source = intent.checkoutSnapshot?.sourceType === "RECEPTION" ? parseReceptionSource(intent.checkoutSnapshot.sourcePayload, intent.paymentMethod) : null;
  let issuedPrices = issued.map(item => item.sellPriceSnapshot);
  if (intent.checkoutSnapshot?.sourceType === "INVOICE") {
    const lines = await tx.select({ lineKey: digitalSaleIntentItems.lineKey, sellPrice: digitalSaleIntentItems.sellPriceSnapshot,
      variantId: digitalOfferings.variantId, productUnitId: digitalOfferings.productUnitId }).from(digitalSaleIntentItems)
      .innerJoin(digitalOfferings, eq(digitalOfferings.id, digitalSaleIntentItems.offeringId)).where(eq(digitalSaleIntentItems.intentId, intent.id));
    const pricing = computeInvoiceIntentTotal({ sourcePayload: parseInvoiceSourcePayload(intent.checkoutSnapshot.sourcePayload),
      digitalLines: lines, regularSubtotal: intent.checkoutSnapshot.expectedSubtotal });
    if (!money(pricing.total).eq(intent.expectedTotal) || lines.length !== details.length) blocked("القبض الأصلي لا يطابق بنود الفاتورة المثبتة");
    issuedPrices = issued.map(item => pricing.digitalLineTotals.get(item.lineKey)!);
  }
  return digitalSettlementAmounts({ captured: intent.expectedTotal, issuedPrices,
    regularSubtotal: intent.checkoutSnapshot?.expectedSubtotal ?? "0", regularDisposition: regularDisposition,
    unknownCount: 0, cashRound: source?.cashRoundIQD === true });
}

export async function requestDigitalSettlement(tx: Tx, intent: typeof digitalSaleIntents.$inferSelect,
  resolutionId: number, outcomes: Array<{ intentItemId: number; outcome: "ISSUED" | "NOT_ISSUED" }>,
  options: SettlementOptions | undefined, actor: Actor) {
  if (!options?.captureConfirmed || !["CASH", "CARD"].includes(intent.paymentMethod)) blocked("التسوية تتطلب تأكيد قبض نقدي أو بطاقة محدد في النيّة الأصلية");
  if (!digitalRefundMethodAllowed(intent.paymentMethod, options.refundMethod)) blocked("القبض النقدي يرد نقداً؛ رد البطاقة يتبع وسيلتها أو صرف الخزينة المعتمد");
  if (intent.paymentMethod === "CARD") await lockConfirmedExternalPaymentAttempt(tx, {
    branchId: Number(intent.branchId), channel: digitalPaymentChannel(intent.checkoutSnapshot?.sourceType), method: "CARD",
    amount: intent.expectedTotal, attemptId: intent.externalPaymentAttemptId ?? undefined,
    deviceId: intent.externalPaymentDeviceId, digitalSaleIntentId: Number(intent.id),
  }, actor);
  const details = await tx.select().from(digitalSaleIntentItems).where(eq(digitalSaleIntentItems.intentId, Number(intent.id))).for("update");
  const issuedIds = outcomes.filter((item) => item.outcome === "ISSUED").map((item) => item.intentItemId).sort((a,b) => a-b);
  const issued = details.filter((item) => issuedIds.includes(Number(item.id)));
  if (details.length !== outcomes.length || issued.length !== issuedIds.length) blocked("لقطات البنود لا تطابق نتيجة المراجعة");
  const amounts = await quotedAllocation(tx, intent, details, issued, options.regularDisposition);
  const [previous] = await tx.select().from(digitalIntentSettlements).where(eq(digitalIntentSettlements.intentId, Number(intent.id))).for("update").limit(1);
  if (previous) {
    const [refund] = await tx.select({ id: digitalRefundPayments.id }).from(digitalRefundPayments)
      .where(eq(digitalRefundPayments.intentId, Number(intent.id))).limit(1);
    if (previous.collectionReceiptId != null || refund) blocked("تسوية القبض أو إثبات رده محفوظان؛ أكمل القرار الأصلي دون تغييره");
    await tx.delete(digitalIntentSettlements).where(eq(digitalIntentSettlements.id, previous.id));
  }
  const [originalShift] = await tx.select().from(shifts).where(eq(shifts.id, Number(intent.shiftId))).for("update").limit(1);
  if (originalShift?.status !== "OPEN") {
    if (!intent.checkoutSnapshot?.unadmittedCapture || !options.recovery || !money(amounts.saleAmount).isZero() || options.regularDisposition !== "RELEASE") blocked("الوردية الأصلية مغلقة؛ حدّد وردية استدراك مفتوحة ودليل عهدة النقد لرد القبض غير المقبول");
    const recovery={...options.recovery,reason:options.recovery.reason.trim(),requestedBy:actor.userId};
    if (recovery.reason.length<5) blocked("سبب الاستدراك مطلوب");
    await validateRecoveryContext(tx,intent,recovery,amounts.capturedAmount);
    await tx.update(digitalSaleIntents).set({checkoutSnapshot:{...intent.checkoutSnapshot,captureRecovery:recovery}}).where(eq(digitalSaleIntents.id,intent.id));
    await tx.insert(auditLogs).values({userId:actor.userId,branchId:Number(intent.branchId),action:"digitalCards.capture.recoveryRequested",
      entityType:"digitalSaleIntent",entityId:String(intent.id),newValue:{originalShiftId:intent.shiftId,originalOperatorId:intent.createdBy,attemptId:intent.externalPaymentAttemptId,...recovery}});
  } else if(options.recovery) blocked("الوردية الأصلية مفتوحة؛ لا تنقل عهدتها إلى وردية أخرى");
  await tx.insert(digitalIntentSettlements).values({ intentId: Number(intent.id), resolutionId,
    customerId: intent.checkoutSnapshot?.customerId ?? null, ...amounts,
    refundMethod: options.refundMethod, regularDisposition: options.regularDisposition, issuedItemIds: issuedIds,
    status: "REQUESTED", createdBy: actor.userId });
  return amounts;
}

export async function discardRejectedAllocation(tx: Tx, intentId: number, resolutionId: number) {
  const [row] = await tx.select().from(digitalIntentSettlements).where(eq(digitalIntentSettlements.intentId, intentId)).for("update").limit(1);
  await assertNoSettlementEvidence(tx, intentId);
  if (!row) return;
  if (row.resolutionId !== resolutionId || row.status !== "REQUESTED" || row.collectionReceiptId != null || row.refundPaymentId != null || row.approvedBy != null) blocked("تخصيص القبض مرتبط بمعالجة مالية ولا يُحذف");
  await tx.delete(digitalIntentSettlements).where(eq(digitalIntentSettlements.id, row.id));
}

async function assertNoSettlementEvidence(tx: Tx, intentId: number) {
  const [refund] = await tx.select({ id: digitalRefundPayments.id }).from(digitalRefundPayments)
    .where(eq(digitalRefundPayments.intentId, intentId)).for("update").limit(1);
  if (refund) blocked("يوجد حجز أو إثبات رد محفوظ؛ لا يمكن رفضه أو تبديل القرار، أكمل تسويته الأصلية");
}

/** Original money enters OTHER_LIABILITY exactly once, never a second charge. */
export async function materializeDigitalCapture(tx: Tx, intent: typeof digitalSaleIntents.$inferSelect, approvedBy: number, actor: Actor) {
  const [settlement] = await tx.select().from(digitalIntentSettlements).where(eq(digitalIntentSettlements.intentId, Number(intent.id))).for("update").limit(1);
  if (!settlement || settlement.status !== "REQUESTED") blocked("لا يوجد تخصيص قبض ينتظر الاعتماد");
  if (settlement.collectionReceiptId != null) blocked("سند القبض المحتجز موجود بالفعل؛ راجع حالة التسوية دون قبض جديد");
  if (intent.checkoutSnapshot?.sourceType === "INVOICE") {
    const details = await tx.select().from(digitalSaleIntentItems).where(eq(digitalSaleIntentItems.intentId, intent.id)).for("update");
    const quote = await quotedAllocation(tx, intent, details, details.filter(item => settlement.issuedItemIds.includes(item.id)), settlement.regularDisposition);
    if (!money(quote.saleAmount).eq(settlement.saleAmount) || !money(quote.refundAmount).eq(settlement.refundAmount)) {
      blocked("تخصيص سابق لا يطابق صافي الفاتورة. لا تنفذ رداً آخر؛ احتفظ بالإثبات وطابق فرق التسوية مع الحسابات");
    }
  }
  const [shift] = await tx.select().from(shifts).where(eq(shifts.id, Number(intent.shiftId))).for("update").limit(1);
  if (!shift || shift.branchId !== intent.branchId) blocked("الوردية الأصلية لا تخص الفرع");
  let postingShiftId=Number(intent.shiftId);
  if (shift.status !== "OPEN") {
    const recovery=intent.checkoutSnapshot?.captureRecovery;
    if (!intent.checkoutSnapshot?.unadmittedCapture || !recovery || !money(settlement.saleAmount).isZero()) blocked("الوردية الأصلية مغلقة؛ يلزم استدراك موثق في فترة مفتوحة ولا يُعدّل إقفال الأصل");
    await validateRecoveryContext(tx,intent,recovery,settlement.capturedAmount);
    postingShiftId=recovery.postingShiftId;
    if (intent.paymentMethod==="CASH") {
      const receiptId=recovery.cashCustodyReceiptId!;
      await tx.update(digitalIntentSettlements).set({collectionReceiptId:receiptId,approvedBy}).where(eq(digitalIntentSettlements.id,settlement.id));
      return {...settlement,collectionReceiptId:receiptId,approvedBy};
    }
  }
  let reference: string | null = null;
  if (intent.paymentMethod === "CARD") {
    const attempt = await lockConfirmedExternalPaymentAttempt(tx, { branchId: Number(intent.branchId),
      channel: digitalPaymentChannel(intent.checkoutSnapshot?.sourceType), method: "CARD", amount: settlement.capturedAmount,
      attemptId: intent.externalPaymentAttemptId ?? undefined, deviceId: intent.externalPaymentDeviceId,
      digitalSaleIntentId: Number(intent.id) }, actor);
    reference = attempt.externalReference;
  } else if (intent.paymentMethod === "CASH") {
    // The original shift is already locked; acquire its day gate before a new physical receipt.
    // Closed-shift custody recovery reuses its approved receipt above, without collecting again.
    await lockMaterializedCashReceiptSourceForWrite(tx, { branchId: Number(intent.branchId),
      shiftId: postingShiftId, cashBucket: "DRAWER", paymentMethod: "CASH", status: "COMPLETED" });
  } else blocked("وسيلة القبض غير قابلة للتسوية");
  const inserted = await tx.insert(receipts).values({ branchId: Number(intent.branchId), shiftId: postingShiftId,
    invoiceId: null, direction: "IN", amount: settlement.capturedAmount, paymentMethod: intent.paymentMethod as "CASH" | "CARD",
    cashBucket: intent.paymentMethod === "CASH" ? "DRAWER" : null, status: "COMPLETED", referenceNumber: reference,
    partyType: settlement.customerId == null ? "OTHER" : "CUSTOMER", partyId: settlement.customerId,
    description: `قبض محتجز لتسوية نية الكروت #${intent.id}`, createdBy: Number(intent.createdBy) });
  const receiptId = extractInsertId(inserted);
  const amount = money(settlement.capturedAmount);
  const asset = intent.paymentMethod === "CASH" ? "CASH" : "CARD_BANK";
  const components = { roleDebits: { [asset]: amount }, roleCredits: { OTHER_LIABILITY: amount } };
  await postEntry(tx, { entryType: "PAYMENT_IN", branchId: Number(intent.branchId), invoiceId: null, customerId: null,
    receiptId, amount, dedupeKey: `DIGITAL:HOLD:${intent.id}`, notes: `قبض محتجز قبل فوترة الكروت #${intent.id}`, createdBy: Number(intent.createdBy),
    postingSourceComponents: components, postingIntent: createPostingIntent("PAYMENT_IN_OTHER", "PAYMENT_IN",
      [debitLine(asset, amount), creditLine("OTHER_LIABILITY", amount)], components) });
  await tx.update(digitalIntentSettlements).set({ collectionReceiptId: receiptId, approvedBy })
    .where(eq(digitalIntentSettlements.id, settlement.id));
  if (intent.paymentMethod === "CARD") await bindExternalPaymentAttempt(tx, Number(intent.externalPaymentAttemptId), null, receiptId);
  return { ...settlement, collectionReceiptId: receiptId, approvedBy };
}

export async function controlIntentRefund(tx: Tx, intentId: number, control: DigitalCardRefundControl, actor: Actor) {
  const context = await intentDigitalRefundContext(tx, intentId, actor);
  const [settlement] = await tx.select().from(digitalIntentSettlements).where(eq(digitalIntentSettlements.intentId, intentId)).limit(1);
  if (!settlement || settlement.refundMethod !== "CARD") blocked("طريقة الرد تختلف عن قرار التسوية المحفوظ");
  return controlDigitalCardRefund(tx, context, control, actor);
}

export async function completeDigitalSettlement(tx: Tx, intentId: number, invoiceId: number | null, tender: DigitalRefundTender | undefined, actor: Actor) {
  const context = await intentDigitalRefundContext(tx, intentId, actor);
  const [settlement] = await tx.select().from(digitalIntentSettlements).where(eq(digitalIntentSettlements.intentId, intentId)).for("update").limit(1);
  if (!settlement || (!money(context.amount).isZero() && settlement.refundMethod !== tender?.method) || !settlement.collectionReceiptId || !settlement.approvedBy) blocked("تخصيص القبض أو اعتماد الرد غير مكتمل");
  const refund = tender ? await executeDigitalRefund(tx, context, tender, actor, "OTHER_LIABILITY") : null;
  await tx.update(digitalIntentSettlements).set({ status: "COMPLETED", invoiceId,
    refundPaymentId: refund?.refundId ?? null, completedAt: new Date() }).where(eq(digitalIntentSettlements.id, settlement.id));
}


async function validateRecoveryContext(tx:Tx,intent:typeof digitalSaleIntents.$inferSelect,
  recovery:NonNullable<NonNullable<typeof intent.checkoutSnapshot>["captureRecovery"]>,amount:string) {
  const [posting]=await tx.select().from(shifts).where(eq(shifts.id,recovery.postingShiftId)).for("update").limit(1);
  if(!posting || posting.status!=="OPEN" || posting.branchId!==intent.branchId || posting.userId!==recovery.requestedBy || posting.id===intent.shiftId)
    blocked("اختر وردية مفتوحة لمنشئ طلب الاستدراك في الفرع نفسه؛ لا يتغير إقفال الأصل");
  if(intent.paymentMethod==="CARD") {
    if(recovery.cashCustodyReceiptId)blocked("قبض البنك لا يربط بعهدة نقدية");
    return;
  }
  const [receipt]=await tx.select().from(receipts).where(eq(receipts.id,recovery.cashCustodyReceiptId??0)).for("update").limit(1);
  if(!receipt || receipt.branchId!==intent.branchId || receipt.direction!=="IN" || receipt.paymentMethod!=="CASH" ||
     receipt.status!=="COMPLETED" || receipt.approvalStatus!=="APPROVED" || !money(receipt.amount).eq(amount) || receipt.invoiceId!=null)
    blocked("النقد يتطلب سند زيادة أمانات معتمداً بمبلغ القبض كاملاً. طابق النقد في الخزينة وارفع دليله عبر حالات فرق النقد، ثم أدخل رقم سند الاعتماد");
  const [used]=await tx.select({intentId:digitalIntentSettlements.intentId}).from(digitalIntentSettlements)
    .where(eq(digitalIntentSettlements.collectionReceiptId,receipt.id)).for("update").limit(1);
  if(used && used.intentId!==intent.id)blocked("دليل العهدة مرتبط بتسوية أخرى");
  if(receipt.cashBucket==="TREASURY") {
    const [event]=await tx.select({event:cashVarianceCaseEvents,source:cashVarianceCases}).from(cashVarianceCaseEvents)
      .innerJoin(cashVarianceCases,eq(cashVarianceCases.id,cashVarianceCaseEvents.caseId))
      .where(eq(cashVarianceCaseEvents.adjustmentReceiptId,receipt.id)).for("update").limit(1);
    if(!event || event.event.eventType!=="APPROVED" || event.event.counterAccountRole!=="OTHER_LIABILITY" ||
       event.source.branchId!==intent.branchId || !money(event.source.variance).eq(amount) ||
       event.source.evidenceReference!=="DIGITAL_CAPTURE:"+intent.clientRequestId || !event.source.evidenceDocumentId ||
       !event.source.evidenceContentHash) blocked("دليل فرق النقد لا يربط القبض الأصلي؛ وثّق مرجع DIGITAL_CAPTURE:"+intent.clientRequestId+" في حالة زيادة معتمدة");
    const [entry]=await tx.select().from(accountingEntries).where(eq(accountingEntries.id,event.event.accountingEntryId!)).limit(1);
    if(!entry || entry.receiptId!==receipt.id || entry.dedupeKey!=="CASH_VARIANCE:"+event.source.id) blocked("قيد عهدة النقد غير مكتمل");
  } else {
    if(receipt.shiftId!==intent.shiftId || receipt.referenceNumber!=="SV-"+intent.shiftId)blocked("سند النقد لا يثبت عهدة الأصل");
    const [entry]=await tx.select().from(accountingEntries).where(eq(accountingEntries.dedupeKey,"SHIFT_VARIANCE_SURPLUS:"+intent.shiftId)).limit(1);
    const transfers=await tx.select().from(receipts).where(and(eq(receipts.shiftId,Number(intent.shiftId)),eq(receipts.direction,"OUT"),eq(receipts.cashBucket,"DRAWER"),eq(receipts.status,"COMPLETED"))).for("update");
    let handed=false;
    for(const out of transfers.filter(r=>r.referenceNumber?.startsWith("CH-") && money(r.amount).gte(amount))) {
      const [incoming]=await tx.select().from(receipts).where(and(eq(receipts.referenceNumber,out.referenceNumber!),eq(receipts.branchId,Number(intent.branchId)),eq(receipts.direction,"IN"),eq(receipts.cashBucket,"TREASURY"),eq(receipts.status,"COMPLETED"))).for("update").limit(1);
      if(incoming && money(incoming.amount).eq(out.amount))handed=true;
    }
    if(!entry || entry.receiptId!==receipt.id || !handed)blocked("زيادة الوردية لم تُثبت بقيد أمانات وتسليم كامل للخزينة");
  }
}
