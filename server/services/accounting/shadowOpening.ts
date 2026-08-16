import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import type { DB, Tx } from "../../db";
import { getDb } from "../../db";
import {
  assetMaintenance,
  branchStock,
  accountingEntries,
  cashTransfers,
  customers,
  deliveryConsignments,
  deliveryLedgerEntries,
  digitalWallets,
  doubleEntrySettings,
  employeeAdvances,
  exchangeHouses,
  exchangeTransactions,
  fixedAssets,
  invoices,
  installmentLines,
  journalEntries,
  journalLines,
  orderPayments,
  payrollObligations,
  payrollRuns,
  productVariants,
  products,
  purchaseOrders,
  receipts,
  receptionDrafts,
  shifts,
  suppliers,
  workOrders,
} from "../../../drizzle/schema";
import { money, round2 } from "../money";
import { verifyPostingIntentEvidence } from "./postingEngine";

/**
 * The roles below are the balance-sheet roles backed by an authoritative
 * operational balance in the current system.  Revenue/expense/equity roles are
 * deliberately absent: fabricating them from a balancing difference would turn
 * the cut-over preview into an accounting estimate rather than a reconciliation.
 */
export const CONFIRMED_OPERATIONAL_ROLES = [
  "CASH",
  "TREASURY_CASH",
  "CARD_BANK",
  "CHECKS_RECEIVABLE",
  "PAYMENT_WALLET",
  "TELECOM_BALANCE",
  "CASH_IN_TRANSIT",
  "INTERBRANCH_CLEARING",
  "INVENTORY",
  "WORK_IN_PROGRESS",
  "AR",
  "EMPLOYEE_ADVANCES",
  "FIXED_ASSETS",
  "ACCUMULATED_DEPRECIATION",
  "AP",
  "CONSIGNMENT_PAYABLE",
  "COURIER_PAYABLE",
  "OTHER_LIABILITY",
  "TAX_PAYABLE",
  "DELIVERY_FLOAT",
  "EXCHANGE_WALLET_IQD",
  "EXCHANGE_WALLET_USD",
  "EXCHANGE_RECEIVABLE_IQD",
  "EXCHANGE_RECEIVABLE_USD",
  "EXCHANGE_PAYABLE_IQD",
  "EXCHANGE_PAYABLE_USD",
  "FOREIGN_CASH_USD",
  "DIGITAL_WALLET",
  "ACCRUED_SALARY",
  "PAYROLL_TAX_PAYABLE",
  "SOCIAL_SECURITY_PAYABLE",
  "EOS_PROVISION",
  "ACCRUED_EXPENSES",
  "CAPITAL",
] as const;

export type ConfirmedOperationalRole =
  (typeof CONFIRMED_OPERATIONAL_ROLES)[number];

export const SHADOW_OPENING_ALLOCATION_ROLES = [
  "CAPITAL",
  "RETAINED_EARNINGS",
  "OWNER_CURRENT",
  "LOAN_PAYABLE",
] as const;

export type ShadowOpeningAllocationRole =
  (typeof SHADOW_OPENING_ALLOCATION_ROLES)[number];

const SHADOW_OPENING_STORED_ROLES = new Set<string>([
  ...CONFIRMED_OPERATIONAL_ROLES,
  ...SHADOW_OPENING_ALLOCATION_ROLES,
]);

export interface ShadowOpeningAllocation {
  role: ShadowOpeningAllocationRole;
  branchId: number | null;
  debit: string;
  credit: string;
}

/** Roles whose operational source retains a real branch dimension. */
export const BRANCH_OPERATIONAL_ROLES = new Set<ConfirmedOperationalRole>([
  "CASH",
  "TREASURY_CASH",
  "CARD_BANK",
  "CHECKS_RECEIVABLE",
  "PAYMENT_WALLET",
  "TELECOM_BALANCE",
  "CASH_IN_TRANSIT",
  "INTERBRANCH_CLEARING",
  "INVENTORY",
  "WORK_IN_PROGRESS",
  "EMPLOYEE_ADVANCES",
  "FIXED_ASSETS",
  "ACCUMULATED_DEPRECIATION",
  "COURIER_PAYABLE",
  "OTHER_LIABILITY",
  "TAX_PAYABLE",
  "DELIVERY_FLOAT",
  "FOREIGN_CASH_USD",
  "DIGITAL_WALLET",
  "ACCRUED_SALARY",
  "PAYROLL_TAX_PAYABLE",
  "SOCIAL_SECURITY_PAYABLE",
  "EOS_PROVISION",
  "ACCRUED_EXPENSES",
  "CAPITAL",
]);

export interface ShadowOpeningBlocker {
  code:
    | "SNAPSHOT_DATE_MISMATCH"
    | "CASH_BUCKET_MISSING"
    | "COURIER_PAYABLE_NEGATIVE"
    | "DELIVERY_LEDGER_INCONSISTENT"
    | "EXCHANGE_CONTROL_SOURCE_INVALID"
    | "FOREIGN_CASH_SOURCE_INVALID"
    | "CHECK_SOURCE_AMBIGUOUS"
    | "PAYROLL_OBLIGATION_INCONSISTENT"
    | "PAYROLL_LEGACY_UNCOVERED"
    | "ACCRUED_EXPENSE_SOURCE_INVALID"
    | "TAX_SOURCE_UNSUPPORTED"
    | "BALANCE_SHEET_SOURCE_UNCONFIRMED"
    | "JOURNAL_UNBALANCED";
  source: string;
  message: string;
  count: number;
  amount: string;
}

export interface OperationalBalance {
  role: ConfirmedOperationalRole;
  /** null means a valid company-wide/unallocated amount, never "all branches". */
  branchId: number | null;
  /** Signed balance in the ledger convention: debit positive, credit negative. */
  netDebit: string;
  sources: string[];
}

export interface OperationalBalanceSnapshot {
  asOf: string;
  snapshotDate: string;
  balances: OperationalBalance[];
  blockers: ShadowOpeningBlocker[];
}

export interface ShadowOpeningLine extends Omit<OperationalBalance, "role"> {
  role: ConfirmedOperationalRole | ShadowOpeningAllocationRole;
  debit: string;
  credit: string;
}

export interface ShadowOpeningPreview {
  cycleId: string;
  sourceKey: string;
  asOf: string;
  snapshotDate: string;
  hashVersion: 1;
  openingHash: string;
  canApprove: boolean;
  manualAllocations: ShadowOpeningAllocation[];
  unallocatedOpeningBalance: {
    debit: string;
    credit: string;
    scopes: Array<{
      branchId: number | null;
      /** Signed allocation still required: debit positive, credit negative. */
      netDebit: string;
      debit: string;
      credit: string;
    }>;
  };
  lines: ShadowOpeningLine[];
  journalGroups: Array<{
    branchId: number | null;
    sourceKey: string;
    lines: ShadowOpeningLine[];
    debit: string;
    credit: string;
  }>;
  roleTotals: Array<{
    role: ConfirmedOperationalRole | ShadowOpeningAllocationRole;
    netDebit: string;
    debit: string;
    credit: string;
  }>;
  branchTotals: Array<{
    branchId: number | null;
    debit: string;
    credit: string;
    difference: string;
    isBalanced: boolean;
  }>;
  totals: {
    debit: string;
    credit: string;
    difference: string;
    isBalanced: boolean;
  };
  blockers: ShadowOpeningBlocker[];
}

export interface StoredShadowOpeningVerification {
  cycleId: string;
  expectedHash: string;
  exists: boolean;
  hashMatches: boolean;
  balanced: boolean;
  sourceKeysValid: boolean;
  postingProfilesValid: boolean;
  openingHash: string | null;
  asOf: string | null;
  entryCount: number;
  lineCount: number;
}

type MutableBalance = {
  role: ConfirmedOperationalRole;
  branchId: number | null;
  netDebit: ReturnType<typeof money>;
  sources: Set<string>;
};

type ReadDb = DB | Tx;

function requireDb(db?: ReadDb): ReadDb {
  const resolved = db ?? getDb();
  if (!resolved) throw new Error("DATABASE_URL not set");
  return resolved;
}

function validYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

const SYSTEM_PAYMENT_REQUEST_PREFIX = "@SYSTEM_PAYMENT_REQUEST:";

type RecognizedAccrualRequest =
  | {
      kind: "PURCHASE_SHIPPING";
      purchaseOrderId: number;
      requestToken: string;
      expectedAmount: string;
      sourceShippingTotal: string;
    }
  | { kind: "ASSET_MAINTENANCE"; assetId: number; maintenanceId: number }
  | { kind: "ASSET_ACQUISITION"; assetId: number };

