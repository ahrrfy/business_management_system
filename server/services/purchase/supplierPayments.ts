import {
  loadSupplierFormalCreditTotals,
  supplierFormalCreditTotalsSql,
} from "./supplierFormalCreditProjection";
import {
  loadSupplierBookInvoiceTotals,
  supplierBookInvoiceTotalsSql,
} from "./supplierBookProjection";
import { createHash } from "node:crypto";
import {
  canonicalOperationAllowed,
  loadOperationUserTx,
} from "../authorization/operationAuthority";
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  accounts,
  accountingEntries,
  goodsReceiptItems,
  purchaseOrderEvents,
  purchaseOrderItems,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
  purchaseReturnReversals,
  purchaseReturns,
  receipts,
  roles,
  shifts,
  supplierInvoiceLines,
  supplierInvoiceMatchRuns,
  supplierInvoiceMatchAllocations,
  supplierInvoices,
  supplierPaymentAllocations,
  supplierPaymentRefundItems,
  supplierPaymentRefundRequestItems,
  supplierPaymentRefundRequests,
  supplierPaymentRefunds,
  supplierPaymentRequestAllocations,
  supplierPaymentRequests,
  supplierPayments,
  suppliers,
  auditLogs,
  users,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { autoDecideForActiveOwner } from "../approval/ownerAutoDecision";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import {
  createPostingIntent,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import {
  assertApprovedTreasuryOutAvailable,
  assertCashOutAvailable,
  assertNonPhysicalOutReceipt,
  authorizeExternalTreasuryDisbursement,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import {
  adjustSupplierBalance,
  adjustSupplierBalanceUsd,
  postEntry,
} from "../ledgerService";
import { money, round2, sumMoney, toDbMoney } from "../money";
import { paymentAssetRole } from "../sale/paymentPosting";
import { openShiftIdTx } from "../shiftService";
import { appErrorMessage } from "@shared/errors";
import {
  applyPermissionOverrides,
  diffFromTemplate,
  moduleAccessAllowed,
  resolvePermissions,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { withTx, type Actor } from "../tx";
import { sha256, stableCanonical } from "./grniAccounting";
import { assertPurchaseBranch } from "./internal";
import {
  lockLinkedSupplierVoucherTx,
  supplierVoucherConflict,
  supplierVoucherReceiptId,
  supplierVoucherSignature,
  SUPPLIER_VOUCHER_REQUEST_PREFIX,
  SUPPLIER_VOUCHER_REQUEST_CAPABILITY,
} from "../voucher/supplierPaymentLink";
import {
  assertExpectedVersion,
  assertIndependentPurchaseReviewer,
  usdReturnAmountWithFinalResidual,
} from "./returnGovernance";
import {
  supplierPaymentRefundTrigger,
  supplierPaymentTrigger,
} from "@shared/approvalTriggers";
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { payloadHashMatches } from "../idempotency";
import {
  loadPurchaseSettlements,
  loadPurchasePaymentEvidenceCases,
} from "./settlementProjection";
import {
  cumulativeCurrencyDelta,
  INVOICE_CURRENCY_SETTLEMENT,
  supplierVoucherCurrencyAmount,
  usesInvoiceCurrencySettlement,
} from "./supplierVoucherCurrency";
import {
  assertPurchaseCardAccountTx,
  purchaseTenderError,
  readPurchaseTenderTx,
} from "./tender";
import { applyPurchasePriorPaymentInTx } from "./priorPayment";

type Method = "CASH" | "CARD" | "TRANSFER" | "WALLET";
const AUTO_PURCHASE_PAYMENT_PREFIX = "auto-cash-po:";
type CashSourceInput = { mode: "DRAWER" | "TREASURY"; shiftId?: number | null };
type CashSource = {
  mode: "DRAWER" | "TREASURY";
  shiftId: number | null;
  payerUserId: number;
};
type StoredCashRequest = Pick<
  typeof supplierPaymentRequests.$inferSelect,
  | "payloadCanonical"
  | "payloadHash"
  | "requestedBy"
  | "branchId"
  | "paymentMethod"
>;
type RefundCashSource = Omit<CashSource, "payerUserId"> & {
  receiverUserId: number;
};

function refundCashSource(
  source: CashSource | null | undefined,
): RefundCashSource | null | undefined {
  return source == null
    ? source
    : {
        mode: source.mode,
        shiftId: source.shiftId,
        receiverUserId: source.payerUserId,
      };
}
export const SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY = Symbol(
  "supplier-payment-treasury-decision",
);
export type SupplierPaymentTreasuryDecisionCapability =
  typeof SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY;

export function assertSupplierPaymentTreasuryDecisionAuthority(
  actor: Actor,
  capability?: SupplierPaymentTreasuryDecisionCapability,
): void {
  if (
    actor.role === "admin" ||
    actor.role === "manager" ||
    actor.role === "accountant" ||
    capability === SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY
  ) {
    return;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      "قرار سداد المورد أو استرداده يتطلب صلاحية الخزينة الكاملة؛ صلاحية المشتريات وحدها لا تكفي",
  });
}
type Evidence =
  | "PAYMENT_ORDER"
  | "BANK_ADVICE"
  | "TRANSFER_RECEIPT"
  | "CASH_ACKNOWLEDGEMENT"
  | "DOCUMENT_IMAGE"
  | "PDF"
  | "OTHER";

export interface RequestSupplierPaymentInput {
  supplierId: number;
  branchId: number;
  requestKey: string;
  currency: "IQD" | "USD";
  exchangeRate?: string | null;
  amount: string;
  currencyAmount: string;
  paymentMethod: Method;
  cashSource?: CashSourceInput | null;
  externalReference?: string | null;
  evidenceType: Evidence;
  evidenceReference: string;
  reason: string;
  allocations: Array<{
    supplierInvoiceId: number;
    invoiceVersion: number;
    amount: string;
    currencyAmount: string;
  }>;
}

export interface DecideSupplierPaymentInput {
  requestId: number;
  decisionKey: string;
  action: "APPROVE" | "REJECT";
  reviewReason: string;
}

export interface RequestSupplierPaymentRefundInput {
  supplierPaymentId: number;
  expectedPaymentVersion: number;
  requestKey: string;
  refundMethod: Method;
  cashSource?: CashSourceInput | null;
  externalReference?: string | null;
  evidenceType:
    | "SUPPLIER_ACKNOWLEDGEMENT"
    | "BANK_ADVICE"
    | "TRANSFER_RECEIPT"
    | "CASH_RECEIPT"
    | "DOCUMENT_IMAGE"
    | "PDF"
    | "OTHER";
  evidenceReference: string;
  reason: string;
  allocations: Array<{
    supplierPaymentAllocationId: number;
    amount: string;
    currencyAmount: string;
  }>;
}

export interface DecideSupplierPaymentRefundInput {
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
  const result = value?.trim() ?? "";
  if (!result)
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب` });
  if (result.length > max)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} يتجاوز ${max} محرفاً`,
    });
  return result;
}

function uniqueIds(ids: number[], label: string): void {
  const set = new Set<number>();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${label} غير صالح`,
      });
    if (set.has(id))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `لا يجوز تكرار ${label}`,
      });
    set.add(id);
  }
}

export function assertPaymentTotals(
  amount: string,
  currencyAmount: string,
  allocations: Array<{ amount: string; currencyAmount: string }>,
): void {
  const total = round2(amount);
  const currencyTotal = round2(currencyAmount);
  if (!total.gt(0) || !currencyTotal.gt(0))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مبلغ الدفعة يجب أن يكون موجباً",
    });
  if (
    !round2(sumMoney(allocations.map((row) => row.amount))).eq(total) ||
    !round2(sumMoney(allocations.map((row) => row.currencyAmount))).eq(
      currencyTotal,
    )
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مجموع تخصيصات الدفعة لا يساوي رأس الدفعة",
    });
  }
}

/**
 * Currency amounts are source-of-truth amounts.  The IQD book value may differ
 * only by the final 2-decimal rounding of currencyAmount * agreedRate.
 */
export function assertAgreedRateAmount(
  amountIqd: string | number | Decimal,
  currencyAmount: string | number | Decimal,
  agreedRate: string | number | Decimal | null | undefined,
  label: string,
): void {
  const rate = money(agreedRate);
  if (
    !rate.gt(0) ||
    !round2(money(currencyAmount).times(rate)).eq(round2(amountIqd))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label}: مبلغ IQD لا يساوي مبلغ العملة × سعر الصرف المتفق عليه`,
    });
  }
}

export function effectiveInvoicePayable(
  invoiceTotal: string | number | Decimal,
  netCreditReturns: string | number | Decimal,
): ReturnType<typeof money> {
  const effective = round2(money(invoiceTotal).minus(netCreditReturns));
  return effective.isNegative() ? money(0) : effective;
}

export function assertSupplierInvoicePayable(invoice: {
  status: string;
  paymentGate: string;
  liabilityClass: string;
  legacySettlementEvidenceHash?: string | null;
}): void {
  if (invoice.status !== "POSTED" || invoice.paymentGate !== "OPEN")
    throw new TRPCError({
      code: "CONFLICT",
      message: "فاتورة المورد ليست POSTED مؤهلة للدفع",
    });
  if (
    !(["NATIVE_AP", "LEGACY_AP"] as const).includes(
      invoice.liabilityClass as "NATIVE_AP" | "LEGACY_AP",
    )
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "الفاتورة ليست التزام AP صالحاً؛ مسار CASH_CLEARING أو UNKNOWN محظور",
    });
  }
  if (
    invoice.liabilityClass === "LEGACY_AP" &&
    !invoice.legacySettlementEvidenceHash
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "فاتورة AP الإرثية بلا دليل تسوية مادي",
    });
  }
}

function decisionPayloadHash(
  requestId: number,
  action: string,
  reviewReason: string,
): string {
  return sha256(stableCanonical({ requestId, action, reviewReason }));
}

export function sortedUniquePurchaseOrderIds(ids: number[]): number[] {
  return Array.from(
    new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0)),
  ).sort((a, b) => a - b);
}

export async function resolveInvoicePurchaseOrderIds(
  tx: Tx,
  invoiceIds: number[],
): Promise<number[]> {
  const [legacy, matched, declared] = await Promise.all([
    tx
      .select({ id: supplierInvoices.legacyPurchaseOrderId })
      .from(supplierInvoices)
      .where(inArray(supplierInvoices.id, invoiceIds)),
    tx
      .select({ id: purchaseOrderItems.purchaseOrderId })
      .from(supplierInvoiceMatchAllocations)
      .innerJoin(
        supplierInvoiceMatchRuns,
        eq(
          supplierInvoiceMatchRuns.id,
          supplierInvoiceMatchAllocations.matchRunId,
        ),
      )
      .innerJoin(
        goodsReceiptItems,
        eq(
          goodsReceiptItems.id,
          supplierInvoiceMatchAllocations.goodsReceiptItemId,
        ),
      )
      .innerJoin(
        purchaseOrderItems,
        eq(purchaseOrderItems.id, goodsReceiptItems.purchaseOrderItemId),
      )
      .where(inArray(supplierInvoiceMatchRuns.supplierInvoiceId, invoiceIds)),
    tx
      .select({ id: purchaseOrderRevisions.purchaseOrderId })
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
      .where(inArray(supplierInvoiceLines.supplierInvoiceId, invoiceIds)),
  ]);
  return sortedUniquePurchaseOrderIds([
    ...legacy.map((row) => Number(row.id ?? 0)),
    ...matched.map((row) => Number(row.id)),
    ...declared.map((row) => Number(row.id)),
  ]);
}

/** Canonical financial aggregate lock order: PO ids asc -> supplier -> invoices asc. */
export async function lockPaymentAggregate(
  tx: Tx,
  supplierId: number,
  invoiceIds: number[],
) {
  const sortedInvoiceIds = sortedUniquePurchaseOrderIds(invoiceIds);
  const poIds = await resolveInvoicePurchaseOrderIds(tx, sortedInvoiceIds);
  const orders = poIds.length
    ? await tx
        .select()
        .from(purchaseOrders)
        .where(inArray(purchaseOrders.id, poIds))
        .orderBy(asc(purchaseOrders.id))
        .for("update")
    : [];
  const supplier = (
    await tx
      .select()
      .from(suppliers)
      .where(eq(suppliers.id, supplierId))
      .for("update")
      .limit(1)
  )[0];
  const invoices = await tx
    .select()
    .from(supplierInvoices)
    .where(inArray(supplierInvoices.id, sortedInvoiceIds))
    .orderBy(asc(supplierInvoices.id))
    .for("update");
  return { supplier, invoices, orders };
}

export async function assertNativePurchaseSettlementEvidence(
  tx: Tx,
  aggregate: Awaited<ReturnType<typeof lockPaymentAggregate>>,
): Promise<void> {
  const evidenceCases = await loadPurchasePaymentEvidenceCases(
    tx,
    aggregate.orders.map((order) => Number(order.id)),
    aggregate.invoices.map((invoice) => Number(invoice.id)),
    true,
  );
  if (evidenceCases.length)
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر طلب أو اعتماد سداد المورد",
        why: `السداد السابق غير محسوم في قضية ${evidenceCases[0].caseNumber}`,
        doThis:
          "أكمل المطابقة المحكومة لسندات الدفع وكشف المورد قبل أي صرف جديد",
      }),
    });
  if (
    !aggregate.invoices.some(
      (invoice) => invoice.liabilityClass === "NATIVE_AP",
    )
  )
    return;
  const settlements = await loadPurchaseSettlements(tx, aggregate.orders, {
    currentRead: true,
  });
  const ambiguous = aggregate.orders.find(
    (order) => settlements.get(Number(order.id))?.requiresReview,
  );
  if (ambiguous) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر طلب أو اعتماد سداد المورد",
        why: `دليل تسوية أمر الشراء ${ambiguous.poNumber} لا يطابق المدفوع المسجل أو لا يثبت تخصيصه`,
        doThis:
          "افتح قضية نزاهة شراء وأكمل المراجعة المحكومة لدليل الدفع قبل أي صرف جديد؛ لا تعِد الدفع لتصحيح العرض",
      }),
    });
  }
}

async function accountingEntryId(tx: Tx, dedupeKey: string): Promise<number> {
  const row = (
    await tx
      .select({ id: accountingEntries.id })
      .from(accountingEntries)
      .where(eq(accountingEntries.dedupeKey, dedupeKey))
      .limit(1)
  )[0];
  if (!row) throw new Error(`accounting entry missing: ${dedupeKey}`);
  return Number(row.id);
}

function cashSourceError(
  why: string,
  code:
    | "BAD_REQUEST"
    | "FORBIDDEN"
    | "PRECONDITION_FAILED"
    | "CONFLICT" = "PRECONDITION_FAILED",
) {
  return new TRPCError({
    code,
    message: appErrorMessage({
      what: "تعذّر استخدام مصدر نقد المورد",
      why,
      doThis:
        "أعد تقديمه بمصدر نقد صريح وصحيح؛ وارفض الطلب المعلّق السابق إن وجد",
    }),
  });
}

async function treasurySourceAllowed(tx: Tx, actor: Actor): Promise<boolean> {
  // Listing the maker's own drawers is an input dependency, not treasury
  // custody. Treasury remains tied to the independent approval operation.
  const canonical = canonicalOperationAllowed(
    await loadOperationUserTx(tx, actor.userId),
    "supplierPayments.decidePayment",
  );
  if (canonical !== undefined) return canonical;
  const [user] = await tx
    .select()
    .from(users)
    .where(eq(users.id, actor.userId))
    .for("share")
    .limit(1);
  if (!user?.isActive) return false;
  if (user.isOwner) return true;
  let role = user.role as RoleKey;
  let override = user.permissionsOverride as PermissionMap | null;
  if (user.customRoleId != null) {
    const [custom] = await tx
      .select()
      .from(roles)
      .where(eq(roles.id, user.customRoleId))
      .for("share")
      .limit(1);
    if (!custom?.isActive) return false;
    role = custom.baseRole as RoleKey;
    const effective = applyPermissionOverrides(
      resolvePermissions(
        role,
        diffFromTemplate(role, custom.permissions as PermissionMap),
      ),
      override,
    );
    override = diffFromTemplate(role, effective);
  }
  return moduleAccessAllowed(role, override, "treasury", "FULL", [
    "manager",
    "accountant",
  ]);
}

