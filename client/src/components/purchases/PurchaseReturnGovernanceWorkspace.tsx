import { useMemo, useState } from "react";
import { PackageMinus, RotateCcw } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  GovernanceApprovalQueue,
  type GovernanceQueueRow,
} from "./GovernanceApprovalQueue";
import { GovernanceRequestNotice } from "./GovernanceRequestNotice";
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
import { newGovernanceKey } from "./purchaseGovernanceUiPolicy";

export type ReturnSource = {
  supplierInvoiceId: number;
  invoiceNumber: string;
  invoiceVersion: number;
  matchRunId: number;
  supplierLabel: string;
  allocations: Array<{
    matchAllocationId: number;
    description: string;
    availableBaseQuantity: number;
  }>;
};

export type ReversalSource = {
  purchaseReturnId: number;
  returnNumber: string;
  returnVersion: number;
  supplierLabel: string;
  items: Array<{
    purchaseReturnItemId: number;
    description: string;
    remainingBaseQuantity: number;
  }>;
};

type EvidenceType =
  | "RETURN_NOTE"
  | "SUPPLIER_ACKNOWLEDGEMENT"
  | "DOCUMENT_IMAGE"
  | "PDF"
  | "EMAIL"
  | "OTHER";

const EVIDENCE_OPTIONS: Array<{ value: EvidenceType; label: string }> = [
  { value: "RETURN_NOTE", label: "مذكرة إرجاع" },
  { value: "SUPPLIER_ACKNOWLEDGEMENT", label: "إقرار المورد" },
  { value: "DOCUMENT_IMAGE", label: "صورة مستند" },
  { value: "PDF", label: "ملف PDF" },
  { value: "EMAIL", label: "بريد إلكتروني" },
  { value: "OTHER", label: "دليل آخر" },
];

function quantityLines(
  quantities: Record<number, string>,
): Array<{ id: number; baseQuantity: number }> {
  return Object.entries(quantities)
    .map(([id, value]) => ({ id: Number(id), baseQuantity: Number(value) }))
    .filter(
      (row) =>
        Number.isSafeInteger(row.id) &&
        Number.isSafeInteger(row.baseQuantity) &&
        row.baseQuantity > 0,
    );
}

