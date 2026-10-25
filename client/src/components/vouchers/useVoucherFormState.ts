import { type ImageItem } from "@/components/form/ImageUploader";
import { useSessionContext } from "@/hooks/useSessionContext";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { treasuryOperationAllowed } from "@/lib/treasuryOperationAccess";
import { usePrintAudit } from "@/hooks/usePrintAudit";
import { isInboundPaymentMethodEnabled } from "@shared/inboundPaymentPolicy";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { isVoucherCategoryRoleCompatible } from "@shared/voucherCategoryAccounting";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { VoucherFormProps, MethodValue } from "./voucherFormTypes";

export function useVoucherFormState(props: VoucherFormProps) {
  const { voucherType } = props;

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

  const [amount, setAmount] = useState("");

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
  const seededCustomerId = isReceipt
    ? Number(queryParams.get("customerId")) || null
    : null;
  const seededSupplierId =
    !isReceipt &&
    (queryParams.get("partyType") === "SUPPLIER" ||
      queryParams.has("supplierId"))
      ? Number(queryParams.get("partyId") || queryParams.get("supplierId")) ||
        null
      : null;

  const [partyType, setPartyType] = useState<
    "CUSTOMER" | "SUPPLIER" | "DELIVERY_PARTY" | "OTHER"
  >(
    seededCustomerId
      ? "CUSTOMER"
      : seededSupplierId ||
          (!isReceipt && queryParams.get("partyType") === "SUPPLIER")
        ? "SUPPLIER"
        : "OTHER",
  );

  const [customerId, setCustomerId] = useState<number | null>(seededCustomerId);

  const [supplierId, setSupplierId] = useState<number | null>(seededSupplierId);

  const [deliveryPartyId, setDeliveryPartyId] = useState<number | null>(null);

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
    seededCustomerId,
    partyType,
    setPartyType,
    customerId,
    setCustomerId,
    supplierId,
    setSupplierId,
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
