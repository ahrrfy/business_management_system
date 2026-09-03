import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  purchaseReturnReversals,
  purchaseReturns,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
  supplierPaymentAllocations,
  supplierInvoiceApprovalRequests,
  supplierInvoiceLines,
  supplierInvoiceMatchAllocations,
  supplierInvoiceMatchRuns,
  supplierInvoices,
  suppliers,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  adjustSupplierBalance,
  adjustSupplierBalanceUsd,
} from "../ledgerService";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { withTx, type Actor } from "../tx";
import {
  postSupplierInvoiceGrniTx,
  sha256,
  stableCanonical,
} from "./grniAccounting";
import { assertPurchaseBranch } from "./internal";
import {
  buildSupplierInvoiceDraftDocument,
  type SupplierInvoiceDraftDocumentInput,
  type SupplierInvoiceDraftEvidenceType,
  type SupplierInvoiceDraftIdentity,
} from "./supplierInvoiceDraftPolicy";
import { supplierInvoiceApprovalTrigger } from "@shared/approvalTriggers";
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { payloadHashMatches } from "../idempotency";

export type SupplierInvoiceEvidenceType = SupplierInvoiceDraftEvidenceType;

export interface CreateSupplierInvoiceInput
  extends SupplierInvoiceDraftDocumentInput, SupplierInvoiceDraftIdentity {
  clientRequestId: string;
}

export interface RequestSupplierInvoiceApprovalInput {
  supplierInvoiceId: number;
  expectedInvoiceVersion: number;
  requestKey: string;
  kind: "POST_INVOICE" | "REVERSE_INVOICE";
  matchRunId?: number | null;
  reason: string;
  evidenceType?:
    | "DOCUMENT_IMAGE"
    | "PDF"
    | "EMAIL"
    | "SIGNED_APPROVAL"
    | "OTHER"
    | null;
  evidenceReference?: string | null;
}

export interface DecideSupplierInvoiceApprovalInput {
  requestId: number;
  decisionKey: string;
  action: "APPROVE" | "REJECT";
  reviewReason: string;
}

function required(
  value: string | null | undefined,
  label: string,
  max: number,
): string {
  const text = value?.trim() ?? "";
  if (!text)
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب` });
  if (text.length > max)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} يجب ألا يتجاوز ${max} محرفاً`,
    });
  return text;
}

export function assertSupplierInvoiceReversalDependenciesClear(input: {
  paymentAllocations: Array<{
    allocatedAmount: string | number | Decimal;
    refundedAmount: string | number | Decimal;
  }>;
  purchaseReturns: Array<{
    id: number;
    totalAmount: string | number | Decimal;
    reversalAmounts: Array<string | number | Decimal>;
  }>;
}): void {
  const asAmount = (value: string | number | Decimal) =>
    value instanceof Decimal ? value : money(value);
  const unsettledPayment = input.paymentAllocations.some((allocation) =>
    round2(
      asAmount(allocation.allocatedAmount).minus(
        asAmount(allocation.refundedAmount),
      ),
    ).gt(0),
  );
  if (unsettledPayment) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "لا يمكن عكس الفاتورة وفيها تخصيص سداد صافٍ؛ استرد تخصيصاتها بالكامل أولاً",
    });
  }
  const activeReturn = input.purchaseReturns.some((purchaseReturn) => {
    const reversed = purchaseReturn.reversalAmounts.reduce<Decimal>(
      (sum, amount) => sum.plus(asAmount(amount)),
      money(0),
    );
    return round2(asAmount(purchaseReturn.totalAmount).minus(reversed)).gt(0);
  });
  if (activeReturn) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "لا يمكن عكس الفاتورة وفيها مرتجع شراء غير معكوس بالكامل؛ اعكس المرتجع أولاً",
    });
  }
}