async function validateDrawerSource(
  tx: Tx,
  source: CashSource,
  branchId: number,
) {
  const [shift] = await tx
    .select({
      id: shifts.id,
      branchId: shifts.branchId,
      userId: shifts.userId,
      status: shifts.status,
    })
    .from(shifts)
    .where(eq(shifts.id, source.shiftId!))
    .for("update")
    .limit(1);
  if (!shift || shift.status !== "OPEN")
    throw cashSourceError(
      "درج مقدم الطلب المسجّل غير موجود أو ورديته مغلقة؛ لا يُستبدل بدرج جديد",
    );
  if (Number(shift.branchId) !== branchId)
    throw cashSourceError("الدرج المسجّل يعود إلى فرع مختلف", "BAD_REQUEST");
  if (Number(shift.userId) !== source.payerUserId)
    throw cashSourceError("الدرج المسجّل يعود إلى مستخدم آخر", "FORBIDDEN");
}

async function captureCashSource(
  tx: Tx,
  method: Method,
  input: CashSourceInput | null | undefined,
  branchId: number,
  actor: Actor,
  deferredVoucherTreasuryRequest = false,
): Promise<CashSource | null> {
  if (method !== "CASH") {
    if (input != null)
      throw cashSourceError(
        "الحركة غير النقدية لا تقبل مصدر درج أو خزينة",
        "BAD_REQUEST",
      );
    return null;
  }
  const mode = input?.mode ?? "DRAWER";
  if (mode === "TREASURY") {
    if (input?.shiftId != null)
      throw cashSourceError("مصدر الخزينة لا يقبل رقم وردية", "BAD_REQUEST");
    if (
      !deferredVoucherTreasuryRequest &&
      !(await treasurySourceAllowed(tx, actor))
    )
      throw cashSourceError(
        "اختيار الخزينة يتطلب صلاحية الخزينة الكاملة",
        "FORBIDDEN",
      );
    return { mode, shiftId: null, payerUserId: actor.userId };
  }
  if (mode !== "DRAWER")
    throw cashSourceError("نوع مصدر النقد غير صالح", "BAD_REQUEST");
  const shiftId =
    input?.shiftId ?? (await openShiftIdTx(tx, actor.userId, branchId));
  if (!Number.isSafeInteger(shiftId) || Number(shiftId) <= 0)
    throw cashSourceError(
      "لا توجد وردية مفتوحة لمقدم الطلب؛ اختيار الخزينة يجب أن يكون صريحاً",
    );
  const source: CashSource = {
    mode,
    shiftId: Number(shiftId),
    payerUserId: actor.userId,
  };
  await validateDrawerSource(tx, source, branchId);
  return source;
}

function storedCashSource(
  request: StoredCashRequest,
  allowLegacy = false,
  methodField: "paymentMethod" | "refundMethod" = "paymentMethod",
): CashSource | null | undefined {
  let payload: {
    cashSource?:
      | (Omit<CashSource, "payerUserId"> & {
          payerUserId?: number;
          receiverUserId?: number;
        })
      | null;
    branchId?: number;
    paymentMethod?: Method;
    refundMethod?: Method;
  };
  try {
    payload = JSON.parse(request.payloadCanonical);
  } catch {
    throw cashSourceError("دليل مصدر النقد غير قابل للقراءة", "CONFLICT");
  }
  if (
    !payload ||
    !payloadHashMatches(
      sha256(request.payloadCanonical),
      request.payloadHash,
    ) ||
    ((methodField === "paymentMethod" || payload.cashSource !== undefined) &&
      Number(payload.branchId) !== Number(request.branchId)) ||
    payload[methodField] !== request.paymentMethod
  )
    throw cashSourceError(
      "بصمة الطلب أو بيانات مصدر النقد لا تطابق الطلب المحفوظ",
      "CONFLICT",
    );
  const source = payload.cashSource;
  if (source === undefined && (allowLegacy || request.paymentMethod !== "CASH"))
    return undefined;
  if (request.paymentMethod !== "CASH") {
    if (source != null)
      throw cashSourceError("طلب غير نقدي يحمل مصدر نقد", "CONFLICT");
    return null;
  }
  if (!source) throw cashSourceError("طلب نقدي قديم بلا مصدر نقد محدّد");
  const userId =
    methodField === "refundMethod" ? source.receiverUserId : source.payerUserId;
  if (
    userId !== Number(request.requestedBy) ||
    !["DRAWER", "TREASURY"].includes(source.mode) ||
    (source.mode === "DRAWER"
      ? !Number.isSafeInteger(source.shiftId) || Number(source.shiftId) <= 0
      : source.shiftId !== null)
  )
    throw cashSourceError(
      "مصدر النقد المحفوظ لا يطابق هوية مقدم الطلب أو نوع المصدر",
      "CONFLICT",
    );
  return { mode: source.mode, shiftId: source.shiftId, payerUserId: userId! };
}

async function lockRequestedPaymentInstrument(
  tx: Tx,
  request: StoredCashRequest,
  reviewer: Actor,
  direction: "IN" | "OUT" = "OUT",
  methodField: "paymentMethod" | "refundMethod" = "paymentMethod",
) {
  const source = storedCashSource(request, false, methodField);
  if (!source)
    return { shiftId: null, cashBucket: null, treasuryApproval: null };
  const branchId = Number(request.branchId);
  if (source.mode === "TREASURY" && direction === "OUT") {
    const treasuryApproval = await authorizeExternalTreasuryDisbursement(tx, {
      actor: reviewer,
      makerUserIds: [request.requestedBy],
      branchIds: [branchId],
      operation: "دفع مورد",
    });
    return { shiftId: null, cashBucket: "TREASURY" as const, treasuryApproval };
  }
  if (source.mode === "DRAWER")
    await validateDrawerSource(tx, source, branchId);
  await lockCashSourceForUpdate(tx, {
    branchId,
    shiftId: source.shiftId,
    cashBucket: source.mode,
  });
  return {
    shiftId: source.shiftId,
    cashBucket: source.mode,
    treasuryApproval: null,
  };
}

export async function listSupplierPaymentCashSources(
  branchId: number,
  actor: Actor,
) {
  assertPurchaseBranch({ branchId }, actor);
  return withTx(
    async (tx) => {
      const canonical = canonicalOperationAllowed(
        await loadOperationUserTx(tx, actor.userId),
        "supplierPayments.cashSources",
      );
      if (canonical === false) {
        throw cashSourceError(
          "لا تملك صلاحية عرض مصادر سداد المورد",
          "FORBIDDEN",
        );
      }
      return {
        drawers: await tx
          .select({ id: shifts.id, shiftType: shifts.shiftType })
          .from(shifts)
          .where(
            and(
              eq(shifts.branchId, branchId),
              eq(shifts.userId, actor.userId),
              eq(shifts.status, "OPEN"),
            ),
          )
          .orderBy(asc(shifts.id)),
        canUseTreasury: await treasurySourceAllowed(tx, actor),
      };
    },
    { gate: "NONE" },
  );
}

export async function invoiceReservations(
  tx: Tx,
  invoiceIds: number[],
  lockRows = true,
) {
  const postedQuery = tx
    .select({
      invoiceId: supplierPaymentAllocations.supplierInvoiceId,
      amount: sql<string>`COALESCE(SUM(${supplierPaymentAllocations.allocatedAmount} - ${supplierPaymentAllocations.refundedAmount}),0)`,
      currencyAmount: sql<string>`COALESCE(SUM(${supplierPaymentAllocations.allocatedCurrencyAmount} - ${supplierPaymentAllocations.refundedCurrencyAmount}),0)`,
    })
    .from(supplierPaymentAllocations)
    .where(inArray(supplierPaymentAllocations.supplierInvoiceId, invoiceIds))
    .groupBy(supplierPaymentAllocations.supplierInvoiceId);
  const posted = await (lockRows ? postedQuery.for("update") : postedQuery);
  const pendingQuery = tx
    .select({
      invoiceId: supplierPaymentRequestAllocations.supplierInvoiceId,
      amount: sql<string>`COALESCE(SUM(${supplierPaymentRequestAllocations.requestedAmount}),0)`,
      currencyAmount: sql<string>`COALESCE(SUM(${supplierPaymentRequestAllocations.requestedCurrencyAmount}),0)`,
    })
    .from(supplierPaymentRequestAllocations)
    .innerJoin(
      supplierPaymentRequests,
      eq(
        supplierPaymentRequests.id,
        supplierPaymentRequestAllocations.requestId,
      ),
    )
    .where(
      and(
        eq(supplierPaymentRequests.status, "PENDING"),
        inArray(
          supplierPaymentRequestAllocations.supplierInvoiceId,
          invoiceIds,
        ),
      ),
    )
    .groupBy(supplierPaymentRequestAllocations.supplierInvoiceId);
  const pending = await (lockRows ? pendingQuery.for("update") : pendingQuery);
  const formalCredits = await loadSupplierFormalCreditTotals(tx, invoiceIds, {
    currentRead: lockRows,
  });
  const book = await loadSupplierBookInvoiceTotals(tx, invoiceIds, {
    currentRead: lockRows,
  });
  const postedTotals = new Map(
    posted.map((row) => [
      Number(row.invoiceId),
      { amount: money(row.amount), currencyAmount: money(row.currencyAmount) },
    ]),
  );
  const creditTotals = new Map(
    Array.from(formalCredits, ([id, amount]) => [id, money(amount)]),
  );
  const creditCurrencyAmounts = new Map<number, ReturnType<typeof money>>();
  const invoiceQuery = tx
    .select({
      id: supplierInvoices.id,
      currency: supplierInvoices.currency,
      usdTotal: supplierInvoices.usdTotal,
      totalAmount: supplierInvoices.totalAmount,
    })
    .from(supplierInvoices)
    .where(inArray(supplierInvoices.id, invoiceIds));
  const invoices = invoiceIds.length
    ? await (lockRows ? invoiceQuery.for("share") : invoiceQuery)
    : [];
  for (const invoice of invoices) {
    const credit = creditTotals.get(Number(invoice.id)) ?? money(0);
    creditCurrencyAmounts.set(
      Number(invoice.id),
      invoice.currency === "USD"
        ? usdReturnAmountWithFinalResidual(
            invoice.usdTotal,
            invoice.totalAmount,
            credit,
            0,
          )
        : credit,
    );
  }
  for (const [id, totals] of Array.from(book)) {
    const native = postedTotals.get(id);
    postedTotals.set(id, {
      amount: money(native?.amount).plus(totals.paidAmount),
      currencyAmount: money(native?.currencyAmount).plus(
        totals.paidCurrencyAmount,
      ),
    });
    creditTotals.set(
      id,
      money(creditTotals.get(id)).plus(totals.creditedAmount),
    );
    creditCurrencyAmounts.set(
      id,
      money(creditCurrencyAmounts.get(id)).plus(totals.creditedCurrencyAmount),
    );
  }
  return {
    posted: postedTotals,
    creditCurrencyAmounts,
    pending: new Map(
      pending.map((row) => [
        Number(row.invoiceId),
        {
          amount: money(row.amount),
          currencyAmount: money(row.currencyAmount),
        },
      ]),
    ),
    creditReturns: creditTotals,
  };
}

function legacyCurrencySettled(invoice: typeof supplierInvoices.$inferSelect) {
  if (invoice.currency === "IQD") return money(invoice.legacySettledAmount);
  const rate = money(invoice.agreedRate);
  return rate.gt(0)
    ? round2(money(invoice.legacySettledAmount).dividedBy(rate))
    : money(0);
}

function assertAllocationAvailable(
  invoice: typeof supplierInvoices.$inferSelect,
  requested: { amount: string; currencyAmount: string },
  used: {
    amount: ReturnType<typeof money>;
    currencyAmount: ReturnType<typeof money>;
  },
  netCreditReturns: ReturnType<typeof money>,
  creditCurrencyAmount?: ReturnType<typeof money>,
): void {
  const effectiveTotal = effectiveInvoicePayable(
    invoice.totalAmount,
    netCreditReturns,
  );
  const remaining = round2(
    effectiveTotal.minus(invoice.legacySettledAmount).minus(used.amount),
  );
  const sourceCurrencyTotal =
    invoice.currency === "USD"
      ? money(invoice.usdTotal).minus(
          creditCurrencyAmount ??
            usdReturnAmountWithFinalResidual(
              invoice.usdTotal,
              invoice.totalAmount,
              netCreditReturns,
              0,
            ),
        )
      : effectiveTotal;
  const remainingCurrency = round2(
    sourceCurrencyTotal
      .minus(legacyCurrencySettled(invoice))
      .minus(used.currencyAmount),
  );
  if (
    money(requested.amount).gt(remaining) ||
    money(requested.currencyAmount).gt(remainingCurrency)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `تخصيص الدفعة يتجاوز المتبقي في فاتورة المورد ${invoice.invoiceNumber}`,
    });
  }
}

