import { RowActions } from "@/components/list";
import { FinancialTraceDetails } from "@/components/financial/FinancialTraceDetails";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { useFocusHighlight } from "@/components/search/useFocusHighlight";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TablePager } from "@/components/table/TablePager";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows, type ExportColumn } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { notify } from "@/lib/notify";
import { D, fmt } from "@/lib/money";
import { printDoc } from "@/lib/printing/print";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { INBOUND_METHOD_OPTIONS } from "@/lib/paymentMethod";
import type { InboundEnabledPaymentMethod } from "@shared/inboundPaymentPolicy";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import {
  AlertTriangle,
  Ban,
  Building2,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleDollarSign,
  Landmark,
  Layers3,
  Loader2,
  Printer,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  UserRound,
  WalletCards,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  expenseAuditDetail,
  expenseStatusFromSearch,
  isExpenseFinanciallyPrintable,
} from "./expenseUiPolicy";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const CATEGORY_LABEL: Record<string, string> = {
  RENT: "إيجار",
  UTILITIES: "خدمات/فواتير",
  SUPPLIES: "لوازم",
  SALARY: "مرتبات",
  TRANSPORT: "مواصلات/شحن",
  MAINTENANCE: "صيانة",
  MARKETING: "تسويق",
  OTHER: "أخرى",
};

const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  CHECK: "صك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
  ACCRUAL: "استحقاق",
};

// production-slice: مصدر الصرف من المخزون (نثرية/تلف) بدل طريقة الدفع.
const STOCK_REASON_LABEL: Record<string, string> = {
  INTERNAL_USE: "نثرية (مخزون)",
  WASTAGE: "تلف (مخزون)",
};
function sourceLabel(r: {
  source?: string | null;
  stockReason?: string | null;
  paymentMethod: string;
}) {
  if (r.source === "STOCK")
    return STOCK_REASON_LABEL[r.stockReason ?? ""] ?? "مخزون";
  return METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod;
}

const STATUS_CLS: Record<string, string> = {
  PENDING_APPROVAL: "badge-status-pending",
  ACTIVE: "badge-status-active",
  REJECTED: "badge-status-cancelled",
  CANCELLED: "badge-status-cancelled",
};
const STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: "بانتظار اعتماد المالك",
  ACTIVE: "نافذ",
  REJECTED: "مرفوض بلا صرف",
  CANCELLED: "مُلغى",
};

/** حجم صفحة القائمة — الخادم يُرقّم (سقفه ١٠٠٠). */
const PAGE_SIZE = 50;

type ExpenseRowBase = RouterOutputs["expenses"]["list"]["rows"][number];

/**
 * عقد العرض الموسّع. جميع الحقول اختيارية عمداً حتى يبقى نشر الواجهة آمناً أثناء
 * ترقية خدمة المصروفات، وتظهر «—» بدلاً من كسر الشاشة عند سجل تاريخي ناقص.
 */
type ExpenseRow = ExpenseRowBase &
  Partial<{
    cashBucket: "DRAWER" | "TREASURY" | null;
    payee: string | null;
    costCenter: string | null;
    receiptId: number | null;
    createdBy: number | null;
    createdByName: string | null;
    shiftOwnerName: string | null;
    shiftType: string | null;
    shiftStatus: string | null;
    receiptVoucherNumber: string | null;
    receiptStatus: string | null;
    approvalStatus: string | null;
    approvedByName: string | null;
    updatedAt: string | Date | null;
    fundingKind: string | null;
    integrityWarnings: string[] | null;
    accrualObligationId: number | null;
    accrualKind: string | null;
    settlementStatus: string | null;
    accrualBeneficiaryName: string | null;
    accrualEvidenceReference: string | null;
    recognitionAccountingEntryId: number | null;
    settlementAccountingEntryId: number | null;
    settlementReceiptId: number | null;
  }>;

type ExpenseTotals = {
  active?: string | number | null;
  pendingApproval?: string | number | null;
  rejected?: string | number | null;
  count?: number | null;
  drawer?: string | number | null;
  treasury?: string | number | null;
  nonCash?: string | number | null;
  stock?: string | number | null;
  cancelled?: string | number | null;
  needsAudit?: string | number | null;
  missingDescription?: string | number | null;
  missingPayee?: string | number | null;
  sourceMismatch?: string | number | null;
  drawerMismatch?: string | number | null;
  accruedUnpaid?: string | number | null;
  accruedPaid?: string | number | null;
};

type FundingKind =
  | "PENDING"
  | "DRAWER"
  | "TREASURY"
  | "NON_CASH"
  | "ACCRUED_UNPAID"
  | "ACCRUED_PAID"
  | "STOCK"
  | "UNATTRIBUTED";

type AuditFocus = "DESCRIPTION" | "PAYEE" | "SOURCE" | "DRAWER";

const FUNDING_ORDER: FundingKind[] = [
  "PENDING",
  "DRAWER",
  "TREASURY",
  "NON_CASH",
  "ACCRUED_UNPAID",
  "ACCRUED_PAID",
  "STOCK",
  "UNATTRIBUTED",
];
const FUNDING_META: Record<
  FundingKind,
  { label: string; short: string; badge: string }
> = {
  PENDING: {
    label: "طلبات اعتماد غير منفذة",
    short: "بلا أثر مالي",
    badge: "badge-status-pending",
  },
  DRAWER: {
    label: "مصروفات الأدراج والورديات",
    short: "درج وردية",
    badge: "badge-status-active",
  },
  TREASURY: {
    label: "مصروفات الخزينة الإدارية",
    short: "خزينة إدارية",
    badge: "badge-status-pending",
  },
  NON_CASH: {
    label: "مصروفات غير نقدية",
    short: "غير نقدي",
    badge: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  },
  ACCRUED_UNPAID: {
    label: "مصروفات مستحقة غير مدفوعة",
    short: "مستحق غير مدفوع",
    badge: "badge-status-pending",
  },
  ACCRUED_PAID: {
    label: "مصروفات مستحقة سُوّيت فعلياً",
    short: "استحقاق مسوّى",
    badge: "badge-status-active",
  },
  STOCK: {
    label: "مصروفات من المخزون بالكلفة",
    short: "مخزون",
    badge: "badge-stock-low",
  },
  UNATTRIBUTED: {
    label: "مصروفات تحتاج تحديد مصدر التمويل",
    short: "مصدر غير محسوم",
    badge: "badge-status-cancelled",
  },
};

const SHIFT_TYPE_LABEL: Record<string, string> = {
  RETAIL: "تجزئة",
  RECEPTION: "استقبال",
  PRINT_SERVICES: "خدمات الطباعة",
};
const SHIFT_STATUS_LABEL: Record<string, string> = {
  OPEN: "مفتوحة",
  CLOSED: "مغلقة",
};
const APPROVAL_LABEL: Record<string, string> = {
  APPROVED: "معتمد",
  PENDING_APPROVAL: "بانتظار الاعتماد",
  REJECTED: "مرفوض",
};

function fundingKindOf(r: ExpenseRow): FundingKind {
  if (r.status === "PENDING_APPROVAL" || r.status === "REJECTED")
    return "PENDING";
  if (r.fundingKind && FUNDING_ORDER.includes(r.fundingKind as FundingKind))
    return r.fundingKind as FundingKind;
  if (r.source === "STOCK") return "STOCK";
  if (r.paymentMethod !== "CASH") return "NON_CASH";
  if (r.cashBucket === "TREASURY") return "TREASURY";
  if (r.cashBucket === "DRAWER" || r.shiftId != null) return "DRAWER";
  return "UNATTRIBUTED";
}

/** رسائل تدقيق مفهومة للمستخدم بدلاً من رموز السلامة الداخلية. */
const AUDIT_WARNING_LABEL: Record<string, string> = {
  DESCRIPTION_MISSING: "لا يوجد شرح للعملية",
  PAYEE_MISSING: "المستفيد غير محدد",
  RECEIPT_MISSING: "إيصال الصرف غير مرتبط",
  RECEIPT_DIRECTION_MISMATCH: "اتجاه الإيصال لا يطابق عملية الصرف",
  RECEIPT_AMOUNT_MISMATCH: "مبلغ الإيصال لا يطابق المصروف",
  RECEIPT_BRANCH_MISMATCH: "فرع الإيصال لا يطابق فرع المصروف",
  RECEIPT_SHIFT_MISMATCH: "وردية الإيصال لا تطابق وردية المصروف",
  RECEIPT_PAYMENT_METHOD_MISMATCH: "طريقة دفع الإيصال غير مطابقة",
  RECEIPT_CASH_BUCKET_MISMATCH: "مصدر النقد في الإيصال غير مطابق",
  RECEIPT_CREATOR_MISMATCH: "منشئ الإيصال لا يطابق منشئ المصروف",
  RECEIPT_STATUS_MISMATCH: "حالة الإيصال لا تطابق حالة المصروف",
  RECEIPT_NOT_APPROVED: "إيصال الصرف غير معتمد",
  CASH_FUNDING_UNKNOWN: "مصدر النقد غير محسوم",
  DRAWER_WITHOUT_SHIFT: "صرف درج بلا وردية",
  TREASURY_WITH_SHIFT: "صرف خزينة مرتبط خطأً بورديّة",
  NON_CASH_HAS_CASH_BUCKET: "عملية غير نقدية مرتبطة بدرج أو خزينة",
  STOCK_HAS_RECEIPT: "صرف مخزون مرتبط خطأً بإيصال نقدي",
  STOCK_HAS_CASH_LOCATION: "صرف مخزون مرتبط خطأً بدرج أو خزينة",
  PENDING_RECEIPT_MISMATCH: "طلب الاعتماد لا يطابق إيصالاً معلّقاً",
  REJECTED_RECEIPT_MISMATCH: "رفض الطلب لا يطابق حالة الإيصال",
  UNEXECUTED_HAS_CASH_LOCATION: "طلب غير منفذ مرتبط خطأً بمصدر نقد",
  ACCRUAL_PAYMENT_METHOD_MISMATCH:
    "طريقة المصروف المستحق لا تطابق عقد الاستحقاق",
  ACCRUAL_HAS_DIRECT_RECEIPT:
    "الاعتراف بالاستحقاق مرتبط خطأً بإيصال نقدي مباشر",
  ACCRUAL_HAS_CASH_LOCATION: "الاعتراف بالاستحقاق مرتبط خطأً بدرج أو خزينة",
  ACCRUAL_OBLIGATION_MISSING: "سجل التزام الاستحقاق مفقود",
  ACCRUAL_RECOGNITION_ENTRY_MISSING: "قيد الاعتراف بالاستحقاق مفقود",
  ACCRUAL_SETTLEMENT_TRACE_MISSING: "أثر تسوية الاستحقاق المدفوع غير مكتمل",
  UNPAID_ACCRUAL_HAS_SETTLEMENT_EFFECT:
    "استحقاق غير مدفوع يحمل أثر تسوية متناقضاً",
};

