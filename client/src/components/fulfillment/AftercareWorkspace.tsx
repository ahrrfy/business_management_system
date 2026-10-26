import React, { useEffect, useRef, useState } from "react";
import {
  deliveryDriverOptions,
  requiresDeliveryDriver,
} from "@/components/delivery/driverOptions";
import { useSearch } from "wouter";
import {
  Plus,
  ShieldCheck,
  Truck,
  PackageCheck,
  RotateCcw,
  CheckCheck,
  XCircle,
  Printer,
} from "lucide-react";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { DataTable } from "@/components/data-table/DataTable";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { confirm } from "@/lib/confirm";
import { printLabel } from "@/lib/printing/print";
import { WorkflowPrintActions } from "@/components/delivery/workflow/WorkflowPrintActions";
import { AftercareSettlementPanel } from "./AftercareSettlementPanel";
import type { AftercareStationProps } from "./AftercareStation";
import { D, fmt } from "@/lib/money";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import {
  AFTERCARE_DISPOSITIONS,
  aftercareCaseStatusLabel,
  aftercareDispositionLabel,
  aftercareExecutionStatusLabel,
  type AftercareDisposition,
} from "@shared/fulfillment";

type ApiInput = RouterInputs["delivery"]["fulfillment"]["aftercare"];
type Detail = RouterOutputs["delivery"]["fulfillment"]["aftercare"]["get"];
type Execution = Detail["executions"][number];
type CreateLine = ApiInput["create"]["lines"][number];
type PrepareLine = ApiInput["prepare"]["lines"][number];

/** Reuses the same key for the same unchanged payload after a lost response. */
function useAftercareActions(refresh: () => Promise<unknown>) {
  const keys = useRef(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function run<T extends object>(
    operation: string,
    payload: T,
    mutate: (input: T & { clientRequestId: string }) => Promise<unknown>,
  ) {
    const fingerprint = `${operation}:${JSON.stringify(payload)}`;
    const key = keys.current.get(fingerprint) ?? crypto.randomUUID();
    keys.current.set(fingerprint, key);
    setPending(true);
    setError("");
    try {
      await mutate({ ...payload, clientRequestId: key });
      keys.current.delete(fingerprint);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "تعذّر تنفيذ المعالجة؛ حدّث المستند وراجع التفاصيل",
      );
    } finally {
      setPending(false);
    }
  }
  return { run, pending, error };
}