export async function requestSupplierPaymentInTx(
  tx: Tx,
  input: RequestSupplierPaymentInput,
  actor: Actor,
  voucherCapabilityOrOptions?:
    | typeof SUPPLIER_VOUCHER_REQUEST_CAPABILITY
    | { pendingGuardOverride?: string },
) {
  const voucherCapability =
    voucherCapabilityOrOptions === SUPPLIER_VOUCHER_REQUEST_CAPABILITY
      ? voucherCapabilityOrOptions
      : undefined;
  const options =
    voucherCapabilityOrOptions && typeof voucherCapabilityOrOptions === "object"
      ? voucherCapabilityOrOptions
      : undefined;
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120);
  const voucherReceiptId = supplierVoucherReceiptId(requestKey);
  const deferredVoucher =
    voucherReceiptId != null &&
    voucherCapability === SUPPLIER_VOUCHER_REQUEST_CAPABILITY;
  if (voucherReceiptId != null && !deferredVoucher)
    throw supplierVoucherConflict(
      "ربط تخصيص الفواتير بالسند يتطلب مسار سند الصرف الداخلي",
    );
  if (deferredVoucher) {
    const [receipt] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, voucherReceiptId!))
      .limit(1);
    if (
      !receipt ||
      receipt.createdBy !== actor.userId ||
      receipt.direction !== "OUT" ||
      receipt.partyType !== "SUPPLIER" ||
      receipt.partyId !== input.supplierId ||
      receipt.branchId !== input.branchId ||
      receipt.paymentMethod !== input.paymentMethod ||
      !money(receipt.amount).eq(input.amount) ||
      receipt.status !== "PENDING" ||
      receipt.approvalStatus !== "PENDING_APPROVAL"
    )
      throw supplierVoucherConflict(
        "طلب التخصيص الداخلي لا يطابق سند الصرف المعلق",
      );
  }
  const reason = required(input.reason, "سبب الدفع", 500);
  const evidenceReference = required(
    input.evidenceReference,
    "مرجع الدليل",
    500,
  );
  const externalReference = input.externalReference?.trim() || null;
  if (input.paymentMethod !== "CASH" && !externalReference)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مرجع أداة الدفع مطلوب للدفع غير النقدي",
    });
  if (!input.allocations.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أضف تخصيص فاتورة واحداً على الأقل",
    });
  uniqueIds(
    input.allocations.map((row) => row.supplierInvoiceId),
    "فاتورة المورد",
  );
  const normalized = [...input.allocations]
    .map((row) => ({
      ...row,
      amount: toDbMoney(row.amount),
      currencyAmount: toDbMoney(row.currencyAmount),
    }))
    .sort((a, b) => a.supplierInvoiceId - b.supplierInvoiceId);
  const replay = (
    await tx
      .select()
      .from(supplierPaymentRequests)
      .where(eq(supplierPaymentRequests.requestKey, requestKey))
      .limit(1)
  )[0];
  // USD is the invoice denomination; every receipt and cash/AP book remains IQD.
  // A prior IQD allocation can leave a rounded USD residual whose exact IQD
  // balance is no longer USD * rate. Continue its proven cumulative book basis.
  const priorCurrencyPayments =
    !replay && input.currency === "USD"
      ? await tx
          .select({
            supplierInvoiceId: supplierPaymentAllocations.supplierInvoiceId,
            payloadCanonical: supplierPayments.payloadCanonical,
            payloadHash: supplierPayments.payloadHash,
          })
          .from(supplierPaymentAllocations)
          .innerJoin(
            supplierPayments,
            eq(
              supplierPayments.id,
              supplierPaymentAllocations.supplierPaymentId,
            ),
          )
          .where(
            inArray(
              supplierPaymentAllocations.supplierInvoiceId,
              normalized.map((row) => row.supplierInvoiceId),
            ),
          )
      : [];
  const priorBookTotals =
    !replay && input.currency === "USD"
      ? await loadSupplierBookInvoiceTotals(
          tx,
          normalized.map((row) => row.supplierInvoiceId),
          { currentRead: true },
        )
      : new Map();
  const continuedInvoiceIds: number[] = replay
    ? (JSON.parse(replay.payloadCanonical).continuedInvoiceIds ?? [])
    : Array.from(
        new Set([
          ...Array.from(priorBookTotals)
            .filter(
              ([, totals]) =>
                money(totals.paidAmount).gt(0) ||
                money(totals.creditedAmount).gt(0),
            )
            .map(([id]) => id),
          ...priorCurrencyPayments
            .filter((row) => {
              if (!usesInvoiceCurrencySettlement(row)) return false;
              const original = JSON.parse(row.payloadCanonical);
              return (
                original.currency === "IQD" ||
                original.continuedInvoiceIds?.includes(
                  Number(row.supplierInvoiceId),
                )
              );
            })
            .map((row) => Number(row.supplierInvoiceId)),
        ]),
      ).sort((a, b) => a - b);
  const invoiceCurrencySettlement = replay
    ? usesInvoiceCurrencySettlement(replay)
    : (deferredVoucher && input.currency === "IQD") ||
      continuedInvoiceIds.length > 0;
  assertPaymentTotals(
    input.amount,
    input.currencyAmount,
    invoiceCurrencySettlement && input.currency === "IQD"
      ? normalized.map((row) => ({ ...row, currencyAmount: row.amount }))
      : normalized,
  );
  const amount = toDbMoney(input.amount);
  const currencyAmount = toDbMoney(input.currencyAmount);
  const rate =
    input.currency === "USD" ? money(input.exchangeRate).toFixed(4) : null;
  if (input.currency === "USD" && !money(rate).gt(0))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سعر الصرف مطلوب للدفع بالدولار",
    });
  if (input.currency === "USD" && !invoiceCurrencySettlement)
    assertAgreedRateAmount(amount, currencyAmount, rate, "رأس دفعة المورد");
  if (
    input.currency === "IQD" &&
    (!money(amount).eq(currencyAmount) || input.exchangeRate != null)
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "دفعة IQD لا تقبل سعر صرف ويجب تطابق مبلغيها",
    });
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  if (replay) {
    assertPurchaseBranch(replay, actor);
    if (Number(replay.requestedBy) !== actor.userId)
      throw cashSourceError("مفتاح الطلب يعود إلى دافع آخر", "FORBIDDEN");
  }
  const cashSource = replay
    ? storedCashSource(replay, true)
    : await captureCashSource(
        tx,
        input.paymentMethod,
        input.cashSource,
        input.branchId,
        actor,
        deferredVoucher,
      );
  if (input.paymentMethod !== "CASH" && input.cashSource != null)
    throw cashSourceError("الدفع غير النقدي لا يقبل مصدر نقد", "BAD_REQUEST");
  if (
    replay &&
    input.cashSource != null &&
    (!cashSource ||
      input.cashSource.mode !== cashSource.mode ||
      (input.cashSource.shiftId != null &&
        input.cashSource.shiftId !== cashSource.shiftId))
  )
    throw cashSourceError("مفتاح الطلب مستعمل بمصدر نقد مختلف", "CONFLICT");
  const canonical = stableCanonical({
    ...(invoiceCurrencySettlement
      ? {
          allocationCurrency: INVOICE_CURRENCY_SETTLEMENT,
          ...(input.currency === "USD" ? { continuedInvoiceIds } : {}),
        }
      : {}),
    supplierId: input.supplierId,
    branchId: input.branchId,
    currency: input.currency,
    exchangeRate: rate,
    amount,
    currencyAmount,
    paymentMethod: input.paymentMethod,
    ...(cashSource === undefined ? {} : { cashSource }),
    externalReference,
    evidenceType: input.evidenceType,
    evidenceReference,
    reason,
    allocations: normalized,
  });
  const payloadHash = sha256(canonical);
  const evidenceHash = sha256(
    stableCanonical({ type: input.evidenceType, reference: evidenceReference }),
  );
  if (replay) {
    assertPurchaseBranch(replay, actor);
    if (!payloadHashMatches(payloadHash, replay.payloadHash))
      throw new TRPCError({
        code: "CONFLICT",
        message: "مفتاح الطلب مستعمل بدفعة مختلفة",
      });
    return {
      requestId: Number(replay.id),
      status: replay.status,
      idempotent: true as const,
    };
  }
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  const ids = normalized.map((row) => row.supplierInvoiceId);
  const aggregate = await lockPaymentAggregate(tx, input.supplierId, ids);
  const { supplier, invoices } = aggregate;
  if (!supplier || !supplier.isActive)
    throw new TRPCError({
      code: "CONFLICT",
      message: "المورد غير موجود أو غير نشط",
    });
  if (invoices.length !== ids.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "بعض فواتير المورد غير موجودة",
    });
  const [pendingBookVoucher] = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .innerJoin(
      auditLogs,
      and(
        eq(auditLogs.action, "supplier.bookVoucher.request"),
        eq(auditLogs.entityType, "receipt"),
        sql`BINARY ${auditLogs.entityId} = BINARY CAST(${receipts.id} AS CHAR)`,
      ),
    )
    .where(
      and(
        eq(receipts.partyType, "SUPPLIER"),
        eq(receipts.partyId, input.supplierId),
        eq(receipts.direction, "OUT"),
        eq(receipts.status, "PENDING"),
        eq(receipts.approvalStatus, "PENDING_APPROVAL"),
      ),
    )
    .for("share")
    .limit(1);
  if (pendingBookVoucher)
    throw supplierVoucherConflict(
      "يوجد سند تسوية دفترية معلق يحجز رصيد المورد؛ احسمه قبل طلب سداد جديد",
    );
  await assertNativePurchaseSettlementEvidence(tx, aggregate);
  const invoiceById = new Map(invoices.map((row) => [Number(row.id), row]));
  const reservations = await invoiceReservations(tx, ids);
  const rows = normalized.map((allocation) => {
    const invoice = invoiceById.get(allocation.supplierInvoiceId)!;
    assertPurchaseBranch(invoice, actor);
    assertSupplierInvoicePayable(invoice);
    assertExpectedVersion(
      Number(invoice.version),
      allocation.invoiceVersion,
      "فاتورة المورد",
    );
    if (
      Number(invoice.supplierId) !== input.supplierId ||
      Number(invoice.branchId) !== input.branchId ||
      (!(deferredVoucher && input.currency === "IQD") &&
        invoice.currency !== input.currency)
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الفاتورة لا تطابق المورد أو الفرع أو العملة",
      });
    if (input.currency === "USD") {
      if (
        !money(invoice.agreedRate)
          .toDecimalPlaces(4)
          .eq(money(rate).toDecimalPlaces(4))
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يجوز جمع فواتير بأسعار صرف مختلفة في دفعة واحدة",
        });
      if (!continuedInvoiceIds.includes(Number(invoice.id)))
        assertAgreedRateAmount(
          allocation.amount,
          allocation.currencyAmount,
          invoice.agreedRate,
          `تخصيص الفاتورة ${invoice.invoiceNumber}`,
        );
    }
    const posted = reservations.posted.get(allocation.supplierInvoiceId) ?? {
      amount: money(0),
      currencyAmount: money(0),
    };
    const pending = reservations.pending.get(allocation.supplierInvoiceId) ?? {
      amount: money(0),
      currencyAmount: money(0),
    };
    const creditReturns =
      reservations.creditReturns.get(allocation.supplierInvoiceId) ?? money(0);
    if (
      invoiceCurrencySettlement &&
      (input.currency === "IQD" ||
        continuedInvoiceIds.includes(Number(invoice.id))) &&
      !money(allocation.currencyAmount).eq(
        supplierVoucherCurrencyAmount(
          invoice,
          allocation.amount,
          {
            amount: toDbMoney(posted.amount.plus(pending.amount)),
            currencyAmount: toDbMoney(
              posted.currencyAmount.plus(pending.currencyAmount),
            ),
          },
          toDbMoney(creditReturns),
          toDbMoney(
            reservations.creditCurrencyAmounts.get(Number(invoice.id)) ?? 0,
          ),
        ),
      )
    )
      throw supplierVoucherConflict(
        "تغيّر رصيد عملة الفاتورة؛ أعد توزيع السند",
      );
    assertAllocationAvailable(
      invoice,
      allocation,
      {
        amount: posted.amount.plus(pending.amount),
        currencyAmount: posted.currencyAmount.plus(pending.currencyAmount),
      },
      creditReturns,
      reservations.creditCurrencyAmounts.get(Number(invoice.id)),
    );
    const snapshot = stableCanonical({
      invoiceId: Number(invoice.id),
      invoiceNumber: invoice.invoiceNumber,
      version: Number(invoice.version),
      status: invoice.status,
      paymentGate: invoice.paymentGate,
      liabilityClass: invoice.liabilityClass,
      legacySettledAmount: invoice.legacySettledAmount,
      legacySettlementEvidenceHash: invoice.legacySettlementEvidenceHash,
      totalAmount: invoice.totalAmount,
      usdTotal: invoice.usdTotal,
      ...(invoiceCurrencySettlement
        ? { currency: invoice.currency, agreedRate: invoice.agreedRate }
        : {}),
    });
    return { allocation, snapshot, hash: sha256(snapshot) };
  });
  const inserted = await tx.insert(supplierPaymentRequests).values({
    requestKey,
    supplierId: input.supplierId,
    branchId: input.branchId,
    currency: input.currency,
    exchangeRate: rate,
    requestedAmount: amount,
    requestedCurrencyAmount: currencyAmount,
    paymentMethod: input.paymentMethod,
    externalReference,
    payloadCanonical: canonical,
    payloadHash,
    evidenceType: input.evidenceType,
    evidenceReference,
    evidenceHash,
    reason,
    pendingGuard:
      options?.pendingGuardOverride ??
      `SUPPLIER-PAY:${input.supplierId}:${input.branchId}:${input.currency}`,
    requestedBy: actor.userId,
  });
  const requestId = extractInsertId(inserted);
  await tx.insert(supplierPaymentRequestAllocations).values(
    rows.map(({ allocation, snapshot, hash }) => ({
      requestId,
      supplierInvoiceId: allocation.supplierInvoiceId,
      invoiceVersion: allocation.invoiceVersion,
      requestedAmount: allocation.amount,
      requestedCurrencyAmount: allocation.currencyAmount,
      invoiceSnapshot: snapshot,
      invoiceHash: hash,
    })),
  );
  return {
    requestId,
    status: "PENDING" as const,
    idempotent: false as const,
  };
}

/**
 * الغلاف العام لطلب سدادٍ صريح من المستخدم. القرار المالي الصادر في ٥/١٠/٢٦
 * يفصل اعتماد أمر الشراء عن وقوع الدفع؛ لذلك لا يستدعيه مسار اعتماد الأمر تلقائياً.
 * يبقى `requestSupplierPaymentInTx` متاحاً للمسارات التي تملك معاملةً قائمة فعلاً.
 */
export async function requestSupplierPayment(
  input: RequestSupplierPaymentInput,
  actor: Actor,
) {
  if (
    input.requestKey
      .trim()
      .toLowerCase()
      .startsWith(AUTO_PURCHASE_PAYMENT_PREFIX)
  ) {
    throw purchaseTenderError(
      "تعذر استخدام مفتاح التسوية التلقائية",
      "بادئة الطلب محجوزة للسداد الداخلي المرتبط بفاتورة الشراء",
    );
  }
  if (input.requestKey.trim().startsWith(SUPPLIER_VOUCHER_REQUEST_PREFIX))
    throw supplierVoucherConflict(
      "بادئة ربط سند المورد محجوزة لمسار سند الصرف",
    );
  const reason = required(input.reason, "سبب الدفع", 500);
  const result = await withTx((tx) =>
    requestSupplierPaymentInTx(tx, input, actor),
  );
  const approved = await autoDecideForActiveOwner(actor, {
    kind: "supplier.payment.decide",
    id: result.requestId,
    reason,
  });
  return approved ? { ...result, status: "APPROVED" as const } : result;
}

