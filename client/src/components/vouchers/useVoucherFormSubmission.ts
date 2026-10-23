import { useVoucherPrintAfterCreate } from "./useVoucherPrintAfterCreate";
import { useVoucherFormShortcuts } from "./useVoucherFormShortcuts";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";

import {
  releaseReservedPrintWindow,
  reservePrintWindow,
} from "@/lib/printing/brand";
import { trpc } from "@/lib/trpc";
import { useUnsavedGuard, bypassUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { paymentMethodCompact } from "@shared/terms";

import { useMemo, useRef, useState } from "react";
import { voucherCreateSuccessMessage } from "@/components/vouchers/voucherUiPolicy";
import { VoucherFormProps } from "./voucherFormTypes";
import type { useVoucherFormState } from "./useVoucherFormState";
import type { useVoucherFormQueries } from "./useVoucherFormQueries";
export function useVoucherFormSubmission(
  ctx: Pick<
    ReturnType<typeof useVoucherFormState> &
      ReturnType<typeof useVoucherFormQueries> &
      VoucherFormProps,
    | "navigate"
    | "utils"
    | "branches"
    | "printAudit"
    | "isReceipt"
    | "direction"
    | "canCreate"
    | "branchId"
    | "amount"
    | "method"
    | "seededCustomerId"
    | "partyType"
    | "customerId"
    | "supplierId"
    | "deliveryPartyId"
    | "description"
    | "referenceNumber"
    | "cardLastFour"
    | "voucherCategoryId"
    | "counterpartyName"
    | "voucherDate"
    | "attachmentImages"
    | "attachmentUrl"
    | "internalNote"
    | "invoiceId"
    | "setErr"
    | "selectedCategoryReady"
    | "customerData"
    | "supplierData"
    | "hardBlock"
    | "voucherType"
  >,
) {
  const {
    navigate,
    utils,
    isReceipt,
    direction,
    canCreate,
    branchId,
    amount,
    method,
    seededCustomerId,
    partyType,
    customerId,
    supplierId,
    deliveryPartyId,
    description,
    referenceNumber,
    cardLastFour,
    voucherCategoryId,
    counterpartyName,
    voucherDate,
    attachmentImages,
    attachmentUrl,
    internalNote,
    invoiceId,
    setErr,
    selectedCategoryReady,
    customerData,
    supplierData,
    hardBlock,
    voucherType,
  } = ctx;

  const { pendingPrintRef, setPendingPrintRef, tryPrintAfterCreate } =
    useVoucherPrintAfterCreate(ctx);
  // idempotency: مفتاح ثابت لكل سند (الصفحة تنتقل بعد النجاح فيتجدّد) ⇒ نقرة مزدوجة لا تُنشئ سندين.
  const [clientRequestId] = useState(() => crypto.randomUUID());

  const create = trpc.vouchers.create.useMutation({
    onSuccess: async (res) => {
      notify.ok(
        voucherCreateSuccessMessage({
          direction,
          voucherNumber: res.voucherNumber,
          approvalStatus: res.approvalStatus,
        }),
      );
      await Promise.all([
        utils.vouchers.list.invalidate(),
        utils.vouchers.aggregate.invalidate(),
        ...(direction === "OUT" && partyType === "SUPPLIER"
          ? [
              utils.suppliers.invalidate(),
              utils.purchases.invalidate(),
              utils.supplierPayments.invalidate(),
              utils.reports.supplierStatement.invalidate(),
            ]
          : []),
      ]);
      // OUT لا يطبع وثيقة رسمية عند إنشاء الطلب. IN يطبع بعد نجاحه الفوري فقط.
      if (isReceipt && pendingPrintRef && res.approvalStatus === "APPROVED") {
        await tryPrintAfterCreate(res.receiptId);
      } else if (pendingPrintRef && res.approvalStatus !== "APPROVED") {
        if (pendingPrintRef === "a4") releaseReservedPrintWindow();
        notify.err(
          "حُفظ الطلب بلا أثر مالي؛ تتاح الطباعة الرسمية بعد الاعتماد والتنفيذ.",
        );
      }
      bypassUnsavedGuard();
      navigate("/vouchers");
    },
    onError: (e) => {
      if (pendingPrintRef === "a4") releaseReservedPrintWindow();
      setPendingPrintRef(null);
      setErr(e.message);
    },
  });

  // الحَفظ + الطَباعة الفورية — نَحفظ مرجع طلب الطباعة.

  const submitColor = isReceipt
    ? "bg-[var(--sem-pos)] text-background hover:bg-[var(--sem-pos-hover)]"
    : "bg-[var(--sem-neg)] text-background hover:bg-[var(--sem-neg-hover)]";

  function validate(): string {
    if (branchId == null)
      return "الفرع غير محدَّد — اختر الفرع من القائمة قبل الحفظ (لا فرعَ افتراضيّ).";
    if (!voucherDate) return "تاريخ السند مطلوب.";
    if (
      !amount.trim() ||
      !/^\d+(\.\d{1,2})?$/.test(amount.trim()) ||
      Number(amount) <= 0
    ) {
      return "المبلغ مطلوب (موجب، منزلتان عشريتان).";
    }
    if (!description.trim()) return "وصف السند مطلوب.";
    if (partyType === "CUSTOMER" && !customerId)
      return "اختر العميل المرتبط بالسند.";
    if (partyType === "SUPPLIER" && !supplierId)
      return "اختر المورّد المرتبط بالسند.";
    if (partyType === "DELIVERY_PARTY" && !deliveryPartyId)
      return "اختر جهة التوصيل المرتبطة بالسند.";
    if (partyType === "OTHER" && voucherCategoryId === "") {
      return "فئة محاسبية معيّنة إلزامية لسندات «أخرى».";
    }
    if (partyType === "OTHER" && !selectedCategoryReady) {
      return "الفئة المختارة بلا حساب مقابل صالح؛ عيّن الحساب من إدارة الفئات أولاً.";
    }
    if (method === "TRANSFER" && !referenceNumber.trim()) {
      return "الرقم المرجعي إلزامي لطريقة الدفع «تحويل».";
    }
    if (method === "CARD" && !/^\d{4}$/.test(cardLastFour.trim())) {
      return "آخر 4 من البطاقة إلزامي لطريقة الدفع «بطاقة» (4 أرقام).";
    }
    return "";
  }

  function buildPayload() {
    const partyId =
      partyType === "CUSTOMER"
        ? customerId
        : partyType === "SUPPLIER"
          ? supplierId
          : partyType === "DELIVERY_PARTY"
            ? deliveryPartyId
            : null;
    return {
      voucherType,
      // `validate()` يرفض الحفظَ بلا فرع؛ الشاشةُ تُرسل ما عرضته حرفياً — لا انزلاق بين المعروض والمُرسَل.
      branchId: branchId ?? undefined,
      amount: amount.trim(),
      paymentMethod: method,
      partyType,
      partyId,
      description: description.trim(),
      referenceNumber: referenceNumber.trim() || null,
      // لا صكوك في الإنشاء (قرار المالك) — الحقل يبقى بالعقد للسجلات التاريخية فقط.
      checkNumber: null,
      cardLastFour: method === "CARD" ? cardLastFour.trim() || null : null,
      voucherCategoryId:
        voucherCategoryId === "" ? null : Number(voucherCategoryId),
      counterpartyName: counterpartyName.trim() || null,
      voucherDate,
      attachmentUrl: attachmentUrl.trim() || null,
      internalNote: internalNote.trim() || null,
      invoiceId: partyType === "CUSTOMER" ? invoiceId : null,
      clientRequestId,
    };
  }

  const partyDisplayName = useMemo(() => {
    if (partyType === "CUSTOMER") return customerData.data?.name || "العميل";
    if (partyType === "SUPPLIER") return supplierData.data?.name || "المورّد";
    if (partyType === "DELIVERY_PARTY") return "شركة التوصيل";
    return counterpartyName.trim() || "الطرف المحدد";
  }, [
    partyType,
    customerData.data?.name,
    supplierData.data?.name,
    counterpartyName,
  ]);

  async function submit(printAfter: "thermal" | "a4" | null = null) {
    if (!canCreate || create.isPending || hardBlock) return;
    setErr("");
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    if (isReceipt && printAfter === "a4" && !reservePrintWindow()) {
      notify.err("تعذّر فتح نافذة الطباعة — تحقّق من مانع النوافذ المنبثقة");
      return;
    }

    const formattedAmount = fmt(amount.trim());
    const methodLabel = paymentMethodCompact(method);
    const isOut = direction === "OUT";

    const title = isOut ? "تأكيد سند الصرف" : "تأكيد سند القبض";
    const description = isOut
      ? `سيُسجَّل سند صرف بمبلغ ${formattedAmount} د.ع لصالح «${partyDisplayName}» بطريقة «${methodLabel}» ويُحال للاعتماد والتنفيذ المالي. هل تؤكد العملية؟`
      : `سيُسجَّل سند قبض بمبلغ ${formattedAmount} د.ع من «${partyDisplayName}» بطريقة «${methodLabel}» وتُثبَّت الحركة المالية في الدفتر. هل تؤكد العملية؟`;
    const confirmText = isOut ? "تأكيد الصرف" : "تأكيد القبض";

    const ok = await confirm({
      variant: isOut ? "warning" : "info",
      title,
      description,
      confirmText,
      cancelText: "تراجع",
    });
    if (!ok) {
      if (isReceipt && printAfter === "a4") releaseReservedPrintWindow();
      return;
    }

    // حارس تجربة مستخدم فقط: سند الصرف المعلّق لا يطلب طباعة رسمية.
    setPendingPrintRef(isReceipt ? printAfter : null);
    create.mutate(buildPayload());
  }

  // حارس فقدان البيانات (نمط ExpenseNew): dirty عند إدخال فعليّ فقط — العميل المُمرَّر من URL
  // (seededCustomerId) لا يُحسب إدخالاً كي لا يظهر تحذير كاذب فور فتح الشاشة.
  const isDirty =
    amount.trim() !== "" ||
    description.trim() !== "" ||
    counterpartyName.trim() !== "" ||
    internalNote.trim() !== "" ||
    referenceNumber.trim() !== "" ||
    attachmentImages.length > 0 ||
    supplierId != null ||
    (customerId != null && customerId !== seededCustomerId);

  useUnsavedGuard(isDirty);

  // Esc/زر الإلغاء: تأكيد قبل مغادرة نموذج غير محفوظ (كان Esc يُغادر فوراً فيمسح المُدخلات).
  const leaveBusyRef = useRef(false);

  async function requestCancel() {
    if (create.isPending) return;
    if (!isDirty) {
      navigate("/vouchers");
      return;
    }
    // Esc داخل حوار التأكيد نفسه يصل لهذا المعالج أيضاً — الحارس يمنع فتح حوارٍ ثانٍ.
    if (leaveBusyRef.current) return;
    leaveBusyRef.current = true;
    try {
      const ok = await confirm({
        variant: "warning",
        title: "مغادرة السند",
        description:
          "توجد بيانات غير محفوظة في النموذج — ستُفقد عند المغادرة. هل تتابع؟",
        confirmText: "مغادرة",
        cancelText: "بقاء",
      });
      if (ok) {
        bypassUnsavedGuard();
        navigate("/vouchers");
      }
    } finally {
      leaveBusyRef.current = false;
    }
  }

  useVoucherFormShortcuts({ isReceipt, submit, requestCancel });
  return {
    clientRequestId,
    create,
    pendingPrintRef,
    setPendingPrintRef,
    tryPrintAfterCreate,
    submitColor,
    validate,
    buildPayload,
    partyDisplayName,
    submit,
    isDirty,
    leaveBusyRef,
    requestCancel,
  };
}