/** Company lock order for every existing supplier-invoice mutation: PO(s) → supplier → invoice. */
export async function lockSupplierInvoiceChainTx(
  tx: Tx,
  supplierInvoiceId: number,
  options?: {
    allowVoidedDraft?: boolean;
    additionalRevisionItemIds?: number[];
  },
) {
  const preview = (
    await tx
      .select({ supplierId: supplierInvoices.supplierId })
      .from(supplierInvoices)
      .where(eq(supplierInvoices.id, supplierInvoiceId))
      .limit(1)
  )[0];
  if (!preview)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "فاتورة المورد غير موجودة",
    });
  const poRows = await tx
    .select({ purchaseOrderId: purchaseOrderRevisions.purchaseOrderId })
    .from(supplierInvoiceLines)
    .innerJoin(
      purchaseOrderRevisionItems,
      eq(
        purchaseOrderRevisionItems.id,
        supplierInvoiceLines.purchaseOrderRevisionItemId,
      ),
    )
    .innerJoin(
      purchaseOrderRevisions,
      eq(purchaseOrderRevisions.id, purchaseOrderRevisionItems.revisionId),
    )
    .where(eq(supplierInvoiceLines.supplierInvoiceId, supplierInvoiceId));
  const additionalPoRows = options?.additionalRevisionItemIds?.length
    ? await tx
        .select({ purchaseOrderId: purchaseOrderRevisions.purchaseOrderId })
        .from(purchaseOrderRevisionItems)
        .innerJoin(
          purchaseOrderRevisions,
          eq(purchaseOrderRevisions.id, purchaseOrderRevisionItems.revisionId),
        )
        .where(
          inArray(
            purchaseOrderRevisionItems.id,
            options.additionalRevisionItemIds,
          ),
        )
    : [];
  const poIds = Array.from(
    new Set([
      ...poRows.map((row) => Number(row.purchaseOrderId)),
      ...additionalPoRows.map((row) => Number(row.purchaseOrderId)),
    ]),
  ).sort((a, b) => a - b);
  for (const purchaseOrderId of poIds) {
    await tx
      .select({ id: purchaseOrders.id })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, purchaseOrderId))
      .for("update")
      .limit(1);
  }
  await tx
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(eq(suppliers.id, Number(preview.supplierId)))
    .for("update")
    .limit(1);
  const invoice = (
    await tx
      .select()
      .from(supplierInvoices)
      .where(eq(supplierInvoices.id, supplierInvoiceId))
      .for("update")
      .limit(1)
  )[0];
  if (!invoice)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "فاتورة المورد غير موجودة",
    });
  if (!options?.allowVoidedDraft) {
    const raw: any = await tx.execute(
      sql`SELECT draftState FROM supplierInvoices WHERE id = ${supplierInvoiceId} LIMIT 1`,
    );
    const state = Array.isArray(raw) ? raw[0]?.[0] : raw?.rows?.[0];
    if (state?.draftState === "VOIDED") {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "مسودة فاتورة المورد ملغاة وموثقة؛ أنشئ فاتورة جديدة بدلاً من إعادة استخدامها",
      });
    }
  }
  return { invoice, purchaseOrderIds: poIds };
}

async function nextInvoiceNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replaceAll("-", "");
  const prefix = `SIN-${branchId}-${ymd}-`;
  const lockName = `numbering:supplier_invoice:${branchId}:${ymd}`;
  const lockResult: any = await tx.execute(
    sql`SELECT GET_LOCK(${lockName}, 5) AS locked`,
  );
  const locked = Array.isArray(lockResult)
    ? lockResult[0]?.[0]
    : lockResult?.rows?.[0];
  if (Number(locked?.locked) !== 1)
    throw new Error(`numbering lock timeout for ${lockName}`);
  try {
    const rows = await tx
      .select({ value: supplierInvoices.invoiceNumber })
      .from(supplierInvoices)
      .where(sql`${supplierInvoices.invoiceNumber} LIKE ${`${prefix}%`}`)
      .orderBy(desc(supplierInvoices.id))
      .for("update");
    let max = 0;
    for (const row of rows) {
      const suffix = row.value.slice(prefix.length);
      if (/^[0-9]+$/.test(suffix)) max = Math.max(max, Number(suffix));
    }
    return `${prefix}${String(max + 1).padStart(5, "0")}`;
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

interface ApprovedRevisionExactAmount {
  purchaseOrderRevisionItemId: number;
  grossAmountIqd: string;
  netAmountIqd: string;
  grossDocumentAmount: string;
  netDocumentAmount: string;
  usdTotal?: string | null;
}

function applyApprovedRevisionExactAmounts(
  document: ReturnType<typeof buildSupplierInvoiceDraftDocument>,
  amounts: ApprovedRevisionExactAmount[],
) {
  const amountByRevisionItem = new Map(
    amounts.map((amount) => [amount.purchaseOrderRevisionItemId, amount]),
  );
  if (
    amountByRevisionItem.size !== amounts.length ||
    amounts.length !== document.lines.length
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "مبالغ النسخة المعتمدة لا تغطي بنود فاتورة المورد كاملة",
    });
  }
  const lines = document.lines.map((line) => {
    const exact = amountByRevisionItem.get(line.purchaseOrderRevisionItemId);
    if (!exact) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "مبلغ بند النسخة المعتمدة مفقود",
      });
    }
    const grossNetAmount = money(exact.grossAmountIqd);
    const netAmount = money(exact.netAmountIqd);
    const discountAmount = round2(grossNetAmount.minus(netAmount));
    const usdTotal = exact.usdTotal == null ? null : money(exact.usdTotal);
    if (
      grossNetAmount.isNegative() ||
      netAmount.isNegative() ||
      discountAmount.isNegative() ||
      usdTotal?.isNegative()
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "مبلغ بند النسخة المعتمدة لا يقبل السالب",
      });
    }
    return {
      ...line,
      unitPriceIqd: netAmount.dividedBy(line.invoicedBaseQuantity),
      grossNetAmount,
      discountAmount,
      netAmount,
      taxAmount: money(0),
      totalAmount: netAmount,
      usdUnitPrice:
        usdTotal == null ? null : usdTotal.dividedBy(line.invoicedBaseQuantity),
      usdTotal,
    };
  });
  const subtotal = round2(
    lines.reduce((sum, line) => sum.plus(line.grossNetAmount), money(0)),
  );
  const discount = round2(
    lines.reduce((sum, line) => sum.plus(line.discountAmount), money(0)),
  );
  const total = round2(subtotal.minus(discount));
  const documentDiscount = round2(
    amounts.reduce(
      (sum, amount) =>
        sum.plus(
          money(amount.grossDocumentAmount).minus(
            money(amount.netDocumentAmount),
          ),
        ),
      money(0),
    ),
  );
  if (documentDiscount.isNegative()) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "خصم النسخة المعتمدة بعملة المستند لا يقبل السالب",
    });
  }
  const usdTotal = lines.some((line) => line.usdTotal != null)
    ? round2(
        lines.reduce(
          (sum, line) => sum.plus(line.usdTotal ?? money(0)),
          money(0),
        ),
      )
    : null;
  const canonicalBase = JSON.parse(document.canonical) as Record<
    string,
    unknown
  >;
  const canonical = stableCanonical({
    ...canonicalBase,
    subtotal: toDbMoney(subtotal),
    taxAmount: "0.00",
    discountAmount: toDbMoney(discount),
    documentTaxAmount: "0.00",
    documentDiscountAmount: toDbMoney(documentDiscount),
    totalAmount: toDbMoney(total),
    usdTotal: usdTotal == null ? null : toDbMoney(usdTotal),
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      purchaseOrderRevisionItemId: line.purchaseOrderRevisionItemId,
      description: line.description,
      invoicedBaseQuantity: line.invoicedBaseQuantity,
      unitPriceIqd: toDbMoney(line.unitPriceIqd),
      grossNetAmount: toDbMoney(line.grossNetAmount),
      discountAmount: toDbMoney(line.discountAmount),
      netAmount: toDbMoney(line.netAmount),
      taxAmount: "0.00",
      totalAmount: toDbMoney(line.totalAmount),
      usdUnitPrice: line.usdUnitPrice?.toFixed(4) ?? null,
      usdTotal: line.usdTotal == null ? null : toDbMoney(line.usdTotal),
    })),
  });
  return {
    ...document,
    tax: money(0),
    discount,
    subtotal,
    total,
    usdTotal,
    lines,
    canonical,
    payloadHash: sha256(canonical),
  };
}