export async function decideSupplierPaymentInTx(
  tx: Tx,
  input: DecideSupplierPaymentInput,
  actor: Actor,
  capability?: SupplierPaymentTreasuryDecisionCapability,
) {
  assertSupplierPaymentTreasuryDecisionAuthority(actor, capability);
  const decisionKey = required(input.decisionKey, "مفتاح القرار", 120);
  const reviewReason = required(input.reviewReason, "سبب القرار", 500);
  const hash = decisionPayloadHash(input.requestId, input.action, reviewReason);
  const preview = (
    await tx
      .select()
      .from(supplierPaymentRequests)
      .where(eq(supplierPaymentRequests.id, input.requestId))
      .limit(1)
  )[0];
  if (!preview)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "طلب دفع المورد غير موجود",
    });
  assertPurchaseBranch(preview, actor);
  const instrument =
    input.action === "APPROVE" && preview.status === "PENDING"
      ? await lockRequestedPaymentInstrument(tx, preview, actor)
      : { shiftId: null, cashBucket: null, treasuryApproval: null };
  const previewAllocations =
    input.action === "APPROVE"
      ? await tx
          .select({
            supplierInvoiceId:
              supplierPaymentRequestAllocations.supplierInvoiceId,
          })
          .from(supplierPaymentRequestAllocations)
          .where(
            eq(supplierPaymentRequestAllocations.requestId, input.requestId),
          )
      : [];
  const aggregate =
    input.action === "APPROVE"
      ? await lockPaymentAggregate(
          tx,
          Number(preview.supplierId),
          previewAllocations.map((row) => Number(row.supplierInvoiceId)),
        )
      : {
          supplier: null,
          invoices: [] as Array<typeof supplierInvoices.$inferSelect>,
        };
  const request = (
    await tx
      .select()
      .from(supplierPaymentRequests)
      .where(eq(supplierPaymentRequests.id, input.requestId))
      .for("update")
      .limit(1)
  )[0]!;
  const linkedVoucher = await lockLinkedSupplierVoucherTx(tx, request);
  // سدادُ المورّد **خروجُ مال**، وهذه البوّابة هي التفويض الوحيد له: إيصال OUT مكتمل
  // بـcashBucket + حارسُ توفّرٍ + قفلُ مصدر النقد. ⇒ المالك حصراً.
  // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — كما في السندات (voucher/approval.ts)
  // بلا انتظار علَم ownerOnlyApproval؛ التفصيل هناك.
  assertApprover({
    actor: await (async () => {
      const resolved = await resolveApprovalActor(tx, actor);
      if (linkedVoucher && !resolved.isOwner)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر اعتماد أو رفض سند سداد المورد",
            why: "القرار محصور بحساب مالك نشط",
            doThis: "اطلب من مالك النظام مراجعة سند الصرف",
          }),
        });
      return resolved;
    })(),
    trigger: supplierPaymentTrigger(input.action),
    subject: `سداد مورّد (طلب ${input.requestId})`,
    legacy: () => {
      assertIndependentPurchaseReviewer(
        Number(request.requestedBy),
        actor.userId,
      );
    },
  });
  if (request.status !== "PENDING") {
    if (request.decisionKey === decisionKey && request.decisionHash === hash)
      return {
        requestId: input.requestId,
        status: request.status,
        supplierPaymentId: null,
        idempotent: true as const,
      };
    throw new TRPCError({
      code: "CONFLICT",
      message: "حُسم طلب الدفع مسبقاً",
    });
  }
  if (
    linkedVoucher &&
    (linkedVoucher.status !== "PENDING" ||
      linkedVoucher.approvalStatus !== "PENDING_APPROVAL")
  )
    throw supplierVoucherConflict(
      "سند الصرف المرتبط لم يعد طلباً معلقاً صالحاً للتنفيذ",
    );
  if (input.action === "REJECT") {
    await tx
      .update(supplierPaymentRequestAllocations)
      .set({ activeInvoiceGuard: null })
      .where(eq(supplierPaymentRequestAllocations.requestId, input.requestId));
    await tx
      .update(supplierPaymentRequests)
      .set({
        status: "REJECTED",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewReason,
        decisionKey,
        decisionHash: hash,
      })
      .where(eq(supplierPaymentRequests.id, input.requestId));
    if (linkedVoucher)
      await tx
        .update(receipts)
        .set({
          status: "FAILED",
          approvalStatus: "REJECTED",
          approvedBy: actor.userId,
          approvedAt: new Date(),
        })
        .where(eq(receipts.id, linkedVoucher.id));
    return {
      requestId: input.requestId,
      status: "REJECTED" as const,
      supplierPaymentId: null,
      idempotent: false as const,
    };
  }
  if (
    request.payloadCanonical !== preview.payloadCanonical ||
    request.payloadHash !== preview.payloadHash ||
    request.requestedBy !== preview.requestedBy ||
    request.branchId !== preview.branchId ||
    request.paymentMethod !== preview.paymentMethod
  )
    throw cashSourceError("تغيّر دليل مصدر النقد أثناء الاعتماد", "CONFLICT");
  const supplier = aggregate.supplier;
  if (!supplier || !supplier.isActive)
    throw new TRPCError({
      code: "CONFLICT",
      message: "المورد غير صالح للدفع",
    });
  // Linked live vouchers retain the generic voucher net-AP ceiling under the
  // aggregate supplier lock. Native payments keep their invoice-based contract.
  if (
    linkedVoucher &&
    supplier.supplierKind === "REGULAR" &&
    money(request.requestedAmount).gt(supplier.currentBalance)
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر اعتماد سند سداد المورد",
        why: `الرصيد المستحق للمورد (${money(supplier.currentBalance).toFixed(2)}) أقلّ من مبلغ الصرف`,
        doThis: "أعد الطلب بعد مراجعة كشف المورد",
      }),
    });
  const requested = await tx
    .select()
    .from(supplierPaymentRequestAllocations)
    .where(eq(supplierPaymentRequestAllocations.requestId, input.requestId))
    .orderBy(asc(supplierPaymentRequestAllocations.supplierInvoiceId))
    .for("update");
  const ids = requested.map((row) => Number(row.supplierInvoiceId));
  const invoices = aggregate.invoices;
  const invoiceById = new Map(invoices.map((row) => [Number(row.id), row]));
  const reservations = await invoiceReservations(tx, ids);
  const staleInvoice = requested.find((row) => {
    const invoice = invoiceById.get(Number(row.supplierInvoiceId));
    return (
      !invoice ||
      Number(invoice.version) !== Number(row.invoiceVersion) ||
      invoice.status !== "POSTED" ||
      invoice.paymentGate !== "OPEN"
    );
  });
  if (staleInvoice) {
    if (linkedVoucher)
      throw supplierVoucherConflict(
        "تغيّرت فاتورة مخصصة بعد إنشاء السند؛ اسحب الطلب وأعد توزيع المبلغ",
      );
    await tx
      .update(supplierPaymentRequestAllocations)
      .set({ activeInvoiceGuard: null })
      .where(eq(supplierPaymentRequestAllocations.requestId, input.requestId));
    await tx
      .update(supplierPaymentRequests)
      .set({
        status: "STALE",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewReason: "تغيّرت فاتورة مورد مخصصة بعد إنشاء الطلب",
        decisionKey,
        decisionHash: hash,
      })
      .where(eq(supplierPaymentRequests.id, input.requestId));
    return {
      requestId: input.requestId,
      status: "STALE" as const,
      supplierPaymentId: null,
      idempotent: false as const,
    };
  }
  await assertNativePurchaseSettlementEvidence(tx, aggregate);
  const invoiceCurrencySettlement = usesInvoiceCurrencySettlement(request);
  const continuedInvoiceIds: number[] =
    JSON.parse(request.payloadCanonical).continuedInvoiceIds ?? [];
  if (invoiceCurrencySettlement) {
    if (request.currency === "IQD" && !linkedVoucher)
      throw supplierVoucherConflict(
        "نمط عملة الفاتورة يتطلب سند دينار مرتبطاً أو إكمال فاتورة دولارية",
      );
    assertPaymentTotals(
      request.requestedAmount,
      request.requestedCurrencyAmount,
      requested.map((row) => ({
        amount: row.requestedAmount,
        currencyAmount:
          request.currency === "IQD"
            ? row.requestedAmount
            : row.requestedCurrencyAmount,
      })),
    );
    const savedAllocations = JSON.parse(request.payloadCanonical).allocations;
    const currentAllocations = requested.map((row) => ({
      supplierInvoiceId: Number(row.supplierInvoiceId),
      invoiceVersion: Number(row.invoiceVersion),
      amount: row.requestedAmount,
      currencyAmount: row.requestedCurrencyAmount,
    }));
    if (
      stableCanonical(savedAllocations) !== stableCanonical(currentAllocations)
    )
      throw supplierVoucherConflict("تخصيصات السند لا تطابق بصمة الطلب");
  }
  for (const row of requested) {
    const invoice = invoiceById.get(Number(row.supplierInvoiceId));
    if (!invoice)
      throw new TRPCError({
        code: "CONFLICT",
        message: "فاتورة مخصصة مفقودة",
      });
    assertSupplierInvoicePayable(invoice);
    assertExpectedVersion(
      Number(invoice.version),
      Number(row.invoiceVersion),
      "فاتورة المورد",
    );
    if (
      Number(invoice.supplierId) !== Number(request.supplierId) ||
      Number(invoice.branchId) !== Number(request.branchId)
    )
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّرت ملكية الفاتورة",
      });
    const posted = reservations.posted.get(Number(invoice.id)) ?? {
      amount: money(0),
      currencyAmount: money(0),
    };
    const pendingAll = reservations.pending.get(Number(invoice.id)) ?? {
      amount: money(0),
      currencyAmount: money(0),
    };
    const pendingOther = {
      amount: pendingAll.amount.minus(row.requestedAmount),
      currencyAmount: pendingAll.currencyAmount.minus(
        row.requestedCurrencyAmount,
      ),
    };
    const creditReturns =
      reservations.creditReturns.get(Number(invoice.id)) ?? money(0);
    if (invoiceCurrencySettlement) {
      const snapshot = JSON.parse(row.invoiceSnapshot);
      if (
        sha256(row.invoiceSnapshot) !== row.invoiceHash ||
        snapshot.currency !== invoice.currency ||
        snapshot.agreedRate !== invoice.agreedRate ||
        ((request.currency === "IQD" ||
          continuedInvoiceIds.includes(Number(invoice.id))) &&
          !money(row.requestedCurrencyAmount).eq(
            supplierVoucherCurrencyAmount(
              invoice,
              row.requestedAmount,
              {
                amount: toDbMoney(posted.amount.plus(pendingOther.amount)),
                currencyAmount: toDbMoney(
                  posted.currencyAmount.plus(pendingOther.currencyAmount),
                ),
              },
              toDbMoney(creditReturns),
              toDbMoney(
                reservations.creditCurrencyAmounts.get(Number(invoice.id)) ?? 0,
              ),
            ),
          ))
      )
        throw supplierVoucherConflict(
          "تغيّرت عملة الفاتورة أو سعرها أو رصيدها بعد إنشاء السند",
        );
    }
    if (
      request.currency === "USD" &&
      !continuedInvoiceIds.includes(Number(invoice.id))
    )
      assertAgreedRateAmount(
        row.requestedAmount,
        row.requestedCurrencyAmount,
        invoice.agreedRate,
        `تخصيص الفاتورة ${invoice.invoiceNumber}`,
      );
    assertAllocationAvailable(
      invoice,
      {
        amount: row.requestedAmount,
        currencyAmount: row.requestedCurrencyAmount,
      },
      {
        amount: posted.amount.plus(pendingOther.amount),
        currencyAmount: posted.currencyAmount.plus(pendingOther.currencyAmount),
      },
      creditReturns,
      reservations.creditCurrencyAmounts.get(Number(invoice.id)),
    );
  }
  if (request.currency === "USD" && !invoiceCurrencySettlement)
    assertAgreedRateAmount(
      request.requestedAmount,
      request.requestedCurrencyAmount,
      request.exchangeRate,
      "رأس دفعة المورد",
    );
  const amount = money(request.requestedAmount);
  if (request.paymentMethod === "CASH") {
    if (instrument.cashBucket === "TREASURY") {
      if (!instrument.treasuryApproval)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "إثبات اعتماد دفع المورد من الخزينة مفقود",
        });
      await assertApprovedTreasuryOutAvailable(
        tx,
        { branchId: Number(request.branchId), amount, operation: "دفع مورد" },
        instrument.treasuryApproval,
      );
    } else if (instrument.cashBucket === "DRAWER") {
      await assertCashOutAvailable(tx, {
        branchId: Number(request.branchId),
        shiftId: instrument.shiftId,
        cashBucket: "DRAWER",
        amount,
        operation: "دفع مورد",
      });
    } else {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "مصدر دفع المورد النقدي مفقود",
      });
    }
  } else {
    assertNonPhysicalOutReceipt({
      classification: "NON_CASH_METHOD",
      paymentMethod: request.paymentMethod,
      cashBucket: null,
      approvalStatus: "APPROVED",
      operation: "دفع مورد",
    });
  }
  const receiptValues = {
    branchId: Number(request.branchId),
    shiftId: instrument.shiftId,
    cashBucket: instrument.cashBucket,
    direction: "OUT" as const,
    amount: toDbMoney(amount),
    paymentMethod: request.paymentMethod,
    referenceNumber:
      request.externalReference ?? `SUPPLIER-PAY-REQ:${input.requestId}`,
    partyType: "SUPPLIER" as const,
    partyId: Number(request.supplierId),
    description: request.reason,
    status: "COMPLETED" as const,
    approvalStatus: "APPROVED" as const,
    approvedBy: actor.userId,
    approvedAt: new Date(),
    createdBy: Number(request.requestedBy),
  };
  let receiptId: number;
  if (linkedVoucher) {
    receiptId = linkedVoucher.id;
    await tx
      .update(receipts)
      .set({
        shiftId: instrument.shiftId,
        cashBucket: instrument.cashBucket,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
        signatureHash: supplierVoucherSignature(linkedVoucher, actor.userId),
      })
      .where(eq(receipts.id, receiptId));
  } else {
    receiptId = extractInsertId(
      await tx.insert(receipts).values(receiptValues),
    );
  }
  const asset = paymentAssetRole(
    request.paymentMethod,
    instrument.cashBucket,
    "OUT",
  );
  const source = {
    roleDebits: { AP: amount },
    roleCredits: { [asset]: amount },
  };
  const dedupeKey = `SUPPLIER_PAYMENT_REQUEST:${input.requestId}`;
  // تدقيق التغطية النقدية (getPurchaseIntegrityReport) يقيس المدفوع مقابل المعترف به عبر
  // accountingEntries.purchaseOrderId على القيدين معاً — بلا هذا الربط يبدو كل سدادٍ صحيح
  // بلا تغطيةٍ إطلاقاً (CRITICAL كاذب). دفعة تخصّ فاتورةً واحدة مرتبطة بأمر شراءٍ واحد تُربَط
  // به صراحة؛ ودفعة متعددة الفواتير/الأوامر (نادرة) تبقى بلا ربطٍ بدل تخمين أمرٍ خاطئ.
  const paidPurchaseOrderIds = await resolveInvoicePurchaseOrderIds(tx, ids);
  const linkedPurchaseOrderId =
    paidPurchaseOrderIds.length === 1 ? paidPurchaseOrderIds[0] : null;
  await postEntry(tx, {
    entryType: "PAYMENT_OUT",
    branchId: Number(request.branchId),
    supplierId: Number(request.supplierId),
    purchaseOrderId: linkedPurchaseOrderId,
    receiptId,
    amount,
    paymentMethod: request.paymentMethod,
    createdBy: Number(request.requestedBy),
    dedupeKey,
    notes: request.reason,
    ...(linkedVoucher
      ? {
          entryDate: new Date(
            linkedVoucher.voucherDate ?? linkedVoucher.createdAt,
          ),
        }
      : {}),
    postingIntent: createPostingIntent(
      "PAYMENT_OUT_SUPPLIER",
      "PAYMENT_OUT",
      [debitLine("AP", amount), creditLine(asset, amount)],
      source,
    ),
    postingSourceComponents: source,
  });
  const entryId = await accountingEntryId(tx, dedupeKey);
  const paymentNumber = `SP-${request.branchId}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${createHash("sha256").update(request.requestKey).digest("hex").slice(0, 16).toUpperCase()}`;
  const inserted = await tx.insert(supplierPayments).values({
    paymentNumber,
    requestId: input.requestId,
    supplierId: Number(request.supplierId),
    branchId: Number(request.branchId),
    currency: request.currency,
    exchangeRate: request.exchangeRate,
    amount: request.requestedAmount,
    currencyAmount: request.requestedCurrencyAmount,
    paymentMethod: request.paymentMethod,
    externalReference: request.externalReference,
    receiptId,
    accountingEntryId: entryId,
    payloadCanonical: request.payloadCanonical,
    payloadHash: request.payloadHash,
    postedBy: actor.userId,
  });
  const supplierPaymentId = extractInsertId(inserted);
  await tx.insert(supplierPaymentAllocations).values(
    requested.map((row) => ({
      supplierPaymentId,
      requestAllocationId: Number(row.id),
      supplierInvoiceId: Number(row.supplierInvoiceId),
      allocatedAmount: row.requestedAmount,
      allocatedCurrencyAmount: row.requestedCurrencyAmount,
      invoiceHash: row.invoiceHash,
    })),
  );
  await tx
    .update(supplierPaymentRequestAllocations)
    .set({ activeInvoiceGuard: null })
    .where(eq(supplierPaymentRequestAllocations.requestId, input.requestId));
  await adjustSupplierBalance(tx, Number(request.supplierId), amount.neg());
  if (request.currency === "USD")
    await adjustSupplierBalanceUsd(
      tx,
      Number(request.supplierId),
      money(request.requestedCurrencyAmount).neg(),
    );
  else if (invoiceCurrencySettlement) {
    const usdPaid = sumMoney(
      requested
        .filter(
          (row) =>
            invoiceById.get(Number(row.supplierInvoiceId))?.currency === "USD",
        )
        .map((row) => row.requestedCurrencyAmount),
    );
    if (usdPaid.gt(0))
      await adjustSupplierBalanceUsd(
        tx,
        Number(request.supplierId),
        usdPaid.neg(),
      );
  }
  for (const row of requested) {
    const invoice = invoiceById.get(Number(row.supplierInvoiceId))!;
    const posted = reservations.posted.get(Number(invoice.id)) ?? {
      amount: money(0),
      currencyAmount: money(0),
    };
    const newPaid = round2(
      money(invoice.legacySettledAmount)
        .plus(posted.amount)
        .plus(row.requestedAmount),
    );
    const effectiveTotal = effectiveInvoicePayable(
      invoice.totalAmount,
      reservations.creditReturns.get(Number(invoice.id)) ?? money(0),
    );
    await tx
      .update(supplierInvoices)
      .set({
        version: sql`${supplierInvoices.version} + 1`,
        paymentGate: newPaid.gte(effectiveTotal) ? "SETTLED" : "OPEN",
        paymentGateReason: newPaid.gte(effectiveTotal)
          ? "سُوّيت بالكامل بعد صافي المرتجعات وتخصيصات الدفع الذرية"
          : null,
      })
      .where(eq(supplierInvoices.id, Number(invoice.id)));

    // ═══ تحديث ذري لأمر الشراء المرتبط (إن وُجد) ═══
    // سداد الفاتورة يجب أن ينعكس فوراً على paidAmount لأمر الشراء، فلا يبقى الأمر
    // يطالب بمبلغٍ متبقٍّ بعد سداد فاتورته، ولا يظهر كدينٍ غير مدفوع في كشف الحساب.
    const invoicePoIds = await resolveInvoicePurchaseOrderIds(tx, [
      Number(invoice.id),
    ]);
    if (invoicePoIds.length === 1) {
      const targetPoId = invoicePoIds[0];
      await tx
        .update(purchaseOrders)
        .set({
          paidAmount: sql`${purchaseOrders.paidAmount} + ${toDbMoney(row.requestedAmount)}`,
          ...(invoice.currency === "USD"
            ? {
                paidUsd: sql`${purchaseOrders.paidUsd} + ${toDbMoney(row.requestedCurrencyAmount)}`,
              }
            : {}),
          version: sql`${purchaseOrders.version} + 1`,
        })
        .where(eq(purchaseOrders.id, targetPoId));
    }
  }
  await tx
    .update(supplierPaymentRequests)
    .set({
      status: "APPROVED",
      pendingGuard: null,
      reviewedBy: actor.userId,
      reviewedAt: new Date(),
      reviewReason,
      decisionKey,
      decisionHash: hash,
      appliedAt: new Date(),
    })
    .where(eq(supplierPaymentRequests.id, input.requestId));
  return {
    requestId: input.requestId,
    status: "APPROVED" as const,
    supplierPaymentId,
    idempotent: false as const,
  };
}

