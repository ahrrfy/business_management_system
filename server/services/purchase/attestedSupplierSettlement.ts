import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, eq, inArray } from "drizzle-orm";
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
import type { Tx } from "../../db";
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
import { assertAttestedPaymentEvidenceTx } from "./attestedPaymentEvidence";
import { resolvePurchaseIntegrityForOwnerInTx } from "./integrityCases";
import { sha256 } from "./grniAccounting";

const schema = z
  .object({
    attestationKey: z.string().trim().min(8).max(80),
    evidenceText: z.string().trim().min(20).max(2000),
    recordingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    evidenceCases: z
      .array(
        z
          .object({
            caseId: z.number().int().positive(),
            purchaseOrderId: z.number().int().positive(),
            supplierInvoiceId: z.number().int().positive(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
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
  resolvedEvidenceCaseIds: number[];
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
const MANIFEST_ACTION = "supplier.attestedSettlement.manifest";
const FRAGMENT_ACTION = "supplier.attestedSettlement.fragment";
const FORMAT = "attestedSettlement.fragments.v1";
const MAX_FRAGMENTS = 4096;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z
  .object({
    format: z.literal(FORMAT),
    payloadHash: hashSchema,
    digest: hashSchema,
    count: z.number().int().min(1).max(MAX_FRAGMENTS),
    encoding: z.literal("base64-json"),
  })
  .strict();
const fragmentSchema = manifestSchema
  .omit({ encoding: true })
  .extend({
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_FRAGMENTS - 1),
    data: z
      .string()
      .min(1)
      .max(800)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
const idsSchema = z.array(z.number().int().positive()).max(50);
const resultSchema = z.object({
  paymentIds: idsSchema.min(1),
  receiptIds: idsSchema.min(1),
  requestIds: idsSchema.min(1),
  replayed: z.boolean(),
  resolvedEvidenceCaseIds: idsSchema,
  verification: z
    .array(
      z.object({
        kind: z.enum(["TREASURY", "SUPPLIER_AP"]),
        id: z.number().int().positive(),
        before: z.string(),
        after: z.string(),
        delta: z.string(),
      }),
    )
    .min(1)
    .max(100),
});
function checkedResult(value: unknown, referenceId: number): Result {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) fail("سجل الإقرار السابق غير مكتمل");
  const result = parsed.data;
  if (
    result.requestIds[0] !== referenceId ||
    result.paymentIds.length !== result.requestIds.length ||
    result.receiptIds.length !== result.requestIds.length ||
    [
      result.paymentIds,
      result.requestIds,
      result.receiptIds,
      result.resolvedEvidenceCaseIds,
    ].some((ids) => new Set(ids).size !== ids.length)
  )
    fail("هويات نتيجة الإقرار السابق غير متطابقة");
  return result;
}
async function savedResult(
  tx: Tx,
  referenceId: number,
  payloadHash: string,
): Promise<Result> {
  const rows = await tx
    .select({ action: auditLogs.action, value: auditLogs.newValue })
    .from(auditLogs)
    .where(
      and(
        inArray(auditLogs.action, [ACTION, MANIFEST_ACTION, FRAGMENT_ACTION]),
        eq(auditLogs.entityType, "supplierPaymentBatch"),
        eq(auditLogs.entityId, String(referenceId)),
      ),
    )
    .orderBy(asc(auditLogs.id))
    .limit(MAX_FRAGMENTS + 3);
  if (rows.length > MAX_FRAGMENTS + 2)
    fail("سجل الإقرار تجاوز حد الأجزاء الآمن");
  const manifests = rows.filter((row) => row.action === MANIFEST_ACTION);
  const fragments = rows.filter((row) => row.action === FRAGMENT_ACTION);
  if (!manifests.length && !fragments.length) {
    const legacy = rows.filter((row) => row.action === ACTION);
    const value = legacy[0]?.value as Record<string, unknown> | undefined;
    if (legacy.length !== 1 || value?.payloadHash !== payloadHash)
      fail("سجل الإقرار السابق غير مكتمل");
    return checkedResult(value, referenceId);
  }
  const parsedManifest = manifestSchema.safeParse(manifests[0]?.value);
  if (
    manifests.length !== 1 ||
    !parsedManifest.success ||
    parsedManifest.data.payloadHash !== payloadHash ||
    fragments.length !== parsedManifest.data.count
  )
    fail("أجزاء سجل الإقرار ناقصة أو غير صالحة");
  const manifest = parsedManifest.data;
  const parts = fragments
    .map((row) => {
      const part = fragmentSchema.safeParse(row.value);
      if (
        !part.success ||
        part.data.payloadHash !== payloadHash ||
        part.data.digest !== manifest.digest ||
        part.data.count !== manifest.count
      )
        fail("جزء من سجل الإقرار لا يطابق بصمته");
      return part.data;
    })
    .sort((a, b) => a.index - b.index);
  if (parts.some((part, index) => part.index !== index))
    fail("ترتيب أجزاء سجل الإقرار غير صالح");
  const encoded = parts.map((part) => part.data).join("");
  const bytes = Buffer.from(encoded, "base64");
  if (
    sha256(encoded) !== manifest.digest ||
    bytes.toString("base64") !== encoded
  )
    fail("بصمة سجل الإقرار المجمع غير متطابقة");
  let document: {
    version?: number;
    payloadHash?: string;
    result?: unknown;
    evidence?: unknown;
  };
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("وثيقة الإقرار المجمع غير صالحة");
  }
  if (
    !document ||
    document.version !== 1 ||
    document.payloadHash !== payloadHash ||
    !document.evidence ||
    typeof document.evidence !== "object" ||
    Array.isArray(document.evidence)
  )
    fail("وثيقة الإقرار المجمع لا تطابق الطلب");
  return checkedResult(document.result, referenceId);
}

async function recordResult(
  tx: Tx,
  actor: Actor,
  payloadHash: string,
  result: Result,
  evidence: Record<string, unknown>,
) {
  const encoded = Buffer.from(
    JSON.stringify({ version: 1, payloadHash, result, evidence }),
    "utf8",
  ).toString("base64");
  const count = Math.ceil(encoded.length / 800);
  if (count > MAX_FRAGMENTS) fail("حجم دليل الإقرار تجاوز حد الأجزاء الآمن");
  const manifest = {
    format: FORMAT,
    payloadHash,
    digest: sha256(encoded),
    count,
    encoding: "base64-json",
  };
  const source = {
    userId: actor.userId,
    actor: {
      source: "user" as const,
      label: "إقرار مالك بتسديد نقدي سابق غير مسجل",
    },
  };
  const target = {
    entityType: "supplierPaymentBatch",
    entityId: result.requestIds[0],
    screenPath: "/purchases",
  };
  // Base64 avoids UTF-8 byte inflation and data-URL redaction; every string is below the audit cap.
  for (let index = 0; index < count; index++)
    await logAuditTx(tx, source, {
      ...target,
      action: FRAGMENT_ACTION,
      newValue: {
        format: FORMAT,
        payloadHash,
        digest: manifest.digest,
        count,
        index,
        data: encoded.slice(index * 800, (index + 1) * 800),
      },
    });
  await logAuditTx(tx, source, {
    ...target,
    action: MANIFEST_ACTION,
    newValue: manifest,
  });
  await logAuditTx(tx, source, {
    ...target,
    action: ACTION,
    newValue: manifest,
  });
}
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
    evidenceCases: [...parsed.data.evidenceCases].sort(
      (a, b) => a.caseId - b.caseId,
    ),
  };
  if (
    new Set(input.payments.map((row) => row.supplierInvoiceId)).size !==
      input.payments.length ||
    new Set(input.payments.map((row) => row.purchaseOrderId)).size !==
      input.payments.length ||
    new Set(input.evidenceCases.map((row) => row.caseId)).size !==
      input.evidenceCases.length
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
      const saved = await savedResult(tx, previous, payloadHash);
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
    const priorPaymentEvidence: Array<{
      supplierInvoiceId: number;
      proof: Awaited<ReturnType<typeof assertAttestedPaymentEvidenceTx>>;
    }> = [];
    const verifiedTargets = new Map<
      number,
      { purchaseOrderId: number; supplierId: number; branchId: number }
    >();
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
      const proof = await assertAttestedPaymentEvidenceTx(
        tx,
        po.supplierId,
        po.branchId,
        posting.id,
        input.payments.map((target) => target.supplierInvoiceId),
      );
      priorPaymentEvidence.push({ supplierInvoiceId: invoice.id, proof });
      evidencePayments.push({
        ...row,
        purchaseOrderDate: baghdadToday(po.orderDate),
        invoiceRecognitionDate: invoice.invoiceDate,
      });
      verifiedTargets.set(invoice.id, {
        purchaseOrderId: po.id,
        supplierId: po.supplierId,
        branchId: po.branchId,
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
    const resolvedEvidenceCaseIds: number[] = [];
    for (const row of input.evidenceCases) {
      const target = verifiedTargets.get(row.supplierInvoiceId);
      if (!target || target.purchaseOrderId !== row.purchaseOrderId)
        fail("قضية دليل السداد لا تخص الفواتير المثبتة في الإقرار");
      const resolution = await resolvePurchaseIntegrityForOwnerInTx(
        tx,
        {
          caseId: row.caseId,
          requestKey: `ATTESTED-CASE:${idempotencyHash(input.attestationKey).slice(0, 32)}:${row.caseId}`,
          reason:
            `حسم المالك عدم تذكر دفع البضاعة بإقراره المباشر: ${input.evidenceText}`.slice(
              0,
              1000,
            ),
          evidenceReference: `OWNER-ATTESTATION:${payloadHash}:PO:${row.purchaseOrderId}:SI:${row.supplierInvoiceId}`,
          expectedPurchaseOrderId: row.purchaseOrderId,
          expectedSupplierInvoiceId: row.supplierInvoiceId,
          expectedSupplierId: target.supplierId,
          expectedBranchId: target.branchId,
        },
        actor,
      );
      if (resolution.status !== "RESOLVED")
        fail("لم يكتمل حسم قضية دليل السداد");
      resolvedEvidenceCaseIds.push(row.caseId);
    }
    const result: Result = {
      paymentIds: [],
      receiptIds: [],
      requestIds: [],
      replayed: false,
      resolvedEvidenceCaseIds,
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
    await recordResult(tx, actor, payloadHash, result, {
      attestationKey: input.attestationKey,
      evidenceText: input.evidenceText,
      recordingDate: input.recordingDate,
      payments: evidencePayments,
      priorPaymentEvidence,
      evidenceCases: input.evidenceCases,
      correctionRecordedAt: new Date().toISOString(),
    });
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
