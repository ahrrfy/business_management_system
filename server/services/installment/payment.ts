// سداد قسط ذرّي: external attempt (إن وجد) -> invoice -> plan -> lines -> voucher/allocation.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  customers,
  idempotencyKeys,
  receipts,
  externalPaymentAttempts,
  installmentLines,
  installmentPlans,
  invoices,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { shiftIdForCashTx } from "../shiftService";
import { lockMaterializedCashReceiptSourceForWrite } from "../cash/cashAvailability";
import {
  installmentConflict,
  lockInstallmentPlanTx,
  installmentLineViews,
  installmentPlanViews,
  assertInstallmentScopeTx,
} from "./receiptAllocations";
import { saveInstallmentReceiptClaimTx } from "./receiptClaims";
import { assertInboundPaymentMethodEnabled } from "../inboundPaymentPolicy";
import { money, toDbMoney } from "../money";
import {
  assertExternalPaymentReplay,
  consumeConfirmedExternalPaymentAttemptTx,
  INSTALLMENT_EXTERNAL_PAYMENT_PROVIDER,
  type ExternalPaymentBindingInput,
  type LockedExternalPaymentAttempt,
} from "../posExternalPayment";
import { requireDb, type Actor, withTx } from "../tx";
import { createVoucherTx } from "../voucher/create";
import {
  assertPlanBranch,
  type BranchRestriction,
  type PayLineInput,
  type PayLineResult,
} from "./types";

type CollectionMethod = NonNullable<PayLineInput["paymentMethod"]>;

function voucherRequestKey(lineId: number, clientRequestId: string): string {
  // idempotencyKeys.clientRequestId سقفه 64؛ UUID + أكبر bigint يبقيان هذا المفتاح <= 59.
  return `ip:${lineId}:${clientRequestId}`;
}

function assertExternalEvidenceMatches(
  input: PayLineInput,
  attempt: LockedExternalPaymentAttempt,
): void {
  const suppliedReference = input.referenceNumber?.trim() || null;
  if (
    suppliedReference != null &&
    suppliedReference !== attempt.externalReference.trim()
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "مرجع السداد لا يطابق مرجع محاولة الدفع المؤكدة",
    });
  }
}

const INSTALLMENT_BINDING_RE = /:INSTALLMENT_LINE:(\d+)$/;

/**
 * طابور الاعتماد اليدويّ غير النقدي. لا يعرض إلا المحاولات غير المستهلكة ذات الربط
 * البنيوي الصحيح بقسطٍ حيّ في الفرع المسموح؛ الصف المنجرف يُحجب fail-closed.
 */
