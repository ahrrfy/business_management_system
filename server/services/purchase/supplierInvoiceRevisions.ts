import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
  supplierInvoiceApprovalRequests,
  supplierInvoiceLines,
  supplierInvoiceMatchRuns,
  supplierInvoices,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { assertPurchaseBranch } from "./internal";
import {
  buildSupplierInvoiceDraftDocument,
  buildSupplierInvoiceDraftRequestHash,
  type SupplierInvoiceDraftDocumentInput,
} from "./supplierInvoiceDraftPolicy";
import { lockSupplierInvoiceChainTx } from "./supplierInvoices";

export interface UpdateSupplierInvoiceDraftInput extends SupplierInvoiceDraftDocumentInput {
  supplierInvoiceId: number;
  expectedVersion: number;
  requestKey: string;
  reason: string;
}

export interface VoidSupplierInvoiceDraftInput {
  supplierInvoiceId: number;
  expectedVersion: number;
  requestKey: string;
  reason: string;
}

interface DraftRevisionRow {
  id: number | string;
  supplierInvoiceId: number | string;
  revisionNo: number | string;
  action: "UPDATE_DRAFT" | "VOID_DRAFT";
  requestKey: string;
  requestPayloadHash: string;
  baseVersion: number | string;
  resultVersion: number | string;
  beforeCanonical: string;
  beforeHash: string;
  afterCanonical: string;
  afterHash: string;
  reason: string;
  actedBy: number | string;
  actedAt: Date | string;
}

function firstRow<T>(result: any): T | undefined {
  return (Array.isArray(result) ? result[0]?.[0] : result?.rows?.[0]) as
    | T
    | undefined;
}

function resultRows<T>(result: any): T[] {
  return (Array.isArray(result) ? result[0] : (result?.rows ?? [])) as T[];
}

function required(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text)
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب` });
  if (text.length > max)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} يجب ألا يتجاوز ${max} محرفاً`,
    });
  return text;
}

function validateEnvelope(input: {
  supplierInvoiceId: number;
  expectedVersion: number;
  requestKey: string;
  reason: string;
}) {
  if (
    !Number.isSafeInteger(input.supplierInvoiceId) ||
    input.supplierInvoiceId <= 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "معرّف فاتورة المورد غير صالح",
    });
  }
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion <= 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "نسخة فاتورة المورد المتوقعة غير صالحة",
    });
  }
  return {
    requestKey: required(input.requestKey, "مفتاح الطلب", 120),
    reason: (() => {
      const reason = required(input.reason, "سبب التصحيح", 500);
      if (reason.length < 3) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "سبب التصحيح يجب ألا يقل عن 3 محارف",
        });
      }
      return reason;
    })(),
  };
}

async function findRevisionByRequestKeyTx(tx: Tx, requestKey: string) {
  const result: any = await tx.execute(
    sql`SELECT * FROM supplierInvoiceDraftRevisions WHERE requestKey = ${requestKey} LIMIT 1`,
  );
  return firstRow<DraftRevisionRow>(result);
}

function replayOrConflict(
  row: DraftRevisionRow,
  expectedHash: string,
  expectedInvoiceId: number,
) {
  if (
    row.requestPayloadHash !== expectedHash ||
    Number(row.supplierInvoiceId) !== expectedInvoiceId
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "مفتاح طلب تصحيح المسودة مستعمل بحمولة مختلفة",
    });
  }
  return {
    supplierInvoiceId: expectedInvoiceId,
    revisionId: Number(row.id),
    revisionNo: Number(row.revisionNo),
    action: row.action,
    version: Number(row.resultVersion),
    idempotentReplay: true as const,
  };
}

async function loadDraftStateTx(tx: Tx, supplierInvoiceId: number) {
  const result: any = await tx.execute(
    sql`SELECT draftState, voidedBy, voidedAt, voidReason FROM supplierInvoices WHERE id = ${supplierInvoiceId} LIMIT 1`,
  );
  const state = firstRow<{
    draftState: "ACTIVE" | "VOIDED";
    voidedBy: number | string | null;
    voidedAt: Date | string | null;
    voidReason: string | null;
  }>(result);
  if (!state)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "فاتورة المورد غير موجودة",
    });
  return state;
}

