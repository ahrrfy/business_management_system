export const REMEDIATION_CLASSIFICATIONS = [
  "TREASURY_PAID",
  "EMPLOYEE_PERSONAL_PAID",
  "MISSING_INTERNAL_TRANSFER",
  "DUPLICATE_OR_ERROR",
] as const;

export type RemediationClassification =
  (typeof REMEDIATION_CLASSIFICATIONS)[number];

export type SuggestedClassification =
  | RemediationClassification
  | "VERIFIED_INTERNAL_TRANSFER"
  | "UNVERIFIED_INTERNAL_TRANSFER"
  | "VERIFIED_REVERSAL"
  | "UNVERIFIED_REVERSAL"
  | "UNRESOLVED";

export type ClassificationConfidence = "HIGH" | "MEDIUM" | "LOW";

export type EvidenceMissing =
  | "SOURCE_DOCUMENT"
  | "COUNTERPARTY"
  | "PAYMENT_PROOF"
  | "LEDGER_ENTRY"
  | "EMPLOYEE_DECLARATION"
  | "TREASURY_HANDOVER_OR_FUNDING_PROOF"
  | "PHYSICAL_CASH_COUNT"
  | "CONFIRM_SINGLE_PHYSICAL_PAYMENT"
  | "MANAGER_DECISION";

export interface CashRemediationSimulationInput {
  receiptId: number;
  classification: RemediationClassification;
}

export interface CashRemediationFilters {
  from: string;
  to: string;
  branchId?: number;
  shiftIds?: number[];
  userIds?: number[];
  simulations?: CashRemediationSimulationInput[];
}

export interface RawRemediationShift {
  id: number;
  branchId: number;
  branchName: string;
  userId: number;
  userName: string;
  shiftType: string;
  status: "OPEN" | "CLOSED";
  openingBalance: string;
  storedExpectedCash: string | null;
  countedCash: string | null;
  storedVariance: string | null;
  openedAt: Date;
  closedAt: Date | null;
}

export interface RawRemediationExpense {
  id: number;
  receiptId: number;
  amount: string;
  paymentMethod: string;
  cashBucket: "DRAWER" | "TREASURY" | null;
  status: "PENDING_APPROVAL" | "ACTIVE" | "REJECTED" | "CANCELLED";
  category: string;
  description: string | null;
  referenceNumber: string | null;
  payee: string | null;
}

export interface RawRemediationReceipt {
  id: number;
  shiftId: number;
  branchId: number | null;
  direction: "IN" | "OUT";
  amount: string;
  paymentMethod: string;
  cashBucket: "DRAWER" | "TREASURY" | null;
  referenceNumber: string | null;
  voucherNumber: string | null;
  invoiceId: number | null;
  workOrderId: number | null;
  reservationId: number | null;
  partyType: string | null;
  partyId: number | null;
  counterpartyName: string | null;
  description: string | null;
  attachmentUrl: string | null;
  status: string;
  approvalStatus: string;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: Date;
  expense: RawRemediationExpense | null;
  linkedExpenseIds: number[];
  ledgerEntryIds: number[];
  ledgerEntryTypes: string[];
  pairedTreasuryReceiptId: number | null;
  pairedTreasuryReceiptStatus: string | null;
  pairedTreasuryApprovalStatus: string | null;
}

export interface RawCashRemediationDataset {
  shifts: RawRemediationShift[];
  receipts: RawRemediationReceipt[];
}

export interface CashRemediationSource {
  documentType:
    | "EXPENSE"
    | "INVOICE"
    | "WORK_ORDER"
    | "RESERVATION"
    | "VOUCHER"
    | "RECEIPT";
  documentId: number | string;
  expenseId: number | null;
  expenseIds: number[];
  invoiceId: number | null;
  workOrderId: number | null;
  reservationId: number | null;
  voucherNumber: string | null;
  referenceNumber: string | null;
  ledgerEntryIds: number[];
  ledgerEntryTypes: string[];
}

export interface CashRemediationOutRow {
  receiptId: number;
  shiftId: number;
  createdAt: string;
  amount: string;
  paymentMethod: string;
  cashBucket: "DRAWER" | "TREASURY" | null;
  status: string;
  approvalStatus: string;
  description: string | null;
  actorId: number | null;
  actorName: string | null;
  counterpartyName: string | null;
  source: CashRemediationSource;
  affectsDrawer: boolean;
  excludedClosingHandover: boolean;
  pairedTreasuryReceiptId: number | null;
  pairedTreasuryReceiptStatus: string | null;
  pairedTreasuryApprovalStatus: string | null;
  runningBalanceBefore: string;
  runningBalanceAfter: string;
  suggestedClassification: SuggestedClassification;
  confidence: ClassificationConfidence;
  rationale: string;
  evidenceMissing: EvidenceMissing[];
  duplicateOfReceiptId: number | null;
  simulation: {
    selectedClassification: RemediationClassification | null;
    drawerDelta: string;
    treasuryDelta: string;
    employeePayableDelta: string;
    expenseDelta: string;
  };
}

export interface CashRemediationShiftReport {
  shift: {
    id: number;
    branchId: number;
    branchName: string;
    userId: number;
    userName: string;
    shiftType: string;
    status: "OPEN" | "CLOSED";
    openedAt: string;
    closedAt: string | null;
  };
  firstNegative: {
    point: "OPENING" | "RECEIPT";
    receiptId: number | null;
    occurredAt: string;
    balance: string;
  } | null;
  before: {
    openingBalance: string;
    computedExpectedCash: string;
    storedExpectedCash: string | null;
    countedCash: string | null;
    computedVariance: string | null;
    storedVariance: string | null;
  };
  afterSimulation: {
    expectedCash: string;
    variance: string | null;
    drawerDelta: string;
    treasuryDelta: string;
    employeePayableDelta: string;
    expenseDelta: string;
  };
  outflows: CashRemediationOutRow[];
}

export interface CashRemediationReport {
  mode: "DRY_RUN_READ_ONLY";
  generatedAt: string;
  filters: Omit<CashRemediationFilters, "simulations">;
  safeguards: {
    mutationsAvailable: false;
    postedDocuments: 0;
    postedLedgerEntries: 0;
    sourceRowsChanged: 0;
  };
  summary: {
    shiftCount: number;
    negativeShiftCount: number;
    outflowCount: number;
    unresolvedCount: number;
    beforeExpectedCash: string;
    afterExpectedCash: string;
    drawerDelta: string;
    treasuryDelta: string;
    employeePayableDelta: string;
    expenseDelta: string;
  };
  shifts: CashRemediationShiftReport[];
}