export async function decideSupplierPayment(
  input: DecideSupplierPaymentInput,
  actor: Actor,
  capability?: SupplierPaymentTreasuryDecisionCapability,
) {
  return withTx((tx) =>
    decideSupplierPaymentInTx(tx, input, actor, capability),
  );
}

export async function requestSupplierPaymentRefund(
  input: RequestSupplierPaymentRefundInput,
  actor: Actor,
) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120);
  const reason = required(input.reason, "سبب الاسترداد", 500);
  const evidenceReference = required(
    input.evidenceReference,
    "مرجع الدليل",
    500,
  );
  const externalReference = input.externalReference?.trim() || null;
  if (input.refundMethod !== "CASH" && !externalReference)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مرجع أداة الاسترداد مطلوب",
    });
  if (!input.allocations.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أضف تخصيص استرداد واحداً على الأقل",
    });
  uniqueIds(
    input.allocations.map((row) => row.supplierPaymentAllocationId),
    "تخصيص الدفع",
  );
  let normalized = [...input.allocations]
    .map((row) => ({
      ...row,
      amount: toDbMoney(row.amount),
      currencyAmount: toDbMoney(row.currencyAmount),
    }))
    .sort(
      (a, b) => a.supplierPaymentAllocationId - b.supplierPaymentAllocationId,
    );
  const amount = toDbMoney(sumMoney(normalized.map((row) => row.amount)));
  const currencyAmount = toDbMoney(
    sumMoney(normalized.map((row) => row.currencyAmount)),
  );
  assertPaymentTotals(amount, currencyAmount, normalized);
  const payload = {
    supplierPaymentId: input.supplierPaymentId,
    expectedPaymentVersion: input.expectedPaymentVersion,
    refundMethod: input.refundMethod,
    externalReference,
    evidenceType: input.evidenceType,
    evidenceReference,
    reason,
    allocations: normalized,
  };
  const refundCanonical = (
    source: CashSource | null | undefined,
    branchId: number,
  ) =>
    stableCanonical({
      ...payload,
      ...(source === undefined
        ? {}
        : { branchId, cashSource: refundCashSource(source) }),
    });
  const result = await withTx(async (tx) => {
    const replay = (
      await tx
        .select()
        .from(supplierPaymentRefundRequests)
        .where(eq(supplierPaymentRefundRequests.requestKey, requestKey))
        .limit(1)
    )[0];
    if (replay) {
      assertPurchaseBranch(replay, actor);
      if (Number(replay.requestedBy) !== actor.userId)
        throw cashSourceError("مفتاح الطلب يعود إلى مستلم آخر", "FORBIDDEN");
      const source = storedCashSource(
        { ...replay, paymentMethod: replay.refundMethod },
        true,
        "refundMethod",
      );
      if (input.refundMethod !== "CASH" && input.cashSource != null)
        throw cashSourceError(
          "الاسترداد غير النقدي لا يقبل مصدر نقد",
          "BAD_REQUEST",
        );
      if (
        input.cashSource != null &&
        (!source ||
          input.cashSource.mode !== source.mode ||
          (input.cashSource.shiftId != null &&
            input.cashSource.shiftId !== source.shiftId))
      )
        throw cashSourceError("مفتاح الطلب مستعمل بمصدر نقد مختلف", "CONFLICT");
      if (
        !payloadHashMatches(
          sha256(refundCanonical(source, Number(replay.branchId))),
          replay.payloadHash,
        )
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح الطلب مستعمل باسترداد مختلف",
        });
      return {
        requestId: Number(replay.id),
        status: replay.status,
        idempotent: true as const,
      };
    }
    const previewPayment = (
      await tx
        .select()
        .from(supplierPayments)
        .where(eq(supplierPayments.id, input.supplierPaymentId))
        .limit(1)
    )[0];
    if (!previewPayment)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "دفعة المورد غير موجودة",
      });
    assertPurchaseBranch(previewPayment, actor);
    const source = await captureCashSource(
      tx,
      input.refundMethod,
      input.cashSource,
      Number(previewPayment.branchId),
      actor,
    );
    const payment = (
      await tx
        .select()
        .from(supplierPayments)
        .where(eq(supplierPayments.id, input.supplierPaymentId))
        .for("update")
        .limit(1)
    )[0];
    if (
      !payment ||
      Number(payment.branchId) !== Number(previewPayment.branchId)
    )
      throw cashSourceError(
        "تغيّرت دفعة المورد أثناء تحديد مصدر النقد",
        "CONFLICT",
      );
    assertPurchaseBranch(payment, actor);
    const canonical = refundCanonical(source, Number(payment.branchId));
    const payloadHash = sha256(canonical);
    assertExpectedVersion(
      Number(payment.version),
      input.expectedPaymentVersion,
      "دفعة المورد",
    );
    if (payment.status === "REFUNDED")
      throw new TRPCError({
        code: "CONFLICT",
        message: "الدفعة مستردة بالكامل",
      });
    const ids = normalized.map((row) => row.supplierPaymentAllocationId);
    const allocations = await tx
      .select()
      .from(supplierPaymentAllocations)
      .where(inArray(supplierPaymentAllocations.id, ids))
      .orderBy(asc(supplierPaymentAllocations.id))
      .for("update");
    const byId = new Map(allocations.map((row) => [Number(row.id), row]));
    const invoiceCurrencySettlement = usesInvoiceCurrencySettlement(payment);
    if (invoiceCurrencySettlement)
      normalized = normalized.map((row) => {
        const allocation = byId.get(row.supplierPaymentAllocationId);
        if (
          !allocation ||
          Number(allocation.supplierPaymentId) !== input.supplierPaymentId
        )
          throw supplierVoucherConflict("تخصيص الاسترداد لا يخص الدفعة");
        return {
          ...row,
          currencyAmount: cumulativeCurrencyDelta(
            allocation.allocatedAmount,
            allocation.allocatedCurrencyAmount,
            allocation.refundedAmount,
            allocation.refundedCurrencyAmount,
            row.amount,
          ),
        };
      });
    for (const row of normalized) {
      const allocation = byId.get(row.supplierPaymentAllocationId);
      if (
        !allocation ||
        Number(allocation.supplierPaymentId) !== input.supplierPaymentId
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "تخصيص لا يخص الدفعة",
        });
      if (payment.currency === "USD" && !invoiceCurrencySettlement)
        assertAgreedRateAmount(
          row.amount,
          row.currencyAmount,
          payment.exchangeRate,
          "تخصيص استرداد دفعة المورد",
        );
      if (
        money(row.amount).gt(
          money(allocation.allocatedAmount).minus(allocation.refundedAmount),
        ) ||
        money(row.currencyAmount).gt(
          money(allocation.allocatedCurrencyAmount).minus(
            allocation.refundedCurrencyAmount,
          ),
        )
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "الاسترداد يتجاوز المتبقي من تخصيص الدفع",
        });
    }
    if (payment.currency === "USD" && !invoiceCurrencySettlement)
      assertAgreedRateAmount(
        amount,
        currencyAmount,
        payment.exchangeRate,
        "رأس استرداد دفعة المورد",
      );
    const inserted = await tx.insert(supplierPaymentRefundRequests).values({
      requestKey,
      supplierPaymentId: input.supplierPaymentId,
      branchId: Number(payment.branchId),
      basePaymentVersion: input.expectedPaymentVersion,
      requestedAmount: amount,
      requestedCurrencyAmount: invoiceCurrencySettlement
        ? payment.currency === "IQD"
          ? amount
          : toDbMoney(sumMoney(normalized.map((row) => row.currencyAmount)))
        : currencyAmount,
      refundMethod: input.refundMethod,
      externalReference,
      payloadCanonical: canonical,
      payloadHash,
      evidenceType: input.evidenceType,
      evidenceReference,
      reason,
      pendingGuard: `SUPPLIER-PAY-REFUND:${input.supplierPaymentId}`,
      requestedBy: actor.userId,
    });
    const requestId = extractInsertId(inserted);
    await tx.insert(supplierPaymentRefundRequestItems).values(
      normalized.map((row) => ({
        requestId,
        supplierPaymentAllocationId: row.supplierPaymentAllocationId,
        amount: row.amount,
        currencyAmount: row.currencyAmount,
      })),
    );
    return {
      requestId,
      status: "PENDING" as const,
      idempotent: false as const,
    };
  });
  const approved = await autoDecideForActiveOwner(actor, {
    kind: "supplier.payment.refund",
    id: result.requestId,
    reason,
  });
  return approved ? { ...result, status: "APPROVED" as const } : result;
}

