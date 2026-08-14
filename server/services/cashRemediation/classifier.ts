import { money, toDbMoney } from "../money";
import type {
  CashRemediationFilters,
  CashRemediationOutRow,
  CashRemediationReport,
  CashRemediationShiftReport,
  ClassificationConfidence,
  EvidenceMissing,
  RawCashRemediationDataset,
  RawRemediationReceipt,
  RemediationClassification,
  SuggestedClassification,
} from "./types";

type ClassificationResult = {
  classification: SuggestedClassification;
  confidence: ClassificationConfidence;
  rationale: string;
  evidenceMissing: EvidenceMissing[];
  duplicateOfReceiptId: number | null;
};

function sourceOf(receipt: RawRemediationReceipt): CashRemediationOutRow["source"] {
  const expense = receipt.expense;
  const documentType = expense
    ? "EXPENSE"
    : receipt.invoiceId != null
      ? "INVOICE"
      : receipt.workOrderId != null
        ? "WORK_ORDER"
        : receipt.reservationId != null
          ? "RESERVATION"
          : receipt.voucherNumber
            ? "VOUCHER"
            : "RECEIPT";
  const documentId = expense
    ? expense.id
    : receipt.invoiceId ??
      receipt.workOrderId ??
      receipt.reservationId ??
      receipt.voucherNumber ??
      receipt.id;
  return {
    documentType,
    documentId,
    expenseId: expense?.id ?? null,
    expenseIds: receipt.linkedExpenseIds,
    invoiceId: receipt.invoiceId,
    workOrderId: receipt.workOrderId,
    reservationId: receipt.reservationId,
    voucherNumber: receipt.voucherNumber,
    referenceNumber: receipt.referenceNumber ?? expense?.referenceNumber ?? null,
    ledgerEntryIds: receipt.ledgerEntryIds,
    ledgerEntryTypes: receipt.ledgerEntryTypes,
  };
}

function duplicateKey(receipt: RawRemediationReceipt): string | null {
  if (receipt.expense) return `EXPENSE:${receipt.expense.id}`;
  const reference = receipt.referenceNumber?.trim() || receipt.voucherNumber?.trim();
  if (!reference) return null;
  return [
    receipt.shiftId,
    receipt.direction,
    receipt.paymentMethod,
    receipt.cashBucket ?? "NONE",
    toDbMoney(money(receipt.amount)),
    reference,
  ].join(":");
}

function baseEvidence(receipt: RawRemediationReceipt): EvidenceMissing[] {
  const missing: EvidenceMissing[] = [];
  const hasDocument = Boolean(
    receipt.expense ||
      receipt.invoiceId ||
      receipt.workOrderId ||
      receipt.reservationId ||
      receipt.voucherNumber,
  );
  if (!hasDocument) missing.push("SOURCE_DOCUMENT");
  if (!receipt.partyId && !receipt.counterpartyName && !receipt.expense?.payee) {
    missing.push("COUNTERPARTY");
  }
  if (!receipt.attachmentUrl) missing.push("PAYMENT_PROOF");
  if (receipt.ledgerEntryIds.length === 0) missing.push("LEDGER_ENTRY");
  return missing;
}