function warningsOf(r: ExpenseRow): string[] {
  const warnings = new Set(
    (r.integrityWarnings ?? [])
      .filter(Boolean)
      .map((warning) => AUDIT_WARNING_LABEL[warning] ?? warning),
  );
  if (!r.description?.trim()) warnings.add("لا يوجد شرح للعملية");
  if (Object.prototype.hasOwnProperty.call(r, "payee") && !r.payee?.trim())
    warnings.add("المستفيد غير محدد");
  const funding = fundingKindOf(r);
  if (funding === "UNATTRIBUTED") warnings.add("مصدر النقد غير محسوم");
  if (funding === "DRAWER" && r.shiftId == null)
    warnings.add("صرف درج بلا وردية");
  return Array.from(warnings);
}

function fundingDetail(r: ExpenseRow): string {
  const kind = fundingKindOf(r);
  if (kind === "PENDING")
    return r.paymentMethod === "CASH"
      ? "طلب اعتماد خزينة — لم يُصرف"
      : `طلب اعتماد ${METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod} — لم يُنفذ`;
  if (kind === "ACCRUED_UNPAID")
    return `${r.accrualBeneficiaryName ?? r.payee ?? "مستفيد غير موثق"} · اعتراف محاسبي بلا خروج نقدي`;
  if (kind === "ACCRUED_PAID")
    return `${r.accrualBeneficiaryName ?? r.payee ?? "مستفيد غير موثق"} · سُوّي بسند وقيد مستقلين`;
  if (kind === "DRAWER") {
    return (
      [r.shiftOwnerName, r.shiftId != null ? `وردية #${r.shiftId}` : null]
        .filter(Boolean)
        .join(" · ") || "درج وردية"
    );
  }
  if (kind === "TREASURY") return "الخزينة الإدارية";
  if (kind === "STOCK")
    return STOCK_REASON_LABEL[r.stockReason ?? ""] ?? "صرف مخزون";
  if (kind === "NON_CASH")
    return METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod;
  return "يحتاج مطابقة مع الإيصال والوردية";
}

function metric(value: string | number | null | undefined): string {
  return value == null ? "—" : fmt(value);
}