export async function listPendingInstallmentExternalPayments(
  input: { branchId?: number | null; limit?: number },
  actor: Actor,
  restrictToBranchId: BranchRestriction = null,
) {
  if (
    restrictToBranchId != null &&
    input.branchId != null &&
    Number(input.branchId) !== Number(restrictToBranchId)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يمكن عرض اعتمادات تحصيل لفرع آخر",
    });
  }
  const effectiveBranchId = restrictToBranchId ?? input.branchId ?? null;
  const db = requireDb();
  const attempts = await db
    .select()
    .from(externalPaymentAttempts)
    .where(
      and(
        eq(
          externalPaymentAttempts.providerCode,
          INSTALLMENT_EXTERNAL_PAYMENT_PROVIDER,
        ),
        inArray(externalPaymentAttempts.state, ["INITIATED", "CONFIRMED"]),
        isNull(externalPaymentAttempts.invoiceId),
        isNull(externalPaymentAttempts.receiptId),
        isNull(externalPaymentAttempts.consumedAt),
        effectiveBranchId == null
          ? undefined
          : eq(externalPaymentAttempts.branchId, effectiveBranchId),
      ),
    )
    .orderBy(desc(externalPaymentAttempts.id))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 200));

  const scoped = attempts.flatMap((attempt) => {
    const match = attempt.accountReference.match(INSTALLMENT_BINDING_RE);
    if (!match) return [];
    const lineId = Number(match[1]);
    if (!Number.isSafeInteger(lineId) || lineId <= 0) return [];
    return [{ attempt, lineId }];
  });
  if (scoped.length === 0) return [];

  const lineIds = Array.from(new Set(scoped.map((row) => row.lineId)));
  const details = await db
    .select({
      lineId: installmentLines.id,
      lineSeq: installmentLines.seq,
      lineAmount: installmentLines.amount,
      lineStatus: installmentLines.status,
      dueDate: installmentLines.dueDate,
      planId: installmentPlans.id,
      planStatus: installmentPlans.status,
      branchId: installmentPlans.branchId,
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerId: customers.id,
      customerName: customers.name,
    })
    .from(installmentLines)
    .innerJoin(
      installmentPlans,
      eq(installmentLines.planId, installmentPlans.id),
    )
    .innerJoin(invoices, eq(installmentPlans.invoiceId, invoices.id))
    .innerJoin(customers, eq(installmentPlans.customerId, customers.id))
    .where(inArray(installmentLines.id, lineIds));
  const detailByLine = new Map(
    details.map((detail) => [Number(detail.lineId), detail]),
  );
  const planIds = Array.from(new Set(details.map((row) => row.planId)));
  const plans = planIds.length
    ? await db
        .select()
        .from(installmentPlans)
        .where(inArray(installmentPlans.id, planIds))
    : [];
  const actualLines = planIds.length
    ? await db
        .select()
        .from(installmentLines)
        .where(inArray(installmentLines.planId, planIds))
    : [];
  const actualViews = await installmentLineViews(db, actualLines);
  const scopeViews = await installmentPlanViews(
    db,
    plans,
    actualLines,
    actualViews,
  );
  const creatorIds = Array.from(
    new Set(scoped.map(({ attempt }) => Number(attempt.createdBy))),
  );
  const creators = await db
    .select({ id: users.id, name: users.name, username: users.username })
    .from(users)
    .where(inArray(users.id, creatorIds));
  const creatorById = new Map(
    creators.map((creator) => [
      Number(creator.id),
      creator.name || creator.username || `#${creator.id}`,
    ]),
  );

  return scoped.flatMap(({ attempt, lineId }) => {
    const detail = detailByLine.get(lineId);
    if (!detail) return [];
    const expectedAccount =
      `BRANCH:${Number(attempt.branchId)}:${attempt.paymentMethod}` +
      `:INSTALLMENT_LINE:${lineId}`;
    if (
      attempt.accountReference !== expectedAccount ||
      Number(detail.branchId) !== Number(attempt.branchId) ||
      actualViews.get(lineId)?.reconciliationRequired ||
      scopeViews.get(detail.planId)?.reconciliationRequired ||
      !money(actualViews.get(lineId)?.remainingAmount ?? "0").eq(
        money(attempt.amount),
      ) ||
      detail.lineStatus === "PAID" ||
      detail.lineStatus === "CANCELLED" ||
      detail.planStatus !== "ACTIVE"
    ) {
      return [];
    }
    const createdBy = Number(attempt.createdBy);
    const confirmedBy =
      attempt.confirmedBy == null ? null : Number(attempt.confirmedBy);
    return [
      {
        attemptId: Number(attempt.id),
        lineId,
        lineSeq: Number(detail.lineSeq),
        dueDate: detail.dueDate,
        planId: Number(detail.planId),
        invoiceId: Number(detail.invoiceId),
        invoiceNumber: detail.invoiceNumber,
        customerId: Number(detail.customerId),
        customerName: detail.customerName,
        branchId: Number(detail.branchId),
        amount: attempt.amount,
        paymentMethod: attempt.paymentMethod,
        reference: attempt.externalReference,
        deviceId: attempt.deviceId,
        state: attempt.state as "INITIATED" | "CONFIRMED",
        createdBy,
        createdByName: creatorById.get(createdBy) ?? `#${createdBy}`,
        confirmedBy,
        createdAt: attempt.createdAt,
        confirmedAt: attempt.confirmedAt,
        canConfirm: attempt.state === "INITIATED" && createdBy !== actor.userId,
        canSettle:
          attempt.state === "CONFIRMED" &&
          confirmedBy === actor.userId &&
          createdBy !== actor.userId,
      },
    ];
  });
}

/**
 * لا إيصال يسبق وسم القسط بعد الآن: إثبات المزوّد، createVoucherTx، التخصيص،
 * وPAID/COMPLETED كلها داخل المعاملة نفسها. أي throw يعكسها جميعاً.
 */
