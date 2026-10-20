import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  accountingEntries,
  auditLogs,
  purchaseOrders,
  supplierInvoices,
  supplierPayments,
  suppliers,
  users,
} from "../../../drizzle/schema";
import { positiveMoneyString } from "../../lib/schemas";
import { enqueueFinancialRefresh } from "../../realtime/financialRefresh";
import { logAuditTx } from "../auditService";
import { baghdadToday } from "../businessDay";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { money, toDbMoney } from "../money";
import { type Actor, withGovernanceTx } from "../tx";
import {
  requestSupplierPaymentInTx,
  decideSupplierPaymentInTx,
} from "./supplierPayments";

const schema = z
  .object({
    attestationKey: z.string().trim().min(8).max(80),
    evidenceText: z.string().trim().min(20).max(2000),
    recordingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    payments: z
      .array(
        z
          .object({
            purchaseOrderId: z.number().int().positive(),
            supplierInvoiceId: z.number().int().positive(),
            invoiceVersion: z.number().int().positive(),
            amount: positiveMoneyString,
            actualPaymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type AttestedSupplierSettlementInput = z.input<typeof schema>;
type Result = {
  paymentIds: number[];
  receiptIds: number[];
  requestIds: number[];
  replayed: boolean;
  verification: Array<{
    kind: "TREASURY" | "SUPPLIER_AP";
    id: number;
    before: string;
    after: string;
    delta: string;
  }>;
};
const OPERATION = "supplier.attestedSettlement";
const ACTION = "supplier.attestedSettlement.record";
function fail(
  why: string,
  code: "CONFLICT" | "FORBIDDEN" | "BAD_REQUEST" = "CONFLICT",
): never {
  throw new TRPCError({
    code,
    message: appErrorMessage({
      what: "تعذر إثبات التسديد النقدي المفقود",
      why,
      doThis: "راجع إقرار المالك والفاتورة ومصدر الخزينة قبل إعادة المحاولة",
    }),
  });
}

/** Posts an owner-attested missing payment today; original payment dates remain evidence. */
export async function recordAttestedSupplierSettlement(
  raw: AttestedSupplierSettlementInput,
  caller: Actor,
): Promise<Result> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    fail("بيانات الإقرار أو مبالغ الفواتير غير صالحة", "BAD_REQUEST");
  const input = {
    ...parsed.data,
    payments: [...parsed.data.payments]
      .map((row) => ({ ...row, amount: toDbMoney(row.amount) }))
      .sort((a, b) => a.purchaseOrderId - b.purchaseOrderId),
  };
  if (
    new Set(input.payments.map((row) => row.supplierInvoiceId)).size !==
      input.payments.length ||
    new Set(input.payments.map((row) => row.purchaseOrderId)).size !==
      input.payments.length
  )
    fail("تكرر أمر الشراء أو الفاتورة في الإقرار", "BAD_REQUEST");
  const payloadHash = idempotencyHash(input);
  return withGovernanceTx(async (tx) => {
    const [owner] = await tx
      .select()
      .from(users)
      .where(eq(users.id, caller.userId))
      .for("share")
      .limit(1);
    if (!owner?.isActive || !owner.isOwner)
      fail("التسجيل بإقرار نقدي يتطلب مالكاً نشطاً", "FORBIDDEN");
    const actor: Actor = {
      userId: owner.id,
      branchId: owner.branchId ?? caller.branchId,
      role: owner.role,
      isOwner: true,
    };
    const previous = await checkIdempotency(
      tx,
      OPERATION,
      input.attestationKey,
      payloadHash,
      { requireStoredHash: true, forUpdate: true },
    );
    if (previous != null) {
      const [audit] = await tx
        .select({ value: auditLogs.newValue })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, ACTION),
            eq(auditLogs.entityType, "supplierPaymentBatch"),
            eq(auditLogs.entityId, String(previous)),
          ),
        )
        .orderBy(asc(auditLogs.id))
        .limit(1);
      const saved = audit?.value as Omit<Result, "replayed"> | undefined;
      if (
        !saved?.paymentIds?.length ||
        !saved.requestIds?.length ||
        !saved.receiptIds?.length
      )
        fail("سجل الإقرار السابق غير مكتمل");
      return { ...saved, replayed: true };
    }
    if (input.recordingDate !== baghdadToday())
      fail(
        "يجب تسجيل التصحيح بتاريخ اليوم مع حفظ تاريخ الدفع الفعلي في الإقرار",
        "BAD_REQUEST",
      );
    const groups = new Map<
      string,
      {
        supplierId: number;
        branchId: number;
        amount: ReturnType<typeof money>;
        allocations: Array<{
          supplierInvoiceId: number;
          invoiceVersion: number;
          amount: string;
          currencyAmount: string;
        }>;
      }
    >();
    const evidencePayments: Array<
      (typeof input.payments)[number] & {
        purchaseOrderDate: string;
        invoiceRecognitionDate: string;
      }
    > = [];
    for (const row of input.payments) {
      const [invoice] = await tx
        .select()
        .from(supplierInvoices)
        .where(eq(supplierInvoices.id, row.supplierInvoiceId))
        .for("update")
        .limit(1);
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, row.purchaseOrderId))
        .for("update")
        .limit(1);
      const [posting] = invoice?.postingEntryId
        ? await tx
            .select()
            .from(accountingEntries)
            .where(eq(accountingEntries.id, invoice.postingEntryId))
            .limit(1)
        : [];
      if (
        !invoice ||
        !po ||
        !posting ||
        invoice.origin !== "NATIVE" ||
        invoice.liabilityClass !== "NATIVE_AP" ||
        invoice.status !== "POSTED" ||
        invoice.paymentGate !== "OPEN" ||
        invoice.version !== row.invoiceVersion ||
        invoice.currency !== "IQD" ||
        po.agreedCurrency !== "IQD" ||
        po.status !== "RECEIVED" ||
        po.settlementType !== "CASH" ||
        baghdadToday(po.orderDate) !== row.actualPaymentDate ||
        row.actualPaymentDate > input.recordingDate ||
        posting.purchaseOrderId !== po.id ||
        posting.supplierId !== po.supplierId ||
        invoice.supplierId !== po.supplierId ||
        invoice.branchId !== po.branchId ||
        posting.branchId !== po.branchId ||
        !money(invoice.totalAmount).eq(row.amount) ||
        !money(po.total).eq(row.amount)
      )
        fail(
          "الفاتورة أو الأمر أو المبلغ أو النسخة أو التاريخ لا يطابق إقرار الدفع الكامل",
        );
      // A posted but unallocated payment could be the missing link itself. Never disburse it again.
      const laterPayments = await tx
        .select({ id: accountingEntries.id })
        .from(accountingEntries)
        .where(
          and(
            eq(accountingEntries.supplierId, po.supplierId),
            eq(accountingEntries.branchId, po.branchId),
            gt(accountingEntries.id, posting.id),
            inArray(accountingEntries.entryType, [
              "PAYMENT_OUT",
              "EXCHANGE_SETTLE",
            ]),
          ),
        )
        .orderBy(asc(accountingEntries.id))
        .limit(1001);
      if (laterPayments.length > 1000)
        fail("حجم دليل الدفع يتجاوز حد الفحص الآمن");
      // Conservatively stop if another payment followed this invoice. Its allocation must be reviewed first.
      if (laterPayments.length)
        fail("يوجد قيد سداد بعد الفاتورة؛ طابقه قبل تسجيل دفع نقدي إضافي");
      evidencePayments.push({
        ...row,
        purchaseOrderDate: baghdadToday(po.orderDate),
        invoiceRecognitionDate: invoice.invoiceDate,
      });
      const key = `${po.supplierId}:${po.branchId}`;
      const group = groups.get(key) ?? {
        supplierId: po.supplierId,
        branchId: po.branchId,
        amount: money(0),
        allocations: [],
      };
      group.amount = group.amount.plus(row.amount);
      group.allocations.push({
        supplierInvoiceId: invoice.id,
        invoiceVersion: invoice.version,
        amount: row.amount,
        currencyAmount: row.amount,
      });
      groups.set(key, group);
    }
    const result: Result = {
      paymentIds: [],
      receiptIds: [],
      requestIds: [],
      replayed: false,
      verification: [],
    };
    const groupRows = Array.from(groups.values()).sort(
      (a, b) => a.supplierId - b.supplierId || a.branchId - b.branchId,
    );
    const branchTotals = new Map<number, ReturnType<typeof money>>();
    const supplierTotals = new Map<number, ReturnType<typeof money>>();
    for (const group of groupRows) {
      branchTotals.set(
        group.branchId,
        (branchTotals.get(group.branchId) ?? money(0)).plus(group.amount),
      );
      supplierTotals.set(
        group.supplierId,
        (supplierTotals.get(group.supplierId) ?? money(0)).plus(group.amount),
      );
    }
    const cashBefore = new Map<number, string>();
    const apBefore = new Map<number, string>();
    for (const id of Array.from(branchTotals.keys()).sort((a, b) => a - b))
      cashBefore.set(id, toDbMoney(await computeTreasuryCashBalance(tx, id)));
    for (const id of Array.from(supplierTotals.keys()).sort((a, b) => a - b)) {
      const [supplier] = await tx
        .select({ balance: suppliers.currentBalance })
        .from(suppliers)
        .where(eq(suppliers.id, id))
        .limit(1);
      if (!supplier) fail("المورد المثبت في الإقرار غير موجود");
      apBefore.set(id, supplier.balance);
    }
    for (const group of Array.from(groups.values()).sort(
      (a, b) => a.supplierId - b.supplierId || a.branchId - b.branchId,
    )) {
      const amount = toDbMoney(group.amount);
      const request = await requestSupplierPaymentInTx(
        tx,
        {
          supplierId: group.supplierId,
          branchId: group.branchId,
          requestKey: `ATTESTED-CASH:${idempotencyHash(input.attestationKey).slice(0, 32)}:${group.supplierId}:${group.branchId}`,
          currency: "IQD",
          amount,
          currencyAmount: amount,
          paymentMethod: "CASH",
          cashSource: { mode: "TREASURY" },
          evidenceType: "CASH_ACKNOWLEDGEMENT",
          evidenceReference: `OWNER-ATTESTATION:${payloadHash}:${group.supplierId}:${group.branchId}`,
          reason:
            `إثبات دفع نقدي مفقود بإقرار المالك: ${input.evidenceText}`.slice(
              0,
              500,
            ),
          allocations: group.allocations,
        },
        actor,
      );
      const decision = await decideSupplierPaymentInTx(
        tx,
        {
          requestId: request.requestId,
          decisionKey: `ATTESTED-CASH-DECIDE:${request.requestId}`,
          action: "APPROVE",
          reviewReason:
            `إقرار المالك ${input.attestationKey}: نقد مدفوع فعلاً من الخزينة، وليس صرفاً جديداً مادياً`.slice(
              0,
              500,
            ),
        },
        actor,
      );
      if (decision.status !== "APPROVED" || !("supplierPaymentId" in decision))
        fail("لم يكتمل تسجيل الدفع المؤكد");
      const [payment] = await tx
        .select()
        .from(supplierPayments)
        .where(eq(supplierPayments.id, decision.supplierPaymentId!))
        .limit(1);
      if (!payment) fail("سجل الدفع المؤكد مفقود");
      result.requestIds.push(request.requestId);
      result.paymentIds.push(payment.id);
      result.receiptIds.push(payment.receiptId);
      enqueueFinancialRefresh(tx, group.branchId);
    }
    for (const [id, total] of Array.from(branchTotals)) {
      const before = cashBefore.get(id)!;
      const after = toDbMoney(await computeTreasuryCashBalance(tx, id));
      const delta = money(after).minus(before);
      if (!delta.eq(total.neg()))
        fail(
          "أثر الخزينة لا يطابق مجموع المبالغ المؤكدة؛ تراجعت العملية كاملة",
        );
      result.verification.push({
        kind: "TREASURY",
        id,
        before,
        after,
        delta: toDbMoney(delta),
      });
    }
    for (const [id, total] of Array.from(supplierTotals)) {
      const before = apBefore.get(id)!;
      const [supplier] = await tx
        .select({ balance: suppliers.currentBalance })
        .from(suppliers)
        .where(eq(suppliers.id, id))
        .limit(1);
      if (!supplier) fail("تعذرت مطابقة ذمة المورد بعد التسجيل");
      const delta = money(supplier.balance).minus(before);
      if (!delta.eq(total.neg()))
        fail("أثر ذمة المورد لا يطابق المبلغ المؤكد؛ تراجعت العملية كاملة");
      result.verification.push({
        kind: "SUPPLIER_AP",
        id,
        before,
        after: supplier.balance,
        delta: toDbMoney(delta),
      });
    }
    await logAuditTx(
      tx,
      {
        userId: actor.userId,
        actor: {
          source: "user",
          label: "إقرار مالك بتسديد نقدي سابق غير مسجل",
        },
      },
      {
        action: ACTION,
        entityType: "supplierPaymentBatch",
        entityId: result.requestIds[0],
        screenPath: "/purchases",
        newValue: {
          ...result,
          attestationKey: input.attestationKey,
          payloadHash,
          evidenceText: input.evidenceText,
          recordingDate: input.recordingDate,
          payments: evidencePayments,
          correctionRecordedAt: new Date().toISOString(),
        },
      },
    );
    await recordIdempotencyKey(
      tx,
      OPERATION,
      input.attestationKey,
      result.requestIds[0],
      payloadHash,
    );
    return result;
  });
}
