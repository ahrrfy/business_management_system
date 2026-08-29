import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  accounts,
  accountingEntries,
  accrualCorrectionRequests,
  accrualObligationEvents,
  accrualObligations,
  doubleEntrySettings,
  employeeAdvances,
  employees,
  idempotencyKeys,
  receipts,
  voucherCategories,
} from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { reconcileDoubleEntryShadowWindow } from "../reconcileService";
import {
  POSTING_POLICY_HASH,
  PROFILE_POLICIES,
  ENTRY_TYPE_PROFILES,
  ACTIVATION_REQUIRED_ACCOUNT_ROLES,
  ACTIVATION_REQUIRED_POSTING_PROFILES,
} from "./postingEngine";
import type { EntryType } from "../ledgerService";
import {
  CONFIRMED_OPERATIONAL_ROLES,
  verifyStoredShadowOpening,
} from "./shadowOpening";
import { reconcileDoubleEntryOperational } from "./doubleEntryOperationalReconcile";
import { findVoucherCategoryMappingIssues } from "../voucher/categoryAccounting";
import {
  hasSystemPaymentRequestEnvelope,
  isCanonicalSystemPaymentRequest,
  isSystemPaymentReference,
  parseSystemPaymentRequest,
  type SystemPaymentRequest,
} from "../voucher/create";
import { money } from "../money";
import { getStatutoryActivationReadiness } from "./statutoryAccounting";

export const REQUIRED_SHADOW_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * حارس اكتمال مستقلّ عن العدد: أُضيف DELIVERY_FEE_HELD بعد اعتماد «31/31». لو فحصنا الحجم فقط
 * لمرّت الخرائط القديمة 31/31 وهي تترك هذا المال المحتجَز بلا خريطة. Record<EntryType,…> يجعل
 * TypeScript يرفض أيضاً أي نوعٍ جديدٍ مستقبلاً حتى يُضاف هنا وتراه البوابة.
 */
const CURRENT_ENTRY_TYPE_FLAGS: Record<EntryType, true> = {
  SALE: true,
  PURCHASE: true,
  PAYMENT_IN: true,
  PAYMENT_OUT: true,
  RETURN: true,
  ADJUST: true,
  OPENING: true,
  INTERNAL_USE: true,
  WASTAGE: true,
  CASH_HANDOVER: true,
  CASH_TRANSFER_OUT: true,
  CASH_TRANSFER_IN: true,
  SHIFT_FLOAT_OUT: true,
  TREASURY_FUNDING: true,
  DELIVERY_DISPATCH: true,
  DELIVERY_REMIT: true,
  DELIVERY_FEE: true,
  DELIVERY_FEE_HELD: true,
  DELIVERY_WRITEOFF: true,
  EXCHANGE_DEPOSIT: true,
  EXCHANGE_WITHDRAW: true,
  EXCHANGE_FX_BUY: true,
  EXCHANGE_SETTLE: true,
  EXCHANGE_FEE: true,
  EXCHANGE_FX_DIFF: true,
  GIFT_OUT: true,
  DIGITAL_WALLET_DEPOSIT: true,
  DIGITAL_WALLET_WITHDRAWAL: true,
  DIGITAL_WALLET_CONSUMPTION: true,
  DIGITAL_WALLET_REVERSAL: true,
  DIGITAL_WALLET_ADJUSTMENT: true,
  DIGITAL_WRITEOFF: true,
};
export const CURRENT_ENTRY_TYPES = Object.keys(
  CURRENT_ENTRY_TYPE_FLAGS,
) as EntryType[];
/** لا يُثبَّت العدد يدوياً: إضافة EntryType جديد ترفع البوابة تلقائياً حتى تُضاف خريطته. */
export const REQUIRED_MAPPED_ENTRY_TYPE_COUNT = CURRENT_ENTRY_TYPES.length;

export type ActivationBlockerKey =
  | "MODE"
  | "SHADOW_START"
  | "SHADOW_CYCLE"
  | "OPENING_SNAPSHOT"
  | "OPENING_HASH"
  | "OPERATIONAL_RECONCILIATION"
  | "POLICY_APPROVAL"
  | "SHADOW_DURATION"
  | "MAPPING_COVERAGE"
  | "UNMAPPED_GAPS"
  | "MISSING_JOURNALS"
  | "EXTRA_JOURNALS"
  | "JOURNAL_SCOPE_MISMATCH"
  | "SOURCE_INTENT_INTEGRITY"
  | "SOURCE_MAPPING"
  | "RECONCILIATION_DRIFT"
  | "JOURNAL_IMBALANCE"
  | "VOUCHER_CATEGORY_MAPPING"
  | "STATUTORY_COMPLIANCE"
  | "CRITICAL_MANIFEST";

export interface ActivationBlocker {
  key: ActivationBlockerKey;
  label: string;
  detail: string;
  actual: string | number | null;
  required: string | number;
}

export interface ActivationGateResult {
  ok: boolean;
  mode: "OFF" | "SHADOW" | "ACTIVE";
  shadowStartedAt: string | null;
  cycleId: string | null;
  openingHash: string | null;
  openingVerification: {
    exists: boolean;
    hashMatches: boolean;
    balanced: boolean;
    sourceKeysValid: boolean;
    postingProfilesValid: boolean;
    actualHash: string | null;
    entryCount: number;
    lineCount: number;
  } | null;
  operationalReconciliation: {
    ok: boolean;
    asOf: string;
    driftCount: number;
    totalAbsoluteDifference: string;
    blockerCount: number;
    mismatches: Array<{
      scope: "GLOBAL" | "BRANCH";
      branchId: number | null;
      role: string;
      operationalNetDebit: string;
      journalNetDebit: string;
      difference: string;
    }>;
    blockers: Array<{
      code: string;
      source: string;
      message: string;
      count: number;
      amount?: string;
    }>;
  } | null;
  policyApproval: {
    reference: string;
    accountantName: string;
    approvedAt: string;
    approvedBy: number | null;
    cycleId: string;
    openingHash: string;
    policyHash: string;
  } | null;
  shadowDays: number;
  requiredShadowDays: number;
  mappedTypes: number;
  requiredMappedTypes: number;
  unmappedEntryTypes: string[];
  gapCount: number;
  missingCount: number;
  extraCount: number;
  scopeMismatchCount: number;
  unreconstructableCount: number;
  sourceMismatchCount: number;
  observedProfiles: string[];
  unobservedProfiles: string[];
  drift: string;
  journalImbalance: string;
  imbalancedJournalCount: number;
  voucherCategoryMappingIssueCount: number;
  statutoryCompliance: Awaited<
    ReturnType<typeof getStatutoryActivationReadiness>
  > | null;
  blockers: ActivationBlocker[];
}