export async function decideSupplierPaymentRefund(
  input: DecideSupplierPaymentRefundInput,
  actor: Actor,
  capability?: SupplierPaymentTreasuryDecisionCapability,
) {
  assertSupplierPaymentTreasuryDecisionAuthority(actor, capability);
  const decisionKey = required(input.decisionKey, "مفتاح القرار", 120);
  const reviewReason = required(input.reviewReason, "سبب القرار", 500);
  const hash = decisionPayloadHash(input.requestId, input.action, reviewReason);
  return withTx(async (tx) => {
    const preview = (
      await tx
        .select()
        .from(supplierPaymentRefundRequests)
        .where(eq(supplierPaymentRefundRequests.id, input.requestId))
        .limit(1)
    )[0];
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "طلب استرداد الدفعة غير موجود",
      });
    assertPurchaseBranch(preview, actor);
    const previewPayment =
      input.action === "APPROVE"
        ? (
            await tx
              .select()
              .from(supplierPayments)
              .where(eq(supplierPayments.id, Number(preview.supplierPaymentId)))
              .limit(1)
          )[0]
        : null;
    const instrument =
      input.action === "APPROVE" && preview.status === "PENDING"
        ? await lockRequestedPaymentInstrument(
            tx,
            { ...preview, paymentMethod: preview.refundMethod },
            actor,
            "IN",
            "refundMethod",
          )
        : { shiftId: null, cashBucket: null, treasuryApproval: null };
    const previewItems =
      input.action === "APPROVE"
        ? await tx
            .select({
              allocationId:
                supplierPaymentRefundRequestItems.supplierPaymentAllocationId,
            })
            .from(supplierPaymentRefundRequestItems)
            .where(
              eq(supplierPaymentRefundRequestItems.requestId, input.requestId),
            )
        : [];
    const previewAllocations = previewItems.length
      ? await tx
          .select({
            id: supplierPaymentAllocations.id,
            supplierInvoiceId: supplierPaymentAllocations.supplierInvoiceId,
          })
          .from(supplierPaymentAllocations)
          .where(
            inArray(
              supplierPaymentAllocations.id,
              previewItems.map((row) => Number(row.allocationId)),
            ),
          )
      : [];
    if (input.action === "APPROVE" && previewPayment)
      await lockPaymentAggregate(
        tx,
        Number(previewPayment.supplierId),
        previewAllocations.map((row) => Number(row.supplierInvoiceId)),
      );
    const request = (
      await tx
        .select()
        .from(supplierPaymentRefundRequests)
        .where(eq(supplierPaymentRefundRequests.id, input.requestId))
        .for("update")
        .limit(1)
    )[0]!;
    // استردادُ السداد **محوُ أثر**: عكسٌ جبريٌّ سطراً بسطر للدفع — إيصال IN مقابل OUT،
    // وPAYMENT_IN مقابل PAYMENT_OUT، ورصيدُ المورّد يعود، والفاتورة تعود OPEN.
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — التفصيل في voucher/approval.ts.
    const supplierPaymentRefundApprover = await resolveApprovalActor(tx, actor);
    assertApprover({
      actor: await resolveApprovalActor(tx, actor),
      trigger: supplierPaymentRefundTrigger(input.action),
      subject: `استرداد سداد (طلب ${input.requestId})`,
      legacy: () => {
        if (supplierPaymentRefundApprover.isOwner) return;
        assertIndependentPurchaseReviewer(
          Number(request.requestedBy),
          actor.userId,
        );
      },
    });
    if (request.status !== "PENDING") {
      if (request.decisionKey === decisionKey && request.decisionHash === hash)
        return {
          requestId: input.requestId,
          status: request.status,
          refundId: null,
          idempotent: true as const,
        };
      throw new TRPCError({
        code: "CONFLICT",
        message: "حُسم طلب الاسترداد مسبقاً",
      });
    }
    if (input.action === "REJECT") {
      await tx
        .update(supplierPaymentRefundRequests)
        .set({
          status: "REJECTED",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          reviewReason,
          decisionKey,
          decisionHash: hash,
        })
        .where(eq(supplierPaymentRefundRequests.id, input.requestId));
      return {
        requestId: input.requestId,
        status: "REJECTED" as const,
        refundId: null,
        idempotent: false as const,
      };
    }
    if (
      request.payloadHash !== preview.payloadHash ||
      request.payloadCanonical !== preview.payloadCanonical ||
      Number(request.requestedBy) !== Number(preview.requestedBy) ||
      Number(request.branchId) !== Number(preview.branchId) ||
      request.refundMethod !== preview.refundMethod
    )
      throw cashSourceError("تغيّر دليل مصدر النقد أثناء الاعتماد", "CONFLICT");
    const payment = (
      await tx
        .select()
        .from(supplierPayments)
        .where(eq(supplierPayments.id, Number(request.supplierPaymentId)))
        .for("update")
        .limit(1)
    )[0];
    if (!payment)
      throw new TRPCError({ code: "CONFLICT", message: "دفعة المورد مفقودة" });
    if (Number(payment.version) !== Number(request.basePaymentVersion)) {
      await tx
        .update(supplierPaymentRefundRequests)
        .set({
          status: "STALE",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          reviewReason: "تغيّرت دفعة المورد بعد إنشاء طلب الاسترداد",
          decisionKey,
          decisionHash: hash,
        })
        .where(eq(supplierPaymentRefundRequests.id, input.requestId));
      return {
        requestId: input.requestId,
        status: "STALE" as const,
        refundId: null,
        idempotent: false as const,
      };
    }
    const items = await tx
      .select()
      .from(supplierPaymentRefundRequestItems)
      .where(eq(supplierPaymentRefundRequestItems.requestId, input.requestId))
      .orderBy(
        asc(supplierPaymentRefundRequestItems.supplierPaymentAllocationId),
      )
      .for("update");
    const ids = items.map((row) => Number(row.supplierPaymentAllocationId));
    const allocations = await tx
      .select()
      .from(supplierPaymentAllocations)
      .where(inArray(supplierPaymentAllocations.id, ids))
      .orderBy(asc(supplierPaymentAllocations.id))
      .for("update");
    const byId = new Map(allocations.map((row) => [Number(row.id), row]));
    const invoiceCurrencySettlement = usesInvoiceCurrencySettlement(payment);
    const refundInvoices = await tx
      .select({ id: supplierInvoices.id, currency: supplierInvoices.currency })
      .from(supplierInvoices)
      .where(
        inArray(
          supplierInvoices.id,
          allocations.map((row) => Number(row.supplierInvoiceId)),
        ),
      );
    const refundInvoiceCurrency = new Map(
      refundInvoices.map((row) => [Number(row.id), row.currency]),
    );
    if (invoiceCurrencySettlement) {
      assertPaymentTotals(
        request.requestedAmount,
        request.requestedCurrencyAmount,
        items.map((row) => ({
          amount: row.amount,
          currencyAmount:
            payment.currency === "IQD" ? row.amount : row.currencyAmount,
        })),
      );
      const commandRows = JSON.parse(request.payloadCanonical).allocations;
      const identity = (
        rows: Array<{ supplierPaymentAllocationId: number; amount: string }>,
      ) =>
        stableCanonical(
          rows
            .map((row) => ({
              id: Number(row.supplierPaymentAllocationId),
              amount: toDbMoney(row.amount),
            }))
            .sort((a, b) => a.id - b.id),
        );
      if (identity(commandRows) !== identity(items))
        throw supplierVoucherConflict("مبالغ الاسترداد لا تطابق بصمة الطلب");
    }

    if (payment.currency === "USD" && !invoiceCurrencySettlement)
      assertAgreedRateAmount(
        request.requestedAmount,
        request.requestedCurrencyAmount,
        payment.exchangeRate,
        "رأس استرداد دفعة المورد",
      );
    for (const row of items) {
      const allocation = byId.get(Number(row.supplierPaymentAllocationId));
      if (
        invoiceCurrencySettlement &&
        allocation &&
        !money(row.currencyAmount).eq(
          cumulativeCurrencyDelta(
            allocation.allocatedAmount,
            allocation.allocatedCurrencyAmount,
            allocation.refundedAmount,
            allocation.refundedCurrencyAmount,
            row.amount,
          ),
        )
      )
        throw supplierVoucherConflict("تغيّر رصيد عملة تخصيص الاسترداد");
      if (payment.currency === "USD" && !invoiceCurrencySettlement)
        assertAgreedRateAmount(
          row.amount,
          row.currencyAmount,
          payment.exchangeRate,
          "تخصيص استرداد دفعة المورد",
        );
      if (
        !allocation ||
        Number(allocation.supplierPaymentId) !== Number(payment.id) ||
        money(row.amount).gt(
          money(allocation.allocatedAmount).minus(allocation.refundedAmount),
        ) ||
        money(row.currencyAmount).gt(
          money(allocation.allocatedCurrencyAmount).minus(
            allocation.refundedCurrencyAmount,
          ),
        )
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّر المبلغ القابل للاسترداد",
        });
    }
    const amount = money(request.requestedAmount);
    const refundPurchaseOrderIds = await resolveInvoicePurchaseOrderIds(
      tx,
      allocations.map((row) => Number(row.supplierInvoiceId)),
    );
    const refundPurchaseOrderId =
      refundPurchaseOrderIds.length === 1 ? refundPurchaseOrderIds[0] : null;
    const receipt = await tx.insert(receipts).values({
      branchId: Number(request.branchId),
      shiftId: instrument.shiftId,
      cashBucket: instrument.cashBucket,
      direction: "IN",
      amount: request.requestedAmount,
      paymentMethod: request.refundMethod,
      referenceNumber:
        request.externalReference ?? `SUPPLIER-REFUND-REQ:${input.requestId}`,
      partyType: "SUPPLIER",
      partyId: Number(payment.supplierId),
      description: request.reason,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      createdBy: Number(request.requestedBy),
    });
    const receiptId = extractInsertId(receipt);
    const asset = paymentAssetRole(
      request.refundMethod,
      instrument.cashBucket,
      "IN",
    );
    const source = {
      roleDebits: { [asset]: amount },
      roleCredits: { AP: amount },
    };
    const dedupeKey = `SUPPLIER_PAYMENT_REFUND_REQUEST:${input.requestId}`;
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: Number(request.branchId),
      purchaseOrderId: refundPurchaseOrderId,
      supplierId: Number(payment.supplierId),
      receiptId,
      amount,
      paymentMethod: request.refundMethod,
      createdBy: Number(request.requestedBy),
      dedupeKey,
      notes: request.reason,
      postingIntent: createPostingIntent(
        "PAYMENT_IN_SUPPLIER_REFUND",
        "PAYMENT_IN",
        [debitLine(asset, amount), creditLine("AP", amount)],
        source,
      ),
      postingSourceComponents: source,
    });
    const entryId = await accountingEntryId(tx, dedupeKey);
    const refundNumber = `SPR-${request.branchId}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${createHash("sha256").update(request.requestKey).digest("hex").slice(0, 16).toUpperCase()}`;
    const inserted = await tx.insert(supplierPaymentRefunds).values({
      refundNumber,
      requestId: input.requestId,
      supplierPaymentId: Number(payment.id),
      supplierId: Number(payment.supplierId),
      branchId: Number(request.branchId),
      amount: request.requestedAmount,
      currencyAmount: request.requestedCurrencyAmount,
      receiptId,
      accountingEntryId: entryId,
      payloadCanonical: request.payloadCanonical,
      payloadHash: request.payloadHash,
      postedBy: actor.userId,
    });
    const refundId = extractInsertId(inserted);
    for (const row of items) {
      const updated = await tx
        .update(supplierPaymentAllocations)
        .set({
          refundedAmount: sql`${supplierPaymentAllocations.refundedAmount} + ${row.amount}`,
          refundedCurrencyAmount: sql`${supplierPaymentAllocations.refundedCurrencyAmount} + ${row.currencyAmount}`,
        })
        .where(
          and(
            eq(
              supplierPaymentAllocations.id,
              Number(row.supplierPaymentAllocationId),
            ),
            sql`${supplierPaymentAllocations.refundedAmount} + ${row.amount} <= ${supplierPaymentAllocations.allocatedAmount}`,
            sql`${supplierPaymentAllocations.refundedCurrencyAmount} + ${row.currencyAmount} <= ${supplierPaymentAllocations.allocatedCurrencyAmount}`,
          ),
        );
      if (extractAffectedRows(updated) !== 1)
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّر تخصيص الدفع أثناء الاسترداد",
        });
      await tx.insert(supplierPaymentRefundItems).values({
        refundId,
        supplierPaymentAllocationId: Number(row.supplierPaymentAllocationId),
        amount: row.amount,
        currencyAmount: row.currencyAmount,
      });
      const allocation = byId.get(Number(row.supplierPaymentAllocationId));
      if (allocation) {
        const invoicePoIds = await resolveInvoicePurchaseOrderIds(tx, [
          Number(allocation.supplierInvoiceId),
        ]);
        if (invoicePoIds.length === 1) {
          await tx
            .update(purchaseOrders)
            .set({
              paidAmount: sql`GREATEST(${purchaseOrders.paidAmount} - ${toDbMoney(row.amount)}, 0)`,
              ...(refundInvoiceCurrency.get(
                Number(allocation.supplierInvoiceId),
              ) === "USD"
                ? {
                    paidUsd: sql`GREATEST(${purchaseOrders.paidUsd} - ${toDbMoney(row.currencyAmount)}, 0)`,
                  }
                : {}),
              version: sql`${purchaseOrders.version} + 1`,
            })
            .where(eq(purchaseOrders.id, invoicePoIds[0]));
        }
      }
    }
    const affectedInvoiceIds = sortedUniquePurchaseOrderIds(
      allocations.map((row) => Number(row.supplierInvoiceId)),
    );
    const affectedInvoices = await tx
      .select()
      .from(supplierInvoices)
      .where(inArray(supplierInvoices.id, affectedInvoiceIds))
      .orderBy(asc(supplierInvoices.id));
    const afterRefund = await invoiceReservations(tx, affectedInvoiceIds);
    for (const invoice of affectedInvoices) {
      const paid =
        afterRefund.posted.get(Number(invoice.id))?.amount ?? money(0);
      const creditReturns =
        afterRefund.creditReturns.get(Number(invoice.id)) ?? money(0);
      const effectiveTotal = effectiveInvoicePayable(
        invoice.totalAmount,
        creditReturns,
      );
      const settled = money(invoice.legacySettledAmount)
        .plus(paid)
        .gte(effectiveTotal);
      await tx
        .update(supplierInvoices)
        .set({
          version: sql`${supplierInvoices.version} + 1`,
          paymentGate: settled ? "SETTLED" : "OPEN",
          paymentGateReason: settled
            ? "سُوّيت بالكامل بعد صافي المرتجعات وتخصيصات الدفع"
            : null,
        })
        .where(eq(supplierInvoices.id, Number(invoice.id)));
    }
    await adjustSupplierBalance(tx, Number(payment.supplierId), amount);
    if (payment.currency === "USD")
      await adjustSupplierBalanceUsd(
        tx,
        Number(payment.supplierId),
        money(request.requestedCurrencyAmount),
      );
    else if (invoiceCurrencySettlement) {
      const usdRefund = sumMoney(
        items
          .filter((row) => {
            const allocation = byId.get(
              Number(row.supplierPaymentAllocationId),
            );
            return (
              allocation &&
              refundInvoiceCurrency.get(
                Number(allocation.supplierInvoiceId),
              ) === "USD"
            );
          })
          .map((row) => row.currencyAmount),
      );
      if (usdRefund.gt(0))
        await adjustSupplierBalanceUsd(
          tx,
          Number(payment.supplierId),
          usdRefund,
        );
    }
    const totals = (
      await tx
        .select({
          refunded: sql<string>`COALESCE(SUM(${supplierPaymentAllocations.refundedAmount}),0)`,
          allocated: sql<string>`COALESCE(SUM(${supplierPaymentAllocations.allocatedAmount}),0)`,
        })
        .from(supplierPaymentAllocations)
        .where(
          eq(supplierPaymentAllocations.supplierPaymentId, Number(payment.id)),
        )
    )[0];
    const status = money(totals?.refunded).gte(money(totals?.allocated))
      ? ("REFUNDED" as const)
      : ("PARTIALLY_REFUNDED" as const);
    await tx
      .update(supplierPayments)
      .set({ status, version: sql`${supplierPayments.version} + 1` })
      .where(eq(supplierPayments.id, Number(payment.id)));
    await tx
      .update(supplierPaymentRefundRequests)
      .set({
        status: "APPROVED",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewReason,
        decisionKey,
        decisionHash: hash,
        appliedAt: new Date(),
      })
      .where(eq(supplierPaymentRefundRequests.id, input.requestId));
    return {
      requestId: input.requestId,
      status: "APPROVED" as const,
      refundId,
      idempotent: false as const,
    };
  });
}

export async function listPendingSupplierPaymentRequests(
  branchId: number,
  actor: Actor,
) {
  assertPurchaseBranch({ branchId }, actor);
  return withTx(
    async (tx) => {
      const rows = await tx
        .select()
        .from(supplierPaymentRequests)
        .where(
          and(
            eq(supplierPaymentRequests.branchId, branchId),
            eq(supplierPaymentRequests.status, "PENDING"),
            sql`${supplierPaymentRequests.requestKey} NOT LIKE ${`${SUPPLIER_VOUCHER_REQUEST_PREFIX}%`}`,
          ),
        )
        .orderBy(asc(supplierPaymentRequests.requestedAt));
      return rows.map((row) => {
        let cashSource: CashSource | null = null;
        try {
          cashSource = storedCashSource(row) ?? null;
        } catch {
          /* قديم أو دليل تالف: يُعرض لإعادة تقديمه. */
        }
        return { ...row, cashSource };
      });
    },
    { gate: "NONE" },
  );
}

export async function listPendingSupplierPaymentRefundRequests(
  input: {
    branchId: number;
    limit: number;
    cursor?: { requestedAt: Date; id: number } | null;
  },
  actor: Actor,
) {
  const { branchId } = input;
  assertPurchaseBranch({ branchId }, actor);
  return withTx(
    async (tx) => {
      const rows = await tx
        .select()
        .from(supplierPaymentRefundRequests)
        .where(
          and(
            eq(supplierPaymentRefundRequests.branchId, branchId),
            eq(supplierPaymentRefundRequests.status, "PENDING"),
            input.cursor == null
              ? undefined
              : or(
                  gt(
                    supplierPaymentRefundRequests.requestedAt,
                    input.cursor.requestedAt,
                  ),
                  and(
                    eq(
                      supplierPaymentRefundRequests.requestedAt,
                      input.cursor.requestedAt,
                    ),
                    gt(supplierPaymentRefundRequests.id, input.cursor.id),
                  ),
                ),
          ),
        )
        .orderBy(
          asc(supplierPaymentRefundRequests.requestedAt),
          asc(supplierPaymentRefundRequests.id),
        )
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      return {
        rows: page.map((row) => {
          let cashSource: RefundCashSource | null = null;
          try {
            cashSource =
              refundCashSource(
                storedCashSource(
                  { ...row, paymentMethod: row.refundMethod },
                  false,
                  "refundMethod",
                ),
              ) ?? null;
          } catch {
            // Approval rejects legacy or corrupt cash evidence; the queue remains rejectable.
          }
          return { ...row, cashSource };
        }),
        hasMore,
        nextCursor:
          hasMore && last
            ? { requestedAt: last.requestedAt, id: Number(last.id) }
            : null,
      };
    },
    { gate: "NONE" },
  );
}

