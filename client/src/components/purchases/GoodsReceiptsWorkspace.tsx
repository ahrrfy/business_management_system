import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  FileCheck2,
  PackageCheck,
  RotateCcw,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { DataTable } from "@/components/data-table/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
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
import { fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { ACTION_LABELS } from "@shared/actionLabels";

type GoodsReceiptRow = RouterOutputs["goodsReceipts"]["list"][number];
type GoodsReceiptDetail = RouterOutputs["goodsReceipts"]["get"];
type PendingReversal = RouterOutputs["goodsReceipts"]["pendingReversals"][number];
type PurchaseOrderRow = RouterOutputs["purchases"]["list"][number];

type ReceiptLineDraft = {
  purchaseOrderItemId: number;
  acceptedBaseQuantity: number;
  rejectedBaseQuantity: number;
  rejectionReason: string;
};

type ReversalLineDraft = {
  goodsReceiptItemId: number;
  baseQuantity: number;
  reason: string;
};

const RECEIPT_STATUS: Record<string, string> = {
  POSTED: "مرحّل للمخزون",
  PARTIALLY_REVERSED: "معكوس جزئياً",
  REVERSED: "معكوس بالكامل",
};

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "POSTED") return "default";
  if (status === "REVERSED") return "destructive";
  return "secondary";
}

function permissionsOverride(value: unknown) {
  return (value as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)
    ?.permissionsOverride ?? null;
}