export function PurchaseReturnGovernanceWorkspace({
  returnSources,
  reversalSources,
  pendingReturns,
  pendingReversals,
  currentUserId,
  isOwner,
  loadingSources,
  sourcesError,
  onRetrySources,
  requestPending,
  decisionPending,
  onRequestReturn,
  onRequestReversal,
  onDecideReturn,
  onDecideReversal,
  pendingReturnLoading,
  pendingReversalLoading,
  pendingReturnError,
  pendingReversalError,
  onRetryPendingReturns,
  onRetryPendingReversals,
}: {
  returnSources: ReturnSource[];
  reversalSources: ReversalSource[];
  pendingReturns: GovernanceQueueRow[];
  pendingReversals: GovernanceQueueRow[];
  currentUserId: number | null | undefined;
  isOwner?: boolean;
  loadingSources: boolean;
  sourcesError?: unknown;
  onRetrySources: () => void;
  requestPending: boolean;
  decisionPending: boolean;
  onRequestReturn: (input: {
    supplierInvoiceId: number;
    matchRunId: number;
    expectedInvoiceVersion: number;
    requestKey: string;
    settlement: "CREDIT" | "CASH";
    paymentMethod: "CASH" | "CARD" | "TRANSFER" | "WALLET";
    evidenceType: EvidenceType;
    evidenceReference: string;
    reason: string;
    lines: Array<{ matchAllocationId: number; baseQuantity: number }>;
  }) => Promise<unknown>;
  onRequestReversal: (input: {
    purchaseReturnId: number;
    expectedReturnVersion: number;
    requestKey: string;
    evidenceType:
      | "SUPPLIER_ACKNOWLEDGEMENT"
      | "DOCUMENT_IMAGE"
      | "PDF"
      | "EMAIL"
      | "SIGNED_APPROVAL"
      | "OTHER";
    evidenceReference: string;
    reason: string;
    lines: Array<{ purchaseReturnItemId: number; baseQuantity: number }>;
  }) => Promise<unknown>;
  onDecideReturn: Parameters<typeof GovernanceApprovalQueue>[0]["onDecide"];
  onDecideReversal: Parameters<typeof GovernanceApprovalQueue>[0]["onDecide"];
  pendingReturnLoading: boolean;
  pendingReversalLoading: boolean;
  pendingReturnError?: unknown;
  pendingReversalError?: unknown;
  onRetryPendingReturns: () => void;
  onRetryPendingReversals: () => void;
}) {
  const [mode, setMode] = useState<"RETURN" | "REVERSAL" | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [settlement, setSettlement] = useState<"CREDIT" | "CASH">("CREDIT");
  const [paymentMethod, setPaymentMethod] = useState<
    "CASH" | "CARD" | "TRANSFER" | "WALLET"
  >("CASH");
  const [evidenceType, setEvidenceType] = useState<EvidenceType>("RETURN_NOTE");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [reason, setReason] = useState("");

  const selectedReturn = useMemo(
    () =>
      returnSources.find((row) => row.supplierInvoiceId === Number(sourceId)),
    [returnSources, sourceId],
  );
  const selectedReversal = useMemo(
    () =>
      reversalSources.find((row) => row.purchaseReturnId === Number(sourceId)),
    [reversalSources, sourceId],
  );
  const selectedLines = quantityLines(quantities);
  const valid =
    reason.trim().length >= 3 &&
    evidenceReference.trim().length > 0 &&
    selectedLines.length > 0 &&
    (mode === "RETURN" ? selectedReturn != null : selectedReversal != null);

  function reset() {
    setMode(null);
    setSourceId("");
    setQuantities({});
    setSettlement("CREDIT");
    setPaymentMethod("CASH");
    setEvidenceType("RETURN_NOTE");
    setEvidenceReference("");
    setReason("");
  }

  async function submitRequest() {
    if (!valid) return;
    if (mode === "RETURN" && selectedReturn) {
      try {
        await onRequestReturn({
          supplierInvoiceId: selectedReturn.supplierInvoiceId,
          matchRunId: selectedReturn.matchRunId,
          expectedInvoiceVersion: selectedReturn.invoiceVersion,
          requestKey: newGovernanceKey(
            `purchase-return-${selectedReturn.supplierInvoiceId}`,
          ),
          settlement,
          paymentMethod,
          evidenceType,
          evidenceReference: evidenceReference.trim(),
          reason: reason.trim(),
          lines: selectedLines.map((line) => ({
            matchAllocationId: line.id,
            baseQuantity: line.baseQuantity,
          })),
        });
        reset();
      } catch {
        // يبقى الحوار مفتوحاً ويعرض مالك mutation الخطأ.
      }
      return;
    }
    if (mode === "REVERSAL" && selectedReversal) {
      const reversalEvidence =
        evidenceType === "RETURN_NOTE" ? "OTHER" : evidenceType;
      try {
        await onRequestReversal({
          purchaseReturnId: selectedReversal.purchaseReturnId,
          expectedReturnVersion: selectedReversal.returnVersion,
          requestKey: newGovernanceKey(
            `purchase-return-reversal-${selectedReversal.purchaseReturnId}`,
          ),
          evidenceType: reversalEvidence,
          evidenceReference: evidenceReference.trim(),
          reason: reason.trim(),
          lines: selectedLines.map((line) => ({
            purchaseReturnItemId: line.id,
            baseQuantity: line.baseQuantity,
          })),
        });
        reset();
      } catch {
        // يبقى الحوار مفتوحاً ويعرض مالك mutation الخطأ.
      }
    }
  }

  const sourceLines =
    mode === "RETURN" ? selectedReturn?.allocations : selectedReversal?.items;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="inline-flex items-center gap-2">
              <PackageMinus aria-hidden className="size-4" />
              طلب إجراء على مرتجع شراء
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setMode("RETURN");
                  setEvidenceType("RETURN_NOTE");
                }}
              >
                طلب مرتجع
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setMode("REVERSAL");
                  setEvidenceType("SUPPLIER_ACKNOWLEDGEMENT");
                }}
              >
                طلب عكس مرتجع
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={loadingSources}
                onClick={onRetrySources}
              >
                <RotateCcw aria-hidden className="size-4" />
                {ACTION_LABELS.refresh}
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <GovernanceRequestNotice />
          {sourcesError ? (
            <p role="alert" className="text-sm text-destructive">
              تعذّر تحميل المستندات القابلة للإجراء. أعد المحاولة قبل إنشاء طلب.
            </p>
          ) : null}
          {!loadingSources &&
          !sourcesError &&
          returnSources.length === 0 &&
          reversalSources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              لا توجد فواتير أو مرتجعات مؤهلة حالياً.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <GovernanceApprovalQueue
        title="طلبات مرتجعات الشراء بانتظار اعتماد"
        scope="purchase-return"
        rows={pendingReturns}
        currentUserId={currentUserId}
        isOwner={isOwner}
        loading={pendingReturnLoading}
        error={pendingReturnError}
        pending={decisionPending}
        onRetry={onRetryPendingReturns}
        onDecide={onDecideReturn}
      />
      <GovernanceApprovalQueue
        title="طلبات عكس المرتجعات بانتظار اعتماد"
        scope="purchase-return-reversal"
        rows={pendingReversals}
        currentUserId={currentUserId}
        isOwner={isOwner}
        loading={pendingReversalLoading}
        error={pendingReversalError}
        pending={decisionPending}
        onRetry={onRetryPendingReversals}
        onDecide={onDecideReversal}
      />

      <Dialog
        open={mode != null}
        onOpenChange={(open) => !open && !requestPending && reset()}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {mode === "RETURN" ? "طلب مرتجع شراء" : "طلب عكس مرتجع شراء"}
            </DialogTitle>
            <DialogDescription>
              اختر المستند والبنود من المصادر المؤهلة. الإرسال لا يغيّر المخزون
              أو رصيد المورد.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="purchase-return-source">المستند المصدر</Label>
              <AppSelect
                id="purchase-return-source"
                value={sourceId}
                onValueChange={(value) => {
                  setSourceId(value);
                  setQuantities({});
                }}
                disabled={loadingSources || Boolean(sourcesError)}
              >
                <option value="">اختر مستنداً مؤهلاً</option>
                {(mode === "RETURN" ? returnSources : reversalSources).map(
                  (row) => {
                    const id =
                      "supplierInvoiceId" in row
                        ? row.supplierInvoiceId
                        : row.purchaseReturnId;
                    const number =
                      "invoiceNumber" in row
                        ? row.invoiceNumber
                        : row.returnNumber;
                    return (
                      <option key={id} value={id}>
                        {number} — {row.supplierLabel}
                      </option>
                    );
                  },
                )}
              </AppSelect>
            </div>

            {sourceLines?.length ? (
              <div className="space-y-2">
                <Label>البنود والكميات بالوحدة الأساس</Label>
                <div className="space-y-2 rounded-md border p-3">
                  {sourceLines.map((line) => {
                    const id =
                      "matchAllocationId" in line
                        ? line.matchAllocationId
                        : line.purchaseReturnItemId;
                    const max =
                      "availableBaseQuantity" in line
                        ? line.availableBaseQuantity
                        : line.remainingBaseQuantity;
                    return (
                      <div
                        key={id}
                        className="grid items-center gap-2 sm:grid-cols-[1fr_11rem]"
                      >
                        <span className="text-sm">
                          {line.description}{" "}
                          <span className="text-xs text-muted-foreground">
                            (متاح {max})
                          </span>
                        </span>
                        <Input
                          type="number"
                          min={0}
                          max={max}
                          step={1}
                          inputMode="numeric"
                          value={quantities[id] ?? ""}
                          aria-label={`كمية ${line.description}`}
                          onChange={(event) =>
                            setQuantities((current) => ({
                              ...current,
                              [id]: event.target.value,
                            }))
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {mode === "RETURN" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="purchase-return-settlement">التسوية</Label>
                  <AppSelect
                    id="purchase-return-settlement"
                    value={settlement}
                    onValueChange={(value) =>
                      setSettlement(value as "CREDIT" | "CASH")
                    }
                  >
                    <option value="CREDIT">تخفيض ذمة المورد</option>
                    <option value="CASH">استرداد فعلي</option>
                  </AppSelect>
                </div>
                {settlement === "CASH" ? (
                  <div className="space-y-2">
                    <Label htmlFor="purchase-return-method">
                      طريقة الاسترداد
                    </Label>
                    <AppSelect
                      id="purchase-return-method"
                      value={paymentMethod}
                      onValueChange={(value) =>
                        setPaymentMethod(value as typeof paymentMethod)
                      }
                    >
                      <option value="CASH">نقدي</option>
                      <option value="CARD">بطاقة</option>
                      <option value="TRANSFER">تحويل</option>
                      <option value="WALLET">محفظة</option>
                    </AppSelect>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="purchase-return-evidence-type">
                  نوع الدليل
                </Label>
                <AppSelect
                  id="purchase-return-evidence-type"
                  value={evidenceType}
                  onValueChange={(value) =>
                    setEvidenceType(value as EvidenceType)
                  }
                >
                  {EVIDENCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="purchase-return-evidence-reference">
                  مرجع الدليل
                </Label>
                <Input
                  id="purchase-return-evidence-reference"
                  value={evidenceReference}
                  maxLength={500}
                  onChange={(event) => setEvidenceReference(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="purchase-return-reason">سبب الطلب</Label>
              <Textarea
                id="purchase-return-reason"
                value={reason}
                rows={4}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={requestPending}
              onClick={reset}
            >
              تراجع
            </Button>
            <SubmitButton
              type="button"
              pending={requestPending}
              pendingText={ACTION_LABELS.sending}
              disabled={!valid}
              onClick={() => void submitRequest()}
            >
              إرسال للاعتماد
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
