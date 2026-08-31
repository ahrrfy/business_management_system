// سداد قسط ذرّي: external attempt (إن وجد) -> invoice -> plan -> lines -> voucher/allocation.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  customers,
  externalPaymentAttempts,
  installmentLines,
  installmentPlans,
  invoices,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { findIdempotentRefId } from "../idempotency";
import { assertInboundPaymentMethodEnabled } from "../inboundPaymentPolicy";
import { money, sumMoney, toDbMoney } from "../money";
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
      !money(detail.lineAmount).eq(money(attempt.amount)) ||
      detail.lineStatus === "PAID" ||
      detail.lineStatus === "CANCELLED" ||
      detail.planStatus !== "ACTIVE"
    ) {
      return [];
    }
    const createdBy = Number(attempt.createdBy);
    const confirmedBy =
      attempt.confirmedBy == null ? null : Number(attempt.confirmedBy);
    return [{
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
      canConfirm:
        attempt.state === "INITIATED" && createdBy !== actor.userId,
      canSettle:
        attempt.state === "CONFIRMED" &&
        confirmedBy === actor.userId &&
        createdBy !== actor.userId,
    }];
  });
}

/**
 * لا إيصال يسبق وسم القسط بعد الآن: إثبات المزوّد، createVoucherTx، التخصيص،
 * وPAID/COMPLETED كلها داخل المعاملة نفسها. أي throw يعكسها جميعاً.
 */