function positiveInteger(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function GoodsReceiptsWorkspace() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState(0);
  const [selectedReceiptId, setSelectedReceiptId] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createOrderId, setCreateOrderId] = useState(0);
  const [supplierDeliveryNote, setSupplierDeliveryNote] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [receiptNotes, setReceiptNotes] = useState("");
  const [receiptLines, setReceiptLines] = useState<ReceiptLineDraft[]>([]);
  const createKey = useRef(crypto.randomUUID());
  const hydratedOrderId = useRef(0);

  const [reversalOpen, setReversalOpen] = useState(false);
  const [reversalReason, setReversalReason] = useState("");
  const [reversalLines, setReversalLines] = useState<ReversalLineDraft[]>([]);
  const reversalKey = useRef(crypto.randomUUID());
  const [decisionTarget, setDecisionTarget] = useState<PendingReversal | null>(null);
  const [decisionAction, setDecisionAction] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [decisionReason, setDecisionReason] = useState("");
  const decisionKeys = useRef(new Map<number, string>());

  useEffect(() => {
    if (branchId > 0) return;
    if (me.data?.role === "admin") return;
    if (me.data?.branchId != null && Number(me.data.branchId) > 0) {
      setBranchId(Number(me.data.branchId));
    }
  }, [branchId, me.data?.branchId, me.data?.role]);

  const role = me.data?.role ?? "";
  const override = permissionsOverride(me.data) as PermissionMap | null;
  const canReceive = !!role && moduleAccessAllowed(
    role as RoleKey,
    override,
    "purchases",
    "FULL",
    ["warehouse", "manager", "purchasing"],
  );
  const canReview = !!role && moduleAccessAllowed(
    role as RoleKey,
    override,
    "purchases",
    "FULL",
    ["manager", "purchasing"],
  );

  const receipts = trpc.goodsReceipts.list.useQuery(
    { branchId, limit: 200 },
    { enabled: branchId > 0 },
  );
  const pending = trpc.goodsReceipts.pendingReversals.useQuery(
    { branchId },
    { enabled: branchId > 0 && canReview },
  );
  const confirmedOrders = trpc.purchases.list.useQuery(
    { branchId, status: "CONFIRMED", limit: 500, offset: 0 },
    { enabled: branchId > 0 && createOpen && canReceive },
  );
  const createOrder = trpc.purchases.get.useQuery(
    { purchaseOrderId: createOrderId || 1 },
    { enabled: createOpen && createOrderId > 0 },
  );
  const selectedReceipt = trpc.goodsReceipts.get.useQuery(
    { goodsReceiptId: selectedReceiptId || 1 },
    { enabled: selectedReceiptId > 0 },
  );

  useEffect(() => {
    const order = createOrder.data;
    if (!order || hydratedOrderId.current === Number(order.id)) return;
    hydratedOrderId.current = Number(order.id);
    setReceiptLines(
      order.items.map((item) => ({
        purchaseOrderItemId: Number(item.id),
        acceptedBaseQuantity: 0,
        rejectedBaseQuantity: 0,
        rejectionReason: "",
      })),
    );
  }, [createOrder.data]);

  async function refreshAll() {
    await Promise.all([
      utils.goodsReceipts.list.invalidate(),
      utils.goodsReceipts.pendingReversals.invalidate(),
      utils.goodsReceipts.get.invalidate(),
      utils.purchases.list.invalidate(),
      utils.purchases.get.invalidate(),
    ]);
  }

  function resetCreate() {
    setCreateOpen(false);
    setCreateOrderId(0);
    setSupplierDeliveryNote("");
    setReceivedAt("");
    setReceiptNotes("");
    setReceiptLines([]);
    hydratedOrderId.current = 0;
    createKey.current = crypto.randomUUID();
  }

  const createReceipt = trpc.goodsReceipts.create.useMutation({
    onSuccess: async (result) => {
      notify.ok("سُجّل إذن الاستلام", `${result.receiptNumber} رُحّل للمخزون وGRNI في معاملة واحدة.`);
      resetCreate();
      await refreshAll();
    },
    onError: (error) => notify.err(error),
  });
  const requestReversal = trpc.goodsReceipts.requestReversal.useMutation({
    onSuccess: async () => {
      notify.ok("أُرسل طلب العكس", "لم يتغير المخزون أو إذن الاستلام؛ ينتظر الطلب مراجعاً مستقلاً.");
      setReversalOpen(false);
      setReversalReason("");
      setReversalLines([]);
      reversalKey.current = crypto.randomUUID();
      await refreshAll();
    },
    onError: (error) => notify.err(error),
  });
  const decideReversal = trpc.goodsReceipts.decideReversal.useMutation({
    onSuccess: async (result) => {
      notify.ok(
        result.status === "APPROVED" ? "نُفّذ عكس الاستلام" : "حُسم طلب العكس",
        result.status === "APPROVED"
          ? "أُنشئ مستند عكس وحركة مخزون وقيد GRNI ذرّياً."
          : `الحالة النهائية: ${result.status}`,
      );
      setDecisionTarget(null);
      setDecisionReason("");
      await refreshAll();
    },
    onError: (error) => notify.err(error),
  });

  function submitReceipt() {
    const order = createOrder.data;
    if (!order || order.approvedRevisionId == null) return notify.warn("اختر أمر شراء له مراجعة معتمدة.");
    const lines = receiptLines.filter((line) => line.acceptedBaseQuantity + line.rejectedBaseQuantity > 0);
    if (!lines.length) return notify.warn("أدخل كمية مقبولة أو مرفوضة لبند واحد على الأقل.");
    for (const line of lines) {
      const orderLine = order.items.find((item) => Number(item.id) === line.purchaseOrderItemId);
      const remaining = Number(orderLine?.baseQuantity ?? 0) - Number(orderLine?.receivedBaseQuantity ?? 0);
      if (line.acceptedBaseQuantity + line.rejectedBaseQuantity > remaining) {
        return notify.warn("إحدى الكميات تتجاوز المتبقي في المراجعة المعتمدة.");
      }
      if (line.rejectedBaseQuantity > 0 && line.rejectionReason.trim().length < 3) {
        return notify.warn("اكتب سبب رفض الكمية المرفوضة.");
      }
    }
    createReceipt.mutate({
      purchaseOrderId: Number(order.id),
      purchaseOrderRevisionId: Number(order.approvedRevisionId),
      expectedOrderVersion: Number(order.version),
      clientRequestId: createKey.current,
      supplierDeliveryNote: supplierDeliveryNote.trim() || null,
      receivedAt: receivedAt ? new Date(receivedAt) : undefined,
      notes: receiptNotes.trim() || null,
      lines: lines.map((line) => ({
        ...line,
        rejectionReason: line.rejectionReason.trim() || null,
      })),
    });
  }

  function openReversal(detail: GoodsReceiptDetail) {
    const available = detail.items
      .map((item) => ({
        goodsReceiptItemId: Number(item.id),
        baseQuantity: 0,
        reason: "",
        available:
          Number(item.acceptedBaseQuantity) -
          Number(item.reversedBaseQuantity) -
          Number(item.returnedBaseQuantity),
      }))
      .filter((line) => line.available > 0);
    setReversalLines(available.map(({ available: _available, ...line }) => line));
    setReversalReason("");
    reversalKey.current = crypto.randomUUID();
    setReversalOpen(true);
  }

  function submitReversal() {
    const detail = selectedReceipt.data;
    if (!detail || reversalReason.trim().length < 3) return notify.warn("اكتب سبب العكس التشغيلي.");
    const lines = reversalLines.filter((line) => line.baseQuantity > 0);
    if (!lines.length) return notify.warn("حدد كمية عكس موجبة في بند واحد على الأقل.");
    for (const line of lines) {
      const item = detail.items.find((candidate) => Number(candidate.id) === line.goodsReceiptItemId);
      const available = Number(item?.acceptedBaseQuantity ?? 0) - Number(item?.reversedBaseQuantity ?? 0) - Number(item?.returnedBaseQuantity ?? 0);
      if (line.baseQuantity > available) return notify.warn("كمية العكس تتجاوز المقبول المتاح.");
    }
    requestReversal.mutate({
      goodsReceiptId: Number(detail.receipt.id),
      expectedReceiptVersion: Number(detail.receipt.version),
      requestKey: reversalKey.current,
      reason: reversalReason.trim(),
      lines: lines.map((line) => ({ ...line, reason: line.reason.trim() || null })),
    });
  }

  function submitDecision() {
    if (!decisionTarget || decisionReason.trim().length < 3) return notify.warn("اكتب سبب قرار المراجعة.");
    let key = decisionKeys.current.get(Number(decisionTarget.id));
    if (!key) {
      key = crypto.randomUUID();
      decisionKeys.current.set(Number(decisionTarget.id), key);
    }
    decideReversal.mutate({
      requestId: Number(decisionTarget.id),
      decisionKey: key,
      action: decisionAction,
      reviewReason: decisionReason.trim(),
    });
  }

  const receiptColumns = useMemo<ColumnDef<GoodsReceiptRow>[]>(
    () => [
      { header: "رقم إذن الاستلام", accessorKey: "receiptNumber" },
      { header: "أمر الشراء", accessorKey: "purchaseOrderId", cell: ({ row }) => `#${Number(row.original.purchaseOrderId)}` },
      { header: "المورد", accessorKey: "supplierId", cell: ({ row }) => `#${Number(row.original.supplierId)}` },
      { header: "وقت الاستلام", accessorKey: "receivedAt", cell: ({ row }) => fmtDateTime(row.original.receivedAt) },
      { header: "القيمة", accessorKey: "totalAmount", cell: ({ row }) => `${fmtAr(row.original.totalAmount)} د.ع` },
      {
        header: "الحالة",
        accessorKey: "status",
        cell: ({ row }) => <Badge variant={statusVariant(row.original.status)}>{RECEIPT_STATUS[row.original.status] ?? row.original.status}</Badge>,
      },
      {
        id: "actions",
        header: "الإجراءات",
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => setSelectedReceiptId(Number(row.original.id))}>
            <FileCheck2 aria-hidden className="size-4" /> عرض الدليل
          </Button>
        ),
      },
    ],
    [],
  );

  const pendingColumns = useMemo<ColumnDef<PendingReversal>[]>(
    () => [
      { header: "الطلب", accessorKey: "id", cell: ({ row }) => `#${Number(row.original.id)}` },
      { header: "إذن الاستلام", accessorKey: "goodsReceiptId", cell: ({ row }) => `#${Number(row.original.goodsReceiptId)}` },
      { header: "السبب", accessorKey: "reason" },
      { header: "طالب العكس", accessorKey: "requestedBy", cell: ({ row }) => `مستخدم #${Number(row.original.requestedBy)}` },
      { header: "وقت الطلب", accessorKey: "requestedAt", cell: ({ row }) => fmtDateTime(row.original.requestedAt) },
      {
        id: "decision",
        header: "قرار مستقل",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              onClick={() => {
                setDecisionTarget(row.original);
                setDecisionAction("APPROVE");
                setDecisionReason("");
              }}
            >
              <ShieldCheck aria-hidden className="size-4" /> اعتماد
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setDecisionTarget(row.original);
                setDecisionAction("REJECT");
                setDecisionReason("");
              }}
            >
              رفض
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  const selectedDetail = selectedReceipt.data;
  const createOrderRow = (confirmedOrders.data ?? []).find((row: PurchaseOrderRow) => Number(row.id) === createOrderId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="أذون استلام المشتريات (GRN)"
        icon={<PackageCheck aria-hidden className="size-5 text-primary" />}
        description="الاستلام على المراجعة المعتمدة فقط؛ المخزون وGRNI يُرحّلان معاً، والعكس طلب صفري الأثر حتى قرار مستقل."
        actions={
          <div className="flex flex-wrap gap-2">
            {role === "admin" ? (
              <AppSelect aria-label="فرع أذون الاستلام" value={branchId ? String(branchId) : ""} onValueChange={(value) => setBranchId(Number(value))}>
                <option value="">اختر فرعاً</option>
                {(branches.data ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </AppSelect>
            ) : null}
            <Button variant="outline" onClick={() => void refreshAll()} disabled={receipts.isFetching}>
              <RotateCcw aria-hidden className="size-4" /> تحديث
            </Button>
            {canReceive ? (
              <Button onClick={() => setCreateOpen(true)} disabled={branchId <= 0}>
                <PackageCheck aria-hidden className="size-4" /> تسجيل استلام
              </Button>
            ) : null}
          </div>
        }
      />

      <section className="rounded-md border bg-muted/20 p-3 text-sm" role="note">
        <strong>فصل المهام:</strong> منشئ أمر الشراء أو معتمده لا يستلم بضاعته، وطالب العكس أو منفذ الاستلام لا يعتمد العكس. الخادم يفرض ذلك حتى لو ظهرت الأزرار بسبب صلاحية واسعة.
      </section>

      {branchId <= 0 ? (
        <EmptyState
          title={role === "admin" ? "اختر فرعاً لعرض أذون الاستلام" : "لا يوجد فرع مُسنَد للمستخدم"}
          description={role === "admin" ? "لا يختار النظام فرعاً إدارياً افتراضياً؛ حدّد النطاق صراحةً من أعلى الشاشة." : "أُوقف تحميل وتشغيل الاستلام حتى يُسند المدير فرعاً لهذا المستخدم."}
        />
      ) : (
        <DataTable
          columns={receiptColumns}
          data={receipts.data ?? []}
          loading={receipts.isLoading}
          errorState={{ isError: receipts.isError, message: receipts.error?.message, onRetry: () => void receipts.refetch() }}
          searchPlaceholder="بحث برقم الإذن أو أمر الشراء"
          emptyText="لا توجد أذون استلام في الفرع المحدد."
        />
      )}

      {canReview && branchId > 0 ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">طلبات عكس تنتظر مراجعاً مستقلاً</h2>
          <DataTable
            columns={pendingColumns}
            data={pending.data ?? []}
            loading={pending.isLoading}
            errorState={{ isError: pending.isError, message: pending.error?.message, onRetry: () => void pending.refetch() }}
            searchable={false}
            emptyText="لا توجد طلبات عكس مؤهلة لمراجعتك. طلباتك الشخصية لا تظهر هنا."
            pageSize={Infinity}
            bounded={false}
          />
        </section>
      ) : null}

      <Dialog open={createOpen} onOpenChange={(open) => { if (!open && !createReceipt.isPending) resetCreate(); }}>
        <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تسجيل إذن استلام من أمر معتمد</DialogTitle>
            <DialogDescription>اختر أمر الشراء المؤكد. لا يسمح النظام بمسودة أو مراجعة قديمة، ولا ينفذ استلاماً بلا كمية صريحة.</DialogDescription>
          </DialogHeader>
          {confirmedOrders.error ? <ErrorState message={confirmedOrders.error.message} onRetry={() => void confirmedOrders.refetch()} /> : null}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="grn-purchase-order">أمر الشراء المؤكد</Label>
              <AppSelect
                id="grn-purchase-order"
                value={createOrderId ? String(createOrderId) : ""}
                onValueChange={(value) => {
                  setCreateOrderId(Number(value));
                  hydratedOrderId.current = 0;
                }}
              >
                <option value="">اختر أمر شراء</option>
                {(confirmedOrders.data ?? []).map((order) => (
                  <option key={order.id} value={order.id}>{order.poNumber} · {order.supplierName ?? `مورد #${order.supplierId}`}</option>
                ))}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="grn-delivery-note">رقم مذكرة تسليم المورد</Label>
              <Input id="grn-delivery-note" value={supplierDeliveryNote} maxLength={160} onChange={(event) => setSupplierDeliveryNote(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="grn-received-at">وقت الاستلام الفعلي</Label>
              <Input id="grn-received-at" type="datetime-local" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="grn-notes">ملاحظات الاستلام</Label>
              <Textarea id="grn-notes" value={receiptNotes} maxLength={500} onChange={(event) => setReceiptNotes(event.target.value)} />
            </div>
          </div>
          {createOrder.isLoading ? <LoadingState message={ACTION_LABELS.loading} /> : null}
          {createOrder.error ? <ErrorState message={createOrder.error.message} onRetry={() => void createOrder.refetch()} /> : null}
          {createOrder.data ? (
            <div className="space-y-2">
              <div className="rounded-md border bg-muted/20 p-3 text-sm">
                <div>الأمر: <strong>{createOrderRow?.poNumber ?? `#${createOrder.data.id}`}</strong></div>
                <div>المراجعة المعتمدة: <strong>{createOrder.data.approvedRevisionId ? `#${createOrder.data.approvedRevisionId}` : "لا توجد"}</strong> · النسخة التشغيلية: {createOrder.data.version}</div>
              </div>
              {createOrder.data.items.map((item, index) => {
                const draft = receiptLines[index];
                if (!draft) return null;
                const remaining = Math.max(Number(item.baseQuantity) - Number(item.receivedBaseQuantity), 0);
                return (
                  <section key={item.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong>{item.productName ?? `بند #${item.id}`}{item.variantName ? ` — ${item.variantName}` : ""}</strong>
                      <span className="text-sm text-muted-foreground">المتبقي بالأساس: {remaining}</span>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <div className="space-y-1">
                        <Label>المقبول بالأساس</Label>
                        <Input type="number" min={0} max={remaining} step={1} value={draft.acceptedBaseQuantity} onChange={(event) => setReceiptLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, acceptedBaseQuantity: positiveInteger(event.target.value) } : line))} />
                      </div>
                      <div className="space-y-1">
                        <Label>المرفوض بالأساس</Label>
                        <Input type="number" min={0} max={remaining} step={1} value={draft.rejectedBaseQuantity} onChange={(event) => setReceiptLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, rejectedBaseQuantity: positiveInteger(event.target.value) } : line))} />
                      </div>
                      <div className="space-y-1">
                        <Label>سبب الرفض</Label>
                        <Input value={draft.rejectionReason} maxLength={500} disabled={draft.rejectedBaseQuantity <= 0} onChange={(event) => setReceiptLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, rejectionReason: event.target.value } : line))} />
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={resetCreate} disabled={createReceipt.isPending}>إغلاق</Button>
            <Button onClick={submitReceipt} disabled={createReceipt.isPending || !createOrder.data?.approvedRevisionId}>
              {createReceipt.isPending ? ACTION_LABELS.saving : "ترحيل إذن الاستلام"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={selectedReceiptId > 0 && !reversalOpen} onOpenChange={(open) => { if (!open && !reversalOpen && !requestReversal.isPending) setSelectedReceiptId(0); }}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>دليل إذن الاستلام {selectedDetail?.receipt.receiptNumber ?? ""}</DialogTitle>
            <DialogDescription>المستند وبنوده وطلبات العكس تاريخ ثابت. تغيير الحالة لا يمحو دليل الاستلام الأصلي.</DialogDescription>
          </DialogHeader>
          {selectedReceipt.isLoading ? <LoadingState message={ACTION_LABELS.loading} /> : null}
          {selectedReceipt.error ? <ErrorState message={selectedReceipt.error.message} onRetry={() => void selectedReceipt.refetch()} /> : null}
          {selectedDetail ? (
            <div className="space-y-3">
              <div className="grid gap-3 rounded-md border p-3 text-sm md:grid-cols-4">
                <div><span className="text-muted-foreground">الحالة</span><div><Badge variant={statusVariant(selectedDetail.receipt.status)}>{RECEIPT_STATUS[selectedDetail.receipt.status] ?? selectedDetail.receipt.status}</Badge></div></div>
                <div><span className="text-muted-foreground">أمر الشراء</span><div>#{Number(selectedDetail.receipt.purchaseOrderId)}</div></div>
                <div><span className="text-muted-foreground">المراجعة</span><div>#{Number(selectedDetail.receipt.purchaseOrderRevisionId)}</div></div>
                <div><span className="text-muted-foreground">المنفذ</span><div>مستخدم #{Number(selectedDetail.receipt.createdBy)}</div></div>
              </div>
              {selectedDetail.items.map((item) => (
                <section key={item.id} className="rounded-md border p-3 text-sm">
                  <div className="font-semibold">بند #{Number(item.lineNo)} · متغير #{Number(item.variantId)}</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-4">
                    <div>مقبول: {Number(item.acceptedBaseQuantity)}</div>
                    <div>مرفوض: {Number(item.rejectedBaseQuantity)}</div>
                    <div>معكوس: {Number(item.reversedBaseQuantity)}</div>
                    <div>مرتجع: {Number(item.returnedBaseQuantity)}</div>
                  </div>
                  {item.rejectionReason ? <div className="mt-2 text-muted-foreground">سبب الرفض: {item.rejectionReason}</div> : null}
                </section>
              ))}
              {selectedDetail.reversalRequests.length ? (
                <section className="rounded-md border p-3 text-sm">
                  <strong>طلبات العكس</strong>
                  <div className="mt-2 space-y-2">
                    {selectedDetail.reversalRequests.map((request) => <div key={request.id} className="rounded border bg-muted/20 p-2">طلب #{Number(request.id)} · {request.status} · {request.reason}</div>)}
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedReceiptId(0)}>إغلاق</Button>
            {canReceive && selectedDetail && selectedDetail.receipt.status !== "REVERSED" && !selectedDetail.reversalRequests.some((request) => request.status === "PENDING") ? (
              <Button variant="destructive" onClick={() => openReversal(selectedDetail)}>
                <Undo2 aria-hidden className="size-4" /> طلب عكس
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reversalOpen} onOpenChange={(open) => { if (!open && !requestReversal.isPending) setReversalOpen(false); }}>
        <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>طلب عكس إذن الاستلام</DialogTitle>
            <DialogDescription>هذا الطلب صفري الأثر. لا يخرج مخزون ولا يُعكس GRNI قبل اعتماد مستخدم مستقل.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="grn-reversal-reason">سبب العكس</Label>
            <Textarea id="grn-reversal-reason" value={reversalReason} maxLength={500} onChange={(event) => setReversalReason(event.target.value)} />
          </div>
          <div className="space-y-2">
            {reversalLines.map((line, index) => {
              const item = selectedDetail?.items.find((candidate) => Number(candidate.id) === line.goodsReceiptItemId);
              const available = Number(item?.acceptedBaseQuantity ?? 0) - Number(item?.reversedBaseQuantity ?? 0) - Number(item?.returnedBaseQuantity ?? 0);
              return (
                <section key={line.goodsReceiptItemId} className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
                  <div className="space-y-1"><Label>كمية العكس لبند #{Number(item?.lineNo ?? index + 1)} (متاح {available})</Label><Input type="number" min={0} max={available} step={1} value={line.baseQuantity} onChange={(event) => setReversalLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, baseQuantity: positiveInteger(event.target.value) } : candidate))} /></div>
                  <div className="space-y-1"><Label>سبب خاص بالبند</Label><Input value={line.reason} maxLength={500} onChange={(event) => setReversalLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, reason: event.target.value } : candidate))} /></div>
                </section>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReversalOpen(false)} disabled={requestReversal.isPending}>تراجع</Button>
            <Button variant="destructive" onClick={submitReversal} disabled={requestReversal.isPending}>
              {requestReversal.isPending ? ACTION_LABELS.saving : "إرسال طلب العكس"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={decisionTarget != null} onOpenChange={(open) => { if (!open && !decideReversal.isPending) setDecisionTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{decisionAction === "APPROVE" ? "اعتماد عكس الاستلام" : "رفض طلب العكس"}</DialogTitle>
            <DialogDescription>راجع السبب والمستند. الخادم يرفض اعتماد طالب العكس أو منفذ الاستلام أو منشئ/معتمد أمر الشراء.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/20 p-3 text-sm">{decisionTarget?.reason}</div>
          <div className="space-y-1">
            <Label htmlFor="grn-decision-reason">سبب القرار</Label>
            <Textarea id="grn-decision-reason" value={decisionReason} maxLength={500} onChange={(event) => setDecisionReason(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecisionTarget(null)} disabled={decideReversal.isPending}>تراجع</Button>
            <Button variant={decisionAction === "APPROVE" ? "default" : "destructive"} onClick={submitDecision} disabled={decideReversal.isPending}>
              {decideReversal.isPending ? ACTION_LABELS.saving : decisionAction === "APPROVE" ? "اعتماد وتنفيذ العكس" : "رفض الطلب"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