export default function AftercareWorkspace({
  scannedBarcode,
  onBarcodeConsumed,
  branchId,
  caseId,
  executionId,
}: AftercareStationProps = {}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number>();
  const [creating, setCreating] = useState(false);
  const canCreate = useOperationPermission(
    "delivery.fulfillment.aftercare.create",
  ).allowed;
  const [scannedSource, setScannedSource] = useState<ApiInput["preview"]>();
  const consumed = useRef<string | null>(null);
  const scan = trpc.delivery.workflow.preview.useQuery(
    { raw: scannedBarcode ?? "", station: "aftercare", branchId },
    { enabled: !!scannedBarcode, retry: false },
  );
  useEffect(() => {
    if (!scannedBarcode || !scan.data || consumed.current === scannedBarcode)
      return;
    const relations = scan.data.relations;
    if (relations.aftercareCaseId) {
      setSelected(relations.aftercareCaseId);
      setCreating(false);
    } else if ((relations.workOrderId || relations.invoiceId) && canCreate) {
      setScannedSource(
        relations.workOrderId
          ? { workOrderId: relations.workOrderId }
          : { invoiceId: relations.invoiceId! },
      );
      setSelected(undefined);
      setCreating(true);
    } else return;
    consumed.current = scannedBarcode;
    onBarcodeConsumed?.();
  }, [scan.data, scannedBarcode, onBarcodeConsumed, canCreate]);
  useEffect(() => {
    if (!scannedBarcode) consumed.current = null;
  }, [scannedBarcode]);
  useEffect(() => {
    if (caseId) setSelected(caseId);
  }, [caseId]);
  const urlSearch = useSearch();
  const linkedExecutionId =
    executionId ?? Number(new URLSearchParams(urlSearch).get("executionId"));
  const linkedExecution =
    trpc.delivery.fulfillment.aftercare.resolveExecution.useQuery(
      { executionId: linkedExecutionId, branchId },
      {
        enabled:
          Number.isSafeInteger(linkedExecutionId) && linkedExecutionId > 0,
      },
    );
  useEffect(() => {
    if (linkedExecution.data) setSelected(linkedExecution.data.caseId);
  }, [linkedExecution.data]);
  useEffect(() => {
    const params = new URLSearchParams(urlSearch);
    const sourceId = Number(
      params.get("invoiceId") || params.get("workOrderId"),
    );
    if (canCreate && Number.isSafeInteger(sourceId) && sourceId > 0)
      setCreating(true);
  }, [urlSearch, canCreate]);
  const list = trpc.delivery.fulfillment.aftercare.list.useQuery({
    branchId,
    search,
    page: page + 1,
    pageSize: 20,
  });
  return (
    <section dir="rtl" className="space-y-4">
      {scan.error && (
        <p role="alert" className="text-sm text-destructive">
          {scan.error.message}
        </p>
      )}
      {scan.data && !canCreate && !scan.data.relations.aftercareCaseId && (
        <p className="text-sm text-muted-foreground">
          إنشاء المعالجة يحتاج موظفاً مخولاً. يمكنك متابعة حالات فرعك القائمة من
          القائمة أدناه.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        امسح الأصل، وثّق النقص، ثم تابع الاعتماد والتجهيز والإرسال والحقوق من
        هذه المحطة.
      </p>
      {linkedExecution.error && (
        <p role="alert" className="text-sm text-destructive">
          {linkedExecution.error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          استكمال المبيع بعهدتنا أو صرف بديل معتمد، مع بقاء البيع والتحصيل
          الأصليين محفوظين.
        </p>
        {canCreate && (
          <Button onClick={() => setCreating(!creating)}>
            <Plus className="size-4" />
            حالة معالجة
          </Button>
        )}
      </div>
      {creating && (
        <NewAftercare
          sourceInput={scannedSource}
          branchId={branchId}
          onCreated={async (id) => {
            setCreating(false);
            if (id) setSelected(id);
            await list.refetch();
          }}
        />
      )}
      <DataTable
        data={list.data?.rows ?? []}
        columns={[
          { accessorKey: "caseNumber", header: "الحالة" },
          { accessorKey: "customerName", header: "العميل" },
          { accessorKey: "invoiceId", header: "الفاتورة المرجعية" },
          { accessorKey: "reason", header: "السبب" },
          {
            accessorKey: "status",
            header: "الحالة التشغيلية",
            cell: ({ row }) => aftercareCaseStatusLabel[row.original.status],
          },
        ]}
        loading={list.isLoading}
        errorState={{
          isError: list.isError,
          message: list.error?.message,
          onRetry: () => void list.refetch(),
        }}
        onRowClick={(row) => setSelected(row.id)}
        serverPagination={{
          page,
          onPageChange: setPage,
          pageSize: 20,
          total: list.data?.total ?? 0,
          isFetching: list.isFetching,
        }}
        serverSearch={{
          value: search,
          onChange: (value) => {
            setSearch(value);
            setPage(0);
          },
        }}
      />
      {selected && (
        <AftercareDetail
          id={selected}
          branchId={branchId}
          onChange={async () => {
            await list.refetch();
          }}
        />
      )}
    </section>
  );
}

function NewAftercare({
  onCreated,
  sourceInput,
  branchId,
}: {
  onCreated: (id?: number) => Promise<void>;
  sourceInput?: ApiInput["preview"];
  branchId?: number;
}) {
  const urlSearch = useSearch();
  const [sourceKind, setSourceKind] = useState<"INVOICE" | "WORK_ORDER">(
    "INVOICE",
  );
  const [sourceReference, setSourceReference] = useState("");
  const [previewInput, setPreviewInput] = useState<ApiInput["preview"]>();
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [choiceIndex, setChoiceIndex] = useState("");
  const [disposition, setDisposition] =
    useState<AftercareDisposition>("MISSING_HELD");
  const [quantity, setQuantity] = useState("1");
  const [movement, setMovement] = useState("");
  const [held, setHeld] = useState(false);
  const [lines, setLines] = useState<CreateLine[]>([]);
  useEffect(() => {
    if (!sourceInput) return;
    setPreviewInput(sourceInput);
    setSourceKind(sourceInput.workOrderId ? "WORK_ORDER" : "INVOICE");
    setSourceReference(
      String(sourceInput.workOrderId ?? sourceInput.invoiceId ?? ""),
    );
    setLines([]);
  }, [sourceInput]);
  useEffect(() => {
    if (sourceInput) return;
    const params = new URLSearchParams(urlSearch);
    const invoiceId = Number(params.get("invoiceId"));
    const workOrderId = Number(params.get("workOrderId"));
    if (Number.isSafeInteger(invoiceId) && invoiceId > 0) {
      setSourceKind("INVOICE");
      setSourceReference(String(invoiceId));
      setPreviewInput({ invoiceId });
      setLines([]);
    } else if (Number.isSafeInteger(workOrderId) && workOrderId > 0) {
      setSourceKind("WORK_ORDER");
      setSourceReference(String(workOrderId));
      setPreviewInput({ workOrderId });
      setLines([]);
    }
  }, [urlSearch, sourceInput]);
  const preview = trpc.delivery.fulfillment.aftercare.preview.useQuery(
    { ...previewInput, branchId },
    { enabled: !!previewInput },
  );
  useEffect(() => {
    if (preview.data) {
      setSourceReference(preview.data.sourceNumber);
      setSourceKind(preview.data.workOrderId ? "WORK_ORDER" : "INVOICE");
      if (
        preview.data.choices.length === 1 &&
        preview.data.choices[0].sourceWorkOrderId != null
      ) {
        setChoiceIndex("0");
        setDisposition("REPRINT");
        setMovement("");
        setHeld(false);
      }
    }
  }, [preview.data]);
  const createdId = useRef<number | undefined>(undefined);
  const create = trpc.delivery.fulfillment.aftercare.create.useMutation({
    onSuccess: (result) => {
      createdId.current = result.id;
    },
  });
  const action = useAftercareActions(() => onCreated(createdId.current));
  const choice =
    choiceIndex === "" ? undefined : preview.data?.choices[Number(choiceIndex)];
  return (
    <div className="space-y-3 rounded border p-3">
      <p className="font-medium">فتح حالة من المستند الأصلي</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Label>
          نوع الأصل
          <AppSelect
            value={sourceKind}
            onValueChange={(value) => {
              if (value !== "INVOICE" && value !== "WORK_ORDER") return;
              setSourceKind(value);
              setPreviewInput(undefined);
              setSourceReference("");
              setLines([]);
              setChoiceIndex("");
              setMovement("");
              setHeld(false);
            }}
          >
            <option value="INVOICE">فاتورة</option>
            <option value="WORK_ORDER">أمر شغل مسلّم</option>
          </AppSelect>
        </Label>
        <Label>
          رقم الفاتورة / أمر الشغل أو باركوده
          <Input
            placeholder="الرقم المطبوع أو الباركود"
            value={sourceReference}
            onChange={(event) => {
              setSourceReference(event.target.value);
              setPreviewInput(undefined);
              setLines([]);
              setChoiceIndex("");
              setMovement("");
              setHeld(false);
            }}
          />
        </Label>
        <Button
          variant="outline"
          disabled={!sourceReference.trim() || preview.isFetching}
          onClick={() => {
            setPreviewInput({
              sourceKind,
              sourceReference: sourceReference.trim(),
            });
            setChoiceIndex("");
          }}
        >
          معاينة الأصل والمخرجات
        </Button>
      </div>
      {preview.error && (
        <p role="alert" className="text-sm text-destructive">
          {preview.error.message}
        </p>
      )}
      {preview.data && (
        <>
          <p className="text-sm">
            الأصل المعاين: {preview.data.workOrderId ? "أمر شغل" : "فاتورة"}{" "}
            {preview.data.sourceNumber}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Label>
              المكوّن أو مخرج أمر الشغل الأصلي
              <AppSelect
                value={choiceIndex}
                onValueChange={(value) => {
                  setChoiceIndex(value);
                  setMovement("");
                  setHeld(false);
                  if (
                    preview.data?.choices[Number(value)]?.sourceWorkOrderId !=
                    null
                  )
                    setDisposition("REPRINT");
                }}
              >
                <option value="">اختر سطر الأصل</option>
                {preview.data.choices.map((item, index) => (
                  <option
                    key={`${item.sourceWorkOrderId}:${item.originalInvoiceItemId}:${item.variantId}`}
                    value={String(index)}
                  >
                    {item.label?.name} {item.label?.variantName} — متاح للمعالجة{" "}
                    {item.availableForAftercare}
                  </option>
                ))}
              </AppSelect>
            </Label>
            <Label>
              نوع المعالجة
              <AppSelect
                value={disposition}
                onValueChange={(value) =>
                  setDisposition(value as AftercareDisposition)
                }
              >
                {AFTERCARE_DISPOSITIONS.filter(
                  (value) =>
                    choice?.sourceWorkOrderId == null || value === "REPRINT",
                ).map((value) => (
                  <option key={value} value={value}>
                    {aftercareDispositionLabel[value]}
                  </option>
                ))}
              </AppSelect>
            </Label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Label>
              {choice?.sourceWorkOrderId != null
                ? "عدد مخرجات أمر الشغل"
                : "الكمية بالوحدة الأساس"}
              <MoneyInput
                decimals={0}
                value={quantity}
                onChange={setQuantity}
              />
            </Label>
            {disposition === "MISSING_HELD" && (
              <Label>
                حركة الخصم الأصلية
                <AppSelect value={movement} onValueChange={setMovement}>
                  <option value="">اختر الدليل</option>
                  {choice?.movements.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      حركة {item.id} — كمية {item.quantity}
                    </option>
                  ))}
                </AppSelect>
              </Label>
            )}
          </div>
          {disposition === "MISSING_HELD" && (
            <Label className="flex items-center gap-2">
              <Checkbox
                checked={held}
                onCheckedChange={(value) => setHeld(value === true)}
              />
              تحققت من وجود القطعة وفصلها فعلياً بعهدة العميل
            </Label>
          )}
          <Label>
            السبب
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Label>
          <Label>
            الدليل والملاحظات
            <Textarea
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </Label>
          <Button
            variant="outline"
            disabled={
              !choice ||
              !choiceIndex ||
              !evidence.trim() ||
              Number(quantity) <= 0 ||
              (disposition === "MISSING_HELD" && (!held || !movement))
            }
            onClick={() => {
              if (choice)
                setLines([
                  ...lines,
                  {
                    originalInvoiceItemId: choice.originalInvoiceItemId,
                    sourceWorkOrderId: choice.sourceWorkOrderId,
                    originalBundleComponentId: choice.originalBundleComponentId,
                    componentVariantId: choice.variantId,
                    disposition,
                    baseQuantity: Number(quantity),
                    originalMovementId:
                      disposition === "MISSING_HELD"
                        ? Number(movement)
                        : undefined,
                    physicalHeldConfirmed: held,
                    evidence,
                  },
                ]);
            }}
          >
            إضافة سطر المعالجة
          </Button>
          {lines.map((line, index) => (
            <div
              key={index}
              className="flex items-center justify-between border-b py-2 text-sm"
            >
              <span>
                {
                  preview.data.choices.find(
                    (item) =>
                      item.originalInvoiceItemId ===
                        line.originalInvoiceItemId &&
                      item.variantId === line.componentVariantId &&
                      item.sourceWorkOrderId === line.sourceWorkOrderId,
                  )?.label?.name
                }{" "}
                — {aftercareDispositionLabel[line.disposition]} —{" "}
                {line.baseQuantity}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setLines(lines.filter((_, item) => item !== index))
                }
              >
                حذف السطر
              </Button>
            </div>
          ))}
          <SubmitButton
            type="button"
            pending={action.pending}
            disabled={!lines.length || !reason.trim() || !evidence.trim()}
            onClick={() =>
              void action.run(
                "create",
                {
                  ...(preview.data.workOrderId
                    ? { workOrderId: preview.data.workOrderId }
                    : { invoiceId: preview.data.invoiceId }),
                  branchId: preview.data.branchId,
                  reason,
                  evidence,
                  lines,
                },
                create.mutateAsync,
              )
            }
          >
            حفظ وإرسال للمراجعة
          </SubmitButton>
        </>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      )}
    </div>
  );
}

function AftercareDetail({
  id,
  branchId,
  onChange,
}: {
  id: number;
  branchId?: number;
  onChange: () => Promise<void>;
}) {
  const detail = trpc.delivery.fulfillment.aftercare.get.useQuery({
    id,
    branchId,
  });
  const approve = trpc.delivery.fulfillment.aftercare.approve.useMutation();
  const cancel = trpc.delivery.fulfillment.aftercare.cancel.useMutation();
  const resolve = trpc.delivery.fulfillment.aftercare.resolve.useMutation();
  const canApprove = useOperationPermission(
    "delivery.fulfillment.aftercare.approve",
  ).allowed;
  const canCancel = useOperationPermission(
    "delivery.fulfillment.aftercare.cancel",
  ).allowed;
  const canResolve = useOperationPermission(
    "delivery.fulfillment.aftercare.resolve",
  ).allowed;
  const canPrepare = useOperationPermission(
    "delivery.fulfillment.aftercare.prepare",
  ).allowed;
  const [note, setNote] = useState("");
  const action = useAftercareActions(async () => {
    await detail.refetch();
    await onChange();
  });
  const row = detail.data?.case;
  if (!row || !detail.data)
    return detail.error ? (
      <p role="alert" className="text-destructive">
        {detail.error.message}
      </p>
    ) : null;
  const data = detail.data;
  const transition = { id: row.id, expectedVersion: row.version };
  return (
    <div className="space-y-4 rounded border p-3">
      <div className="flex flex-wrap justify-between gap-2">
        <p className="font-medium">
          {row.caseNumber} — {aftercareCaseStatusLabel[row.status]}
        </p>
        <span className="text-sm text-muted-foreground">
          الأصل:{" "}
          {row.invoiceId
            ? `فاتورة ${row.invoiceId}`
            : `أمر شغل ${row.workOrderId}`}{" "}
          — مرجع تاريخي
        </span>
      </div>
      <p className="text-sm">السبب: {row.reason}</p>
      <p className="whitespace-pre-wrap text-sm">الدليل: {row.evidence}</p>
      <p className="text-sm text-muted-foreground">
        الطالب: {data.actors.find((actor) => actor.id === row.createdBy)?.name}{" "}
        — المعتمد:{" "}
        {data.actors.find((actor) => actor.id === row.approvedBy)?.name ??
          "بانتظار مراجعة مستقلة"}
      </p>
      <DataTable
        data={data.lines}
        columns={[
          { accessorKey: "productName", header: "المكوّن" },
          {
            accessorKey: "disposition",
            header: "المعالجة",
            cell: ({ row }) =>
              aftercareDispositionLabel[row.original.disposition],
          },
          { accessorKey: "baseQuantity", header: "معتمد" },
          { accessorKey: "executedBaseQuantity", header: "صُرف / عُهد" },
          { accessorKey: "deliveredBaseQuantity", header: "سُلّم" },
          { accessorKey: "settledBaseQuantity", header: "سُوّي بمستند" },
          { accessorKey: "evidence", header: "الدليل" },
        ]}
      />
      {row.status === "DRAFT" && canApprove && (
        <SubmitButton
          type="button"
          pending={action.pending}
          onClick={async () => {
            if (
              await confirm({
                title: "اعتماد المعالجة",
                description:
                  "تحقق من المكونات والكمية والدليل والعهدة. الاعتماد يحتاج موظفاً غير الطالب.",
                variant: "warning",
              })
            )
              await action.run("approve", transition, approve.mutateAsync);
          }}
        >
          <ShieldCheck className="size-4" />
          اعتماد مستقل
        </SubmitButton>
      )}
      {["DRAFT", "APPROVED", "IN_PROGRESS"].includes(row.status) && (
        <>
          <Label>
            سبب الإلغاء أو نتيجة الإقفال
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Label>
          <div className="flex flex-wrap gap-2">
            {canCancel &&
              (row.status === "DRAFT" ||
                !data.lines.some(
                  (line) => line.disposition === "MISSING_HELD",
                )) &&
              data.lines.every((line) => line.executedBaseQuantity === 0) && (
                <SubmitButton
                  type="button"
                  variant="outline"
                  pending={action.pending}
                  disabled={!note.trim()}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "إلغاء حالة المعالجة",
                        description: note,
                        variant: "danger",
                      })
                    )
                      await action.run(
                        "cancel",
                        { ...transition, reason: note },
                        cancel.mutateAsync,
                      );
                  }}
                >
                  <XCircle className="size-4" />
                  إلغاء الحالة
                </SubmitButton>
              )}
            {canResolve && row.status === "IN_PROGRESS" && (
              <SubmitButton
                type="button"
                pending={action.pending}
                disabled={!note.trim()}
                onClick={() =>
                  void action.run(
                    "resolve",
                    { ...transition, resolution: note },
                    resolve.mutateAsync,
                  )
                }
              >
                <CheckCheck className="size-4" />
                إقفال بعد حسم الكميات والحقوق والالتزامات
              </SubmitButton>
            )}
          </div>
        </>
      )}
      {canPrepare &&
        !data.settlement &&
        ["APPROVED", "IN_PROGRESS"].includes(row.status) && (
          <PrepareAftercare
            data={data}
            onChange={async () => {
              await detail.refetch();
            }}
          />
        )}
      {data.executions.map((execution) => (
        <AftercareExecution
          key={execution.id}
          execution={execution}
          onChange={async () => {
            await detail.refetch();
          }}
        />
      ))}
      {(["APPROVED", "IN_PROGRESS"].includes(row.status) ||
        data.settlement?.status === "POSTED") && (
        <AftercareSettlementPanel
          data={data}
          onChange={async () => {
            await detail.refetch();
            await onChange();
          }}
        />
      )}
      {data.receipts.length > 0 && (
        <DataTable
          data={data.receipts}
          columns={[
            { accessorKey: "id", header: "سند الصرف" },
            { accessorKey: "referenceNumber", header: "المرجع" },
            {
              accessorKey: "amount",
              header: "المبلغ",
              cell: ({ row }) => fmt(row.original.amount),
            },
            { accessorKey: "paymentMethod", header: "وسيلة الدفع" },
          ]}
        />
      )}
      {row.resolution && (
        <p className="text-sm">نتيجة المعالجة: {row.resolution}</p>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      )}
    </div>
  );
}