function classify(
  receipt: RawRemediationReceipt,
  duplicateOfReceiptId: number | null,
  causedNegative: boolean,
  reversal: { verified: boolean; evidenceMissing: EvidenceMissing[] } | null,
): ClassificationResult {
  const evidenceMissing = baseEvidence(receipt);
  const pairedInternalTransfer = receipt.pairedTreasuryReceiptId != null;
  if (pairedInternalTransfer) {
    const fullyAccepted =
      receipt.pairedTreasuryReceiptStatus === "COMPLETED" &&
      receipt.pairedTreasuryApprovalStatus === "APPROVED" &&
      receipt.ledgerEntryTypes.includes("CASH_HANDOVER");
    const transferEvidence: EvidenceMissing[] = [];
    if (
      receipt.pairedTreasuryReceiptStatus !== "COMPLETED" ||
      receipt.pairedTreasuryApprovalStatus !== "APPROVED"
    ) {
      transferEvidence.push("TREASURY_HANDOVER_OR_FUNDING_PROOF", "MANAGER_DECISION");
    }
    if (!receipt.ledgerEntryTypes.includes("CASH_HANDOVER")) transferEvidence.push("LEDGER_ENTRY");
    return {
      classification: fullyAccepted
        ? "VERIFIED_INTERNAL_TRANSFER"
        : "UNVERIFIED_INTERNAL_TRANSFER",
      confidence: fullyAccepted ? "HIGH" : "LOW",
      rationale:
        fullyAccepted
          ? receipt.referenceNumber?.startsWith("CH-")
            ? "تسليم إغلاق مثبت بإيصال خزينة مكتمل ومعتمد؛ مستبعد من متوقع الدرج كما في تقرير الوردية."
            : "سحب نقدي داخلي مثبت بإيصال خزينة مكتمل ومعتمد؛ يبقى خارج الدرج ويظهر كسحب تشغيلي."
          : "يوجد زوج خزينة مطابق بنيوياً لكنه غير مكتمل/غير معتمد؛ يُحافظ على حساب الوردية القائم ولا يُعد إثبات تسوية.",
      evidenceMissing: transferEvidence,
      duplicateOfReceiptId: null,
    };
  }
  if (receipt.linkedExpenseIds.length > 1) {
    return {
      classification: "DUPLICATE_OR_ERROR",
      confidence: "HIGH",
      rationale: `الإيصال مرتبط بأكثر من مستند مصروف (${receipt.linkedExpenseIds.join("، ")})؛ يجب حسم التعارض قبل أي تسوية.`,
      evidenceMissing: Array.from(
        new Set<EvidenceMissing>([...evidenceMissing, "CONFIRM_SINGLE_PHYSICAL_PAYMENT", "MANAGER_DECISION"]),
      ),
      duplicateOfReceiptId: null,
    };
  }
  if (reversal != null) {
    const verified = reversal.verified;
    return {
      classification: verified ? "VERIFIED_REVERSAL" : "UNVERIFIED_REVERSAL",
      confidence: verified ? "HIGH" : "LOW",
      rationale: verified
        ? "المصروف ملغى، والأصل REVERSED، والتعويض مكتمل ومعتمد، وقيدا PAYMENT_OUT/PAYMENT_IN موجودان؛ الأثر متصافر."
        : "توجد بصمة إلغاء وتعويض، لكن الحالة/الاعتماد/القيد غير مكتمل؛ لا يُعد العكس مثبتاً ولا يقبل محاكاة ثانية.",
      evidenceMissing: reversal.evidenceMissing,
      duplicateOfReceiptId: null,
    };
  }
  if (duplicateOfReceiptId != null) {
    return {
      classification: "DUPLICATE_OR_ERROR",
      confidence: receipt.expense ? "HIGH" : "MEDIUM",
      rationale: `توجد حركة OUT أسبق تحمل المصدر/البصمة نفسها (الإيصال #${duplicateOfReceiptId}).`,
      evidenceMissing: Array.from(
        new Set<EvidenceMissing>([...evidenceMissing, "CONFIRM_SINGLE_PHYSICAL_PAYMENT", "MANAGER_DECISION"]),
      ),
      duplicateOfReceiptId,
    };
  }
  const expenseMismatch =
    receipt.expense != null &&
    (receipt.expense.status === "CANCELLED" ||
      receipt.expense.paymentMethod !== receipt.paymentMethod ||
      receipt.expense.cashBucket !== receipt.cashBucket ||
      !money(receipt.expense.amount).eq(money(receipt.amount)));
  if (expenseMismatch) {
    return {
      classification: "DUPLICATE_OR_ERROR",
      confidence: "HIGH",
      rationale: "بيانات إيصال الصرف لا تطابق مستند المصروف المرتبط أو أن المصروف ملغى.",
      evidenceMissing: Array.from(new Set<EvidenceMissing>([...evidenceMissing, "MANAGER_DECISION"])),
      duplicateOfReceiptId: null,
    };
  }
  if (causedNegative && receipt.paymentMethod === "CASH" && receipt.cashBucket === "DRAWER") {
    return {
      classification: "MISSING_INTERNAL_TRANSFER",
      confidence: "LOW",
      rationale:
        "هذه أول حركة جعلت الرصيد الجاري سالباً؛ نقص التحويل فرضية تشخيصية فقط ولا يُرحّل بلا إثبات.",
      evidenceMissing: Array.from(
        new Set<EvidenceMissing>([
          ...evidenceMissing,
          "TREASURY_HANDOVER_OR_FUNDING_PROOF",
          "EMPLOYEE_DECLARATION",
          "PHYSICAL_CASH_COUNT",
          "MANAGER_DECISION",
        ]),
      ),
      duplicateOfReceiptId: null,
    };
  }
  return {
    classification: "UNRESOLVED",
    confidence: "LOW",
    rationale:
      "لا تكفي البيانات البنيوية لإثبات أن الدفع من الدرج أو الخزينة أو مال الموظف؛ يلزم مستند خارجي وموافقة.",
    evidenceMissing: Array.from(
      new Set<EvidenceMissing>([
        ...evidenceMissing,
        "EMPLOYEE_DECLARATION",
        "PHYSICAL_CASH_COUNT",
        "MANAGER_DECISION",
      ]),
    ),
    duplicateOfReceiptId: null,
  };
}