async function assertDraftMutableTx(
  tx: Tx,
  invoice: typeof supplierInvoices.$inferSelect,
) {
  const state = await loadDraftStateTx(tx, Number(invoice.id));
  if (state.draftState !== "ACTIVE") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "مسودة فاتورة المورد ملغاة ولا تقبل تعديلاً جديداً",
    });
  }
  if (invoice.status !== "DRAFT") {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "لا يمكن تعديل فاتورة المورد بعد بدء المطابقة أو الترحيل؛ استعمل مسار العكس المحكوم",
    });
  }
  const [match] = await tx
    .select({ id: supplierInvoiceMatchRuns.id })
    .from(supplierInvoiceMatchRuns)
    .where(eq(supplierInvoiceMatchRuns.supplierInvoiceId, Number(invoice.id)))
    .for("update")
    .limit(1);
  if (match) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "بدأت مطابقة الفاتورة؛ لا يمكن إعادة كتابة مسودتها",
    });
  }
  const [approval] = await tx
    .select({ id: supplierInvoiceApprovalRequests.id })
    .from(supplierInvoiceApprovalRequests)
    .where(
      and(
        eq(
          supplierInvoiceApprovalRequests.supplierInvoiceId,
          Number(invoice.id),
        ),
        eq(supplierInvoiceApprovalRequests.status, "PENDING"),
      ),
    )
    .for("update")
    .limit(1);
  if (approval) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "يوجد طلب اعتماد معلّق؛ احسمه قبل تصحيح المسودة",
    });
  }
  return state;
}

async function nextRevisionNoTx(
  tx: Tx,
  supplierInvoiceId: number,
): Promise<number> {
  const result: any = await tx.execute(
    sql`SELECT COALESCE(MAX(revisionNo), 0) + 1 AS nextNo FROM supplierInvoiceDraftRevisions WHERE supplierInvoiceId = ${supplierInvoiceId}`,
  );
  return Number(firstRow<{ nextNo: number | string }>(result)?.nextNo ?? 1);
}

async function insertRevisionTx(
  tx: Tx,
  input: {
    supplierInvoiceId: number;
    revisionNo: number;
    action: "UPDATE_DRAFT" | "VOID_DRAFT";
    requestKey: string;
    requestPayloadHash: string;
    baseVersion: number;
    resultVersion: number;
    beforeCanonical: string;
    beforeHash: string;
    afterCanonical: string;
    afterHash: string;
    reason: string;
    actedBy: number;
  },
) {
  await tx.execute(sql`
    INSERT INTO supplierInvoiceDraftRevisions
      (supplierInvoiceId, revisionNo, action, requestKey, requestPayloadHash,
       baseVersion, resultVersion, beforeCanonical, beforeHash, afterCanonical, afterHash, reason, actedBy)
    VALUES
      (${input.supplierInvoiceId}, ${input.revisionNo}, ${input.action}, ${input.requestKey}, ${input.requestPayloadHash},
       ${input.baseVersion}, ${input.resultVersion}, ${input.beforeCanonical}, ${input.beforeHash}, ${input.afterCanonical},
       ${input.afterHash}, ${input.reason}, ${input.actedBy})
  `);
  const row = await findRevisionByRequestKeyTx(tx, input.requestKey);
  if (!row)
    throw new Error(
      "supplier invoice draft revision insert was not materialized",
    );
  return Number(row.id);
}