class RestartInstallmentTransaction extends Error {}
function requestHash(
  input: PayLineInput,
  actor: Actor,
  receipt: typeof receipts.$inferSelect,
) {
  return idempotencyHash({
    lineId: input.lineId,
    actorId: actor.userId,
    actorBranch: actor.branchId ?? null,
    amount: toDbMoney(receipt.amount),
    actualShiftId: receipt.shiftId,
    actualCashBucket: receipt.cashBucket,
    paymentMethod: input.paymentMethod ?? "CASH",
    note: input.note?.trim() || null,
    referenceNumber: input.referenceNumber?.trim() || null,
    cardLastFour: input.cardLastFour?.trim() || null,
    attachmentUrl: input.attachmentUrl?.trim() || null,
    externalPaymentAttemptId: input.externalPaymentAttemptId ?? null,
    deviceId: input.deviceId?.trim() || null,
  });
}
export async function payLine(
  input: PayLineInput,
  actor: Actor,
  restrictToBranchId: BranchRestriction = null,
): Promise<PayLineResult> {
  const method: CollectionMethod = input.paymentMethod ?? "CASH";
  assertInboundPaymentMethodEnabled(method);
  const request = input.clientRequestId.trim();
  if (!request || request.length > 36)
    installmentConflict("معرّف محاولة السداد غير صالح");
  if (
    method === "CASH" &&
    (input.externalPaymentAttemptId != null || input.deviceId?.trim())
  )
    installmentConflict("السداد النقدي لا يحمل محاولة دفع خارجية");
  if (
    method !== "CASH" &&
    (!input.externalPaymentAttemptId || !input.deviceId?.trim())
  )
    installmentConflict("أكّد الدفع الخارجي من جهاز التحصيل قبل سداد القسط");
  if (method === "CARD" && !/^\d{4}$/.test(input.cardLastFour?.trim() ?? ""))
    installmentConflict("آخر ٤ من البطاقة إلزامي لطريقة الدفع «بطاقة» (٤ أرقام)");
  const requestKey = `${input.lineId}:${request}`;
  const execute = async (
    tx: Tx,
    replayOnly = false,
  ): Promise<PayLineResult> => {
    const [key] = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.operation, "installment.pay"),
          eq(idempotencyKeys.clientRequestId, requestKey),
        ),
      );
    const [preview] = await tx
      .select({ line: installmentLines, plan: installmentPlans })
      .from(installmentLines)
      .innerJoin(
        installmentPlans,
        eq(installmentPlans.id, installmentLines.planId),
      )
      .where(eq(installmentLines.id, input.lineId));
    if (!preview || preview.plan.invoiceId == null)
      installmentConflict("الخطة التاريخية غير مرتبطة بفاتورة؛ راجع المطابقة");
    assertPlanBranch(preview.plan.branchId, restrictToBranchId);
    const invoiceId = preview.plan.invoiceId;
    const [saved] = key
      ? await tx.select().from(receipts).where(eq(receipts.id, key.refId))
      : [];
    if (key && (!saved || key.payloadHash !== requestHash(input, actor, saved)))
      installmentConflict(
        "تعارض idempotency: معرّف السداد محفوظ بحمولة مختلفة",
      );
    if (!key && replayOnly) throw new RestartInstallmentTransaction();
    // Saved identity wins before today's drawer and remaining amount.
    let cashRoute: Awaited<ReturnType<typeof shiftIdForCashTx>> | undefined;
    if (!key && method === "CASH") {
      cashRoute = await shiftIdForCashTx(
        tx,
        actor,
        preview.plan.branchId,
        "تحصيل قسط",
      );
      await lockMaterializedCashReceiptSourceForWrite(tx, {
        ...cashRoute,
        branchId: preview.plan.branchId,
        paymentMethod: "CASH",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
      });
    }
    const binding = (amount: string): ExternalPaymentBindingInput => ({
      branchId: preview.plan.branchId,
      channel: "SALES_COLLECTION",
      method,
      amount,
      attemptId: input.externalPaymentAttemptId,
      deviceId: input.deviceId?.trim() || null,
      verificationPolicy: "INDEPENDENT_APPROVAL",
      businessBinding: { type: "INSTALLMENT_LINE", id: input.lineId },
    });
    const settle = async (
      attempt: LockedExternalPaymentAttempt | null,
    ): Promise<PayLineResult> => {
      if (attempt) assertExternalEvidenceMatches(input, attempt);
      const [inv] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .for("update");
      const state = await lockInstallmentPlanTx(tx, preview.plan.id);
      if (
        !inv ||
        !state ||
        state.plan.invoiceId !== inv.id ||
        state.plan.customerId !== inv.customerId ||
        state.plan.branchId !== inv.branchId
      )
        installmentConflict("تغير ربط الخطة بالفاتورة");
      assertPlanBranch(state.plan.branchId, restrictToBranchId);
      const line = state.lines.find((row) => row.id === input.lineId);
      if (!line) installmentConflict("سطر القسط مفقود");
      if (key && saved) {
        const originals = line.allocations.filter(
          (row) => row.effectReceiptId === saved.id && money(row.amount).gt(0),
        );
        const reversed = new Set(
          line.allocations.map((row) => row.reversesAllocationId),
        );
        if (
          originals.some((row) => reversed.has(row.id)) ||
          saved.status === "REVERSED" ||
          saved.status === "FAILED" ||
          saved.approvalStatus === "REJECTED"
        )
          installmentConflict(
            "محاولة التحصيل الأصلية معكوسة أو مرفوضة؛ استخدم طلباً جديداً",
          );
        if (method !== "CASH")
          await assertExternalPaymentReplay(
            tx,
            invoiceId,
            binding(saved.amount),
            actor,
            saved.id,
          );
        return {
          receiptId: saved.id,
          voucherNumber: saved.voucherNumber ?? String(saved.id),
          status:
            saved.approvalStatus !== "APPROVED"
              ? "PENDING_APPROVAL"
              : originals.length
                ? "PAID"
                : "UNALLOCATED",
          planCompleted: state.plan.status === "COMPLETED",
        };
      }
      if (
        line.allocationHeadId !== preview.line.allocationHeadId ||
        line.pendingAllocationClaimId !==
          preview.line.pendingAllocationClaimId ||
        line.receiptId !== preview.line.receiptId
      )
        throw new RestartInstallmentTransaction();
      if (line.pendingAllocationClaimId != null)
        installmentConflict("للقسط سند بانتظار الاعتماد");
      if (
        state.plan.status !== "ACTIVE" ||
        line.status === "CANCELLED" ||
        line.remaining.lte(0)
      )
        installmentConflict("هذا القسط مسدَّد بالفعل أو الخطة غير نشطة");
      await assertInstallmentScopeTx(tx, state, inv);
      const outstanding = money(inv.total)
        .minus(inv.returnedTotal)
        .minus(inv.paidAmount);
      if (
        !outstanding.eq(
          state.lines.reduce((sum, row) => sum.plus(row.remaining), money(0)),
        )
      )
        installmentConflict("رصيد الفاتورة الحي لا يطابق أقساط الخطة المتبقية");
      if (attempt && !money(attempt.amount).eq(line.remaining))
        installmentConflict("الدفع الخارجي لا يطابق متبقي القسط الحالي");
      const voucher = await createVoucherTx(
        tx,
        {
          voucherType: "RECEIPT",
          branchId: state.plan.branchId,
          amount: toDbMoney(line.remaining),
          paymentMethod: method,
          partyType: "CUSTOMER",
          partyId: state.plan.customerId,
          description: `تحصيل القسط رقم ${line.seq} من خطة الأقساط #${state.plan.id}`,
          referenceNumber: attempt?.externalReference.trim() || null,
          cardLastFour:
            method === "CARD" ? input.cardLastFour?.trim() || null : null,
          voucherCategoryId: null,
          invoiceId,
          attachmentUrl: input.attachmentUrl ?? null,
          internalNote: input.note?.trim() || null,
          clientRequestId: voucherRequestKey(input.lineId, request),
        },
        actor,
        {
          installmentTarget: {
            lineId: line.id,
            effectKey: `INSTALLMENT:${requestKey}`,
          },
          prelockedCashRoute: cashRoute,
        },
      );
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, voucher.receiptId));
      if (!receipt) installmentConflict("سند التحصيل مفقود");
      await saveInstallmentReceiptClaimTx(
        tx,
        line.id,
        state.plan,
        receipt,
        voucher.approvalStatus !== "APPROVED",
      );
      await recordIdempotencyKey(
        tx,
        "installment.pay",
        requestKey,
        receipt.id,
        requestHash(input, actor, receipt),
      );
      const current = await lockInstallmentPlanTx(tx, state.plan.id);
      return {
        receiptId: receipt.id,
        voucherNumber: voucher.voucherNumber,
        status:
          voucher.approvalStatus !== "APPROVED" ? "PENDING_APPROVAL" : "PAID",
        planCompleted: current?.plan.status === "COMPLETED",
      };
    };
    if (key || method === "CASH") return settle(null);
    const [external] = await tx
      .select({ amount: externalPaymentAttempts.amount })
      .from(externalPaymentAttempts)
      .where(eq(externalPaymentAttempts.id, input.externalPaymentAttemptId!));
    if (!external) installmentConflict("محاولة الدفع الخارجي مفقودة");
    const amount = external.amount;
    return consumeConfirmedExternalPaymentAttemptTx(
      tx,
      binding(amount),
      actor,
      async (attempt) => {
        const value = await settle(attempt);
        return { invoiceId, receiptId: value.receiptId, value };
      },
    );
  };
  let firstError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withTx((tx) => execute(tx));
    } catch (error) {
      firstError ??= error;
      if (error instanceof RestartInstallmentTransaction) continue;
      // A route error can occur before the current-line comparison; retry only saved identity first.
      try {
        return await withTx((tx) => execute(tx, true));
      } catch (replayError) {
        if (!(replayError instanceof RestartInstallmentTransaction))
          throw replayError;
      }
      const code =
        (error as { code?: string; cause?: { code?: string } }).cause?.code ??
        (error as { code?: string }).code;
      if (code === "ER_DUP_ENTRY" || code === "ER_LOCK_DEADLOCK") continue;
      throw error;
    }
  }
  if (firstError instanceof RestartInstallmentTransaction)
    installmentConflict("تغير التحصيل بالتزامن؛ حدّث الخطة وأعد نفس الطلب");
  throw firstError;
}