function simulationDelta(
  receipt: RawRemediationReceipt,
  selected: RemediationClassification | null,
) {
  const zero = money("0");
  if (!selected) {
    return {
      selectedClassification: null,
      drawerDelta: toDbMoney(zero),
      treasuryDelta: toDbMoney(zero),
      employeePayableDelta: toDbMoney(zero),
      expenseDelta: toDbMoney(zero),
    };
  }
  const amount = money(receipt.amount);
  const reversesDrawer =
    receipt.paymentMethod === "CASH" &&
    receipt.cashBucket === "DRAWER" &&
    !(receipt.pairedTreasuryReceiptId != null && receipt.referenceNumber?.startsWith("CH-"));
  const drawerDelta = reversesDrawer ? amount : zero;
  const treasuryDelta =
    selected === "TREASURY_PAID" || selected === "MISSING_INTERNAL_TRANSFER"
      ? amount.negated()
      : zero;
  const employeePayableDelta = selected === "EMPLOYEE_PERSONAL_PAID" ? amount : zero;
  const expenseDelta =
    selected === "DUPLICATE_OR_ERROR" && receipt.expense ? amount.negated() : zero;
  return {
    selectedClassification: selected,
    drawerDelta: toDbMoney(drawerDelta),
    treasuryDelta: toDbMoney(treasuryDelta),
    employeePayableDelta: toDbMoney(employeePayableDelta),
    expenseDelta: toDbMoney(expenseDelta),
  };
}