export async function updateSupplierInvoiceDraft(
  input: UpdateSupplierInvoiceDraftInput,
  actor: Actor,
) {
  const { requestKey, reason } = validateEnvelope(input);
  const requestPayloadHash = buildSupplierInvoiceDraftRequestHash({
    action: "UPDATE_DRAFT",
    supplierInvoiceId: input.supplierInvoiceId,
    expectedVersion: input.expectedVersion,
    reason,
    document: {
      externalInvoiceNumber: input.externalInvoiceNumber,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate ?? null,
      agreedRate: input.agreedRate ?? null,
      taxAmount: input.taxAmount ?? null,
      discountAmount: input.discountAmount ?? null,
      evidenceType: input.evidenceType,
      evidenceReference: input.evidenceReference,
      lines: input.lines,
    },
  });

  return withTx(async (tx) => {
    const replay = await findRevisionByRequestKeyTx(tx, requestKey);
    if (replay)
      return replayOrConflict(
        replay,
        requestPayloadHash,
        input.supplierInvoiceId,
      );

    const revisionItemIds = input.lines.map(
      (line) => line.purchaseOrderRevisionItemId,
    );
    const { invoice } = await lockSupplierInvoiceChainTx(
      tx,
      input.supplierInvoiceId,
      {
        allowVoidedDraft: true,
        additionalRevisionItemIds: revisionItemIds,
      },
    );
    const concurrentReplay = await findRevisionByRequestKeyTx(tx, requestKey);
    if (concurrentReplay)
      return replayOrConflict(
        concurrentReplay,
        requestPayloadHash,
        input.supplierInvoiceId,
      );
    assertPurchaseBranch(invoice, actor);
    if (Number(invoice.version) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّرت فاتورة المورد؛ أعد تحميلها قبل حفظ التصحيح",
      });
    }
    await assertDraftMutableTx(tx, invoice);

    const document = buildSupplierInvoiceDraftDocument(
      {
        supplierId: Number(invoice.supplierId),
        branchId: Number(invoice.branchId),
        currency: invoice.currency,
      },
      input,
    );
    if (document.payloadHash === invoice.payloadHash) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "التصحيح لا يغيّر بيانات فاتورة المورد",
      });
    }
    const [duplicateExternal] = await tx
      .select({ id: supplierInvoices.id })
      .from(supplierInvoices)
      .where(
        and(
          eq(supplierInvoices.supplierId, Number(invoice.supplierId)),
          eq(supplierInvoices.externalNumberNorm, document.externalNumberNorm),
          ne(supplierInvoices.id, input.supplierInvoiceId),
        ),
      )
      .limit(1);
    if (duplicateExternal) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "رقم فاتورة المورد مسجّل مسبقاً لهذا المورد",
      });
    }

    const snapshots = await tx
      .select({
        item: purchaseOrderRevisionItems,
        revision: purchaseOrderRevisions,
        order: purchaseOrders,
      })
      .from(purchaseOrderRevisionItems)
      .innerJoin(
        purchaseOrderRevisions,
        eq(purchaseOrderRevisions.id, purchaseOrderRevisionItems.revisionId),
      )
      .innerJoin(
        purchaseOrders,
        eq(purchaseOrders.id, purchaseOrderRevisions.purchaseOrderId),
      )
      .where(inArray(purchaseOrderRevisionItems.id, document.revisionItemIds))
      .orderBy(asc(purchaseOrders.id), asc(purchaseOrderRevisionItems.id))
      .for("update");
    if (snapshots.length !== document.revisionItemIds.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "أحد بنود نسخة أمر الشراء غير موجود",
      });
    }
    const snapshotById = new Map(
      snapshots.map((row) => [Number(row.item.id), row] as const),
    );
    for (const line of document.lines) {
      const snapshot = snapshotById.get(line.purchaseOrderRevisionItemId)!;
      if (
        Number(snapshot.order.approvedRevisionId) !==
          Number(snapshot.revision.id) ||
        Number(snapshot.order.supplierId) !== Number(invoice.supplierId) ||
        Number(snapshot.order.branchId) !== Number(invoice.branchId) ||
        snapshot.order.agreedCurrency !== invoice.currency ||
        ["DRAFT", "SENT", "CANCELLED"].includes(snapshot.order.status)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "كل بنود التصحيح يجب أن تنتمي لنسخ أوامر شراء معتمدة للمورد والفرع والعملة نفسها",
        });
      }
    }

    const revisionNo = await nextRevisionNoTx(tx, input.supplierInvoiceId);
    await tx
      .update(supplierInvoices)
      .set({
        externalInvoiceNumber: document.externalInvoiceNumber,
        externalNumberNorm: document.externalNumberNorm,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        agreedRate:
          invoice.currency === "USD" ? document.rate.toFixed(4) : null,
        subtotal: toDbMoney(document.subtotal),
        taxAmount: toDbMoney(document.tax),
        discountAmount: toDbMoney(document.discount),
        totalAmount: toDbMoney(document.total),
        usdTotal:
          document.usdTotal == null ? null : toDbMoney(document.usdTotal),
        payloadCanonical: document.canonical,
        payloadHash: document.payloadHash,
        evidenceType: input.evidenceType,
        evidenceReference: document.evidenceReference,
        holdReason: null,
      })
      .where(eq(supplierInvoices.id, input.supplierInvoiceId));
    await tx
      .delete(supplierInvoiceLines)
      .where(
        eq(supplierInvoiceLines.supplierInvoiceId, input.supplierInvoiceId),
      );
    await tx.insert(supplierInvoiceLines).values(
      document.lines.map((line) => {
        const snapshot = snapshotById.get(line.purchaseOrderRevisionItemId)!;
        return {
          supplierInvoiceId: input.supplierInvoiceId,
          lineNo: line.lineNo,
          purchaseOrderRevisionItemId: line.purchaseOrderRevisionItemId,
          variantId: Number(snapshot.item.variantId),
          description: line.description,
          invoicedBaseQuantity: line.invoicedBaseQuantity,
          unitPriceIqd: toDbMoney(line.unitPriceIqd),
          netAmount: toDbMoney(line.netAmount),
          taxAmount: toDbMoney(line.taxAmount),
          totalAmount: toDbMoney(line.totalAmount),
          usdUnitPrice: line.usdUnitPrice?.toFixed(4) ?? null,
          usdTotal: line.usdTotal == null ? null : toDbMoney(line.usdTotal),
        };
      }),
    );
    const [updated] = await tx
      .select({ version: supplierInvoices.version })
      .from(supplierInvoices)
      .where(eq(supplierInvoices.id, input.supplierInvoiceId))
      .limit(1);
    const resultVersion = Number(updated?.version);
    if (resultVersion !== input.expectedVersion + 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تعذّر تثبيت نسخة تصحيح فاتورة المورد",
      });
    }
    const revisionId = await insertRevisionTx(tx, {
      supplierInvoiceId: input.supplierInvoiceId,
      revisionNo,
      action: "UPDATE_DRAFT",
      requestKey,
      requestPayloadHash,
      baseVersion: input.expectedVersion,
      resultVersion,
      beforeCanonical: invoice.payloadCanonical,
      beforeHash: invoice.payloadHash,
      afterCanonical: document.canonical,
      afterHash: document.payloadHash,
      reason,
      actedBy: actor.userId,
    });
    return {
      supplierInvoiceId: input.supplierInvoiceId,
      revisionId,
      revisionNo,
      action: "UPDATE_DRAFT" as const,
      version: resultVersion,
      totalAmount: toDbMoney(document.total),
      idempotentReplay: false as const,
    };
  });
}