function PrepareAftercare({
  data,
  onChange,
}: {
  data: Detail;
  onChange: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [deliveryFee, setFee] = useState("0");
  const [productSearch, setProductSearch] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [materials, setMaterials] = useState<
    Record<number, { variantId: number; baseQuantity: number }[]>
  >({});
  const [variantId, setVariant] = useState("");
  const [materialQuantity, setMaterialQuantity] = useState("1");
  const [reuseId, setReuseId] = useState("");
  const products = trpc.delivery.fulfillment.aftercare.products.useQuery({
    branchId: data.case.branchId,
    search: productSearch,
  });
  const prepare = trpc.delivery.fulfillment.aftercare.prepare.useMutation();
  const action = useAftercareActions(onChange);
  const returned = data.executions.filter(
    (execution) =>
      ["RETURNED", "CANCELLED"].includes(execution.status) &&
      execution.lines.some(
        (line) => line.kind === "OUTPUT" && line.settledBaseQuantity === 0,
      ) &&
      !data.executions.some((other) =>
        other.lines.some(
          (line) =>
            line.reusedFromLineId &&
            execution.lines.some(
              (original) => original.id === line.reusedFromLineId,
            ),
        ),
      ),
  );
  const reuse = returned.find((execution) => execution.id === Number(reuseId));
  const lines: PrepareLine[] = reuse
    ? reuse.lines
        .filter((line) => line.kind === "OUTPUT")
        .map((line) => ({
          aftercareLineId: line.aftercareLineId,
          baseQuantity: line.fulfilledBaseQuantity,
        }))
    : data.lines
        .filter((line) => Number(quantities[line.id]) > 0)
        .map((line) => ({
          aftercareLineId: line.id,
          baseQuantity: Number(quantities[line.id]),
          materials:
            line.disposition === "REPRINT" ? materials[line.id] : undefined,
        }));
  return (
    <div className="space-y-3 border-t pt-3">
      <p className="font-medium">تجهيز دفعة معالجة — التحصيل من العميل صفر</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Label>
          المستلم
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Label>
        <Label>
          الهاتف
          <IntlPhoneInput
            value={phone}
            onChange={setPhone}
            ariaLabel="هاتف مستلم المعالجة"
          />
        </Label>
        <Label>
          أجرة على المكتبة
          <MoneyInput value={deliveryFee} onChange={setFee} />
        </Label>
      </div>
      <Label>
        عنوان التسليم
        <Textarea
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </Label>
      {returned.length > 0 && (
        <Label>
          إعادة إرسال عهدة عائدة مثبتة
          <AppSelect value={reuseId} onValueChange={setReuseId}>
            <option value="">صرف دفعة جديدة من الحق المتبقي</option>
            {returned.map((execution) => (
              <option key={execution.id} value={String(execution.id)}>
                الدفعة {execution.id} — {execution.returnEvidence}
              </option>
            ))}
          </AppSelect>
        </Label>
      )}
      {reuse ? (
        <p className="text-sm">
          يعاد إرسال العهدة العائدة كاملة دون خصم مخزون أو مصروف بديل جديد.
        </p>
      ) : (
        <>
          {data.lines
            .filter((line) => line.baseQuantity > line.executedBaseQuantity)
            .map((line) => (
              <div key={line.id} className="space-y-2 rounded border p-2">
                <Label>
                  {line.productName} {line.variantName} —{" "}
                  {aftercareDispositionLabel[line.disposition]} — المتبقي{" "}
                  {line.baseQuantity - line.executedBaseQuantity}
                  <MoneyInput
                    decimals={0}
                    value={quantities[line.id] ?? "0"}
                    onChange={(value) =>
                      setQuantities({ ...quantities, [line.id]: value })
                    }
                  />
                </Label>
                {line.disposition === "REPRINT" && (
                  <>
                    <Label>
                      بحث الخامات الجديدة
                      <Input
                        value={productSearch}
                        onChange={(event) =>
                          setProductSearch(event.target.value)
                        }
                      />
                    </Label>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <AppSelect
                        aria-label="الخامة"
                        value={variantId}
                        onValueChange={setVariant}
                      >
                        <option value="">اختر خامة متاحة</option>
                        {products.data?.map((product) => (
                          <option key={product.id} value={String(product.id)}>
                            {product.name} {product.variantName} — رصيد{" "}
                            {product.quantity}
                          </option>
                        ))}
                      </AppSelect>
                      <MoneyInput
                        ariaLabel="كمية الخامة"
                        decimals={0}
                        value={materialQuantity}
                        onChange={setMaterialQuantity}
                      />
                      <Button
                        variant="outline"
                        disabled={!variantId || Number(materialQuantity) <= 0}
                        onClick={() =>
                          setMaterials({
                            ...materials,
                            [line.id]: [
                              ...(materials[line.id] ?? []),
                              {
                                variantId: Number(variantId),
                                baseQuantity: Number(materialQuantity),
                              },
                            ],
                          })
                        }
                      >
                        إضافة خامة
                      </Button>
                    </div>
                    {materials[line.id]?.map((material, index) => (
                      <div key={index} className="flex justify-between text-sm">
                        <span>
                          {products.data?.find(
                            (product) => product.id === material.variantId,
                          )?.name ?? `صنف ${material.variantId}`}{" "}
                          × {material.baseQuantity}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setMaterials({
                              ...materials,
                              [line.id]: materials[line.id].filter(
                                (_, item) => item !== index,
                              ),
                            })
                          }
                        >
                          حذف
                        </Button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            ))}
        </>
      )}
      <SubmitButton
        type="button"
        pending={action.pending}
        disabled={
          !name.trim() || !phone.trim() || !address.trim() || !lines.length
        }
        onClick={async () => {
          if (
            await confirm({
              title: "تثبيت دفعة المعالجة",
              description:
                "يصرف البديل والخامات مرة واحدة بالتكلفة الحالية. المبيع الموجود بعهدتنا يثبت دون حركة مخزون جديدة.",
              variant: "warning",
            })
          )
            await action.run(
              "prepare",
              {
                id: data.case.id,
                expectedVersion: data.case.version,
                recipientName: name,
                recipientPhone: phone,
                deliveryAddress: address,
                deliveryFee,
                lines,
                reuseExecutionId: reuse?.id,
              },
              prepare.mutateAsync,
            );
        }}
      >
        <PackageCheck className="size-4" />
        تثبيت التجهيز والعهدة
      </SubmitButton>
      {products.error && (
        <p role="alert" className="text-sm text-destructive">
          {products.error.message}
        </p>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      )}
    </div>
  );
}

function AftercareExecution({
  execution,
  onChange,
}: {
  execution: Execution;
  onChange: () => Promise<void>;
}) {
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true });
  const [partyId, setPartyId] = useState("");
  const [assignedUserId, setAssignedUserId] = useState("");
  const [tracking, setTracking] = useState("");
  const [proof, setProof] = useState("");
  const [result, setResult] = useState<"DELIVERED" | "FAILED" | "RETURNED">(
    "DELIVERED",
  );
  const [feeEarned, setFeeEarned] = useState(false);
  const [cashBucket, setBucket] = useState<"DRAWER" | "TREASURY">("DRAWER");
  const [shiftId, setShift] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [shopHeld, setShopHeld] = useState(false);
  const [printError, setPrintError] = useState("");
  const cancelExecution =
    trpc.delivery.fulfillment.aftercare.cancelExecution.useMutation();
  const declareReturn =
    trpc.delivery.fulfillment.aftercare.declareReturn.useMutation();
  const dispatch = trpc.delivery.fulfillment.aftercare.dispatch.useMutation();
  const confirmDelivery =
    trpc.delivery.fulfillment.aftercare.confirm.useMutation();
  const payFee = trpc.delivery.fulfillment.aftercare.payFee.useMutation();
  const canDispatch = useOperationPermission(
    "delivery.fulfillment.aftercare.dispatch",
  ).allowed;
  const canConfirm = useOperationPermission(
    "delivery.fulfillment.aftercare.confirm",
  ).allowed;
  const canPay = useOperationPermission(
    "delivery.fulfillment.aftercare.payFee",
  ).allowed;
  const canCancelExecution = useOperationPermission(
    "delivery.fulfillment.aftercare.cancelExecution",
  ).allowed;
  const canDeclareReturn = useOperationPermission(
    "delivery.fulfillment.aftercare.declareReturn",
  ).allowed;
  const action = useAftercareActions(onChange);
  const identity = { id: execution.id, expectedVersion: execution.version };
  const selectedParty = parties.data?.find(
    (party) => String(party.id) === partyId,
  );
  const requiresDriver = requiresDeliveryDriver(selectedParty);
  const drivers = deliveryDriverOptions(selectedParty, execution.branchId);
  return (
    <div className="space-y-3 border-t pt-3">
      <p className="font-medium">
        دفعة {execution.id} — {aftercareExecutionStatusLabel[execution.status]}{" "}
        — {execution.partyName ?? "لم تسند"}
      </p>
      <WorkflowPrintActions
        branchId={execution.branchId}
        source={{ kind: "aftercareExecution", id: execution.id }}
        consignmentId={execution.consignmentId}
        mode="aftercare"
      />
      <div className="flex flex-wrap items-center gap-2">
        <code dir="ltr">{execution.barcode}</code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={async () => {
            setPrintError("");
            try {
              const result = await printLabel(
                [
                  {
                    name: `معالجة ${execution.caseNumber} — دفعة ${execution.id}`,
                    sku: `${execution.originalSource.kind === "INVOICE" ? "فاتورة" : "أمر شغل"} ${execution.originalSource.id} — ${execution.recipientName}`,
                    barcode: execution.barcode,
                  },
                ],
                { showName: true, showPrice: false },
              );
              if (!result.ok)
                setPrintError(
                  "حُجبت نافذة الطباعة؛ اسمح بها ثم أعد طباعة باركود الدفعة نفسها.",
                );
            } catch {
              setPrintError(
                "تعذرت طباعة الملصق؛ الدفعة محفوظة. أعد طباعة الباركود نفسه.",
              );
            }
          }}
        >
          <Printer className="size-4" />
          باركود الدفعة للإرسال العادي
        </Button>
        {printError && (
          <p role="alert" className="text-sm text-destructive">
            {printError}
          </p>
        )}
      </div>
      <p className="text-sm">
        المستلم: {execution.recipientName} — {execution.recipientPhone} —{" "}
        {execution.deliveryAddress}
      </p>
      <p className="text-sm">
        {execution.totalCost != null && (
          <>تكلفة البديل / الخامات: {fmt(execution.totalCost)} — </>
        )}
        الأجرة: {fmt(execution.deliveryFee)} — مستحق ناقل:{" "}
        {fmt(execution.feeLedger.due)} — COD: 0
      </p>
      {execution.consignmentId && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm">
            إرسالية المعالجة:{" "}
            {execution.consignmentNumber ?? execution.consignmentId}{" "}
            {execution.externalTrackingRef
              ? `— البوليصة ${execution.externalTrackingRef}`
              : ""}
          </p>
        </div>
      )}
      <DataTable
        data={execution.lines}
        columns={[
          {
            accessorKey: "kind",
            header: "نوع السطر",
            cell: ({ row }) =>
              row.original.kind === "OUTPUT" ? "مخرج / عهدة" : "خامة جديدة",
          },
          { accessorKey: "productName", header: "الصنف" },
          { accessorKey: "baseQuantity", header: "الكمية" },
          { accessorKey: "custodyBaseQuantity", header: "العهدة" },
          { accessorKey: "deliveredBaseQuantity", header: "المسلّم" },
          { accessorKey: "returnedBaseQuantity", header: "العائد فعلياً" },
          { accessorKey: "settledBaseQuantity", header: "سُوّي بمستند" },
          ...(execution.totalCost != null
            ? [
                {
                  accessorKey: "lineCost",
                  header: "التكلفة",
                  cell: ({
                    row,
                  }: {
                    row: { original: Execution["lines"][number] };
                  }) =>
                    row.original.lineCost == null
                      ? "—"
                      : fmt(row.original.lineCost),
                },
              ]
            : []),
        ]}
      />
      {execution.status === "PREPARED" && canDispatch && (
        <div className="grid gap-2 sm:grid-cols-3">
          <AppSelect
            aria-label="جهة التوصيل"
            value={partyId}
            onValueChange={(value) => {
              setPartyId(value);
              setAssignedUserId("");
            }}
          >
            <option value="">اختر الناقل</option>
            {parties.data
              ?.filter(
                (party) =>
                  party.branchId == null ||
                  party.branchId === execution.branchId,
              )
              .map((party) => (
                <option key={party.id} value={String(party.id)}>
                  {party.name}
                </option>
              ))}
          </AppSelect>
          <AppSelect
            aria-label="موظف التوصيل"
            value={assignedUserId}
            onValueChange={setAssignedUserId}
          >
            <option value="">اختر موظف التوصيل</option>
            {drivers.map((driver) => (
              <option key={driver.userId} value={String(driver.userId)}>
                {driver.name}
              </option>
            ))}
          </AppSelect>
          {partyId &&
            !parties.isLoading &&
            !drivers.length &&
            requiresDriver && (
              <p className="text-sm text-destructive">
                لا يوجد موظف توصيل فعال مرتبط بهذه الجهة. اربط حساب المندوب من
                إعدادات جهات التوصيل، ثم حدّث قائمة الموظفين قبل الإسناد.
              </p>
            )}
          <Input
            aria-label="رقم تتبع الشركة"
            placeholder="رقم تتبع الشركة"
            value={tracking}
            onChange={(event) => setTracking(event.target.value)}
          />
          <SubmitButton
            type="button"
            pending={action.pending}
            disabled={
              !partyId ||
              (requiresDriver && !assignedUserId) ||
              parties.isLoading
            }
            onClick={() =>
              void action.run(
                "dispatch",
                {
                  ...identity,
                  partyId: Number(partyId),
                  assignedUserId: assignedUserId
                    ? Number(assignedUserId)
                    : undefined,
                  externalTrackingRef: tracking || undefined,
                },
                dispatch.mutateAsync,
              )
            }
          >
            <Truck className="size-4" />
            إرسال دون تحصيل
          </SubmitButton>
        </div>
      )}
      {["PREPARED", "DISPATCHED"].includes(execution.status) &&
        canCancelExecution && (
          <div className="space-y-2 border-t pt-3">
            <Label>
              محضر التحقق قبل استلام الناقل
              <Textarea
                value={proof}
                onChange={(event) => setProof(event.target.value)}
              />
            </Label>
            <Label className="flex items-center gap-2">
              <Checkbox
                checked={shopHeld}
                onCheckedChange={(value) => setShopHeld(value === true)}
              />
              تحققت من وجود كامل الدفعة فعلياً في المكتبة وأن الناقل لم يستلمها
            </Label>
            <SubmitButton
              type="button"
              variant="outline"
              pending={action.pending}
              disabled={!shopHeld || proof.trim().length < 3}
              onClick={() =>
                void action.run(
                  "cancelExecution",
                  {
                    ...identity,
                    reason: proof,
                    physicalHeldConfirmed: shopHeld,
                  },
                  cancelExecution.mutateAsync,
                )
              }
            >
              إلغاء قبل الاستلام مع حفظ العهدة والتاريخ
            </SubmitButton>
            <p className="text-xs text-muted-foreground">
              بعد استلام الناقل تُعلن العودة ثم يُثبت الاستلام والفحص. الإلغاء
              لا يعيد مخزوناً ولا يصرف بديلاً ثانياً.
            </p>
          </div>
        )}
      {execution.status === "DISPATCHED" && canConfirm && (
        <>
          <AppSelect
            aria-label="نتيجة المحاولة"
            value={result}
            onValueChange={(value) => setResult(value as typeof result)}
          >
            <option value="DELIVERED">تسليم مثبت</option>
            <option value="FAILED">فشل / رفض — تبقى العهدة</option>
            <option value="RETURNED">استلام العهدة العائدة فعلياً</option>
          </AppSelect>
          <Label>
            الإثبات
            <Textarea
              value={proof}
              onChange={(event) => setProof(event.target.value)}
            />
          </Label>
          {canDeclareReturn && !execution.returnDeclaredAt && (
            <SubmitButton
              type="button"
              variant="outline"
              pending={action.pending}
              disabled={proof.trim().length < 3}
              onClick={() =>
                void action.run(
                  "declareReturn",
                  { ...identity, reason: proof },
                  declareReturn.mutateAsync,
                )
              }
            >
              إعلان رجوع العهدة دون إثبات استلامها
            </SubmitButton>
          )}
          {execution.returnDeclaredAt && (
            <p className="text-sm text-muted-foreground">
              الرجوع معلن. الخطوة التالية استلام العهدة وفحصها فعلياً؛ لا يتغير
              حق العميل أو المخزون بالإعلان.
            </p>
          )}
          {result !== "DELIVERED" && (
            <Label className="flex items-center gap-2">
              <Checkbox
                checked={feeEarned}
                onCheckedChange={(value) => setFeeEarned(value === true)}
              />
              تحققت من استحقاق الناقل للأجرة رغم عدم التسليم
            </Label>
          )}
          <SubmitButton
            type="button"
            pending={action.pending}
            disabled={proof.trim().length < 3}
            onClick={async () => {
              if (
                await confirm({
                  title: "تثبيت نتيجة التوصيل",
                  description:
                    result === "RETURNED"
                      ? "أكد الاستلام والفحص الفعلي للعهدة. لا ينشأ مرتجع بيع أو مخزون مملوك تلقائياً."
                      : "تحقق من دليل النتيجة. فشل التوصيل يبقي العهدة وحق الصرف مستهلكاً.",
                  variant: "warning",
                })
              )
                await action.run(
                  "confirm",
                  { ...identity, result, proof, feeEarned },
                  confirmDelivery.mutateAsync,
                );
            }}
          >
            <RotateCcw className="size-4" />
            تثبيت النتيجة
          </SubmitButton>
        </>
      )}
      {canPay && D(execution.feeLedger.due).gt(0) && (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <Label>
              مصدر النقد
              <AppSelect
                value={cashBucket}
                onValueChange={(value) => setBucket(value as typeof cashBucket)}
              >
                <option value="DRAWER">درج وردية مفتوحة</option>
                <option value="TREASURY">خزينة الفرع</option>
              </AppSelect>
            </Label>
            {cashBucket === "DRAWER" && (
              <Label>
                رقم الوردية
                <MoneyInput decimals={0} value={shiftId} onChange={setShift} />
              </Label>
            )}
            <Label>
              الصرف الفعلي
              <MoneyInput value={payAmount} onChange={setPayAmount} />
            </Label>
          </div>
          <SubmitButton
            type="button"
            pending={action.pending}
            disabled={!payAmount || (cashBucket === "DRAWER" && !shiftId)}
            onClick={async () => {
              if (
                await confirm({
                  title: "صرف استحقاق الناقل",
                  description:
                    "صرف نقدي فعلي من المصدر المحدد لتسديد الالتزام السابق دون مصروف ثانٍ.",
                  variant: "warning",
                })
              )
                await action.run(
                  "payFee",
                  {
                    ...identity,
                    cashBucket,
                    shiftId:
                      cashBucket === "DRAWER" ? Number(shiftId) : undefined,
                    amount: payAmount,
                  },
                  payFee.mutateAsync,
                );
            }}
          >
            صرف الأجرة بسند
          </SubmitButton>
        </>
      )}
      {(execution.deliveryProof || execution.returnEvidence) && (
        <p className="whitespace-pre-wrap text-sm">
          الإثبات: {execution.deliveryProof ?? execution.returnEvidence}
        </p>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      )}
    </div>
  );
}
