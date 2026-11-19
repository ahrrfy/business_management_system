import { type ImageItem } from "@/components/form/ImageUploader";
import { useSessionContext } from "@/hooks/useSessionContext";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { treasuryOperationAllowed } from "@/lib/treasuryOperationAccess";
import { usePrintAudit } from "@/hooks/usePrintAudit";
import { isInboundPaymentMethodEnabled } from "@shared/inboundPaymentPolicy";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { isVoucherCategoryRoleCompatible } from "@shared/voucherCategoryAccounting";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import type { SupplierReceiptPurpose } from "@shared/balanceTrail";
import { VoucherFormProps, MethodValue } from "./voucherFormTypes";

export function useVoucherFormState(props: VoucherFormProps) {
  const {
    voucherType,
    embedded = false,
    initialPartyType,
    initialPartyId,
    initialAmount,
    initialCurrentBalance,
    initialPendingReserved,
    onSubmitted,
    onCancel,
  } = props;

  const [, navigate] = useLocation();

  const search = useSearch();

  const utils = trpc.useUtils();

  const printAudit = usePrintAudit();

  const isReceipt = voucherType === "RECEIPT";

  const direction: "IN" | "OUT" = isReceipt ? "IN" : "OUT";

  const me = trpc.auth.me.useQuery();

  const canCreate = treasuryOperationAllowed(me.data, "vouchers.create", true);

  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";

  // الفرع: استنتاجٌ خادميّ عبر `<InferredBranchField>` (م٤ ق١) — تبدأ `null` عمداً: كان
  // `useState<number>(1)` «الفرع ١ مكتوباً بيد» (بابُ IDOR الذي يحرسه `check:branch`).
  const [branchId, setBranchId] = useState<number | null>(null);

  const session = useSessionContext();

  const businessDay = session.context?.businessDay ?? null;

  const [amount, setAmount] = useState(initialAmount ?? "");

  const [method, setMethod] = useState<MethodValue>("CASH");

  useEffect(() => {
    // fail-closed على المجهول فقط: أيّ طريقةٍ خارج سياسة القبض تعود نقداً.
    if (!isInboundPaymentMethodEnabled(method)) {
      setMethod("CASH");
      setReferenceNumber("");
      setCardLastFour("");
    }
  }, [method]);

  const queryParams = new URLSearchParams(search);
  const queryPartyId = Number(queryParams.get("partyId")) || null;
  const seededCustomerId =
    initialPartyType === "CUSTOMER"
      ? (initialPartyId ?? null)
      : queryParams.get("customerId")
        ? Number(queryParams.get("customerId")) || null
        : queryParams.get("partyType") === "CUSTOMER"
          ? queryPartyId
          : null;
  const seededSupplierId =
    initialPartyType === "SUPPLIER"
      ? (initialPartyId ?? null)
      : queryParams.get("supplierId")
        ? Number(queryParams.get("supplierId")) || null
        : queryParams.get("partyType") === "SUPPLIER"
          ? queryPartyId
          : null;
  const seededDeliveryPartyId =
    initialPartyType === "DELIVERY_PARTY"
      ? (initialPartyId ?? null)
      : queryParams.get("partyType") === "DELIVERY_PARTY"
        ? queryPartyId
        : null;
  const seededPartyType: "CUSTOMER" | "SUPPLIER" | "DELIVERY_PARTY" | "OTHER" =
    initialPartyType ??
    (seededCustomerId
      ? "CUSTOMER"
      : seededSupplierId || queryParams.get("partyType") === "SUPPLIER"
        ? "SUPPLIER"
        : seededDeliveryPartyId || queryParams.get("partyType") === "DELIVERY_PARTY"
          ? "DELIVERY_PARTY"
          : "OTHER");

  const [partyType, setPartyType] = useState<
    "CUSTOMER" | "SUPPLIER" | "DELIVERY_PARTY" | "OTHER"
  >(seededPartyType);

  const [customerId, setCustomerId] = useState<number | null>(seededCustomerId);

  const [supplierId, setSupplierId] = useState<number | null>(seededSupplierId);

  const advanceRefundScope = `${voucherType}:${branchId ?? ""}:${partyType}:${supplierId ?? ""}`;
  const [advanceRefundSelection, setAdvanceRefundSelection] = useState<{
    scope: string;
    receiptId: number;
  } | null>(null);
  const [receiptPurposeSelection, setReceiptPurposeSelection] = useState<{
    scope: string;
    purpose: SupplierReceiptPurpose;
  } | null>(null);
  const [allowOverpaySelection, setAllowOverpaySelection] = useState<string | null>(null);
  const allowSupplierOverpay = allowOverpaySelection === advanceRefundScope;
  function setAllowSupplierOverpay(next: boolean) {
    setAllowOverpaySelection(next ? advanceRefundScope : null);
  }
  const supplierAdvanceRefundReceiptId =
    advanceRefundSelection?.scope === advanceRefundScope
      ? advanceRefundSelection.receiptId
      : null;
  const supplierReceiptPurpose: SupplierReceiptPurpose =
    receiptPurposeSelection?.scope === advanceRefundScope
      ? receiptPurposeSelection.purpose
      : supplierAdvanceRefundReceiptId != null
        ? "ADVANCE_REFUND"
        : "CREDIT_OBLIGATION";
  function setSupplierAdvanceRefundReceiptId(receiptId: number | null) {
    setAdvanceRefundSelection(
      receiptId == null ? null : { scope: advanceRefundScope, receiptId },
    );
    if (receiptId != null) {
      setReceiptPurposeSelection({
        scope: advanceRefundScope,
        purpose: "ADVANCE_REFUND",
      });
    }
  }
  function setSupplierReceiptPurpose(purpose: SupplierReceiptPurpose) {
    setReceiptPurposeSelection({ scope: advanceRefundScope, purpose });
    if (purpose === "CREDIT_OBLIGATION") {
      setAdvanceRefundSelection(null);
    }
  }
  useEffect(() => {
    setAdvanceRefundSelection((current) =>
      current?.scope === advanceRefundScope ? current : null,
    );
    setReceiptPurposeSelection((current) =>
      current?.scope === advanceRefundScope ? current : null,
    );
  }, [advanceRefundScope]);

  const [deliveryPartyId, setDeliveryPartyId] = useState<number | null>(
    seededDeliveryPartyId,
  );

  const [description, setDescription] = useState("");

  const [referenceNumber, setReferenceNumber] = useState("");

  const [cardLastFour, setCardLastFour] = useState("");

  // vouchers-pro:
  const [voucherCategoryId, setVoucherCategoryId] = useState<number | "">("");

  const [counterpartyName, setCounterpartyName] = useState("");

  // تاريخُ السند: يُقترَح من اليوم التشغيليّ الخادميّ (لا ساعة الجهاز) ويبقى قابلاً للتعديل.
  const [voucherDate, setVoucherDate] = useState<string>("");

  const [voucherDateTouched, setVoucherDateTouched] = useState(false);

  useEffect(() => {
    if (!voucherDateTouched && businessDay) setVoucherDate(businessDay);
  }, [businessDay, voucherDateTouched]);

  const [attachmentImages, setAttachmentImages] = useState<ImageItem[]>([]);

  const attachmentUrl = attachmentImages[0]?.dataUrl ?? "";

  const [internalNote, setInternalNote] = useState("");

  // attachment-upload (٥/٧): ربط سند العميل بفاتورة بيع مُحدَّدة (اختياري).
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const prevInvoiceBranchRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      prevInvoiceBranchRef.current != null &&
      branchId != null &&
      prevInvoiceBranchRef.current !== branchId
    ) {
      setInvoiceId(null);
    }
    if (branchId != null) {
      prevInvoiceBranchRef.current = branchId;
    }
  }, [branchId]);

  const [err, setErr] = useState("");

  const branches = trpc.branches.list.useQuery();

  // فئات السندات بحَسب اتجاه السند الحالي (IN/OUT) — تَستثني المُعطَّلة.
  const categories = trpc.voucherCategories.list.useQuery({
    includeInactive: false,
  });

  const categoryOptions = useMemo(() => {
    const list = categories.data ?? [];
    return list.filter(
      (c) => c.direction === "BOTH" || c.direction === direction,
    );
  }, [categories.data, direction]);

  const selectedCategory = categoryOptions.find(
    (category) => Number(category.id) === Number(voucherCategoryId),
  );

  const selectedCategoryReady =
    selectedCategory != null &&
    isVoucherCategoryRoleCompatible(direction, selectedCategory.postingRole);

  /** فئات صالحة فعلاً لهذا الاتجاه (نشِطة + حساب مقابل متوافق) — صفرٌ يعني طريقاً مسدوداً. */
  const readyCategoryCount = useMemo(
    () =>
      categoryOptions.filter((c) =>
        isVoucherCategoryRoleCompatible(direction, c.postingRole),
      ).length,
    [categoryOptions, direction],
  );

  // مرآة بوّابة الخادم لفئات السندات (treasuryGlobalProcedure) — إخفاء بصريّ فقط، والإنفاذ خادميّ.
  const legacyManageCategories =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "treasury",
      "FULL",
      ["manager", "accountant"],
    );

  const canManageCategories = treasuryOperationAllowed(
    me.data,
    "voucherCategories.create",
    legacyManageCategories,
  );

  const canRestoreCategories = treasuryOperationAllowed(
    me.data,
    "voucherCategories.restoreDefaults",
    legacyManageCategories,
  );

  const [showCategoryDialog, setShowCategoryDialog] = useState(false);

  const restoreDefaults = trpc.voucherCategories.restoreDefaults.useMutation({
    onSuccess: async (res) => {
      await utils.voucherCategories.list.invalidate();
      notify.ok(
        res.inserted.length || res.mapped.length
          ? `استُعيدت الفئات: +${res.inserted.length} جديدة، ${res.mapped.length} عُيّن حسابها`
          : "الفئات الافتراضية مكتملة أصلاً",
      );
    },
    onError: (e) => notify.err(e),
  });
  return {
    voucherType,
    embedded,
    initialCurrentBalance,
    initialPendingReserved,
    onSubmitted,
    onCancel,
    seededPartyType,
    seededCustomerId,
    seededSupplierId,
    seededDeliveryPartyId,
    initialAmount,
    navigate,
    search,
    utils,
    printAudit,
    isReceipt,
    direction,
    me,
    canCreate,
    isElevated,
    branchId,
    setBranchId,
    session,
    businessDay,
    amount,
    setAmount,
    method,
    setMethod,
    partyType,
    setPartyType,
    customerId,
    setCustomerId,
    supplierId,
    setSupplierId,
    supplierAdvanceRefundReceiptId,
    setSupplierAdvanceRefundReceiptId,
    supplierReceiptPurpose,
    setSupplierReceiptPurpose,
    allowSupplierOverpay,
    setAllowSupplierOverpay,
    deliveryPartyId,
    setDeliveryPartyId,
    description,
    setDescription,
    referenceNumber,
    setReferenceNumber,
    cardLastFour,
    setCardLastFour,
    voucherCategoryId,
    setVoucherCategoryId,
    counterpartyName,
    setCounterpartyName,
    voucherDate,
    setVoucherDate,
    voucherDateTouched,
    setVoucherDateTouched,
    attachmentImages,
    setAttachmentImages,
    attachmentUrl,
    internalNote,
    setInternalNote,
    invoiceId,
    setInvoiceId,
    err,
    setErr,
    branches,
    categories,
    categoryOptions,
    selectedCategory,
    selectedCategoryReady,
    readyCategoryCount,
    legacyManageCategories,
    canManageCategories,
    canRestoreCategories,
    showCategoryDialog,
    setShowCategoryDialog,
    restoreDefaults,
  };
}