export async function payLine(
  input: PayLineInput,
  actor: Actor,
  restrictToBranchId: BranchRestriction = null,
): Promise<PayLineResult> {
  const method: CollectionMethod = input.paymentMethod ?? "CASH";
  assertInboundPaymentMethodEnabled(method);
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId || clientRequestId.length > 36) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "معرّف محاولة السداد غير صالح",
    });
  }
  if (
    method === "CASH" &&
    (input.externalPaymentAttemptId != null || input.deviceId?.trim())
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "السداد النقدي لا يحمل محاولة دفع خارجية",
    });
  }
  if (method !== "CASH") {
    if (input.externalPaymentAttemptId == null || !input.deviceId?.trim()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "أكّد الدفع الخارجي من جهاز التحصيل قبل سداد القسط",
      });
    }
    if (method === "CARD" && !/^\d{4}$/.test(input.cardLastFour?.trim() ?? "")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "آخر ٤ من البطاقة إلزامي لطريقة الدفع «بطاقة» (٤ أرقام)",
      });
    }
  }

  // تحديد مفاتيح القفل يسبق المعاملة: القراءة المتسقة داخل معاملة MySQL قبل انتظار
  // invoice FOR UPDATE تُجمّد snapshot قديمة، فتمنع exact replay من رؤية مفتاح السند
  // الذي التزم به الطلب الفائز. القيم هنا إرشادية فقط وتُعاد مطابقتها بعد الأقفال.
  const preview = (
    await requireDb()
      .select({
        planId: installmentPlans.id,
        invoiceId: installmentPlans.invoiceId,
        branchId: installmentPlans.branchId,
        lineAmount: installmentLines.amount,
      })
      .from(installmentLines)
      .innerJoin(installmentPlans, eq(installmentLines.planId, installmentPlans.id))
      .where(eq(installmentLines.id, input.lineId))
      .limit(1)
  )[0];
  if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "القسط غير موجود" });
  assertPlanBranch(Number(preview.branchId), restrictToBranchId);
  if (preview.invoiceId == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "الخطة التاريخية غير مرتبطة بفاتورة؛ اربطها أو أعد جدولتها قبل التحصيل",
    });
  }

  const execute = async (tx: Tx, allowExternalConsume: boolean): Promise<PayLineResult> => {
    const invoiceId = Number(preview.invoiceId);
    const requestKey = voucherRequestKey(Number(input.lineId), clientRequestId);

    const settleLocked = async (
      externalAttempt: LockedExternalPaymentAttempt | null,
    ): Promise<PayLineResult> => {
      if (externalAttempt) assertExternalEvidenceMatches(input, externalAttempt);

      const inv = (
        await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, invoiceId))
          .for("update")
          .limit(1)
      )[0];
      if (!inv) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "فاتورة الخطة مفقودة؛ أوقف التحصيل وراجع التدقيق",
        });
      }

      const plan = (
        await tx
          .select()
          .from(installmentPlans)
          .where(eq(installmentPlans.id, Number(preview.planId)))
          .for("update")
          .limit(1)
      )[0];
      if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة" });
      assertPlanBranch(Number(plan.branchId), restrictToBranchId);
      if (
        Number(plan.invoiceId) !== Number(inv.id) ||
        Number(plan.branchId) !== Number(inv.branchId) ||
        Number(plan.customerId) !== Number(inv.customerId)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "ربط الخطة بالفاتورة/العميل/الفرع غير متسق؛ أوقف التحصيل وراجع التدقيق",
        });
      }

      // قفل كل الأسطر يجعل دفعتين متزامنتين لخطة واحدة متسلسلتين ويثبّت مجموع المتبقي.
      const lines = await tx
        .select()
        .from(installmentLines)
        .where(eq(installmentLines.planId, Number(plan.id)))
        .for("update");
      const line = lines.find((row) => Number(row.id) === Number(input.lineId));
      if (!line) throw new TRPCError({ code: "NOT_FOUND", message: "القسط غير موجود" });
      if (!money(line.amount).eq(money(preview.lineAmount))) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّر مبلغ القسط بعد بدء محاولة التحصيل؛ حدّث الصفحة وأعد المحاولة",
        });
      }

      const existingReceiptId = await findIdempotentRefId(
        tx,
        "voucher.create",
        requestKey,
      );
      const planWasCompleted = plan.status === "COMPLETED";
      if (line.status === "PAID" && existingReceiptId == null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "هذا القسط مسدَّد بالفعل" });
      }
      if (line.status === "CANCELLED") {
        throw new TRPCError({ code: "CONFLICT", message: "هذا القسط ملغى — لا يمكن سداده" });
      }
      if (line.status !== "PAID" && plan.status !== "ACTIVE") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الخطة غير نشطة — لا يمكن سداد أقساطها" });
      }

      const unpaidSchedule = sumMoney(
        lines
          .filter((row) => row.status === "PENDING" || row.status === "BOUNCED")
          .map((row) => row.amount),
      );
      const liveOutstanding = money(inv.total)
        .minus(money(inv.returnedTotal ?? "0"))
        .minus(money(inv.paidAmount ?? "0"));
      if (!liveOutstanding.eq(unpaidSchedule)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            `رصيد الفاتورة الحي (${toDbMoney(liveOutstanding)}) لا يطابق أقساط الخطة المتبقية ` +
            `(${toDbMoney(unpaidSchedule)}). أوقف التحصيل وأعد الجدولة محكوماً.`,
        });
      }

      const scheduledCheckInfo =
        line.kind === "CHECK"
          ? ` (مجدول تاريخياً بصك رقم ${line.checkNumber ?? "—"}${line.bankName ? ` — ${line.bankName}` : ""})`
          : "";
      const description = `تحصيل القسط رقم ${line.seq} من خطة الأقساط #${plan.id}${scheduledCheckInfo}`;
      const externalReference = externalAttempt?.externalReference.trim() || null;
      const voucher = await createVoucherTx(
        tx,
        {
          voucherType: "RECEIPT",
          branchId: Number(plan.branchId),
          amount: toDbMoney(line.amount),
          paymentMethod: method,
          partyType: "CUSTOMER",
          partyId: Number(plan.customerId),
          description,
          referenceNumber: externalReference,
          cardLastFour: method === "CARD" ? input.cardLastFour?.trim() || null : null,
          checkNumber: undefined,
          voucherCategoryId: null,
          invoiceId: Number(plan.invoiceId),
          attachmentUrl: input.attachmentUrl ?? null,
          internalNote: JSON.stringify({
            kind: "INSTALLMENT_PAYMENT",
            planId: Number(plan.id),
            lineId: Number(line.id),
            clientRequestId,
            externalPaymentAttemptId:
              externalAttempt == null ? null : Number(externalAttempt.id),
            operatorNote: input.note?.trim() || null,
          }),
          clientRequestId: requestKey,
        },
        actor,
      );

      if (line.status === "PAID") {
        if (Number(line.receiptId) !== Number(voucher.receiptId)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "القسط سُدِّد بسند آخر؛ حدّث الشاشة",
          });
        }
        return {
          status: "PAID",
          receiptId: voucher.receiptId,
          voucherNumber: voucher.voucherNumber,
          planCompleted: planWasCompleted,
        };
      }
      if (voucher.approvalStatus !== "APPROVED") {
        await tx
          .update(installmentLines)
          .set({
            receiptId: voucher.receiptId,
            note: `سند قبض ${voucher.voucherNumber} بانتظار الاعتماد`.slice(0, 255),
          })
          .where(eq(installmentLines.id, Number(line.id)));
        return {
          status: "PENDING_APPROVAL",
          receiptId: voucher.receiptId,
          voucherNumber: voucher.voucherNumber,
          planCompleted: false,
        };
      }

      await tx
        .update(installmentLines)
        .set({
          status: "PAID",
          receiptId: voucher.receiptId,
          paidAt: new Date(),
          note: input.note?.trim() ? input.note.trim().slice(0, 255) : line.note,
        })
        .where(eq(installmentLines.id, Number(line.id)));

      const remaining = lines.filter(
        (row) =>
          Number(row.id) !== Number(line.id) &&
          (row.status === "PENDING" || row.status === "BOUNCED"),
      );
      const planCompleted = remaining.length === 0;
      if (planCompleted) {
        await tx
          .update(installmentPlans)
          .set({ status: "COMPLETED" })
          .where(
            and(
              eq(installmentPlans.id, Number(plan.id)),
              eq(installmentPlans.status, "ACTIVE"),
            ),
          );
      }

      return {
        status: "PAID",
        receiptId: voucher.receiptId,
        voucherNumber: voucher.voucherNumber,
        planCompleted,
      };
    };

    if (method === "CASH") return settleLocked(null);

    const binding: ExternalPaymentBindingInput = {
      branchId: Number(preview.branchId),
      channel: "SALES_COLLECTION",
      method,
      amount: toDbMoney(preview.lineAmount),
      attemptId: input.externalPaymentAttemptId,
      deviceId: input.deviceId?.trim() || null,
      verificationPolicy: "INDEPENDENT_APPROVAL",
      businessBinding: { type: "INSTALLMENT_LINE", id: Number(input.lineId) },
    };
    const existingReceiptId = await findIdempotentRefId(
      tx,
      "voucher.create",
      requestKey,
    );
    if (existingReceiptId != null) {
      await assertExternalPaymentReplay(
        tx,
        invoiceId,
        binding,
        actor,
        existingReceiptId,
      );
      const attempt = (
        await tx
          .select()
          .from(externalPaymentAttempts)
          .where(eq(externalPaymentAttempts.id, Number(input.externalPaymentAttemptId)))
          .limit(1)
      )[0];
      if (!attempt) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "محاولة الدفع المرتبطة بالسند مفقودة؛ راجع التدقيق",
        });
      }
      return settleLocked(attempt);
    }
    if (!allowExternalConsume) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "محاولة الدفع مستهلكة ولا تطابق طلب السداد الحالي",
      });
    }

    return consumeConfirmedExternalPaymentAttemptTx(
      tx,
      binding,
      actor,
      async (attempt) => {
        const value = await settleLocked(attempt);
        return { invoiceId, receiptId: value.receiptId, value };
      },
    );
  };

  try {
    return await withTx((tx) => execute(tx, true));
  } catch (error) {
    // في سباق exact duplicate قد ينتظر الطلب الثاني قفل المحاولة ثم يراها مستهلكة.
    // بعد التزام الفائز نعيد قراءة مفتاح السند وبصمة المحاولة؛ لا يُقبَل إلا التطابق الكامل.
    if (
      method === "CASH" ||
      !(error instanceof TRPCError) ||
      error.code !== "CONFLICT"
    ) {
      throw error;
    }
    try {
      return await withTx((tx) => execute(tx, false));
    } catch {
      throw error;
    }
  }
}