export async function createSupplierInvoiceInTx(
  tx: Tx,
  input: CreateSupplierInvoiceInput,
  actor: Actor,
  options: {
    /**
     * Internal-only automatic-posting path. Purchase-order revision rows
     * already contain the allocated supplier discount and final rounding, so
     * their immutable line totals must be copied exactly rather than applying
     * the header discount a second time or re-deriving cents from unit prices.
     */
    approvedRevisionExactAmounts?: ApprovedRevisionExactAmount[];
  } = {},
) {
  const clientRequestId = required(input.clientRequestId, "مفتاح الطلب", 120);
  const builtDocument = buildSupplierInvoiceDraftDocument(
    {
      supplierId: input.supplierId,
      branchId: input.branchId,
      currency: input.currency,
    },
    input,
  );
  const document = options.approvedRevisionExactAmounts
    ? applyApprovedRevisionExactAmounts(
        builtDocument,
        options.approvedRevisionExactAmounts,
      )
    : builtDocument;
  const {
    externalInvoiceNumber,
    externalNumberNorm,
    evidenceReference,
    rate,
    tax,
    discount,
    subtotal,
    total,
    usdTotal,
    lines: normalizedLines,
    canonical,
    payloadHash,
    revisionItemIds: revisionIds,
  } = document;
  const executeInExistingTransaction = async () => {
    const existing = (
      await tx
        .select()
        .from(supplierInvoices)
        .where(eq(supplierInvoices.clientRequestId, clientRequestId))
        .limit(1)
    )[0];
    if (existing) {
      if (!payloadHashMatches(payloadHash, existing.payloadHash))
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح الطلب مستعمل لفاتورة مورد مختلفة",
        });
      assertPurchaseBranch(existing, actor);
      return { ...existing, idempotentReplay: true as const };
    }
    if (actor.role !== "admin" && actor.branchId !== input.branchId)
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يمكنك إنشاء فاتورة في فرع آخر",
      });
    await assertPeriodOpen(tx, new Date(`${input.invoiceDate}T00:00:00.000Z`));
    const snapshotPreview = await tx
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
      .where(inArray(purchaseOrderRevisionItems.id, revisionIds))
      .orderBy(asc(purchaseOrders.id), asc(purchaseOrderRevisionItems.id));
    if (snapshotPreview.length !== revisionIds.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "أحد بنود نسخة أمر الشراء غير موجود",
      });
    const poIds = Array.from(
      new Set(snapshotPreview.map((row) => Number(row.order.id))),
    ).sort((a, b) => a - b);
    for (const purchaseOrderId of poIds) {
      await tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, purchaseOrderId))
        .for("update")
        .limit(1);
    }
    const supplier = (
      await tx
        .select()
        .from(suppliers)
        .where(eq(suppliers.id, input.supplierId))
        .for("update")
        .limit(1)
    )[0];
    if (!supplier || !supplier.isActive)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "المورد غير موجود أو غير نشط",
      });
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
      .where(inArray(purchaseOrderRevisionItems.id, revisionIds))
      .orderBy(asc(purchaseOrders.id), asc(purchaseOrderRevisionItems.id))
      .for("update");
    if (snapshots.length !== revisionIds.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "أحد بنود نسخة أمر الشراء غير موجود",
      });
    const snapshotById = new Map(
      snapshots.map((row) => [Number(row.item.id), row] as const),
    );
    for (const line of normalizedLines) {
      const snapshot = snapshotById.get(line.purchaseOrderRevisionItemId)!;
      const exactAmount = options.approvedRevisionExactAmounts?.find(
        (amount) =>
          amount.purchaseOrderRevisionItemId ===
          line.purchaseOrderRevisionItemId,
      );
      if (exactAmount) {
        const grossDocumentUnitPrice =
          snapshot.order.agreedCurrency === "USD"
            ? (snapshot.item.usdListUnitPrice ?? snapshot.item.usdUnitPrice)
            : snapshot.item.listUnitPrice;
        if (grossDocumentUnitPrice == null) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "سعر قائمة النسخة المعتمدة مفقود",
          });
        }
        const expectedGrossDocument = round2(
          money(grossDocumentUnitPrice).times(snapshot.item.quantity),
        );
        const expectedNetDocument =
          snapshot.order.agreedCurrency === "USD"
            ? money(snapshot.item.usdLineTotal ?? "0")
            : money(snapshot.item.lineTotal);
        const expectedGrossIqd =
          snapshot.order.agreedCurrency === "USD"
            ? round2(
                expectedGrossDocument.times(
                  snapshot.revision.agreedRate ?? "0",
                ),
              )
            : expectedGrossDocument;
        if (
          money(exactAmount.grossAmountIqd).lt(
            money(exactAmount.netAmountIqd),
          ) ||
          toDbMoney(exactAmount.grossAmountIqd) !==
            toDbMoney(expectedGrossIqd) ||
          toDbMoney(exactAmount.netAmountIqd) !==
            toDbMoney(snapshot.item.lineTotal) ||
          toDbMoney(exactAmount.grossDocumentAmount) !==
            toDbMoney(expectedGrossDocument) ||
          toDbMoney(exactAmount.netDocumentAmount) !==
            toDbMoney(expectedNetDocument) ||
          (snapshot.order.agreedCurrency === "USD" &&
            toDbMoney(exactAmount.usdTotal ?? "0") !==
              toDbMoney(snapshot.item.usdLineTotal ?? "0"))
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "مبلغ فاتورة المورد التلقائية لا يطابق النسخة المعتمدة",
          });
        }
      }
      if (
        Number(snapshot.order.approvedRevisionId) !==
        Number(snapshot.revision.id)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "فاتورة المورد لا تُربط إلا بنسخ أوامر شراء معتمدة",
        });
      }
      if (
        Number(snapshot.order.supplierId) !== input.supplierId ||
        Number(snapshot.order.branchId) !== input.branchId ||
        snapshot.order.agreedCurrency !== input.currency
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "كل أوامر الفاتورة يجب أن تتطابق في المورد والفرع والعملة",
        });
      }
      if (
        snapshot.order.status === "CANCELLED" ||
        snapshot.order.status === "DRAFT" ||
        snapshot.order.status === "SENT"
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "حالة أحد أوامر الشراء لا تسمح بفوترة المورد",
        });
      }
    }
    const invoiceNumber = await nextInvoiceNumber(tx, input.branchId);
    const inserted = await tx.insert(supplierInvoices).values({
      invoiceNumber,
      clientRequestId,
      origin: "NATIVE",
      supplierId: input.supplierId,
      externalInvoiceNumber,
      externalNumberNorm,
      branchId: input.branchId,
      status: "DRAFT",
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate ?? null,
      currency: input.currency,
      agreedRate: input.currency === "USD" ? rate.toFixed(4) : null,
      subtotal: toDbMoney(subtotal),
      taxAmount: toDbMoney(tax),
      discountAmount: toDbMoney(discount),
      totalAmount: toDbMoney(total),
      usdTotal: usdTotal == null ? null : toDbMoney(usdTotal),
      payloadCanonical: canonical,
      payloadHash,
      evidenceType: input.evidenceType,
      evidenceReference,
      createdBy: actor.userId,
    });
    const supplierInvoiceId = extractInsertId(inserted);
    await tx.insert(supplierInvoiceLines).values(
      normalizedLines.map((line) => {
        const snapshot = snapshotById.get(line.purchaseOrderRevisionItemId)!;
        return {
          supplierInvoiceId,
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
    return {
      supplierInvoiceId,
      invoiceNumber,
      totalAmount: toDbMoney(total),
      idempotentReplay: false as const,
    };
  };
  return executeInExistingTransaction();
}

export async function createSupplierInvoice(
  input: CreateSupplierInvoiceInput,
  actor: Actor,
) {
  return withTx((tx) => createSupplierInvoiceInTx(tx, input, actor));
}

export async function requestSupplierInvoiceApproval(
  input: RequestSupplierInvoiceApprovalInput,
  actor: Actor,
) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120);
  const reason = required(input.reason, "سبب الطلب", 500);
  if (
    !Number.isSafeInteger(input.expectedInvoiceVersion) ||
    input.expectedInvoiceVersion <= 0
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "نسخة الفاتورة المتوقعة غير صالحة",
    });
  const canonical = stableCanonical({
    supplierInvoiceId: input.supplierInvoiceId,
    expectedInvoiceVersion: input.expectedInvoiceVersion,
    kind: input.kind,
    matchRunId: input.matchRunId ?? null,
    reason,
    evidenceType: input.evidenceType ?? null,
    evidenceReference: input.evidenceReference?.trim() || null,
  });
  const payloadHash = sha256(canonical);
  return withTx(async (tx) => {
    const existing = (
      await tx
        .select()
        .from(supplierInvoiceApprovalRequests)
        .where(eq(supplierInvoiceApprovalRequests.requestKey, requestKey))
        .limit(1)
    )[0];
    if (existing) {
      if (!payloadHashMatches(payloadHash, existing.payloadHash))
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح طلب الاعتماد مستعمل بحمولة مختلفة",
        });
      assertPurchaseBranch(existing, actor);
      return { ...existing, idempotentReplay: true as const };
    }
    const { invoice } = await lockSupplierInvoiceChainTx(
      tx,
      input.supplierInvoiceId,
    );
    assertPurchaseBranch(invoice, actor);
    if (Number(invoice.version) !== input.expectedInvoiceVersion)
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّرت فاتورة المورد؛ أعد تحميلها",
      });
    let matchRunId: number | null = null;
    if (input.kind === "POST_INVOICE") {
      if (invoice.status !== "MATCHED")
        throw new TRPCError({
          code: "CONFLICT",
          message: "لا يمكن طلب الترحيل قبل مطابقة ناجحة",
        });
      if (input.matchRunId == null)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "تشغيل المطابقة مطلوب",
        });
      const match = (
        await tx
          .select()
          .from(supplierInvoiceMatchRuns)
          .where(
            and(
              eq(supplierInvoiceMatchRuns.id, input.matchRunId),
              eq(
                supplierInvoiceMatchRuns.supplierInvoiceId,
                input.supplierInvoiceId,
              ),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
      if (
        !match ||
        match.outcome === "HOLD" ||
        match.invoiceHash !== invoice.payloadHash
      )
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "تشغيل المطابقة غير صالح أو محجوز أو لا يطابق الفاتورة الحالية",
        });
      const latest = (
        await tx
          .select({ id: supplierInvoiceMatchRuns.id })
          .from(supplierInvoiceMatchRuns)
          .where(
            eq(
              supplierInvoiceMatchRuns.supplierInvoiceId,
              input.supplierInvoiceId,
            ),
          )
          .orderBy(desc(supplierInvoiceMatchRuns.runNo))
          .limit(1)
      )[0];
      if (!latest || Number(latest.id) !== input.matchRunId)
        throw new TRPCError({
          code: "CONFLICT",
          message: "يجب اعتماد أحدث تشغيل مطابقة",
        });
      matchRunId = input.matchRunId;
    } else {
      if (invoice.status !== "POSTED")
        throw new TRPCError({
          code: "CONFLICT",
          message: "العكس متاح لفاتورة مرحّلة فقط",
        });
      if (!input.evidenceReference?.trim())
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "دليل العكس مطلوب",
        });
    }
    const inserted = await tx.insert(supplierInvoiceApprovalRequests).values({
      requestKey,
      supplierInvoiceId: input.supplierInvoiceId,
      matchRunId,
      branchId: Number(invoice.branchId),
      kind: input.kind,
      baseInvoiceVersion: input.expectedInvoiceVersion,
      payloadCanonical: canonical,
      payloadHash,
      reason,
      evidenceType: input.evidenceType ?? null,
      evidenceReference: input.evidenceReference?.trim() || null,
      status: "PENDING",
      pendingGuard: `${input.kind}:${input.supplierInvoiceId}`,
      requestedBy: actor.userId,
    });
    return {
      requestId: extractInsertId(inserted),
      status: "PENDING" as const,
      idempotentReplay: false as const,
    };
  });
}