export async function listSupplierPaymentSources(
  input: {
    branchId: number;
    supplierId?: number;
    purchaseOrderId?: number;
    limit?: number;
    cursor?: { invoiceDate: string; id: number } | null;
  },
  actor: Actor,
) {
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  return withTx(
    async (tx) => {
      const book = supplierBookInvoiceTotalsSql(supplierInvoices.id);
      const postedAmount = sql<string>`${book.paidAmount} + COALESCE((
        SELECT SUM(spa.allocatedAmount - spa.refundedAmount)
        FROM supplierPaymentAllocations spa
        WHERE spa.supplierInvoiceId = ${supplierInvoices.id}
      ), 0)`;
      const postedCurrencyAmount = sql<string>`${book.paidCurrencyAmount} + COALESCE((
        SELECT SUM(spa.allocatedCurrencyAmount - spa.refundedCurrencyAmount)
        FROM supplierPaymentAllocations spa
        WHERE spa.supplierInvoiceId = ${supplierInvoices.id}
      ), 0)`;
      const pendingAmount = sql<string>`COALESCE((
        SELECT SUM(spra.requestedAmount)
        FROM supplierPaymentRequestAllocations spra
        INNER JOIN supplierPaymentRequests spr ON spr.id = spra.requestId
        WHERE spra.supplierInvoiceId = ${supplierInvoices.id}
          AND spr.status = 'PENDING'
      ), 0)`;
      const pendingCurrencyAmount = sql<string>`COALESCE((
        SELECT SUM(spra.requestedCurrencyAmount)
        FROM supplierPaymentRequestAllocations spra
        INNER JOIN supplierPaymentRequests spr ON spr.id = spra.requestId
        WHERE spra.supplierInvoiceId = ${supplierInvoices.id}
          AND spr.status = 'PENDING'
      ), 0)`;
      const formalCredit = supplierFormalCreditTotalsSql(supplierInvoices.id);
      const netCreditReturns = formalCredit.amount;
      const remainingAmount = sql<string>`GREATEST(
        GREATEST(${supplierInvoices.totalAmount} - ${netCreditReturns} - ${book.creditedAmount}, 0)
        - ${supplierInvoices.legacySettledAmount}
        - (${postedAmount})
        - ${pendingAmount},
        0
      )`;
      const remainingCurrencyAmount = sql<string>`CASE
        WHEN ${supplierInvoices.currency} = 'IQD' THEN ${remainingAmount}
        WHEN ${supplierInvoices.agreedRate} > 0 THEN GREATEST(
          ${supplierInvoices.usdTotal}
          - ROUND(${supplierInvoices.usdTotal} * LEAST(GREATEST(${netCreditReturns},0), ${supplierInvoices.totalAmount}) / ${supplierInvoices.totalAmount}, 2)
          - ROUND(${supplierInvoices.legacySettledAmount} / ${supplierInvoices.agreedRate}, 2)
          - ${book.creditedCurrencyAmount}
          - (${postedCurrencyAmount})
          - ${pendingCurrencyAmount},
          0
        )
        ELSE 0
      END`;
      const eligibleWhere = and(
        formalCredit.eligible,
        eq(supplierInvoices.branchId, input.branchId),
        input.supplierId == null
          ? undefined
          : eq(supplierInvoices.supplierId, input.supplierId),
        input.purchaseOrderId == null
          ? undefined
          : or(
              eq(supplierInvoices.legacyPurchaseOrderId, input.purchaseOrderId),
              sql`EXISTS (
                SELECT 1
                FROM supplierInvoiceLines sil
                INNER JOIN purchaseOrderRevisionItems pori ON pori.id = sil.purchaseOrderRevisionItemId
                INNER JOIN purchaseOrderRevisions por ON por.id = pori.revisionId
                WHERE sil.supplierInvoiceId = ${supplierInvoices.id}
                  AND por.purchaseOrderId = ${input.purchaseOrderId}
              )`,
            ),
        eq(supplierInvoices.status, "POSTED"),
        eq(supplierInvoices.paymentGate, "OPEN"),
        or(
          eq(supplierInvoices.liabilityClass, "NATIVE_AP"),
          and(
            eq(supplierInvoices.liabilityClass, "LEGACY_AP"),
            sql`${supplierInvoices.legacySettlementEvidenceHash} IS NOT NULL`,
          ),
        ),
        sql`${remainingAmount} > 0`,
        sql`${remainingCurrencyAmount} > 0`,
      );
      const pageWhere = and(
        eligibleWhere,
        input.cursor == null
          ? undefined
          : or(
              gt(supplierInvoices.invoiceDate, input.cursor.invoiceDate),
              and(
                eq(supplierInvoices.invoiceDate, input.cursor.invoiceDate),
                gt(supplierInvoices.id, input.cursor.id),
              ),
            ),
      );
      const limit = Math.min(input.limit ?? 100, 200);
      const total = Number(
        (
          await tx
            .select({ count: sql<number>`COUNT(*)` })
            .from(supplierInvoices)
            .where(eligibleWhere)
        )[0]?.count ?? 0,
      );
      const invoices = await tx
        .select()
        .from(supplierInvoices)
        .where(pageWhere)
        .orderBy(asc(supplierInvoices.invoiceDate), asc(supplierInvoices.id))
        .limit(limit + 1);
      const hasMore = invoices.length > limit;
      const page = hasMore ? invoices.slice(0, limit) : invoices;
      if (!page.length)
        return { rows: [], hasMore: false, nextCursor: null, total };
      const ids = page.map((row) => Number(row.id));
      const reservations = await invoiceReservations(tx, ids);

      let invoicePoMap = new Map<number, number[]>();
      if (ids.length > 0) {
        const invoicePoRows = await tx
          .select({
            supplierInvoiceId: supplierInvoiceLines.supplierInvoiceId,
            purchaseOrderId: purchaseOrderRevisions.purchaseOrderId,
          })
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
            eq(
              purchaseOrderRevisions.id,
              purchaseOrderRevisionItems.revisionId,
            ),
          )
          .where(inArray(supplierInvoiceLines.supplierInvoiceId, ids));

        const tempMap = new Map<number, Set<number>>();
        for (const r of invoicePoRows) {
          const invId = Number(r.supplierInvoiceId);
          const poId = Number(r.purchaseOrderId);
          if (!tempMap.has(invId)) tempMap.set(invId, new Set<number>());
          tempMap.get(invId)!.add(poId);
        }
        for (const inv of page) {
          const invId = Number(inv.id);
          if (inv.legacyPurchaseOrderId != null) {
            if (!tempMap.has(invId)) tempMap.set(invId, new Set<number>());
            tempMap.get(invId)!.add(Number(inv.legacyPurchaseOrderId));
          }
        }
        invoicePoMap = new Map(
          Array.from(tempMap.entries()).map(([k, v]) => [k, Array.from(v)]),
        );
      }

      const rows = page.map((invoice) => {
        const paid = reservations.posted.get(Number(invoice.id)) ?? {
          amount: money(0),
          currencyAmount: money(0),
        };
        const pending = reservations.pending.get(Number(invoice.id)) ?? {
          amount: money(0),
          currencyAmount: money(0),
        };
        const creditReturns =
          reservations.creditReturns.get(Number(invoice.id)) ?? money(0);
        const effectiveTotal = effectiveInvoicePayable(
          invoice.totalAmount,
          creditReturns,
        );
        const sourceCurrency =
          invoice.currency === "USD"
            ? money(invoice.usdTotal).minus(
                reservations.creditCurrencyAmounts.get(Number(invoice.id)) ??
                  money(0),
              )
            : effectiveTotal;
        return {
          id: Number(invoice.id),
          invoiceNumber: invoice.invoiceNumber,
          externalInvoiceNumber: invoice.externalInvoiceNumber,
          supplierId: Number(invoice.supplierId),
          branchId: Number(invoice.branchId),
          version: Number(invoice.version),
          currency: invoice.currency,
          agreedRate: invoice.agreedRate,
          purchaseOrderIds: invoicePoMap.get(Number(invoice.id)) ?? [],
          totalAmount: toDbMoney(invoice.totalAmount),
          currencyTotal: toDbMoney(sourceCurrency),
          legacySettledAmount: toDbMoney(invoice.legacySettledAmount),
          paidAmount: toDbMoney(paid.amount),
          paidCurrencyAmount: toDbMoney(paid.currencyAmount),
          pendingAmount: toDbMoney(pending.amount),
          pendingCurrencyAmount: toDbMoney(pending.currencyAmount),
          netCreditReturnAmount: toDbMoney(creditReturns),
          remainingAmount: toDbMoney(
            DecimalMaxZero(
              effectiveTotal
                .minus(invoice.legacySettledAmount)
                .minus(paid.amount)
                .minus(pending.amount),
            ),
          ),
          remainingCurrencyAmount: toDbMoney(
            DecimalMaxZero(
              sourceCurrency
                .minus(legacyCurrencySettled(invoice))
                .minus(paid.currencyAmount)
                .minus(pending.currencyAmount),
            ),
          ),
        };
      });
      const last = page.at(-1);
      return {
        rows,
        hasMore,
        nextCursor:
          hasMore && last
            ? { invoiceDate: last.invoiceDate, id: Number(last.id) }
            : null,
        total,
      };
    },
    { gate: "NONE" },
  );
}

function DecimalMaxZero(value: ReturnType<typeof money>) {
  return value.isNegative() ? money(0) : value;
}

export async function listSupplierPaymentRefundSources(
  input: {
    branchId: number;
    supplierId?: number;
    limit?: number;
    cursor?: { postedAt: Date; id: number } | null;
  },
  actor: Actor,
) {
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  return withTx(
    async (tx) => {
      const eligibleWhere = and(
        eq(supplierPayments.branchId, input.branchId),
        input.supplierId == null
          ? undefined
          : eq(supplierPayments.supplierId, input.supplierId),
        sql`${supplierPayments.status} <> 'REFUNDED'`,
        sql`EXISTS (
          SELECT 1 FROM supplierPaymentAllocations spa
          WHERE spa.supplierPaymentId = ${supplierPayments.id}
            AND spa.allocatedAmount > spa.refundedAmount
            AND spa.allocatedCurrencyAmount > spa.refundedCurrencyAmount
        )`,
      );
      const pageWhere = and(
        eligibleWhere,
        input.cursor == null
          ? undefined
          : or(
              gt(supplierPayments.postedAt, input.cursor.postedAt),
              and(
                eq(supplierPayments.postedAt, input.cursor.postedAt),
                gt(supplierPayments.id, input.cursor.id),
              ),
            ),
      );
      const limit = Math.min(input.limit ?? 100, 200);
      const total = Number(
        (
          await tx
            .select({ count: sql<number>`COUNT(*)` })
            .from(supplierPayments)
            .where(eligibleWhere)
        )[0]?.count ?? 0,
      );
      const payments = await tx
        .select()
        .from(supplierPayments)
        .where(pageWhere)
        .orderBy(asc(supplierPayments.postedAt), asc(supplierPayments.id))
        .limit(limit + 1);
      const hasMore = payments.length > limit;
      const page = hasMore ? payments.slice(0, limit) : payments;
      if (!page.length)
        return { rows: [], hasMore: false, nextCursor: null, total };
      const allocations = await tx
        .select()
        .from(supplierPaymentAllocations)
        .where(
          inArray(
            supplierPaymentAllocations.supplierPaymentId,
            page.map((row) => Number(row.id)),
          ),
        )
        .orderBy(
          asc(supplierPaymentAllocations.supplierPaymentId),
          asc(supplierPaymentAllocations.id),
        );
      const byPayment = new Map<number, typeof allocations>();
      for (const allocation of allocations) {
        const list = byPayment.get(Number(allocation.supplierPaymentId)) ?? [];
        list.push(allocation);
        byPayment.set(Number(allocation.supplierPaymentId), list);
      }
      const rows = page
        .map((payment) => ({
          id: Number(payment.id),
          paymentNumber: payment.paymentNumber,
          supplierId: Number(payment.supplierId),
          branchId: Number(payment.branchId),
          version: Number(payment.version),
          status: payment.status,
          currency: payment.currency,
          derivesInvoiceCurrency: usesInvoiceCurrencySettlement(payment),
          exchangeRate: payment.exchangeRate,
          amount: payment.amount,
          currencyAmount: payment.currencyAmount,
          paymentMethod: payment.paymentMethod,
          postedAt: payment.postedAt,
          allocations: (byPayment.get(Number(payment.id)) ?? [])
            .map((allocation) => ({
              id: Number(allocation.id),
              supplierInvoiceId: Number(allocation.supplierInvoiceId),
              allocatedAmount: allocation.allocatedAmount,
              allocatedCurrencyAmount: allocation.allocatedCurrencyAmount,
              refundableAmount: toDbMoney(
                money(allocation.allocatedAmount).minus(
                  allocation.refundedAmount,
                ),
              ),
              refundableCurrencyAmount: toDbMoney(
                money(allocation.allocatedCurrencyAmount).minus(
                  allocation.refundedCurrencyAmount,
                ),
              ),
            }))
            .filter((allocation) => money(allocation.refundableAmount).gt(0)),
        }))
        .filter((payment) => payment.allocations.length > 0);
      const last = page.at(-1);
      return {
        rows,
        hasMore,
        nextCursor:
          hasMore && last
            ? { postedAt: last.postedAt, id: Number(last.id) }
            : null,
        total,
      };
    },
    { gate: "NONE" },
  );
}

export interface DeclaredPurchaseCashSource {
  mode: "DRAWER" | "TREASURY";
  shiftId: number | null;
  payerUserId: number;
  explicit: boolean;
}

export async function readDeclaredPurchaseCashSourceTx(
  tx: DB | Tx,
  purchaseOrderId: number,
  revisionId: number | null,
): Promise<DeclaredPurchaseCashSource | null> {
  const conds = [
    eq(purchaseOrderEvents.purchaseOrderId, purchaseOrderId),
    inArray(purchaseOrderEvents.eventType, [
      "ORDER_CREATED",
      "REVISION_CREATED",
    ]),
  ];
  if (revisionId != null) {
    conds.push(eq(purchaseOrderEvents.revisionId, revisionId));
  }
  const events = await tx
    .select({ payloadCanonical: purchaseOrderEvents.payloadCanonical })
    .from(purchaseOrderEvents)
    .where(and(...conds))
    .orderBy(desc(purchaseOrderEvents.id))
    .limit(5);
  for (const ev of events) {
    if (!ev.payloadCanonical) continue;
    try {
      const parsed = JSON.parse(ev.payloadCanonical) as {
        cashSource?: {
          mode?: unknown;
          shiftId?: unknown;
          payerUserId?: unknown;
          explicit?: unknown;
        } | null;
        payload?: {
          cashSource?: {
            mode?: unknown;
            shiftId?: unknown;
            payerUserId?: unknown;
            explicit?: unknown;
          } | null;
        } | null;
      };
      const rawCashSource =
        parsed.payload !== undefined && parsed.payload !== null
          ? parsed.payload.cashSource
          : parsed.cashSource;
      if (rawCashSource === null) return null;
      if (
        rawCashSource &&
        (rawCashSource.mode === "DRAWER" || rawCashSource.mode === "TREASURY")
      ) {
        const mode = rawCashSource.mode;
        const shiftId =
          mode === "DRAWER" &&
          Number.isSafeInteger(Number(rawCashSource.shiftId)) &&
          Number(rawCashSource.shiftId) > 0
            ? Number(rawCashSource.shiftId)
            : null;
        const payerUserId = Number(rawCashSource.payerUserId ?? 0);
        if (
          Number.isSafeInteger(payerUserId) &&
          payerUserId > 0 &&
          (mode === "TREASURY" || shiftId != null)
        ) {
          return {
            mode,
            shiftId,
            payerUserId,
            explicit: Boolean(rawCashSource.explicit),
          };
        }
      }
    } catch {
      // Ignore unrelated malformed payloads on historical rows.
    }
  }
  return null;
}

export async function resolveCashPurchaseSettlementPlanTx(
  tx: Tx,
  input: {
    purchaseOrder: Pick<
      typeof purchaseOrders.$inferSelect,
      "id" | "branchId" | "createdBy" | "currentRevisionId"
    >;
    reviewer: Actor;
    explicitCashSource?: CashSourceInput | null;
  },
): Promise<{
  mode: "DRAWER" | "TREASURY";
  shiftId: number | null;
  payerUserId: number;
}> {
  const branchId = Number(input.purchaseOrder.branchId);
  const creatorUserId =
    input.purchaseOrder.createdBy != null
      ? Number(input.purchaseOrder.createdBy)
      : null;
  const reviewerApproval = await resolveApprovalActor(tx, input.reviewer);

  if (input.explicitCashSource != null) {
    if (input.explicitCashSource.mode === "TREASURY") {
      if (input.explicitCashSource.shiftId != null) {
        throw cashSourceError("مصدر الخزينة لا يقبل رقم وردية", "BAD_REQUEST");
      }
      if (!reviewerApproval.isOwner) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر ترحيل وتسوية الفاتورة النقدية من الخزينة",
            why: "التنفيذ النقدي من الخزينة الرئيسية محصور بحساب مالك نشط",
            doThis:
              "ليعتمد المالك النشط الفاتورة النقدية، أو اختر وردية منشئ الفاتورة المفتوحة",
          }),
        });
      }
      return {
        mode: "TREASURY",
        shiftId: null,
        payerUserId: input.reviewer.userId,
      };
    }
    if (input.explicitCashSource.mode !== "DRAWER") {
      throw cashSourceError("نوع مصدر النقد غير صالح", "BAD_REQUEST");
    }
    let resolvedShiftId: number | null =
      input.explicitCashSource.shiftId != null
        ? Number(input.explicitCashSource.shiftId)
        : null;
    if (resolvedShiftId == null) {
      if (reviewerApproval.isOwner) {
        resolvedShiftId =
          (await openShiftIdTx(tx, input.reviewer.userId, branchId)) ??
          (creatorUserId != null
            ? await openShiftIdTx(tx, creatorUserId, branchId)
            : null);
      } else if (creatorUserId != null) {
        resolvedShiftId = await openShiftIdTx(tx, creatorUserId, branchId);
      }
    }
    if (!resolvedShiftId || resolvedShiftId <= 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذر ترحيل وتسوية الفاتورة النقدية من الدرج",
          why: "لا توجد وردية مفتوحة صالحة للصرف النقدي في هذا الفرع",
          doThis:
            "افتح وردية صالحة أولاً، أو اعتمد الفاتورة من الخزينة الرئيسية بحساب المالك النشط",
        }),
      });
    }
    const [shift] = await tx
      .select({
        id: shifts.id,
        branchId: shifts.branchId,
        userId: shifts.userId,
        status: shifts.status,
      })
      .from(shifts)
      .where(eq(shifts.id, resolvedShiftId))
      .limit(1);
    if (
      !shift ||
      shift.status !== "OPEN" ||
      Number(shift.branchId) !== branchId
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذر ترحيل وتسوية الفاتورة النقدية من الدرج",
          why: "الوردية المحددة غير مفتوحة أو لا تتبع فرع الفاتورة",
          doThis: "اختر وردية مفتوحة في نفس الفرع أو الخزينة الرئيسية",
        }),
      });
    }
    const shiftOwnerId = Number(shift.userId);
    const allowedOwner =
      (creatorUserId != null && shiftOwnerId === creatorUserId) ||
      (reviewerApproval.isOwner && shiftOwnerId === input.reviewer.userId);
    if (!allowedOwner) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذر خصم سداد الفاتورة النقدية من هذا الدرج",
          why: "لا يُخصم سداد الفاتورة النقدية من درج معتمد مستقل لا يخص منشئ الفاتورة",
          doThis:
            "استخدم درج منشئ الفاتورة المفتوح أو اعتمد الصرف من الخزينة الرئيسية بحساب المالك النشط",
        }),
      });
    }
    return {
      mode: "DRAWER",
      shiftId: Number(shift.id),
      payerUserId: shiftOwnerId,
    };
  }

  const tender = await readPurchaseTenderTx(
    tx,
    Number(input.purchaseOrder.id),
    input.purchaseOrder.currentRevisionId == null
      ? null
      : Number(input.purchaseOrder.currentRevisionId),
  );
  if (tender?.mode === "CARD")
    throw purchaseTenderError(
      "تعذر استبدال البطاقة بالنقد",
      "طريقة سداد النسخة المعتمدة هي بطاقة الشركة",
    );
  if (tender?.mode === "DRAWER" && tender.shiftId == null) {
    throw purchaseTenderError(
      "تعذر صرف المتبقي من الفاتورة",
      "مصدر الوردية المحدد لا يتضمن درجاً صالحاً؛ حدد الوردية صراحةً ولا تحول الصرف إلى الخزنة تلقائياً",
    );
  }
  const declared: DeclaredPurchaseCashSource | null = tender
    ? {
        mode: tender.mode,
        shiftId: tender.mode === "DRAWER" ? (tender.shiftId ?? null) : null,
        payerUserId: creatorUserId ?? input.reviewer.userId,
        explicit: true,
      }
    : await readDeclaredPurchaseCashSourceTx(
        tx,
        Number(input.purchaseOrder.id),
        input.purchaseOrder.currentRevisionId == null
          ? null
          : Number(input.purchaseOrder.currentRevisionId),
      );
  if (declared?.mode === "TREASURY") {
    if (!reviewerApproval.isOwner) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذر ترحيل وتسوية الفاتورة النقدية من الخزينة",
          why: "الفاتورة النقدية موجهة للصرف من الخزينة الرئيسية، والتنفيذ النقدي من الخزينة محصور بحساب مالك نشط",
          doThis: "ليعتمد المالك النشط هذه الفاتورة النقدية من الخزينة",
        }),
      });
    }
    return {
      mode: "TREASURY",
      shiftId: null,
      payerUserId: input.reviewer.userId,
    };
  }
  if (declared?.mode === "DRAWER" && declared.shiftId != null) {
    const [shift] = await tx
      .select({
        id: shifts.id,
        branchId: shifts.branchId,
        userId: shifts.userId,
        status: shifts.status,
      })
      .from(shifts)
      .where(eq(shifts.id, declared.shiftId))
      .limit(1);
    const isDeclaredShiftValid =
      Boolean(shift) &&
      shift!.status === "OPEN" &&
      Number(shift!.branchId) === branchId &&
      Number(shift!.userId) === declared.payerUserId;
    if (isDeclaredShiftValid) {
      return {
        mode: "DRAWER",
        shiftId: Number(shift!.id),
        payerUserId: Number(shift!.userId),
      };
    }
    if (declared.explicit) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذر ترحيل وتسوية الفاتورة النقدية",
          why: "وردية منشئ الفاتورة النقدية المحددة صراحةً أُغلقت أو لم تعد صالحة للصرف",
          doThis:
            "حدد مصدر الصرف صراحةً عند الاعتماد (الخزينة الرئيسية للمالك النشط، أو وردية مفتوحة صالحة)",
        }),
      });
    }
  }

  if (creatorUserId != null) {
    const creatorOpenShiftId = await openShiftIdTx(tx, creatorUserId, branchId);
    if (creatorOpenShiftId != null) {
      return {
        mode: "DRAWER",
        shiftId: creatorOpenShiftId,
        payerUserId: creatorUserId,
      };
    }
  }
  if (reviewerApproval.isOwner) {
    return {
      mode: "TREASURY",
      shiftId: null,
      payerUserId: input.reviewer.userId,
    };
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: appErrorMessage({
      what: "تعذر ترحيل وتسوية الفاتورة النقدية",
      why: "لا توجد وردية مفتوحة لمنشئ الفاتورة النقدية، والصرف من الخزينة الرئيسية محصور بحساب مالك نشط",
      doThis:
        "ليعتمد المالك النشط الفاتورة من الخزينة الرئيسية، أو ليرسلها المنشئ من ورديته المفتوحة",
    }),
  });
}