export async function voidSupplierInvoiceDraft(
  input: VoidSupplierInvoiceDraftInput,
  actor: Actor,
) {
  const { requestKey, reason } = validateEnvelope(input);
  const requestPayloadHash = buildSupplierInvoiceDraftRequestHash({
    action: "VOID_DRAFT",
    supplierInvoiceId: input.supplierInvoiceId,
    expectedVersion: input.expectedVersion,
    reason,
  });
  return withTx(async (tx) => {
    const replay = await findRevisionByRequestKeyTx(tx, requestKey);
    if (replay)
      return replayOrConflict(
        replay,
        requestPayloadHash,
        input.supplierInvoiceId,
      );
    const { invoice } = await lockSupplierInvoiceChainTx(
      tx,
      input.supplierInvoiceId,
      { allowVoidedDraft: true },
    );
    const concurrentReplay = await findRevisionByRequestKeyTx(tx, requestKey);
    if (concurrentReplay)
      return replayOrConflict(
        concurrentReplay,
        requestPayloadHash,
        input.supplierInvoiceId,
      );
    assertPurchaseBranch(invoice, actor);
    if (Number(invoice.version) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّرت فاتورة المورد؛ أعد تحميلها قبل إلغاء المسودة",
      });
    }
    await assertDraftMutableTx(tx, invoice);
    const revisionNo = await nextRevisionNoTx(tx, input.supplierInvoiceId);
    await tx.execute(sql`
      UPDATE supplierInvoices
      SET draftState = 'VOIDED', voidedBy = ${actor.userId}, voidedAt = CURRENT_TIMESTAMP, voidReason = ${reason}
      WHERE id = ${input.supplierInvoiceId}
    `);
    const versionResult: any = await tx.execute(
      sql`SELECT version FROM supplierInvoices WHERE id = ${input.supplierInvoiceId} LIMIT 1`,
    );
    const resultVersion = Number(
      firstRow<{ version: number | string }>(versionResult)?.version,
    );
    if (resultVersion !== input.expectedVersion + 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تعذّر تثبيت نسخة إلغاء مسودة فاتورة المورد",
      });
    }
    const revisionId = await insertRevisionTx(tx, {
      supplierInvoiceId: input.supplierInvoiceId,
      revisionNo,
      action: "VOID_DRAFT",
      requestKey,
      requestPayloadHash,
      baseVersion: input.expectedVersion,
      resultVersion,
      beforeCanonical: invoice.payloadCanonical,
      beforeHash: invoice.payloadHash,
      afterCanonical: invoice.payloadCanonical,
      afterHash: invoice.payloadHash,
      reason,
      actedBy: actor.userId,
    });
    return {
      supplierInvoiceId: input.supplierInvoiceId,
      revisionId,
      revisionNo,
      action: "VOID_DRAFT" as const,
      version: resultVersion,
      idempotentReplay: false as const,
    };
  });
}