export async function decideSupplierInvoiceApproval(
  input: DecideSupplierInvoiceApprovalInput,
  actor: Actor,
) {
  const decisionKey = required(input.decisionKey, "مفتاح القرار", 120);
  const reviewReason = required(input.reviewReason, "سبب القرار", 500);
  const decisionHash = sha256(
    stableCanonical({
      requestId: input.requestId,
      action: input.action,
      reviewReason,
    }),
  );
  return withTx(async (tx) => {
    const preview = (
      await tx
        .select()
        .from(supplierInvoiceApprovalRequests)
        .where(eq(supplierInvoiceApprovalRequests.id, input.requestId))
        .limit(1)
    )[0];
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "طلب اعتماد فاتورة المورد غير موجود",
      });
    const { invoice } = await lockSupplierInvoiceChainTx(
      tx,
      Number(preview.supplierInvoiceId),
    );
    assertPurchaseBranch(invoice, actor);
    const request = (
      await tx
        .select()
        .from(supplierInvoiceApprovalRequests)
        .where(eq(supplierInvoiceApprovalRequests.id, input.requestId))
        .for("update")
        .limit(1)
    )[0]!;
    if (request.decisionKey != null) {
      if (
        request.decisionKey !== decisionKey ||
        request.decisionHash !== decisionHash
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "الطلب حُسم بقرار مختلف",
        });
      return {
        requestId: input.requestId,
        status: request.status,
        idempotentReplay: true as const,
      };
    }
    if (request.status !== "PENDING")
      throw new TRPCError({
        code: "CONFLICT",
        message: "طلب الاعتماد غير معلّق",
      });
    const decidedAt = new Date();
    if (input.action === "REJECT") {
      if (Number(request.requestedBy) === actor.userId)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "فصل المهام: منشئ الطلب لا يرفضه أو يعتمده",
        });
      await tx
        .update(supplierInvoiceApprovalRequests)
        .set({
          status: "REJECTED",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: decidedAt,
          reviewReason,
          decisionKey,
          decisionHash,
        })
        .where(eq(supplierInvoiceApprovalRequests.id, input.requestId));
      return {
        requestId: input.requestId,
        status: "REJECTED" as const,
        idempotentReplay: false as const,
      };
    }
    if (Number(invoice.version) !== Number(request.baseInvoiceVersion)) {
      await tx
        .update(supplierInvoiceApprovalRequests)
        .set({
          status: "STALE",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: decidedAt,
          reviewReason,
          decisionKey,
          decisionHash,
        })
        .where(eq(supplierInvoiceApprovalRequests.id, input.requestId));
      return {
        requestId: input.requestId,
        status: "STALE" as const,
        idempotentReplay: false as const,
      };
    }
    // Posting or reversing changes the AP/GRNI interpretation of the original
    // supplier document. A closed invoice period is immutable; the caller must
    // reopen it or use a separately governed prior-period adjustment flow.
    await assertPeriodOpen(
      tx,
      new Date(`${invoice.invoiceDate}T00:00:00.000Z`),
    );
    // بالفعل لا بالإجراء: **الترحيل** ينشئ ذمّةً جديدة (لا مالٌ خرج ولا أثرٌ قائمٌ مُحي)
    // ⇒ لا بوّابة؛ و**العكس** محوُ أثرٍ مُثبَت (قيدٌ عكسيّ + إنقاصُ رصيد المورّد + الحالة
    // REVERSED التي لا كاتبَ لها سواه) ⇒ المالك حصراً. والرفضُ حرٌّ في الحالتين.
    assertApprover({
      actor: await resolveApprovalActor(tx, actor),
      trigger: supplierInvoiceApprovalTrigger(request.kind, input.action),
      subject: `فاتورة المورّد ${invoice.invoiceNumber}`,
      legacy: () => {
        if (
          Number(request.requestedBy) === actor.userId ||
          Number(invoice.createdBy) === actor.userId
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "فصل المهام: منشئ الفاتورة أو طلبها لا يعتمد الترحيل أو العكس",
          });
        }
      },
    });
    let accountingEntryId: number;
    if (request.kind === "POST_INVOICE") {
      if (invoice.status !== "MATCHED" || request.matchRunId == null)
        throw new TRPCError({
          code: "CONFLICT",
          message: "الفاتورة لم تعد جاهزة للترحيل",
        });
      const match = (
        await tx
          .select()
          .from(supplierInvoiceMatchRuns)
          .where(eq(supplierInvoiceMatchRuns.id, Number(request.matchRunId)))
          .for("update")
          .limit(1)
      )[0];
      // فُصِل الفحصان لأنّهما مختلفان: **حالةُ المطابقة** شرطُ صحّةٍ يبقى دائماً، أمّا
      // **منفّذُ المطابقة لا يعتمدها** ففصلُ مهامٍ تحكمه سياسة الاعتماد. ودمجُهما في شرطٍ
      // واحد كان يُنتج رسالةً واحدة لسببين مختلفين، فلا يعرف الموظّف أيَّهما وقع.
      if (
        !match ||
        match.outcome === "HOLD" ||
        match.invoiceHash !== invoice.payloadHash
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "المطابقة محجوزة أو تغيّرت بعد إجرائها — أعد تشغيل المطابقة ثم أعد الطلب",
        });
      }
      assertApprover({
        actor: await resolveApprovalActor(tx, actor),
        trigger: supplierInvoiceApprovalTrigger(request.kind, input.action),
        subject: `فاتورة المورّد ${invoice.invoiceNumber}`,
        legacy: () => {
          if (Number(match.performedBy) === actor.userId) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "فصل المهام: منفّذ المطابقة لا يعتمدها",
            });
          }
        },
      });
      const allocationRows = await tx
        .select({ purchaseOrderId: purchaseOrderRevisions.purchaseOrderId })
        .from(supplierInvoiceMatchAllocations)
        .innerJoin(
          purchaseOrderRevisionItems,
          eq(
            purchaseOrderRevisionItems.id,
            supplierInvoiceMatchAllocations.purchaseOrderRevisionItemId,
          ),
        )
        .innerJoin(
          purchaseOrderRevisions,
          eq(purchaseOrderRevisions.id, purchaseOrderRevisionItems.revisionId),
        )
        .where(eq(supplierInvoiceMatchAllocations.matchRunId, Number(match.id)))
        .for("update");
      const poIds = Array.from(
        new Set(allocationRows.map((row) => Number(row.purchaseOrderId))),
      );
      accountingEntryId = await postSupplierInvoiceGrniTx(tx, {
        supplierInvoiceId: Number(invoice.id),
        purchaseOrderId: poIds.length === 1 ? poIds[0]! : null,
        supplierId: Number(invoice.supplierId),
        branchId: Number(invoice.branchId),
        invoiceAmount: money(invoice.totalAmount),
        taxAmount: money(invoice.taxAmount),
        grniAmount: money(match.grnTotal),
        actorId: actor.userId,
      });
      await adjustSupplierBalance(
        tx,
        Number(invoice.supplierId),
        money(invoice.totalAmount),
      );
      if (invoice.currency === "USD")
        await adjustSupplierBalanceUsd(
          tx,
          Number(invoice.supplierId),
          money(invoice.usdTotal ?? "0"),
        );
      await tx
        .update(supplierInvoices)
        .set({
          status: "POSTED",
          holdReason: null,
          postingEntryId: accountingEntryId,
          postedBy: actor.userId,
          postedAt: decidedAt,
        })
        .where(eq(supplierInvoices.id, Number(invoice.id)));
    } else {
      if (invoice.status !== "POSTED" || invoice.postedAt == null)
        throw new TRPCError({
          code: "CONFLICT",
          message: "الفاتورة لم تعد مرحّلة",
        });
      const paymentAllocations = await tx
        .select({
          allocatedAmount: supplierPaymentAllocations.allocatedAmount,
          refundedAmount: supplierPaymentAllocations.refundedAmount,
        })
        .from(supplierPaymentAllocations)
        .where(
          eq(supplierPaymentAllocations.supplierInvoiceId, Number(invoice.id)),
        )
        .orderBy(asc(supplierPaymentAllocations.id))
        .for("update");
      const linkedReturns = await tx
        .select({
          id: purchaseReturns.id,
          totalAmount: purchaseReturns.totalAmount,
        })
        .from(purchaseReturns)
        .where(eq(purchaseReturns.supplierInvoiceId, Number(invoice.id)))
        .orderBy(asc(purchaseReturns.id))
        .for("update");
      const linkedReturnIds = linkedReturns.map((purchaseReturn) =>
        Number(purchaseReturn.id),
      );
      const linkedReversals = linkedReturnIds.length
        ? await tx
            .select({
              purchaseReturnId: purchaseReturnReversals.purchaseReturnId,
              totalAmount: purchaseReturnReversals.totalAmount,
            })
            .from(purchaseReturnReversals)
            .where(
              inArray(
                purchaseReturnReversals.purchaseReturnId,
                linkedReturnIds,
              ),
            )
            .orderBy(
              asc(purchaseReturnReversals.purchaseReturnId),
              asc(purchaseReturnReversals.id),
            )
            .for("update")
        : [];
      const reversalsByReturn = new Map<
        number,
        Array<string | number | Decimal>
      >();
      for (const reversal of linkedReversals) {
        const purchaseReturnId = Number(reversal.purchaseReturnId);
        const amounts = reversalsByReturn.get(purchaseReturnId) ?? [];
        amounts.push(reversal.totalAmount);
        reversalsByReturn.set(purchaseReturnId, amounts);
      }
      assertSupplierInvoiceReversalDependenciesClear({
        paymentAllocations,
        purchaseReturns: linkedReturns.map((purchaseReturn) => ({
          id: Number(purchaseReturn.id),
          totalAmount: purchaseReturn.totalAmount,
          reversalAmounts:
            reversalsByReturn.get(Number(purchaseReturn.id)) ?? [],
        })),
      });
      const match = (
        await tx
          .select()
          .from(supplierInvoiceMatchRuns)
          .where(
            eq(supplierInvoiceMatchRuns.supplierInvoiceId, Number(invoice.id)),
          )
          .orderBy(desc(supplierInvoiceMatchRuns.runNo))
          .for("update")
          .limit(1)
      )[0];
      if (!match || match.outcome === "HOLD")
        throw new TRPCError({
          code: "CONFLICT",
          message: "تشغيل المطابقة الأصلي مفقود",
        });
      accountingEntryId = await postSupplierInvoiceGrniTx(tx, {
        supplierInvoiceId: Number(invoice.id),
        purchaseOrderId: null,
        supplierId: Number(invoice.supplierId),
        branchId: Number(invoice.branchId),
        invoiceAmount: money(invoice.totalAmount),
        taxAmount: money(invoice.taxAmount),
        grniAmount: money(match.grnTotal),
        actorId: actor.userId,
        reversal: true,
      });
      await adjustSupplierBalance(
        tx,
        Number(invoice.supplierId),
        money(invoice.totalAmount).negated(),
      );
      if (invoice.currency === "USD")
        await adjustSupplierBalanceUsd(
          tx,
          Number(invoice.supplierId),
          money(invoice.usdTotal ?? "0").negated(),
        );
      await tx
        .update(supplierInvoices)
        .set({
          status: "REVERSED",
          reversalEntryId: accountingEntryId,
          reversedBy: actor.userId,
          reversedAt: decidedAt,
          reversalReason: request.reason,
        })
        .where(eq(supplierInvoices.id, Number(invoice.id)));
    }
    await tx
      .update(supplierInvoiceApprovalRequests)
      .set({
        status: "APPROVED",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt: decidedAt,
        reviewReason,
        decisionKey,
        decisionHash,
        appliedAt: decidedAt,
      })
      .where(eq(supplierInvoiceApprovalRequests.id, input.requestId));
    return {
      requestId: input.requestId,
      supplierInvoiceId: Number(invoice.id),
      accountingEntryId,
      status: "APPROVED" as const,
      idempotentReplay: false as const,
    };
  });
}

