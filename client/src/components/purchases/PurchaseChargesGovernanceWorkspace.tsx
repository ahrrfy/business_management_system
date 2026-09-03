import { useMemo, useState } from "react";
import { ReceiptText, RotateCcw } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { ACTION_LABELS } from "@shared/actionLabels";
import { DataTable } from "@/components/data-table/DataTable";
import { MoneyInput } from "@/components/form/MoneyInput";
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
import { D, fmt, sum } from "@/lib/money";
import { newGovernanceKey } from "./purchaseGovernanceUiPolicy";

type Method = "CASH" | "CARD" | "TRANSFER" | "WALLET";
type ChargeType =
  | "SHIPPING"
  | "CUSTOMS"
  | "FREIGHT"
  | "INSURANCE"
  | "INSPECTION"
  | "OTHER";
type Evidence =
  | "SUPPLIER_INVOICE"
  | "CARRIER_INVOICE"
  | "CUSTOMS_RECEIPT"
  | "BANK_ADVICE"
  | "DOCUMENT_IMAGE"
  | "PDF"
  | "OTHER";

export type PurchaseChargeSource = {
  key: string;
  kind: "PURCHASE_ORDER" | "GOODS_RECEIPT" | "SUPPLIER_INVOICE";
  id: number;
  label: string;
  supplierId: number | null;
  amount: string;
};

export type PurchaseChargeListRow = {
  id: number;
  chargeNumber: string;
  version: number;
  status: "DRAFT" | "POSTED" | "REVERSED";
  chargeType: string;
  settlement: "PAID" | "PAYABLE";
  amount: string;
  expenseDate: string | Date;
};

export type ExpenseAccountOption = { id: number; label: string };
export type SupplierOption = { id: number; label: string };

const TYPE_LABEL: Record<string, string> = {
  SHIPPING: "شحن",
  CUSTOMS: "كمرك",
  FREIGHT: "نقل",
  INSURANCE: "تأمين",
  INSPECTION: "فحص",
  OTHER: "مصروف آخر",
};