function parseRecognizedAccrualRequest(
  note: string | null,
): RecognizedAccrualRequest | null {
  if (!note?.startsWith(SYSTEM_PAYMENT_REQUEST_PREFIX)) return null;
  try {
    const value = JSON.parse(
      note.slice(SYSTEM_PAYMENT_REQUEST_PREFIX.length),
    ) as Record<string, unknown>;
    if (value.kind === "PURCHASE_SHIPPING") {
      return value as RecognizedAccrualRequest;
    }
    if (
      value.kind === "ASSET_MAINTENANCE" ||
      value.kind === "ASSET_ACQUISITION"
    ) {
      return value as RecognizedAccrualRequest;
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolve the isolated OFF→SHADOW cycle, or accept the coordinator's new id before it is stored. */
export async function resolveShadowCycleId(
  dbHandle: ReadDb,
  requested?: string,
): Promise<string> {
  const db = dbHandle as DB;
  const explicit = requested?.trim();
  const cycleId =
    explicit ||
    (
      await db
        .select({ cycleId: doubleEntrySettings.shadowCycleId })
        .from(doubleEntrySettings)
        .where(eq(doubleEntrySettings.id, 1))
        .limit(1)
    )[0]?.cycleId;
  if (!cycleId || !/^[A-Za-z0-9_-]{1,36}$/.test(cycleId)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "معرّف دورة الظل مفقود أو غير صالح؛ لا يمكن إنشاء افتتاحٍ بلا دورة معزولة.",
    });
  }
  return cycleId;
}

function scopeKey(role: string, branchId: number | null): string {
  return `${role}\u0000${branchId == null ? "GLOBAL" : String(branchId)}`;
}

function branchSort(a: number | null, b: number | null): number {
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  return a - b;
}

function ordinalText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function toSides(netDebit: ReturnType<typeof money>): {
  debit: string;
  credit: string;
} {
  const rounded = round2(netDebit);
  if (rounded.isPositive())
    return { debit: rounded.toFixed(2), credit: "0.00" };
  if (rounded.isNegative())
    return { debit: "0.00", credit: rounded.abs().toFixed(2) };
  return { debit: "0.00", credit: "0.00" };
}

function normalizeAllocations(
  input: readonly ShadowOpeningAllocation[],
): ShadowOpeningAllocation[] {
  const allowed = new Set<string>(SHADOW_OPENING_ALLOCATION_ROLES);
  const seen = new Set<string>();
  const normalized: ShadowOpeningAllocation[] = [];
  for (const allocation of input) {
    if (!allowed.has(allocation.role)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "دور تخصيص الرصيد الافتتاحي غير مسموح.",
      });
    }
    if (
      allocation.branchId != null &&
      (!Number.isSafeInteger(allocation.branchId) || allocation.branchId <= 0)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "نطاق فرع تخصيص الرصيد الافتتاحي غير صالح.",
      });
    }
    let debit: ReturnType<typeof money>;
    let credit: ReturnType<typeof money>;
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(allocation.debit) ||
      !/^\d+(?:\.\d{1,2})?$/.test(allocation.credit)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "مبلغ تخصيص الرصيد الافتتاحي يجب أن يكون رقماً عشرياً صريحاً بدقة لا تتجاوز فلسين.",
      });
    }
    try {
      debit = money(allocation.debit);
      credit = money(allocation.credit);
    } catch {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "مبلغ تخصيص الرصيد الافتتاحي غير صالح.",
      });
    }
    if (
      debit.isNegative() ||
      credit.isNegative() ||
      !debit.eq(round2(debit)) ||
      !credit.eq(round2(credit)) ||
      debit.isZero() === credit.isZero()
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "كل تخصيص افتتاحي يجب أن يكون موجباً على جانب واحد فقط وبدقة فلسين.",
      });
    }
    const duplicateKey = scopeKey(allocation.role, allocation.branchId);
    if (seen.has(duplicateKey)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يجوز تكرار الدور نفسه داخل نطاق التخصيص الافتتاحي.",
      });
    }
    seen.add(duplicateKey);
    normalized.push({
      role: allocation.role,
      branchId: allocation.branchId,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
    });
  }
  return normalized.sort(
    (a, b) => branchSort(a.branchId, b.branchId) || ordinalText(a.role, b.role),
  );
}

type HashLine = Pick<
  ShadowOpeningLine,
  "role" | "branchId" | "debit" | "credit"
>;

/** The one canonical representation used by preview and ACTIVE verification. */
export function computeShadowOpeningHash(input: {
  cycleId: string;
  asOf: string;
  lines: HashLine[];
}): string {
  const sourceKey = `SHADOW_OPENING:${input.cycleId}:${input.asOf}`;
  const lines = input.lines
    .map(({ role, branchId, debit, credit }) => ({
      role,
      branchId,
      debit,
      credit,
    }))
    .sort(
      (a, b) =>
        branchSort(a.branchId, b.branchId) ||
        ordinalText(a.role, b.role) ||
        ordinalText(a.debit, b.debit) ||
        ordinalText(a.credit, b.credit),
    );
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        cycleId: input.cycleId,
        sourceKey,
        asOf: input.asOf,
        lines,
      }),
      "utf8",
    )
    .digest("hex");
}

async function databaseToday(db: DB): Promise<string> {
  const result = await db.execute(
    sql`SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+03:00'), '%Y-%m-%d') AS today`,
  );
  const row = (result as unknown as [Array<{ today: string }>])[0][0];
  return String(row.today);
}

/**
 * Reads one coherent cut-over snapshot.  This function never writes.  Cached
 * balances (AR/AP/stock/wallets/assets) are authoritative only for the database
 * day on which they are read; a historical/future `asOf` therefore remains
 * visible but is blocked from approval instead of being silently back-cast.
 */
