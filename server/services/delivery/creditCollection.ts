import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { deliveryConsignments, deliveryLedgerEntries, deliveryParties, invoices } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { logAuditTx } from "../auditService";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { withTx } from "../tx";
import { creditCollectionChoiceTx, recordCreditCollectionChoiceTx } from "./creditCollectionTerms";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";
import { assertFloatLimitTx } from "./parties";
import { assertStandaloneConsignmentTx, createFinalShipmentDispatchDocumentSnapshotsTx } from "./shipments";
import { listDeliveryDocumentSnapshotsTx } from "./documentSnapshots";
import type { DeliveryActor } from "./types";

export interface CreditCollectionChange {
  partyId: number;
  consignmentId: number;
  collectCreditOnDelivery?: boolean;
  expectedClaimVersion?: number;
  collectionReason?: string;
  clientRequestId: string;
}

function reject(why: string, code: "CONFLICT" | "FORBIDDEN" | "PRECONDITION_FAILED" = "PRECONDITION_FAILED"): never {
  throw new TRPCError({ code, message: appErrorMessage({ what: "تعذر تعديل تحصيل المبلغ الآجل", why,
    doThis: "حدّث تفاصيل الإرسالية وراجع اختيار التحصيل ورصيد الفاتورة؛ لا تسجل قبضاً أو توريداً لتصحيح الاختيار" }) });
}

