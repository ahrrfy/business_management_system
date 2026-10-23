import { useOperationPermission } from "@/hooks/useOperationPermission";
/**
 * SalesReturnPortal — المنفذ الأول: مرتجعات المبيعات (العملاء والتجزئة)
 *
 * يشمل:
 *  - مسح الباركود السريع وسلة المنتجات التفاعلية
 *  - الفاتورة الأصلية (اختيارية) مع زر فحص
 *  - العميل المرتبط بـ CRM (ذكي واختياري)
 *  - المسار المخزني للصنف: رجوع للرف (Restock) أو تالف مسجل خسارة (Damaged)
 *  - طرق الاسترداد المالي: نقدي (درج الكاشير)، بطاقة، أو رصيد متجر
 *  - طباعة حرارية فورية 80مم/58مم
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { D } from "@/lib/money";
import { invalidateFinancialQueries } from "@/lib/realtime/financialQueries";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  SalesReturnPortalProps,
  SalesCartItem,
  InspectedInvoice,
} from "./salesReturnPortalTypes";

export function useSalesReturnState(props: SalesReturnPortalProps) {
  const { initialInvoiceNo, initialMode, onReturnSuccess } = props;

  const utils = trpc.useUtils();

  const queryClient = useQueryClient();

  const me = trpc.auth.me.useQuery();

  const operationPermission = useOperationPermission(
    "returns.executeSalesReturnCart",
  );

  const controlWithdrawPermission = useOperationPermission(
    "salesControl.withdraw",
  );

  const legacyWithdrawPermission = useOperationPermission(
    "returns.withdrawRequest",
  );

  const [clientRequestId, setClientRequestId] = useState(() =>
    crypto.randomUUID(),
  );

  const branches = trpc.branches.list.useQuery();

  const activeBranchId = me.data?.branchId
    ? Number(me.data.branchId)
    : Number(branches.data?.[0]?.id || 1);

  const [salesInvoiceNo, setSalesInvoiceNo] = useState(initialInvoiceNo ?? "");

  const debouncedInvoiceNo = useDebouncedValue(salesInvoiceNo.trim(), 400);

  const [salesCustomerName, setSalesCustomerName] = useState("");

  const [salesCustomerPhone, setSalesCustomerPhone] = useState("");

  const [salesCustomerId, setSalesCustomerId] = useState<number | null>(null);

  const [lastAddedId, setLastAddedId] = useState<string | null>(null);

  const [salesCustomerSearch, setSalesCustomerSearch] = useState("");

  const debouncedCustomerSearch = useDebouncedValue(
    salesCustomerSearch.trim(),
    300,
  );

  const customersQuery = trpc.customers.smartSearch.useQuery(
    { q: debouncedCustomerSearch, limit: 6 },
    { enabled: debouncedCustomerSearch.length >= 2 },
  );

  const [salesDisposition, setSalesDisposition] = useState<
    "RESTOCK" | "DAMAGED"
  >("RESTOCK");

  const [salesBarcode, setSalesBarcode] = useState("");

  const [salesCart, setSalesCart] = useState<SalesCartItem[]>([]);

  const [salesRefundMethod, setSalesRefundMethod] = useState<
    "CASH" | "CARD" | "STORE_CREDIT" | "CREDIT_OFFSET"
  >("CASH");

  const [salesCardRef, setSalesCardRef] = useState("");

  const [salesReason, setSalesReason] = useState("");

  const openDrawersQ = trpc.returns.getOpenRefundDrawers.useQuery(undefined, {
    refetchInterval: false,
  });

  const openDrawers = openDrawersQ.data ?? [];

  const [selectedShiftId, setSelectedShiftId] = useState<number | null>(null);

  useEffect(() => {
    if (openDrawers.length > 0 && selectedShiftId == null) {
      const mine = openDrawers.find((d) => d.isMine);
      if (mine) {
        setSelectedShiftId(mine.shiftId);
      } else {
        setSelectedShiftId(openDrawers[0].shiftId);
      }
    }
  }, [openDrawers, selectedShiftId]);

  const salesBarcodeRef = useRef<HTMLInputElement>(null);

  const [inspectionSelection, setInspectedInvoice] =
    useState<InspectedInvoice | null>(null);

  const currentInspection = trpc.returns.inspectInvoiceForReturn.useQuery(
    { invoiceNumber: inspectionSelection?.invoiceNumber ?? "" },
    { enabled: inspectionSelection != null },
  );

  const inspectedInvoice = inspectionSelection
    ? (currentInspection.data ?? inspectionSelection)
    : null;

  const invoiceState = trpc.returns.getInvoice.useQuery(
    { invoiceId: inspectedInvoice?.id ?? 0 },
    { enabled: inspectedInvoice != null },
  );

  const pending = invoiceState.data?.pendingRequest ?? null;

  useEffect(() => {
    setClientRequestId(crypto.randomUUID());
  }, [inspectedInvoice?.id]);

  const withdrawControl = trpc.salesControl.withdraw.useMutation();

  const withdrawLegacy = trpc.returns.withdrawRequest.useMutation();

  const withdrawing = withdrawControl.isPending || withdrawLegacy.isPending;

  const canWithdraw =
    pending?.isMine &&
    (pending.source === "CONTROL"
      ? controlWithdrawPermission.allowed
      : legacyWithdrawPermission.allowed);

  const invoiceStateBlockReason = !inspectedInvoice
    ? null
    : currentInspection.error
      ? currentInspection.error.message
      : !currentInspection.data
        ? "جارٍ التحقق من قيم الفاتورة الحالية…"
        : inspectionSelection?.id !== inspectedInvoice.id
          ? "تغيّرت نسخة الفاتورة؛ أعد فحصها لتحميل البنود الحالية."
          : salesCart.some((line) => {
                const item = inspectedInvoice.items.find(
                  (item) => item.invoiceItemId === line.invoiceItemId,
                );
                const selectedItem = inspectionSelection?.items.find(
                  (item) => item.invoiceItemId === line.invoiceItemId,
                );
                return (
                  !item ||
                  line.quantity > item.remainingQuantity ||
                  !selectedItem ||
                  !D(
                    selectedItem.effectiveUnitPrice || selectedItem.unitPrice,
                  ).eq(item.effectiveUnitPrice || item.unitPrice)
                );
              })
            ? "تغيّرت بنود الفاتورة؛ أعد فحصها وراجع الكميات والأسعار قبل تأكيد المرتجع."
            : !invoiceState.data
              ? (invoiceState.error?.message ??
                "جارٍ التحقق من حالة الفاتورة وطلباتها…")
              : invoiceState.data.id !== inspectedInvoice.id
                ? "تغيّرت نسخة الفاتورة؛ أعد فحصها لتحميل البنود الحالية."
                : pending
                  ? `يوجد طلب معلّق #${pending.id}؛ عالجه قبل تنفيذ مرتجع جديد.`
                  : null;

  async function withdrawPending() {
    if (!pending?.isMine || !canWithdraw) return;
    if (
      !(await confirm({
        title: `سحب طلبي #${pending.id}`,
        description:
          "يُغلق الطلب السابق بلا حركة مال أو مخزون، ثم يمكنك مراجعة المرتجع الحالي وتنفيذه.",
        confirmText: "سحب طلبي",
        variant: "warning",
      }))
    )
      return;
    try {
      await (
        pending.source === "CONTROL" ? withdrawControl : withdrawLegacy
      ).mutateAsync({
        requestId: pending.id,
        reason: "سحب الطالب لإعادة إعداد المرتجع",
      });
      setClientRequestId(crypto.randomUUID());
      await invalidateFinancialQueries(queryClient, inspectedInvoice?.branchId);
      notify.ok("سُحب طلبك السابق؛ راجع المرتجع ثم أكّد تنفيذه.");
    } catch (error) {
      notify.err(error);
    }
  }
  return {
    initialInvoiceNo,
    initialMode,
    onReturnSuccess,
    utils,
    queryClient,
    me,
    operationPermission,
    controlWithdrawPermission,
    legacyWithdrawPermission,
    clientRequestId,
    setClientRequestId,
    branches,
    activeBranchId,
    salesInvoiceNo,
    setSalesInvoiceNo,
    debouncedInvoiceNo,
    salesCustomerName,
    setSalesCustomerName,
    salesCustomerPhone,
    setSalesCustomerPhone,
    salesCustomerId,
    setSalesCustomerId,
    lastAddedId,
    setLastAddedId,
    salesCustomerSearch,
    setSalesCustomerSearch,
    debouncedCustomerSearch,
    customersQuery,
    salesDisposition,
    setSalesDisposition,
    salesBarcode,
    setSalesBarcode,
    salesCart,
    setSalesCart,
    salesRefundMethod,
    setSalesRefundMethod,
    salesCardRef,
    setSalesCardRef,
    salesReason,
    setSalesReason,
    openDrawersQ,
    openDrawers,
    selectedShiftId,
    setSelectedShiftId,
    salesBarcodeRef,
    inspectionSelection,
    setInspectedInvoice,
    currentInspection,
    inspectedInvoice,
    invoiceState,
    pending,
    withdrawControl,
    withdrawLegacy,
    withdrawing,
    canWithdraw,
    invoiceStateBlockReason,
    withdrawPending,
  };
}