export async function prelockCashPurchaseSettlementInTx(
  tx: Tx,
  input: {
    purchaseOrder: Pick<
      typeof purchaseOrders.$inferSelect,
      "id" | "branchId" | "createdBy" | "currentRevisionId"
    >;
    reviewer: Actor;
    explicitCashSource?: CashSourceInput | null;
  },
) {
  const tender = await readPurchaseTenderTx(
    tx,
    Number(input.purchaseOrder.id),
    input.purchaseOrder.currentRevisionId == null
      ? null
      : Number(input.purchaseOrder.currentRevisionId),
  );
  // Prior allocations run under the exclusive governance gate. There may be no
  // new money out; never demand or substitute a live drawer for a fully paid PO.
  if (tender?.previousReceiptId != null || tender?.mode === "CARD") return null;
  const plan = await resolveCashPurchaseSettlementPlanTx(tx, input);
  await lockCashSourceForUpdate(tx, {
    branchId: Number(input.purchaseOrder.branchId),
    cashBucket: plan.mode,
    shiftId: plan.shiftId,
  });
  return plan;
}

/**
 * يسوي فاتورة شراء نقدية (CASH) ذرياً داخل نفس معاملة الترحيل بحيث تصبح ذمة الفاتورة صفراً
 * فور استلامها وترحيلها، مع توثيق كامل عبر supplierPaymentRequests وsupplierPayments وreceipts وPAYMENT_OUT.
 */
export async function settlePostedCashPurchaseInvoiceInTx(
  tx: Tx,
  input: {
    purchaseOrder: Pick<
      typeof purchaseOrders.$inferSelect,
      "id" | "poNumber" | "branchId" | "createdBy" | "currentRevisionId"
    >;
    invoice: typeof supplierInvoices.$inferSelect;
    actor: Actor;
    deterministicKey: string;
    cashSource?: CashSourceInput | null;
  },
) {
  if (input.invoice.currency !== "IQD") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر التسوية النقدية الفورية لفاتورة دولارية",
        why: "الفاتورة الدولارية تُسدَّد عبر مسار الصيرفة بالدولار لا بصرف نقدي ديناري مباشر",
        doThis:
          "استخدم التسوية الآجلة للفواتير الدولارية وسدّدها من مسار دفع المورد بالدولار",
      }),
    });
  }
  const requestKey = `${AUTO_PURCHASE_PAYMENT_PREFIX}${input.deterministicKey}`;
  const decisionKey = `auto-cash-po-ok:${input.deterministicKey}`;
  const reason = `تسوية نقدية فورية لفاتورة الشراء النقدية ${input.purchaseOrder.poNumber}`;
  const evidenceReference = `AUTO-CASH-PO:${input.deterministicKey}`;
  const tender = await readPurchaseTenderTx(
    tx,
    Number(input.purchaseOrder.id),
    input.purchaseOrder.currentRevisionId == null
      ? null
      : Number(input.purchaseOrder.currentRevisionId),
  );
  const isCard = tender?.mode === "CARD";
  if (isCard && input.cashSource != null) {
    throw purchaseTenderError(
      "تعذر تبديل مصدر السداد",
      "الفاتورة محددة ببطاقة الشركة ولا تقبل تجاوزاً نقدياً",
    );
  }

  const [existingRequest] = await tx
    .select()
    .from(supplierPaymentRequests)
    .where(eq(supplierPaymentRequests.requestKey, requestKey))
    .for("update")
    .limit(1);
  if (existingRequest) {
    const requestAllocations = await tx
      .select()
      .from(supplierPaymentRequestAllocations)
      .where(
        eq(
          supplierPaymentRequestAllocations.requestId,
          Number(existingRequest.id),
        ),
      )
      .for("update");
    if (
      Number(existingRequest.supplierId) !== Number(input.invoice.supplierId) ||
      Number(existingRequest.branchId) !== Number(input.invoice.branchId) ||
      existingRequest.currency !== "IQD" ||
      requestAllocations.length !== 1 ||
      Number(requestAllocations[0]?.supplierInvoiceId) !==
        Number(input.invoice.id) ||
      !money(requestAllocations[0]?.requestedAmount ?? "0").eq(
        existingRequest.requestedAmount,
      ) ||
      !money(requestAllocations[0]?.requestedCurrencyAmount ?? "0").eq(
        existingRequest.requestedCurrencyAmount,
      ) ||
      money(existingRequest.requestedAmount).gt(input.invoice.totalAmount) ||
      existingRequest.paymentMethod !== (isCard ? "CARD" : "CASH")
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذر إعادة تشغيل التسوية النقدية التلقائية",
          why: "مفتاح التسوية النقدية التلقائية مرتبط بفاتورة شراء مختلفة",
          doThis: "أرسل مفتاح طلب جديد مستقل لاعتماد أمر الشراء النقدي",
        }),
      });
    }
    if (existingRequest.status === "APPROVED") {
      const [existingPayment] = await tx
        .select({ id: supplierPayments.id })
        .from(supplierPayments)
        .where(eq(supplierPayments.requestId, Number(existingRequest.id)))
        .limit(1);
      if (!existingPayment) {
        throw purchaseTenderError(
          "تعذر استعادة نتيجة السداد",
          "طلب السداد معتمد دون سجل دفعة مرتبط؛ يلزم مراجعة الأثر المالي",
        );
      }
      const savedAllocations = await tx
        .select()
        .from(supplierPaymentAllocations)
        .where(
          eq(
            supplierPaymentAllocations.supplierPaymentId,
            Number(existingPayment.id),
          ),
        )
        .for("update");
      if (
        savedAllocations.length !== 1 ||
        Number(savedAllocations[0]?.supplierInvoiceId) !==
          Number(input.invoice.id) ||
        !money(savedAllocations[0]?.allocatedAmount ?? "0").eq(
          existingRequest.requestedAmount,
        ) ||
        !money(savedAllocations[0]?.allocatedCurrencyAmount ?? "0").eq(
          existingRequest.requestedCurrencyAmount,
        )
      ) {
        throw purchaseTenderError(
          "تعذر استعادة نتيجة السداد",
          "تخصيص الدفعة المحفوظة لا يطابق فاتورة الشراء الحالية",
        );
      }
      return {
        requestId: Number(existingRequest.id),
        supplierPaymentId: Number(existingPayment.id),
        idempotent: true as const,
      };
    }
    if (existingRequest.status === "PENDING") {
      const decided = await decideSupplierPaymentInTx(
        tx,
        {
          requestId: Number(existingRequest.id),
          decisionKey,
          action: "APPROVE",
          reviewReason: reason,
        },
        input.actor,
        SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
      );
      return {
        requestId: Number(existingRequest.id),
        supplierPaymentId: decided.supplierPaymentId,
        idempotent: Boolean(decided.idempotent),
      };
    }
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر إعادة تشغيل التسوية النقدية التلقائية",
        why: `طلب السداد التلقائي المرتبط بهذه الفاتورة في حالة (${existingRequest.status}) غير قابلة للاعتماد`,
        doThis:
          "راجع طلبات سداد المورد المرتبطة بهذه الفاتورة من شاشة دفعات الموردين",
      }),
    });
  }

  if (tender?.previousReceiptId != null) {
    await applyPurchasePriorPaymentInTx(tx, {
      receiptId: tender.previousReceiptId,
      invoiceId: Number(input.invoice.id),
      purchaseOrderId: Number(input.purchaseOrder.id),
      actor: input.actor,
    });
  }
  const [currentInvoice] = await tx
    .select()
    .from(supplierInvoices)
    .where(eq(supplierInvoices.id, Number(input.invoice.id)))
    .for("update")
    .limit(1);
  if (!currentInvoice)
    throw purchaseTenderError("تعذر إكمال السداد", "فاتورة المورد غير موجودة");
  const reserved = await invoiceReservations(tx, [Number(currentInvoice.id)]);
  const paid =
    reserved.posted.get(Number(currentInvoice.id))?.amount ?? money(0);
  const credited =
    reserved.creditReturns.get(Number(currentInvoice.id)) ?? money(0);
  if (
    (reserved.pending.get(Number(currentInvoice.id))?.amount ?? money(0)).gt(0)
  ) {
    throw purchaseTenderError(
      "تعذر إنشاء صرف إضافي",
      "يوجد طلب سداد معلق مرتبط بهذه الفاتورة",
    );
  }
  const remaining = money(currentInvoice.totalAmount)
    .minus(paid)
    .minus(credited);
  if (!remaining.gt(0)) {
    return {
      requestId: null,
      supplierPaymentId: null,
      idempotent: true as const,
    };
  }
  const totalAmount = toDbMoney(remaining);
  const plan = isCard
    ? {
        mode: null,
        shiftId: null,
        payerUserId: Number(
          input.purchaseOrder.createdBy ?? input.actor.userId,
        ),
      }
    : await resolveCashPurchaseSettlementPlanTx(tx, {
        purchaseOrder: input.purchaseOrder,
        reviewer: input.actor,
        explicitCashSource: input.cashSource,
      });
  if (isCard) {
    await assertPurchaseCardAccountTx(tx, tender.accountId);
    // Serialise same-account submissions before checking the documentary key.
    await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, tender.accountId))
      .for("update")
      .limit(1);
    const [duplicate] = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          eq(receipts.paymentMethod, "CARD"),
          eq(receipts.direction, "OUT"),
          eq(receipts.referenceNumber, tender.referenceNumber),
        ),
      )
      .for("update")
      .limit(1);
    if (duplicate)
      throw purchaseTenderError(
        "تعذر صرف البطاقة مرة أخرى",
        `يوجد سند مسجل بمرجع هذه العملية (#${duplicate.id})؛ اربط الدفعة السابقة`,
      );
  }

  const [payerUser] = await tx
    .select({
      id: users.id,
      role: users.role,
      isOwner: users.isOwner,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, plan.payerUserId))
    .for("share")
    .limit(1);
  if (isCard && (!payerUser || !payerUser.isActive)) {
    throw purchaseTenderError(
      "تعذر صرف بطاقة الشركة",
      "حساب منشئ طلب السداد غير موجود أو غير فعال",
    );
  }
  const payerActor: Actor = payerUser
    ? {
        userId: Number(payerUser.id),
        branchId: Number(input.invoice.branchId),
        role: payerUser.role,
        isOwner: Boolean(payerUser.isOwner),
      }
    : {
        userId: plan.payerUserId,
        branchId: Number(input.invoice.branchId),
        role: input.actor.role,
        isOwner:
          plan.payerUserId === input.actor.userId
            ? Boolean(input.actor.isOwner)
            : false,
      };

  const createdRequest = await requestSupplierPaymentInTx(
    tx,
    {
      supplierId: Number(input.invoice.supplierId),
      branchId: Number(input.invoice.branchId),
      requestKey,
      currency: "IQD",
      exchangeRate: null,
      amount: totalAmount,
      currencyAmount: totalAmount,
      paymentMethod: isCard ? "CARD" : "CASH",
      cashSource: isCard
        ? null
        : { mode: plan.mode as "DRAWER" | "TREASURY", shiftId: plan.shiftId },
      externalReference: isCard ? tender.referenceNumber : null,
      evidenceType: isCard ? "BANK_ADVICE" : "CASH_ACKNOWLEDGEMENT",
      evidenceReference: isCard ? tender.referenceNumber : evidenceReference,
      reason,
      allocations: [
        {
          supplierInvoiceId: Number(input.invoice.id),
          invoiceVersion: Number(currentInvoice.version),
          amount: totalAmount,
          currencyAmount: totalAmount,
        },
      ],
    },
    payerActor,
    { pendingGuardOverride: `SUPPLIER-PAY-AUTO-CASH:${input.invoice.id}` },
  );

  const decided = await decideSupplierPaymentInTx(
    tx,
    {
      requestId: createdRequest.requestId,
      decisionKey,
      action: "APPROVE",
      reviewReason: reason,
    },
    input.actor,
    SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
  );
  if (decided.status !== "APPROVED" || decided.supplierPaymentId == null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر إتمام التسوية النقدية الذرية لفاتورة الشراء النقدية",
        why: `قرار سداد الفاتورة النقدية لم يكتمل بحالة معتمدة (${decided.status})`,
        doThis:
          "أعد محاولة اعتماد أمر الشراء النقدي وتأكد من كفاية النقد في مصدر الصرف المختار",
      }),
    });
  }
  if (isCard) {
    const [payment] = await tx
      .select({ receiptId: supplierPayments.receiptId })
      .from(supplierPayments)
      .where(eq(supplierPayments.id, decided.supplierPaymentId))
      .limit(1);
    if (payment?.receiptId == null)
      throw purchaseTenderError(
        "تعذر توثيق البطاقة",
        "سند الصرف المرتبط غير موجود",
      );
    await tx
      .update(receipts)
      .set({ cardLastFour: tender.cardLastFour })
      .where(eq(receipts.id, payment.receiptId));
  }
  return {
    requestId: createdRequest.requestId,
    supplierPaymentId: decided.supplierPaymentId,
    idempotent: false as const,
  };
}