/** Change a future collection instruction only. No customer settlement, cash or sale is posted. */
export function changeCreditCollection(input: CreditCollectionChange, actor: DeliveryActor, existingTx?: Tx) {
  const run = async (tx: Tx) => {
    if (typeof input.collectCreditOnDelivery !== "boolean" || !input.expectedClaimVersion ||
        !input.clientRequestId?.trim() || (input.collectionReason?.trim().length ?? 0) < 3)
      reject("اختر التحصيل مع المندوب أو بقاء الدين على العميل، وأدخل السبب ونسخة المطالبة الحالية");
    const hash = idempotencyHash(input);
    const operation = "delivery.creditCollectionTerms";
    const [party] = await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1);
    const [cn] = await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, input.consignmentId)).for("update").limit(1);
    if (!party || !cn || cn.partyId !== input.partyId) reject("الإرسالية لا تخص جهة التوصيل المحددة");
    if (actor.role !== "admin" && (actor.branchId == null || actor.branchId !== cn.branchId))
      reject("الإرسالية خارج نطاق فرع المستخدم", "FORBIDDEN");
    const eventKey = `CREDIT_COLLECTION:${input.clientRequestId}:${cn.id}`;
    // Replay precedes all mutable-state checks, including delivery/collection and claim version.
    const replay = await checkIdempotency(tx, operation, input.clientRequestId, hash, { requireStoredHash: true });
    if (replay != null) return { consignmentId: cn.id, replay: true as const,
      documentSnapshotIds: (await listDeliveryDocumentSnapshotsTx(tx, { sourceType: "SHIPMENT", sourceId: cn.id,
        branchId: cn.branchId })).filter(row => row.eventKey === `${eventKey}:CLAIM` || row.eventKey === eventKey)
          .map(row => row.id).sort((a,b) => a-b) };
    if (!party.isActive) reject("جهة التوصيل معطلة؛ لا يمكن تكليفها بتحصيل جديد");
    await assertStandaloneConsignmentTx(tx, cn.id, "تعديل تحصيل الآجل", { currentRead: true });
    if (cn.fulfillmentRequestId != null || cn.aftercareExecutionId != null)
      reject("تعديل المطالبة القائمة متاح للإرسالية المنفردة؛ راجع مطالبات طلب التجهيز قبل تعديل مجموعة");
    if (cn.codClaimVersion !== input.expectedClaimVersion) reject("تغيرت نسخة مطالبة المندوب أثناء فتح النافذة", "CONFLICT");
    if (!["DISPATCHED", "PARTIAL"].includes(cn.status) || cn.returnDeclaredAt != null || cn.courierDeliveredAt != null ||
        !["ASSIGNED", "ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY", "FAILED"].includes(cn.parcelStatus) ||
        money(cn.collectedAmount).gt(0) || money(cn.counterSettledAmount).gt(0) || cn.remittanceId != null)
      reject("بدأ التسليم أو التحصيل أو التوريد أو الرجوع؛ يلزم مسار تسوية موثق بدلاً من تغيير تعليمات المندوب");
    const [financial] = await tx.select({ count: sql<number>`COUNT(*)` }).from(deliveryLedgerEntries).where(and(
      eq(deliveryLedgerEntries.consignmentId, cn.id), inArray(deliveryLedgerEntries.entryType,
        ["COD_COLLECTED", "COD_REMITTED", "COD_RETURNED", "COD_WRITTEN_OFF", "COD_RECOVERED", "SHORTFALL_ASSIGNED", "SHORTFALL_SETTLED"])));
    if (Number(financial?.count ?? 0) > 0) reject("للإرسالية تحصيل أو عجز أو تسوية مالية مسجلة");
    if (cn.invoiceId == null) reject("لا توجد فاتورة أصلية مرتبطة بالإرسالية");
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, cn.invoiceId!)).for("update").limit(1);
    if (!invoice || invoice.branchId !== cn.branchId || invoice.paymentMode !== "CREDIT" || isDeadInvoiceStatus(invoice.status))
      reject("اختيار التحصيل الآجل يحتاج فاتورة آجلة حية من فرع الإرسالية");
    const remaining = round2(money(invoice.total).minus(invoice.returnedTotal).minus(invoice.paidAmount));
    if (remaining.lte(0)) reject("الفاتورة مسددة أو لا تحمل متبقياً قابلاً للتحصيل");
    const previous = await creditCollectionChoiceTx(tx, cn.id);
    if ((previous && !money(cn.codAmount).eq(remaining)) || (!previous && !money(cn.codAmount).isZero()))
      reject("مطالبة الإرسالية لا تطابق اختيار التحصيل ورصيد الفاتورة؛ يلزم فحص المطابقة أولاً", "CONFLICT");
    const target = input.collectCreditOnDelivery ? remaining : money(0);
    if (target.isZero() && cn.feeCollection !== "COURIER" && money(cn.deliveryFee).gt(0) && cn.feeSettledAt == null)
      reject("للإرسالية أجرة مستحقة على المكتبة لم تسوّ بعد؛ سوّ الأجرة قبل إلغاء تحصيل البضاعة");
    const delta = round2(target.minus(cn.codAmount));
    if (delta.gt(0)) await assertFloatLimitTx(tx, party, delta);
    const version = cn.codClaimVersion + 1;
    let claimChangeEventId: number | undefined;
    if (previous !== input.collectCreditOnDelivery) {
      if (!delta.isZero()) await appendDeliveryLedgerEntry(tx, { eventKey: `${eventKey}:EXPOSURE`, consignmentId: cn.id,
        partyId: cn.partyId, branchId: cn.branchId, entryType: delta.gt(0) ? "COD_ASSIGNED" : "COD_RELEASED",
        amount: toDbMoney(delta.abs()), actorUserId: actor.userId, notes: input.collectionReason!.trim() });
      await tx.update(deliveryConsignments).set({ codAmount: toDbMoney(target),
        moneyStatus: target.gt(0) ? "UNSETTLED" : "NOT_APPLICABLE", codClaimVersion: version,
        courierAckClaimVersion: 0, courierAckAt: null,
        settledAt: target.gt(0) ? null : cn.settledAt ?? new Date() }).where(eq(deliveryConsignments.id, cn.id));
      await recordCreditCollectionChoiceTx(tx, { consignmentId: cn.id, collectCreditOnDelivery: input.collectCreditOnDelivery,
        actorUserId: actor.userId, eventKey: `${eventKey}:TERMS`, reason: input.collectionReason!.trim(), claimVersion: version });
      claimChangeEventId = await appendDeliveryEvent(tx, { eventKey: `${eventKey}:CLAIM`, consignmentId: cn.id,
        eventType: "COD_CLAIM_CHANGED", actorUserId: actor.userId, payload: { claimVersion: version, ackRequired: true,
          partyId: cn.partyId, sourceType: cn.sourceType, sourceId: cn.sourceId, invoiceId: cn.invoiceId,
          deliveryFee: cn.deliveryFee, feeCollection: cn.feeCollection,
          before: toDbMoney(money(cn.codAmount)), after: toDbMoney(target), collectCreditOnDelivery: input.collectCreditOnDelivery } });
      await logAuditTx(tx, actor, { action: "delivery.creditCollectionTerms", entityType: "deliveryConsignment", entityId: cn.id,
        branchId: cn.branchId, oldValue: { collectCreditOnDelivery: previous, codAmount: cn.codAmount, claimVersion: cn.codClaimVersion },
        newValue: { collectCreditOnDelivery: input.collectCreditOnDelivery, codAmount: toDbMoney(target), claimVersion: version,
          reason: input.collectionReason!.trim() } });
    }
    const snapshots = previous === input.collectCreditOnDelivery ? [] : await createFinalShipmentDispatchDocumentSnapshotsTx(tx,
      { consignmentId: cn.id, clientRequestId: input.clientRequestId, operationId: "CREDIT_COLLECTION",
        eventOccurredAt: new Date(), claimChangeEventId }, actor);
    await recordIdempotencyKey(tx, operation, input.clientRequestId, cn.id, hash);
    return { consignmentId: cn.id, replay: false as const, documentSnapshotIds: snapshots };
  };
  return existingTx ? run(existingTx) : withTx(run);
}
