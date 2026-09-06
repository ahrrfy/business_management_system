import { useMemo, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { ACTION_LABELS } from "@shared/actionLabels";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import {
  canReviewGovernanceRequest,
  newGovernanceKey,
} from "./purchaseGovernanceUiPolicy";

type LiveSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
export type LiveIntegrityFinding = {
  id: string;
  severity: LiveSeverity;
  code: string;
  purchaseOrderId: number;
  poNumber: string;
  supplierId: number;
  supplierName: string | null;
  subjectType: string;
  subjectId: number | string;
  ageDays: number | null;
  summaryAr: string;
  evidence: Record<string, unknown>;
};
export type LiveIntegritySummary = {
  findingCount: number;
  affectedOrderCount: number;
  severityCounts: Record<LiveSeverity, number>;
};

const LIVE_SEVERITY_LABEL: Record<LiveSeverity, string> = {
  CRITICAL: "حرجة",
  HIGH: "عالية",
  MEDIUM: "متوسطة",
  INFO: "معلوماتية",
};

const LIVE_SEVERITY_CLASS: Record<LiveSeverity, string> = {
  CRITICAL: "badge-status-danger",
  HIGH: "badge-status-warning",
  MEDIUM: "badge-status-pending",
  INFO: "badge-status-neutral",
};

// المصدر: PURCHASE_INTEGRITY_CODES في server/services/purchaseIntegrityService.ts —
// قائمةٌ مختلفة تماماً عن CODE_LABEL أعلاه (قضايا مطابقة GRN/فاتورة اليدوية)؛ هذه أكواد
// تشخيصٍ آليّ من GL مباشرة، صفر تدخّلٍ بشريّ في اكتشافها.
const LIVE_CODE_LABEL: Record<string, string> = {
  CASH_RECEIVED_PAYMENT_COVERAGE_GAP: "شراء نقدي بلا تغطية دفع مساوية",
  PAID_AMOUNT_GL_DRIFT: "انحراف المدفوع المسجَّل عن الدفتر",
  NEGATIVE_PO_LEDGER_BALANCE: "رصيد دفتري سالب لأمر الشراء",
  PO_PAYMENT_OVER_ALLOCATION: "تخصيص دفعٍ يتجاوز الاعتراف الدفتري",
  HISTORICAL_CREDIT_REVIEW_CANDIDATE: "أمر آجل قديم مرشَّح للمراجعة",
  STALE_PENDING_PO_PAYMENT: "طلب دفع معلَّق تجاوز المهلة",
  STALE_REJECTED_PO_PAYMENT: "طلب دفع مرفوض قديم بلا إغلاق",
  INVALID_PENDING_PO_PAYMENT: "طلب دفع معلَّق أخفق في أدلة المصدر",
  UNAPPROVED_PAYMENT_OUT_LEDGER_ENTRY: "قيد صرف بلا سند معتمد مطابق",
  LEDGER_BRANCH_OR_SUPPLIER_MISMATCH: "قيد بفرع أو مورد لا يطابق المستند",
  IDEMPOTENCY_CONFLICTING_PO_PAY_REFERENCE: "مرجع دفع متعارض بين محاولتين",
  DUPLICATE_PAYMENT_LEDGER_MATERIALIZATION: "سند صرف واحد بقيدين",
  IDEMPOTENCY_RECEIPT_REF_REUSED: "سند مرتبط بأكثر من مفتاح تنفيذ",
};

type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type CaseStatus =
  | "OPEN"
  | "IN_REVIEW"
  | "PENDING_RESOLUTION"
  | "RESOLVED"
  | "DISMISSED";
type IntegrityCode =
  | "GRN_WITHOUT_POSTED_INVOICE"
  | "INVOICE_WITHOUT_GRN"
  | "UNMATCHED_POSTED_INVOICE"
  | "PAYMENT_EXCEEDS_INVOICE"
  | "RETURN_EXCEEDS_MATCH"
  | "RETURN_WITHOUT_SOURCE"
  | "CHARGE_WITHOUT_EVIDENCE"
  | "AP_LEDGER_MISMATCH"
  | "GRNI_AGING"
  | "DUPLICATE_SUPPLIER_DOCUMENT"
  | "LEGACY_AP_CLASSIFICATION"
  | "LEGACY_PAYMENT_ALLOCATION_AMBIGUOUS"
  | "LEGACY_PAYMENT_EVIDENCE_INVALID"
  | "LEGACY_PAYMENT_EXCEEDS_INVOICE"
  | "PERIOD_CLOSE_BLOCKER"
  | "OTHER";

export type PurchaseIntegrityRow = {
  id: number;
  caseNumber: string;
  code: string;
  severity: Severity;
  status: CaseStatus;
  title: string;
  description: string;
  detectedAmount: string | null;
  detectedAt: Date | string;
  resolutionRequestedBy: number | null;
};

export type MonthCloseBlocker = {
  code: string;
  severity: "HIGH" | "CRITICAL";
  count: number;
  message: string;
};

const CODE_LABEL: Record<string, string> = {
  GRN_WITHOUT_POSTED_INVOICE: "استلام بلا فاتورة مرحّلة",
  INVOICE_WITHOUT_GRN: "فاتورة بلا استلام",
  UNMATCHED_POSTED_INVOICE: "فاتورة مرحّلة بلا مطابقة",
  PAYMENT_EXCEEDS_INVOICE: "سداد يتجاوز الفاتورة",
  RETURN_EXCEEDS_MATCH: "مرتجع يتجاوز المطابقة",
  RETURN_WITHOUT_SOURCE: "مرتجع بلا مصدر",
  CHARGE_WITHOUT_EVIDENCE: "مصروف بلا دليل",
  AP_LEDGER_MISMATCH: "اختلاف ذمة المورد والدفتر",
  GRNI_AGING: "استلام غير مفوتر متقادم",
  DUPLICATE_SUPPLIER_DOCUMENT: "مستند مورد مكرر",
  LEGACY_AP_CLASSIFICATION: "تصنيف ذمة إرثية",
  LEGACY_PAYMENT_ALLOCATION_AMBIGUOUS: "تخصيص دفعة إرثية ملتبس",
  LEGACY_PAYMENT_EVIDENCE_INVALID: "دليل دفعة إرثية غير صالح",
  LEGACY_PAYMENT_EXCEEDS_INVOICE: "دفعة إرثية تتجاوز الفاتورة",
  PERIOD_CLOSE_BLOCKER: "مانع إقفال فترة",
  OTHER: "قضية أخرى",
};

const STATUS_LABEL: Record<CaseStatus, string> = {
  OPEN: "مفتوحة",
  IN_REVIEW: "قيد المراجعة",
  PENDING_RESOLUTION: "حل بانتظار اعتماد",
  RESOLVED: "محلولة",
  DISMISSED: "مستبعدة بقرار",
};

export function PurchaseIntegrityWorkspace({
  branchId,
  rows,
  blockers,
  liveFindings,
  liveSummary,
  liveLoading,
  liveError,
  liveIsPartial,
  onRetryLive,
  cutoffDate,
  currentUserId,
  loading,
  error,
  pending,
  onRetry,
  onCutoffDateChange,
  onOpenCase,
  onRequestResolution,
  onDecideResolution,
}: {
  branchId: number;
  rows: PurchaseIntegrityRow[];
  blockers: MonthCloseBlocker[];
  liveFindings: LiveIntegrityFinding[];
  liveSummary: LiveIntegritySummary | null;
  liveLoading: boolean;
  liveError?: unknown;
  /** Codex (P1، ٦/٩): الفحص الحيّ توقّف عند سقف صفحاتٍ أمانيّ قبل نفاد hasMore — النتيجة
   *  جزئية ولا يجوز عرضها كأنها مسحٌ كاملٌ للفرع. */
  liveIsPartial?: boolean;
  onRetryLive: () => void;
  cutoffDate: string;
  currentUserId: number | null | undefined;
  loading: boolean;
  error?: unknown;
  pending: boolean;
  onRetry: () => void;
  onCutoffDateChange: (value: string) => void;
  onOpenCase: (input: {
    caseKey: string;
    branchId: number;
    code: IntegrityCode;
    severity: Severity;
    title: string;
    description: string;
    detectedAmount?: string | null;
    evidence: unknown;
    reason: string;
  }) => Promise<unknown>;
  onRequestResolution: (input: {
    caseId: number;
    requestKey: string;
    reason: string;
    evidenceReference: string;
  }) => Promise<unknown>;
  onDecideResolution: (input: {
    caseId: number;
    decisionKey: string;
    decision: "APPROVE_RESOLVED" | "APPROVE_DISMISSED" | "REJECT";
    reason: string;
  }) => Promise<unknown>;
}) {
  const [openCase, setOpenCase] = useState(false);
  const [resolution, setResolution] = useState<PurchaseIntegrityRow | null>(
    null,
  );
  const [decision, setDecision] = useState<{
    row: PurchaseIntegrityRow;
    value: "APPROVE_RESOLVED" | "APPROVE_DISMISSED" | "REJECT";
  } | null>(null);
  const [code, setCode] = useState<IntegrityCode>("OTHER");
  const [severity, setSeverity] = useState<Severity>("MEDIUM");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [detectedAmount, setDetectedAmount] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [reason, setReason] = useState("");

  function clearForm() {
    if (pending) return;
    setOpenCase(false);
    setResolution(null);
    setDecision(null);
    setCode("OTHER");
    setSeverity("MEDIUM");
    setTitle("");
    setDescription("");
    setDetectedAmount("");
    setEvidenceReference("");
    setReason("");
  }

  async function submitOpenCase() {
    try {
      await onOpenCase({
        caseKey: newGovernanceKey("purchase-integrity-case"),
        branchId,
        code,
        severity,
        title: title.trim(),
        description: description.trim(),
        detectedAmount: detectedAmount || null,
        evidence: {
          reference: evidenceReference.trim(),
          description: description.trim(),
        },
        reason: reason.trim(),
      });
      clearForm();
    } catch {
      // يبقى الحوار مفتوحاً لإصلاح المدخلات أو إعادة المحاولة.
    }
  }

  // caseKey = معرّف الاكتشاف نفسه (finding.id بصيغة code:subjectType:subjectId) — فتحُ نفس
  // الاكتشاف مرّتين idempotent بلا قضيتين مكرّرتين (openPurchaseIntegrityCase يطابق caseKey).
  // code يبقى OTHER دائماً: أكواد التشخيص الحيّ (LIVE_CODE_LABEL) مصدرها GL مباشرة ولا تتقاطع
  // مع قاموس أكواد القضايا اليدوية (CODE_LABEL) — الاسم الحقيقي يبقى محفوظاً في العنوان والدليل.
  async function openFromLiveFinding(finding: LiveIntegrityFinding) {
    const label = LIVE_CODE_LABEL[finding.code] ?? finding.code;
    const ok = await confirm({
      variant: "warning",
      title: "فتح قضية من اكتشاف الفحص الحيّ",
      description: `أمر الشراء ${finding.poNumber} — ${label}. فتح القضية توثيقٌ للمتابعة فقط، ولا يغيّر قيداً أو مخزوناً أو رصيداً.`,
      confirmText: "فتح القضية",
    });
    if (!ok) return;
    const severity: Severity =
      finding.severity === "INFO" ? "LOW" : finding.severity;
    try {
      await onOpenCase({
        caseKey: finding.id,
        branchId,
        code: "OTHER",
        severity,
        title: `${label} — أمر الشراء ${finding.poNumber}`.slice(0, 255),
        description: finding.summaryAr.slice(0, 1000),
        detectedAmount: null,
        evidence: {
          liveCode: finding.code,
          purchaseOrderId: finding.purchaseOrderId,
          poNumber: finding.poNumber,
          supplierId: finding.supplierId,
          supplierName: finding.supplierName,
          subjectType: finding.subjectType,
          subjectId: finding.subjectId,
          ageDays: finding.ageDays,
          ...finding.evidence,
        },
        reason: `اكتشافٌ آليّ من الفحص الحيّ (GL) — ${label}`,
      });
    } catch {
      // notify.err يعرض الخطأ؛ لا حاجة لحالة إضافية هنا.
    }
  }

  async function submitResolutionRequest() {
    if (!resolution) return;
    try {
      await onRequestResolution({
        caseId: resolution.id,
        requestKey: newGovernanceKey(
          `purchase-integrity-resolution-${resolution.id}`,
        ),
        reason: reason.trim(),
        evidenceReference: evidenceReference.trim(),
      });
      clearForm();
    } catch {
      // يبقى الحوار مفتوحاً لإعادة المحاولة.
    }
  }

  async function submitDecision() {
    if (!decision) return;
    try {
      await onDecideResolution({
        caseId: decision.row.id,
        decisionKey: newGovernanceKey(
          `purchase-integrity-decision-${decision.row.id}`,
        ),
        decision: decision.value,
        reason: reason.trim(),
      });
      clearForm();
    } catch {
      // يبقى الحوار مفتوحاً لإعادة المحاولة.
    }
  }

  const columns = useMemo<ColumnDef<PurchaseIntegrityRow, unknown>[]>(
    () => [
      {
        accessorKey: "caseNumber",
        header: "رقم القضية",
        cell: ({ row }) => <bdi dir="ltr">{row.original.caseNumber}</bdi>,
      },
      { accessorKey: "title", header: "القضية" },
      {
        accessorKey: "severity",
        header: "الخطورة",
        cell: ({ row }) =>
          row.original.severity === "CRITICAL"
            ? "حرجة"
            : row.original.severity === "HIGH"
              ? "عالية"
              : row.original.severity === "MEDIUM"
                ? "متوسطة"
                : "منخفضة",
      },
      {
        accessorKey: "status",
        header: "الحالة",
        cell: ({ row }) => STATUS_LABEL[row.original.status],
      },
      {
        accessorKey: "detectedAmount",
        header: "المبلغ المكتشف",
        cell: ({ row }) =>
          row.original.detectedAmount ? (
            <span dir="ltr">{fmt(row.original.detectedAmount)} د.ع</span>
          ) : (
            "—"
          ),
      },
      {
        id: "actions",
        header: "الإجراء",
        cell: ({ row }) => {
          const item = row.original;
          if (item.status === "OPEN" || item.status === "IN_REVIEW")
            return (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setResolution(item);
                  setEvidenceReference("");
                  setReason("");
                }}
              >
                طلب إقفال القضية
              </Button>
            );
          if (item.status !== "PENDING_RESOLUTION") return "—";
          const allowed = canReviewGovernanceRequest(
            currentUserId,
            item.resolutionRequestedBy,
          );
          return (
            <div className="flex flex-wrap gap-1">
              <Button
                type="button"
                size="sm"
                disabled={!allowed}
                onClick={() => {
                  setDecision({ row: item, value: "APPROVE_RESOLVED" });
                  setReason("");
                }}
              >
                <CheckCircle2 aria-hidden className="size-4" />
                حل واعتماد
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!allowed}
                onClick={() => {
                  setDecision({ row: item, value: "APPROVE_DISMISSED" });
                  setReason("");
                }}
              >
                استبعاد موثّق
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={!allowed}
                onClick={() => {
                  setDecision({ row: item, value: "REJECT" });
                  setReason("");
                }}
              >
                <XCircle aria-hidden className="size-4" />
                رفض الحل
              </Button>
            </div>
          );
        },
      },
    ],
    [currentUserId],
  );

  const liveColumns = useMemo<ColumnDef<LiveIntegrityFinding, unknown>[]>(
    () => [
      {
        accessorKey: "severity",
        header: "الخطورة",
        cell: ({ row }) => (
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs ${LIVE_SEVERITY_CLASS[row.original.severity]}`}
          >
            {LIVE_SEVERITY_LABEL[row.original.severity]}
          </span>
        ),
      },
      {
        accessorKey: "code",
        header: "الاكتشاف",
        cell: ({ row }) =>
          LIVE_CODE_LABEL[row.original.code] ?? row.original.code,
      },
      {
        id: "order",
        header: "أمر الشراء",
        cell: ({ row }) => (
          <div className="whitespace-nowrap">
            <bdi dir="ltr">{row.original.poNumber}</bdi>
            {row.original.supplierName ? (
              <span className="text-muted-foreground">
                {" "}
                — {row.original.supplierName}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "summaryAr",
        header: "الوصف",
        cell: ({ row }) => (
          <div className="max-w-md text-sm">
            {row.original.summaryAr}
            {row.original.ageDays != null ? (
              <span className="text-muted-foreground">
                {" "}
                ({row.original.ageDays.toLocaleString("ar-IQ-u-nu-latn")} يوماً)
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: "live-actions",
        header: "الإجراء",
        cell: ({ row }) => (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void openFromLiveFinding(row.original)}
          >
            فتح قضية
          </Button>
        ),
      },
    ],
    // Codex (P2، ٦/٩/٢٦): openFromLiveFinding يُعاد إنشاؤه كل عرضٍ ويحمل branchId الحاليّ في
    // نطاقه — لكن هذا العمود كان محفوظاً بـpending وحده، فيبقى مغلقاً على branchId **قديم**
    // بعد تبديل الفرع بلا تغيّر pending. إدراج الدالّة في الاعتماديات يضمن عمودَ إجراءٍ طازجاً.
    [pending, openFromLiveFinding],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="inline-flex items-center gap-2">
              <AlertTriangle aria-hidden className="size-4" />
              الفحص الحيّ (من الدفتر مباشرة)
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={liveLoading}
              onClick={onRetryLive}
            >
              <RotateCcw aria-hidden className="size-4" />
              {ACTION_LABELS.refresh}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            تشخيصٌ آليّ يقارن أوامر الشراء بحركاتها الفعلية في الدفتر (لا يقرأ
            من قضايا مفتوحة يدوياً) — يكتشف مثلاً شراءً نقدياً بلا صرفٍ معتمد
            يغطّيه. قراءةٌ فقط، لا يُغيّر قيداً أو رصيداً بنفسه.
          </p>
          {liveSummary ? (
            <p className="text-sm">
              {liveSummary.findingCount.toLocaleString("ar-IQ-u-nu-latn")}{" "}
              اكتشافاً على{" "}
              {liveSummary.affectedOrderCount.toLocaleString("ar-IQ-u-nu-latn")}{" "}
              أمر شراء — حرجة{" "}
              {liveSummary.severityCounts.CRITICAL.toLocaleString(
                "ar-IQ-u-nu-latn",
              )}{" "}
              · عالية{" "}
              {liveSummary.severityCounts.HIGH.toLocaleString(
                "ar-IQ-u-nu-latn",
              )}
            </p>
          ) : null}
          {liveIsPartial ? (
            <p className="inline-flex items-center gap-1 text-xs font-semibold text-money-negative">
              <AlertTriangle aria-hidden className="size-3" />
              الفرع كبيرٌ جداً — هذا مسحٌ جزئيّ فقط ولا يغطّي كل أوامر الشراء. لا
              تعتمد على «لا اكتشافات» هنا كدليل نظافةٍ كاملة.
            </p>
          ) : null}
          {liveError ? (
            <ErrorState
              message="تعذّر تشغيل الفحص الحيّ."
              onRetry={onRetryLive}
            />
          ) : (
            <DataTable
              columns={liveColumns}
              data={liveFindings}
              loading={liveLoading}
              searchable
              searchPlaceholder="بحث برقم الأمر أو المورد أو نوع الاكتشاف"
              emptyText="لا اكتشافات في هذا الفرع — الفحص لا يجد فجوة تغطية أو انحرافاً حالياً."
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="inline-flex items-center gap-2">
              <AlertOctagon aria-hidden className="size-4" />
              قضايا نزاهة الشراء
            </span>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => setOpenCase(true)}>
                فتح قضية يدوية
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={loading}
                onClick={onRetry}
              >
                <RotateCcw aria-hidden className="size-4" />
                {ACTION_LABELS.refresh}
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-[12rem_1fr]">
            <div className="space-y-2">
              <Label htmlFor="purchase-close-cutoff">فحص حتى تاريخ</Label>
              <Input
                id="purchase-close-cutoff"
                type="date"
                dir="ltr"
                value={cutoffDate}
                onChange={(event) => onCutoffDateChange(event.target.value)}
              />
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold">موانع إقفال الفترة</p>
              {blockers.length === 0 ? (
                <p role="status" className="text-sm text-muted-foreground">
                  لا توجد موانع شراء عالية أو حرجة حتى التاريخ المحدد.
                </p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {blockers.map((blocker) => (
                    <li key={blocker.code} className="rounded border p-2">
                      <span className="font-semibold">
                        {blocker.severity === "CRITICAL" ? "حرج" : "عالٍ"}
                      </span>{" "}
                      — {blocker.message} (
                      {blocker.count.toLocaleString("ar-IQ-u-nu-latn")})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {error ? (
            <ErrorState
              message="تعذّر تحميل قضايا النزاهة."
              onRetry={onRetry}
            />
          ) : (
            <DataTable
              columns={columns}
              data={rows}
              loading={loading}
              searchable
              searchPlaceholder="بحث برقم القضية أو عنوانها"
              emptyText="لا توجد قضايا نزاهة في نطاقك."
            />
          )}
        </CardContent>
      </Card>

      <Dialog open={openCase} onOpenChange={(open) => !open && clearForm()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>فتح قضية نزاهة شراء</DialogTitle>
            <DialogDescription>
              سجّل الدليل المرصود كما هو. فتح القضية لا يصحح القيد أو المخزون
              تلقائياً.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="integrity-code">نوع القضية</Label>
                <AppSelect
                  id="integrity-code"
                  value={code}
                  onValueChange={(value) => setCode(value as IntegrityCode)}
                >
                  {Object.entries(CODE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="integrity-severity">الخطورة</Label>
                <AppSelect
                  id="integrity-severity"
                  value={severity}
                  onValueChange={(value) => setSeverity(value as Severity)}
                >
                  <option value="LOW">منخفضة</option>
                  <option value="MEDIUM">متوسطة</option>
                  <option value="HIGH">عالية</option>
                  <option value="CRITICAL">حرجة</option>
                </AppSelect>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="integrity-title">العنوان</Label>
              <Input
                id="integrity-title"
                value={title}
                maxLength={255}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="integrity-description">الوصف</Label>
              <Textarea
                id="integrity-description"
                value={description}
                rows={4}
                maxLength={1000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="integrity-amount">المبلغ المكتشف، إن وجد</Label>
                <MoneyInput
                  id="integrity-amount"
                  value={detectedAmount}
                  onChange={setDetectedAmount}
                  ariaLabel="المبلغ المكتشف"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="integrity-evidence">مرجع الدليل</Label>
                <Input
                  id="integrity-evidence"
                  value={evidenceReference}
                  maxLength={500}
                  onChange={(event) => setEvidenceReference(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="integrity-open-reason">سبب فتح القضية</Label>
              <Textarea
                id="integrity-open-reason"
                value={reason}
                rows={3}
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={clearForm}
            >
              تراجع
            </Button>
            <SubmitButton
              type="button"
              pending={pending}
              pendingText={ACTION_LABELS.saving}
              disabled={
                title.trim().length === 0 ||
                description.trim().length === 0 ||
                evidenceReference.trim().length === 0 ||
                reason.trim().length < 3
              }
              onClick={() => void submitOpenCase()}
            >
              فتح القضية
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resolution != null}
        onOpenChange={(open) => !open && clearForm()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>طلب إقفال القضية</DialogTitle>
            <DialogDescription>
              الطلب يغيّر الحالة إلى انتظار اعتماد فقط. يلزم دليل حل وقرار
              مستخدم مستقل.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="integrity-resolution-evidence">
                مرجع دليل الحل
              </Label>
              <Input
                id="integrity-resolution-evidence"
                value={evidenceReference}
                maxLength={500}
                onChange={(event) => setEvidenceReference(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="integrity-resolution-reason">وصف المعالجة</Label>
              <Textarea
                id="integrity-resolution-reason"
                value={reason}
                rows={4}
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={clearForm}
            >
              تراجع
            </Button>
            <SubmitButton
              type="button"
              pending={pending}
              pendingText={ACTION_LABELS.sending}
              disabled={
                evidenceReference.trim().length === 0 ||
                reason.trim().length < 3
              }
              onClick={() => void submitResolutionRequest()}
            >
              إرسال للاعتماد
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={decision != null}
        onOpenChange={(open) => !open && clearForm()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decision?.value === "APPROVE_RESOLVED"
                ? "اعتماد الحل وإقفال القضية"
                : decision?.value === "APPROVE_DISMISSED"
                  ? "استبعاد القضية بقرار موثّق"
                  : "رفض طلب الحل"}
            </DialogTitle>
            <DialogDescription>
              لا يجوز لطالب الحل حسم طلبه. القرار يبقى في سجل الأحداث باسم
              حسابك.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="integrity-decision-reason">سبب القرار</Label>
            <Textarea
              id="integrity-decision-reason"
              value={reason}
              rows={4}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={clearForm}
            >
              تراجع
            </Button>
            <SubmitButton
              type="button"
              pending={pending}
              pendingText={ACTION_LABELS.processing}
              variant={decision?.value === "REJECT" ? "destructive" : "default"}
              disabled={reason.trim().length < 3}
              onClick={() => void submitDecision()}
            >
              تثبيت القرار
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