export async function getSupplierInvoice(
  supplierInvoiceId: number,
  actor: Actor,
) {
  return withTx(
    async (tx) => {
      const invoice = (
        await tx
          .select()
          .from(supplierInvoices)
          .where(eq(supplierInvoices.id, supplierInvoiceId))
          .limit(1)
      )[0];
      if (!invoice)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "فاتورة المورد غير موجودة",
        });
      assertPurchaseBranch(invoice, actor);
      const lines = await tx
        .select()
        .from(supplierInvoiceLines)
        .where(eq(supplierInvoiceLines.supplierInvoiceId, supplierInvoiceId))
        .orderBy(asc(supplierInvoiceLines.lineNo));
      const matches = await tx
        .select()
        .from(supplierInvoiceMatchRuns)
        .where(
          eq(supplierInvoiceMatchRuns.supplierInvoiceId, supplierInvoiceId),
        )
        .orderBy(desc(supplierInvoiceMatchRuns.runNo));
      const approvals = await tx
        .select()
        .from(supplierInvoiceApprovalRequests)
        .where(
          eq(
            supplierInvoiceApprovalRequests.supplierInvoiceId,
            supplierInvoiceId,
          ),
        )
        .orderBy(desc(supplierInvoiceApprovalRequests.requestedAt));
      return { invoice, lines, matches, approvals };
    },
    { gate: "NONE" },
  );
}

