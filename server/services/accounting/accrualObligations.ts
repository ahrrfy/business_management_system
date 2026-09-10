import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  accountingEntries,
  accrualCorrectionRequests,
  accrualObligationEvents,
  accrualObligations,
  users,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import type { Tx } from "../../db";
import { idempotencyHash } from "../idempotency";
import { money, toDbMoney } from "../money";

export type AccrualObligationKind =
  | "PURCHASE_SHIPPING"
  | "ASSET_MAINTENANCE"
  | "ASSET_ACQUISITION_CASH"
  | "ASSET_ACQUISITION_SUPPLIER";

export type AccrualObligationStatus =
  | "ACCRUED_UNPAID"
  | "PAYMENT_PENDING"
  | "PAYABLE_UNSETTLED"
  | "PAID"
  | "CORRECTION_PENDING"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "RECOGNITION_REVERSED";

export type AccrualObligationEventType =
  | "RECOGNIZED"
  | "PAYMENT_REQUESTED"
  | "PAYMENT_REJECTED"
  | "PAYMENT_SETTLED"
  | "CORRECTION_REQUESTED"
  | "CORRECTION_REJECTED"
  | "SETTLEMENT_REVERSED"
  | "RECOGNITION_REVERSED";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface AccrualObligationSource {
  kind: AccrualObligationKind;
  branchId: number;
  expenseId?: number | null;
  purchaseOrderId?: number | null;
  assetId?: number | null;
  maintenanceId?: number | null;
  sourceKey: string;
  recognizedAmount: string;
  initialStatus: "ACCRUED_UNPAID" | "PAYMENT_PENDING" | "PAYABLE_UNSETTLED";
  beneficiaryType: "SUPPLIER" | "OTHER";
  beneficiarySupplierId?: number | null;
  beneficiaryName: string;
  evidenceReference: string;
  plannedPaymentMethod: PaymentMethod;
  clientRequestId: string;
  recognizedBy: number;
  recognizedAt: Date;
  recognitionAccountingEntryId: number;
}

