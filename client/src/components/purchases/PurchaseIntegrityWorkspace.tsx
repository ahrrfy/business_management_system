import { useMemo, useState } from "react";
import { AlertOctagon, CheckCircle2, RotateCcw, XCircle } from "lucide-react";
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
import { fmt } from "@/lib/money";
import {
  canReviewGovernanceRequest,
  newGovernanceKey,
} from "./purchaseGovernanceUiPolicy";

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

  return (
    <div className="space-y-4">
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
