import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ClipboardList,
  FilePlus2,
  Pencil,
  Send,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { DataTable } from "@/components/data-table/DataTable";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PurchaseCancellationDialog } from "@/components/purchases/PurchaseCancellationDialog";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { estimatedPurchaseUnitPrice } from "@/components/invoice/purchasePrice";

type RequisitionRow = RouterOutputs["purchases"]["requisitions"][number];
type RequisitionDetail = RouterOutputs["purchases"]["requisition"];
type CatalogRow = RouterOutputs["catalog"]["forPurchase"][number];

type DraftItem = {
  variantId: number;
  productUnitId: number;
  requestedBaseQuantity: number;
  estimatedUnitPrice: string;
  preferredSupplierId: number | null;
  justification: string;
};

type Draft = {
  branchId: number;
  neededBy: string;
  purpose: string;
  costCenter: string;
  priority: "LOW" | "NORMAL" | "URGENT";
  items: DraftItem[];
};

const EMPTY_DRAFT: Draft = {
  branchId: 0,
  neededBy: "",
  purpose: "",
  costCenter: "",
  priority: "NORMAL",
  items: [],
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "مسودة",
  SUBMITTED: "مرسل للاعتماد",
  APPROVED: "معتمد",
  PARTIALLY_ORDERED: "مرتبط جزئياً بأمر",
  FULLY_ORDERED: "مرتبط بالكامل بأمر",
  FULFILLED: "مكتمل الاستلام",
  REJECTED: "مرفوض",
  CANCELLED: "ملغى",
};

const PRIORITY_LABEL: Record<string, string> = {
  LOW: "منخفضة",
  NORMAL: "عادية",
  URGENT: "عاجلة",
};

function dateValue(value: unknown) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function detailToDraft(detail: RequisitionDetail): Draft {
  return {
    branchId: Number(detail.branchId),
    neededBy: dateValue(detail.neededBy),
    purpose: detail.purpose,
    costCenter: detail.costCenter ?? "",
    priority: detail.priority,
    items: detail.items.map((item) => ({
      variantId: Number(item.variantId),
      productUnitId: Number(item.productUnitId),
      requestedBaseQuantity: Number(item.requestedBaseQuantity),
      estimatedUnitPrice: item.estimatedUnitPrice ?? "",
      preferredSupplierId:
        item.preferredSupplierId == null
          ? null
          : Number(item.preferredSupplierId),
      justification: item.justification,
    })),
  };
}