export function analyzeCashRemediation(
  dataset: RawCashRemediationDataset,
  filters: CashRemediationFilters,
  generatedAt = new Date(),
): CashRemediationReport {
  const simulations = new Map<number, RemediationClassification>();
  for (const item of filters.simulations ?? []) {
    if (simulations.has(item.receiptId)) {
      throw new Error(`الإيصال #${item.receiptId} مكرر في مدخلات المحاكاة`);
    }
    simulations.set(item.receiptId, item.classification);
  }

  const receiptById = new Map(dataset.receipts.map((receipt) => [receipt.id, receipt]));
  simulations.forEach((_classification, receiptId) => {
    const receipt = receiptById.get(receiptId);
    if (!receipt || receipt.direction !== "OUT") {
      throw new Error(`الإيصال #${receiptId} ليس حركة OUT ضمن نطاق التقرير`);
    }
    if (
      receipt.paymentMethod !== "CASH" ||
      receipt.cashBucket !== "DRAWER" ||
      receipt.pairedTreasuryReceiptId != null ||
      receipt.status === "REVERSED" ||
      receipt.linkedExpenseIds.length > 1
    ) {
      throw new Error(
        `الإيصال #${receiptId} لا يقبل محاكاة تسوية: لا يؤثر في سالب الدرج أو أنه تحويل داخلي مثبت`,
      );
    }
  });

  const shiftReports: CashRemediationShiftReport[] = [];
  for (const shift of dataset.shifts) {
    const shiftReceipts = dataset.receipts
      .filter((receipt) => receipt.shiftId === shift.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
    let running = money(shift.openingBalance);
    let firstNegative: CashRemediationShiftReport["firstNegative"] = running.isNegative()
      ? {
          point: "OPENING",
          receiptId: null,
          occurredAt: shift.openedAt.toISOString(),
          balance: toDbMoney(running),
        }
      : null;
    const runningByReceipt = new Map<number, { before: string; after: string }>();

    for (const receipt of shiftReceipts) {
      const before = running;
      const affectsDrawer = receipt.paymentMethod === "CASH" && receipt.cashBucket === "DRAWER";
      const excludedClosingHandover =
        affectsDrawer &&
        receipt.direction === "OUT" &&
        receipt.pairedTreasuryReceiptId != null &&
        Boolean(receipt.referenceNumber?.startsWith("CH-"));
      if (affectsDrawer && !excludedClosingHandover) {
        running = receipt.direction === "IN"
          ? running.plus(money(receipt.amount))
          : running.minus(money(receipt.amount));
      }
      runningByReceipt.set(receipt.id, {
        before: toDbMoney(before),
        after: toDbMoney(running),
      });
      if (!firstNegative && running.isNegative()) {
        firstNegative = {
          point: "RECEIPT",
          receiptId: receipt.id,
          occurredAt: receipt.createdAt.toISOString(),
          balance: toDbMoney(running),
        };
      }
    }

    const seenDuplicates = new Map<string, number>();
    const reversalByReceipt = new Map<
      number,
      { verified: boolean; evidenceMissing: EvidenceMissing[] }
    >();
    for (const receipt of shiftReceipts) {
      const expense = receipt.expense;
      if (!expense || expense.status !== "CANCELLED" || receipt.status !== "REVERSED") continue;
      const compensation = shiftReceipts.find(
        (candidate) =>
          candidate.direction === "IN" &&
          candidate.referenceNumber === `CANCEL-EXP-${expense.id}` &&
          candidate.paymentMethod === receipt.paymentMethod &&
          candidate.cashBucket === receipt.cashBucket &&
          money(candidate.amount).eq(money(receipt.amount)),
      );
      if (!compensation) continue;
      const verified =
        compensation.status === "COMPLETED" &&
        compensation.approvalStatus === "APPROVED" &&
        receipt.ledgerEntryTypes.includes("PAYMENT_OUT") &&
        compensation.ledgerEntryTypes.includes("PAYMENT_IN");
      const reversalEvidence: EvidenceMissing[] = [];
      if (
        compensation.status !== "COMPLETED" ||
        compensation.approvalStatus !== "APPROVED"
      ) {
        reversalEvidence.push("PAYMENT_PROOF", "MANAGER_DECISION");
      }
      if (
        !receipt.ledgerEntryTypes.includes("PAYMENT_OUT") ||
        !compensation.ledgerEntryTypes.includes("PAYMENT_IN")
      ) {
        reversalEvidence.push("LEDGER_ENTRY");
      }
      reversalByReceipt.set(receipt.id, { verified, evidenceMissing: reversalEvidence });
    }
    const outflows: CashRemediationOutRow[] = [];
    for (const receipt of shiftReceipts.filter((row) => row.direction === "OUT")) {
      const key = duplicateKey(receipt);
      const duplicateOfReceiptId = key ? (seenDuplicates.get(key) ?? null) : null;
      if (key && duplicateOfReceiptId == null) seenDuplicates.set(key, receipt.id);
      const classification = classify(
        receipt,
        duplicateOfReceiptId,
        firstNegative?.point === "RECEIPT" && firstNegative.receiptId === receipt.id,
        reversalByReceipt.get(receipt.id) ?? null,
      );
      const balances = runningByReceipt.get(receipt.id)!;
      const excludedClosingHandover =
        receipt.paymentMethod === "CASH" &&
        receipt.cashBucket === "DRAWER" &&
        receipt.pairedTreasuryReceiptId != null &&
        Boolean(receipt.referenceNumber?.startsWith("CH-"));
      outflows.push({
        receiptId: receipt.id,
        shiftId: receipt.shiftId,
        createdAt: receipt.createdAt.toISOString(),
        amount: toDbMoney(money(receipt.amount)),
        paymentMethod: receipt.paymentMethod,
        cashBucket: receipt.cashBucket,
        status: receipt.status,
        approvalStatus: receipt.approvalStatus,
        description: receipt.description ?? receipt.expense?.description ?? null,
        actorId: receipt.createdBy,
        actorName: receipt.createdByName,
        counterpartyName: receipt.counterpartyName ?? receipt.expense?.payee ?? null,
        source: sourceOf(receipt),
        affectsDrawer:
          receipt.paymentMethod === "CASH" &&
          receipt.cashBucket === "DRAWER" &&
          !excludedClosingHandover,
        excludedClosingHandover,
        pairedTreasuryReceiptId: receipt.pairedTreasuryReceiptId,
        pairedTreasuryReceiptStatus: receipt.pairedTreasuryReceiptStatus,
        pairedTreasuryApprovalStatus: receipt.pairedTreasuryApprovalStatus,
        runningBalanceBefore: balances.before,
        runningBalanceAfter: balances.after,
        suggestedClassification: classification.classification,
        confidence: classification.confidence,
        rationale: classification.rationale,
        evidenceMissing: classification.evidenceMissing,
        duplicateOfReceiptId: classification.duplicateOfReceiptId,
        simulation: simulationDelta(receipt, simulations.get(receipt.id) ?? null),
      });
    }

    const sumSimulation = (key: keyof CashRemediationOutRow["simulation"]) =>
      outflows.reduce((sum, row) => {
        const value = row.simulation[key];
        return typeof value === "string" ? sum.plus(money(value)) : sum;
      }, money("0"));
    const drawerDelta = sumSimulation("drawerDelta");
    const treasuryDelta = sumSimulation("treasuryDelta");
    const employeePayableDelta = sumSimulation("employeePayableDelta");
    const expenseDelta = sumSimulation("expenseDelta");
    const counted = shift.countedCash == null ? null : money(shift.countedCash);
    const afterExpected = running.plus(drawerDelta);
    shiftReports.push({
      shift: {
        id: shift.id,
        branchId: shift.branchId,
        branchName: shift.branchName,
        userId: shift.userId,
        userName: shift.userName,
        shiftType: shift.shiftType,
        status: shift.status,
        openedAt: shift.openedAt.toISOString(),
        closedAt: shift.closedAt?.toISOString() ?? null,
      },
      firstNegative,
      before: {
        openingBalance: toDbMoney(money(shift.openingBalance)),
        computedExpectedCash: toDbMoney(running),
        storedExpectedCash:
          shift.storedExpectedCash == null ? null : toDbMoney(money(shift.storedExpectedCash)),
        countedCash: counted == null ? null : toDbMoney(counted),
        computedVariance: counted == null ? null : toDbMoney(counted.minus(running)),
        storedVariance:
          shift.storedVariance == null ? null : toDbMoney(money(shift.storedVariance)),
      },
      afterSimulation: {
        expectedCash: toDbMoney(afterExpected),
        variance: counted == null ? null : toDbMoney(counted.minus(afterExpected)),
        drawerDelta: toDbMoney(drawerDelta),
        treasuryDelta: toDbMoney(treasuryDelta),
        employeePayableDelta: toDbMoney(employeePayableDelta),
        expenseDelta: toDbMoney(expenseDelta),
      },
      outflows,
    });
  }

  const sumShift = (
    pick: (shift: CashRemediationShiftReport) => string,
  ) => shiftReports.reduce((sum, shift) => sum.plus(money(pick(shift))), money("0"));
  const { simulations: _simulations, ...reportedFilters } = filters;
  return {
    mode: "DRY_RUN_READ_ONLY",
    generatedAt: generatedAt.toISOString(),
    filters: reportedFilters,
    safeguards: {
      mutationsAvailable: false,
      postedDocuments: 0,
      postedLedgerEntries: 0,
      sourceRowsChanged: 0,
    },
    summary: {
      shiftCount: shiftReports.length,
      negativeShiftCount: shiftReports.filter((shift) => shift.firstNegative != null).length,
      outflowCount: shiftReports.reduce((count, shift) => count + shift.outflows.length, 0),
      unresolvedCount: shiftReports.reduce(
        (count, shift) =>
          count + shift.outflows.filter((row) => row.suggestedClassification === "UNRESOLVED").length,
        0,
      ),
      beforeExpectedCash: toDbMoney(sumShift((shift) => shift.before.computedExpectedCash)),
      afterExpectedCash: toDbMoney(sumShift((shift) => shift.afterSimulation.expectedCash)),
      drawerDelta: toDbMoney(sumShift((shift) => shift.afterSimulation.drawerDelta)),
      treasuryDelta: toDbMoney(sumShift((shift) => shift.afterSimulation.treasuryDelta)),
      employeePayableDelta: toDbMoney(sumShift((shift) => shift.afterSimulation.employeePayableDelta)),
      expenseDelta: toDbMoney(sumShift((shift) => shift.afterSimulation.expenseDelta)),
    },
    shifts: shiftReports,
  };
}