export async function readOperationalBalanceSnapshot(
  input: {
    asOf?: string;
    db?: ReadDb;
  } = {},
): Promise<OperationalBalanceSnapshot> {
  const db = requireDb(input.db) as DB;
  const snapshotDate = await databaseToday(db);
  const asOf = input.asOf ?? snapshotDate;
  if (!validYmd(asOf)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تاريخ لقطة الافتتاح غير صالح.",
    });
  }

  const blockers: ShadowOpeningBlocker[] = [];
  if (asOf !== snapshotDate) {
    blockers.push({
      code: "SNAPSHOT_DATE_MISMATCH",
      source: "CURRENT_BALANCE_CACHES",
      message:
        "أرصدة الذمم والمخزون والمحافظ والأصول لقطاتٌ حالية؛ لا يجوز اعتمادها كلقطة تاريخية أو مستقبلية.",
      count: 1,
      amount: "0.00",
    });
  }

  const aggregate = new Map<string, MutableBalance>();
  const add = (
    role: ConfirmedOperationalRole,
    branchId: number | null,
    value: string | number | ReturnType<typeof money>,
    source: string,
  ) => {
    const amount = money(value);
    if (amount.isZero()) return;
    const key = scopeKey(role, branchId);
    const current = aggregate.get(key);
    if (current) {
      current.netDebit = current.netDebit.plus(amount);
      current.sources.add(source);
      return;
    }
    aggregate.set(key, {
      role,
      branchId,
      netDebit: amount,
      sources: new Set([source]),
    });
  };
  const [
    customerRows,
    supplierRows,
    stockRows,
    receiptRows,
    shiftRows,
    deliveryRows,
    courierPayableRows,
    shopFeeRows,
    exchangeRows,
    foreignCashRows,
    walletRows,
    assetRows,
    advanceRows,
    cashTransferRows,
    workOrderDepositRows,
    draftDepositRows,
    taxRows,
    capitalRows,
    bouncedCheckRows,
    payrollObligationRows,
    payrollRunRows,
    accrualEntryRows,
    systemRequestRows,
    purchaseOrderRows,
    maintenanceRows,
  ] = await Promise.all([
    db.select({ balance: customers.currentBalance }).from(customers),
    db
      .select({
        balance: suppliers.currentBalance,
        kind: suppliers.supplierKind,
      })
      .from(suppliers),
    db
      .select({
        branchId: branchStock.branchId,
        quantity: branchStock.quantity,
        costPrice: productVariants.costPrice,
      })
      .from(branchStock)
      .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(eq(products.isConsignment, false), eq(products.isService, false)),
      ),
    db
      .select({
        id: receipts.id,
        branchId: receipts.branchId,
        direction: receipts.direction,
        amount: receipts.amount,
        paymentMethod: receipts.paymentMethod,
        cashBucket: receipts.cashBucket,
        shiftId: receipts.shiftId,
        referenceNumber: receipts.referenceNumber,
        checkNumber: receipts.checkNumber,
        internalNote: receipts.internalNote,
        partyType: receipts.partyType,
        partyId: receipts.partyId,
      })
      .from(receipts)
      .where(
        sql`${receipts.approvalStatus} = 'APPROVED'
              AND ${receipts.createdAt} < CONVERT_TZ(DATE_ADD(${asOf}, INTERVAL 1 DAY), '+03:00', '+00:00')`,
      ),
    db
      .select({
        id: shifts.id,
        branchId: shifts.branchId,
        openingBalance: shifts.openingBalance,
      })
      .from(shifts)
      .where(
        sql`${shifts.status} = 'OPEN'
              AND ${shifts.openedAt} < CONVERT_TZ(DATE_ADD(${asOf}, INTERVAL 1 DAY), '+03:00', '+00:00')`,
      ),
    db
      .select({
        branchId: deliveryLedgerEntries.branchId,
        gross: sql<string>`CAST(COALESCE(SUM(CASE
          WHEN ${deliveryLedgerEntries.entryType} = 'COD_COLLECTED' THEN ${deliveryLedgerEntries.amount}
          WHEN ${deliveryLedgerEntries.entryType} IN ('COD_REMITTED', 'COD_WRITTEN_OFF') THEN -${deliveryLedgerEntries.amount}
          ELSE 0 END), 0) AS CHAR)`,
        customerBacked: sql<string>`CAST(COALESCE(SUM(CASE
          WHEN ${invoices.customerId} IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM accountingEntries ae
              WHERE ae.dedupeKey = CONCAT('PAYMENT_IN:COURIER_DELIVERY:', ${deliveryConsignments.id})
            )
          THEN CASE
            WHEN ${deliveryLedgerEntries.entryType} = 'COD_COLLECTED' THEN ${deliveryLedgerEntries.amount}
            WHEN ${deliveryLedgerEntries.entryType} IN ('COD_REMITTED', 'COD_WRITTEN_OFF') THEN -${deliveryLedgerEntries.amount}
            ELSE 0 END
          ELSE 0 END), 0) AS CHAR)`,
      })
      .from(deliveryLedgerEntries)
      .leftJoin(
        deliveryConsignments,
        eq(deliveryConsignments.id, deliveryLedgerEntries.consignmentId),
      )
      .leftJoin(invoices, eq(invoices.id, deliveryConsignments.invoiceId))
      .where(
        sql`${deliveryLedgerEntries.occurredAt} < CONVERT_TZ(DATE_ADD(${asOf}, INTERVAL 1 DAY), '+03:00', '+00:00')`,
      )
      .groupBy(deliveryLedgerEntries.branchId),
    db
      .select({
        branchId: accountingEntries.branchId,
        amount: accountingEntries.amount,
      })
      .from(accountingEntries)
      .where(
        and(
          eq(accountingEntries.entryType, "DELIVERY_FEE_HELD"),
          sql`${accountingEntries.entryDate} <= ${asOf}`,
        ),
      ),
    db
      .select({
        branchId: deliveryLedgerEntries.branchId,
        amount: sql<string>`CAST(COALESCE(SUM(CASE
          WHEN ${deliveryLedgerEntries.entryType} = 'FEE_EARNED' THEN ${deliveryLedgerEntries.amount}
          WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID', 'FEE_OFFSET', 'FEE_REFUNDED') THEN -${deliveryLedgerEntries.amount}
          ELSE 0 END), 0) AS CHAR)`,
      })
      .from(deliveryLedgerEntries)
      .innerJoin(
        deliveryConsignments,
        eq(deliveryConsignments.id, deliveryLedgerEntries.consignmentId),
      )
      .where(
        sql`${deliveryConsignments.feeCollection} = 'SHOP'
              AND ${deliveryLedgerEntries.occurredAt} < CONVERT_TZ(DATE_ADD(${asOf}, INTERVAL 1 DAY), '+03:00', '+00:00')`,
      )
      .groupBy(deliveryLedgerEntries.branchId),
    db
      .select({
        id: exchangeHouses.id,
        balanceIqd: exchangeHouses.balanceIqd,
        balanceUsd: exchangeHouses.balanceUsd,
        balanceUsdCarryingIqd: exchangeHouses.balanceUsdCarryingIqd,
      })
      .from(exchangeHouses),
    db
      .select({
        exchangeHouseId: exchangeTransactions.exchangeHouseId,
        branchId: exchangeTransactions.branchId,
        type: exchangeTransactions.type,
        usdAmount: exchangeTransactions.usdAmount,
        iqdAmount: exchangeTransactions.iqdAmount,
      })
      .from(exchangeTransactions)
      .where(
        sql`${exchangeTransactions.status} = 'ACTIVE'
              AND ${exchangeTransactions.currency} = 'USD'
              AND ${exchangeTransactions.type} IN ('FX_BUY', 'WITHDRAW', 'DEPOSIT')
              AND ${exchangeTransactions.createdAt} < CONVERT_TZ(DATE_ADD(${asOf}, INTERVAL 1 DAY), '+03:00', '+00:00')`,
      ),
    db
      .select({
        branchId: digitalWallets.branchId,
        balance: digitalWallets.currentBalance,
      })
      .from(digitalWallets),
    db
      .select({
        id: fixedAssets.id,
        branchId: fixedAssets.branchId,
        purchaseValue: fixedAssets.purchaseValue,
        accumulatedDepreciation: fixedAssets.accumulatedDepreciation,
      })
      .from(fixedAssets)
      .where(
        sql`${fixedAssets.status} IN ('active', 'maintenance')
              AND ${fixedAssets.purchaseDate} <= ${asOf}`,
      ),
    db
      .select({
        branchId: employeeAdvances.branchId,
        remaining: employeeAdvances.remaining,
      })
      .from(employeeAdvances)
      .where(eq(employeeAdvances.status, "ACTIVE")),
    db
      .select({
        fromBranchId: cashTransfers.fromBranchId,
        toBranchId: cashTransfers.toBranchId,
        amount: cashTransfers.amount,
        status: cashTransfers.status,
      })
      .from(cashTransfers)
      .where(
        sql`${cashTransfers.status} IN ('IN_TRANSIT', 'RECEIVED')
              AND ${cashTransfers.sentAt} < CONVERT_TZ(DATE_ADD(${asOf}, INTERVAL 1 DAY), '+03:00', '+00:00')`,
      ),
    db
      .select({
        branchId: workOrders.branchId,
        deposit: workOrders.deposit,
        materialsCost: workOrders.materialsCost,
        status: workOrders.status,
        invoiceId: workOrders.invoiceId,
      })
      .from(workOrders)
      .where(sql`${workOrders.status} IN ('RECEIVED', 'IN_PROGRESS', 'READY')`),
    db
      .select({
        branchId: orderPayments.branchId,
        kind: orderPayments.kind,
        amount: orderPayments.amount,
      })
      .from(orderPayments)
      .innerJoin(receptionDrafts, eq(receptionDrafts.id, orderPayments.draftId))
      .where(
        sql`${receptionDrafts.status} = 'OPEN'
              AND ${orderPayments.kind} IN ('COLLECTION', 'REFUND')`,
      ),
    db
      .select({
        branchId: accountingEntries.branchId,
        entryType: accountingEntries.entryType,
        supplierId: accountingEntries.supplierId,
        taxAmount: accountingEntries.taxAmount,
      })
      .from(accountingEntries)
      .where(
        sql`${accountingEntries.entryDate} <= ${asOf}
              AND ${accountingEntries.taxAmount} <> 0`,
      ),
    db
      .select({
        branchId: accountingEntries.branchId,
        amount: accountingEntries.amount,
      })
      .from(accountingEntries)
      .where(
        and(
          eq(accountingEntries.entryType, "TREASURY_FUNDING"),
          sql`${accountingEntries.entryDate} <= ${asOf}`,
        ),
      ),
    db
      .select({
        id: installmentLines.id,
        receiptId: installmentLines.receiptId,
        status: installmentLines.status,
      })
      .from(installmentLines)
      .where(sql`${installmentLines.kind} = 'CHECK' AND ${installmentLines.status} = 'BOUNCED'`),
    db
      .select({
        id: payrollObligations.id,
        runId: payrollObligations.runId,
        itemId: payrollObligations.itemId,
        branchId: payrollObligations.branchIdSnapshot,
        revisionNo: payrollObligations.revisionNo,
        kind: payrollObligations.kind,
        originalAmount: payrollObligations.originalAmount,
        remainingAmount: payrollObligations.remainingAmount,
        status: payrollObligations.status,
        sourceType: payrollObligations.sourceType,
        sourceKey: payrollObligations.sourceKey,
      })
      .from(payrollObligations)
      .where(
        sql`${payrollObligations.createdAt} < CONVERT_TZ(DATE_ADD(${asOf}, INTERVAL 1 DAY), '+03:00', '+00:00')`,
      ),
    db
      .select({
        id: payrollRuns.id,
        status: payrollRuns.status,
        revisionNo: payrollRuns.revisionNo,
        approvalSnapshotHash: payrollRuns.approvalSnapshotHash,
        totalNet: payrollRuns.totalNet,
        totalIncomeTax: payrollRuns.totalIncomeTax,
        totalSocialSecurityEmployee: payrollRuns.totalSocialSecurityEmployee,
        totalSocialSecurityEmployer: payrollRuns.totalSocialSecurityEmployer,
        totalEndOfServiceAccrual: payrollRuns.totalEndOfServiceAccrual,
      })
      .from(payrollRuns)
      .where(
        sql`${payrollRuns.status} IN ('approved', 'paid')
              AND ${payrollRuns.period} <= ${asOf.slice(0, 7)}`,
      ),
    db
      .select({
        id: accountingEntries.id,
        entryType: accountingEntries.entryType,
        branchId: accountingEntries.branchId,
        receiptId: accountingEntries.receiptId,
        purchaseOrderId: accountingEntries.purchaseOrderId,
        amount: accountingEntries.amount,
        revenue: accountingEntries.revenue,
        cost: accountingEntries.cost,
        profit: accountingEntries.profit,
        taxAmount: accountingEntries.taxAmount,
        profile: accountingEntries.postingProfile,
        intentJson: accountingEntries.postingIntentJson,
        intentHash: accountingEntries.postingIntentHash,
        dedupeKey: accountingEntries.dedupeKey,
      })
      .from(accountingEntries)
      .where(
        sql`${accountingEntries.postingProfile} IN (
                'ADJUST_EXPENSE_ACCRUAL',
                'ADJUST_EXPENSE_ACCRUAL_REVERSAL',
                'PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT',
                'ADJUST_FIXED_ASSET_ACCRUAL',
                'ADJUST_FIXED_ASSET_ACCRUAL_REVERSAL',
                'PAYMENT_OUT_FIXED_ASSET_ACCRUAL_SETTLEMENT'
              )
              AND ${accountingEntries.entryDate} <= ${asOf}`,
      ),
    db
      .select({
        id: receipts.id,
        branchId: receipts.branchId,
        direction: receipts.direction,
        amount: receipts.amount,
        paymentMethod: receipts.paymentMethod,
        status: receipts.status,
        approvalStatus: receipts.approvalStatus,
        referenceNumber: receipts.referenceNumber,
        internalNote: receipts.internalNote,
      })
      .from(receipts)
      .where(
        sql`${receipts.internalNote} LIKE '@SYSTEM_PAYMENT_REQUEST:%'
              AND ${receipts.createdAt} < CONVERT_TZ(DATE_ADD(${asOf}, INTERVAL 1 DAY), '+03:00', '+00:00')`,
      ),
    db
      .select({
        id: purchaseOrders.id,
        branchId: purchaseOrders.branchId,
        poNumber: purchaseOrders.poNumber,
        shippingCost: purchaseOrders.shippingCost,
        customsCost: purchaseOrders.customsCost,
      })
      .from(purchaseOrders),
    db
      .select({
        id: assetMaintenance.id,
        assetId: assetMaintenance.assetId,
        cost: assetMaintenance.cost,
      })
      .from(assetMaintenance),
  ]);

  for (const row of customerRows)
    add("AR", null, row.balance, "customers.currentBalance");
  for (const row of supplierRows) {
    add(
      row.kind === "CONSIGNOR" ? "CONSIGNMENT_PAYABLE" : "AP",
      null,
      money(row.balance).negated(),
      "suppliers.currentBalance",
    );
  }
  for (const row of stockRows) {
    add(
      "INVENTORY",
      row.branchId,
      money(row.quantity).times(money(row.costPrice)),
      "branchStock.quantity×productVariants.costPrice",
    );
  }

  let missingCashBucketCount = 0;
  let missingCashBucketAmount = money(0);
  let ambiguousCheckCount = 0;
  let ambiguousCheckAmount = money(0);
  const openShiftIds = new Set(shiftRows.map((row) => Number(row.id)));
  const receiptsById = new Map(
    receiptRows.map((row) => [Number(row.id), row] as const),
  );
  const bouncedChecksByLine = new Map(
    bouncedCheckRows.map((row) => [Number(row.id), row] as const),
  );
  for (const row of receiptRows) {
    const signed =
      row.direction === "IN" ? money(row.amount) : money(row.amount).negated();
    if (row.paymentMethod === "CASH") {
      if (row.cashBucket === "DRAWER") {
        if (row.shiftId != null && openShiftIds.has(Number(row.shiftId))) {
          add("CASH", row.branchId, signed, "receipts.DRAWER.openShift");
        }
      } else if (row.cashBucket === "TREASURY") {
        add("TREASURY_CASH", row.branchId, signed, "receipts.TREASURY");
      } else {
        missingCashBucketCount += 1;
        missingCashBucketAmount = missingCashBucketAmount.plus(signed.abs());
      }
      continue;
    }
    if (["CARD", "TRANSFER"].includes(row.paymentMethod)) {
      add("CARD_BANK", row.branchId, signed, `receipts.${row.paymentMethod}`);
    } else if (row.paymentMethod === "CHECK") {
      const cancellationMatch = row.referenceNumber?.match(
        /^CANCEL-VCH-([1-9][0-9]*)$/,
      );
      const bounceMatch = row.referenceNumber?.match(
        /^BOUNCE-CHK-([1-9][0-9]*)$/,
      );
      if (cancellationMatch) {
        const original = receiptsById.get(Number(cancellationMatch[1]));
        if (
          !original ||
          original.paymentMethod !== "CHECK" ||
          original.direction === row.direction ||
          Number(original.branchId ?? 0) !== Number(row.branchId ?? 0) ||
          !money(original.amount).eq(money(row.amount))
        ) {
          ambiguousCheckCount += 1;
          ambiguousCheckAmount = ambiguousCheckAmount.plus(money(row.amount));
          continue;
        }
        add(
          original.direction === "IN" ? "CHECKS_RECEIVABLE" : "CARD_BANK",
          row.branchId,
          signed,
          "receipts.CHECK.canonicalVoucherCancellation",
        );
      } else if (bounceMatch) {
        const bounced = bouncedChecksByLine.get(Number(bounceMatch[1]));
        const original =
          bounced?.receiptId == null
            ? undefined
            : receiptsById.get(Number(bounced.receiptId));
        if (
          row.direction !== "OUT" ||
          !original ||
          original.paymentMethod !== "CHECK" ||
          original.direction !== "IN" ||
          Number(original.branchId ?? 0) !== Number(row.branchId ?? 0) ||
          !money(original.amount).eq(money(row.amount))
        ) {
          ambiguousCheckCount += 1;
          ambiguousCheckAmount = ambiguousCheckAmount.plus(money(row.amount));
          continue;
        }
        add(
          "CHECKS_RECEIVABLE",
          row.branchId,
          signed,
          "receipts.CHECK.canonicalInstallmentBounce",
        );
      } else if (
        row.referenceNumber?.startsWith("CANCEL-VCH-") ||
        row.referenceNumber?.startsWith("BOUNCE-CHK-")
      ) {
        ambiguousCheckCount += 1;
        ambiguousCheckAmount = ambiguousCheckAmount.plus(money(row.amount));
      } else {
        add(
          row.direction === "IN" ? "CHECKS_RECEIVABLE" : "CARD_BANK",
          row.branchId,
          signed,
          row.direction === "IN"
            ? "receipts.CHECK.incoming"
            : "receipts.CHECK.issued",
        );
      }
    } else if (row.paymentMethod === "WALLET") {
      add("PAYMENT_WALLET", row.branchId, signed, "receipts.WALLET");
    } else if (row.paymentMethod === "TELECOM") {
      add("TELECOM_BALANCE", row.branchId, signed, "receipts.TELECOM");
    }
  }
  for (const row of shiftRows) {
    add("CASH", row.branchId, row.openingBalance, "shifts.OPEN.openingBalance");
  }
  if (missingCashBucketCount > 0) {
    blockers.push({
      code: "CASH_BUCKET_MISSING",
      source: "receipts",
      message:
        "توجد إيصالات نقدية مكتملة بلا تحديد درج/خزينة؛ استُبعدت كي لا يُختلق تصنيف نقدي.",
      count: missingCashBucketCount,
      amount: round2(missingCashBucketAmount).toFixed(2),
    });
  }
  if (ambiguousCheckCount > 0) {
    blockers.push({
      code: "CHECK_SOURCE_AMBIGUOUS",
      source: "receipts.CHECK",
      message:
        "يوجد شيك يدّعي أنه عكس أو ارتداد بلا رابط مصدر مطابق؛ استُبعد من الرصيد ولم يُخمّن كشيك قبض أو شيك صادر.",
      count: ambiguousCheckCount,
      amount: round2(ambiguousCheckAmount).toFixed(2),
    });
  }

  for (const row of deliveryRows) {
    const gross = money(row.gross);
    const customerBacked = money(row.customerBacked);
    const net = gross.minus(customerBacked);
    if (
      gross.isNegative() ||
      customerBacked.isNegative() ||
      customerBacked.gt(gross) ||
      net.isNegative()
    ) {
      blockers.push({
        code: "DELIVERY_LEDGER_INCONSISTENT",
        source: `deliveryLedgerEntries.branch:${row.branchId ?? "GLOBAL"}`,
        message:
          "دفتر عهدة التوصيل ينتج رصيداً سالباً أو جزءاً مدعوماً بذمة عميل أكبر من إجمالي العهدة؛ صحّح سلسلة التحصيل/التوريد قبل القطع.",
        count: 1,
        amount: round2(
          gross.isNegative() ? gross.abs() : customerBacked.minus(gross).abs(),
        ).toFixed(2),
      });
      continue;
    }
    add(
      "DELIVERY_FLOAT",
      row.branchId,
      net,
      "deliveryLedgerEntries.COD.netExcludingCustomerBacked",
    );
  }

  for (const row of advanceRows) {
    add(
      "EMPLOYEE_ADVANCES",
      row.branchId,
      row.remaining,
      "employeeAdvances.ACTIVE.remaining",
    );
  }

  const payrollOriginalByRunKind = new Map<
    string,
    ReturnType<typeof money>
  >();
  let invalidPayrollCount = 0;
  let invalidPayrollAmount = money(0);
  const payrollRoleByKind = {
    SALARY_NET: "ACCRUED_SALARY",
    INCOME_TAX: "PAYROLL_TAX_PAYABLE",
    SOCIAL_SECURITY: "SOCIAL_SECURITY_PAYABLE",
    EOS_PROVISION: "EOS_PROVISION",
  } as const satisfies Record<
    (typeof payrollObligationRows)[number]["kind"],
    ConfirmedOperationalRole
  >;
  for (const row of payrollObligationRows) {
    const original = money(row.originalAmount);
    const remaining = money(row.remainingAmount);
    const balanceMatchesStatus =
      (row.status === "OPEN" && remaining.eq(original)) ||
      (row.status === "PARTIAL" &&
        remaining.isPositive() &&
        remaining.lt(original)) ||
      ((row.status === "SETTLED" || row.status === "REVERSED") &&
        remaining.isZero());
    const sourceValid =
      row.sourceKey.trim().length > 0 &&
      (row.sourceType !== "PAYROLL_APPROVAL" ||
        (row.runId != null && row.itemId != null));
    if (
      !original.isPositive() ||
      remaining.isNegative() ||
      remaining.gt(original) ||
      !balanceMatchesStatus ||
      !sourceValid ||
      (row.branchId != null && Number(row.branchId) <= 0)
    ) {
      invalidPayrollCount += 1;
      invalidPayrollAmount = invalidPayrollAmount.plus(
        original.abs().plus(remaining.abs()),
      );
      continue;
    }
    if (row.runId != null) {
      const runKey = `${row.runId}:${row.revisionNo}:${row.kind}`;
      payrollOriginalByRunKind.set(
        runKey,
        (payrollOriginalByRunKind.get(runKey) ?? money(0)).plus(original),
      );
    }
    if (remaining.isPositive()) {
      add(
        payrollRoleByKind[row.kind],
        row.branchId == null ? null : Number(row.branchId),
        remaining.negated(),
        `payrollObligations.${row.kind}.remainingAmount`,
      );
    }
  }
  if (invalidPayrollCount > 0) {
    blockers.push({
      code: "PAYROLL_OBLIGATION_INCONSISTENT",
      source: "payrollObligations",
      message:
        "توجد التزامات رواتب بمبلغ أصلي/متبقٍ أو حالة أو رابط مصدر غير متسق؛ استُبعدت ولم يُستنتج رصيدها من قيد اليومية.",
      count: invalidPayrollCount,
      amount: round2(invalidPayrollAmount).toFixed(2),
    });
  }

  let uncoveredPayrollCount = 0;
  let uncoveredPayrollAmount = money(0);
  for (const run of payrollRunRows) {
    const expectedByKind = [
      ["SALARY_NET", money(run.totalNet)],
      ["INCOME_TAX", money(run.totalIncomeTax)],
      [
        "SOCIAL_SECURITY",
        money(run.totalSocialSecurityEmployee).plus(
          money(run.totalSocialSecurityEmployer),
        ),
      ],
      ["EOS_PROVISION", money(run.totalEndOfServiceAccrual)],
    ] as const;
    const required =
      run.status === "approved" ? expectedByKind : expectedByKind.slice(1);
    let runUncovered = !/^[a-f0-9]{64}$/i.test(
      run.approvalSnapshotHash ?? "",
    );
    let runAmount = money(0);
    for (const [kind, expected] of required) {
      const actual =
        payrollOriginalByRunKind.get(
          `${run.id}:${run.revisionNo}:${kind}`,
        ) ?? money(0);
      if (!expected.eq(actual)) {
        runUncovered = true;
        runAmount = runAmount.plus(expected.minus(actual).abs());
      }
    }
    if (runUncovered) {
      uncoveredPayrollCount += 1;
      uncoveredPayrollAmount = uncoveredPayrollAmount.plus(runAmount);
    }
  }
  if (uncoveredPayrollCount > 0) {
    blockers.push({
      code: "PAYROLL_LEGACY_UNCOVERED",
      source: "payrollRuns",
      message:
        "يوجد مسيّر معتمد/مدفوع بلا بصمة اعتماد أو بلا التزامات راتب/ضريبة/ضمان/EOS مطابقة للنسخة؛ يلزم ترحيل أو شهادة افتتاح صريحة.",
      count: uncoveredPayrollCount,
      amount: round2(uncoveredPayrollAmount).toFixed(2),
    });
  }

  const purchaseOrderById = new Map(
    purchaseOrderRows.map((row) => [Number(row.id), row] as const),
  );
  const maintenanceById = new Map(
    maintenanceRows.map((row) => [Number(row.id), row] as const),
  );
  const assetById = new Map(
    assetRows.map((row) => [Number(row.id), row] as const),
  );
  const recognizedAccrualSources = new Map<
    string,
    { outstanding: boolean; branchId: number; amount: string }
  >();
  let invalidAccrualCount = 0;
  let invalidAccrualAmount = money(0);
  for (const row of systemRequestRows) {
    const request = parseRecognizedAccrualRequest(row.internalNote);
    const claimsRecognizedSource =
      row.internalNote?.includes('"kind":"PURCHASE_SHIPPING"') ||
      row.internalNote?.includes('"kind":"ASSET_MAINTENANCE"') ||
      row.internalNote?.includes('"kind":"ASSET_ACQUISITION"');
    if (!request) {
      if (claimsRecognizedSource) {
        invalidAccrualCount += 1;
        invalidAccrualAmount = invalidAccrualAmount.plus(money(row.amount));
      }
      continue;
    }
    let key: string | null = null;
    let valid =
      row.direction === "OUT" &&
      row.branchId != null &&
      money(row.amount).isPositive();
    try {
      if (request.kind === "PURCHASE_SHIPPING") {
        const po = purchaseOrderById.get(Number(request.purchaseOrderId));
        valid =
          valid &&
          Number.isSafeInteger(request.purchaseOrderId) &&
          request.purchaseOrderId > 0 &&
          /^[0-9a-f]{16}$/i.test(request.requestToken) &&
          typeof request.expectedAmount === "string" &&
          typeof request.sourceShippingTotal === "string" &&
          po != null &&
          Number(po.branchId) === Number(row.branchId) &&
          row.referenceNumber ===
            `SHIP-${po.poNumber}-${request.requestToken}` &&
          money(request.expectedAmount).eq(money(row.amount)) &&
          money(request.sourceShippingTotal).eq(
            money(po.shippingCost).plus(money(po.customsCost)),
          );
        key = `PURCHASE_SHIPPING_ACCRUAL:${request.purchaseOrderId}:${request.requestToken}`;
      } else if (request.kind === "ASSET_MAINTENANCE") {
        const maintenance = maintenanceById.get(Number(request.maintenanceId));
        const asset = assetById.get(Number(request.assetId));
        valid =
          valid &&
          Number.isSafeInteger(request.assetId) &&
          request.assetId > 0 &&
          Number.isSafeInteger(request.maintenanceId) &&
          request.maintenanceId > 0 &&
          maintenance != null &&
          asset != null &&
          Number(maintenance.assetId) === request.assetId &&
          Number(asset.branchId) === Number(row.branchId) &&
          row.referenceNumber === `ASSET-MAINT-${request.maintenanceId}` &&
          money(maintenance.cost).eq(money(row.amount));
        key = `ASSET_MAINT_ACCRUAL:${request.maintenanceId}`;
      } else {
        const asset = assetById.get(Number(request.assetId));
        valid =
          valid &&
          Number.isSafeInteger(request.assetId) &&
          request.assetId > 0 &&
          asset != null &&
          Number(asset.branchId) === Number(row.branchId) &&
          row.referenceNumber === `ASSET-ACQ-${request.assetId}` &&
          money(asset.purchaseValue).eq(money(row.amount));
        key = `ASSET_ACCRUAL:${request.assetId}`;
      }
    } catch {
      valid = false;
    }
    if (!valid || !key) {
      invalidAccrualCount += 1;
      invalidAccrualAmount = invalidAccrualAmount.plus(money(row.amount));
      continue;
    }
    const settled =
      row.status === "COMPLETED" && row.approvalStatus === "APPROVED";
    const prior = recognizedAccrualSources.get(key);
    recognizedAccrualSources.set(key, {
      outstanding: (prior?.outstanding ?? true) && !settled,
      branchId: Number(row.branchId),
      amount: money(row.amount).toFixed(2),
    });
  }

  const recognizedAccrualEntries = new Set<string>();
  const recognitionProfiles = new Set([
    "ADJUST_EXPENSE_ACCRUAL",
    "ADJUST_FIXED_ASSET_ACCRUAL",
  ]);
  const reversalProfiles = new Set([
    "ADJUST_EXPENSE_ACCRUAL_REVERSAL",
    "ADJUST_FIXED_ASSET_ACCRUAL_REVERSAL",
  ]);
  const settlementProfiles = new Set([
    "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT",
    "PAYMENT_OUT_FIXED_ASSET_ACCRUAL_SETTLEMENT",
  ]);
  for (const row of accrualEntryRows) {
    const amount = money(row.amount);
    const isRecognition = recognitionProfiles.has(row.profile ?? "");
    const isReversal = reversalProfiles.has(row.profile ?? "");
    const isSettlement = settlementProfiles.has(row.profile ?? "");
    let valid =
      row.branchId != null &&
      ((isRecognition && row.entryType === "ADJUST" && amount.isPositive()) ||
        (isReversal && row.entryType === "ADJUST" && amount.isNegative()) ||
        (isSettlement &&
          row.entryType === "PAYMENT_OUT" &&
          !amount.isZero() &&
          row.receiptId != null));
    try {
      verifyPostingIntentEvidence({
        expectedEntryType: row.entryType,
        postingProfile: row.profile,
        postingIntentJson: row.intentJson,
        postingIntentHash: row.intentHash,
        source: {
          amount: row.amount,
          revenue: row.revenue,
          cost: row.cost,
          profit: row.profit,
          taxAmount: row.taxAmount,
        },
      });
    } catch {
      valid = false;
    }
    if (
      isRecognition &&
      (!row.dedupeKey || !recognizedAccrualSources.has(row.dedupeKey))
    ) {
      valid = false;
    }
    if (!valid) {
      invalidAccrualCount += 1;
      invalidAccrualAmount = invalidAccrualAmount.plus(amount.abs());
      continue;
    }
    if (isRecognition && row.dedupeKey) {
      recognizedAccrualEntries.add(row.dedupeKey);
    }
    add(
      "ACCRUED_EXPENSES",
      Number(row.branchId),
      isSettlement ? amount : amount.negated(),
      `accountingEntries.${row.profile}.canonicalEvidence`,
    );
  }
  for (const [key, source] of Array.from(recognizedAccrualSources.entries())) {
    if (source.outstanding && !recognizedAccrualEntries.has(key)) {
      invalidAccrualCount += 1;
      invalidAccrualAmount = invalidAccrualAmount.plus(source.amount);
    }
  }
  if (invalidAccrualCount > 0) {
    blockers.push({
      code: "ACCRUED_EXPENSE_SOURCE_INVALID",
      source: "recognizedSystemAccruals",
      message:
        "يوجد طلب شحن/صيانة/اقتناء أصل أو قيد استحقاق بلا مصدر نظامي وبصمة canonical متطابقين؛ استُبعد ولم يُستنتج الالتزام من اليومية المزدوجة.",
      count: invalidAccrualCount,
      amount: round2(invalidAccrualAmount).toFixed(2),
    });
  }

  for (const row of cashTransferRows) {
    if (row.status === "IN_TRANSIT") {
      add(
        "CASH_IN_TRANSIT",
        Number(row.fromBranchId),
        row.amount,
        "cashTransfers.IN_TRANSIT.amount",
      );
      continue;
    }
    add(
      "INTERBRANCH_CLEARING",
      Number(row.fromBranchId),
      row.amount,
      "cashTransfers.RECEIVED.dueFrom",
    );
    add(
      "INTERBRANCH_CLEARING",
      Number(row.toBranchId),
      money(row.amount).negated(),
      "cashTransfers.RECEIVED.dueTo",
    );
  }

  const otherLiabilityByBranch = new Map<number, ReturnType<typeof money>>();
  const addHeldDeposit = (
    branchId: number,
    amount: ReturnType<typeof money>,
  ) => {
    otherLiabilityByBranch.set(
      branchId,
      (otherLiabilityByBranch.get(branchId) ?? money(0)).plus(amount),
    );
  };
  for (const row of workOrderDepositRows) {
    if (row.invoiceId == null) {
      addHeldDeposit(row.branchId, money(row.deposit));
    }
    if (row.status === "IN_PROGRESS" || row.status === "READY") {
      add(
        "WORK_IN_PROGRESS",
        row.branchId,
        row.materialsCost,
        "workOrders.IN_PROGRESS_READY.materialsCost",
      );
    }
  }
  for (const row of draftDepositRows) {
    addHeldDeposit(
      row.branchId,
      row.kind === "COLLECTION"
        ? money(row.amount)
        : money(row.amount).negated(),
    );
  }
  for (const [branchId, net] of Array.from(otherLiabilityByBranch.entries())) {
    if (net.isNegative()) {
      blockers.push({
        code: "BALANCE_SHEET_SOURCE_UNCONFIRMED",
        source: `operationalDeposits.branch:${branchId}`,
        message:
          "صافي العرابين التشغيلية سالب؛ لا يجوز تحويل التزام سالب إلى أصل ضمني. صحّح دورة القبض/الرد قبل القطع.",
        count: 1,
        amount: round2(net.abs()).toFixed(2),
      });
      continue;
    }
    add(
      "OTHER_LIABILITY",
      branchId,
      net.negated(),
      "workOrders.deposit+orderPayments.heldNet",
    );
  }

  const heldByBranch = new Map<number | null, ReturnType<typeof money>>();
  for (const row of courierPayableRows) {
    heldByBranch.set(
      row.branchId,
      (heldByBranch.get(row.branchId) ?? money(0)).plus(row.amount),
    );
  }
  const courierByBranch = new Map<number | null, ReturnType<typeof money>>();
  const addCourierPayable = (
    branchId: number | null,
    amount: ReturnType<typeof money>,
  ) => {
    courierByBranch.set(
      branchId,
      (courierByBranch.get(branchId) ?? money(0)).plus(amount),
    );
  };
  for (const [branchId, net] of Array.from(heldByBranch.entries())) {
    if (net.isNegative()) {
      blockers.push({
        code: "COURIER_PAYABLE_NEGATIVE",
        source: `accountingEntries.DELIVERY_FEE_HELD:${branchId ?? "GLOBAL"}`,
        message:
          "صافي أمانة أجرة المندوب سالب؛ لا يجوز تحويل الالتزام السالب إلى أصل. صحّح القبض/الصرف أو الرد أولاً.",
        count: 1,
        amount: round2(net.abs()).toFixed(2),
      });
      continue;
    }
    addCourierPayable(branchId, net);
  }
  for (const row of shopFeeRows) {
    const net = money(row.amount);
    if (net.isNegative()) {
      blockers.push({
        code: "COURIER_PAYABLE_NEGATIVE",
        source: `deliveryLedgerEntries.SHOP_FEE:${row.branchId ?? "GLOBAL"}`,
        message:
          "صافي أجور التوصيل التي تتحملها المكتبة سالب؛ لا يجوز تحويل التزام مستحق سالب إلى أصل. صحّح دورة الاستحقاق/الدفع/الرد قبل القطع.",
        count: 1,
        amount: round2(net.abs()).toFixed(2),
      });
      continue;
    }
    addCourierPayable(row.branchId, net);
  }
  for (const [branchId, net] of Array.from(courierByBranch.entries())) {
    add(
      "COURIER_PAYABLE",
      branchId,
      net.negated(),
      "accountingEntries.DELIVERY_FEE_HELD+deliveryLedgerEntries.SHOP_FEE.net",
    );
  }

  const taxByBranch = new Map<number | null, ReturnType<typeof money>>();
  let unsupportedTaxCount = 0;
  let unsupportedTaxAmount = money(0);
  for (const row of taxRows) {
    const tax = money(row.taxAmount);
    let netDebit: ReturnType<typeof money> | null = null;
    if (row.entryType === "SALE") netDebit = tax.negated();
    else if (row.entryType === "PURCHASE") netDebit = tax;
    else if (row.entryType === "RETURN") {
      netDebit = row.supplierId == null ? tax.negated() : tax;
    }
    if (netDebit == null) {
      unsupportedTaxCount += 1;
      unsupportedTaxAmount = unsupportedTaxAmount.plus(tax.abs());
      continue;
    }
    taxByBranch.set(
      row.branchId,
      (taxByBranch.get(row.branchId) ?? money(0)).plus(netDebit),
    );
  }
  for (const [branchId, netDebit] of Array.from(taxByBranch.entries())) {
    add("TAX_PAYABLE", branchId, netDebit, "accountingEntries.taxAmount");
  }
  if (unsupportedTaxCount > 0) {
    blockers.push({
      code: "TAX_SOURCE_UNSUPPORTED",
      source: "accountingEntries.taxAmount",
      message:
        "توجد ضريبة غير صفرية على نوع قيد لا يملك دلالة مدينة/دائنة تشغيلية معتمدة؛ يلزم تصنيفها قبل القطع.",
      count: unsupportedTaxCount,
      amount: round2(unsupportedTaxAmount).toFixed(2),
    });
  }

  for (const row of capitalRows) {
    add(
      "CAPITAL",
      row.branchId,
      money(row.amount).negated(),
      "accountingEntries.TREASURY_FUNDING",
    );
  }

  for (const row of exchangeRows) {
    const iqd = money(row.balanceIqd);
    const usdQuantity = money(row.balanceUsd);
    const usdCarrying = money(row.balanceUsdCarryingIqd);
    if (
      usdQuantity.isZero() !== usdCarrying.isZero() ||
      (!usdQuantity.isZero() &&
        usdQuantity.isPositive() !== usdCarrying.isPositive())
    ) {
      blockers.push({
        code: "EXCHANGE_CONTROL_SOURCE_INVALID",
        source: `exchangeHouses:${row.id}`,
        message:
          "كمية دولار الصيرفة وقيمتها الدفترية الدينارية غير متسقتين صفراً أو إشارةً؛ استُبعد الرصيد ولم يُقدَّر بسعر لحظي.",
        count: 1,
        amount: round2(usdCarrying.abs()).toFixed(2),
      });
    } else if (!usdCarrying.isZero()) {
      add(
        usdCarrying.isPositive()
          ? "EXCHANGE_RECEIVABLE_USD"
          : "EXCHANGE_PAYABLE_USD",
        null,
        usdCarrying,
        "exchangeHouses.balanceUsdCarryingIqd.byHouse",
      );
    }
    if (!iqd.isZero()) {
      add(
        iqd.isPositive()
          ? "EXCHANGE_RECEIVABLE_IQD"
          : "EXCHANGE_PAYABLE_IQD",
        null,
        iqd,
        "exchangeHouses.balanceIqd.byHouse",
      );
    }
  }
  const foreignCashByBranch = new Map<
    string,
    { quantity: ReturnType<typeof money>; carrying: ReturnType<typeof money> }
  >();
  let invalidForeignCashCount = 0;
  let invalidForeignCashAmount = money(0);
  for (const row of foreignCashRows) {
    const quantity = money(row.usdAmount);
    const carrying = money(row.iqdAmount);
    if (
      row.branchId == null ||
      !quantity.isPositive() ||
      !carrying.isPositive()
    ) {
      invalidForeignCashCount += 1;
      invalidForeignCashAmount = invalidForeignCashAmount.plus(carrying.abs());
      continue;
    }
    const direction = row.type === "DEPOSIT" ? money(-1) : money(1);
    const key = `${row.exchangeHouseId}:${row.branchId}`;
    const current = foreignCashByBranch.get(key) ?? {
      quantity: money(0),
      carrying: money(0),
    };
    current.quantity = current.quantity.plus(quantity.times(direction));
    current.carrying = current.carrying.plus(carrying.times(direction));
    foreignCashByBranch.set(key, current);
  }
  for (const [key, balance] of Array.from(foreignCashByBranch.entries())) {
    const [exchangeHouseId, branchIdText] = key.split(":");
    const branchId = Number(branchIdText);
    if (
      balance.quantity.isNegative() ||
      balance.carrying.isNegative() ||
      balance.quantity.isZero() !== balance.carrying.isZero()
    ) {
      invalidForeignCashCount += 1;
      invalidForeignCashAmount = invalidForeignCashAmount.plus(
        balance.carrying.abs(),
      );
      continue;
    }
    add(
      "FOREIGN_CASH_USD",
      branchId,
      balance.carrying,
      `exchangeTransactions.ACTIVE.USD.iqdAmount:house:${exchangeHouseId}`,
    );
  }
  if (invalidForeignCashCount > 0) {
    blockers.push({
      code: "FOREIGN_CASH_SOURCE_INVALID",
      source: "exchangeTransactions.ACTIVE.USD",
      message:
        "حركة نقد أجنبي نافذة تفتقد الفرع/سعر الكلفة أو تنتج كمية أو قيمة دفترية سالبة؛ استُبعدت ولم يُخمّن لها رصيد.",
      count: invalidForeignCashCount,
      amount: round2(invalidForeignCashAmount).toFixed(2),
    });
  }
  for (const row of walletRows)
    add(
      "DIGITAL_WALLET",
      row.branchId,
      row.balance,
      "digitalWallets.currentBalance",
    );
  for (const row of assetRows) {
    add(
      "FIXED_ASSETS",
      row.branchId,
      row.purchaseValue,
      "fixedAssets.purchaseValue",
    );
    add(
      "ACCUMULATED_DEPRECIATION",
      row.branchId,
      money(row.accumulatedDepreciation).negated(),
      "fixedAssets.accumulatedDepreciation",
    );
  }

  const balances = Array.from(aggregate.values())
    .map<OperationalBalance>((row) => ({
      role: row.role,
      branchId: row.branchId,
      netDebit: round2(row.netDebit).toFixed(2),
      sources: Array.from(row.sources).sort(),
    }))
    .filter((row) => !money(row.netDebit).isZero())
    .sort(
      (a, b) =>
        branchSort(a.branchId, b.branchId) || a.role.localeCompare(b.role),
    );

  return {
    asOf,
    snapshotDate,
    balances,
    blockers: blockers.sort(
      (a, b) =>
        a.code.localeCompare(b.code) || a.source.localeCompare(b.source),
    ),
  };
}

