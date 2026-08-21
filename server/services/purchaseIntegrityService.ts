import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  idempotencyKeys,
  purchaseOrders,
  receipts,
  suppliers,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";
import { parseSystemPaymentRequest } from "./voucher/create";

export const MAX_PURCHASE_INTEGRITY_LIMIT = 500;
const DEFAULT_PURCHASE_INTEGRITY_LIMIT = 100;
const MAX_PURCHASE_INTEGRITY_OFFSET = 100_000;
const DEFAULT_STALE_AFTER_DAYS = 14;
const DEFAULT_HISTORICAL_CREDIT_AGE_DAYS = 90;
const MAX_AGE_THRESHOLD_DAYS = 3_650;
const DAY_MS = 86_400_000;

export const PURCHASE_INTEGRITY_CODES = [
  "CASH_RECEIVED_PAYMENT_COVERAGE_GAP",
  "PAID_AMOUNT_GL_DRIFT",
  "NEGATIVE_PO_LEDGER_BALANCE",
  "PO_PAYMENT_OVER_ALLOCATION",
  "HISTORICAL_CREDIT_REVIEW_CANDIDATE",
  "STALE_PENDING_PO_PAYMENT",
  "STALE_REJECTED_PO_PAYMENT",
  "INVALID_PENDING_PO_PAYMENT",
  "UNAPPROVED_PAYMENT_OUT_LEDGER_ENTRY",
  "LEDGER_BRANCH_OR_SUPPLIER_MISMATCH",
  "IDEMPOTENCY_CONFLICTING_PO_PAY_REFERENCE",
  "DUPLICATE_PAYMENT_LEDGER_MATERIALIZATION",
  "IDEMPOTENCY_RECEIPT_REF_REUSED",
] as const;

export type PurchaseIntegrityCode = (typeof PURCHASE_INTEGRITY_CODES)[number];
export type PurchaseIntegritySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface PurchaseIntegrityFinding {
  id: string;
  severity: PurchaseIntegritySeverity;
  code: PurchaseIntegrityCode;
  branchId: number;
  purchaseOrderId: number;
  poNumber: string;
  supplierId: number;
  supplierName: string | null;
  subjectType: "PURCHASE_ORDER" | "PAYMENT_REQUEST" | "RECEIPT" | "IDEMPOTENCY";
  subjectId: number | string;
  ageDays: number | null;
  summaryAr: string;
  evidence: Record<string, JsonValue>;
  autoCorrectionAllowed: false;
}

export interface PurchaseIntegrityOrderSummary {
  purchaseOrderId: number;
  poNumber: string;
  supplierId: number;
  supplierName: string | null;
  status: string;
  settlementType: "CASH" | "CREDIT";
  ageDays: number;
  recognizedPurchaseGl: string;
  approvedPaymentOutGl: string;
  approvedPaymentInGl: string;
  validPendingPoPay: string;
  storedPaidAmount: string;
  linkedPaidAmountGl: string;
  bookBalance: string;
  findingCodes: PurchaseIntegrityCode[];
}

export interface PurchaseIntegrityReportInput {
  /** يمرّره الراوتر من scopedBranchId؛ لا توجد قراءة مجمّعة أو فرع افتراضي. */
  branchId: number;
  limit?: number;
  offset?: number;
  staleAfterDays?: number;
  historicalCreditAgeDays?: number;
  /** seam اختباري فقط؛ الراوتر لا يعرّضه. */
  asOf?: Date;
}

export interface PurchaseIntegrityReport {
  mode: "DRY_RUN_READ_ONLY";
  generatedAt: string;
  branchId: number;
  sourceOfTruth: "ACCOUNTING_ENTRIES_GL";
  thresholds: {
    staleAfterDays: number;
    historicalCreditAgeDays: number;
  };
  page: {
    limit: number;
    offset: number;
    scannedOrderCount: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
  safeguards: {
    mutationsAvailable: false;
    productionRowsChanged: 0;
    cacheUsedAsSourceOfTruth: false;
    automaticCorrectionAvailable: false;
  };
  summary: {
    findingCount: number;
    affectedOrderCount: number;
    severityCounts: Record<PurchaseIntegritySeverity, number>;
    codeCounts: Partial<Record<PurchaseIntegrityCode, number>>;
  };
  orders: PurchaseIntegrityOrderSummary[];
  findings: PurchaseIntegrityFinding[];
}

type OrderRow = {
  id: number;
  poNumber: string;
  supplierId: number;
  supplierName: string | null;
  branchId: number;
  total: string;
  paidAmount: string;
  settlementType: "CASH" | "CREDIT";
  status: string;
  createdAt: Date;
};

type EntryRow = {
  id: number;
  purchaseOrderId: number;
  entryType: string;
  branchId: number | null;
  supplierId: number | null;
  receiptId: number | null;
  amount: string;
  postingProfile: string | null;
  notes: string | null;
  receiptBranchId: number | null;
  receiptDirection: string | null;
  receiptAmount: string | null;
  receiptPaymentMethod: string | null;
  receiptStatus: string | null;
  receiptApprovalStatus: string | null;
  receiptPartyType: string | null;
  receiptPartyId: number | null;
  receiptReferenceNumber: string | null;
  receiptInternalNote: string | null;
};

type RequestRow = {
  id: number;
  purchaseOrderId: number;
  poNumber: string;
  poBranchId: number;
  poSupplierId: number;
  poTotal: string;
  branchId: number | null;
  direction: string;
  amount: string;
  paymentMethod: string;
  referenceNumber: string | null;
  partyType: string | null;
  partyId: number | null;
  status: string;
  approvalStatus: string;
  internalNote: string | null;
  createdAt: Date;
};

type RequestAssessment = {
  row: RequestRow;
  invalidReasons: string[];
  validForCoverage: boolean;
};

type OrderAmounts = {
  recognizedPurchase: Decimal;
  approvedPaymentOut: Decimal;
  approvedPaymentIn: Decimal;
  paymentCancellationIn: Decimal;
  bookBalance: Decimal;
  validPending: Decimal;
};

function assertPositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} يجب أن يكون عدداً صحيحاً موجباً`,
    });
  }
  return value;
}

function guardedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} يجب أن يكون عدداً صحيحاً بين ${min} و${max}`,
    });
  }
  return resolved;
}

