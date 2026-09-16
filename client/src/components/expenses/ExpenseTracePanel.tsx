import { Loader2 } from "lucide-react";
import { FinancialTraceDetails } from "@/components/financial/FinancialTraceDetails";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { fmt } from "@/lib/money";
import { expenseAuditDetail } from "@/lib/expenseUiPolicy";
import { trpc } from "@/lib/trpc";
import {
  expenseCategoryText,
  fundingDetail,
  fundingKindOf,
  SHIFT_STATUS_LABEL,
  SHIFT_TYPE_LABEL,
  STATUS_LABEL,
  warningsOf,
  type ExpenseRow,
} from "./expenseView";

/** لوحةُ مسار المصروف (المستند → الإيصال → القيد → أيّ إلغاء/عكس) — استُخرجت من Expenses.tsx. */
export function ExpenseTracePanel({ expenseId }: { expenseId: number }) {
  const trace = trpc.expenses.trace.useQuery({ expenseId });

  if (trace.isLoading) {
    return (
      <div className="flex min-h-28 items-center justify-center gap-2 rounded-lg border bg-muted/20 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        جارٍ تحميل مسار المستند والقيد…
      </div>
    );
  }
  if (trace.isError || !trace.data) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        تعذّر تحميل مسار التتبّع لهذا المصروف.
      </div>
    );
  }

  const expense = trace.data.expense as ExpenseRow;
  const directReceiptId =
    expense.receiptId == null ? null : Number(expense.receiptId);
  const settlementReceiptId =
    expense.settlementReceiptId == null
      ? null
      : Number(expense.settlementReceiptId);
  const receiptId = settlementReceiptId ?? directReceiptId;
  const obligationEvents = trace.data.obligationEvents ?? [];
  const warnings = warningsOf(expense);
  const reversal = trace.data.reversalReceipts[0];

  return (
    <FinancialTraceDetails
      compact
      title={`مسار المصروف EXP#${expenseId}`}
      description="سلسلة المستند من الإدخال إلى إيصال الصرف والقيد المحاسبي وأي إلغاء أو عكس لاحق."
      document={{
        id: expenseId,
        number: `EXP#${expenseId}`,
        type: "مصروف",
        status: STATUS_LABEL[expense.status] ?? expense.status,
        statusTone:
          expense.status === "REJECTED"
            ? "critical"
            : expense.status === "PENDING_APPROVAL" ||
                expense.status === "CANCELLED"
              ? "warning"
              : "ok",
        direction: "OUT",
        amount: `${fmt(expense.amount)} د.ع`,
        branch: expense.branchName,
        reference: expense.referenceNumber,
        description: expense.description?.trim() || "لا يوجد شرح للعملية",
        extra: [
          {
            label: "الفئة / مركز التكلفة",
            value: `${expenseCategoryText(expense)}${expense.costCenter ? ` · ${expense.costCenter}` : ""}`,
          },
          { label: "حالة الاعتماد", value: expense.approvalStatus },
          { label: "حالة الاستحقاق", value: expense.settlementStatus },
          {
            label: "مرجع دليل المصدر",
            value: expense.accrualEvidenceReference,
          },
        ],
      }}
      parties={{
        recordedBy: {
          name: expense.createdByName,
          id: expense.createdBy,
          at: fmtDateTime(expense.createdAt as unknown as string),
        },
        executedBy: {
          name: expense.createdByName,
          id: expense.createdBy,
          note: receiptId
            ? `منفذ إيصال الصرف R#${receiptId}`
            : "لا يوجد إيصال صرف مرتبط",
        },
        beneficiary: { name: expense.payee || "غير محدد" },
        approvedBy: expense.approvedByName
          ? { name: expense.approvedByName, note: expense.approvalStatus }
          : {
              name: "غير موثق",
              note: expense.approvalStatus ?? "لا توجد موافقة ظاهرة",
            },
        reversedBy: reversal
          ? {
              name:
                reversal.createdByName ??
                (reversal.createdBy ? `#${reversal.createdBy}` : "غير موثق"),
              id: reversal.createdBy,
              at: fmtDateTime(reversal.createdAt),
              note: `إيصال عكس R#${reversal.id}`,
            }
          : null,
      }}
      moneyPath={{
        paymentMethod: expense.paymentMethod,
        source: fundingKindOf(expense),
        cashBucket: expense.cashBucket,
        branch: expense.branchName,
        shiftId: expense.shiftId,
        shiftLabel: expense.shiftType
          ? `${SHIFT_TYPE_LABEL[expense.shiftType] ?? expense.shiftType} · ${SHIFT_STATUS_LABEL[expense.shiftStatus ?? ""] ?? expense.shiftStatus ?? "—"}`
          : null,
        shiftOwner: expense.shiftOwnerName,
        from: fundingDetail(expense),
        to: expense.payee || "المستفيد غير محدد",
        externalReference: expense.referenceNumber,
        extra: [
          {
            label: "المبلغ المصروف",
            value: fmt(expense.amount),
            dir: "ltr",
            emphasis: true,
          },
          { label: "حالة الإيصال المباشر", value: expense.receiptStatus },
          {
            label: "قيد الاعتراف",
            value: expense.recognitionAccountingEntryId
              ? `JE#${expense.recognitionAccountingEntryId}`
              : null,
          },
          {
            label: "قيد التسوية",
            value: expense.settlementAccountingEntryId
              ? `JE#${expense.settlementAccountingEntryId}`
              : null,
          },
        ],
      }}
      linkChain={[
        {
          kind: "DOCUMENT",
          label: "المصروف",
          value: `EXP#${expenseId}`,
          status: STATUS_LABEL[expense.status] ?? expense.status,
        },
        ...(expense.source === "ACCRUAL"
          ? obligationEvents.map((event) => ({
              id: `accrual-event-${event.id}`,
              kind: (event.accountingEntryId
                ? "LEDGER"
                : event.receiptId
                  ? "RECEIPT"
                  : "DOCUMENT") as "LEDGER" | "RECEIPT" | "DOCUMENT",
              label:
                event.eventType === "RECOGNIZED"
                  ? "اعتراف الاستحقاق"
                  : event.eventType === "PAYMENT_REQUESTED"
                    ? "طلب التسوية — صفر أثر نقدي"
                    : event.eventType === "PAYMENT_SETTLED"
                      ? "التسوية الفعلية"
                      : event.eventType === "RECOGNITION_REVERSED"
                        ? "عكس الاعتراف"
                        : event.eventType,
              value: event.accountingEntryId
                ? `JE#${event.accountingEntryId}`
                : event.receiptId
                  ? `R#${event.receiptId}`
                  : `AOE#${event.id}`,
              status: event.eventType,
              subtitle: `${fmt(event.amount)} د.ع · ${event.evidenceReference}`,
            }))
          : [
              {
                kind: "RECEIPT" as const,
                label: "إيصال الصرف",
                value: directReceiptId ? `R#${directReceiptId}` : null,
                status: expense.receiptStatus,
                missing: !directReceiptId,
              },
            ]),
        ...trace.data.ledgerEntries.map((entry) => ({
          id: entry.id,
          kind: "LEDGER" as const,
          label: "القيد المحاسبي",
          value: `JE#${entry.id}`,
          status: entry.entryType,
          subtitle: `${fmt(entry.amount ?? 0)} د.ع${entry.notes ? ` · ${entry.notes}` : ""}`,
        })),
        ...trace.data.reversalReceipts.map((entry) => ({
          id: `reversal-${entry.id}`,
          kind: "RECEIPT" as const,
          label: "إيصال الإلغاء / العكس",
          value: `R#${entry.id}`,
          status: entry.status,
          subtitle: `${fmt(entry.amount)} د.ع · ${entry.createdByName ?? "منفذ غير موثق"}`,
        })),
      ]}
      timestamps={[
        {
          id: "expense-date",
          label: "تاريخ المصروف",
          value: fmtDate(expense.expenseDate as unknown as string),
        },
        {
          id: "created-at",
          label: "وقت الإدخال",
          value: fmtDateTime(expense.createdAt as unknown as string),
          actor: expense.createdByName,
        },
        {
          id: "updated-at",
          label: "آخر تحديث",
          value: fmtDateTime(expense.updatedAt),
        },
      ]}
      integrityWarnings={warnings.map((warning, index) => ({
        id: `${expenseId}-${index}`,
        severity: "warning" as const,
        title: warning,
        code: (expense.integrityWarnings ?? [])[index] ?? null,
      }))}
      auditTimeline={[
        ...trace.data.auditTrail.map((event) => ({
          id: `audit-${event.id}`,
          action: event.action,
          actor:
            event.userName ?? (event.userId ? `#${event.userId}` : "غير موثق"),
          at: fmtDateTime(event.createdAt),
          detail: expenseAuditDetail(
            event.action,
            event.oldValue,
            event.newValue,
          ),
          tone: "info" as const,
        })),
        ...trace.data.reversalReceipts.map((event) => ({
          id: `reverse-event-${event.id}`,
          action: "إلغاء / عكس المصروف",
          actor:
            event.createdByName ??
            (event.createdBy ? `#${event.createdBy}` : "غير موثق"),
          at: fmtDateTime(event.createdAt),
          status: event.status,
          detail: `${fmt(event.amount)} د.ع`,
          tone: "warning" as const,
        })),
        ...trace.data.correctionRequests.map((event) => ({
          id: `accrual-correction-${event.id}`,
          action: "تصحيح مصدر الاستحقاق",
          actor: `#${event.requestedBy}`,
          at: fmtDateTime(event.requestedAt),
          status: event.status,
          detail: `${event.reason} · ${event.externalEvidenceReference}`,
          tone:
            event.status === "APPROVED"
              ? ("ok" as const)
              : event.status === "REJECTED"
                ? ("warning" as const)
                : ("info" as const),
        })),
      ]}
    />
  );
}