export default function PurchaseRequisitions() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const suppliers = trpc.suppliers.list.useQuery();
  const [filterBranchId, setFilterBranchId] = useState(0);
  useEffect(() => {
    if (filterBranchId > 0) return;
    const ownBranch = me.data?.branchId == null ? 0 : Number(me.data.branchId);
    const availableBranch = ownBranch || Number(branches.data?.[0]?.id ?? 0);
    if (availableBranch > 0) setFilterBranchId(availableBranch);
  }, [filterBranchId, me.data?.branchId, branches.data]);
  const list = trpc.purchases.requisitions.useQuery(
    { branchId: filterBranchId || undefined, limit: 200 },
    { enabled: filterBranchId > 0 },
  );
  const pendingControls = trpc.purchases.pendingControls.useQuery({
    limit: 200,
  });
  const pendingRequisitionIds = useMemo(
    () =>
      new Set(
        (pendingControls.data?.rows ?? [])
          .filter((row) => row.documentType === "REQUISITION")
          .map((row) => Number(row.requisitionId)),
      ),
    [pendingControls.data],
  );
  const controlStateUnavailable =
    pendingControls.isLoading || pendingControls.isError;
  const [editorId, setEditorId] = useState<number | "NEW" | null>(null);
  const detail = trpc.purchases.requisition.useQuery(
    { requisitionId: typeof editorId === "number" ? editorId : 1 },
    { enabled: typeof editorId === "number" },
  );
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const hydratedId = useRef<number | null>(null);
  const requestKeys = useRef(new Map<string, string>());
  const [cancelTarget, setCancelTarget] = useState<RequisitionRow | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  function stableKey(kind: string, id: number, version: number) {
    const slot = `${kind}:${id}:${version}`;
    const found = requestKeys.current.get(slot);
    if (found) return found;
    const next = `purchase-requisition-${kind}-${id}-${version}-${crypto.randomUUID()}`;
    requestKeys.current.set(slot, next);
    return next;
  }

  useEffect(() => {
    if (editorId === "NEW") {
      const ownBranch =
        me.data?.branchId == null ? 0 : Number(me.data.branchId);
      const availableBranch =
        ownBranch || filterBranchId || Number(branches.data?.[0]?.id ?? 0);
      setDraft({ ...EMPTY_DRAFT, branchId: availableBranch });
      hydratedId.current = null;
    }
  }, [editorId, me.data?.branchId, branches.data, filterBranchId]);

  useEffect(() => {
    if (
      typeof editorId !== "number" ||
      !detail.data ||
      hydratedId.current === editorId
    )
      return;
    hydratedId.current = editorId;
    setDraft(detailToDraft(detail.data));
  }, [editorId, detail.data]);

  const catalog = trpc.catalog.forPurchase.useQuery(
    { branchId: draft.branchId, query: "", limit: 500 },
    { enabled: editorId != null && draft.branchId > 0 },
  );
  const catalogByUnit = useMemo(
    () =>
      new Map(
        (catalog.data ?? []).map((row) => [Number(row.productUnitId), row]),
      ),
    [catalog.data],
  );
  const [productUnitId, setProductUnitId] = useState("");

  const invalidate = async () => {
    await Promise.all([
      utils.purchases.requisitions.invalidate(),
      utils.purchases.pendingControls.invalidate(),
      utils.purchases.requisition.invalidate(),
    ]);
  };
  const closeEditor = () => {
    setEditorId(null);
    setProductUnitId("");
    hydratedId.current = null;
  };

  const create = trpc.purchases.createRequisition.useMutation({
    onSuccess: async () => {
      notify.ok("حُفظ طلب الشراء مسودة");
      closeEditor();
      await invalidate();
    },
    onError: (error) => notify.err(error),
  });
  const update = trpc.purchases.updateRequisition.useMutation({
    onSuccess: async () => {
      notify.ok("حُفظت تعديلات طلب الشراء كمسودة جديدة النسخة");
      closeEditor();
      await invalidate();
    },
    onError: (error) => notify.err(error),
  });
  const submit = trpc.purchases.submitRequisition.useMutation({
    onSuccess: async () => {
      notify.ok("أُرسل طلب الشراء للاعتماد — لم يُعتمد بعد");
      await invalidate();
    },
    onError: (error) => notify.err(error),
  });
  const cancel = trpc.purchases.requestRequisitionCancel.useMutation({
    onSuccess: async () => {
      notify.ok("أُرسل طلب الإلغاء صفري الأثر — ينتظر مراجعاً مستقلاً");
      setCancelTarget(null);
      setCancelReason("");
      await invalidate();
    },
    onError: (error) => notify.err(error),
  });

  function validateDraft() {
    if (draft.branchId <= 0) return "اختر الفرع.";
    if (draft.purpose.trim().length < 3)
      return "اكتب غرض طلب الشراء (3 محارف على الأقل).";
    if (!draft.items.length) return "أضف صنفاً واحداً على الأقل.";
    if (
      draft.items.some(
        (item) =>
          item.requestedBaseQuantity <= 0 ||
          !Number.isInteger(item.requestedBaseQuantity),
      )
    ) {
      return "الكميات المطلوبة يجب أن تكون أعداداً صحيحة موجبة بالوحدة الأساس.";
    }
    if (draft.items.some((item) => item.justification.trim().length < 3)) {
      return "اكتب مبرر كل بند (3 محارف على الأقل).";
    }
    return null;
  }

  function saveDraft() {
    const error = validateDraft();
    if (error) return notify.warn(error);
    const payload = {
      branchId: draft.branchId,
      neededBy: draft.neededBy || null,
      purpose: draft.purpose.trim(),
      costCenter: draft.costCenter.trim() || null,
      priority: draft.priority,
      items: draft.items.map((item) => ({
        ...item,
        estimatedUnitPrice: item.estimatedUnitPrice.trim() || null,
        preferredSupplierId: item.preferredSupplierId,
        justification: item.justification.trim(),
      })),
    };
    if (editorId === "NEW") {
      create.mutate({
        ...payload,
        clientRequestId: `purchase-requisition-create-${crypto.randomUUID()}`,
      });
    } else if (typeof editorId === "number" && detail.data) {
      update.mutate({
        ...payload,
        requisitionId: editorId,
        expectedVersion: Number(detail.data.version),
      });
    }
  }

  async function submitForApproval(row: RequisitionRow) {
    const ok = await confirm({
      variant: "info",
      title: "إرسال طلب الشراء للاعتماد",
      description: `سيُرسل ${row.requisitionNumber} إلى مراجع مستقل، ولن يُعتمد بمجرد الإرسال.`,
      confirmText: "إرسال للاعتماد",
      cancelText: "تراجع",
      requireText: row.requisitionNumber,
      requireTextLabel: `اكتب ${row.requisitionNumber}`,
    });
    if (!ok) return;
    submit.mutate({
      requisitionId: Number(row.id),
      expectedVersion: Number(row.version),
      requestKey: stableKey("submit", Number(row.id), Number(row.version)),
      reason: `إرسال طلب الشراء ${row.requisitionNumber} بعد مراجعة الغرض والكميات المطلوبة`,
    });
  }

  function requestCancellation(row: RequisitionRow) {
    setCancelReason("");
    setCancelTarget(row);
  }

  function submitCancellation() {
    if (!cancelTarget || cancelReason.trim().length < 3) return;
    cancel.mutate({
      requisitionId: Number(cancelTarget.id),
      expectedVersion: Number(cancelTarget.version),
      requestKey: stableKey(
        "cancel",
        Number(cancelTarget.id),
        Number(cancelTarget.version),
      ),
      reason: cancelReason.trim(),
    });
  }

  const columns = useMemo<ColumnDef<RequisitionRow>[]>(
    () => [
      { header: "رقم الطلب", accessorKey: "requisitionNumber" },
      { header: "الغرض", accessorKey: "purpose" },
      {
        header: "الأولوية",
        accessorKey: "priority",
        cell: ({ row }) =>
          PRIORITY_LABEL[row.original.priority] ?? row.original.priority,
      },
      {
        header: "الحالة",
        accessorKey: "status",
        cell: ({ row }) => (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
            {STATUS_LABEL[row.original.status] ?? row.original.status}
          </span>
        ),
      },
      {
        header: "مطلوب في",
        accessorKey: "neededBy",
        cell: ({ row }) =>
          row.original.neededBy ? fmtDate(row.original.neededBy) : "—",
      },
      {
        id: "actions",
        header: "الإجراءات",
        cell: ({ row }) => {
          const value = row.original;
          const editable =
            value.status === "DRAFT" || value.status === "REJECTED";
          const cancellable = [
            "DRAFT",
            "SUBMITTED",
            "APPROVED",
            "PARTIALLY_ORDERED",
          ].includes(value.status);
          const convertible = ["APPROVED", "PARTIALLY_ORDERED"].includes(
            value.status,
          );
          const hasPendingControl = pendingRequisitionIds.has(Number(value.id));
          return (
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  hydratedId.current = null;
                  setEditorId(Number(value.id));
                }}
              >
                <Pencil aria-hidden className="size-4" />{" "}
                {editable ? "تعديل" : "عرض"}
              </Button>
              {value.status === "DRAFT" ? (
                <Button
                  size="sm"
                  onClick={() => void submitForApproval(value)}
                  disabled={
                    submit.isPending ||
                    hasPendingControl ||
                    controlStateUnavailable
                  }
                  title={
                    controlStateUnavailable
                      ? "تعذّر التحقق من الطلبات المعلّقة"
                      : hasPendingControl
                        ? "يوجد طلب قرار معلّق"
                        : undefined
                  }
                >
                  <Send aria-hidden className="size-4" /> إرسال للاعتماد
                </Button>
              ) : null}
              {convertible ? (
                <Button size="sm" variant="outline" asChild>
                  <a href={`/purchases/new?requisitionId=${Number(value.id)}`}>
                    <ShoppingCart aria-hidden className="size-4" /> تحويل لأمر
                    شراء
                  </a>
                </Button>
              ) : null}
              {cancellable ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => void requestCancellation(value)}
                  disabled={
                    cancel.isPending ||
                    hasPendingControl ||
                    controlStateUnavailable
                  }
                  title={
                    controlStateUnavailable
                      ? "تعذّر التحقق من الطلبات المعلّقة"
                      : hasPendingControl
                        ? "يوجد طلب قرار معلّق"
                        : undefined
                  }
                >
                  <Trash2 aria-hidden className="size-4" /> طلب إلغاء
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [
      cancel.isPending,
      submit.isPending,
      pendingRequisitionIds,
      controlStateUnavailable,
    ],
  );

  const editingAllowed =
    editorId === "NEW" ||
    detail.data?.status === "DRAFT" ||
    detail.data?.status === "REJECTED";
  const saving = create.isPending || update.isPending;

  function updateItem(index: number, patch: Partial<DraftItem>) {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    }));
  }

  function addCatalogItem() {
    const selected = catalogByUnit.get(Number(productUnitId));
    if (!selected) return;
    if (
      draft.items.some(
        (item) => item.productUnitId === Number(selected.productUnitId),
      )
    ) {
      return notify.warn("الصنف والوحدة مضافان مسبقاً.");
    }
    setDraft((current) => ({
      ...current,
      items: [
        ...current.items,
        {
          variantId: Number(selected.variantId),
          productUnitId: Number(selected.productUnitId),
          requestedBaseQuantity: Number(selected.conversionFactor || 1),
          // Codex #980 (٤/٩/٢٦) — Finding 4: كان يُهيَّأ بـ`selected.costPriceBase` وحده ⇒ درزنٌ
          // (معامل ١٢) بتكلفة قطعةٍ ١٥٠ يُخزَّن سعرُ وحدةٍ تقديريّاً ١٥٠ لا ١٨٠٠. عند تحويل الطلب
          // إلى أمر شراء (`PurchaseNew` مسار الاستحضار)، تُنقَل هذه القيمةُ خامّاً إلى `unitPrice`
          // ⇒ الخادم يقسمها على المعامل ⇒ `costPerBase = 12.50` يسمّم WAVG. المساعد المشترك
          // يُصلح المصدر: `price = costBase × factor` (الطلب بالدينار — لا عمود عملة عليه).
          estimatedUnitPrice: estimatedPurchaseUnitPrice(
            selected.costPriceBase,
            String(selected.conversionFactor ?? "1"),
          ),
          preferredSupplierId: null,
          justification: "حاجة تشغيلية موثقة",
        },
      ],
    }));
    setProductUnitId("");
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="طلبات الشراء الداخلية"
        icon={<ClipboardList aria-hidden className="size-5 text-primary" />}
        description="الحاجة الداخلية تسبق أمر المورد؛ الإنشاء والإرسال والاعتماد والإلغاء مراحل منفصلة موثّقة."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {me.data?.role === "admin" ? (
              <AppSelect
                aria-label="فرع طلبات الشراء"
                value={filterBranchId ? String(filterBranchId) : ""}
                onValueChange={(value) => setFilterBranchId(Number(value))}
              >
                {(branches.data ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </AppSelect>
            ) : null}
            <Button
              onClick={() => setEditorId("NEW")}
              disabled={filterBranchId <= 0}
            >
              <FilePlus2 aria-hidden className="size-4" /> طلب شراء جديد
            </Button>
          </div>
        }
      />
      {list.error ? (
        <ErrorState
          message={`تعذّر تحميل طلبات الشراء: ${list.error.message}`}
          onRetry={() => void list.refetch()}
        />
      ) : (
        <DataTable
          columns={columns}
          data={list.data ?? []}
          loading={list.isLoading}
          searchPlaceholder="بحث برقم الطلب أو الغرض"
          emptyText="لا توجد طلبات شراء في نطاقك."
        />
      )}

      <Dialog
        open={editorId != null}
        onOpenChange={(open) => {
          if (!open && !saving) closeEditor();
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editorId === "NEW"
                ? "إنشاء طلب شراء"
                : `طلب الشراء ${detail.data?.requisitionNumber ?? ""}`}
            </DialogTitle>
            <DialogDescription>
              أدخل الحاجة والكميات بالوحدة الأساس. الحفظ مسودة فقط؛ الإرسال
              والاعتماد خطوتان منفصلتان.
            </DialogDescription>
          </DialogHeader>
          {detail.isLoading && typeof editorId === "number" ? (
            <LoadingState message={ACTION_LABELS.loading} />
          ) : null}
          {detail.error ? (
            <ErrorState
              message={detail.error.message}
              onRetry={() => void detail.refetch()}
            />
          ) : null}
          {(editorId === "NEW" || detail.data) && !detail.error ? (
            <div className="space-y-4">
              {!editingAllowed ? (
                <div
                  role="note"
                  className="rounded-md border bg-muted/30 p-3 text-sm"
                >
                  هذا الطلب للعرض فقط في حالته الحالية. عند رفض الاعتماد يعود
                  قابلاً للتعديل، أما المعتمد فيُحوّل إلى أمر شراء.
                </div>
              ) : null}
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="requisition-branch">الفرع</Label>
                  <AppSelect
                    id="requisition-branch"
                    value={draft.branchId ? String(draft.branchId) : ""}
                    disabled={!editingAllowed || typeof editorId === "number"}
                    onValueChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        branchId: Number(value),
                        items: [],
                      }))
                    }
                  >
                    <option value="">اختر الفرع</option>
                    {(branches.data ?? []).map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </AppSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="requisition-needed-by">تاريخ الحاجة</Label>
                  <Input
                    id="requisition-needed-by"
                    type="date"
                    value={draft.neededBy}
                    disabled={!editingAllowed}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        neededBy: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-1 md:col-span-2">
                  <Label htmlFor="requisition-purpose">الغرض</Label>
                  <Textarea
                    id="requisition-purpose"
                    value={draft.purpose}
                    maxLength={500}
                    disabled={!editingAllowed}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        purpose: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="requisition-cost-center">مركز التكلفة</Label>
                  <Input
                    id="requisition-cost-center"
                    value={draft.costCenter}
                    maxLength={120}
                    disabled={!editingAllowed}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        costCenter: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="requisition-priority">الأولوية</Label>
                  <AppSelect
                    id="requisition-priority"
                    value={draft.priority}
                    disabled={!editingAllowed}
                    onValueChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        priority: value as Draft["priority"],
                      }))
                    }
                  >
                    <option value="LOW">منخفضة</option>
                    <option value="NORMAL">عادية</option>
                    <option value="URGENT">عاجلة</option>
                  </AppSelect>
                </div>
              </div>

              {editingAllowed ? (
                <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/20 p-3">
                  <div className="min-w-64 flex-1 space-y-1">
                    <Label htmlFor="requisition-product">إضافة صنف ووحدة</Label>
                    <AppSelect
                      id="requisition-product"
                      value={productUnitId}
                      onValueChange={setProductUnitId}
                    >
                      <option value="">اختر من كتالوج الفرع</option>
                      {(catalog.data ?? []).map((row) => (
                        <option
                          key={row.productUnitId}
                          value={row.productUnitId}
                        >
                          {row.productName}
                          {row.variantName
                            ? ` — ${row.variantName}`
                            : ""} · {row.unitName}
                        </option>
                      ))}
                    </AppSelect>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!productUnitId}
                    onClick={addCatalogItem}
                  >
                    إضافة
                  </Button>
                </div>
              ) : null}

              <div className="space-y-2">
                {draft.items.map((item, index) => {
                  const catalogRow = catalogByUnit.get(item.productUnitId) as
                    | CatalogRow
                    | undefined;
                  return (
                    <section
                      key={`${item.productUnitId}:${index}`}
                      className="rounded-md border p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold">
                          {catalogRow
                            ? `${catalogRow.productName}${catalogRow.variantName ? ` — ${catalogRow.variantName}` : ""} · ${catalogRow.unitName}`
                            : `متغير #${item.variantId} · وحدة #${item.productUnitId}`}
                        </div>
                        {editingAllowed ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setDraft((current) => ({
                                ...current,
                                items: current.items.filter(
                                  (_, i) => i !== index,
                                ),
                              }))
                            }
                          >
                            <Trash2 aria-hidden className="size-4" /> حذف
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-4">
                        <div className="space-y-1">
                          <Label>الكمية بالأساس</Label>
                          <Input
                            type="number"
                            min={1}
                            step={1}
                            value={item.requestedBaseQuantity}
                            disabled={!editingAllowed}
                            onChange={(event) =>
                              updateItem(index, {
                                requestedBaseQuantity: Number(
                                  event.target.value,
                                ),
                              })
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <Label>السعر التقديري</Label>
                          <MoneyInput
                            value={item.estimatedUnitPrice}
                            disabled={!editingAllowed}
                            onChange={(value) =>
                              updateItem(index, { estimatedUnitPrice: value })
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <Label>المورد المفضّل</Label>
                          <AppSelect
                            value={
                              item.preferredSupplierId
                                ? String(item.preferredSupplierId)
                                : ""
                            }
                            disabled={!editingAllowed}
                            onValueChange={(value) =>
                              updateItem(index, {
                                preferredSupplierId: value
                                  ? Number(value)
                                  : null,
                              })
                            }
                          >
                            <option value="">بلا تفضيل</option>
                            {(suppliers.data ?? []).map((supplier) => (
                              <option key={supplier.id} value={supplier.id}>
                                {supplier.name}
                              </option>
                            ))}
                          </AppSelect>
                        </div>
                        <div className="space-y-1">
                          <Label>مبرر البند</Label>
                          <Input
                            value={item.justification}
                            maxLength={500}
                            disabled={!editingAllowed}
                            onChange={(event) =>
                              updateItem(index, {
                                justification: event.target.value,
                              })
                            }
                          />
                        </div>
                      </div>
                    </section>
                  );
                })}
                {!draft.items.length ? (
                  <div className="rounded-md border p-5 text-center text-sm text-muted-foreground">
                    لم تُضف أصنافاً بعد.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeEditor} disabled={saving}>
              إغلاق
            </Button>
            {editingAllowed ? (
              <Button onClick={saveDraft} disabled={saving}>
                {saving ? ACTION_LABELS.saving : "حفظ المسودة"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PurchaseCancellationDialog
        open={cancelTarget != null}
        reference={cancelTarget?.requisitionNumber ?? "طلب الشراء"}
        description="الطلب صفري الأثر: تبقى حالة طلب الشراء وكمياته كما هي حتى قرار مستخدم مستقل."
        reason={cancelReason}
        pending={cancel.isPending}
        onReasonChange={setCancelReason}
        onClose={() => {
          setCancelTarget(null);
          setCancelReason("");
        }}
        onSubmit={submitCancellation}
      />
    </div>
  );
}
