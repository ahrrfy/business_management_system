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
import { useState } from "react";
import { fmt } from "@/lib/money";
import { invalidateFinancialQueries } from "@/lib/realtime/financialQueries";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { preopenDocumentWindow } from "@/lib/printing/brand";
import {
  printSalesReturnReceipt,
  type PrintSalesReturnData,
} from "./printThermalReturnReceipt";
import {
  SalesReturnPortalProps,
  ReturnSubmission,
} from "./salesReturnPortalTypes";
import type { useSalesReturnState } from "./useSalesReturnState";
import type { useSalesReturnSettlement } from "./useSalesReturnSettlement";
export function useSalesReturnSubmission(
  ctx: Pick<
    ReturnType<typeof useSalesReturnState> &
      ReturnType<typeof useSalesReturnSettlement> &
      SalesReturnPortalProps,
    | "queryClient"
    | "operationPermission"
    | "clientRequestId"
    | "setClientRequestId"
    | "activeBranchId"
    | "salesInvoiceNo"
    | "setSalesInvoiceNo"
    | "salesCustomerName"
    | "setSalesCustomerName"
    | "salesCustomerPhone"
    | "setSalesCustomerPhone"
    | "salesCustomerId"
    | "setSalesCustomerId"
    | "salesDisposition"
    | "salesCart"
    | "setSalesCart"
    | "salesRefundMethod"
    | "salesCardRef"
    | "setSalesCardRef"
    | "salesReason"
    | "setSalesReason"
    | "openDrawers"
    | "selectedShiftId"
    | "salesBarcodeRef"
    | "setInspectedInvoice"
    | "inspectedInvoice"
    | "invoiceStateBlockReason"
    | "salesTotal"
    | "hasIncompletePrice"
    | "salesTotalPieces"
    | "selectedDrawer"
    | "autoDebtOffsetPortion"
    | "effectiveCashOrCardRefund"
    | "settlementMethod"
    | "creditOffsetCap"
    | "noCashNoAccount"
    | "isInsufficientCash"
    | "isOverInvoiceLimit"
    | "isInvoiceFullyReturned"
    | "onReturnSuccess"
  >,
) {
  const {
    queryClient,
    operationPermission,
    clientRequestId,
    setClientRequestId,
    activeBranchId,
    salesInvoiceNo,
    setSalesInvoiceNo,
    salesCustomerName,
    setSalesCustomerName,
    salesCustomerPhone,
    setSalesCustomerPhone,
    salesCustomerId,
    setSalesCustomerId,
    salesDisposition,
    salesCart,
    setSalesCart,
    salesRefundMethod,
    salesCardRef,
    setSalesCardRef,
    salesReason,
    setSalesReason,
    openDrawers,
    selectedShiftId,
    salesBarcodeRef,
    setInspectedInvoice,
    inspectedInvoice,
    invoiceStateBlockReason,
    salesTotal,
    hasIncompletePrice,
    salesTotalPieces,
    selectedDrawer,
    autoDebtOffsetPortion,
    effectiveCashOrCardRefund,
    settlementMethod,
    creditOffsetCap,
    noCashNoAccount,
    isInsufficientCash,
    isOverInvoiceLimit,
    isInvoiceFullyReturned,
    onReturnSuccess,
  } = ctx;

  const salesReturnMutation = trpc.returns.executeSalesReturnCart.useMutation();

  const [pendingReturn, setPendingReturn] = useState<ReturnSubmission | null>(
    null,
  );

  const handleExecuteSalesReturn = async () => {
    if (!operationPermission.allowed) {
      notify.err(operationPermission.reason);
      return;
    }
    if (pendingReturn) {
      const docWin = preopenDocumentWindow("width=420,height=760");
      await submitSalesReturn(pendingReturn, docWin);
      return;
    }
    if (invoiceStateBlockReason) {
      notify.warn(invoiceStateBlockReason);
      return;
    }
    if (salesCart.length === 0) {
      notify.warn("يرجى إضافة صنف واحد على الأقل للسلة");
      return;
    }
    if (hasIncompletePrice) {
      notify.warn("أكمل سعر الإرجاع قبل تأكيد المرتجع");
      return;
    }
    if (salesTotal <= 0) {
      notify.warn("مبلغ الإرجاع غير صالح");
      return;
    }

    if (inspectedInvoice) {
      if (inspectedInvoice.isOtherBranch) {
        notify.err(
          `الفاتورة #${inspectedInvoice.invoiceNumber} صادرة من فرع آخر (فرع #${inspectedInvoice.originBranchId}) ولا يمكن إرجاعها من هذا الفرع إلا بصلاحية مدير عام`,
        );
        return;
      }
      if (isInvoiceFullyReturned || inspectedInvoice.isDead) {
        notify.warn(
          "لا يمكن تنفيذ مرتجع على هذه الفاتورة لأنها مغلقة أو ملغاة أو مسترجعة بالكامل مسبقاً",
        );
        return;
      }
      if (isOverInvoiceLimit) {
        notify.warn(
          settlementMethod === "STORE_CREDIT"
            ? `إجمالي مبلغ المرتجع (${fmt(String(salesTotal))} د.ع) يتجاوز القيمة المتبقية للفاتورة (${fmt(inspectedInvoice.remainingInvoiceTotal)} د.ع)`
            : settlementMethod === "CREDIT_OFFSET"
              ? `قيمة المرتجع (${fmt(String(salesTotal))} د.ع) تتجاوز المتبقي القابل للتسوية (${fmt(creditOffsetCap)} د.ع)`
              : salesTotal > 0 && effectiveCashOrCardRefund <= 0
                ? "قيمة المرتجع تقع ضمن الجزء الآجل غير المسدد من الفاتورة — اختر [معادلة ذمم] لتسويته من حساب العميل دون صرف نقد"
                : `صافي الاسترداد المطلوب (${fmt(String(effectiveCashOrCardRefund))} د.ع) يتجاوز سقف الاسترداد المدفوع للفاتورة (${fmt(inspectedInvoice.maxRefundable)} د.ع)`,
        );
        return;
      }
    }

    if (settlementMethod === "CASH" && effectiveCashOrCardRefund > 0) {
      if (openDrawers.length === 0) {
        notify.warn(
          "لا توجد وردية كاشير مفتوحة حالياً في الفرع لصرف النقد منها — افتح وردية أولاً أو اختر طريقة أخرى",
        );
        return;
      }
      if (!selectedShiftId) {
        notify.warn(
          "يرجى اختيار درج النقدية / الوردية التي سيتم صرف المبلغ منها",
        );
        return;
      }
      if (isInsufficientCash) {
        notify.err(
          `رصيد الدرج المتاح (${fmt(selectedDrawer?.expectedCash || "0")} د.ع) غير كافٍ لصرف صافي مبلغ المرتجع (${fmt(String(effectiveCashOrCardRefund))} د.ع). يرجى تغذية الدرج بنقدية أو اختيار طريقة استرداد أخرى.`,
        );
        return;
      }
    } else if (settlementMethod === "STORE_CREDIT") {
      if (!salesCustomerId) {
        notify.warn(
          "طريقة استرداد رصيد المتجر تتطلب اختيار عميل مسجل في CRM لإيداع الرصيد في حسابه",
        );
        return;
      }
      // رصيد المتجر التزامٌ دائمٌ على حساب العميل ⇒ يجب ربطه بالفاتورة الأصليّة (نفس ما يفرضه
      // الخادم): بلا فاتورةٍ لا مُسنَدَ للرصيد الدائن في الدفتر فينحرف كشف الحساب. المرتجع العابر
      // بلا فاتورة مساره ردٌّ نقديّ فوريّ لا رصيد متجر.
      if (!salesInvoiceNo.trim()) {
        notify.warn(
          "إيداع رصيد المتجر يتطلّب ربط المرتجع بالفاتورة الأصليّة — أدخل رقم الفاتورة، أو اختر استرداداً نقدياً/بالبطاقة للمرتجع العابر",
        );
        return;
      }
    } else if (settlementMethod === "CREDIT_OFFSET") {
      if (!inspectedInvoice && !salesCustomerId) {
        notify.warn(
          "طريقة معادلة الذمم تتطلب اختيار عميل مسجل لإلغاء المديونية من حسابه",
        );
        return;
      }
      if (!salesInvoiceNo.trim()) {
        notify.warn(
          "معادلة الذمم تتطلب ربط المرتجع بالفاتورة الأصلية لتسوية رصيدها مع حساب العميل",
        );
        return;
      }
    }

    const drawerNotice = noCashNoAccount
      ? "تخفيض المتبقي على الفاتورة — بلا استرداد مالي"
      : settlementMethod === "CASH"
        ? `استرداد نقدي من درج [${selectedDrawer?.userName || "الكاشير"}]`
        : settlementMethod === "CARD"
          ? "استرداد بالبطاقة"
          : settlementMethod === "STORE_CREDIT"
            ? "إيداع رصيد متجر بحساب العميل"
            : "معادلة ذمم وإنقاص حساب العميل الآجل";

    const splitSummaryText =
      (salesRefundMethod === "CASH" || salesRefundMethod === "CARD") &&
      autoDebtOffsetPortion > 0 &&
      effectiveCashOrCardRefund > 0
        ? ` (تسوية ذرية مركبة: إسقاط ذمة آجلة بقيمة ${fmt(String(autoDebtOffsetPortion))} د.ع + صرف صافي ${fmt(String(effectiveCashOrCardRefund))} د.ع بطريقة [${drawerNotice}])`
        : ` بطريقة [${drawerNotice}]`;

    const ok = await confirm({
      title: "تأكيد تنفيذ مرتجع المبيعات",
      description: `سيتم إرجاع ${salesTotalPieces} قطعة بإجمالي ${fmt(String(salesTotal))} د.ع${splitSummaryText}. هل تؤكد التنفيذ الذري فوراً؟`,
      confirmText: "تأكيد وطباعة الإيصال",
      variant: "info",
    });
    if (!ok) return;
    const docWin = preopenDocumentWindow("width=420,height=760");

    await submitSalesReturn({
      clientRequestId,
      invoiceNumber:
        inspectedInvoice?.invoiceNumber ?? (salesInvoiceNo.trim() || undefined),
      customer: {
        customerId: inspectedInvoice
          ? (inspectedInvoice.customerId ?? undefined)
          : (salesCustomerId ?? undefined),
        name: salesCustomerName.trim() || undefined,
        phone: salesCustomerPhone.trim() || undefined,
      },
      disposition: salesDisposition,
      items: salesCart.map((i) => ({
        variantId: i.variantId,
        productUnitId: i.productUnitId,
        invoiceItemId: i.invoiceItemId,
        productName: i.productName,
        barcode: i.barcode,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
      })),
      settlement: {
        method: settlementMethod,
        totalAmount: String(salesTotal),
        shiftId:
          settlementMethod === "CASH" && effectiveCashOrCardRefund > 0
            ? (selectedShiftId ?? undefined)
            : undefined,
        reference: salesCardRef.trim() || undefined,
      },
      reason: salesReason.trim() || undefined,
    }, docWin);
  };

  async function submitSalesReturn(submission: ReturnSubmission, docWin?: Window | null) {
    const targetWin =
      docWin !== undefined
        ? docWin
        : preopenDocumentWindow("width=420,height=760");
    try {
      const res = await salesReturnMutation.mutateAsync(submission);
      setPendingReturn(null);

      notify.ok(`تم تنفيذ مرتجع المبيعات بنجاح: ${res.returnNumber}`);

      const printData: PrintSalesReturnData = {
        returnNumber: res.returnNumber,
        originalInvoiceNumber: res.originalInvoiceNumber,
        customerName: res.customerName,
        customerPhone: res.customerPhone,
        disposition: res.disposition,
        method: res.method,
        reference: res.reference,
        totalAmount: res.totalAmount,
        items: res.items,
        noCashNoAccount: res.noCashNoAccount === true,
        payoutAmount: res.payoutAmount,
        debtOffsetAmount: res.debtOffsetAmount,
      };

      if (targetWin) void printSalesReturnReceipt(printData, { into: targetWin });
      else void printSalesReturnReceipt(printData);
      onReturnSuccess(printData);
      setClientRequestId(crypto.randomUUID());

      setSalesCart([]);
      setSalesInvoiceNo("");
      setInspectedInvoice(null);
      setSalesCustomerName("");
      setSalesCustomerPhone("");
      setSalesCustomerId(null);
      setSalesReason("");
      setSalesCardRef("");
      salesBarcodeRef.current?.focus();
      await invalidateFinancialQueries(
        queryClient,
        inspectedInvoice?.branchId ?? activeBranchId,
      );
    } catch (e: any) {
      try { targetWin?.close(); } catch { /* ignore */ }
      // A lost reply may follow a committed return. Replay the exact submitted
      // intent before validating a new cart against the now-updated invoice.
      if (
        !e?.data?.code ||
        ["INTERNAL_SERVER_ERROR", "TIMEOUT"].includes(e.data.code)
      )
        setPendingReturn(submission);
      else setPendingReturn(null);
      notify.err(e.message || "تعذر تنفيذ المرتجع");
    }
  }
  return {
    salesReturnMutation,
    pendingReturn,
    setPendingReturn,
    handleExecuteSalesReturn,
    submitSalesReturn,
  };
}