function positiveId(value: number | null | undefined): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function requiredText(value: string, label: string, max = 255): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} إلزامي ويجب ألا يتجاوز ${max} محرفاً`,
    });
  }
  return normalized;
}

function assertSourceShape(input: AccrualObligationSource) {
  if (!positiveId(input.branchId) || !positiveId(input.recognizedBy)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "فرع أو منشئ الاستحقاق غير صالح" });
  }
  if (!positiveId(input.recognitionAccountingEntryId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "قيد الاعتراف المرتبط بالاستحقاق إلزامي" });
  }
  if (!money(input.recognizedAmount).gt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الاستحقاق يجب أن يكون أكبر من صفر" });
  }
  if (input.beneficiaryType === "SUPPLIER" && !positiveId(input.beneficiarySupplierId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المستفيد المورّد يجب أن يكون طرفاً مسجلاً" });
  }
  if (input.beneficiaryType === "OTHER" && input.beneficiarySupplierId != null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المستفيد الخارجي لا يحمل معرّف مورّد" });
  }
  const hasExpense = positiveId(input.expenseId);
  const hasPurchase = positiveId(input.purchaseOrderId);
  const hasAsset = positiveId(input.assetId);
  const hasMaintenance = positiveId(input.maintenanceId);
  const valid =
    (input.kind === "PURCHASE_SHIPPING" && hasExpense && hasPurchase && !hasAsset && !hasMaintenance) ||
    (input.kind === "ASSET_MAINTENANCE" && hasExpense && !hasPurchase && hasAsset && hasMaintenance) ||
    ((input.kind === "ASSET_ACQUISITION_CASH" || input.kind === "ASSET_ACQUISITION_SUPPLIER") &&
      !hasExpense && !hasPurchase && hasAsset && !hasMaintenance);
  if (!valid) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مراجع مصدر الاستحقاق لا تطابق نوعه" });
  }
  if (
    (input.kind === "ASSET_ACQUISITION_SUPPLIER") !==
    (input.initialStatus === "PAYABLE_UNSETTLED")
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حالة ذمة اقتناء الأصل لا تطابق مصدر تمويله" });
  }
}

export function accrualObligationSourceHash(
  input: Omit<AccrualObligationSource, "sourceHash">,
): string {
  return idempotencyHash({
    kind: input.kind,
    branchId: input.branchId,
    expenseId: input.expenseId ?? null,
    purchaseOrderId: input.purchaseOrderId ?? null,
    assetId: input.assetId ?? null,
    maintenanceId: input.maintenanceId ?? null,
    sourceKey: input.sourceKey.trim(),
    recognizedAmount: toDbMoney(input.recognizedAmount),
    beneficiaryType: input.beneficiaryType,
    beneficiarySupplierId: input.beneficiarySupplierId ?? null,
    beneficiaryName: input.beneficiaryName.trim(),
    evidenceReference: input.evidenceReference.trim(),
    plannedPaymentMethod: input.plannedPaymentMethod,
    clientRequestId: input.clientRequestId.trim(),
    recognizedBy: input.recognizedBy,
    recognizedAt: input.recognizedAt.toISOString(),
    recognitionAccountingEntryId: input.recognitionAccountingEntryId,
  });
}

export async function createAccrualObligationTx(tx: Tx, input: AccrualObligationSource) {
  assertSourceShape(input);
  const sourceKey = requiredText(input.sourceKey, "مفتاح مصدر الاستحقاق", 191);
  const clientRequestId = requiredText(input.clientRequestId, "مفتاح منع التكرار", 80);
  const beneficiaryName = requiredText(input.beneficiaryName, "اسم المستفيد", 200);
  const evidenceReference = requiredText(input.evidenceReference, "مرجع مستند المصدر", 191);
  const sourceHash = accrualObligationSourceHash({
    ...input,
    sourceKey,
    clientRequestId,
    beneficiaryName,
    evidenceReference,
  });
  const existing = await tx
    .select()
    .from(accrualObligations)
    .where(eq(accrualObligations.clientRequestId, clientRequestId))
    .for("update")
    .limit(1);
  if (existing[0]) {
    if (existing[0].sourceHash !== sourceHash) {
      throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency في مصدر الاستحقاق" });
    }
    return { ...existing[0], replayed: true as const };
  }

  const inserted = await tx.insert(accrualObligations).values({
    kind: input.kind,
    branchId: input.branchId,
    expenseId: input.expenseId ?? null,
    purchaseOrderId: input.purchaseOrderId ?? null,
    assetId: input.assetId ?? null,
    maintenanceId: input.maintenanceId ?? null,
    sourceKey,
    recognizedAmount: toDbMoney(input.recognizedAmount),
    status: input.initialStatus,
    beneficiaryType: input.beneficiaryType,
    beneficiarySupplierId: input.beneficiarySupplierId ?? null,
    beneficiaryName,
    evidenceReference,
    plannedPaymentMethod: input.plannedPaymentMethod,
    clientRequestId,
    sourceHash,
    recognizedBy: input.recognizedBy,
    recognizedAt: input.recognizedAt,
  });
  const obligationId = extractInsertId(inserted);
  await tx.insert(accrualObligationEvents).values({
    obligationId,
    eventType: "RECOGNIZED",
    amount: toDbMoney(input.recognizedAmount),
    accountingEntryId: input.recognitionAccountingEntryId,
    evidenceReference,
    actorId: input.recognizedBy,
    dedupeKey: `ACCRUAL:RECOGNIZED:${obligationId}`,
  });
  const [created] = await tx
    .select()
    .from(accrualObligations)
    .where(eq(accrualObligations.id, obligationId))
    .limit(1);
  if (!created) throw new Error("فشل إنشاء سجل الاستحقاق");
  return { ...created, replayed: false as const };
}

export async function lockAccrualObligationTx(tx: Tx, obligationId: number) {
  const [row] = await tx
    .select()
    .from(accrualObligations)
    .where(eq(accrualObligations.id, obligationId))
    .for("update")
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "التزام الاستحقاق غير موجود" });
  return row;
}

/**
 * Canonical recognition link for an accrual obligation.
 *
 * A pending payment receipt is deliberately not the recognition document: it
 * may be rejected and replaced while the original expense/asset recognition
 * remains immutable. Settlement callers must therefore follow
 * obligation -> RECOGNIZED event -> accounting entry and validate the source
 * snapshot under the same transaction lock.
 */
export async function lockAccrualRecognitionTx(tx: Tx, obligationId: number) {
  const obligation = await lockAccrualObligationTx(tx, obligationId);
  const recognitionEvents = await tx
    .select()
    .from(accrualObligationEvents)
    .where(
      and(
        eq(accrualObligationEvents.obligationId, obligationId),
        eq(accrualObligationEvents.eventType, "RECOGNIZED"),
      ),
    )
    .for("update")
    .limit(2);
  const event = recognitionEvents[0];
  if (
    recognitionEvents.length !== 1 ||
    !event ||
    event.receiptId != null ||
    event.accountingEntryId == null ||
    event.reviewerId != null ||
    Number(event.actorId) !== Number(obligation.recognizedBy) ||
    !money(event.amount).eq(money(obligation.recognizedAmount)) ||
    event.evidenceReference !== obligation.evidenceReference
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "حدث الاعتراف المرتبط بالالتزام مفقود أو تغيّر",
    });
  }

  const [entry] = await tx
    .select()
    .from(accountingEntries)
    .where(eq(accountingEntries.id, Number(event.accountingEntryId)))
    .for("update")
    .limit(1);
  const expectedEntryType =
    obligation.kind === "ASSET_ACQUISITION_SUPPLIER" ? "PURCHASE" : "ADJUST";
  const expectedProfile =
    obligation.kind === "ASSET_ACQUISITION_SUPPLIER"
      ? "PURCHASE_FIXED_ASSET"
      : obligation.kind === "ASSET_ACQUISITION_CASH"
        ? "ADJUST_FIXED_ASSET_ACCRUAL"
        : "ADJUST_EXPENSE_ACCRUAL";
  const sourceForeignKeysMatch =
    obligation.kind === "PURCHASE_SHIPPING"
      ? Number(entry?.purchaseOrderId) === Number(obligation.purchaseOrderId) &&
        entry?.supplierId == null
      : obligation.kind === "ASSET_ACQUISITION_SUPPLIER"
        ? Number(entry?.supplierId) === Number(obligation.beneficiarySupplierId) &&
          entry?.purchaseOrderId == null
        : entry?.purchaseOrderId == null && entry?.supplierId == null;
  if (
    !entry ||
    entry.entryType !== expectedEntryType ||
    (entry.postingProfile != null && entry.postingProfile !== expectedProfile) ||
    entry.dedupeKey !== obligation.sourceKey ||
    Number(entry.branchId) !== Number(obligation.branchId) ||
    entry.receiptId != null ||
    !money(entry.amount).eq(money(obligation.recognizedAmount)) ||
    !sourceForeignKeysMatch
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "قيد الاعتراف المرتبط بالالتزام مفقود أو تغيّر",
    });
  }

  return { obligation, event, entry };
}

export async function transitionAccrualObligationTx(
  tx: Tx,
  input: {
    obligationId: number;
    expectedStatus: AccrualObligationStatus | AccrualObligationStatus[];
    nextStatus: AccrualObligationStatus;
    eventType: AccrualObligationEventType;
    actorId: number;
    reviewerId?: number | null;
    receiptId?: number | null;
    accountingEntryId?: number | null;
    evidenceReference: string;
    dedupeKey: string;
    amount?: string;
  },
) {
  const obligation = await lockAccrualObligationTx(tx, input.obligationId);
  const expected = Array.isArray(input.expectedStatus) ? input.expectedStatus : [input.expectedStatus];
  if (!expected.includes(obligation.status as AccrualObligationStatus)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `حالة الالتزام ${obligation.status} لا تسمح بحدث ${input.eventType}`,
    });
  }
  const eventAmount = money(input.amount ?? obligation.recognizedAmount);
  if (!eventAmount.eq(money(obligation.recognizedAmount))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "التسوية والتصحيح كاملان فقط ويجب أن يطابقا أصل الالتزام" });
  }
  if (input.reviewerId != null && input.reviewerId === input.actorId) {
    const [reviewer] = await tx
      .select({ isOwner: users.isOwner, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, input.reviewerId))
      .limit(1);
    if (!reviewer?.isActive || !reviewer.isOwner) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الفصل بين المنشئ والمعتمد إلزامي" });
    }
  }
  const paymentRequestEvent = input.eventType === "PAYMENT_REQUESTED" || input.eventType === "PAYMENT_REJECTED";
  const settlementEvent = input.eventType === "PAYMENT_SETTLED" || input.eventType === "SETTLEMENT_REVERSED";
  const recognitionEvent = input.eventType === "RECOGNITION_REVERSED";
  const correctionEvent = input.eventType === "CORRECTION_REQUESTED" || input.eventType === "CORRECTION_REJECTED";
  if (
    (paymentRequestEvent && (input.receiptId == null || input.accountingEntryId != null)) ||
    (settlementEvent && (input.receiptId == null || input.accountingEntryId == null)) ||
    (recognitionEvent && (input.receiptId != null || input.accountingEntryId == null)) ||
    (correctionEvent && (input.receiptId != null || input.accountingEntryId != null))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `مراجع حدث الاستحقاق ${input.eventType} لا تطابق عقده المحاسبي`,
    });
  }
  await tx.insert(accrualObligationEvents).values({
    obligationId: input.obligationId,
    eventType: input.eventType,
    amount: toDbMoney(eventAmount),
    receiptId: input.receiptId ?? null,
    accountingEntryId: input.accountingEntryId ?? null,
    evidenceReference: requiredText(input.evidenceReference, "مرجع دليل الحدث", 191),
    actorId: input.actorId,
    reviewerId: input.reviewerId ?? null,
    dedupeKey: requiredText(input.dedupeKey, "مفتاح الحدث", 191),
  });
  const updateResult = await tx
    .update(accrualObligations)
    .set({ status: input.nextStatus })
    .where(and(eq(accrualObligations.id, input.obligationId), eq(accrualObligations.status, obligation.status)));
  const affectedRows = Number(
    (updateResult as unknown as [{ affectedRows?: number }])[0]?.affectedRows ??
      (updateResult as unknown as { affectedRows?: number }).affectedRows ??
      0,
  );
  if (affectedRows !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: "تغير إسقاط الالتزام أثناء إلحاق الحدث" });
  }
  return { ...obligation, status: input.nextStatus };
}

export async function assertAccrualRequestBindingTx(
  tx: Tx,
  input: {
    obligationId: number;
    sourceHash: string;
    branchId: number;
    amount: string;
    beneficiaryType: "SUPPLIER" | "OTHER";
    beneficiaryId: number | null;
    beneficiaryName: string;
    evidenceReference: string;
  },
) {
  const row = await lockAccrualObligationTx(tx, input.obligationId);
  if (
    row.sourceHash !== input.sourceHash ||
    Number(row.branchId) !== input.branchId ||
    !money(row.recognizedAmount).eq(money(input.amount)) ||
    row.beneficiaryType !== input.beneficiaryType ||
    (row.beneficiarySupplierId == null ? null : Number(row.beneficiarySupplierId)) !== input.beneficiaryId ||
    row.beneficiaryName !== input.beneficiaryName.trim() ||
    row.evidenceReference !== input.evidenceReference.trim()
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "طلب التسوية لا يطابق مصدر الالتزام المثبت" });
  }
  return row;
}

export async function latestAccrualEventTx(tx: Tx, obligationId: number) {
  return (await tx
    .select()
    .from(accrualObligationEvents)
    .where(eq(accrualObligationEvents.obligationId, obligationId))
    .orderBy(desc(accrualObligationEvents.id))
    .limit(1))[0] ?? null;
}

export function correctionPayloadHash(input: {
  obligationId: number;
  expectedAssetId?: number;
  reason: string;
  externalEvidenceReference: string;
  attachmentUrl?: string | null;
  refundPaymentMethod?: PaymentMethod | null;
  refundCashBucket?: "DRAWER" | "TREASURY" | null;
  refundReferenceNumber?: string | null;
  refundCardLastFour?: string | null;
  clientRequestId: string;
}) {
  return idempotencyHash({
    ...input,
    expectedAssetId: input.expectedAssetId ?? null,
    reason: input.reason.trim(),
    externalEvidenceReference: input.externalEvidenceReference.trim(),
    attachmentUrl: input.attachmentUrl?.trim() || null,
    refundReferenceNumber: input.refundReferenceNumber?.trim() || null,
    refundCardLastFour: input.refundCardLastFour?.trim() || null,
    clientRequestId: input.clientRequestId.trim(),
  });
}

export { accrualCorrectionRequests, accrualObligationEvents, accrualObligations };