export async function listSupplierInvoices(
  input: { branchId: number; supplierId?: number; limit?: number },
  actor: Actor,
) {
  if (actor.role !== "admin" && actor.branchId !== input.branchId)
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك عرض فرع آخر" });
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  return withTx(
    (tx) =>
      tx
        .select()
        .from(supplierInvoices)
        .where(
          and(
            eq(supplierInvoices.branchId, input.branchId),
            input.supplierId == null
              ? undefined
              : eq(supplierInvoices.supplierId, input.supplierId),
          ),
        )
        .orderBy(desc(supplierInvoices.invoiceDate), desc(supplierInvoices.id))
        .limit(limit),
    { gate: "NONE" },
  );
}

export async function listPendingSupplierInvoiceApprovals(
  branchId: number,
  actor: Actor,
) {
  if (actor.role !== "admin" && actor.branchId !== branchId)
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك عرض فرع آخر" });
  return withTx(
    (tx) =>
      tx
        .select()
        .from(supplierInvoiceApprovalRequests)
        .where(
          and(
            eq(supplierInvoiceApprovalRequests.branchId, branchId),
            eq(supplierInvoiceApprovalRequests.status, "PENDING"),
            ne(supplierInvoiceApprovalRequests.requestedBy, actor.userId),
          ),
        )
        .orderBy(asc(supplierInvoiceApprovalRequests.requestedAt)),
    { gate: "NONE" },
  );
}