export function PurchaseChargesGovernanceWorkspace({
  branchId,
  sources,
  charges,
  expenseAccounts,
  pendingControls,
  currentUserId,
  isOwner,
  loading,
  error,
  onRetry,
  requestPending,
  decisionPending,
  onCreateAndRequestPost,
  onRequestControl,
  onDecideControl,
}: {
  branchId: number;
  sources: PurchaseChargeSource[];
  charges: PurchaseChargeListRow[];
  expenseAccounts: ExpenseAccountOption[];
  suppliers: SupplierOption[];
  pendingControls: GovernanceQueueRow[];
  currentUserId: number | null | undefined;
  isOwner?: boolean;
  loading: boolean;
  error?: unknown;
  onRetry: () => void;
  requestPending: boolean;
  decisionPending: boolean;
  onCreateAndRequestPost: (
    input: {
      branchId: number;
      clientRequestId: string;
      payeeSupplierId?: number | null;
      expenseAccountId: number;
      chargeType: ChargeType;
      settlement: "PAID" | "PAYABLE";
      paymentMethod?: Method | null;
      amount: string;
      expenseDate: string;
      externalReference?: string | null;
      evidenceType: Evidence;
      evidenceReference: string;
      allocations: Array<{
        purchaseOrderId?: number | null;
        goodsReceiptId?: number | null;
        supplierInvoiceId?: number | null;
        allocatedAmount: string;
      }>;
    },
    control: { requestKey: string; evidenceReference: string; reason: string },
  ) => Promise<unknown>;
  onRequestControl: (input: {
    purchaseChargeId: number;
    expectedChargeVersion: number;
    requestKey: string;
    kind: "POST" | "REVERSE";
    evidenceReference: string;
    reason: string;
  }) => Promise<unknown>;
  onDecideControl: Parameters<typeof GovernanceApprovalQueue>[0]["onDecide"];
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [control, setControl] = useState<{
    row: PurchaseChargeListRow;
    kind: "POST" | "REVERSE";
  } | null>(null);
  const [accountId, setAccountId] = useState("");
  const [chargeType, setChargeType] = useState<ChargeType>("SHIPPING");
  const settlement = "PAID" as const;
  const [method, setMethod] = useState<Method>("TRANSFER");
  const [expenseDate, setExpenseDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [externalReference, setExternalReference] = useState("");
  const [evidenceType, setEvidenceType] = useState<Evidence>("CARRIER_INVOICE");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [reason, setReason] = useState("");
  const [allocations, setAllocations] = useState<Record<string, string>>({});

  const allocated = Object.entries(allocations)
    .map(([key, amount]) => ({
      source: sources.find((source) => source.key === key),
      amount,
    }))
    .filter(
      (row): row is { source: PurchaseChargeSource; amount: string } =>
        row.source != null && D(row.amount).gt(0),
    );
  const total = sum(allocated.map((row) => row.amount));
  const createValid =
    Number(accountId) > 0 &&
    D(total).gt(0) &&
    allocated.length > 0 &&
    evidenceReference.trim().length > 0 &&
    reason.trim().length >= 3 &&
    (method === "CASH" || externalReference.trim().length > 0);

  const columns = useMemo<ColumnDef<PurchaseChargeListRow, unknown>[]>(
    () => [
      {
        accessorKey: "chargeNumber",
        header: "رقم المصروف",
        cell: ({ row }) => <bdi dir="ltr">{row.original.chargeNumber}</bdi>,
      },
      {
        accessorKey: "chargeType",
        header: "النوع",
        cell: ({ row }) =>
          TYPE_LABEL[row.original.chargeType] ?? row.original.chargeType,
      },
      {
        accessorKey: "settlement",
        header: "التسوية",
        cell: ({ row }) =>
          row.original.settlement === "PAID" ? "مدفوع" : "مستحق",
      },
      {
        accessorKey: "amount",
        header: "المبلغ",
        cell: ({ row }) => (
          <span dir="ltr" className="font-semibold">
            {fmt(row.original.amount)} د.ع
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "الحالة",
        cell: ({ row }) =>
          row.original.status === "DRAFT"
            ? "مسودة بلا أثر"
            : row.original.status === "POSTED"
              ? "مرحّل"
              : "معكوس",
      },
      {
        id: "actions",
        header: "الإجراء",
        cell: ({ row }) =>
          row.original.status === "REVERSED" ? (
            "—"
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setControl({
                  row: row.original,
                  kind: row.original.status === "DRAFT" ? "POST" : "REVERSE",
                })
              }
            >
              {row.original.status === "DRAFT" ? "طلب ترحيل" : "طلب عكس"}
            </Button>
          ),
      },
    ],
    [],
  );

  function resetCreate() {
    if (requestPending) return;
    setCreateOpen(false);
    setAccountId("");
    setChargeType("SHIPPING");
    setMethod("TRANSFER");
    setExternalReference("");
    setEvidenceType("CARRIER_INVOICE");
    setEvidenceReference("");
    setReason("");
    setAllocations({});
  }

  async function submitCreate() {
    if (!createValid) return;
    const clientRequestId = newGovernanceKey("purchase-charge");
    try {
      await onCreateAndRequestPost(
        {
          branchId,
          clientRequestId,
          payeeSupplierId: null,
          expenseAccountId: Number(accountId),
          chargeType,
          settlement,
          paymentMethod: method,
          amount: total,
          expenseDate,
          externalReference: externalReference.trim() || null,
          evidenceType,
          evidenceReference: evidenceReference.trim(),
          allocations: allocated.map(({ source, amount }) => ({
            purchaseOrderId:
              source.kind === "PURCHASE_ORDER" ? source.id : null,
            goodsReceiptId: source.kind === "GOODS_RECEIPT" ? source.id : null,
            supplierInvoiceId:
              source.kind === "SUPPLIER_INVOICE" ? source.id : null,
            allocatedAmount: amount,
          })),
        },
        {
          requestKey: newGovernanceKey("purchase-charge-post"),
          evidenceReference: evidenceReference.trim(),
          reason: reason.trim(),
        },
      );
      resetCreate();
    } catch {
      // تبقى المدخلات لإعادة المحاولة.
    }
  }

  async function submitControl() {
    if (
      !control ||
      reason.trim().length < 3 ||
      evidenceReference.trim().length === 0
    )
      return;
    try {
      await onRequestControl({
        purchaseChargeId: control.row.id,
        expectedChargeVersion: control.row.version,
        requestKey: newGovernanceKey(
          `purchase-charge-${control.kind.toLowerCase()}-${control.row.id}`,
        ),
        kind: control.kind,
        evidenceReference: evidenceReference.trim(),
        reason: reason.trim(),
      });
      setControl(null);
      setEvidenceReference("");
      setReason("");
    } catch {
      // يبقى الحوار مفتوحاً لإعادة المحاولة.
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="inline-flex items-center gap-2">
              <ReceiptText aria-hidden className="size-4" />
              مصاريف الشراء وتوزيعها
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => setCreateOpen(true)}
              >
                مصروف جديد
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
        <CardContent className="space-y-3">
          <GovernanceRequestNotice>
            إنشاء المصروف يحفظ مسودة وتوزيعاً فقط. الترحيل أو العكس يحتاج طلباً
            واعتماداً مستقلاً؛ المصروف لا يُحمّل تكلفة المخزون.
          </GovernanceRequestNotice>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              تعذّر تحميل المصاريف أو مصادرها. أعد المحاولة.
            </p>
          ) : null}
          <DataTable
            columns={columns}
            data={charges}
            loading={loading}
            searchable
            searchPlaceholder="بحث برقم المصروف أو النوع"
            emptyText="لا توجد مصاريف شراء بعد."
          />
        </CardContent>
      </Card>

      <GovernanceApprovalQueue
        title="طلبات ترحيل أو عكس المصاريف"
        scope="purchase-charge-control"
        rows={pendingControls}
        currentUserId={currentUserId}
        isOwner={isOwner}
        loading={loading}
        error={error}
        pending={decisionPending}
        onRetry={onRetry}
        onDecide={onDecideControl}
      />

      <Dialog open={createOpen} onOpenChange={(open) => !open && resetCreate()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>مصروف شراء جديد</DialogTitle>
            <DialogDescription>
              وزّع المبلغ بالكامل على أوامر شراء أو استلامات أو فواتير مورد.
              الحفظ يتبعه طلب ترحيل بلا أثر حتى الاعتماد.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="purchase-charge-account">حساب المصروف</Label>
                <AppSelect
                  id="purchase-charge-account"
                  value={accountId}
                  onValueChange={setAccountId}
                >
                  <option value="">اختر حساب EXPENSE</option>
                  {expenseAccounts.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="purchase-charge-type">نوع المصروف</Label>
                <AppSelect
                  id="purchase-charge-type"
                  value={chargeType}
                  onValueChange={(value) => setChargeType(value as ChargeType)}
                >
                  {Object.entries(TYPE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="purchase-charge-settlement">التسوية</Label>
                <Input
                  id="purchase-charge-settlement"
                  value="مدفوع الآن"
                  disabled
                />
                <p className="text-xs text-muted-foreground">
                  المصروف الآجل متوقف احترازياً حتى اكتمال دورة التزام وصرف مستقلة؛ لا يُنشأ التزام بلا مسار تسوية.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="purchase-charge-method">طريقة الدفع</Label>
                <AppSelect
                  id="purchase-charge-method"
                  value={method}
                  onValueChange={(value) => setMethod(value as Method)}
                >
                  <option value="CASH">نقدي</option>
                  <option value="CARD">بطاقة</option>
                  <option value="TRANSFER">تحويل</option>
                  <option value="WALLET">محفظة</option>
                </AppSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="purchase-charge-date">تاريخ المصروف</Label>
                <Input
                  id="purchase-charge-date"
                  type="date"
                  dir="ltr"
                  value={expenseDate}
                  onChange={(event) => setExpenseDate(event.target.value)}
                />
              </div>
              {method !== "CASH" ? (
                <div className="space-y-2">
                  <Label htmlFor="purchase-charge-reference">مرجع الدفع</Label>
                  <Input
                    id="purchase-charge-reference"
                    value={externalReference}
                    maxLength={160}
                    onChange={(event) =>
                      setExternalReference(event.target.value)
                    }
                  />
                </div>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>مصادر التوزيع</Label>
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
                {sources.map((source) => (
                  <div
                    key={source.key}
                    className="grid items-center gap-2 sm:grid-cols-[1fr_12rem]"
                  >
                    <div className="text-sm">
                      <p>{source.label}</p>
                      <p className="text-xs text-muted-foreground">
                        القيمة المرجعية {fmt(source.amount)} د.ع
                      </p>
                    </div>
                    <MoneyInput
                      value={allocations[source.key] ?? ""}
                      onChange={(value) =>
                        setAllocations((current) => ({
                          ...current,
                          [source.key]: value,
                        }))
                      }
                      ariaLabel={`توزيع على ${source.label}`}
                    />
                  </div>
                ))}
              </div>
              <p className="text-sm font-semibold" dir="ltr">
                إجمالي المصروف: {fmt(total)} د.ع
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="purchase-charge-evidence-type">
                  نوع الدليل
                </Label>
                <AppSelect
                  id="purchase-charge-evidence-type"
                  value={evidenceType}
                  onValueChange={(value) => setEvidenceType(value as Evidence)}
                >
                  <option value="SUPPLIER_INVOICE">فاتورة مورد</option>
                  <option value="CARRIER_INVOICE">فاتورة ناقل</option>
                  <option value="CUSTOMS_RECEIPT">وصل كمرك</option>
                  <option value="BANK_ADVICE">إشعار مصرفي</option>
                  <option value="DOCUMENT_IMAGE">صورة مستند</option>
                  <option value="PDF">ملف PDF</option>
                  <option value="OTHER">دليل آخر</option>
                </AppSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="purchase-charge-evidence">مرجع الدليل</Label>
                <Input
                  id="purchase-charge-evidence"
                  value={evidenceReference}
                  maxLength={500}
                  onChange={(event) => setEvidenceReference(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="purchase-charge-reason">
                سبب المصروف وطلب الترحيل
              </Label>
              <Textarea
                id="purchase-charge-reason"
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
              onClick={resetCreate}
            >
              تراجع
            </Button>
            <SubmitButton
              type="button"
              pending={requestPending}
              pendingText={ACTION_LABELS.sending}
              disabled={!createValid}
              onClick={() => void submitCreate()}
            >
              حفظ مسودة وإرسال الترحيل للاعتماد
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={control != null}
        onOpenChange={(open) => {
          if (!open && !requestPending) {
            setControl(null);
            setEvidenceReference("");
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {control?.kind === "POST"
                ? "طلب ترحيل المصروف"
                : "طلب عكس المصروف"}
            </DialogTitle>
            <DialogDescription>
              الطلب لا يغيّر القيود أو النقد حتى يعتمد مستخدم مستقل.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="purchase-charge-control-evidence">
                مرجع الدليل
              </Label>
              <Input
                id="purchase-charge-control-evidence"
                value={evidenceReference}
                maxLength={500}
                onChange={(event) => setEvidenceReference(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="purchase-charge-control-reason">السبب</Label>
              <Textarea
                id="purchase-charge-control-reason"
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
              onClick={() => setControl(null)}
            >
              تراجع
            </Button>
            <SubmitButton
              type="button"
              pending={requestPending}
              pendingText={ACTION_LABELS.sending}
              disabled={
                reason.trim().length < 3 ||
                evidenceReference.trim().length === 0
              }
              onClick={() => void submitControl()}
            >
              إرسال للاعتماد
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