/** Builds the balanced, hash-bound, read-only opening journal preview. */
export async function previewShadowOpening(
  input: {
    asOf?: string;
    cycleId?: string;
    allocations?: ShadowOpeningAllocation[];
    db?: ReadDb;
  } = {},
): Promise<ShadowOpeningPreview> {
  const dbHandle = requireDb(input.db);
  const db = dbHandle as DB;
  const [snapshot, cycleId] = await Promise.all([
    readOperationalBalanceSnapshot({ asOf: input.asOf, db: dbHandle }),
    resolveShadowCycleId(dbHandle, input.cycleId),
  ]);
  const sourceKey = `SHADOW_OPENING:${cycleId}:${snapshot.asOf}`;
  const operationalLines: ShadowOpeningLine[] = snapshot.balances.map(
    (balance) => ({
      ...balance,
      ...toSides(money(balance.netDebit)),
    }),
  );
  const scopeNets = new Map<number | null, ReturnType<typeof money>>();
  for (const line of operationalLines) {
    scopeNets.set(
      line.branchId,
      (scopeNets.get(line.branchId) ?? money(0)).plus(line.netDebit),
    );
  }

  const manualAllocations = normalizeAllocations(input.allocations ?? []);
  for (const allocation of manualAllocations) {
    if (!scopeNets.has(allocation.branchId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "تخصيص الرصيد الافتتاحي يشير إلى نطاق لا يحمل رصيداً تشغيلياً.",
      });
    }
    const allocationNet = money(allocation.debit).minus(allocation.credit);
    scopeNets.set(
      allocation.branchId,
      (scopeNets.get(allocation.branchId) ?? money(0)).plus(allocationNet),
    );
  }

  const lines: ShadowOpeningLine[] = [
    ...operationalLines,
    ...manualAllocations.map((allocation) => ({
      ...allocation,
      netDebit: money(allocation.debit).minus(allocation.credit).toFixed(2),
      sources: ["manual-approved-allocation"],
    })),
  ];
  lines.sort(
    (a, b) =>
      branchSort(a.branchId, b.branchId) ||
      ordinalText(a.role, b.role) ||
      ordinalText(a.debit, b.debit) ||
      ordinalText(a.credit, b.credit),
  );

  const unallocatedScopes = Array.from(scopeNets.entries())
    .map(([branchId, currentNet]) => {
      const requiredNet = round2(currentNet).negated();
      return {
        branchId,
        netDebit: requiredNet.toFixed(2),
        ...toSides(requiredNet),
      };
    })
    .filter((scope) => !money(scope.netDebit).isZero())
    .sort((a, b) => branchSort(a.branchId, b.branchId));
  let unallocatedDebit = money(0);
  let unallocatedCredit = money(0);
  for (const scope of unallocatedScopes) {
    unallocatedDebit = unallocatedDebit.plus(scope.debit);
    unallocatedCredit = unallocatedCredit.plus(scope.credit);
  }
  const blockers = [...snapshot.blockers];
  if (unallocatedScopes.length > 0) {
    blockers.push({
      code: "BALANCE_SHEET_SOURCE_UNCONFIRMED",
      source: "manualOpeningAllocation",
      message:
        "بقي رصيد ميزانية غير منسوب. يجب أن يخصّصه المحاسب بالكامل إلى رأس المال أو الأرباح المحتجزة أو جاري المالك أو القروض قبل اعتماد البصمة.",
      count: unallocatedScopes.length,
      amount: round2(unallocatedDebit.plus(unallocatedCredit)).toFixed(2),
    });
  }

  const roleMap = new Map<string, ReturnType<typeof money>>();
  const branchMap = new Map<
    number | null,
    { debit: ReturnType<typeof money>; credit: ReturnType<typeof money> }
  >();
  let totalDebit = money(0);
  let totalCredit = money(0);
  for (const line of lines) {
    roleMap.set(
      line.role,
      (roleMap.get(line.role) ?? money(0)).plus(line.netDebit),
    );
    const branch = branchMap.get(line.branchId) ?? {
      debit: money(0),
      credit: money(0),
    };
    branch.debit = branch.debit.plus(line.debit);
    branch.credit = branch.credit.plus(line.credit);
    branchMap.set(line.branchId, branch);
    totalDebit = totalDebit.plus(line.debit);
    totalCredit = totalCredit.plus(line.credit);
  }

  // A clean company still needs a hash-bound cut-over certificate. The writer
  // persists this one empty GLOBAL group as MEMO (never as a zero POSTED entry).
  if (lines.length === 0) {
    branchMap.set(null, { debit: money(0), credit: money(0) });
  }

  const roleTotals = Array.from(roleMap.entries())
    .map(([role, netDebit]) => ({
      role: role as ConfirmedOperationalRole | ShadowOpeningAllocationRole,
      netDebit: round2(netDebit).toFixed(2),
      ...toSides(netDebit),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
  const branchTotals = Array.from(branchMap.entries())
    .map(([branchId, amounts]) => {
      const debit = round2(amounts.debit);
      const credit = round2(amounts.credit);
      const difference = debit.minus(credit);
      return {
        branchId,
        debit: debit.toFixed(2),
        credit: credit.toFixed(2),
        difference: difference.toFixed(2),
        isBalanced: difference.isZero(),
      };
    })
    .sort((a, b) => branchSort(a.branchId, b.branchId));
  const difference = round2(totalDebit.minus(totalCredit));
  const journalGroups = branchTotals.map((total) => ({
    branchId: total.branchId,
    sourceKey: `${sourceKey}:${total.branchId == null ? "GLOBAL" : `B${total.branchId}`}`,
    lines: lines.filter((line) => line.branchId === total.branchId),
    debit: total.debit,
    credit: total.credit,
  }));

  const openingHash = computeShadowOpeningHash({
    cycleId,
    asOf: snapshot.asOf,
    lines,
  });

  return {
    cycleId,
    sourceKey,
    asOf: snapshot.asOf,
    snapshotDate: snapshot.snapshotDate,
    hashVersion: 1,
    openingHash,
    canApprove: blockers.length === 0 && difference.isZero(),
    manualAllocations,
    unallocatedOpeningBalance: {
      debit: round2(unallocatedDebit).toFixed(2),
      credit: round2(unallocatedCredit).toFixed(2),
      scopes: unallocatedScopes,
    },
    lines,
    journalGroups,
    roleTotals,
    branchTotals,
    totals: {
      debit: round2(totalDebit).toFixed(2),
      credit: round2(totalCredit).toFixed(2),
      difference: difference.toFixed(2),
      isBalanced: difference.isZero(),
    },
    blockers: blockers.sort(
      (a, b) =>
        a.code.localeCompare(b.code) || a.source.localeCompare(b.source),
    ),
  };
}

function ymd(value: Date | string): string {
  return typeof value === "string"
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}

/**
 * Reconstructs the canonical hash from stored SHADOW_OPENING heads/lines. It is
 * read-only and accepts a transaction so ACTIVE verifies under its mode lock.
 */
export async function verifyStoredShadowOpening(input: {
  cycleId: string;
  expectedHash: string;
  db: DB | Tx;
}): Promise<StoredShadowOpeningVerification> {
  const cycleId = input.cycleId.trim();
  const empty = (): StoredShadowOpeningVerification => ({
    cycleId,
    expectedHash: input.expectedHash,
    exists: false,
    hashMatches: false,
    balanced: false,
    sourceKeysValid: false,
    postingProfilesValid: false,
    openingHash: null,
    asOf: null,
    entryCount: 0,
    lineCount: 0,
  });
  if (
    !/^[A-Za-z0-9_-]{1,36}$/.test(cycleId) ||
    !/^[a-f0-9]{64}$/.test(input.expectedHash)
  ) {
    return empty();
  }

  // DB and Tx expose the same read API; cast only avoids a union of generic overloads.
  const db = input.db as DB;
  const heads = await db
    .select({
      id: journalEntries.id,
      entryDate: journalEntries.entryDate,
      branchId: journalEntries.branchId,
      entryId: journalEntries.entryId,
      sourceKey: journalEntries.sourceKey,
      postingProfile: journalEntries.postingProfile,
      status: journalEntries.status,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.sourceType, "SHADOW_OPENING"),
        eq(journalEntries.cycleId, cycleId),
      ),
    );
  if (heads.length === 0) return empty();

  const dates = new Set(heads.map((head) => ymd(head.entryDate)));
  const asOf = dates.size === 1 ? Array.from(dates)[0] : null;
  const rows = await db
    .select({
      journalId: journalLines.journalId,
      role: journalLines.role,
      debit: journalLines.debit,
      credit: journalLines.credit,
      branchId: journalEntries.branchId,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
    .where(
      and(
        eq(journalEntries.sourceType, "SHADOW_OPENING"),
        eq(journalEntries.cycleId, cycleId),
      ),
    );

  const headTotals = new Map<
    number,
    { debit: ReturnType<typeof money>; credit: ReturnType<typeof money> }
  >();
  let totalDebit = money(0);
  let totalCredit = money(0);
  for (const row of rows) {
    const current = headTotals.get(row.journalId) ?? {
      debit: money(0),
      credit: money(0),
    };
    current.debit = current.debit.plus(row.debit);
    current.credit = current.credit.plus(row.credit);
    headTotals.set(row.journalId, current);
    totalDebit = totalDebit.plus(row.debit);
    totalCredit = totalCredit.plus(row.credit);
  }

  const isEmptyMemoCertificate =
    heads.length === 1 &&
    rows.length === 0 &&
    heads[0].branchId == null &&
    heads[0].status === "MEMO";
  const isPostedOpening =
    rows.length > 0 &&
    heads.every((head) => head.status === "POSTED") &&
    heads.every((head) => {
      const total = headTotals.get(head.id);
      return total != null && round2(total.debit.minus(total.credit)).isZero();
    }) &&
    round2(totalDebit.minus(totalCredit)).isZero();
  const balanced = isEmptyMemoCertificate || isPostedOpening;
  const sourceKeysValid =
    asOf != null &&
    new Set(
      heads.map((head) =>
        head.branchId == null ? "GLOBAL" : `B${head.branchId}`,
      ),
    ).size === heads.length &&
    heads.every(
      (head) =>
        head.sourceKey ===
        `SHADOW_OPENING:${cycleId}:${asOf}:${head.branchId == null ? "GLOBAL" : `B${head.branchId}`}`,
    );
  const postingProfilesValid =
    heads.every(
      (head) =>
        head.entryId == null && head.postingProfile === "SHADOW_OPENING_V1",
    ) &&
    rows.every((row) => SHADOW_OPENING_STORED_ROLES.has(row.role)) &&
    (isEmptyMemoCertificate || isPostedOpening);
  const openingHash =
    asOf == null
      ? null
      : computeShadowOpeningHash({
          cycleId,
          asOf,
          lines: rows.map((row) => ({
            role: row.role as ShadowOpeningLine["role"],
            branchId: row.branchId,
            debit: round2(row.debit).toFixed(2),
            credit: round2(row.credit).toFixed(2),
          })),
        });

  return {
    cycleId,
    expectedHash: input.expectedHash,
    exists: true,
    hashMatches:
      openingHash === input.expectedHash &&
      balanced &&
      sourceKeysValid &&
      postingProfilesValid,
    balanced,
    sourceKeysValid,
    postingProfilesValid,
    openingHash,
    asOf,
    entryCount: heads.length,
    lineCount: rows.length,
  };
}