function ageDays(createdAt: Date, asOf: Date): number {
  return Math.max(
    0,
    Math.floor((asOf.getTime() - new Date(createdAt).getTime()) / DAY_MS),
  );
}

function safeMoney(value: unknown): Decimal | null {
  try {
    const parsed = money(value as string);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

function emptyAmounts(): OrderAmounts {
  return {
    recognizedPurchase: money(0),
    approvedPaymentOut: money(0),
    approvedPaymentIn: money(0),
    paymentCancellationIn: money(0),
    bookBalance: money(0),
    validPending: money(0),
  };
}

function requestAssessment(
  row: RequestRow,
  linkedEntryCount: number,
): RequestAssessment {
  const invalidReasons: string[] = [];
  const parsed = parseSystemPaymentRequest(row.internalNote);
  const token =
    parsed?.kind === "PURCHASE_SUPPLIER" ? parsed.requestToken : null;
  const expectedReference = token ? `PO-PAY-${row.poNumber}-${token}` : null;
  const amount = safeMoney(row.amount);
  const expectedAmount =
    parsed?.kind === "PURCHASE_SUPPLIER"
      ? safeMoney(parsed.expectedAmount)
      : null;
  const sourceTotal =
    parsed?.kind === "PURCHASE_SUPPLIER" ? safeMoney(parsed.sourceTotal) : null;

  if (row.status !== "PENDING" || row.approvalStatus !== "PENDING_APPROVAL")
    invalidReasons.push("REQUEST_NOT_PENDING");
  if (row.direction !== "OUT") invalidReasons.push("DIRECTION_NOT_OUT");
  if (row.paymentMethod !== "CASH")
    invalidReasons.push("PAYMENT_METHOD_NOT_CASH");
  if (row.branchId !== row.poBranchId) invalidReasons.push("BRANCH_MISMATCH");
  if (row.partyType !== "SUPPLIER" || row.partyId !== row.poSupplierId)
    invalidReasons.push("SUPPLIER_MISMATCH");
  if (!amount?.gt(0)) invalidReasons.push("AMOUNT_NOT_POSITIVE");
  if (parsed?.kind !== "PURCHASE_SUPPLIER")
    invalidReasons.push("SYSTEM_REQUEST_MISSING_OR_WRONG_KIND");
  if (
    parsed?.kind === "PURCHASE_SUPPLIER" &&
    parsed.purchaseOrderId !== row.purchaseOrderId
  )
    invalidReasons.push("PURCHASE_ORDER_ID_MISMATCH");
  if (token == null || !/^[0-9a-f]{16}$/i.test(token))
    invalidReasons.push("REQUEST_TOKEN_INVALID");
  if (expectedReference == null || row.referenceNumber !== expectedReference)
    invalidReasons.push("REFERENCE_MISMATCH");
  if (amount == null || expectedAmount == null || !amount.eq(expectedAmount))
    invalidReasons.push("EXPECTED_AMOUNT_MISMATCH");
  if (
    sourceTotal == null ||
    !sourceTotal.eq(safeMoney(row.poTotal) ?? money(0))
  )
    invalidReasons.push("SOURCE_TOTAL_MISMATCH");
  if (linkedEntryCount !== 0)
    invalidReasons.push("PENDING_REQUEST_ALREADY_HAS_LEDGER_ENTRY");

  return {
    row,
    invalidReasons,
    validForCoverage: invalidReasons.length === 0,
  };
}

function findingId(
  code: PurchaseIntegrityCode,
  subjectType: PurchaseIntegrityFinding["subjectType"],
  subjectId: number | string,
): string {
  return `${code}:${subjectType}:${subjectId}`;
}

function severityRank(severity: PurchaseIntegritySeverity): number {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 }[severity];
}

/**
 * تقرير تدقيق تشخيصي فقط: لا يكتب، لا يصحح cache، ولا يرحّل قيداً. كل القراءات
 * داخل لقطة REPEATABLE READ / READ ONLY، والفرع إلزامي في أول SELECT.
 */
export async function getPurchaseIntegrityReport(
  input: PurchaseIntegrityReportInput,
): Promise<PurchaseIntegrityReport> {
  const branchId = assertPositiveSafeInteger(input.branchId, "الفرع");
  const limit = guardedInteger(
    input.limit,
    DEFAULT_PURCHASE_INTEGRITY_LIMIT,
    1,
    MAX_PURCHASE_INTEGRITY_LIMIT,
    "limit",
  );
  const offset = guardedInteger(
    input.offset,
    0,
    0,
    MAX_PURCHASE_INTEGRITY_OFFSET,
    "offset",
  );
  const staleAfterDays = guardedInteger(
    input.staleAfterDays,
    DEFAULT_STALE_AFTER_DAYS,
    1,
    MAX_AGE_THRESHOLD_DAYS,
    "staleAfterDays",
  );
  const historicalCreditAgeDays = guardedInteger(
    input.historicalCreditAgeDays,
    DEFAULT_HISTORICAL_CREDIT_AGE_DAYS,
    1,
    MAX_AGE_THRESHOLD_DAYS,
    "historicalCreditAgeDays",
  );
  const asOf = input.asOf ? new Date(input.asOf) : new Date();
  if (!Number.isFinite(asOf.getTime())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "وقت التقرير غير صالح",
    });
  }

  const database = getDb();
  if (!database) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "قاعدة البيانات غير متاحة",
    });
  }

  return database.transaction(
    async (tx) => {
      const fetchedOrders = (await tx
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          supplierId: purchaseOrders.supplierId,
          supplierName: suppliers.name,
          branchId: purchaseOrders.branchId,
          total: purchaseOrders.total,
          paidAmount: purchaseOrders.paidAmount,
          settlementType: purchaseOrders.settlementType,
          status: purchaseOrders.status,
          createdAt: purchaseOrders.createdAt,
        })
        .from(purchaseOrders)
        .leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .where(eq(purchaseOrders.branchId, branchId))
        .orderBy(desc(purchaseOrders.id))
        .limit(limit + 1)
        .offset(offset)) as OrderRow[];
      const hasMore = fetchedOrders.length > limit;
      const orderRows = fetchedOrders.slice(0, limit);
      const orderIds = orderRows.map((row) => Number(row.id));

      if (orderIds.length === 0) {
        return buildReport({
          branchId,
          limit,
          offset,
          hasMore: false,
          staleAfterDays,
          historicalCreditAgeDays,
          asOf,
          orders: [],
          findings: [],
        });
      }

      const relatedRowLimit = Math.min(10_000, Math.max(100, limit * 50));
      const entryRows = (await tx
        .select({
          id: accountingEntries.id,
          purchaseOrderId: accountingEntries.purchaseOrderId,
          entryType: accountingEntries.entryType,
          branchId: accountingEntries.branchId,
          supplierId: accountingEntries.supplierId,
          receiptId: accountingEntries.receiptId,
          amount: accountingEntries.amount,
          postingProfile: accountingEntries.postingProfile,
          notes: accountingEntries.notes,
          receiptBranchId: receipts.branchId,
          receiptDirection: receipts.direction,
          receiptAmount: receipts.amount,
          receiptPaymentMethod: receipts.paymentMethod,
          receiptStatus: receipts.status,
          receiptApprovalStatus: receipts.approvalStatus,
          receiptPartyType: receipts.partyType,
          receiptPartyId: receipts.partyId,
          receiptReferenceNumber: receipts.referenceNumber,
          receiptInternalNote: receipts.internalNote,
        })
        .from(accountingEntries)
        .leftJoin(receipts, eq(receipts.id, accountingEntries.receiptId))
        .where(inArray(accountingEntries.purchaseOrderId, orderIds))
        .orderBy(desc(accountingEntries.id))
        .limit(relatedRowLimit + 1)) as EntryRow[];

      const requestRows = (await tx
        .select({
          id: receipts.id,
          purchaseOrderId: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          poBranchId: purchaseOrders.branchId,
          poSupplierId: purchaseOrders.supplierId,
          poTotal: purchaseOrders.total,
          branchId: receipts.branchId,
          direction: receipts.direction,
          amount: receipts.amount,
          paymentMethod: receipts.paymentMethod,
          referenceNumber: receipts.referenceNumber,
          partyType: receipts.partyType,
          partyId: receipts.partyId,
          status: receipts.status,
          approvalStatus: receipts.approvalStatus,
          internalNote: receipts.internalNote,
          createdAt: receipts.createdAt,
        })
        .from(receipts)
        .innerJoin(
          purchaseOrders,
          and(
            inArray(purchaseOrders.id, orderIds),
            sql`${receipts.referenceNumber} LIKE CONCAT('PO-PAY-', ${purchaseOrders.poNumber}, '-%')`,
          ),
        )
        .orderBy(desc(receipts.id))
        .limit(relatedRowLimit + 1)) as RequestRow[];

      if (
        entryRows.length > relatedRowLimit ||
        requestRows.length > relatedRowLimit
      ) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message:
            "عدد القيود أو طلبات الدفع المرتبطة بالصفحة يتجاوز حد التدقيق؛ خفّض limit أو صدّر على صفحات أصغر",
        });
      }

      const relatedReceiptIds = Array.from(
        new Set([
          ...requestRows.map((row) => Number(row.id)),
          ...entryRows
            .map((row) => row.receiptId)
            .filter((id): id is number => id != null)
            .map(Number),
        ]),
      );
      const keyRows = relatedReceiptIds.length
        ? await tx
            .select({
              id: idempotencyKeys.id,
              operation: idempotencyKeys.operation,
              clientRequestId: idempotencyKeys.clientRequestId,
              refId: idempotencyKeys.refId,
              payloadHash: idempotencyKeys.payloadHash,
            })
            .from(idempotencyKeys)
            .where(
              and(
                eq(idempotencyKeys.operation, "voucher.create"),
                inArray(idempotencyKeys.refId, relatedReceiptIds),
              ),
            )
            .limit(relatedRowLimit + 1)
        : [];
      if (keyRows.length > relatedRowLimit) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message:
            "عدد مفاتيح idempotency المرتبطة يتجاوز حد التدقيق؛ صدّر على صفحات أصغر",
        });
      }

      const orderById = new Map(orderRows.map((row) => [Number(row.id), row]));
      const entriesByOrder = new Map<number, EntryRow[]>();
      const entriesByReceipt = new Map<number, EntryRow[]>();
      const entryReceiptById = new Map<
        number,
        Pick<
          EntryRow,
          | "receiptBranchId"
          | "receiptDirection"
          | "receiptAmount"
          | "receiptPaymentMethod"
          | "receiptStatus"
          | "receiptApprovalStatus"
          | "receiptPartyType"
          | "receiptPartyId"
          | "receiptReferenceNumber"
          | "receiptInternalNote"
        >
      >();
      const purchaseOrderByReceiptId = new Map<number, number>();
      for (const entry of entryRows) {
        const poId = Number(entry.purchaseOrderId);
        const current = entriesByOrder.get(poId) ?? [];
        current.push(entry);
        entriesByOrder.set(poId, current);
        if (entry.receiptId != null) {
          const receiptId = Number(entry.receiptId);
          const linked = entriesByReceipt.get(receiptId) ?? [];
          linked.push(entry);
          entriesByReceipt.set(receiptId, linked);
          entryReceiptById.set(receiptId, entry);
          purchaseOrderByReceiptId.set(receiptId, poId);
        }
      }
      for (const request of requestRows) {
        purchaseOrderByReceiptId.set(
          Number(request.id),
          Number(request.purchaseOrderId),
        );
      }

      const findings: PurchaseIntegrityFinding[] = [];
      const addFinding = (
        order: OrderRow,
        data: Omit<
          PurchaseIntegrityFinding,
          | "id"
          | "branchId"
          | "purchaseOrderId"
          | "poNumber"
          | "supplierId"
          | "supplierName"
          | "autoCorrectionAllowed"
        >,
      ) => {
        findings.push({
          id: findingId(data.code, data.subjectType, data.subjectId),
          branchId,
          purchaseOrderId: Number(order.id),
          poNumber: order.poNumber,
          supplierId: Number(order.supplierId),
          supplierName: order.supplierName,
          autoCorrectionAllowed: false,
          ...data,
        });
      };

      const conflictingReferences = new Set<string>();
      const requestsByReference = new Map<string, RequestRow[]>();
      const requestsByOrder = new Map<number, RequestRow[]>();
      for (const request of requestRows) {
        const poId = Number(request.purchaseOrderId);
        const orderRequests = requestsByOrder.get(poId) ?? [];
        orderRequests.push(request);
        requestsByOrder.set(poId, orderRequests);
        if (!request.referenceNumber) continue;
        const group = requestsByReference.get(request.referenceNumber) ?? [];
        group.push(request);
        requestsByReference.set(request.referenceNumber, group);
      }
      for (const [reference, group] of Array.from(
        requestsByReference.entries(),
      )) {
        const active = group.filter(
          (row) =>
            (row.status === "PENDING" &&
              row.approvalStatus === "PENDING_APPROVAL") ||
            (row.status === "COMPLETED" && row.approvalStatus === "APPROVED"),
        );
        const amountSet = new Set(
          active.map((row) => toDbMoney(money(row.amount))),
        );
        const partySet = new Set(
          active.map(
            (row) => `${row.branchId}:${row.partyType}:${row.partyId}`,
          ),
        );
        if (
          active.length > 1 &&
          (amountSet.size > 1 || partySet.size > 1 || active.length !== 1)
        ) {
          conflictingReferences.add(reference);
          const order = orderById.get(Number(group[0].purchaseOrderId));
          if (order) {
            addFinding(order, {
              severity: "HIGH",
              code: "IDEMPOTENCY_CONFLICTING_PO_PAY_REFERENCE",
              subjectType: "IDEMPOTENCY",
              subjectId: reference,
              ageDays: null,
              summaryAr:
                "مرجع PO-PAY واحد مرتبط بأكثر من محاولة حية؛ لا تُجمع مبالغها كتغطية قبل مراجعة السلسلة.",
              evidence: {
                referenceNumber: reference,
                receiptIds: active.map((row) => Number(row.id)),
                amounts: active.map((row) => toDbMoney(money(row.amount))),
                states: active.map(
                  (row) => `${row.status}/${row.approvalStatus}`,
                ),
              },
            });
          }
        }
      }

      const assessmentByReceipt = new Map<number, RequestAssessment>();
      for (const request of requestRows) {
        const assessment = requestAssessment(
          request,
          (entriesByReceipt.get(Number(request.id)) ?? []).length,
        );
        if (
          request.referenceNumber &&
          conflictingReferences.has(request.referenceNumber)
        ) {
          assessment.invalidReasons.push("CONFLICTING_ACTIVE_REFERENCE");
          assessment.validForCoverage = false;
        }
        assessmentByReceipt.set(Number(request.id), assessment);
      }

      const amountsByOrder = new Map<number, OrderAmounts>();
      for (const order of orderRows) {
        const poId = Number(order.id);
        const amounts = emptyAmounts();
        const poEntries = entriesByOrder.get(poId) ?? [];
        const duplicateOutByReceipt = new Map<number, EntryRow[]>();
        for (const entry of poEntries) {
          const amount = money(entry.amount);
          if (entry.entryType === "PURCHASE" || entry.entryType === "RETURN")
            amounts.recognizedPurchase =
              amounts.recognizedPurchase.plus(amount);
          if (
            entry.entryType === "PURCHASE" ||
            entry.entryType === "RETURN" ||
            entry.entryType === "PAYMENT_IN"
          )
            amounts.bookBalance = amounts.bookBalance.plus(amount);
          else if (
            entry.entryType === "PAYMENT_OUT" ||
            entry.entryType === "EXCHANGE_SETTLE"
          )
            amounts.bookBalance = amounts.bookBalance.minus(amount);

          const receiptApproved =
            entry.receiptStatus === "COMPLETED" &&
            entry.receiptApprovalStatus === "APPROVED" &&
            entry.receiptBranchId === Number(order.branchId) &&
            entry.receiptPartyType === "SUPPLIER" &&
            entry.receiptPartyId === Number(order.supplierId);
          if (entry.entryType === "PAYMENT_OUT") {
            if (entry.receiptId != null) {
              const receiptId = Number(entry.receiptId);
              const linked = duplicateOutByReceipt.get(receiptId) ?? [];
              linked.push(entry);
              duplicateOutByReceipt.set(receiptId, linked);
            }
            if (
              receiptApproved &&
              entry.receiptDirection === "OUT" &&
              safeMoney(entry.receiptAmount)?.eq(amount)
            ) {
              amounts.approvedPaymentOut =
                amounts.approvedPaymentOut.plus(amount);
            } else {
              addFinding(order, {
                severity: "CRITICAL",
                code: "UNAPPROVED_PAYMENT_OUT_LEDGER_ENTRY",
                subjectType: "RECEIPT",
                subjectId: entry.receiptId ?? `ENTRY-${entry.id}`,
                ageDays: null,
                summaryAr:
                  "قيد PAYMENT_OUT يؤثر في رصيد أمر الشراء بلا سند صرف مكتمل ومعتمد مطابق.",
                evidence: {
                  accountingEntryId: Number(entry.id),
                  receiptId: entry.receiptId,
                  entryAmount: toDbMoney(amount),
                  receiptStatus: entry.receiptStatus,
                  approvalStatus: entry.receiptApprovalStatus,
                  receiptDirection: entry.receiptDirection,
                  receiptAmount: entry.receiptAmount,
                },
              });
            }
          }
          if (
            entry.entryType === "PAYMENT_IN" &&
            receiptApproved &&
            entry.receiptDirection === "IN" &&
            safeMoney(entry.receiptAmount)?.eq(amount)
          ) {
            amounts.approvedPaymentIn = amounts.approvedPaymentIn.plus(amount);
            const cancellation = parseSystemPaymentRequest(
              entry.receiptInternalNote,
            );
            if (cancellation?.kind === "VOUCHER_CANCELLATION") {
              const original = entryReceiptById.get(
                Number(cancellation.originalReceiptId),
              );
              const originalRequest = parseSystemPaymentRequest(
                original?.receiptInternalNote,
              );
              if (
                originalRequest?.kind === "PURCHASE_SUPPLIER" &&
                originalRequest.purchaseOrderId === poId &&
                original?.receiptStatus === "COMPLETED" &&
                original.receiptApprovalStatus === "APPROVED" &&
                original.receiptDirection === "OUT" &&
                safeMoney(original.receiptAmount)?.eq(amount)
              ) {
                amounts.paymentCancellationIn =
                  amounts.paymentCancellationIn.plus(amount);
              }
            }
          }
          if (
            entry.branchId !== Number(order.branchId) ||
            entry.supplierId !== Number(order.supplierId)
          ) {
            addFinding(order, {
              severity: "CRITICAL",
              code: "LEDGER_BRANCH_OR_SUPPLIER_MISMATCH",
              subjectType: "PURCHASE_ORDER",
              subjectId: poId,
              ageDays: null,
              summaryAr:
                "قيد مرتبط بأمر الشراء يحمل فرعاً أو مورداً لا يطابق المستند.",
              evidence: {
                accountingEntryId: Number(entry.id),
                entryBranchId: entry.branchId,
                orderBranchId: Number(order.branchId),
                entrySupplierId: entry.supplierId,
                orderSupplierId: Number(order.supplierId),
              },
            });
          }
        }
        for (const [receiptId, duplicateEntries] of Array.from(
          duplicateOutByReceipt.entries(),
        )) {
          if (duplicateEntries.length <= 1) continue;
          addFinding(order, {
            severity: "CRITICAL",
            code: "DUPLICATE_PAYMENT_LEDGER_MATERIALIZATION",
            subjectType: "RECEIPT",
            subjectId: receiptId,
            ageDays: null,
            summaryAr:
              "سند صرف واحد مرتبط بأكثر من قيد PAYMENT_OUT لنفس أمر الشراء.",
            evidence: {
              receiptId,
              accountingEntryIds: duplicateEntries.map((entry) =>
                Number(entry.id),
              ),
              amounts: duplicateEntries.map((entry) =>
                toDbMoney(money(entry.amount)),
              ),
            },
          });
        }

        const poRequests = requestsByOrder.get(poId) ?? [];
        for (const request of poRequests) {
          const assessment = assessmentByReceipt.get(Number(request.id));
          if (assessment?.validForCoverage)
            amounts.validPending = amounts.validPending.plus(
              money(request.amount),
            );
          const requestAge = ageDays(request.createdAt, asOf);
          if (
            request.status === "PENDING" &&
            request.approvalStatus === "PENDING_APPROVAL" &&
            requestAge >= staleAfterDays
          ) {
            addFinding(order, {
              severity: "MEDIUM",
              code: "STALE_PENDING_PO_PAYMENT",
              subjectType: "PAYMENT_REQUEST",
              subjectId: Number(request.id),
              ageDays: requestAge,
              summaryAr:
                "طلب دفع أمر شراء ما زال معلقاً بعد مهلة المتابعة البشرية.",
              evidence: {
                receiptId: Number(request.id),
                referenceNumber: request.referenceNumber,
                amount: toDbMoney(money(request.amount)),
                ageDays: requestAge,
                requestValidForCoverage: assessment?.validForCoverage ?? false,
                invalidReasons: assessment?.invalidReasons ?? [],
              },
            });
          }
          if (
            request.approvalStatus === "REJECTED" &&
            requestAge >= staleAfterDays
          ) {
            addFinding(order, {
              severity: "INFO",
              code: "STALE_REJECTED_PO_PAYMENT",
              subjectType: "PAYMENT_REQUEST",
              subjectId: Number(request.id),
              ageDays: requestAge,
              summaryAr:
                "طلب دفع مرفوض قديم بقي في السجل ويحتاج قرار إغلاق أو إعادة تقديم موثق.",
              evidence: {
                receiptId: Number(request.id),
                referenceNumber: request.referenceNumber,
                amount: toDbMoney(money(request.amount)),
                ageDays: requestAge,
                status: request.status,
                approvalStatus: request.approvalStatus,
              },
            });
          }
          if (
            request.status === "PENDING" &&
            request.approvalStatus === "PENDING_APPROVAL" &&
            assessment &&
            !assessment.validForCoverage
          ) {
            addFinding(order, {
              severity: "HIGH",
              code: "INVALID_PENDING_PO_PAYMENT",
              subjectType: "PAYMENT_REQUEST",
              subjectId: Number(request.id),
              ageDays: requestAge,
              summaryAr:
                "طلب PO-PAY معلق لا يجتاز أدلة المصدر، لذلك لم يُحتسب ضمن تغطية الأمر.",
              evidence: {
                receiptId: Number(request.id),
                referenceNumber: request.referenceNumber,
                amount: toDbMoney(money(request.amount)),
                invalidReasons: assessment.invalidReasons,
              },
            });
          }
        }
        amountsByOrder.set(poId, amounts);
      }

      const keysByReceipt = new Map<number, typeof keyRows>();
      for (const key of keyRows) {
        const refId = Number(key.refId);
        const current = keysByReceipt.get(refId) ?? [];
        current.push(key);
        keysByReceipt.set(refId, current);
      }
      for (const [receiptId, keys] of Array.from(keysByReceipt.entries())) {
        if (keys.length <= 1) continue;
        const poId = purchaseOrderByReceiptId.get(receiptId);
        const order = poId == null ? null : orderById.get(poId);
        if (!order) continue;
        addFinding(order, {
          severity: "HIGH",
          code: "IDEMPOTENCY_RECEIPT_REF_REUSED",
          subjectType: "IDEMPOTENCY",
          subjectId: receiptId,
          ageDays: null,
          summaryAr:
            "نتيجة سند واحدة مرتبطة بأكثر من مفتاح voucher.create؛ راجع ما إذا كانت إعادةً شرعية أم تعارض عميل.",
          evidence: {
            receiptId,
            idempotencyKeyIds: keys.map((key) => Number(key.id)),
            clientRequestIds: keys.map((key) => key.clientRequestId),
            payloadHashes: keys.map((key) => key.payloadHash),
          },
        });
      }

      for (const order of orderRows) {
        const poId = Number(order.id);
        const amounts = amountsByOrder.get(poId) ?? emptyAmounts();
        const linkedPaidAmount = amounts.approvedPaymentOut.minus(
          amounts.paymentCancellationIn,
        );
        const netCovered = amounts.approvedPaymentOut
          .minus(amounts.approvedPaymentIn)
          .plus(amounts.validPending);
        const coverageDifference = netCovered.minus(amounts.recognizedPurchase);
        const storedPaid = money(order.paidAmount);
        const paidDifference = storedPaid.minus(linkedPaidAmount);
        const orderAge = ageDays(order.createdAt, asOf);

        if (
          order.settlementType === "CASH" &&
          amounts.recognizedPurchase.gt(0) &&
          !coverageDifference.isZero()
        ) {
          addFinding(order, {
            severity: coverageDifference.lt(0) ? "CRITICAL" : "HIGH",
            code: "CASH_RECEIVED_PAYMENT_COVERAGE_GAP",
            subjectType: "PURCHASE_ORDER",
            subjectId: poId,
            ageDays: orderAge,
            summaryAr: coverageDifference.lt(0)
              ? "شراء CASH معترف به في GL بلا تغطية مساوية من الصرف المعتمد والطلبات المعلقة الصالحة."
              : "تغطية شراء CASH تتجاوز الاعتراف الدفتري المرتبط؛ يلزم منع صرف مكرر قبل أي اعتماد جديد.",
            evidence: {
              recognizedPurchaseGl: toDbMoney(amounts.recognizedPurchase),
              approvedPaymentOutGl: toDbMoney(amounts.approvedPaymentOut),
              approvedPaymentInGl: toDbMoney(amounts.approvedPaymentIn),
              validPendingPoPay: toDbMoney(amounts.validPending),
              netCoveredAmount: toDbMoney(netCovered),
              difference: toDbMoney(coverageDifference),
              formula:
                "PAYMENT_OUT approved - PAYMENT_IN approved + valid pending PO-PAY - (PURCHASE + RETURN)",
            },
          });
        }
        if (!paidDifference.isZero()) {
          addFinding(order, {
            severity: "HIGH",
            code: "PAID_AMOUNT_GL_DRIFT",
            subjectType: "PURCHASE_ORDER",
            subjectId: poId,
            ageDays: orderAge,
            summaryAr:
              "purchaseOrders.paidAmount لا يطابق التخصيص المثبت بقيود الدفع المرتبطة؛ GL هو الدليل الحاكم.",
            evidence: {
              storedPaidAmount: toDbMoney(storedPaid),
              linkedPaidAmountGl: toDbMoney(linkedPaidAmount),
              approvedPaymentOutGl: toDbMoney(amounts.approvedPaymentOut),
              approvedCancellationInGl: toDbMoney(
                amounts.paymentCancellationIn,
              ),
              difference: toDbMoney(paidDifference),
            },
          });
        }
        if (amounts.bookBalance.lt(0)) {
          addFinding(order, {
            severity: "CRITICAL",
            code: "NEGATIVE_PO_LEDGER_BALANCE",
            subjectType: "PURCHASE_ORDER",
            subjectId: poId,
            ageDays: orderAge,
            summaryAr:
              "صافي رصيد أمر الشراء في GL سالب؛ الصرف/التخصيص تجاوز الاعتراف المرتبط.",
            evidence: {
              bookBalance: toDbMoney(amounts.bookBalance),
              overAllocatedBy: toDbMoney(amounts.bookBalance.abs()),
              formula:
                "PURCHASE + RETURN + PAYMENT_IN - PAYMENT_OUT - EXCHANGE_SETTLE",
            },
          });
        }
        if (coverageDifference.gt(0)) {
          addFinding(order, {
            severity: "HIGH",
            code: "PO_PAYMENT_OVER_ALLOCATION",
            subjectType: "PURCHASE_ORDER",
            subjectId: poId,
            ageDays: orderAge,
            summaryAr:
              "الصرف المعتمد مع طلبات PO-PAY الصالحة يتجاوز الاعتراف الدفتري للأمر.",
            evidence: {
              recognizedPurchaseGl: toDbMoney(amounts.recognizedPurchase),
              netCoveredAmount: toDbMoney(netCovered),
              overAllocatedBy: toDbMoney(coverageDifference),
            },
          });
        }
        if (
          order.settlementType === "CREDIT" &&
          orderAge >= historicalCreditAgeDays &&
          !amounts.recognizedPurchase.isZero()
        ) {
          const reasonCodes = [
            "SETTLEMENT_TYPE_CREDIT",
            "GL_PURCHASE_RECOGNIZED",
          ];
          if (amounts.bookBalance.gt(0))
            reasonCodes.push("OUTSTANDING_GL_BALANCE");
          if (amounts.approvedPaymentOut.gt(0))
            reasonCodes.push("APPROVED_PAYMENT_OUT_LINKED");
          if (storedPaid.gt(0)) reasonCodes.push("STORED_PAID_AMOUNT_NONZERO");
          if (amounts.validPending.gt(0))
            reasonCodes.push("VALID_PENDING_PO_PAY_PRESENT");
          addFinding(order, {
            severity: "INFO",
            code: "HISTORICAL_CREDIT_REVIEW_CANDIDATE",
            subjectType: "PURCHASE_ORDER",
            subjectId: poId,
            ageDays: orderAge,
            summaryAr:
              "أمر CREDIT تاريخي مرشح لمراجعة المستندات فقط؛ لا توجد أدلة كافية لاستنتاج أنه كان CASH.",
            evidence: {
              settlementType: "CREDIT",
              cashClassificationInferred: false,
              ageDays: orderAge,
              reasonCodes,
              recognizedPurchaseGl: toDbMoney(amounts.recognizedPurchase),
              approvedPaymentOutGl: toDbMoney(amounts.approvedPaymentOut),
              validPendingPoPay: toDbMoney(amounts.validPending),
              bookBalance: toDbMoney(amounts.bookBalance),
            },
          });
        }
      }

      findings.sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) ||
          b.purchaseOrderId - a.purchaseOrderId ||
          a.code.localeCompare(b.code) ||
          String(a.subjectId).localeCompare(String(b.subjectId)),
      );

      const findingCodesByOrder = new Map<number, PurchaseIntegrityCode[]>();
      for (const finding of findings) {
        const codes = findingCodesByOrder.get(finding.purchaseOrderId) ?? [];
        codes.push(finding.code);
        findingCodesByOrder.set(finding.purchaseOrderId, codes);
      }

      const orderSummaries = orderRows.map((order) => {
        const amounts = amountsByOrder.get(Number(order.id)) ?? emptyAmounts();
        return {
          purchaseOrderId: Number(order.id),
          poNumber: order.poNumber,
          supplierId: Number(order.supplierId),
          supplierName: order.supplierName,
          status: order.status,
          settlementType: order.settlementType,
          ageDays: ageDays(order.createdAt, asOf),
          recognizedPurchaseGl: toDbMoney(amounts.recognizedPurchase),
          approvedPaymentOutGl: toDbMoney(amounts.approvedPaymentOut),
          approvedPaymentInGl: toDbMoney(amounts.approvedPaymentIn),
          validPendingPoPay: toDbMoney(amounts.validPending),
          storedPaidAmount: toDbMoney(money(order.paidAmount)),
          linkedPaidAmountGl: toDbMoney(
            amounts.approvedPaymentOut.minus(amounts.paymentCancellationIn),
          ),
          bookBalance: toDbMoney(amounts.bookBalance),
          findingCodes: findingCodesByOrder.get(Number(order.id)) ?? [],
        } satisfies PurchaseIntegrityOrderSummary;
      });

      return buildReport({
        branchId,
        limit,
        offset,
        hasMore,
        staleAfterDays,
        historicalCreditAgeDays,
        asOf,
        orders: orderSummaries,
        findings,
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

function buildReport(args: {
  branchId: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  staleAfterDays: number;
  historicalCreditAgeDays: number;
  asOf: Date;
  orders: PurchaseIntegrityOrderSummary[];
  findings: PurchaseIntegrityFinding[];
}): PurchaseIntegrityReport {
  const severityCounts: Record<PurchaseIntegritySeverity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    INFO: 0,
  };
  const codeCounts: Partial<Record<PurchaseIntegrityCode, number>> = {};
  for (const finding of args.findings) {
    severityCounts[finding.severity] += 1;
    codeCounts[finding.code] = (codeCounts[finding.code] ?? 0) + 1;
  }
  return {
    mode: "DRY_RUN_READ_ONLY",
    generatedAt: args.asOf.toISOString(),
    branchId: args.branchId,
    sourceOfTruth: "ACCOUNTING_ENTRIES_GL",
    thresholds: {
      staleAfterDays: args.staleAfterDays,
      historicalCreditAgeDays: args.historicalCreditAgeDays,
    },
    page: {
      limit: args.limit,
      offset: args.offset,
      scannedOrderCount: args.orders.length,
      hasMore: args.hasMore,
      nextOffset: args.hasMore ? args.offset + args.orders.length : null,
    },
    safeguards: {
      mutationsAvailable: false,
      productionRowsChanged: 0,
      cacheUsedAsSourceOfTruth: false,
      automaticCorrectionAvailable: false,
    },
    summary: {
      findingCount: args.findings.length,
      affectedOrderCount: new Set(
        args.findings.map((finding) => finding.purchaseOrderId),
      ).size,
      severityCounts,
      codeCounts,
    },
    orders: args.orders,
    findings: args.findings,
  };
}