export async function getSupplierInvoiceDraftGovernance(
  supplierInvoiceId: number,
  actor: Actor,
) {
  return withTx(
    async (tx) => {
      const [invoice] = await tx
        .select()
        .from(supplierInvoices)
        .where(eq(supplierInvoices.id, supplierInvoiceId))
        .limit(1);
      if (!invoice)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "فاتورة المورد غير موجودة",
        });
      assertPurchaseBranch(invoice, actor);
      const state = await loadDraftStateTx(tx, supplierInvoiceId);
      const revisionsResult: any = await tx.execute(sql`
      SELECT id, supplierInvoiceId, revisionNo, action, requestKey, baseVersion, resultVersion,
             beforeHash, afterHash, reason, actedBy, actedAt
      FROM supplierInvoiceDraftRevisions
      WHERE supplierInvoiceId = ${supplierInvoiceId}
      ORDER BY revisionNo DESC
    `);
      return {
        state: state.draftState,
        voidedBy: state.voidedBy == null ? null : Number(state.voidedBy),
        voidedAt: state.voidedAt,
        voidReason: state.voidReason,
        revisions: resultRows<
          Omit<
            DraftRevisionRow,
            "requestPayloadHash" | "beforeCanonical" | "afterCanonical"
          >
        >(revisionsResult).map((row) => ({
          ...row,
          id: Number(row.id),
          supplierInvoiceId: Number(row.supplierInvoiceId),
          revisionNo: Number(row.revisionNo),
          baseVersion: Number(row.baseVersion),
          resultVersion: Number(row.resultVersion),
          actedBy: Number(row.actedBy),
        })),
      };
    },
    { gate: "NONE" },
  );
}
