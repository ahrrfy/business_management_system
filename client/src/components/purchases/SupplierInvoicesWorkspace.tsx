import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Ban,
  FileInput,
  GitCompareArrows,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { DataTable } from "@/components/data-table/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { MoneyInput } from "@/components/form/MoneyInput";
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
import { fmtDate, fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";

type SupplierInvoiceRow = RouterOutputs["supplierInvoices"]["list"][number];
type SupplierInvoiceDetail = RouterOutputs["supplierInvoices"]["get"];
type PendingApproval = RouterOutputs["supplierInvoices"]["pendingApprovals"][number];
type PurchaseOrderRow = RouterOutputs["purchases"]["list"][number];

type InvoiceLineDraft = {
  purchaseOrderRevisionItemId: number;
  description: string;
  invoicedBaseQuantity: number;
  unitPrice: string;
};

type MatchAllocationDraft = {
  supplierInvoiceLineId: number;
  goodsReceiptItemId: number;
  matchedBaseQuantity: number;
  maxQuantity: number;
};

type EvidenceType = "DOCUMENT_IMAGE" | "PDF" | "EMAIL" | "EDI" | "OTHER";
type ApprovalEvidenceType = "DOCUMENT_IMAGE" | "PDF" | "EMAIL" | "SIGNED_APPROVAL" | "OTHER";

const INVOICE_STATUS: Record<string, string> = {
  DRAFT: "مسودة ثابتة",
  ON_HOLD: "محجوزة بالمطابقة",
  MATCHED: "مطابقة وجاهزة للطلب",
  POSTED: "مرحّلة للذمم",
  REVERSED: "معكوسة",
};

const MATCH_OUTCOME: Record<string, string> = {
  EXACT: "مطابقة تامة",
  WITHIN_TOLERANCE: "ضمن هامش السماح",
  HOLD: "محجوزة — خارج السماح",
};

const HOLD_CODE: Record<string, string> = {
  QUANTITY_MISMATCH: "اختلاف كمية",
  PRICE_TOLERANCE_EXCEEDED: "تجاوز سماح السعر",
  TOTAL_TOLERANCE_EXCEEDED: "تجاوز سماح الإجمالي",
};

function invoiceStatusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "POSTED" || status === "MATCHED") return "default";
  if (status === "REVERSED" || status === "ON_HOLD") return "destructive";
  return "outline";
}

function permissionsOverride(value: unknown) {
  return (value as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)
    ?.permissionsOverride ?? null;
}