function ExpenseTracePanel({ expenseId }: { expenseId: number }) {
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
            value: `${CATEGORY_LABEL[expense.category] ?? expense.category}${expense.costCenter ? ` · ${expense.costCenter}` : ""}`,
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

/** إيصال صرف عبر printDoc العام — نفس نواقل الطباعة الثلاثة (جسر الخادم/WebUSB/متصفح). */
async function printExpenseReceipt(r: ExpenseRow) {
  if (r.source === "ACCRUAL") {
    notify.err(
      "المصروف المستحق ليس إيصال صرف؛ اطبع سند التسوية الفعلي من شاشة السندات بعد اعتماده",
    );
    return;
  }
  if (!isExpenseFinanciallyPrintable(r.status)) {
    notify.err("لا يمكن طباعة طلب مصروف غير منفذ كإيصال صرف");
    return;
  }
  const warnings = warningsOf(r);
  await printDoc({
    kind: "receipt",
    title: "الرؤية العربية",
    subtitle: "إيصال صرف — مصروف",
    meta: [
      `مصروف #${Number(r.id)}`,
      `التاريخ: ${r.expenseDate ? new Date(r.expenseDate as unknown as string).toISOString().slice(0, 10) : "—"}`,
      `الفرع: ${r.branchName ?? "—"}`,
      `الفئة: ${CATEGORY_LABEL[r.category] ?? r.category}`,
      `طريقة الدفع: ${METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}`,
      `مصدر التمويل: ${FUNDING_META[fundingKindOf(r)].short} — ${fundingDetail(r)}`,
      ...(r.description ? [`البيان: ${r.description}`] : []),
      ...(r.payee ? [`المستفيد: ${r.payee}`] : []),
      ...(r.costCenter ? [`مركز التكلفة: ${r.costCenter}`] : []),
      ...(r.referenceNumber ? [`المرجع: ${r.referenceNumber}`] : []),
      ...(r.receiptVoucherNumber
        ? [`رقم السند: ${r.receiptVoucherNumber}`]
        : r.receiptId
          ? [`إيصال #${r.receiptId}`]
          : []),
      ...(r.createdByName ? [`أنشأ العملية: ${r.createdByName}`] : []),
      ...(r.approvedByName ? [`اعتمد العملية: ${r.approvedByName}`] : []),
      ...(r.createdAt
        ? [`سُجّلت: ${fmtDateTime(r.createdAt as unknown as string)}`]
        : []),
      ...(warnings.length ? [`ملاحظات التدقيق: ${warnings.join("؛ ")}`] : []),
      // إيصال مصروف مُلغى يحمل حالته صراحةً — لا يُقرأ كصرف نافذ بالخطأ.
      ...(r.status !== "ACTIVE"
        ? [`الحالة: ${STATUS_LABEL[r.status] ?? r.status}`]
        : []),
    ],
    totals: [{ label: "المبلغ", value: fmt(r.amount) }],
    footer: "إيصال صرف داخلي",
  });
}

export default function Expenses() {
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState<number | "">("");
  const [category, setCategory] = useState<string>("");
  const [status, setStatus] = useState<string>(() =>
    typeof window === "undefined"
      ? ""
      : expenseStatusFromSearch(window.location.search),
  );
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [query, setQuery] = useState("");
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<ExpenseRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [correctionTarget, setCorrectionTarget] = useState<ExpenseRow | null>(
    null,
  );
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionEvidence, setCorrectionEvidence] = useState("");
  const [correctionAttachment, setCorrectionAttachment] = useState<ImageItem[]>(
    [],
  );
  const [correctionRefundMethod, setCorrectionRefundMethod] =
    useState<InboundEnabledPaymentMethod>("CASH");
  const [correctionRefundBucket, setCorrectionRefundBucket] = useState<
    "DRAWER" | "TREASURY"
  >("TREASURY");
  const [correctionRefundReference, setCorrectionRefundReference] =
    useState("");
  const [correctionRefundCardTail, setCorrectionRefundCardTail] = useState("");
  const [correctionReviewReason, setCorrectionReviewReason] = useState("");
  const [correctionClientRequestId, setCorrectionClientRequestId] = useState(
    () => crypto.randomUUID(),
  );
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [auditOnly, setAuditOnly] = useState(false);
  const [auditFocus, setAuditFocus] = useState<AuditFocus | null>(null);
  const [expandedDescriptions, setExpandedDescriptions] = useState<Set<number>>(
    () => new Set(),
  );
  const [expandedTraces, setExpandedTraces] = useState<Set<number>>(
    () => new Set(),
  );
  // الترقيم خادميّ: كانت تُحمَّل أحدث ٣٠٠ دفعةً والباقي غير قابل للوصول (بينما التصدير يرى الكل
  // ⇒ تناقض صامت بين ملف Excel والشاشة). الآن صفحة صفحة، والتصدير يبقى شاملاً صراحةً.
  const [page, setPage] = useState(0);
  // إبراز المصروف القادم من البحث الشامل (?focus=) — القائمة تُحمَّل أحدث ٣٠٠، فالأقرب زمنياً يُبرَز.
  const { rowProps } = useFocusHighlight();

  // البحث خادمي الآن (q ممهَّل): البيان/المرجع/المستفيد عبر كل النتائج لا المُحمَّل فقط.
  const dq = useDebouncedValue(query, 250);
  const listInput = {
    branchId: branchId ? Number(branchId) : undefined,
    category: (category || undefined) as any,
    status: (status || undefined) as any,
    from: from || undefined,
    to: to || undefined,
    paymentMethod: (paymentMethod || undefined) as any,
    source: (source || undefined) as any,
    q: dq.trim() || undefined,
  };
  function resetFilters() {
    setBranchId("");
    setCategory("");
    setStatus("");
    setFrom("");
    setTo("");
    setPaymentMethod("");
    setSource("");
    setQuery("");
    setAuditOnly(false);
    setAuditFocus(null);
  }
  const list = trpc.expenses.list.useQuery({
    ...listInput,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const correctionHistory = trpc.expenses.accrualCorrections.useQuery(
    { obligationId: Number(correctionTarget?.accrualObligationId ?? 0) },
    { enabled: Number(correctionTarget?.accrualObligationId ?? 0) > 0 },
  );
  const rows = (list.data?.rows ?? []) as ExpenseRow[];
  const totals = (list.data?.totals ?? {}) as ExpenseTotals;
  const total = Number(totals.count ?? 0);

  const rowsWithWarnings = useMemo(
    () =>
      rows.map((row) => ({
        row,
        warnings: warningsOf(row),
        funding: fundingKindOf(row),
      })),
    [rows],
  );
  const pageNeedsAudit = rowsWithWarnings.filter(
    (entry) => entry.warnings.length > 0,
  ).length;
  const auditBreakdown = useMemo(
    () => ({
      DESCRIPTION: rowsWithWarnings.filter(
        ({ row }) => !row.description?.trim(),
      ).length,
      PAYEE: rowsWithWarnings.filter(({ row }) => !row.payee?.trim()).length,
      SOURCE: rowsWithWarnings.filter(({ row }) =>
        (row.integrityWarnings ?? []).some(
          (warning) =>
            warning !== "DESCRIPTION_MISSING" && warning !== "PAYEE_MISSING",
        ),
      ).length,
      DRAWER: rowsWithWarnings.filter(
        ({ row, funding }) =>
          funding === "DRAWER" &&
          (row.shiftId == null || row.receiptId == null),
      ).length,
    }),
    [rowsWithWarnings],
  );
  const visibleEntries = auditFocus
    ? rowsWithWarnings.filter(({ row, funding }) => {
        if (auditFocus === "DESCRIPTION") return !row.description?.trim();
        if (auditFocus === "PAYEE") return !row.payee?.trim();
        if (auditFocus === "DRAWER")
          return (
            funding === "DRAWER" &&
            (row.shiftId == null || row.receiptId == null)
          );
        return (row.integrityWarnings ?? []).some(
          (warning) =>
            warning !== "DESCRIPTION_MISSING" && warning !== "PAYEE_MISSING",
        );
      })
    : auditOnly
      ? rowsWithWarnings.filter((entry) => entry.warnings.length > 0)
      : rowsWithWarnings;
  const groupedRows = useMemo(
    () =>
      FUNDING_ORDER.map((kind) => ({
        kind,
        entries: visibleEntries.filter((entry) => entry.funding === kind),
      })).filter((group) => group.entries.length > 0),
    [visibleEntries],
  );

  function toggleDescription(id: number) {
    setExpandedDescriptions((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleTrace(id: number) {
    setExpandedTraces((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const activeChips = [
    query.trim()
      ? { key: "q", label: `بحث: ${query.trim()}`, clear: () => setQuery("") }
      : null,
    branchId
      ? {
          key: "branch",
          label: `الفرع: ${branches.data?.find((branch) => Number(branch.id) === Number(branchId))?.name ?? branchId}`,
          clear: () => setBranchId(""),
        }
      : null,
    category
      ? {
          key: "category",
          label: `الفئة: ${CATEGORY_LABEL[category] ?? category}`,
          clear: () => setCategory(""),
        }
      : null,
    status
      ? {
          key: "status",
          label: `الحالة: ${STATUS_LABEL[status] ?? status}`,
          clear: () => setStatus(""),
        }
      : null,
    from
      ? { key: "from", label: `من: ${fmtDate(from)}`, clear: () => setFrom("") }
      : null,
    to
      ? { key: "to", label: `إلى: ${fmtDate(to)}`, clear: () => setTo("") }
      : null,
    paymentMethod
      ? {
          key: "method",
          label: `الدفع: ${METHOD_LABEL[paymentMethod] ?? paymentMethod}`,
          clear: () => setPaymentMethod(""),
        }
      : null,
    source
      ? {
          key: "source",
          label: `المصدر: ${source === "STOCK" ? "مخزون" : "مالي"}`,
          clear: () => setSource(""),
        }
      : null,
    auditOnly
      ? {
          key: "audit",
          label: "يحتاج تدقيقاً — الصفحة الحالية",
          clear: () => setAuditOnly(false),
        }
      : null,
    auditFocus
      ? {
          key: "audit-focus",
          label: `استثناء: ${
            auditFocus === "DESCRIPTION"
              ? "بلا شرح"
              : auditFocus === "PAYEE"
                ? "بلا مستفيد"
                : auditFocus === "SOURCE"
                  ? "مصدر أو إيصال غير متطابق"
                  : "درج أو وردية ناقصة"
          }`,
          clear: () => setAuditFocus(null),
        }
      : null,
  ].filter(
    (chip): chip is { key: string; label: string; clear: () => void } =>
      chip != null,
  );

  // أي تغيير في الفلاتر/البحث يعيدنا للصفحة الأولى (وإلا offset قديم على مجموعة أصغر = صفحة فارغة).
  const filterKey = JSON.stringify(listInput);
  useEffect(() => {
    setPage(0);
  }, [filterKey]);

  // أعمدة التصدير (مشتركة بين زرّ التصدير وجلب-الكل).
  const exportColumns: ExportColumn<ExpenseRow>[] = [
    { key: "id", header: "رقم المصروف", map: (r) => Number(r.id) },
    {
      key: "receiptVoucherNumber",
      header: "رقم السند",
      map: (r) => r.receiptVoucherNumber ?? "",
    },
    { key: "receiptId", header: "رقم الإيصال", map: (r) => r.receiptId ?? "" },
    {
      key: "expenseDate",
      header: "التاريخ",
      map: (r) => fmtDate(r.expenseDate as unknown as string),
    },
    {
      key: "createdAt",
      header: "وقت التسجيل",
      map: (r) => fmtDateTime(r.createdAt as unknown as string),
    },
    {
      key: "updatedAt",
      header: "آخر تحديث",
      map: (r) => fmtDateTime(r.updatedAt as unknown as string),
    },
    { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
    {
      key: "category",
      header: "الفئة",
      map: (r) => CATEGORY_LABEL[r.category] ?? r.category,
    },
    {
      key: "costCenter",
      header: "مركز التكلفة",
      map: (r) => r.costCenter ?? "",
    },
    { key: "description", header: "الوصف", map: (r) => r.description ?? "" },
    { key: "payee", header: "المستفيد", map: (r) => r.payee ?? "" },
    {
      key: "referenceNumber",
      header: "المرجع",
      map: (r) => r.referenceNumber ?? "",
    },
    {
      key: "paymentMethod",
      header: "طريقة الدفع",
      map: (r) => METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod,
    },
    {
      key: "fundingKind",
      header: "مصدر التمويل",
      map: (r) => FUNDING_META[fundingKindOf(r)].short,
    },
    {
      key: "source",
      header: "نوع المصدر الخام",
      map: (r) => r.source ?? "",
    },
    {
      key: "cashBucket",
      header: "وعاء النقد الخام",
      map: (r) => r.cashBucket ?? "",
    },
    { key: "fundingDetail", header: "تفصيل مصدر التمويل", map: fundingDetail },
    {
      key: "settlementStatus",
      header: "حالة تسوية الاستحقاق",
      map: (r) => r.settlementStatus ?? "",
    },
    {
      key: "accrualObligationId",
      header: "رقم التزام الاستحقاق",
      map: (r) => r.accrualObligationId ?? "",
    },
    {
      key: "accrualEvidenceReference",
      header: "مرجع دليل الاعتراف",
      map: (r) => r.accrualEvidenceReference ?? "",
    },
    {
      key: "recognitionAccountingEntryId",
      header: "قيد الاعتراف",
      map: (r) => r.recognitionAccountingEntryId ?? "",
    },
    {
      key: "settlementReceiptId",
      header: "سند التسوية",
      map: (r) => r.settlementReceiptId ?? "",
    },
    {
      key: "settlementAccountingEntryId",
      header: "قيد التسوية",
      map: (r) => r.settlementAccountingEntryId ?? "",
    },
    { key: "shiftId", header: "رقم الوردية", map: (r) => r.shiftId ?? "" },
    {
      key: "shiftOwnerName",
      header: "صاحب الدرج",
      map: (r) => r.shiftOwnerName ?? "",
    },
    {
      key: "shiftType",
      header: "نوع الوردية",
      map: (r) =>
        r.shiftType ? (SHIFT_TYPE_LABEL[r.shiftType] ?? r.shiftType) : "",
    },
    {
      key: "shiftStatus",
      header: "حالة الوردية",
      map: (r) =>
        r.shiftStatus
          ? (SHIFT_STATUS_LABEL[r.shiftStatus] ?? r.shiftStatus)
          : "",
    },
    {
      key: "createdByName",
      header: "أنشأ العملية",
      map: (r) =>
        r.createdByName ?? (r.createdBy != null ? `#${r.createdBy}` : ""),
    },
    {
      key: "approvedByName",
      header: "اعتمد العملية",
      map: (r) => r.approvedByName ?? "",
    },
    {
      key: "approvalStatus",
      header: "حالة الاعتماد",
      map: (r) =>
        r.approvalStatus
          ? (APPROVAL_LABEL[r.approvalStatus] ?? r.approvalStatus)
          : "",
    },
    {
      key: "receiptStatus",
      header: "حالة الإيصال",
      map: (r) => r.receiptStatus ?? "",
    },
    {
      key: "integrityWarnings",
      header: "ملاحظات التدقيق",
      map: (r) => warningsOf(r).join("؛ "),
    },
    { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
    {
      key: "status",
      header: "الحالة",
      map: (r) => STATUS_LABEL[r.status] ?? r.status,
    },
  ];

  // تصدير كل النتائج المطابقة (لا الصفحة المحمَّلة): يكرّر عبر offset حتى تنضب (بلا اقتطاع).
  async function exportAll() {
    setExporting(true);
    try {
      const all = await fetchAllPaged<ExpenseRow>(
        (offset, limit) =>
          utils.expenses.list
            .fetch({ ...listInput, limit, offset })
            .then((res) => ({ rows: res.rows ?? [], total: res.totals.count })),
        { pageSize: 1000 },
      );
      if (!all.length) {
        notify.err("لا بيانات للتصدير");
        return;
      }
      exportRows(all, { filename: "المصروفات", columns: exportColumns });
    } catch (e) {
      notify.err(e);
    } finally {
      setExporting(false);
    }
  }

  // طباعة قائمة المصروفات — كل النتائج المطابقة للفلتر (fetchAllPaged) لا الصفحة المعروضة فقط.
  async function printAll() {
    setPrinting(true);
    try {
      const all = await fetchAllPaged<ExpenseRow>(
        (offset, limit) =>
          utils.expenses.list
            .fetch({ ...listInput, limit, offset })
            .then((res) => ({ rows: res.rows ?? [], total: res.totals.count })),
        { pageSize: 1000 },
      );
      const printable = all.filter((row) =>
        isExpenseFinanciallyPrintable(row.status),
      );
      if (!printable.length) {
        notify.err(
          "لا توجد مصروفات نافذة للطباعة؛ الطلبات المعلّقة والمرفوضة لا تُطبع كسند صرف",
        );
        return;
      }
      const filterLabels = [
        branchId
          ? `الفرع: ${branches.data?.find((b) => b.id === branchId)?.name ?? branchId}`
          : null,
        category ? `الفئة: ${CATEGORY_LABEL[category] ?? category}` : null,
        status ? `الحالة: ${STATUS_LABEL[status] ?? status}` : null,
        paymentMethod
          ? `طريقة الدفع: ${METHOD_LABEL[paymentMethod] ?? paymentMethod}`
          : null,
        source ? `المصدر: ${source === "STOCK" ? "مخزون" : "نقدي"}` : null,
        from || to ? `الفترة: ${from || "البداية"} — ${to || "اليوم"}` : null,
        query.trim() ? `بحث: ${query.trim()}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const printTotal = printable.reduce(
        (sum, row) => sum.plus(D(row.amount)),
        D(0),
      );
      const opened = printReportDoc({
        title: "المصروفات اليومية",
        headerExtra: filterLabels
          ? [{ label: "الفلاتر", value: filterLabels }]
          : [],
        columns: [
          { key: "identity", label: "المصروف / السند" },
          { key: "date", label: "التاريخ / التسجيل" },
          { key: "branch", label: "الفرع" },
          { key: "category", label: "الفئة / المركز" },
          { key: "description", label: "البيان / المستفيد" },
          { key: "funding", label: "التمويل / الدفع" },
          { key: "shift", label: "الدرج / الوردية" },
          { key: "actors", label: "المنشئ / المعتمد" },
          { key: "amount", label: "المبلغ", align: "left" },
          { key: "status", label: "الحالة" },
          { key: "audit", label: "ملاحظات التدقيق" },
        ],
        rows: printable.map((r) => ({
          identity: `#${Number(r.id)}${r.receiptVoucherNumber ? ` / ${r.receiptVoucherNumber}` : r.receiptId ? ` / R#${r.receiptId}` : ""}`,
          date: `${fmtDate(r.expenseDate as unknown as string)} / ${fmtDateTime(r.createdAt as unknown as string)}`,
          branch: r.branchName ?? "—",
          category: `${CATEGORY_LABEL[r.category] ?? r.category}${r.costCenter ? ` / ${r.costCenter}` : ""}`,
          description: `${r.description ?? "لا يوجد شرح"}${r.payee ? ` / المستفيد: ${r.payee}` : ""}${r.referenceNumber ? ` / مرجع: ${r.referenceNumber}` : ""}`,
          funding: `${FUNDING_META[fundingKindOf(r)].short} / ${sourceLabel(r)}`,
          shift: fundingDetail(r),
          actors: `${r.createdByName ?? (r.createdBy != null ? `#${r.createdBy}` : "—")}${r.approvedByName ? ` / اعتماد: ${r.approvedByName}` : ""}`,
          amount: fmt(r.amount),
          status: STATUS_LABEL[r.status] ?? r.status,
          audit: warningsOf(r).join("؛ ") || "سليم",
        })),
        summary: [
          {
            label: "إجمالي المصروفات النافذة فقط",
            value: `${fmt(printTotal.toString())} د.ع`,
            large: true,
            bold: true,
          },
        ],
      });
      if (!opened)
        notify.err(
          "حجب المتصفح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.",
        );
    } catch (e) {
      notify.err(e);
    } finally {
      setPrinting(false);
    }
  }

  // الإلغاء = expensesManagerProcedure(["manager"], "expenses", "FULL") — نُخفي الزرّ عمّن يرفضه
  // الخادم (كاشير/محاسب: إدخالٌ بلا إلغاء) بنفس دالة الخادم moduleAccessAllowed ⇒ لا تباعُد.
  const me = trpc.auth.me.useQuery();
  const canCancel =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "expenses",
      "FULL",
      ["manager"],
    );
  const canApprove = me.data?.isOwner === true;

  const cancel = trpc.expenses.cancel.useMutation({
    onSuccess: async () => {
      await utils.expenses.list.invalidate();
    },
  });
  const approve = trpc.expenses.approve.useMutation({
    onSuccess: async (_result, variables) => {
      await Promise.all([
        utils.expenses.list.invalidate(),
        utils.expenses.trace.invalidate({ expenseId: variables.expenseId }),
      ]);
      notify.ok("تم اعتماد المصروف وتنفيذه ذرياً");
    },
    onError: (error) => notify.err(error),
  });
  const reject = trpc.expenses.reject.useMutation({
    onSuccess: async (_result, variables) => {
      await Promise.all([
        utils.expenses.list.invalidate(),
        utils.expenses.trace.invalidate({ expenseId: variables.expenseId }),
      ]);
      setRejectTarget(null);
      setRejectReason("");
      notify.ok("رُفض طلب المصروف بلا أثر مالي");
    },
    onError: (error) => notify.err(error),
  });
  const requestCorrection = trpc.expenses.requestAccrualCorrection.useMutation({
    onSuccess: async () => {
      notify.ok("سُجل طلب تصحيح المصدر بلا عكس أو قبض تلقائي");
      setCorrectionClientRequestId(crypto.randomUUID());
      setCorrectionReason("");
      setCorrectionEvidence("");
      setCorrectionAttachment([]);
      await Promise.all([
        utils.expenses.list.invalidate(),
        correctionHistory.refetch(),
      ]);
    },
    onError: (error) => notify.err(error),
  });
  const approveCorrection = trpc.expenses.approveAccrualCorrection.useMutation({
    onSuccess: async () => {
      notify.ok("اعتمد التصحيح وعُكس الاعتراف بقيد مستقل");
      await Promise.all([
        utils.expenses.list.invalidate(),
        correctionHistory.refetch(),
      ]);
    },
    onError: (error) => notify.err(error),
  });
  const rejectCorrection = trpc.expenses.rejectAccrualCorrection.useMutation({
    onSuccess: async () => {
      notify.ok("رُفض التصحيح وبقي الاستحقاق الأصلي قائماً");
      setCorrectionReviewReason("");
      await Promise.all([
        utils.expenses.list.invalidate(),
        correctionHistory.refetch(),
      ]);
    },
    onError: (error) => notify.err(error),
  });
  const retryCorrectionRefund =
    trpc.expenses.retryAccrualCorrectionRefund.useMutation({
      onSuccess: async () => {
        notify.ok("أُعيد تقديم طلب قبض الاسترداد، وينتظر اعتماد مالك آخر");
        setCorrectionClientRequestId(crypto.randomUUID());
        await Promise.all([
          utils.expenses.list.invalidate(),
          correctionHistory.refetch(),
        ]);
      },
      onError: (error) => notify.err(error),
    });

  function actionsFor(r: ExpenseRow) {
    return [
      {
        key: "print",
        kind: "print" as const,
        label: "طباعة إيصال صرف",
        onSelect: () => void printExpenseReceipt(r),
        hidden:
          !isExpenseFinanciallyPrintable(r.status) || r.source === "ACCRUAL",
        gate: { module: "expenses" as const, level: "READ" as const },
      },
      {
        key: "approve",
        kind: "approve" as const,
        icon: CircleCheck,
        label: "اعتماد وصرف",
        hidden:
          r.status !== "PENDING_APPROVAL" ||
          !canApprove ||
          Number(r.createdBy) === Number(me.data?.id),
        disabled: approve.isPending || reject.isPending,
        disabledReason: "توجد عملية اعتماد قيد التنفيذ",
        onSelect: () =>
          void (async () => {
            if (
              !(await confirm({
                variant: "warning",
                title: "اعتماد وصرف المصروف",
                description:
                  r.paymentMethod === "CASH"
                    ? `سيُسحب ${fmt(r.amount)} د.ع من خزينة الفرع ويُنشأ القيد والإيصال كعملية ذرية واحدة. هل تتابع؟`
                    : `سيُنفذ المصروف غير النقدي ${fmt(r.amount)} د.ع ويُنشأ القيد والإيصال كعملية ذرية واحدة. هل تتابع؟`,
                confirmText: "اعتماد وصرف",
                cancelText: "تراجع",
              }))
            )
              return;
            approve.mutate({ expenseId: Number(r.id) });
          })(),
      },
      {
        key: "reject",
        kind: "cancel" as const,
        icon: Ban,
        label: "رفض الطلب",
        variant: "destructive" as const,
        hidden:
          r.status !== "PENDING_APPROVAL" ||
          !canApprove ||
          Number(r.createdBy) === Number(me.data?.id),
        disabled: approve.isPending || reject.isPending,
        disabledReason: "توجد عملية اعتماد قيد التنفيذ",
        onSelect: () => {
          setRejectReason("");
          setRejectTarget(r);
        },
      },
      {
        key: "correct-source",
        kind: "reverse" as const,
        label: "تصحيح المصدر",
        variant: "destructive" as const,
        hidden:
          r.status !== "ACTIVE" ||
          r.source !== "ACCRUAL" ||
          r.accrualObligationId == null ||
          ![
            "ACCRUED_UNPAID",
            "PAYMENT_PENDING",
            "PAID",
            "CORRECTION_PENDING",
            "REFUND_PENDING",
          ].includes(r.settlementStatus ?? "") ||
          !canCancel,
        disabled: requestCorrection.isPending,
        disabledReason: "يوجد طلب تصحيح قيد التسجيل",
        onSelect: () => {
          setCorrectionTarget(r);
          setCorrectionReason("");
          setCorrectionEvidence("");
          setCorrectionAttachment([]);
          setCorrectionReviewReason("");
        },
        gate: {
          roles: ["manager"] as RoleKey[],
          module: "expenses" as const,
          level: "FULL" as const,
        },
      },
      {
        key: "cancel",
        kind: "reverse" as const,
        label: "إلغاء",
        variant: "destructive" as const,
        hidden: r.status !== "ACTIVE" || r.source === "ACCRUAL" || !canCancel,
        disabled: cancel.isPending,
        disabledReason: "توجد عملية إلغاء قيد التنفيذ",
        onSelect: () =>
          void (async () => {
            if (
              !(await confirm({
                variant: "warning",
                title: "إلغاء المصروف",
                description:
                  r.source === "STOCK"
                    ? `ستُعاد المنتجات (${fmt(r.amount)} د.ع كلفةً) إلى المخزون ويُعكس القيد. هل تتابع؟`
                    : r.paymentMethod === "CASH"
                      ? `سيُعاد مبلغ ${fmt(r.amount)} د.ع إلى ${r.cashBucket === "DRAWER" ? "درج الوردية" : "خزينة الفرع"} ويُسجَّل قيد محاسبي عكسي. هل تتابع؟`
                      : `سيُعكس مبلغ ${fmt(r.amount)} د.ع محاسبياً بطريقة الدفع المسجّلة من دون مسّ الدرج أو الخزينة النقدية. هل تتابع؟`,
                confirmText: "إلغاء المصروف",
                cancelText: "تراجع",
              }))
            )
              return;
            cancel.mutate({ expenseId: Number(r.id) });
          })(),
        gate: {
          roles: ["manager"] as RoleKey[],
          module: "expenses" as const,
          level: "FULL" as const,
        },
      },
    ];
  }

  const activeCorrection =
    correctionHistory.data?.find((item) => item.status === "PENDING") ?? null;
  const retryableRefundCorrection =
    correctionHistory.data?.find(
      (item) =>
        item.status === "REJECTED" && item.previousObligationStatus === "PAID",
    ) ?? null;
  const correctionRequiresRefund =
    correctionTarget?.settlementStatus === "PAID";

  // أموال العرض عبر fmt من @/lib/money (فواصل آلاف + منزلتان) — بديل الدالة المحلية السابقة.
  return (
    <div className="space-y-3">
      <PageHeader
        title="المصروفات اليومية"
        description="النقدي الصغير الممول يُنفذ من درج المنشئ؛ سائر الطلبات تبقى بلا أثر حتى اعتماد مالك آخر، والنقدي المعتمد وحده يُصرف من الخزينة."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={printing || (list.data?.totals.count ?? 0) === 0}
              onClick={() => void printAll()}
            >
              {printing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Printer className="size-4" />
              )}
              {printing ? "جارٍ التحضير…" : "طباعة قائمة"}
            </Button>
            <Button
              variant="outline"
              disabled={exporting || (list.data?.totals.count ?? 0) === 0}
              onClick={() => void exportAll()}
            >
              {exporting ? <Loader2 className="size-4 animate-spin" /> : null}
              {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
            </Button>
            <Link href="/expenses/new">
              <Button>+ مصروف جديد</Button>
            </Link>
          </div>
        }
      />

      <section
        aria-label="ملخص المصروفات"
        className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-3 p-3">
            <div>
              <p className="text-xs text-muted-foreground">إجمالي النافذ</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums" dir="ltr">
                {metric(totals.active ?? 0)}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {Number(totals.count ?? 0).toLocaleString("ar-IQ-u-nu-latn")}{" "}
                عملية ضمن الفلتر
              </p>
            </div>
            <span className="rounded-lg bg-primary/10 p-1.5 text-primary">
              <CircleDollarSign aria-hidden className="size-4" />
            </span>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-3 p-3">
            <div>
              <p className="text-xs text-muted-foreground">من الأدراج</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums" dir="ltr">
                {metric(totals.drawer)}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                غير نقدي: <span dir="ltr">{metric(totals.nonCash)}</span>
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                مستحق غير مدفوع:{" "}
                <span dir="ltr">{metric(totals.accruedUnpaid)}</span>
              </p>
            </div>
            <span className="rounded-lg bg-[var(--sem-pos-bg)] p-1.5 text-[var(--sem-pos)]">
              <WalletCards aria-hidden className="size-4" />
            </span>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-3 p-3">
            <div>
              <p className="text-xs text-muted-foreground">من الخزينة</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums" dir="ltr">
                {metric(totals.treasury)}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                من المخزون: <span dir="ltr">{metric(totals.stock)}</span>
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                استحقاق مسوّى:{" "}
                <span dir="ltr">{metric(totals.accruedPaid)}</span>
              </p>
            </div>
            <span className="rounded-lg bg-[var(--sem-info-bg)] p-1.5 text-[var(--sem-info)]">
              <Landmark aria-hidden className="size-4" />
            </span>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-3 p-3">
            <div>
              <p className="text-xs text-muted-foreground">يحتاج تدقيقاً</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums" dir="ltr">
                {Number(totals.needsAudit ?? pageNeedsAudit).toLocaleString(
                  "ar-IQ-u-nu-latn",
                )}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                بانتظار الاعتماد:{" "}
                <span dir="ltr">{metric(totals.pendingApproval)}</span>
                {" · "}مرفوض: <span dir="ltr">{metric(totals.rejected)}</span>
                {" · "}ملغى: <span dir="ltr">{metric(totals.cancelled)}</span>
                {totals.needsAudit == null ? " · المحسوب من الصفحة" : ""}
              </p>
            </div>
            <span className="rounded-lg bg-[var(--sem-warn-bg)] p-1.5 text-[var(--sem-warn)]">
              <ShieldAlert aria-hidden className="size-4" />
            </span>
          </CardContent>
        </Card>
      </section>

      <Card className="gap-0 py-0">
        <CardContent className="space-y-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <SlidersHorizontal
                aria-hidden
                className="size-4 text-muted-foreground"
              />
              <h2 className="text-sm font-semibold">بحث وفلاتر المصروفات</h2>
              {activeChips.length > 0 && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                  {activeChips.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                فلاتر متقدمة
                {advancedOpen ? (
                  <ChevronUp aria-hidden className="size-4" />
                ) : (
                  <ChevronDown aria-hidden className="size-4" />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                disabled={activeChips.length === 0}
                onClick={resetFilters}
              >
                <X aria-hidden className="size-3.5" /> إعادة ضبط
              </Button>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-6">
            <div className="space-y-1 md:col-span-2 xl:col-span-3">
              <Label htmlFor="expense-search" className="text-xs">
                بحث شامل
              </Label>
              <div className="relative">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="expense-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="البيان، المستفيد، المرجع، رقم المصروف أو السند…"
                  className="pr-8"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-branch" className="text-xs">
                الفرع
              </Label>
              <select
                id="expense-branch"
                className={selectCls}
                value={branchId}
                onChange={(event) =>
                  setBranchId(
                    event.target.value ? Number(event.target.value) : "",
                  )
                }
              >
                <option value="">كل الفروع</option>
                {(branches.data ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-status" className="text-xs">
                الحالة
              </Label>
              <select
                id="expense-status"
                className={selectCls}
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="">كل الحالات</option>
                <option value="PENDING_APPROVAL">بانتظار اعتماد المالك</option>
                <option value="ACTIVE">نافذ</option>
                <option value="REJECTED">مرفوض بلا صرف</option>
                <option value="CANCELLED">ملغى</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-from" className="text-xs">
                من تاريخ
              </Label>
              <Input
                id="expense-from"
                type="date"
                dir="ltr"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-to" className="text-xs">
                إلى تاريخ
              </Label>
              <Input
                id="expense-to"
                type="date"
                dir="ltr"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
          </div>

          {advancedOpen && (
            <div className="grid gap-2 border-t pt-2 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="expense-category" className="text-xs">
                  الفئة المحاسبية
                </Label>
                <select
                  id="expense-category"
                  className={selectCls}
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                >
                  <option value="">كل الفئات</option>
                  {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="exp-f-method" className="text-xs">
                  طريقة الدفع
                </Label>
                <AppSelect
                  id="exp-f-method"
                  value={paymentMethod}
                  onValueChange={setPaymentMethod}
                  placeholder="كل طرق الدفع"
                >
                  <option value="">كل طرق الدفع</option>
                  {Object.entries(METHOD_LABEL).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="exp-f-source" className="text-xs">
                  نوع المصروف
                </Label>
                <AppSelect
                  id="exp-f-source"
                  value={source}
                  onValueChange={setSource}
                  placeholder="كل الأنواع"
                >
                  <option value="">كل الأنواع</option>
                  <option value="CASH">مالي</option>
                  <option value="STOCK">مخزون (نثرية/تلف)</option>
                </AppSelect>
              </div>
            </div>
          )}

          {activeChips.length > 0 && (
            <div
              className="flex flex-wrap gap-1.5 border-t pt-2"
              aria-label="الفلاتر الفعالة"
            >
              {activeChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.clear}
                  className="inline-flex min-h-8 items-center gap-1 rounded-full border bg-muted/40 px-3 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {chip.label}
                  <X aria-hidden className="size-3" />
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {(Number(totals.needsAudit ?? pageNeedsAudit) > 0 || auditOnly) && (
        <div
          className="flex flex-col gap-3 rounded-lg border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] px-4 py-3 text-[var(--sem-warn)] sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="text-sm font-semibold">
                توجد عمليات تحتاج مراجعة بيانات المصدر أو الشرح
              </p>
              <p className="text-xs opacity-90">
                {pageNeedsAudit} في الصفحة الحالية؛ يشمل غياب الشرح أو المستفيد
                أو ربط الدرج والوردية.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setAuditFocus(null);
              setAuditOnly((value) => !value);
            }}
          >
            {auditOnly ? "عرض كل الصفحة" : "عرض حالات الصفحة فقط"}
          </Button>
        </div>
      )}

      {Number(totals.needsAudit ?? pageNeedsAudit) > 0 && (
        <section
          aria-label="تفصيل استثناءات تدقيق المصروفات"
          className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
        >
          {(
            [
              {
                key: "DESCRIPTION",
                label: "مصروفات بلا شرح",
                count: Number(
                  totals.missingDescription ?? auditBreakdown.DESCRIPTION,
                ),
              },
              {
                key: "PAYEE",
                label: "مصروفات بلا مستفيد",
                count: Number(totals.missingPayee ?? auditBreakdown.PAYEE),
              },
              {
                key: "SOURCE",
                label: "اختلاف المصدر أو الإيصال",
                count: Number(totals.sourceMismatch ?? auditBreakdown.SOURCE),
              },
              {
                key: "DRAWER",
                label: "درج أو وردية غير مكتملة",
                count: Number(totals.drawerMismatch ?? auditBreakdown.DRAWER),
              },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={auditFocus === item.key}
              onClick={() => {
                setAuditOnly(false);
                setAuditFocus((current) =>
                  current === item.key ? null : item.key,
                );
              }}
              className={`flex min-h-14 items-center justify-between rounded-lg border px-3 py-2 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                auditFocus === item.key
                  ? "border-primary bg-primary/5"
                  : "bg-card"
              }`}
            >
              <span>
                <span className="block text-xs font-semibold">
                  {item.label}
                </span>
                <span className="text-[11px] text-primary">عرض السجلات</span>
              </span>
              <span className="text-xl font-bold tabular-nums" dir="ltr">
                {item.count.toLocaleString("ar-IQ-u-nu-latn")}
              </span>
            </button>
          ))}
        </section>
      )}

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
          <div>
            <h2 className="text-sm font-semibold">السجل المحاسبي التفصيلي</h2>
            <p className="text-xs text-muted-foreground">
              مجمّع حسب مصدر التمويل ·{" "}
              {visibleEntries.length.toLocaleString("ar-IQ-u-nu-latn")} من{" "}
              {rows.length.toLocaleString("ar-IQ-u-nu-latn")} في الصفحة
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Layers3 aria-hidden className="size-4" />
            افتح «مسار التتبّع» لأي صف لعرض المستند والإيصال والقيد والتدقيق
          </div>
        </div>
        <CardContent className="p-0">
          <div className="space-y-3 p-3 md:hidden">
            {groupedRows.map((group) => (
              <section
                key={group.kind}
                aria-label={FUNDING_META[group.kind].label}
                className="space-y-2"
              >
                <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2 text-xs font-semibold">
                  <span>{FUNDING_META[group.kind].label}</span>
                  <span>
                    {group.entries.length} ·{" "}
                    <span dir="ltr">
                      {fmt(
                        group.entries.reduce(
                          (sum, entry) => sum + Number(entry.row.amount),
                          0,
                        ),
                      )}
                    </span>
                  </span>
                </div>
                {group.entries.map(({ row: r, warnings }) => {
                  const expanded = expandedDescriptions.has(Number(r.id));
                  const traceExpanded = expandedTraces.has(Number(r.id));
                  return (
                    <article
                      key={Number(r.id)}
                      className="space-y-3 rounded-lg border p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs" dir="ltr">
                              EXP#{Number(r.id)}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}
                            >
                              {STATUS_LABEL[r.status] ?? r.status}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {fmtDate(r.expenseDate as unknown as string)} ·{" "}
                            {r.branchName ?? "—"}
                          </p>
                        </div>
                        <p className="text-lg font-bold tabular-nums" dir="ltr">
                          {fmt(r.amount)}
                        </p>
                      </div>
                      <div>
                        <p
                          className={`text-sm leading-6 ${expanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}
                        >
                          {r.description?.trim() || "لا يوجد شرح للعملية"}
                        </p>
                        {(r.description?.length ?? 0) > 80 && (
                          <button
                            type="button"
                            className="mt-1 text-xs text-primary underline-offset-4 hover:underline"
                            onClick={() => toggleDescription(Number(r.id))}
                          >
                            {expanded ? "طي الشرح" : "عرض الشرح كاملاً"}
                          </button>
                        )}
                      </div>
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                        <div>
                          <dt className="text-muted-foreground">المستفيد</dt>
                          <dd className="font-medium">{r.payee ?? "—"}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            الفئة / المركز
                          </dt>
                          <dd>
                            {CATEGORY_LABEL[r.category] ?? r.category}
                            {r.costCenter ? ` · ${r.costCenter}` : ""}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            مصدر التمويل
                          </dt>
                          <dd>{fundingDetail(r)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            أنشأ العملية
                          </dt>
                          <dd>
                            {r.createdByName ??
                              (r.createdBy != null ? `#${r.createdBy}` : "—")}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">السند</dt>
                          <dd dir="ltr">
                            {r.receiptVoucherNumber ??
                              (r.receiptId ? `R#${r.receiptId}` : "—")}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">وقت التسجيل</dt>
                          <dd dir="ltr">
                            {fmtDateTime(r.createdAt as unknown as string)}
                          </dd>
                        </div>
                      </dl>
                      {warnings.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {warnings.map((warning) => (
                            <span
                              key={warning}
                              className="rounded-full badge-status-cancelled px-2 py-0.5 text-[11px]"
                            >
                              {warning}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-expanded={traceExpanded}
                          onClick={() => toggleTrace(Number(r.id))}
                        >
                          {traceExpanded ? (
                            <ChevronUp aria-hidden className="size-4" />
                          ) : (
                            <ChevronDown aria-hidden className="size-4" />
                          )}
                          مسار التتبّع
                        </Button>
                        <RowActions actions={actionsFor(r)} />
                      </div>
                      {traceExpanded && (
                        <ExpenseTracePanel expenseId={Number(r.id)} />
                      )}
                    </article>
                  );
                })}
              </section>
            ))}
            {list.data && visibleEntries.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                لا مصروفات مطابقة.
              </p>
            )}
          </div>

          <div className="hidden md:block">
            <ScrollTableShell
              bordered={false}
              maxHeightClass="max-h-[calc(100dvh-13rem)]"
            >
              <table className="w-full min-w-[1500px] text-sm">
                <caption className="sr-only">
                  سجل المصروفات التفصيلي مجمّع حسب مصدر التمويل
                </caption>
                <thead className="bg-muted/50">
                  <tr>
                    <th scope="col" className="p-2 text-start">
                      المصروف / السند
                    </th>
                    <th scope="col" className="p-2 text-start">
                      التاريخ والتوقيت
                    </th>
                    <th scope="col" className="p-2 text-start">
                      البيان / المستفيد
                    </th>
                    <th scope="col" className="p-2 text-start">
                      الفرع / التصنيف
                    </th>
                    <th scope="col" className="p-2 text-start">
                      مصدر التمويل
                    </th>
                    <th scope="col" className="p-2 text-start">
                      الدرج / الوردية
                    </th>
                    <th scope="col" className="p-2 text-start">
                      المسؤولية والاعتماد
                    </th>
                    <th scope="col" className="p-2 text-start">
                      المبلغ
                    </th>
                    <th scope="col" className="p-2 text-start">
                      الحالة
                    </th>
                    <th scope="col" className="p-2 text-start">
                      التدقيق
                    </th>
                    <th scope="col" className="p-2 text-center">
                      إجراء
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groupedRows.map((group) => (
                    <Fragment key={group.kind}>
                      <tr className="border-y bg-muted/70">
                        <td colSpan={11} className="px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-semibold">
                              {FUNDING_META[group.kind].label}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {group.entries.length} عملية · إجمالي الصفحة{" "}
                              <span
                                className="font-semibold text-foreground tabular-nums"
                                dir="ltr"
                              >
                                {fmt(
                                  group.entries.reduce(
                                    (sum, entry) =>
                                      sum + Number(entry.row.amount),
                                    0,
                                  ),
                                )}
                              </span>
                            </span>
                          </div>
                        </td>
                      </tr>
                      {group.entries.map(({ row: r, warnings, funding }) => {
                        const fr = rowProps(r.id);
                        const expanded = expandedDescriptions.has(Number(r.id));
                        const traceExpanded = expandedTraces.has(Number(r.id));
                        return (
                          <Fragment key={Number(r.id)}>
                            <tr
                              ref={fr.ref}
                              className={`border-t align-top ${fr.className} ${r.status === "CANCELLED" ? "opacity-70" : ""}`}
                            >
                              <td className="p-2">
                                <div className="font-mono text-xs" dir="ltr">
                                  EXP#{Number(r.id)}
                                </div>
                                <div
                                  className="mt-1 font-mono text-[11px] text-muted-foreground"
                                  dir="ltr"
                                >
                                  {r.receiptVoucherNumber ??
                                    (r.receiptId
                                      ? `R#${r.receiptId}`
                                      : "بلا سند")}
                                </div>
                                {r.referenceNumber && (
                                  <div
                                    className="mt-1 max-w-36 truncate text-[11px] text-muted-foreground"
                                    title={r.referenceNumber}
                                  >
                                    مرجع: {r.referenceNumber}
                                  </div>
                                )}
                              </td>
                              <td className="p-2 text-xs">
                                <div dir="ltr">
                                  {fmtDate(r.expenseDate as unknown as string)}
                                </div>
                                <div
                                  className="mt-1 text-[11px] text-muted-foreground"
                                  dir="ltr"
                                >
                                  أُدخل:{" "}
                                  {fmtDateTime(
                                    r.createdAt as unknown as string,
                                  )}
                                </div>
                                {r.updatedAt && (
                                  <div
                                    className="text-[11px] text-muted-foreground"
                                    dir="ltr"
                                  >
                                    حُدّث: {fmtDateTime(r.updatedAt)}
                                  </div>
                                )}
                              </td>
                              <td className="max-w-[25rem] p-2">
                                <p
                                  className={`leading-6 ${expanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}
                                >
                                  {r.description?.trim() || (
                                    <span className="font-medium text-destructive">
                                      لا يوجد شرح للعملية
                                    </span>
                                  )}
                                </p>
                                {(r.description?.length ?? 0) > 80 && (
                                  <button
                                    type="button"
                                    className="mt-1 text-xs text-primary underline-offset-4 hover:underline"
                                    onClick={() =>
                                      toggleDescription(Number(r.id))
                                    }
                                  >
                                    {expanded ? "طي" : "عرض كامل"}
                                  </button>
                                )}
                                <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                                  <UserRound aria-hidden className="size-3.5" />{" "}
                                  المستفيد:{" "}
                                  <span className="text-foreground">
                                    {r.payee ?? "—"}
                                  </span>
                                </div>
                              </td>
                              <td className="p-2 text-xs">
                                <div>{r.branchName ?? "—"}</div>
                                <div className="mt-1 text-muted-foreground">
                                  {CATEGORY_LABEL[r.category] ?? r.category}
                                </div>
                                {r.costCenter && (
                                  <div className="text-[11px] text-muted-foreground">
                                    مركز: {r.costCenter}
                                  </div>
                                )}
                              </td>
                              <td className="p-2 text-xs">
                                <span
                                  className={`inline-flex rounded-full px-2 py-0.5 text-xs ${FUNDING_META[funding].badge}`}
                                >
                                  {FUNDING_META[funding].short}
                                </span>
                                <div className="mt-1 text-muted-foreground">
                                  {sourceLabel(r)}
                                </div>
                              </td>
                              <td className="p-2 text-xs">
                                {funding === "DRAWER" ? (
                                  <>
                                    <div className="font-medium">
                                      {r.shiftOwnerName ??
                                        "صاحب الدرج غير ظاهر"}
                                    </div>
                                    <div
                                      className="mt-1 text-muted-foreground"
                                      dir="ltr"
                                    >
                                      وردية #{r.shiftId ?? "—"}
                                    </div>
                                    <div className="text-[11px] text-muted-foreground">
                                      {r.shiftType
                                        ? (SHIFT_TYPE_LABEL[r.shiftType] ??
                                          r.shiftType)
                                        : "—"}{" "}
                                      ·{" "}
                                      {r.shiftStatus
                                        ? (SHIFT_STATUS_LABEL[r.shiftStatus] ??
                                          r.shiftStatus)
                                        : "—"}
                                    </div>
                                  </>
                                ) : funding === "TREASURY" ? (
                                  <div className="inline-flex items-center gap-1">
                                    <Building2 aria-hidden className="size-4" />{" "}
                                    الخزينة الإدارية
                                  </div>
                                ) : (
                                  <div>{fundingDetail(r)}</div>
                                )}
                              </td>
                              <td className="p-2 text-xs">
                                <div>
                                  أنشأ:{" "}
                                  <span className="font-medium">
                                    {r.createdByName ??
                                      (r.createdBy != null
                                        ? `#${r.createdBy}`
                                        : "—")}
                                  </span>
                                </div>
                                <div className="mt-1 text-muted-foreground">
                                  اعتمد: {r.approvedByName ?? "—"}
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                  {r.approvalStatus
                                    ? (APPROVAL_LABEL[r.approvalStatus] ??
                                      r.approvalStatus)
                                    : "—"}
                                  {r.receiptStatus
                                    ? ` · إيصال ${r.receiptStatus}`
                                    : ""}
                                </div>
                              </td>
                              <td
                                className="p-2 text-start text-base font-bold tabular-nums"
                                dir="ltr"
                              >
                                {fmt(r.amount)}
                              </td>
                              <td className="p-2">
                                <span
                                  className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}
                                >
                                  {STATUS_LABEL[r.status] ?? r.status}
                                </span>
                              </td>
                              <td className="max-w-52 p-2">
                                {warnings.length ? (
                                  <div className="flex flex-wrap gap-1">
                                    {warnings.map((warning) => (
                                      <span
                                        key={warning}
                                        className="rounded-full badge-status-cancelled px-2 py-0.5 text-[11px]"
                                      >
                                        {warning}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    لا ملاحظات
                                  </span>
                                )}
                              </td>
                              <td className="p-2 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    aria-label={`مسار تتبع المصروف ${Number(r.id)}`}
                                    aria-expanded={traceExpanded}
                                    onClick={() => toggleTrace(Number(r.id))}
                                  >
                                    {traceExpanded ? (
                                      <ChevronUp
                                        aria-hidden
                                        className="size-4"
                                      />
                                    ) : (
                                      <ChevronDown
                                        aria-hidden
                                        className="size-4"
                                      />
                                    )}
                                    تفاصيل
                                  </Button>
                                  <RowActions actions={actionsFor(r)} />
                                </div>
                              </td>
                            </tr>
                            {traceExpanded && (
                              <tr className="border-t bg-muted/20">
                                <td colSpan={11} className="p-3">
                                  <ExpenseTracePanel expenseId={Number(r.id)} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}
                  {list.data && visibleEntries.length === 0 && (
                    <TableEmptyRow
                      colSpan={11}
                      message={
                        auditOnly
                          ? "لا توجد حالات تدقيق في هذه الصفحة."
                          : query
                            ? "لا مصروفات مطابقة للبحث."
                            : "لا مصروفات لهذا الفلتر."
                      }
                    />
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          </div>
        </CardContent>
        <TablePager
          page={page}
          onPageChange={setPage}
          pageSize={PAGE_SIZE}
          rowsOnPage={rows.length}
          total={total}
          isLoading={list.isFetching}
        />
      </Card>
      {cancel.error && (
        <p className="text-sm text-destructive">{cancel.error.message}</p>
      )}
      <Dialog
        open={rejectTarget != null}
        onOpenChange={(open) => {
          if (!open && !reject.isPending) {
            setRejectTarget(null);
            setRejectReason("");
          }
        }}
      >
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>رفض طلب المصروف</DialogTitle>
            <DialogDescription>
              سيبقى الطلب بلا صرف أو قيد مالي. سبب الرفض إلزامي ويُحفظ في مسار
              التدقيق.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="expense-rejection-reason">سبب الرفض *</Label>
            <Textarea
              id="expense-rejection-reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="مثال: المستند المؤيد ناقص أو المبلغ يحتاج تصحيحاً"
              rows={3}
              maxLength={1000}
              autoFocus
            />
            {rejectTarget && (
              <p className="text-xs text-muted-foreground">
                طلب #{Number(rejectTarget.id)} · {fmt(rejectTarget.amount)} د.ع
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRejectTarget(null)}
              disabled={reject.isPending}
            >
              تراجع
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={reject.isPending || rejectReason.trim().length < 3}
              onClick={() => {
                if (!rejectTarget || rejectReason.trim().length < 3) return;
                reject.mutate({
                  expenseId: Number(rejectTarget.id),
                  reason: rejectReason.trim(),
                });
              }}
            >
              {reject.isPending ? (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              ) : (
                <Ban aria-hidden className="size-4" />
              )}
              رفض الطلب
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={correctionTarget != null}
        onOpenChange={(open) => {
          if (
            !open &&
            !requestCorrection.isPending &&
            !approveCorrection.isPending &&
            !rejectCorrection.isPending &&
            !retryCorrectionRefund.isPending
          ) {
            setCorrectionTarget(null);
            setCorrectionReason("");
            setCorrectionEvidence("");
            setCorrectionAttachment([]);
            setCorrectionReviewReason("");
          }
        }}
      >
        <DialogContent dir="rtl" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تصحيح مصدر المصروف المستحق</DialogTitle>
            <DialogDescription>
              التصحيح يحفظ المصروف الأصلي ويضيف طلباً وحدثاً وعكساً مستقلاً.
              المصروف المدفوع يتطلب استرداداً فعلياً موثقاً واعتماد مالك آخر.
            </DialogDescription>
          </DialogHeader>
          {correctionTarget && (
            <div className="space-y-3">
              <div className="rounded-md border p-3 text-sm">
                <div className="font-medium">
                  EXP#{Number(correctionTarget.id)} ·{" "}
                  {fmt(correctionTarget.amount)} د.ع
                </div>
                <div className="mt-1 text-muted-foreground">
                  {correctionTarget.accrualBeneficiaryName ??
                    correctionTarget.payee ??
                    "مستفيد غير موثق"}{" "}
                  · {FUNDING_META[fundingKindOf(correctionTarget)].short}
                </div>
                <div className="mt-1 text-xs" dir="ltr">
                  {correctionTarget.accrualEvidenceReference ?? "—"}
                </div>
              </div>

              {correctionHistory.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 aria-hidden className="size-4 animate-spin" /> جارٍ
                  تحميل سجل التصحيح…
                </div>
              ) : activeCorrection ? (
                <div className="space-y-3 rounded-md border badge-status-pending p-3 text-sm">
                  <div className="font-medium">
                    طلب تصحيح #{activeCorrection.id} بانتظار الاعتماد
                  </div>
                  <p>{activeCorrection.reason}</p>
                  <p className="text-xs" dir="ltr">
                    {activeCorrection.externalEvidenceReference}
                  </p>
                  {activeCorrection.previousObligationStatus === "PAID" ? (
                    <p>
                      أُنشئ طلب قبض استرداد معلّق بلا أثر نقدي. تتم المراجعة من
                      شاشة سندات القبض لمطابقة دليل المزود قبل أي قيد.
                    </p>
                  ) : me.data?.isOwner === true &&
                    Number(activeCorrection.requestedBy) !==
                      Number(me.data.id) ? (
                    <div className="space-y-2 border-t pt-3">
                      <Label htmlFor="expense-correction-review-reason">
                        سبب الرفض عند الرفض
                      </Label>
                      <Input
                        id="expense-correction-review-reason"
                        value={correctionReviewReason}
                        onChange={(event) =>
                          setCorrectionReviewReason(event.target.value)
                        }
                        placeholder="يُترك فارغاً عند الاعتماد"
                      />
                      <div className="flex gap-2">
                        <Button
                          disabled={
                            approveCorrection.isPending ||
                            rejectCorrection.isPending
                          }
                          onClick={async () => {
                            if (
                              !(await confirm({
                                variant: "warning",
                                title: "اعتماد تصحيح المصدر",
                                description:
                                  "سيُغلق المصدر التشغيلي ويُعكس قيد الاعتراف بقيد append-only مستقل.",
                                confirmText: "اعتماد التصحيح",
                              }))
                            )
                              return;
                            approveCorrection.mutate({
                              correctionRequestId: Number(activeCorrection.id),
                            });
                          }}
                        >
                          اعتماد التصحيح
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={
                            correctionReviewReason.trim().length < 3 ||
                            approveCorrection.isPending ||
                            rejectCorrection.isPending
                          }
                          onClick={() =>
                            rejectCorrection.mutate({
                              correctionRequestId: Number(activeCorrection.id),
                              reason: correctionReviewReason.trim(),
                            })
                          }
                        >
                          رفض التصحيح
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-muted-foreground">
                      ينتظر مالكاً آخر؛ لا يستطيع منشئ الطلب اعتماده أو رفضه.
                    </p>
                  )}
                </div>
              ) : retryableRefundCorrection ? (
                <div className="space-y-3 rounded-md border badge-status-rejected p-3 text-sm">
                  <div className="font-medium">
                    رُفض طلب قبض الاسترداد المرتبط بالتصحيح #
                    {retryableRefundCorrection.id}
                  </div>
                  <p>
                    {retryableRefundCorrection.rejectionReason ??
                      "لم يُسجّل سبب الرفض."}
                  </p>
                  <p className="text-muted-foreground">
                    يحتفظ النظام بالطلب المرفوض وسلسلة التدقيق. يمكن لمنشئ طلب
                    التصحيح وحده إصدار طلب قبض بديل بمفتاح مستقل، ثم يعتمد مالك
                    آخر الطلب الجديد.
                  </p>
                  {Number(retryableRefundCorrection.requestedBy) ===
                  Number(me.data?.id) ? (
                    <Button
                      disabled={retryCorrectionRefund.isPending}
                      onClick={() =>
                        retryCorrectionRefund.mutate({
                          correctionRequestId: Number(
                            retryableRefundCorrection.id,
                          ),
                          clientRequestId: correctionClientRequestId,
                        })
                      }
                    >
                      {retryCorrectionRefund.isPending ? (
                        <Loader2 aria-hidden className="size-4 animate-spin" />
                      ) : null}
                      إعادة تقديم طلب قبض الاسترداد
                    </Button>
                  ) : (
                    <p className="text-muted-foreground">
                      إعادة التقديم محصورة بمنشئ طلب التصحيح الأصلي.
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="expense-correction-reason">
                      سبب التصحيح *
                    </Label>
                    <Textarea
                      id="expense-correction-reason"
                      rows={3}
                      value={correctionReason}
                      onChange={(event) =>
                        setCorrectionReason(event.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="expense-correction-evidence">
                      مرجع الدليل الخارجي *
                    </Label>
                    <Input
                      id="expense-correction-evidence"
                      dir="ltr"
                      value={correctionEvidence}
                      onChange={(event) =>
                        setCorrectionEvidence(event.target.value)
                      }
                    />
                  </div>
                  <ImageUploader
                    value={correctionAttachment}
                    onChange={setCorrectionAttachment}
                    maxItems={1}
                    singlePrimary={false}
                    hint="مرفق فاتورة التصحيح/الإشعار الدائن إلزامي."
                  />
                  {correctionRequiresRefund && (
                    <div className="space-y-3 rounded-md border p-3">
                      <p className="font-medium">دليل الاسترداد الفعلي</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label>الطريقة</Label>
                          <select
                            className={selectCls}
                            value={correctionRefundMethod}
                            onChange={(event) =>
                              setCorrectionRefundMethod(
                                event.target
                                  .value as typeof correctionRefundMethod,
                              )
                            }
                          >
                            {/* مشتقّة من سياسة القبض المشتركة — «صك» كان معروضاً ويرفضه الخادم
                                في سند الاسترداد (`assertInboundPaymentMethodEnabled`) ⇒ صفر مسار نجاح. */}
                            {INBOUND_METHOD_OPTIONS.map((m) => (
                              <option key={m.v} value={m.v}>{m.label}</option>
                            ))}
                          </select>
                        </div>
                        {correctionRefundMethod === "CASH" ? (
                          <div className="space-y-1">
                            <Label>وجهة النقد</Label>
                            <select
                              className={selectCls}
                              value={correctionRefundBucket}
                              onChange={(event) =>
                                setCorrectionRefundBucket(
                                  event.target
                                    .value as typeof correctionRefundBucket,
                                )
                              }
                            >
                              <option value="TREASURY">الخزينة الإدارية</option>
                              <option value="DRAWER">درج الوردية</option>
                            </select>
                          </div>
                        ) : (
                          <div className="space-y-1">
                            <Label>مرجع مزود الاسترداد</Label>
                            <Input
                              dir="ltr"
                              value={correctionRefundReference}
                              onChange={(event) =>
                                setCorrectionRefundReference(event.target.value)
                              }
                            />
                          </div>
                        )}
                        {correctionRefundMethod === "CARD" && (
                          <div className="space-y-1">
                            <Label>آخر أربعة أرقام</Label>
                            <Input
                              dir="ltr"
                              maxLength={4}
                              value={correctionRefundCardTail}
                              onChange={(event) =>
                                setCorrectionRefundCardTail(
                                  event.target.value
                                    .replace(/\D/g, "")
                                    .slice(0, 4),
                                )
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectionTarget(null)}>
              إغلاق
            </Button>
            {!activeCorrection &&
              !retryableRefundCorrection &&
              correctionTarget && (
                <Button
                  variant="destructive"
                  disabled={
                    correctionHistory.isLoading ||
                    requestCorrection.isPending ||
                    correctionReason.trim().length < 3 ||
                    !correctionEvidence.trim() ||
                    !correctionAttachment[0]?.dataUrl ||
                    (correctionRequiresRefund &&
                      correctionRefundMethod !== "CASH" &&
                      !correctionRefundReference.trim()) ||
                    (correctionRequiresRefund &&
                      correctionRefundMethod === "CARD" &&
                      !/^\d{4}$/.test(correctionRefundCardTail))
                  }
                  onClick={() =>
                    requestCorrection.mutate({
                      obligationId: Number(
                        correctionTarget.accrualObligationId,
                      ),
                      reason: correctionReason.trim(),
                      externalEvidenceReference: correctionEvidence.trim(),
                      attachmentUrl: correctionAttachment[0]!.dataUrl,
                      refundPaymentMethod: correctionRequiresRefund
                        ? correctionRefundMethod
                        : null,
                      refundCashBucket:
                        correctionRequiresRefund &&
                        correctionRefundMethod === "CASH"
                          ? correctionRefundBucket
                          : null,
                      refundReferenceNumber:
                        correctionRequiresRefund &&
                        correctionRefundMethod !== "CASH"
                          ? correctionRefundReference.trim()
                          : null,
                      refundCardLastFour:
                        correctionRequiresRefund &&
                        correctionRefundMethod === "CARD"
                          ? correctionRefundCardTail
                          : null,
                      clientRequestId: correctionClientRequestId,
                    })
                  }
                >
                  {requestCorrection.isPending ? (
                    <Loader2 aria-hidden className="size-4 animate-spin" />
                  ) : null}
                  تسجيل طلب التصحيح
                </Button>
              )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