function blocker(
  key: ActivationBlockerKey,
  label: string,
  actual: string | number | null,
  required: string | number,
  detail: string,
): ActivationBlocker {
  return { key, label, actual, required, detail };
}

/** بوابة ACTIVE الوحيدة: قرارها مشتقٌ من قاعدة البيانات، ولا تقبل أيّ ادّعاءٍ من الواجهة. */
export async function canActivate(options?: {
  tx?: Tx;
  now?: Date;
  requireStatutoryCompliance?: boolean;
}): Promise<ActivationGateResult> {
  const committedDb = getDb();
  // `activateDoubleEntry` already holds the exclusive settings row lock. Its
  // transaction may nevertheless have opened a REPEATABLE READ snapshot in
  // the company-gate bootstrap before it waited for an in-flight writer. Read
  // the evidence through a fresh committed connection while that exclusive
  // lock keeps every financial writer blocked; otherwise ACTIVE could approve
  // the pre-wait snapshot and miss the writer that just committed.
  const executor = options?.tx && committedDb
    ? committedDb
    : (options?.tx ?? committedDb);
  const reconciliationTx = executor === options?.tx ? options?.tx : undefined;
  const now = options?.now ?? new Date();
  const row = executor
    ? (
        await executor
          .select({
            mode: doubleEntrySettings.mode,
            shadowStartedAt: doubleEntrySettings.shadowStartedAt,
            cycleId: doubleEntrySettings.shadowCycleId,
            openingHash: doubleEntrySettings.shadowOpeningHash,
            policyReference: doubleEntrySettings.policyApprovalReference,
            policyPolicyHash: doubleEntrySettings.policyApprovalPolicyHash,
            policyCycleId: doubleEntrySettings.policyApprovalCycleId,
            policyOpeningHash: doubleEntrySettings.policyApprovalOpeningHash,
            policyAccountantName: doubleEntrySettings.policyAccountantName,
            policyApprovedAt: doubleEntrySettings.policyApprovedAt,
            policyApprovedBy: doubleEntrySettings.policyApprovedBy,
          })
          .from(doubleEntrySettings)
          .where(eq(doubleEntrySettings.id, 1))
          .limit(1)
      )[0]
    : undefined;
  const mode = row?.mode ?? "OFF";
  const startedAt = row?.shadowStartedAt ?? null;
  const cycleId = row?.cycleId ?? null;
  const openingHash = row?.openingHash ?? null;
  const policyApproval =
    row?.policyReference &&
    row.policyAccountantName &&
    row.policyApprovedAt &&
    row.policyCycleId &&
    row.policyOpeningHash &&
    row.policyCycleId === cycleId &&
    row.policyOpeningHash === openingHash &&
    row.policyPolicyHash === POSTING_POLICY_HASH
      ? {
          reference: row.policyReference,
          accountantName: row.policyAccountantName,
          approvedAt: row.policyApprovedAt.toISOString(),
          approvedBy: row.policyApprovedBy ?? null,
          cycleId: row.policyCycleId,
          openingHash: row.policyOpeningHash,
          policyHash: row.policyPolicyHash,
        }
      : null;
  const hasPolicyApprovalRecord = Boolean(
    row?.policyReference || row?.policyAccountantName || row?.policyApprovedAt,
  );
  const elapsedMs = startedAt
    ? Math.max(0, now.getTime() - startedAt.getTime())
    : 0;
  const shadowDays = Math.floor(elapsedMs / DAY_MS);
  const [reconciliation, storedOpening, operational] = await Promise.all([
    startedAt && cycleId
      ? reconcileDoubleEntryShadowWindow(
          { from: startedAt, to: now, cycleId },
          { tx: reconciliationTx },
        )
      : null,
    executor && cycleId && openingHash
      ? verifyStoredShadowOpening({
          cycleId,
          expectedHash: openingHash,
          db: executor,
        })
      : null,
    executor && cycleId
      ? reconcileDoubleEntryOperational({ cycleId, db: executor })
      : null,
  ]);
  const openingVerification = storedOpening
    ? {
        exists: storedOpening.exists,
        hashMatches: storedOpening.hashMatches,
        balanced: storedOpening.balanced,
        sourceKeysValid: storedOpening.sourceKeysValid,
        postingProfilesValid: storedOpening.postingProfilesValid,
        actualHash: storedOpening.openingHash,
        entryCount: storedOpening.entryCount,
        lineCount: storedOpening.lineCount,
      }
    : null;
  const operationalReconciliation = operational
    ? {
        ok: operational.ok,
        asOf: operational.asOf,
        driftCount: operational.driftCount,
        totalAbsoluteDifference: operational.totalAbsoluteDifference,
        blockerCount: operational.blockers.length,
        mismatches: operational.rows
          .filter((item) => !item.matches)
          .map((item) => ({
            scope: item.scope,
            branchId: item.branchId,
            role: item.role,
            operationalNetDebit: item.operationalNetDebit,
            journalNetDebit: item.journalNetDebit,
            difference: item.difference,
          })),
        blockers: operational.blockers.map((item) => ({
          code: item.code,
          source: item.source,
          message: item.message,
          count: item.count,
          ...(item.amount == null ? {} : { amount: item.amount }),
        })),
      }
    : null;
  const policyEntryTypes: ReadonlySet<string> = new Set(
    Object.values(PROFILE_POLICIES).map((policy) => policy.entryType),
  );
  const mappedTypes = CURRENT_ENTRY_TYPES.filter((entryType) =>
    policyEntryTypes.has(entryType),
  ).length;
  const unmappedEntryTypes = CURRENT_ENTRY_TYPES.filter(
    (entryType) => !policyEntryTypes.has(entryType),
  );
  const criticalAccountRows = executor
    ? await executor
        .select({ role: accounts.systemRole, isActive: accounts.isActive })
        .from(accounts)
        .where(
          inArray(
            accounts.systemRole,
            [...ACTIVATION_REQUIRED_ACCOUNT_ROLES],
          ),
        )
    : [];
  const activeCriticalRoles = new Set(
    criticalAccountRows
      .filter((account) => account.isActive && account.role != null)
      .map((account) => account.role!),
  );
  const missingCriticalRoles = ACTIVATION_REQUIRED_ACCOUNT_ROLES.filter(
    (role) => !activeCriticalRoles.has(role),
  );
  const missingCriticalProfiles = ACTIVATION_REQUIRED_POSTING_PROFILES.filter(
    (profile) => {
      const policy = PROFILE_POLICIES[profile];
      return (
        !policy ||
        policy.memoOnly ||
        !ENTRY_TYPE_PROFILES[policy.entryType].includes(profile) ||
        policy.requireRoleComponents.length === 0
      );
    },
  );
  const criticalOperationalRoles = [
    "ACCRUED_SALARY",
    "PAYROLL_TAX_PAYABLE",
    "SOCIAL_SECURITY_PAYABLE",
    "EOS_PROVISION",
    "ACCRUED_EXPENSES",
    "EXCHANGE_WALLET_IQD",
    "EXCHANGE_WALLET_USD",
    "EXCHANGE_RECEIVABLE_IQD",
    "EXCHANGE_RECEIVABLE_USD",
    "EXCHANGE_PAYABLE_IQD",
    "EXCHANGE_PAYABLE_USD",
  ] as const;
  const confirmedOperationalRoles = new Set<string>(
    CONFIRMED_OPERATIONAL_ROLES,
  );
  const missingOperationalSources = criticalOperationalRoles.filter(
    (role) => !confirmedOperationalRoles.has(role),
  );
  const [
    categoryRows,
    usedCategoryRows,
    categoryAccountRows,
    unclassifiedOtherRows,
    allReceiptRows,
  ] = executor
    ? await Promise.all([
        executor
          .select({
            id: voucherCategories.id,
            name: voucherCategories.name,
            direction: voucherCategories.direction,
            postingRole: voucherCategories.postingRole,
            isActive: voucherCategories.isActive,
          })
          .from(voucherCategories),
        executor
          .selectDistinct({ categoryId: receipts.voucherCategoryId })
          .from(receipts)
          .where(isNotNull(receipts.voucherCategoryId)),
        executor
          .select({ role: accounts.systemRole, isActive: accounts.isActive })
          .from(accounts)
          .where(isNotNull(accounts.systemRole)),
        executor
          .select({
            id: receipts.id,
            internalNote: receipts.internalNote,
            referenceNumber: receipts.referenceNumber,
            status: receipts.status,
            approvalStatus: receipts.approvalStatus,
            branchId: receipts.branchId,
            direction: receipts.direction,
            amount: receipts.amount,
            paymentMethod: receipts.paymentMethod,
            cashBucket: receipts.cashBucket,
            partyId: receipts.partyId,
            counterpartyName: receipts.counterpartyName,
            checkNumber: receipts.checkNumber,
            cardLastFour: receipts.cardLastFour,
            attachmentUrl: receipts.attachmentUrl,
          })
          .from(receipts)
          .where(
            and(
              eq(receipts.partyType, "OTHER"),
              isNull(receipts.voucherCategoryId),
            ),
          ),
        executor
          .select({
            id: receipts.id,
            internalNote: receipts.internalNote,
            referenceNumber: receipts.referenceNumber,
            status: receipts.status,
            approvalStatus: receipts.approvalStatus,
            branchId: receipts.branchId,
            direction: receipts.direction,
            amount: receipts.amount,
            paymentMethod: receipts.paymentMethod,
            cashBucket: receipts.cashBucket,
            partyId: receipts.partyId,
            counterpartyName: receipts.counterpartyName,
            checkNumber: receipts.checkNumber,
            cardLastFour: receipts.cardLastFour,
            attachmentUrl: receipts.attachmentUrl,
            partyType: receipts.partyType,
            voucherCategoryId: receipts.voucherCategoryId,
            createdBy: receipts.createdBy,
          })
          .from(receipts),
      ])
    : [[], [], [], [], []];
  const usedCategoryIds = new Set(
    usedCategoryRows
      .map((row) => row.categoryId)
      .filter((id): id is number => id != null)
      .map(Number),
  );
  const activeAccountRoles = new Set(
    categoryAccountRows
      .filter((row) => row.isActive && row.role != null)
      .map((row) => row.role!),
  );
  const voucherCategoryMappingIssues = findVoucherCategoryMappingIssues(
    categoryRows,
    usedCategoryIds,
    activeAccountRoles,
  );
  const systemPaymentRows = allReceiptRows.filter(
    (row) =>
      hasSystemPaymentRequestEnvelope(row.internalNote) ||
      isSystemPaymentReference(row.referenceNumber),
  );
  const systemPaymentReceiptIds = systemPaymentRows.map((row) => Number(row.id));
  const systemPaymentReceiptIdSet = new Set(systemPaymentReceiptIds);
  const manualUnclassifiedOtherReceiptIds = unclassifiedOtherRows
    .filter((row) => !systemPaymentReceiptIdSet.has(Number(row.id)))
    .map((row) => Number(row.id));
  const canonicalAdvanceRequests = systemPaymentRows
    .map((row) => ({ row, request: parseSystemPaymentRequest(row.internalNote) }))
    .filter(
      (item): item is typeof item & {
        request: Extract<SystemPaymentRequest, { kind: "EMPLOYEE_ADVANCE" }>;
      } => item.request?.kind === "EMPLOYEE_ADVANCE",
    );
  const advanceEmployeeIds = Array.from(
    new Set(canonicalAdvanceRequests.map(({ request }) => request.employeeId)),
  );
  const canonicalRefundRequests = systemPaymentRows
    .map((row) => ({ row, request: parseSystemPaymentRequest(row.internalNote) }))
    .filter(
      (item): item is typeof item & {
        request: Extract<
          SystemPaymentRequest,
          { kind: "ACCRUAL_CORRECTION_REFUND" }
        >;
      } => item.request?.kind === "ACCRUAL_CORRECTION_REFUND",
    );
  const canonicalCancellationRequests = systemPaymentRows
    .map((row) => ({ row, request: parseSystemPaymentRequest(row.internalNote) }))
    .filter(
      (item): item is typeof item & {
        request: Extract<
          SystemPaymentRequest,
          { kind: "VOUCHER_CANCELLATION" }
        >;
      } =>
        item.request?.kind === "VOUCHER_CANCELLATION" &&
        isCanonicalSystemPaymentRequest(
          item.request,
          item.row.referenceNumber,
        ),
    );
  const correctionRequestIds = Array.from(
    new Set(
      canonicalRefundRequests.map(({ request }) => request.correctionRequestId),
    ),
  );
  const refundObligationIds = Array.from(
    new Set(canonicalRefundRequests.map(({ request }) => request.obligationId)),
  );
  const originalSettlementReceiptIds = Array.from(
    new Set(
      canonicalRefundRequests.map(
        ({ request }) => request.originalSettlementReceiptId,
      ),
    ),
  );
  const advanceProvenanceKeys = canonicalAdvanceRequests.map(
    ({ request }) => `ADVANCE:${request.sourceClientRequestId}`,
  );
  const cancellationProvenanceKeys = canonicalCancellationRequests.map(
    ({ request }) =>
      `voucher-cancellation-${request.originalReceiptId}-A${request.attempt}`,
  );
  const systemVoucherProvenanceKeys = [
    ...advanceProvenanceKeys,
    ...cancellationProvenanceKeys,
  ];
  const [
    materializedSystemRows,
    materializedAdvanceRows,
    advanceEmployeeRows,
    systemVoucherProvenanceRows,
    refundCorrectionRows,
    refundObligationRows,
    refundSettlementEventRows,
    originalSettlementReceiptRows,
  ] =
    executor && systemPaymentReceiptIds.length > 0
      ? await Promise.all([
          executor
            .select({
              id: accountingEntries.id,
              receiptId: accountingEntries.receiptId,
              entryType: accountingEntries.entryType,
              branchId: accountingEntries.branchId,
              amount: accountingEntries.amount,
              postingProfile: accountingEntries.postingProfile,
              customerId: accountingEntries.customerId,
              supplierId: accountingEntries.supplierId,
            })
            .from(accountingEntries)
            .where(
              inArray(accountingEntries.receiptId, systemPaymentReceiptIds),
            ),
          executor
            .select({
              receiptId: employeeAdvances.receiptId,
              employeeId: employeeAdvances.employeeId,
              branchId: employeeAdvances.branchId,
              amount: employeeAdvances.amount,
              remaining: employeeAdvances.remaining,
              status: employeeAdvances.status,
            })
            .from(employeeAdvances)
            .where(
              inArray(employeeAdvances.receiptId, systemPaymentReceiptIds),
            ),
            advanceEmployeeIds.length > 0
              ? executor
                .select({ id: employees.id, isActive: employees.isActive })
                .from(employees)
                .where(inArray(employees.id, advanceEmployeeIds))
              : Promise.resolve([]),
          systemVoucherProvenanceKeys.length > 0
            ? executor
                .select({
                  operation: idempotencyKeys.operation,
                  clientRequestId: idempotencyKeys.clientRequestId,
                  refId: idempotencyKeys.refId,
                })
                .from(idempotencyKeys)
                .where(
                  and(
                    eq(idempotencyKeys.operation, "voucher.create"),
                    inArray(
                      idempotencyKeys.clientRequestId,
                      systemVoucherProvenanceKeys,
                    ),
                  ),
                )
            : Promise.resolve([]),
          correctionRequestIds.length > 0
            ? executor
                .select()
                .from(accrualCorrectionRequests)
                .where(inArray(accrualCorrectionRequests.id, correctionRequestIds))
            : Promise.resolve([]),
          refundObligationIds.length > 0
            ? executor
                .select()
                .from(accrualObligations)
                .where(inArray(accrualObligations.id, refundObligationIds))
            : Promise.resolve([]),
          refundObligationIds.length > 0
            ? executor
                .select()
                .from(accrualObligationEvents)
                .where(
                  and(
                    inArray(
                      accrualObligationEvents.obligationId,
                      refundObligationIds,
                    ),
                    eq(accrualObligationEvents.eventType, "PAYMENT_SETTLED"),
                  ),
                )
            : Promise.resolve([]),
          originalSettlementReceiptIds.length > 0
            ? executor
                .select({
                  id: receipts.id,
                  status: receipts.status,
                  approvalStatus: receipts.approvalStatus,
                  branchId: receipts.branchId,
                  amount: receipts.amount,
                })
                .from(receipts)
                .where(inArray(receipts.id, originalSettlementReceiptIds))
            : Promise.resolve([]),
        ])
      : [[], [], [], [], [], [], [], []];
  const materializedSystemReceiptIds = new Set(
    materializedSystemRows
      .map((row) => row.receiptId)
      .filter((id): id is number => id != null)
      .map(Number),
  );
  const materializedAdvancesByReceiptId = new Map<
    number,
    typeof materializedAdvanceRows
  >();
  for (const advance of materializedAdvanceRows) {
    if (advance.receiptId == null) continue;
    const receiptId = Number(advance.receiptId);
    const rows = materializedAdvancesByReceiptId.get(receiptId) ?? [];
    rows.push(advance);
    materializedAdvancesByReceiptId.set(receiptId, rows);
  }
  const activeAdvanceEmployeeIds = new Set(
    advanceEmployeeRows
      .filter((row) => row.isActive)
      .map((row) => Number(row.id)),
  );
  const voucherProvenanceByClientRequestId = new Map(
    systemVoucherProvenanceRows.map(
      (row) => [row.clientRequestId, row] as const,
    ),
  );
  const systemEntriesByReceiptId = new Map<
    number,
    typeof materializedSystemRows
  >();
  for (const entry of materializedSystemRows) {
    if (entry.receiptId == null) continue;
    const receiptId = Number(entry.receiptId);
    const rows = systemEntriesByReceiptId.get(receiptId) ?? [];
    rows.push(entry);
    systemEntriesByReceiptId.set(receiptId, rows);
  }
  const refundCorrectionById = new Map(
    refundCorrectionRows.map((row) => [Number(row.id), row] as const),
  );
  const refundObligationById = new Map(
    refundObligationRows.map((row) => [Number(row.id), row] as const),
  );
  const latestRefundSettlementByObligationId = new Map<
    number,
    (typeof refundSettlementEventRows)[number]
  >();
  for (const event of refundSettlementEventRows) {
    const obligationId = Number(event.obligationId);
    const current = latestRefundSettlementByObligationId.get(obligationId);
    if (!current || Number(event.id) > Number(current.id)) {
      latestRefundSettlementByObligationId.set(obligationId, event);
    }
  }
  const originalSettlementReceiptById = new Map(
    originalSettlementReceiptRows.map((row) => [Number(row.id), row] as const),
  );
  const cancellationRequestsByOriginalReceiptId = new Map<
    number,
    typeof canonicalCancellationRequests
  >();
  for (const item of canonicalCancellationRequests) {
    const originalReceiptId = Number(item.request.originalReceiptId);
    const items =
      cancellationRequestsByOriginalReceiptId.get(originalReceiptId) ?? [];
    items.push(item);
    cancellationRequestsByOriginalReceiptId.set(originalReceiptId, items);
  }
  const systemPaymentIssueReceiptIds = systemPaymentRows
    .filter((row) => {
      const request = parseSystemPaymentRequest(row.internalNote);
      if (
        !request ||
        !isCanonicalSystemPaymentRequest(request, row.referenceNumber)
      ) {
        return true;
      }
      if (request.kind === "EMPLOYEE_ADVANCE") {
        const expectedProvenanceKey =
          `ADVANCE:${request.sourceClientRequestId}`;
        const provenance = voucherProvenanceByClientRequestId.get(
          expectedProvenanceKey,
        );
        const approvablePending =
          row.status === "PENDING" &&
          row.approvalStatus === "PENDING_APPROVAL";
        let amountMatches = false;
        try {
          amountMatches = money(row.amount).eq(money(request.expectedAmount));
        } catch {
          amountMatches = false;
        }
        if (
          row.direction !== "OUT" ||
          Number(row.branchId) !== request.branchId ||
          !amountMatches ||
          (approvablePending &&
            !activeAdvanceEmployeeIds.has(request.employeeId)) ||
          !provenance ||
          provenance.operation !== "voucher.create" ||
          provenance.clientRequestId !== expectedProvenanceKey ||
          Number(provenance.refId) !== Number(row.id)
        ) {
          return true;
        }
      }
      if (request.kind === "ACCRUAL_CORRECTION_REFUND") {
        const correction = refundCorrectionById.get(
          request.correctionRequestId,
        );
        const obligation = refundObligationById.get(request.obligationId);
        const settlementEvent = latestRefundSettlementByObligationId.get(
          request.obligationId,
        );
        const originalReceipt = originalSettlementReceiptById.get(
          request.originalSettlementReceiptId,
        );
        const entries = systemEntriesByReceiptId.get(Number(row.id)) ?? [];
        let amountMatches = false;
        let originalAmountMatches = false;
        try {
          amountMatches =
            money(row.amount).eq(money(request.expectedAmount)) &&
            !!obligation &&
            money(obligation.recognizedAmount).eq(
              money(request.expectedAmount),
            );
          originalAmountMatches =
            !!originalReceipt &&
            money(originalReceipt.amount).eq(money(request.expectedAmount));
        } catch {
          amountMatches = false;
          originalAmountMatches = false;
        }
        const expectedProviderEvidence =
          correction?.refundPaymentMethod === "CASH"
            ? correction.externalEvidenceReference
            : correction?.refundReferenceNumber;
        const instrumentMatches =
          correction?.refundPaymentMethod === row.paymentMethod &&
          request.providerEvidenceReference === expectedProviderEvidence &&
          (row.paymentMethod === "CARD"
            ? row.cardLastFour === correction?.refundCardLastFour
            : row.paymentMethod === "CHECK"
              ? row.checkNumber === correction?.refundReferenceNumber
              : row.cardLastFour == null && row.checkNumber == null);
        const sourceMatches =
          !!correction &&
          !!obligation &&
          Number(correction.obligationId) === request.obligationId &&
          correction.previousObligationStatus === "PAID" &&
          obligation.sourceHash === request.obligationSourceHash &&
          Number(obligation.branchId) === Number(row.branchId) &&
          row.direction === "IN" &&
          row.partyId == null &&
          row.counterpartyName === obligation.beneficiaryName &&
          correction.attachmentUrl === row.attachmentUrl &&
          amountMatches &&
          instrumentMatches &&
          !!settlementEvent &&
          settlementEvent.receiptId != null &&
          settlementEvent.accountingEntryId != null &&
          Number(settlementEvent.receiptId) ===
            request.originalSettlementReceiptId &&
          !!originalReceipt &&
          originalReceipt.status === "COMPLETED" &&
          originalReceipt.approvalStatus === "APPROVED" &&
          Number(originalReceipt.branchId) === Number(row.branchId) &&
          originalAmountMatches;
        if (!sourceMatches) return true;

        const pending =
          row.status === "PENDING" &&
          row.approvalStatus === "PENDING_APPROVAL";
        if (pending) {
          return !(
            correction.status === "PENDING" &&
            Number(correction.refundRequestReceiptId) === Number(row.id) &&
            obligation.status === "REFUND_PENDING" &&
            row.cashBucket == null &&
            entries.length === 0
          );
        }
        const rejected =
          row.status === "FAILED" && row.approvalStatus === "REJECTED";
        if (rejected) {
          return !(
            correction.status === "REJECTED" &&
            Number(correction.refundRequestReceiptId) === Number(row.id) &&
            obligation.status === "PAID" &&
            row.cashBucket == null &&
            entries.length === 0
          );
        }
        const completed =
          row.status === "COMPLETED" && row.approvalStatus === "APPROVED";
        if (!completed) return true;
        const entry = entries[0];
        const expectedProfile =
          obligation.kind === "ASSET_ACQUISITION_CASH"
            ? "PAYMENT_OUT_FIXED_ASSET_ACCRUAL_SETTLEMENT"
            : "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT";
        let entryAmountMatches = false;
        try {
          entryAmountMatches =
            !!entry &&
            money(entry.amount).eq(money(request.expectedAmount).neg());
        } catch {
          entryAmountMatches = false;
        }
        return !(
          correction.status === "APPROVED" &&
          Number(correction.refundRequestReceiptId) === Number(row.id) &&
          obligation.status === "RECOGNITION_REVERSED" &&
          entries.length === 1 &&
          !!entry &&
          entry.entryType === "PAYMENT_OUT" &&
          Number(entry.branchId) === Number(row.branchId) &&
          entry.postingProfile === expectedProfile &&
          entry.customerId == null &&
          entry.supplierId == null &&
          entryAmountMatches &&
          (row.paymentMethod !== "CASH" ||
            row.cashBucket === correction.refundCashBucket)
        );
      }
      if (request.kind === "EMPLOYEE_ADVANCE") {
        const advances =
          materializedAdvancesByReceiptId.get(Number(row.id)) ?? [];
        const entries = systemEntriesByReceiptId.get(Number(row.id)) ?? [];
        const pending =
          row.status === "PENDING" &&
          row.approvalStatus === "PENDING_APPROVAL";
        if (pending) {
          return !(
            row.cashBucket == null &&
            entries.length === 0 &&
            advances.length === 0
          );
        }
        const rejected =
          row.status === "FAILED" && row.approvalStatus === "REJECTED";
        if (rejected) {
          return !(entries.length === 0 && advances.length === 0);
        }
        const completed =
          row.status === "COMPLETED" && row.approvalStatus === "APPROVED";
        const reversed =
          row.status === "REVERSED" && row.approvalStatus === "APPROVED";
        if (!completed && !reversed) return true;
        const advance = advances[0];
        const entry = entries[0];
        let entryAmountMatches = false;
        let advanceAmountMatches = false;
        let completedAdvanceLifecycleMatches = false;
        let reversedAdvanceLifecycleMatches = false;
        try {
          entryAmountMatches =
            !!entry && money(entry.amount).eq(money(request.expectedAmount));
          advanceAmountMatches =
            !!advance && money(advance.amount).eq(money(request.expectedAmount));
          completedAdvanceLifecycleMatches =
            !!advance &&
            ((advance.status === "ACTIVE" &&
              money(advance.remaining).gt(0) &&
              money(advance.remaining).lte(money(advance.amount))) ||
              (advance.status === "SETTLED" &&
                money(advance.remaining).eq(0)));
          reversedAdvanceLifecycleMatches =
            !!advance &&
            advance.status === "CANCELLED" &&
            money(advance.remaining).eq(0);
        } catch {
          entryAmountMatches = false;
          advanceAmountMatches = false;
          completedAdvanceLifecycleMatches = false;
          reversedAdvanceLifecycleMatches = false;
        }
        const materializationMatches =
          advances.length === 1 &&
          !!advance &&
          Number(advance.employeeId) === request.employeeId &&
          Number(advance.branchId) === request.branchId &&
          advanceAmountMatches &&
          entries.length === 1 &&
          !!entry &&
          entry.entryType === "PAYMENT_OUT" &&
          entry.postingProfile === "PAYMENT_OUT_EMPLOYEE_ADVANCE" &&
          Number(entry.branchId) === Number(row.branchId) &&
          entry.customerId == null &&
          entry.supplierId == null &&
          entryAmountMatches;
        if (!materializationMatches) return true;
        if (completed) return !completedAdvanceLifecycleMatches;

        const cancellationAttempts = [
          ...(cancellationRequestsByOriginalReceiptId.get(Number(row.id)) ?? []),
        ].sort((left, right) => Number(left.row.id) - Number(right.row.id));
        const cancellationAttemptChainMatches = cancellationAttempts.every(
          (attempt, index) => {
            const prior = index === 0 ? null : cancellationAttempts[index - 1];
            const priorEntries = prior
              ? systemEntriesByReceiptId.get(Number(prior.row.id)) ?? []
              : [];
            const expectedAttemptKey =
              `voucher-cancellation-${attempt.request.originalReceiptId}-A${attempt.request.attempt}`;
            const provenance = voucherProvenanceByClientRequestId.get(
              expectedAttemptKey,
            );
            return (
              attempt.request.attempt === index + 1 &&
              attempt.request.priorCancellationReceiptId ===
                (prior == null ? null : Number(prior.row.id)) &&
              !!provenance &&
              provenance.operation === "voucher.create" &&
              provenance.clientRequestId === expectedAttemptKey &&
              Number(provenance.refId) === Number(attempt.row.id) &&
              (prior == null ||
                (prior.row.status === "FAILED" &&
                  prior.row.approvalStatus === "REJECTED" &&
                  priorEntries.length === 0))
            );
          },
        );
        const cancellation = cancellationAttempts.at(-1);
        const cancellationEntries = cancellation
          ? systemEntriesByReceiptId.get(Number(cancellation.row.id)) ?? []
          : [];
        const cancellationEntry = cancellationEntries[0];
        let cancellationAmountMatches = false;
        let cancellationEntryAmountMatches = false;
        try {
          cancellationAmountMatches =
            !!cancellation && money(cancellation.row.amount).eq(money(row.amount));
          cancellationEntryAmountMatches =
            !!cancellationEntry &&
            money(cancellationEntry.amount).eq(money(row.amount));
        } catch {
          cancellationAmountMatches = false;
          cancellationEntryAmountMatches = false;
        }
        const cancellationEvidenceMatches =
          cancellationAttempts.length > 0 &&
          cancellationAttemptChainMatches &&
          !!cancellation &&
          cancellation.row.status === "COMPLETED" &&
          cancellation.row.approvalStatus === "APPROVED" &&
          cancellation.request.originalReceiptId === Number(row.id) &&
          cancellation.request.originalCreatorId ===
            (row.createdBy == null ? null : Number(row.createdBy)) &&
          cancellation.request.originalDirection === row.direction &&
          cancellation.request.originalPaymentMethod === row.paymentMethod &&
          cancellation.request.originalReferenceNumber ===
            (row.referenceNumber?.trim() || null) &&
          cancellation.request.originalCheckNumber ===
            (row.checkNumber?.trim() || null) &&
          cancellation.request.originalCardLastFour ===
            (row.cardLastFour?.trim() || null) &&
          Number(cancellation.row.branchId) === Number(row.branchId) &&
          cancellation.row.direction === "IN" &&
          cancellation.row.paymentMethod === row.paymentMethod &&
          cancellation.row.partyType === row.partyType &&
          Number(cancellation.row.partyId ?? 0) === Number(row.partyId ?? 0) &&
          Number(cancellation.row.voucherCategoryId ?? 0) ===
            Number(row.voucherCategoryId ?? 0) &&
          cancellation.row.cashBucket === row.cashBucket &&
          cancellationAmountMatches &&
          cancellationEntries.length === 1 &&
          !!cancellationEntry &&
          cancellationEntry.entryType === "PAYMENT_IN" &&
          cancellationEntry.postingProfile === "PAYMENT_IN_OTHER" &&
          Number(cancellationEntry.branchId) === Number(row.branchId) &&
          cancellationEntry.customerId == null &&
          cancellationEntry.supplierId == null &&
          cancellationEntryAmountMatches;
        return !(
          reversedAdvanceLifecycleMatches && cancellationEvidenceMatches
        );
      }
      const zeroEffect =
        row.status !== "COMPLETED" || row.approvalStatus !== "APPROVED";
      if (zeroEffect) return false;
      return !materializedSystemReceiptIds.has(Number(row.id));
    })
    .map((row) => Number(row.id));
  const unclassifiedOtherReceiptIds = [
    ...manualUnclassifiedOtherReceiptIds,
    ...systemPaymentIssueReceiptIds,
  ];
  const voucherCategoryMappingIssueCount =
    voucherCategoryMappingIssues.length + unclassifiedOtherReceiptIds.length;
  const blockers: ActivationBlocker[] = [];
  const statutoryCompliance =
    options?.requireStatutoryCompliance !== true || !executor
      ? null
      : await getStatutoryActivationReadiness(executor);

  if (statutoryCompliance && !statutoryCompliance.ok) {
    blockers.push(
      blocker(
        "STATUTORY_COMPLIANCE",
        "جاهزية الدليل المحاسبي النظامي",
        statutoryCompliance.summary,
        "دليل نظامي معتمد وتغطية كاملة",
        statutoryCompliance.detail,
      ),
    );
  }

  if (voucherCategoryMappingIssueCount > 0) {
    const categoryDetails = voucherCategoryMappingIssues
      .map((issue) => `#${issue.id} ${issue.name} (${issue.reason})`)
      .join("، ");
    const receiptDetails = unclassifiedOtherReceiptIds.length
      ? `سندات OTHER تاريخية بلا فئة: ${unclassifiedOtherReceiptIds.map((id) => `#${id}`).join("، ")}`
      : "";
    blockers.push(
      blocker(
        "VOUCHER_CATEGORY_MAPPING",
        "تصنيف فئات السندات الحرة",
        voucherCategoryMappingIssueCount,
        0,
        `تصنيف محاسبي ناقص: ${[categoryDetails, receiptDetails].filter(Boolean).join("؛ ")}. عيّن مساراً محاسبياً معتمداً أو ادمج الفئة التاريخية في فئة متوافقة.`,
      ),
    );
  }

  if (
    missingCriticalRoles.length > 0 ||
    missingCriticalProfiles.length > 0 ||
    missingOperationalSources.length > 0
  ) {
    blockers.push(
      blocker(
        "CRITICAL_MANIFEST",
        "عقد الرواتب والاستحقاقات والصيرفة الحرج",
        [
          ...missingCriticalRoles.map((role) => `ROLE:${role}`),
          ...missingCriticalProfiles.map((profile) => `PROFILE:${profile}`),
          ...missingOperationalSources.map((role) => `SOURCE:${role}`),
        ].join(", ") || null,
        "كل الأدوار والحسابات والخرائط والمصادر التشغيلية موجودة وفعالة",
        "لا يدخل الدفتر ACTIVE إذا كان مسار رواتب/التزام قانوني/مصروف مستحق/إعادة تصنيف صيرفة خاملاً لكنه غير قابل للترحيل والمطابقة حرفياً.",
      ),
    );
  }

  if (mode !== "SHADOW" && mode !== "ACTIVE") {
    blockers.push(
      blocker(
        "MODE",
        "وضع الدفتر",
        mode,
        "SHADOW",
        "بوابة الاعتماد تبدأ من SHADOW، ومراقبة الصحة تستمر بعد ACTIVE.",
      ),
    );
  }
  if (!startedAt) {
    blockers.push(
      blocker(
        "SHADOW_START",
        "بداية الظل",
        null,
        "تاريخ موجود",
        "لم يُسجَّل وقت بدء المراقبة الظليّة.",
      ),
    );
  } else if (elapsedMs < REQUIRED_SHADOW_DAYS * DAY_MS) {
    blockers.push(
      blocker(
        "SHADOW_DURATION",
        "مدة الظل",
        shadowDays,
        REQUIRED_SHADOW_DAYS,
        `اكتمل ${shadowDays} من ${REQUIRED_SHADOW_DAYS} يوماً مطلوباً.`,
      ),
    );
  }
  if (!cycleId) {
    blockers.push(
      blocker(
        "SHADOW_CYCLE",
        "دورة الدفتر",
        null,
        "معرّف دورة موجود",
        "وضع الظل بلا معرّف دورة؛ لا يمكن عزل يومياته عن دورة سابقة.",
      ),
    );
  }
  if (!openingHash || (openingVerification && !openingVerification.exists)) {
    blockers.push(
      blocker(
        "OPENING_SNAPSHOT",
        "لقطة القطع الافتتاحية",
        openingVerification?.exists ? "موجودة" : null,
        "لقطة معتمدة",
        "لم توجد لقطة افتتاحية مخزنة ومربوطة بالدورة الحالية.",
      ),
    );
  }
  if (
    openingHash &&
    (!/^[a-f0-9]{64}$/.test(openingHash) ||
      (openingVerification != null && !openingVerification.hashMatches))
  ) {
    blockers.push(
      blocker(
        "OPENING_HASH",
        "سلامة بصمة الافتتاح",
        openingVerification?.actualHash ?? openingHash,
        openingHash,
        "اللقطة المخزنة غير متوازنة أو تغيرت بصمتها/مفاتيحها/قالبها عن البصمة المعتمدة.",
      ),
    );
  }
  if (operational && !operational.ok) {
    const operationalBlockers = operational.blockers
      .map((item) => item.message)
      .join("؛ ");
    blockers.push(
      blocker(
        "OPERATIONAL_RECONCILIATION",
        "مطابقة الأرصدة التشغيلية",
        `${operational.driftCount} فرق / ${operational.totalAbsoluteDifference}`,
        "0 فرق / 0.00",
        operationalBlockers ||
          "أرصدة الميزانية في اليومية لا تطابق مصادرها التشغيلية الفعلية حتى تاريخ الفحص.",
      ),
    );
  }
  if (!policyApproval) {
    blockers.push(
      blocker(
        "POLICY_APPROVAL",
        "مصادقة السياسة المحاسبية",
        null,
        "مرجع واسم محاسب وتاريخ مصادقة",
        hasPolicyApprovalRecord
          ? "المصادقة المسجلة قديمة أو لا تطابق دورة الظل وبصمة الافتتاح وإصدار سياسة الترحيل الحالي؛ يجب تسجيل مصادقة جديدة."
          : "لا يدخل الدفتر ACTIVE قبل تسجيل مرجع مصادقة محاسب بشري على السياسات الملتبسة.",
      ),
    );
  }
  if (
    mappedTypes !== REQUIRED_MAPPED_ENTRY_TYPE_COUNT ||
    unmappedEntryTypes.length > 0
  ) {
    blockers.push(
      blocker(
        "MAPPING_COVERAGE",
        "تغطية خرائط القيود",
        mappedTypes,
        REQUIRED_MAPPED_ENTRY_TYPE_COUNT,
        `خرائط الخطة ${mappedTypes}/${REQUIRED_MAPPED_ENTRY_TYPE_COUNT}` +
          (unmappedEntryTypes.length > 0
            ? `؛ الأنواع الحالية غير المغطّاة: ${unmappedEntryTypes.join("، ")}.`
            : "."),
      ),
    );
  }
  if (reconciliation) {
    if (reconciliation.gapCount > 0) {
      blockers.push(
        blocker(
          "UNMAPPED_GAPS",
          "فجوات الظل",
          reconciliation.gapCount,
          0,
          "توجد أحداث مالية مسجّلة كفجوات.",
        ),
      );
    }
    if (reconciliation.missingCount > 0) {
      blockers.push(
        blocker(
          "MISSING_JOURNALS",
          "قيود يومية مفقودة",
          reconciliation.missingCount,
          0,
          "توجد أحداث في الدفتر المبسّط بلا رأس يومية مزدوجة.",
        ),
      );
    }
    if (reconciliation.extraCount > 0) {
      blockers.push(
        blocker(
          "EXTRA_JOURNALS",
          "قيود يومية زائدة",
          reconciliation.extraCount,
          0,
          "توجد رؤوس يومية خارج أحداث نافذة الظل.",
        ),
      );
    }
    if (reconciliation.scopeMismatchCount > 0) {
      blockers.push(
        blocker(
          "JOURNAL_SCOPE_MISMATCH",
          "نطاق يومية غير مطابق",
          reconciliation.scopeMismatchCount,
          0,
          "يوجد رأس يومية منسوب إلى فرع أو تاريخ قيد مختلف عن حدثه المصدر.",
        ),
      );
    }
    if (reconciliation.unreconstructableCount > 0) {
      blockers.push(
        blocker(
          "SOURCE_INTENT_INTEGRITY",
          "سلامة دليل نية القيد",
          reconciliation.unreconstructableCount,
          0,
          "يوجد مصدر في الدورة الحالية بلا دليل canonical كامل وصالح ومطابق لسياسة الترحيل.",
        ),
      );
    }
    if (reconciliation.sourceMismatchCount > 0) {
      blockers.push(
        blocker(
          "SOURCE_MAPPING",
          "مطابقة اليومية لدليل المصدر",
          reconciliation.sourceMismatchCount,
          0,
          "حالة/profile/أسطر يومية واحدة على الأقل لا تطابق دليل مصدرها حرفياً.",
        ),
      );
    }
    if (reconciliation.drift !== "0.00") {
      blockers.push(
        blocker(
          "RECONCILIATION_DRIFT",
          "انحراف المطابقة",
          reconciliation.drift,
          "0.00",
          "صافي دورٍ محاسبيّ واحدٍ على الأقل لا يطابق مصدره.",
        ),
      );
    }
    if (
      reconciliation.journalImbalance !== "0.00" ||
      reconciliation.imbalancedJournalCount > 0
    ) {
      blockers.push(
        blocker(
          "JOURNAL_IMBALANCE",
          "توازن اليومية",
          `${reconciliation.imbalancedJournalCount} يومية / ${reconciliation.journalImbalance}`,
          "0 يومية / 0.00",
          "توجد يومية POSTED بلا أسطر أو يومية لا يتساوى مدينها ودائنها منفردةً.",
        ),
      );
    }
  }

  return {
    ok: blockers.length === 0,
    mode,
    shadowStartedAt: startedAt?.toISOString() ?? null,
    cycleId,
    openingHash,
    openingVerification,
    operationalReconciliation,
    policyApproval,
    shadowDays,
    requiredShadowDays: REQUIRED_SHADOW_DAYS,
    mappedTypes,
    requiredMappedTypes: REQUIRED_MAPPED_ENTRY_TYPE_COUNT,
    unmappedEntryTypes,
    gapCount: reconciliation?.gapCount ?? 0,
    missingCount: reconciliation?.missingCount ?? 0,
    extraCount: reconciliation?.extraCount ?? 0,
    scopeMismatchCount: reconciliation?.scopeMismatchCount ?? 0,
    unreconstructableCount: reconciliation?.unreconstructableCount ?? 0,
    sourceMismatchCount: reconciliation?.sourceMismatchCount ?? 0,
    observedProfiles: reconciliation?.observedProfiles ?? [],
    unobservedProfiles: reconciliation?.unobservedProfiles ?? [],
    drift: reconciliation?.drift ?? "0.00",
    journalImbalance: reconciliation?.journalImbalance ?? "0.00",
    imbalancedJournalCount: reconciliation?.imbalancedJournalCount ?? 0,
    voucherCategoryMappingIssueCount,
    statutoryCompliance,
    blockers,
  };
}