function positiveInteger(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function uniqueOrders(...lists: PurchaseOrderRow[][]) {
  return Array.from(new Map(lists.flat().map((row) => [Number(row.id), row])).values());
}

export function SupplierInvoicesWorkspace() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState(0);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createOrderId, setCreateOrderId] = useState(0);
  const [externalInvoiceNumber, setExternalInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [currency, setCurrency] = useState<"IQD" | "USD">("IQD");
  const [agreedRate, setAgreedRate] = useState("");
  const [taxAmount, setTaxAmount] = useState("0");
  const [discountAmount, setDiscountAmount] = useState("0");
  const [evidenceType, setEvidenceType] = useState<EvidenceType>("DOCUMENT_IMAGE");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [invoiceLines, setInvoiceLines] = useState<InvoiceLineDraft[]>([]);
  const createKey = useRef(crypto.randomUUID());
  const hydratedRevisionId = useRef(0);

  const [matchReceiptId, setMatchReceiptId] = useState(0);
  const [matchAllocations, setMatchAllocations] = useState<MatchAllocationDraft[]>([]);
  const hydratedMatchPair = useRef("");
  const matchKeys = useRef(new Map<string, string>());

  const [requestKind, setRequestKind] = useState<"POST_INVOICE" | "REVERSE_INVOICE" | null>(null);
  const [requestReason, setRequestReason] = useState("");
  const [requestEvidenceType, setRequestEvidenceType] = useState<ApprovalEvidenceType>("DOCUMENT_IMAGE");
  const [requestEvidenceReference, setRequestEvidenceReference] = useState("");
  const requestKeys = useRef(new Map<string, string>());

  const [decisionTarget, setDecisionTarget] = useState<PendingApproval | null>(null);
  const [decisionAction, setDecisionAction] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [decisionReason, setDecisionReason] = useState("");
  const decisionKeys = useRef(new Map<number, string>());

  const [editOpen, setEditOpen] = useState(false);
  const [editReason, setEditReason] = useState("");
  const [editExternalNumber, setEditExternalNumber] = useState("");
  const [editInvoiceDate, setEditInvoiceDate] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editAgreedRate, setEditAgreedRate] = useState("");
  const [editTaxAmount, setEditTaxAmount] = useState("0");
  const [editDiscountAmount, setEditDiscountAmount] = useState("0");
  const [editEvidenceType, setEditEvidenceType] = useState<EvidenceType>("DOCUMENT_IMAGE");
  const [editEvidenceReference, setEditEvidenceReference] = useState("");
  const [editLines, setEditLines] = useState<InvoiceLineDraft[]>([]);
  const editKey = useRef(crypto.randomUUID());
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const voidKey = useRef(crypto.randomUUID());

  useEffect(() => {
    if (branchId > 0) return;
    if (me.data?.role === "admin") return;
    if (me.data?.branchId != null && Number(me.data.branchId) > 0) {
      setBranchId(Number(me.data.branchId));
    }
  }, [branchId, me.data?.branchId, me.data?.role]);

  const role = me.data?.role ?? "";
  const canManage = !!role && moduleAccessAllowed(
    role as RoleKey,
    permissionsOverride(me.data) as PermissionMap | null,
    "purchases",
    "FULL",
    ["manager", "purchasing"],
  );

  const invoices = trpc.supplierInvoices.list.useQuery(
    { branchId, limit: 200 },
    { enabled: branchId > 0 },
  );
  const pending = trpc.supplierInvoices.pendingApprovals.useQuery(
    { branchId },
    { enabled: branchId > 0 && canManage },
  );
  const confirmedOrders = trpc.purchases.list.useQuery(
    { branchId, status: "CONFIRMED", limit: 500, offset: 0 },
    { enabled: branchId > 0 && createOpen && canManage },
  );
  const receivedOrders = trpc.purchases.list.useQuery(
    { branchId, status: "RECEIVED", limit: 500, offset: 0 },
    { enabled: branchId > 0 && createOpen && canManage },
  );
  const eligibleOrders = useMemo(
    () => uniqueOrders(confirmedOrders.data ?? [], receivedOrders.data ?? []),
    [confirmedOrders.data, receivedOrders.data],
  );
  const createOrder = trpc.purchases.get.useQuery(
    { purchaseOrderId: createOrderId || 1 },
    { enabled: createOpen && createOrderId > 0 },
  );
  const approvedRevisionId = Number(createOrder.data?.approvedRevisionId ?? 0);
  const createRevision = trpc.purchases.revision.useQuery(
    { purchaseOrderId: createOrderId || 1, revisionId: approvedRevisionId || 1 },
    { enabled: createOpen && createOrderId > 0 && approvedRevisionId > 0 },
  );
  const selectedInvoice = trpc.supplierInvoices.get.useQuery(
    { supplierInvoiceId: selectedInvoiceId || 1 },
    { enabled: selectedInvoiceId > 0 },
  );
  const draftGovernance = trpc.supplierInvoices.draftGovernance.useQuery(
    { supplierInvoiceId: selectedInvoiceId || 1 },
    { enabled: selectedInvoiceId > 0 },
  );
  const matchingReceipts = trpc.goodsReceipts.list.useQuery(
    { branchId, limit: 200 },
    { enabled: selectedInvoiceId > 0 && branchId > 0 },
  );
  const matchReceipt = trpc.goodsReceipts.get.useQuery(
    { goodsReceiptId: matchReceiptId || 1 },
    { enabled: selectedInvoiceId > 0 && matchReceiptId > 0 },
  );

  useEffect(() => {
    const order = createOrder.data;
    const revision = createRevision.data;
    if (!order || !revision || hydratedRevisionId.current === Number(revision.id)) return;
    hydratedRevisionId.current = Number(revision.id);
    setCurrency(order.agreedCurrency);
    setAgreedRate(order.agreedCurrency === "USD" ? String(order.agreedRate ?? "") : "");
    setInvoiceLines(
      revision.items.map((item) => ({
        purchaseOrderRevisionItemId: Number(item.id),
        description: `${item.productNameSnapshot}${item.variantNameSnapshot ? ` — ${item.variantNameSnapshot}` : ""}`,
        invoicedBaseQuantity: Number(item.baseQuantity),
        unitPrice: String(order.agreedCurrency === "USD" ? item.usdUnitPrice ?? "" : item.unitPrice),
      })),
    );
  }, [createOrder.data, createRevision.data]);

  const selectedDetail = selectedInvoice.data;
  useEffect(() => {
    const detail = selectedDetail;
    const receipt = matchReceipt.data;
    if (!detail || !receipt) return;
    const pair = `${detail.invoice.id}:${detail.invoice.version}:${receipt.receipt.id}:${receipt.receipt.version}`;
    if (hydratedMatchPair.current === pair) return;
    hydratedMatchPair.current = pair;
    const currentReceiptItemIds = new Set(receipt.items.map((item) => Number(item.id)));
    setMatchAllocations((current) => {
      const retained = current.filter((allocation) => !currentReceiptItemIds.has(allocation.goodsReceiptItemId));
      const rows: MatchAllocationDraft[] = [];
      for (const line of detail.lines) {
        const receiptItems = receipt.items.filter(
          (item) =>
            item.purchaseOrderRevisionItemId != null &&
            line.purchaseOrderRevisionItemId != null &&
            Number(item.purchaseOrderRevisionItemId) === Number(line.purchaseOrderRevisionItemId),
        );
        const alreadyAllocated = retained
          .filter((allocation) => allocation.supplierInvoiceLineId === Number(line.id))
          .reduce((sum, allocation) => sum + allocation.matchedBaseQuantity, 0);
        let remainingInvoiceQuantity = Math.max(Number(line.invoicedBaseQuantity) - alreadyAllocated, 0);
        for (const receiptItem of receiptItems) {
          const receiptAvailable =
            Number(receiptItem.acceptedBaseQuantity) -
            Number(receiptItem.reversedBaseQuantity) -
            Number(receiptItem.returnedBaseQuantity);
          const maxQuantity = Math.max(Math.min(remainingInvoiceQuantity, receiptAvailable), 0);
          if (maxQuantity > 0) {
            rows.push({
              supplierInvoiceLineId: Number(line.id),
              goodsReceiptItemId: Number(receiptItem.id),
              matchedBaseQuantity: maxQuantity,
              maxQuantity,
            });
            remainingInvoiceQuantity -= maxQuantity;
          }
        }
      }
      return [...retained, ...rows];
    });
  }, [matchReceipt.data, selectedDetail]);

  async function refreshAll() {
    await Promise.all([
      utils.supplierInvoices.list.invalidate(),
      utils.supplierInvoices.get.invalidate(),
      utils.supplierInvoices.pendingApprovals.invalidate(),
      utils.supplierInvoices.draftGovernance.invalidate(),
      utils.goodsReceipts.list.invalidate(),
      utils.goodsReceipts.get.invalidate(),
    ]);
  }

  function resetCreate() {
    setCreateOpen(false);
    setCreateOrderId(0);
    setExternalInvoiceNumber("");
    setInvoiceDate("");
    setDueDate("");
    setCurrency("IQD");
    setAgreedRate("");
    setTaxAmount("0");
    setDiscountAmount("0");
    setEvidenceType("DOCUMENT_IMAGE");
    setEvidenceReference("");
    setInvoiceLines([]);
    hydratedRevisionId.current = 0;
    createKey.current = crypto.randomUUID();
  }

  const createInvoice = trpc.supplierInvoices.create.useMutation({
    onSuccess: async (result) => {
      notify.ok("حُفظت فاتورة المورد", `${result.invoiceNumber} مسودة ثابتة لا تُعدّل بصمت.`);
      resetCreate();
      await refreshAll();
    },
    onError: (error) => notify.err(error),
  });
  const runMatch = trpc.supplierInvoices.runMatch.useMutation({
    onSuccess: async (result) => {
      notify.ok(
        result.outcome === "HOLD" ? "حُجزت الفاتورة" : "اكتملت المطابقة الثلاثية",
        result.outcome === "HOLD"
          ? "تجاوزت المطابقة حدود السماح؛ لن يظهر مسار طلب الترحيل قبل معالجة الفروقات."
          : `${MATCH_OUTCOME[result.outcome]} — يمكن الآن طلب الترحيل من مراجع مستقل.`,
      );
      hydratedMatchPair.current = "";
      await refreshAll();
    },
    onError: (error) => notify.err(error),
  });
  const requestApproval = trpc.supplierInvoices.requestApproval.useMutation({
    onSuccess: async () => {
      notify.ok("أُرسل طلب القرار", "لم تُرحّل أو تُعكس الفاتورة بعد؛ ينتظر الطلب مراجعاً مستقلاً.");
      setRequestKind(null);
      setRequestReason("");
      setRequestEvidenceReference("");
      await refreshAll();
    },
    onError: (error) => notify.err(error),
  });
  const decideApproval = trpc.supplierInvoices.decideApproval.useMutation({
    onSuccess: async (result) => {
      notify.ok(
        result.status === "APPROVED" ? "طُبّق قرار فاتورة المورد" : "حُسم الطلب",
        result.status === "APPROVED" ? "القيد والذمة وحالة المستند تغيّرت في معاملة واحدة." : `الحالة النهائية: ${result.status}`,
      );
      setDecisionTarget(null);
      setDecisionReason("");
      await refreshAll();
    },
    onError: (error) => notify.err(error),
  });
  const updateDraft = trpc.supplierInvoices.updateDraft.useMutation({
    onSuccess: async (result) => {
      notify.ok("حُفظت مراجعة جديدة للمسودة", `المراجعة ${result.revisionNo} تحفظ قبل/بعد والسبب ولا تستبدل الدليل التاريخي.`);
      setEditOpen(false);
      editKey.current = crypto.randomUUID();
      await refreshAll();
    },
    onError: (error) => notify.err(error),
  });
  const voidDraft = trpc.supplierInvoices.voidDraft.useMutation({
    onSuccess: async () => {
      notify.ok("أُلغيت مسودة فاتورة المورد", "احتُفظ بالمستند ومراجعاته كدليل، وأُغلقت المطابقة والترحيل عليه.");
      setVoidOpen(false);
      setVoidReason("");
      voidKey.current = crypto.randomUUID();
      await refreshAll();
    },
    onError: (error) => notify.err(error),
  });

  function submitCreate() {
    const order = createOrder.data;
    const revision = createRevision.data;
    if (!order || !revision || order.approvedRevisionId == null) return notify.warn("اختر مراجعة أمر شراء معتمدة.");
    if (externalInvoiceNumber.trim().length < 1) return notify.warn("أدخل رقم فاتورة المورد الخارجي.");
    if (!invoiceDate) return notify.warn("أدخل تاريخ فاتورة المورد.");
    if (evidenceReference.trim().length < 1) return notify.warn("أدخل مرجع الدليل أو المرفق.");
    if (!invoiceLines.length || invoiceLines.some((line) => line.invoicedBaseQuantity <= 0 || !line.unitPrice.trim())) {
      return notify.warn("راجع كميات وأسعار كل البنود.");
    }
    createInvoice.mutate({
      supplierId: Number(order.supplierId),
      branchId: Number(order.branchId),
      clientRequestId: createKey.current,
      externalInvoiceNumber: externalInvoiceNumber.trim(),
      invoiceDate,
      dueDate: dueDate || null,
      currency,
      agreedRate: currency === "USD" ? agreedRate : null,
      taxAmount: taxAmount || "0",
      discountAmount: discountAmount || "0",
      evidenceType,
      evidenceReference: evidenceReference.trim(),
      lines: invoiceLines.map((line) => ({
        ...line,
        description: line.description.trim(),
        unitPrice: line.unitPrice.trim(),
      })),
    });
  }

  function submitMatch() {
    const detail = selectedDetail;
    if (!detail || !matchReceipt.data) return notify.warn("اختر إذن استلام للمطابقة.");
    const allocations = matchAllocations.filter((allocation) => allocation.matchedBaseQuantity > 0);
    if (!allocations.length) return notify.warn("لا يوجد بند متوافق بين الفاتورة وإذن الاستلام المختار.");
    if (allocations.some((allocation) => allocation.matchedBaseQuantity > allocation.maxQuantity)) {
      return notify.warn("كمية مطابقة تتجاوز المتاح في الفاتورة أو إذن الاستلام.");
    }
    for (const line of detail.lines) {
      const totalForLine = allocations
        .filter((allocation) => allocation.supplierInvoiceLineId === Number(line.id))
        .reduce((sum, allocation) => sum + allocation.matchedBaseQuantity, 0);
      if (totalForLine > Number(line.invoicedBaseQuantity)) {
        return notify.warn("مجموع تخصيصات أحد بنود الفاتورة يتجاوز كميته؛ راجع أذون الاستلام المضافة.");
      }
    }
    const slot = `${detail.invoice.id}:${detail.invoice.version}:${matchReceipt.data.receipt.id}:${matchReceipt.data.receipt.version}`;
    let key = matchKeys.current.get(slot);
    if (!key) {
      key = crypto.randomUUID();
      matchKeys.current.set(slot, key);
    }
    runMatch.mutate({
      supplierInvoiceId: Number(detail.invoice.id),
      expectedInvoiceVersion: Number(detail.invoice.version),
      matchKey: key,
      allocations: allocations.map(({ maxQuantity: _maxQuantity, ...allocation }) => allocation),
    });
  }

  function openRequest(kind: "POST_INVOICE" | "REVERSE_INVOICE") {
    setRequestKind(kind);
    setRequestReason("");
    setRequestEvidenceType("DOCUMENT_IMAGE");
    setRequestEvidenceReference("");
  }

  function submitRequest() {
    const detail = selectedDetail;
    if (!detail || !requestKind || requestReason.trim().length < 3) return notify.warn("اكتب سبب الطلب.");
    const latestMatch = detail.matches[0];
    if (requestKind === "POST_INVOICE" && (!latestMatch || latestMatch.outcome === "HOLD")) {
      return notify.warn("الترحيل يحتاج أحدث مطابقة ناجحة غير محجوزة.");
    }
    if (requestKind === "REVERSE_INVOICE" && requestEvidenceReference.trim().length < 1) {
      return notify.warn("دليل عكس الفاتورة مطلوب.");
    }
    const slot = `${requestKind}:${detail.invoice.id}:${detail.invoice.version}`;
    let key = requestKeys.current.get(slot);
    if (!key) {
      key = crypto.randomUUID();
      requestKeys.current.set(slot, key);
    }
    requestApproval.mutate({
      supplierInvoiceId: Number(detail.invoice.id),
      expectedInvoiceVersion: Number(detail.invoice.version),
      requestKey: key,
      kind: requestKind,
      matchRunId: requestKind === "POST_INVOICE" ? Number(latestMatch?.id) : null,
      reason: requestReason.trim(),
      evidenceType: requestKind === "REVERSE_INVOICE" ? requestEvidenceType : null,
      evidenceReference: requestKind === "REVERSE_INVOICE" ? requestEvidenceReference.trim() : null,
    });
  }

  function submitDecision() {
    if (!decisionTarget || decisionReason.trim().length < 3) return notify.warn("اكتب سبب قرار المراجعة.");
    let key = decisionKeys.current.get(Number(decisionTarget.id));
    if (!key) {
      key = crypto.randomUUID();
      decisionKeys.current.set(Number(decisionTarget.id), key);
    }
    decideApproval.mutate({
      requestId: Number(decisionTarget.id),
      decisionKey: key,
      action: decisionAction,
      reviewReason: decisionReason.trim(),
    });
  }

  function openDraftEditor(detail: SupplierInvoiceDetail) {
    setEditReason("");
    setEditExternalNumber(detail.invoice.externalInvoiceNumber ?? "");
    setEditInvoiceDate(String(detail.invoice.invoiceDate).slice(0, 10));
    setEditDueDate(detail.invoice.dueDate ? String(detail.invoice.dueDate).slice(0, 10) : "");
    setEditAgreedRate(detail.invoice.agreedRate ?? "");
    setEditTaxAmount(detail.invoice.taxAmount ?? "0");
    setEditDiscountAmount(detail.invoice.discountAmount ?? "0");
    setEditEvidenceType(detail.invoice.evidenceType as EvidenceType);
    setEditEvidenceReference(detail.invoice.evidenceReference ?? "");
    setEditLines(detail.lines.map((line) => ({
      purchaseOrderRevisionItemId: Number(line.purchaseOrderRevisionItemId),
      description: line.description,
      invoicedBaseQuantity: Number(line.invoicedBaseQuantity),
      unitPrice: detail.invoice.currency === "USD" ? String(line.usdUnitPrice ?? "") : String(line.unitPriceIqd),
    })));
    editKey.current = crypto.randomUUID();
    setEditOpen(true);
  }

  function submitDraftUpdate() {
    const detail = selectedDetail;
    if (!detail || editReason.trim().length < 3) return notify.warn("اكتب سبب التعديل لحفظه في سجل المراجعات.");
    if (!editExternalNumber.trim() || !editInvoiceDate || !editEvidenceReference.trim()) {
      return notify.warn("رقم الفاتورة والتاريخ ومرجع الدليل حقول مطلوبة.");
    }
    if (!editLines.length || editLines.some((line) => line.invoicedBaseQuantity <= 0 || !line.unitPrice.trim())) {
      return notify.warn("راجع كميات وأسعار بنود الفاتورة.");
    }
    updateDraft.mutate({
      supplierInvoiceId: Number(detail.invoice.id),
      expectedVersion: Number(detail.invoice.version),
      requestKey: editKey.current,
      reason: editReason.trim(),
      externalInvoiceNumber: editExternalNumber.trim(),
      invoiceDate: editInvoiceDate,
      dueDate: editDueDate || null,
      agreedRate: detail.invoice.currency === "USD" ? editAgreedRate : null,
      taxAmount: editTaxAmount || "0",
      discountAmount: editDiscountAmount || "0",
      evidenceType: editEvidenceType,
      evidenceReference: editEvidenceReference.trim(),
      lines: editLines.map((line) => ({ ...line, description: line.description.trim(), unitPrice: line.unitPrice.trim() })),
    });
  }

  function submitVoidDraft() {
    const detail = selectedDetail;
    if (!detail || voidReason.trim().length < 3) return notify.warn("اكتب سبب إلغاء المسودة.");
    voidDraft.mutate({
      supplierInvoiceId: Number(detail.invoice.id),
      expectedVersion: Number(detail.invoice.version),
      requestKey: voidKey.current,
      reason: voidReason.trim(),
    });
  }

  const invoiceColumns = useMemo<ColumnDef<SupplierInvoiceRow>[]>(
    () => [
      { header: "الرقم الداخلي", accessorKey: "invoiceNumber" },
      { header: "فاتورة المورد", accessorKey: "externalInvoiceNumber" },
      { header: "المورد", accessorKey: "supplierId", cell: ({ row }) => `#${Number(row.original.supplierId)}` },
      { header: "التاريخ", accessorKey: "invoiceDate", cell: ({ row }) => fmtDate(row.original.invoiceDate) },
      { header: "الإجمالي", accessorKey: "totalAmount", cell: ({ row }) => `${fmtAr(row.original.totalAmount)} ${row.original.currency}` },
      {
        header: "الحالة",
        accessorKey: "status",
        cell: ({ row }) => <Badge variant={invoiceStatusVariant(row.original.status)}>{INVOICE_STATUS[row.original.status] ?? row.original.status}</Badge>,
      },
      {
        id: "actions",
        header: "الإجراءات",
        cell: ({ row }) => (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSelectedInvoiceId(Number(row.original.id));
              setMatchReceiptId(0);
              setMatchAllocations([]);
              hydratedMatchPair.current = "";
            }}
          >
            <GitCompareArrows aria-hidden className="size-4" /> المطابقة والدليل
          </Button>
        ),
      },
    ],
    [],
  );

  const pendingColumns = useMemo<ColumnDef<PendingApproval>[]>(
    () => [
      { header: "الطلب", accessorKey: "id", cell: ({ row }) => `#${Number(row.original.id)}` },
      { header: "الفاتورة", accessorKey: "supplierInvoiceId", cell: ({ row }) => `#${Number(row.original.supplierInvoiceId)}` },
      { header: "النوع", accessorKey: "kind", cell: ({ row }) => row.original.kind === "POST_INVOICE" ? "ترحيل الفاتورة" : "عكس الفاتورة" },
      { header: "السبب", accessorKey: "reason" },
      { header: "طالب القرار", accessorKey: "requestedBy", cell: ({ row }) => `مستخدم #${Number(row.original.requestedBy)}` },
      { header: "وقت الطلب", accessorKey: "requestedAt", cell: ({ row }) => fmtDateTime(row.original.requestedAt) },
      {
        id: "decision",
        header: "قرار مستقل",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            <Button size="sm" onClick={() => { setDecisionTarget(row.original); setDecisionAction("APPROVE"); setDecisionReason(""); }}>
              <ShieldCheck aria-hidden className="size-4" /> اعتماد
            </Button>
            <Button size="sm" variant="destructive" onClick={() => { setDecisionTarget(row.original); setDecisionAction("REJECT"); setDecisionReason(""); }}>
              رفض
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  const matchingReceiptRows = (matchingReceipts.data ?? []).filter(
    (receipt) =>
      selectedDetail &&
      Number(receipt.supplierId) === Number(selectedDetail.invoice.supplierId) &&
      receipt.currency === selectedDetail.invoice.currency &&
      receipt.status !== "REVERSED",
  );
  const latestMatch = selectedDetail?.matches[0];
  const latestHoldCodes = Array.isArray(latestMatch?.holdCodes)
    ? latestMatch.holdCodes.filter((code): code is string => typeof code === "string")
    : [];
  const hasPendingRequest = selectedDetail?.approvals.some((approval) => approval.status === "PENDING") ?? false;
  const draftIsActive = draftGovernance.data?.state !== "VOIDED";

  return (
    <div className="space-y-4">
      <PageHeader
        title="فواتير المورد والمطابقة الثلاثية"
        icon={<FileInput aria-hidden className="size-5 text-primary" />}
        description="فاتورة المورد دليل ثابت؛ الترحيل يمر من أمر معتمد + استلام GRN + مطابقة ضمن السماح + قرار مستقل."
        actions={
          <div className="flex flex-wrap gap-2">
            {role === "admin" ? (
              <AppSelect aria-label="فرع فواتير المورد" value={branchId ? String(branchId) : ""} onValueChange={(value) => setBranchId(Number(value))}>
                <option value="">اختر فرعاً</option>
                {(branches.data ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </AppSelect>
            ) : null}
            <Button variant="outline" onClick={() => void refreshAll()} disabled={invoices.isFetching}>
              <RotateCcw aria-hidden className="size-4" /> تحديث
            </Button>
            {canManage ? (
              <Button onClick={() => setCreateOpen(true)} disabled={branchId <= 0}>
                <FileInput aria-hidden className="size-4" /> إدخال فاتورة مورد
              </Button>
            ) : null}
          </div>
        }
      />

      <section className="rounded-md border bg-muted/20 p-3 text-sm" role="note">
        <strong>فصل المهام:</strong> منشئ الفاتورة أو طالب الترحيل لا يعتمد الطلب، ومن نفّذ المطابقة لا يعتمد ترحيلها. حالات HOLD ليست تنبيهاً بصرياً فقط؛ الخادم يمنع الترحيل.
      </section>

      {branchId <= 0 ? (
        <EmptyState
          title={role === "admin" ? "اختر فرعاً لعرض فواتير المورد" : "لا يوجد فرع مُسنَد للمستخدم"}
          description={role === "admin" ? "لا يختار النظام فرعاً إدارياً افتراضياً؛ حدّد النطاق صراحةً من أعلى الشاشة." : "أُوقف تحميل وتشغيل فواتير المورد حتى يُسند المدير فرعاً لهذا المستخدم."}
        />
      ) : (
        <DataTable
          columns={invoiceColumns}
          data={invoices.data ?? []}
          loading={invoices.isLoading}
          errorState={{ isError: invoices.isError, message: invoices.error?.message, onRetry: () => void invoices.refetch() }}
          searchPlaceholder="بحث برقم الفاتورة الداخلي أو الخارجي"
          emptyText="لا توجد فواتير مورد في الفرع المحدد."
        />
      )}

      {canManage && branchId > 0 ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">طلبات ترحيل أو عكس مؤهلة لمراجعتك</h2>
          <DataTable
            columns={pendingColumns}
            data={pending.data ?? []}
            loading={pending.isLoading}
            errorState={{ isError: pending.isError, message: pending.error?.message, onRetry: () => void pending.refetch() }}
            searchable={false}
            emptyText="لا توجد طلبات مؤهلة لمراجعتك؛ طلباتك الشخصية لا تظهر هنا."
            pageSize={Infinity}
            bounded={false}
          />
        </section>
      ) : null}

      <Dialog open={createOpen} onOpenChange={(open) => { if (!open && !createInvoice.isPending) resetCreate(); }}>
        <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>إدخال فاتورة مورد بدليل ثابت</DialogTitle>
            <DialogDescription>اختر أمراً معتمداً. تُحفظ لقطة البنود والمرجع الخارجي والبصمة، ولا يحدث ترحيل محاسبي في هذه الخطوة.</DialogDescription>
          </DialogHeader>
          {(confirmedOrders.error || receivedOrders.error) ? (
            <ErrorState message={(confirmedOrders.error ?? receivedOrders.error)?.message} onRetry={() => { void confirmedOrders.refetch(); void receivedOrders.refetch(); }} />
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="supplier-invoice-order">أمر الشراء ومراجعته المعتمدة</Label>
              <AppSelect
                id="supplier-invoice-order"
                value={createOrderId ? String(createOrderId) : ""}
                onValueChange={(value) => {
                  setCreateOrderId(Number(value));
                  hydratedRevisionId.current = 0;
                }}
              >
                <option value="">اختر أمر شراء</option>
                {eligibleOrders.map((order) => <option key={order.id} value={order.id}>{order.poNumber} · {order.supplierName ?? `مورد #${order.supplierId}`} · {order.status}</option>)}
              </AppSelect>
            </div>
            <div className="space-y-1"><Label htmlFor="supplier-external-number">رقم فاتورة المورد الخارجي</Label><Input id="supplier-external-number" value={externalInvoiceNumber} maxLength={160} onChange={(event) => setExternalInvoiceNumber(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="supplier-invoice-date">تاريخ الفاتورة</Label><Input id="supplier-invoice-date" type="date" value={invoiceDate} onChange={(event) => setInvoiceDate(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="supplier-due-date">تاريخ الاستحقاق</Label><Input id="supplier-due-date" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></div>
            <div className="space-y-1"><Label>العملة</Label><Input value={currency} disabled /></div>
            {currency === "USD" ? <div className="space-y-1"><Label>سعر التثبيت د.ع/$</Label><MoneyInput value={agreedRate} decimals={4} onChange={setAgreedRate} disabled /></div> : null}
            <div className="space-y-1"><Label>الضريبة</Label><MoneyInput value={taxAmount} onChange={setTaxAmount} /></div>
            <div className="space-y-1"><Label>خصم الفاتورة</Label><MoneyInput value={discountAmount} onChange={setDiscountAmount} /></div>
            <div className="space-y-1"><Label htmlFor="supplier-evidence-type">نوع الدليل</Label><AppSelect id="supplier-evidence-type" value={evidenceType} onValueChange={(value) => setEvidenceType(value as EvidenceType)}><option value="DOCUMENT_IMAGE">صورة مستند</option><option value="PDF">ملف PDF</option><option value="EMAIL">بريد إلكتروني</option><option value="EDI">تبادل إلكتروني EDI</option><option value="OTHER">دليل آخر</option></AppSelect></div>
            <div className="space-y-1"><Label htmlFor="supplier-evidence-reference">مرجع الدليل / رابط المرفق</Label><Input id="supplier-evidence-reference" value={evidenceReference} maxLength={500} onChange={(event) => setEvidenceReference(event.target.value)} /></div>
          </div>
          {(createOrder.isLoading || createRevision.isLoading) ? <LoadingState message={ACTION_LABELS.loading} /> : null}
          {(createOrder.error || createRevision.error) ? <ErrorState message={(createOrder.error ?? createRevision.error)?.message} onRetry={() => { void createOrder.refetch(); void createRevision.refetch(); }} /> : null}
          {createRevision.data ? (
            <div className="space-y-2">
              <div className="rounded-md border bg-muted/20 p-3 text-sm">المراجعة المعتمدة #{Number(createRevision.data.id)} · بصمة <bdi dir="ltr" className="font-mono">{createRevision.data.payloadHash.slice(0, 16)}…</bdi></div>
              {invoiceLines.map((line, index) => {
                const snapshot = createRevision.data?.items[index];
                return (
                  <section key={line.purchaseOrderRevisionItemId} className="rounded-md border p-3">
                    <div className="font-semibold">السطر {snapshot?.lineNo ?? index + 1} · {snapshot?.productNameSnapshot ?? line.description}</div>
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <div className="space-y-1"><Label>الوصف على فاتورة المورد</Label><Input value={line.description} maxLength={500} onChange={(event) => setInvoiceLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, description: event.target.value } : candidate))} /></div>
                      <div className="space-y-1"><Label>الكمية بالأساس</Label><Input type="number" min={1} step={1} value={line.invoicedBaseQuantity} onChange={(event) => setInvoiceLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, invoicedBaseQuantity: positiveInteger(event.target.value) } : candidate))} /></div>
                      <div className="space-y-1"><Label>سعر وحدة المستند ({currency})</Label><MoneyInput value={line.unitPrice} decimals={currency === "USD" ? 4 : 2} onChange={(value) => setInvoiceLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, unitPrice: value } : candidate))} /></div>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={resetCreate} disabled={createInvoice.isPending}>إغلاق</Button>
            <Button onClick={submitCreate} disabled={createInvoice.isPending || !createRevision.data}>
              {createInvoice.isPending ? ACTION_LABELS.saving : "حفظ المسودة الثابتة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={selectedInvoiceId > 0 && !editOpen && !voidOpen && requestKind == null} onOpenChange={(open) => { if (!open && !editOpen && !voidOpen && requestKind == null && !runMatch.isPending && !requestApproval.isPending) setSelectedInvoiceId(0); }}>
        <DialogContent className="max-h-[94vh] max-w-6xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>المطابقة الثلاثية — {selectedDetail?.invoice.invoiceNumber ?? "فاتورة المورد"}</DialogTitle>
            <DialogDescription>قارن دليل أمر الشراء ودليل الاستلام وفاتورة المورد جنباً إلى جنب، ثم نفّذ المطابقة. HOLD يمنع الترحيل.</DialogDescription>
          </DialogHeader>
          {selectedInvoice.isLoading ? <LoadingState message={ACTION_LABELS.loading} /> : null}
          {selectedInvoice.error ? <ErrorState message={selectedInvoice.error.message} onRetry={() => void selectedInvoice.refetch()} /> : null}
          {draftGovernance.isLoading ? <LoadingState message={ACTION_LABELS.loading} /> : null}
          {draftGovernance.error ? <ErrorState message={draftGovernance.error.message} onRetry={() => void draftGovernance.refetch()} /> : null}
          {selectedDetail ? (
            <div className="space-y-4">
              <div className="grid gap-3 rounded-md border p-3 text-sm md:grid-cols-5">
                <div><span className="text-muted-foreground">الحالة</span><div><Badge variant={invoiceStatusVariant(selectedDetail.invoice.status)}>{INVOICE_STATUS[selectedDetail.invoice.status] ?? selectedDetail.invoice.status}</Badge></div></div>
                <div><span className="text-muted-foreground">فاتورة المورد</span><div>{selectedDetail.invoice.externalInvoiceNumber}</div></div>
                <div><span className="text-muted-foreground">التاريخ</span><div>{fmtDate(selectedDetail.invoice.invoiceDate)}</div></div>
                <div><span className="text-muted-foreground">الإجمالي</span><div>{fmtAr(selectedDetail.invoice.totalAmount)} {selectedDetail.invoice.currency}</div></div>
                <div><span className="text-muted-foreground">الدليل</span><div className="break-all">{selectedDetail.invoice.evidenceReference}</div></div>
              </div>

              {draftGovernance.data?.state === "VOIDED" ? (
                <section className="rounded-md border border-destructive/60 bg-destructive/5 p-3 text-sm">
                  <strong>هذه المسودة ملغاة تشغيلياً.</strong>
                  <div className="mt-1">السبب: {draftGovernance.data.voidReason}</div>
                  <div>المنفذ: مستخدم #{Number(draftGovernance.data.voidedBy)} · {draftGovernance.data.voidedAt ? fmtDateTime(draftGovernance.data.voidedAt) : "—"}</div>
                  <div className="mt-1 text-muted-foreground">بقي المستند وسجل مراجعاته للرقابة، لكن المطابقة والترحيل مغلقان.</div>
                </section>
              ) : null}

              {latestMatch ? (
                <section className={`rounded-md border p-3 text-sm ${latestMatch.outcome === "HOLD" ? "border-destructive/60 bg-destructive/5" : "bg-muted/20"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>آخر مطابقة #{Number(latestMatch.runNo)} — {MATCH_OUTCOME[latestMatch.outcome] ?? latestMatch.outcome}</strong>
                    <span>سماح السعر {String(latestMatch.priceTolerancePercent)}% · سماح الإجمالي {fmtAr(latestMatch.totalToleranceAmount)} د.ع</span>
                  </div>
                  <div className="mt-2 grid gap-2 md:grid-cols-4">
                    <div>قيمة الأمر: {fmtAr(latestMatch.poTotal)}</div>
                    <div>قيمة GRN: {fmtAr(latestMatch.grnTotal)}</div>
                    <div>قيمة الفاتورة: {fmtAr(latestMatch.invoiceTotal)}</div>
                    <div>فرق الإجمالي: {fmtAr(latestMatch.totalVarianceAmount)}</div>
                  </div>
                  {latestHoldCodes.length ? <div className="mt-2 font-semibold text-destructive">أسباب الحجز: {latestHoldCodes.map((code) => HOLD_CODE[code] ?? code).join("، ")}</div> : null}
                </section>
              ) : null}

              <div className="grid gap-4 lg:grid-cols-2">
                <section className="space-y-2 rounded-md border p-3">
                  <h3 className="font-semibold">فاتورة المورد / أمر الشراء</h3>
                  {selectedDetail.lines.map((line) => (
                    <div key={line.id} className="rounded border bg-muted/20 p-2 text-sm">
                      <div className="font-medium">{line.description}</div>
                      <div>بند مراجعة أمر الشراء #{Number(line.purchaseOrderRevisionItemId)} · كمية {Number(line.invoicedBaseQuantity)} · سعر {fmtAr(line.unitPriceIqd)} د.ع</div>
                    </div>
                  ))}
                </section>
                <section className="space-y-2 rounded-md border p-3">
                  <div className="space-y-1">
                    <Label htmlFor="match-grn">إذن الاستلام للمقارنة</Label>
                    <AppSelect id="match-grn" value={matchReceiptId ? String(matchReceiptId) : ""} onValueChange={(value) => { setMatchReceiptId(Number(value)); hydratedMatchPair.current = ""; }}>
                      <option value="">أضف GRN آخر للمورد والعملة نفسيهما</option>
                      {matchingReceiptRows.map((receipt) => <option key={receipt.id} value={receipt.id}>{receipt.receiptNumber} · أمر #{Number(receipt.purchaseOrderId)} · {fmtDateTime(receipt.receivedAt)}</option>)}
                    </AppSelect>
                  </div>
                  {matchingReceipts.error ? <ErrorState message={matchingReceipts.error.message} onRetry={() => void matchingReceipts.refetch()} /> : null}
                  {matchReceipt.isLoading ? <LoadingState message={ACTION_LABELS.loading} /> : null}
                  {matchReceipt.error ? <ErrorState message={matchReceipt.error.message} onRetry={() => void matchReceipt.refetch()} /> : null}
                  {matchReceipt.data?.items.map((item) => (
                    <div key={item.id} className="rounded border bg-muted/20 p-2 text-sm">
                      <div className="font-medium">بند GRN #{Number(item.lineNo)} · مراجعة #{Number(item.purchaseOrderRevisionItemId)}</div>
                      <div>مقبول {Number(item.acceptedBaseQuantity)} · معكوس {Number(item.reversedBaseQuantity)} · مرتجع {Number(item.returnedBaseQuantity)} · تكلفة {fmtAr(item.unitCostIqd)} د.ع</div>
                    </div>
                  ))}
                </section>
              </div>

              {matchReceipt.data ? (
                <section className="space-y-2 rounded-md border p-3">
                  <h3 className="font-semibold">تخصيص كميات المطابقة من جميع أذون GRN المضافة</h3>
                  {matchAllocations.map((allocation, index) => {
                    const line = selectedDetail.lines.find((candidate) => Number(candidate.id) === allocation.supplierInvoiceLineId);
                    return (
                      <div key={`${allocation.supplierInvoiceLineId}:${allocation.goodsReceiptItemId}`} className="grid items-end gap-3 rounded border p-2 md:grid-cols-[1fr_12rem]">
                        <div className="text-sm">{line?.description ?? `بند فاتورة #${allocation.supplierInvoiceLineId}`} · بند GRN #{allocation.goodsReceiptItemId} · أقصى كمية {allocation.maxQuantity}</div>
                        <div className="space-y-1"><Label>الكمية المطابقة</Label><Input type="number" min={1} max={allocation.maxQuantity} step={1} value={allocation.matchedBaseQuantity} onChange={(event) => setMatchAllocations((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, matchedBaseQuantity: positiveInteger(event.target.value) } : candidate))} /></div>
                      </div>
                    );
                  })}
                  {!matchAllocations.length ? <div className="rounded border p-4 text-center text-sm text-muted-foreground">لا توجد بنود تحمل معرّف مراجعة مشتركاً بين الفاتورة وهذا GRN.</div> : null}
                  {draftIsActive && (["DRAFT", "ON_HOLD", "MATCHED"] as string[]).includes(selectedDetail.invoice.status) ? (
                    <Button onClick={submitMatch} disabled={runMatch.isPending || !matchAllocations.length}>
                      <GitCompareArrows aria-hidden className="size-4" /> {runMatch.isPending ? ACTION_LABELS.saving : "تشغيل المطابقة الثلاثية"}
                    </Button>
                  ) : null}
                </section>
              ) : null}

              {selectedDetail.approvals.length ? (
                <section className="rounded-md border p-3 text-sm">
                  <strong>سجل طلبات القرار</strong>
                  <div className="mt-2 space-y-2">{selectedDetail.approvals.map((approval) => <div key={approval.id} className="rounded border bg-muted/20 p-2">طلب #{Number(approval.id)} · {approval.kind} · {approval.status} · {approval.reason}</div>)}</div>
                </section>
              ) : null}

              {draftGovernance.data?.revisions.length ? (
                <section className="rounded-md border p-3 text-sm">
                  <strong>سجل مراجعات المسودة غير القابل للمحو</strong>
                  <div className="mt-2 space-y-2">
                    {draftGovernance.data.revisions.map((revision) => (
                      <div key={revision.id} className="rounded border bg-muted/20 p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>مراجعة {Number(revision.revisionNo)} · {revision.action === "UPDATE_DRAFT" ? "تعديل" : "إلغاء"}</span>
                          <span>{fmtDateTime(revision.actedAt)}</span>
                        </div>
                        <div>{revision.reason}</div>
                        <div className="text-xs text-muted-foreground">نسخة {Number(revision.baseVersion)} ← {Number(revision.resultVersion)} · منفذ #{Number(revision.actedBy)}</div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}
          <DialogFooter className="flex-wrap">
            <Button variant="outline" onClick={() => setSelectedInvoiceId(0)}>إغلاق</Button>
            {canManage && selectedDetail?.invoice.status === "DRAFT" && draftGovernance.data?.state === "ACTIVE" ? (
              <Button variant="outline" onClick={() => openDraftEditor(selectedDetail)}><Pencil aria-hidden className="size-4" /> تعديل المسودة</Button>
            ) : null}
            {canManage && selectedDetail?.invoice.status === "DRAFT" && draftGovernance.data?.state === "ACTIVE" ? (
              <Button variant="destructive" onClick={() => { setVoidReason(""); voidKey.current = crypto.randomUUID(); setVoidOpen(true); }}><Ban aria-hidden className="size-4" /> إلغاء المسودة</Button>
            ) : null}
            {canManage && draftIsActive && selectedDetail?.invoice.status === "MATCHED" && latestMatch && latestMatch.outcome !== "HOLD" && !hasPendingRequest ? (
              <Button onClick={() => openRequest("POST_INVOICE")}><ShieldCheck aria-hidden className="size-4" /> طلب ترحيل</Button>
            ) : null}
            {canManage && selectedDetail?.invoice.status === "POSTED" && !hasPendingRequest ? (
              <Button variant="destructive" onClick={() => openRequest("REVERSE_INVOICE")}><Undo2 aria-hidden className="size-4" /> طلب عكس الفاتورة</Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={(open) => { if (!open && !updateDraft.isPending) setEditOpen(false); }}>
        <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تعديل مسودة فاتورة المورد بمراجعة جديدة</DialogTitle>
            <DialogDescription>لا يُستبدل السجل السابق. يحفظ النظام قبل/بعد والبصمتين والسبب والفاعل، وتفشل العملية إذا تغيرت النسخة.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1 md:col-span-2"><Label htmlFor="supplier-edit-reason">سبب التعديل</Label><Textarea id="supplier-edit-reason" value={editReason} maxLength={500} onChange={(event) => setEditReason(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="supplier-edit-external-number">رقم فاتورة المورد</Label><Input id="supplier-edit-external-number" value={editExternalNumber} maxLength={160} onChange={(event) => setEditExternalNumber(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="supplier-edit-date">تاريخ الفاتورة</Label><Input id="supplier-edit-date" type="date" value={editInvoiceDate} onChange={(event) => setEditInvoiceDate(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="supplier-edit-due-date">تاريخ الاستحقاق</Label><Input id="supplier-edit-due-date" type="date" value={editDueDate} onChange={(event) => setEditDueDate(event.target.value)} /></div>
            {selectedDetail?.invoice.currency === "USD" ? <div className="space-y-1"><Label>سعر التثبيت</Label><MoneyInput value={editAgreedRate} decimals={4} onChange={setEditAgreedRate} /></div> : null}
            <div className="space-y-1"><Label>الضريبة</Label><MoneyInput value={editTaxAmount} onChange={setEditTaxAmount} /></div>
            <div className="space-y-1"><Label>الخصم</Label><MoneyInput value={editDiscountAmount} onChange={setEditDiscountAmount} /></div>
            <div className="space-y-1"><Label htmlFor="supplier-edit-evidence-type">نوع الدليل</Label><AppSelect id="supplier-edit-evidence-type" value={editEvidenceType} onValueChange={(value) => setEditEvidenceType(value as EvidenceType)}><option value="DOCUMENT_IMAGE">صورة مستند</option><option value="PDF">ملف PDF</option><option value="EMAIL">بريد إلكتروني</option><option value="EDI">تبادل إلكتروني EDI</option><option value="OTHER">دليل آخر</option></AppSelect></div>
            <div className="space-y-1"><Label htmlFor="supplier-edit-evidence">مرجع الدليل</Label><Input id="supplier-edit-evidence" value={editEvidenceReference} maxLength={500} onChange={(event) => setEditEvidenceReference(event.target.value)} /></div>
          </div>
          <div className="space-y-2">
            {editLines.map((line, index) => (
              <section key={line.purchaseOrderRevisionItemId} className="grid gap-3 rounded-md border p-3 md:grid-cols-3">
                <div className="space-y-1"><Label>وصف البند</Label><Input value={line.description} maxLength={500} onChange={(event) => setEditLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, description: event.target.value } : candidate))} /></div>
                <div className="space-y-1"><Label>الكمية بالأساس</Label><Input type="number" min={1} step={1} value={line.invoicedBaseQuantity} onChange={(event) => setEditLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, invoicedBaseQuantity: positiveInteger(event.target.value) } : candidate))} /></div>
                <div className="space-y-1"><Label>سعر وحدة المستند</Label><MoneyInput value={line.unitPrice} decimals={selectedDetail?.invoice.currency === "USD" ? 4 : 2} onChange={(value) => setEditLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, unitPrice: value } : candidate))} /></div>
              </section>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={updateDraft.isPending}>تراجع</Button>
            <Button onClick={submitDraftUpdate} disabled={updateDraft.isPending}>{updateDraft.isPending ? ACTION_LABELS.saving : "حفظ مراجعة التعديل"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={voidOpen} onOpenChange={(open) => { if (!open && !voidDraft.isPending) setVoidOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>إلغاء مسودة فاتورة المورد</DialogTitle>
            <DialogDescription>لا يحذف الإلغاء المستند. ينشئ مراجعة VOID ثابتة ويغلق المطابقة والترحيل عليه.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1"><Label htmlFor="supplier-void-reason">سبب الإلغاء</Label><Textarea id="supplier-void-reason" value={voidReason} maxLength={500} onChange={(event) => setVoidReason(event.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoidOpen(false)} disabled={voidDraft.isPending}>تراجع</Button>
            <Button variant="destructive" onClick={submitVoidDraft} disabled={voidDraft.isPending}>{voidDraft.isPending ? ACTION_LABELS.saving : "إلغاء المسودة وحفظ الدليل"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={requestKind != null} onOpenChange={(open) => { if (!open && !requestApproval.isPending) setRequestKind(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{requestKind === "POST_INVOICE" ? "طلب ترحيل فاتورة المورد" : "طلب عكس فاتورة المورد"}</DialogTitle>
            <DialogDescription>الطلب صفري الأثر. لا تتغير الذمة أو GRNI أو حالة الفاتورة قبل قرار مستخدم مستقل.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1"><Label htmlFor="supplier-request-reason">سبب الطلب</Label><Textarea id="supplier-request-reason" value={requestReason} maxLength={500} onChange={(event) => setRequestReason(event.target.value)} /></div>
          {requestKind === "REVERSE_INVOICE" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="supplier-request-evidence-type">نوع دليل العكس</Label><AppSelect id="supplier-request-evidence-type" value={requestEvidenceType} onValueChange={(value) => setRequestEvidenceType(value as ApprovalEvidenceType)}><option value="DOCUMENT_IMAGE">صورة مستند</option><option value="PDF">ملف PDF</option><option value="EMAIL">بريد إلكتروني</option><option value="SIGNED_APPROVAL">موافقة موقعة</option><option value="OTHER">دليل آخر</option></AppSelect></div>
              <div className="space-y-1"><Label htmlFor="supplier-request-evidence-reference">مرجع دليل العكس</Label><Input id="supplier-request-evidence-reference" value={requestEvidenceReference} maxLength={500} onChange={(event) => setRequestEvidenceReference(event.target.value)} /></div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequestKind(null)} disabled={requestApproval.isPending}>تراجع</Button>
            <Button variant={requestKind === "REVERSE_INVOICE" ? "destructive" : "default"} onClick={submitRequest} disabled={requestApproval.isPending}>
              {requestApproval.isPending ? ACTION_LABELS.saving : "إرسال الطلب للمراجعة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={decisionTarget != null} onOpenChange={(open) => { if (!open && !decideApproval.isPending) setDecisionTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{decisionAction === "APPROVE" ? "اعتماد قرار فاتورة المورد" : "رفض طلب فاتورة المورد"}</DialogTitle>
            <DialogDescription>الخادم يتحقق أن المراجع ليس منشئ الفاتورة أو طالب القرار، وأن منفذ المطابقة لا يعتمد ترحيلها.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/20 p-3 text-sm">{decisionTarget?.reason}</div>
          {decisionTarget?.evidenceReference ? <div className="break-all rounded-md border p-3 text-sm">الدليل: {decisionTarget.evidenceReference}</div> : null}
          <div className="space-y-1"><Label htmlFor="supplier-decision-reason">سبب القرار</Label><Textarea id="supplier-decision-reason" value={decisionReason} maxLength={500} onChange={(event) => setDecisionReason(event.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecisionTarget(null)} disabled={decideApproval.isPending}>تراجع</Button>
            <Button variant={decisionAction === "APPROVE" ? "default" : "destructive"} onClick={submitDecision} disabled={decideApproval.isPending}>
              {decideApproval.isPending ? ACTION_LABELS.saving : decisionAction === "APPROVE" ? "اعتماد وتنفيذ" : "رفض الطلب"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
