import {
  voucherInvoiceEligible,
  voucherInvoiceRemaining as invoiceRemaining,
} from "./voucherInvoiceAllocation";
import { fmt, moneyInput } from "@/lib/money";
import { skipToken } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useMemo, useState } from "react";
import { voucherCashUiPolicy } from "@/components/vouchers/voucherUiPolicy";
import type { useVoucherFormState } from "./useVoucherFormState";
export function useVoucherFormQueries(
  ctx: Pick<
    ReturnType<typeof useVoucherFormState>,
    | "isReceipt"
    | "direction"
    | "isElevated"
    | "branchId"
    | "amount"
    | "method"
    | "partyType"
    | "customerId"
    | "supplierId"
    | "supplierAdvanceRefundReceiptId"
    | "deliveryPartyId"
    | "counterpartyName"
    | "invoiceId"
  >,
) {
  const {
    isReceipt,
    direction,
    isElevated,
    branchId,
    amount,
    method,
    partyType,
    customerId,
    supplierId,
    supplierAdvanceRefundReceiptId,
    deliveryPartyId,
    counterpartyName,
    invoiceId,
  } = ctx;

  const supplierAdvanceRefundActive = isReceipt && partyType === "SUPPLIER" && supplierId != null && branchId != null;
  const supplierAdvanceRefundSources = trpc.vouchers.supplierAdvanceRefundSources.useQuery(
    supplierAdvanceRefundActive ? { supplierId, branchId } : skipToken,
    { retry: false },
  );
  const advanceRefundSources = supplierAdvanceRefundSources.data ?? [];
  const selectedSupplierAdvanceRefund = supplierAdvanceRefundActive
    ? advanceRefundSources.find((row) => row.id === supplierAdvanceRefundReceiptId) : undefined;
  let supplierAdvanceRefundValidationError = "";
  if (supplierAdvanceRefundActive) {
    if (supplierAdvanceRefundSources.isError) {
      supplierAdvanceRefundValidationError = supplierAdvanceRefundSources.error?.message || "تعذر التحقق من الدفعات السابقة القابلة للاسترداد؛ أعد المحاولة قبل الحفظ.";
    } else if (supplierAdvanceRefundSources.isLoading || supplierAdvanceRefundSources.isFetching || !supplierAdvanceRefundSources.data) {
      supplierAdvanceRefundValidationError = "انتظر اكتمال التحقق من الدفعات السابقة القابلة للاسترداد قبل الحفظ.";
    } else if (supplierAdvanceRefundReceiptId != null && !selectedSupplierAdvanceRefund) {
      supplierAdvanceRefundValidationError = "الدفعة السابقة المحددة لم تعد قابلة للاسترداد؛ حدّث المصادر واختر سنداً متاحاً.";
    } else if (advanceRefundSources.length > 0 && !selectedSupplierAdvanceRefund) {
      supplierAdvanceRefundValidationError = "اختر الدفعة السابقة المستردة لربط سند القبض بأصل الأموال.";
    } else if (selectedSupplierAdvanceRefund && moneyInput(amount).gt(selectedSupplierAdvanceRefund.remainingAmount)) {
      supplierAdvanceRefundValidationError = "مبلغ الاسترداد يتجاوز المتبقي القابل للاسترداد من السند المحدد؛ خفّض المبلغ أو اختر سنداً آخر.";
    }
  }
  const supplierAdvanceRefundWarning = selectedSupplierAdvanceRefund && moneyInput(amount).gt(selectedSupplierAdvanceRefund.unusedAmount)
    ? "مبلغ الاسترداد يتجاوز الجزء غير المستخدم من الدفعة؛ قد يعيد فتح ذمة الفواتير المرتبطة بها بمقدار الجزء المسترد من تخصيصاتها." : "";
  const supplierAdvanceRefundBlocked = supplierAdvanceRefundValidationError !== "";

  // عميل/مورّد المُختار (لمعاينة الرَصيد).
  const customerData = trpc.customers.get.useQuery(
    { customerId: customerId ?? 0 },
    {
      enabled: customerId != null && partyType === "CUSTOMER",
      staleTime: 60_000,
    },
  );

  const supplierData = trpc.suppliers.get.useQuery(
    { supplierId: supplierId ?? 0 },
    {
      enabled: supplierId != null && partyType === "SUPPLIER",
      staleTime: 60_000,
    },
  );

  // attachment-upload (٥/٧): فواتير العميل المُختار — لربط سند القبض/الصرف بفاتورة مُحدَّدة (اختياري).
  // fail-soft: خطأ الاستعلام (مَثلاً دورٌ مخصّص بلا صلاحية sales) لا يُعطّل حفظ السند — فقط يُخفي المُنتقي.
  // البحث خادميّ (q + balanceState=OUTSTANDING أي المتبقّي > 0 وغير الملغاة/المرتجعة) — كان «آخر ٥٠»
  // فقط فلا تُوجَد فاتورة أقدم وهي مستحقّة.
  const [invoiceQ, setInvoiceQ] = useState("");

  const debouncedInvoiceQ = useDebouncedValue(invoiceQ.trim(), 250);

  const customerInvoices = trpc.sales.list.useQuery(
    {
      customerId: customerId ?? undefined,
      q: debouncedInvoiceQ || undefined,
      balanceState: isReceipt ? "OUTSTANDING" : undefined,
      limit: 50,
    },
    {
      enabled: partyType === "CUSTOMER" && customerId != null,
      staleTime: 30_000,
      retry: false,
    },
  );

  const outstandingInvoiceOptions = (customerInvoices.data ?? []).filter(
    (inv) => voucherInvoiceEligible(inv, direction),
  );

  // تثبيت الفاتورة المُختارة إن ضيّق البحث القائمة بعد اختيارها — كي لا يفرغ المُنتقي صامتاً.
  const [selectedInvoiceLabel, setSelectedInvoiceLabel] = useState("");

  const selectedInList =
    invoiceId != null &&
    outstandingInvoiceOptions.some((inv) => Number(inv.id) === invoiceId);

  // وردية النقد + شارة الخزينة الإدارية.
  // OUT لا يمس درج المُنشئ أصلاً؛ مصدر التنفيذ النقدي الثابت هو خزينة المالك.
  const openShift = trpc.shifts.current.useQuery(
    { branchId: branchId ?? undefined },
    { enabled: isReceipt && branchId != null },
  );

  const { hardBlock, treasuryNotice } = voucherCashUiPolicy({
    direction,
    paymentMethod: method,
    hasOpenShift: openShift.data != null,
    shiftLoading: openShift.isLoading,
    isElevated,
  });

  // كل OUT طلبٌ بلا أثر حتى ينفّذ مالكٌ آخر «اعتماد وصرف» خادمياً؛ IN يبقى فورياً.
  const amountNum = useMemo(() => {
    const v = Number(amount);
    return Number.isFinite(v) ? v : 0;
  }, [amount]);

  const awaitsOwnerDisbursement = direction === "OUT" && amountNum > 0;

  // لا عَتبة مُرفق: المُرفق اختياريّ دائماً (٣١/٧، قرار المالك).

  // السندات الأخيرة لنفس الطَرف (تَحذير الازدواج).
  const partyKeyForRecent = useMemo(() => {
    if (partyType === "CUSTOMER" && customerId)
      return { partyId: customerId, name: null };
    if (partyType === "SUPPLIER" && supplierId)
      return { partyId: supplierId, name: null };
    if (partyType === "DELIVERY_PARTY" && deliveryPartyId)
      return { partyId: deliveryPartyId, name: null };
    if (partyType === "OTHER" && counterpartyName.trim().length >= 3)
      return { partyId: null, name: counterpartyName.trim() };
    return null;
  }, [partyType, customerId, supplierId, deliveryPartyId, counterpartyName]);

  const recent = trpc.vouchers.recentForParty.useQuery(
    {
      partyType,
      partyId: partyKeyForRecent?.partyId ?? null,
      counterpartyName: partyKeyForRecent?.name ?? null,
      windowDays: 7,
      limit: 5,
    },
    { enabled: !!partyKeyForRecent, staleTime: 30_000 },
  );

  // تَحذير «المبلغ يَتجاوز الرصيد» (P1-7). الاتجاهات وفق BalanceBadge:
  //   عميل: موجب = «لنا عليه» (AR)، سالب = «له علينا» (دفع/دُفع له زيادة).
  //   مورّد: موجب = «له علينا» (AP)، سالب = «لنا عليه» (دفعنا له زيادة).
  const balanceWarn = useMemo(() => {
    if (amountNum <= 0) return null;
    if (partyType === "CUSTOMER" && customerData.data) {
      const b = Number(customerData.data.currentBalance ?? 0);
      if (direction === "IN" && amountNum > b) {
        return `يَتجاوز رصيد العميل المُتبقّي (${fmt(b)}) — سيُصبح للعميل رصيدٌ دائن (له علينا).`;
      }
    }
    if (partyType === "SUPPLIER" && supplierData.data) {
      const b = Number(supplierData.data.currentBalance ?? 0);
      if (direction === "OUT" && amountNum > b) {
        return `يَتجاوز رَصيد المورّد المُستحق (له علينا ${fmt(b)}) — سيُصبح المورّد مديناً (لنا عليه: دفعنا زيادة).`;
      }
    }
    return null;
  }, [amountNum, partyType, customerData.data, supplierData.data, direction]);
  return {
    supplierAdvanceRefundActive,
    supplierAdvanceRefundSources,
    selectedSupplierAdvanceRefund,
    supplierAdvanceRefundValidationError,
    supplierAdvanceRefundWarning,
    supplierAdvanceRefundBlocked,
    customerData,
    supplierData,
    invoiceQ,
    setInvoiceQ,
    debouncedInvoiceQ,
    customerInvoices,
    outstandingInvoiceOptions,
    selectedInvoiceLabel,
    setSelectedInvoiceLabel,
    selectedInList,
    invoiceRemaining,
    openShift,
    hardBlock,
    treasuryNotice,
    amountNum,
    awaitsOwnerDisbursement,
    partyKeyForRecent,
    recent,
    balanceWarn,
  };
}
