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
import { useEffect, useMemo } from "react";
import { D, moneyInput } from "@/lib/money";
import type { useSalesReturnState } from "./useSalesReturnState";
export function useSalesReturnSettlement(
  ctx: Pick<
    ReturnType<typeof useSalesReturnState>,
    | "salesCart"
    | "salesRefundMethod"
    | "openDrawers"
    | "selectedShiftId"
    | "inspectedInvoice"
    | "invoiceState"
  >,
) {
  const {
    salesCart,
    salesRefundMethod,
    openDrawers,
    selectedShiftId,
    inspectedInvoice,
    invoiceState,
  } = ctx;

  const salesTotal = useMemo(() => {
    const remainingItems =
      inspectedInvoice?.items.filter((item) => item.remainingQuantity > 0) ??
      [];
    const completesInvoice =
      remainingItems.length > 0 &&
      salesCart.length === remainingItems.length &&
      remainingItems.every((item) => {
        const selected = salesCart.find(
          (line) => line.invoiceItemId === item.invoiceItemId,
        );
        return (
          selected != null &&
          selected.quantity === item.remainingQuantity &&
          moneyInput(selected.unitPrice).eq(
            item.effectiveUnitPrice || item.unitPrice,
          )
        );
      });
    if (completesInvoice)
      return D(inspectedInvoice!.remainingInvoiceTotal).toNumber();
    return Number(
      salesCart
        .reduce((sum, item) => {
          const matchedInvItem = inspectedInvoice?.items.find((it) =>
            item.invoiceItemId
              ? it.invoiceItemId === item.invoiceItemId
              : it.variantId === item.variantId,
          );
          if (
            matchedInvItem &&
            item.quantity === matchedInvItem.remainingQuantity &&
            matchedInvItem.remainingLineTotal != null &&
            Number(item.unitPrice || 0) ===
              Number(
                matchedInvItem.effectiveUnitPrice ||
                  matchedInvItem.unitPrice ||
                  0,
              )
          ) {
            return sum + Number(matchedInvItem.remainingLineTotal);
          }
          return sum + item.quantity * moneyInput(item.unitPrice).toNumber();
        }, 0)
        .toFixed(2),
    );
  }, [salesCart, inspectedInvoice]);

  const hasIncompletePrice = salesCart.some(
    (item) => !/^\d+(\.\d{1,2})?$/.test(item.unitPrice),
  );

  const salesTotalPieces = useMemo(() => {
    return salesCart.reduce((sum, item) => sum + item.quantity, 0);
  }, [salesCart]);

  const selectedDrawer = useMemo(() => {
    return openDrawers.find((d) => d.shiftId === selectedShiftId) ?? null;
  }, [openDrawers, selectedShiftId]);

  const autoDebtOffsetPortion = useMemo(() => {
    if (!inspectedInvoice) return 0;
    const unpaid = Math.max(
      0,
      D(
        inspectedInvoice.maxCreditOffsetAmount ??
          inspectedInvoice.unpaidAmount ??
          "0",
      ).toNumber(),
    );
    return Number(Math.min(salesTotal, unpaid).toFixed(2));
  }, [inspectedInvoice, salesTotal]);

  const effectiveCashOrCardRefund = useMemo(() => {
    if (!inspectedInvoice) return salesTotal;
    return Number(Math.max(0, salesTotal - autoDebtOffsetPortion).toFixed(2));
  }, [inspectedInvoice, salesTotal, autoDebtOffsetPortion]);

  const sourcePaidAmount =
    invoiceState.data?.sourcePaidAmountIqd ??
    inspectedInvoice?.sourcePaidAmountIqd;

  const actuallyUnpaid =
    sourcePaidAmount != null && D(sourcePaidAmount).isZero();

  const noCashRequired =
    inspectedInvoice != null &&
    salesRefundMethod !== "STORE_CREDIT" &&
    (salesRefundMethod === "CREDIT_OFFSET" ||
      effectiveCashOrCardRefund <= 0 ||
      actuallyUnpaid);

  const settlementMethod = noCashRequired ? "CREDIT_OFFSET" : salesRefundMethod;

  const creditOffsetCap =
    inspectedInvoice?.maxCreditOffsetAmount ??
    inspectedInvoice?.unpaidAmount ??
    "0";

  const noCashNoAccount =
    noCashRequired && inspectedInvoice?.customerId == null;

  const isInsufficientCash = useMemo(() => {
    return (
      salesRefundMethod === "CASH" &&
      selectedDrawer != null &&
      Number(selectedDrawer.expectedCash || 0) < effectiveCashOrCardRefund
    );
  }, [salesRefundMethod, selectedDrawer, effectiveCashOrCardRefund]);

  const isOverInvoiceLimit = useMemo(() => {
    if (!inspectedInvoice) return false;
    if (salesRefundMethod === "STORE_CREDIT") {
      return salesTotal > Number(inspectedInvoice.remainingInvoiceTotal || 0);
    }
    if (noCashRequired) {
      return D(salesTotal).gt(creditOffsetCap);
    }
    if (Number(inspectedInvoice.paidAmount || 0) <= 0) {
      return salesTotal > 0;
    }
    if (salesTotal > 0 && effectiveCashOrCardRefund <= 0) {
      return true;
    }
    return (
      salesTotal > Number(inspectedInvoice.remainingInvoiceTotal || 0) ||
      effectiveCashOrCardRefund > Number(inspectedInvoice.maxRefundable || 0)
    );
  }, [
    inspectedInvoice,
    salesTotal,
    salesRefundMethod,
    effectiveCashOrCardRefund,
    noCashRequired,
    creditOffsetCap,
  ]);

  const isInvoiceFullyReturned = useMemo(() => {
    if (!inspectedInvoice) return false;
    return (
      inspectedInvoice.isFullyReturned === true ||
      inspectedInvoice.isDead === true ||
      inspectedInvoice.status === "RETURNED" ||
      Number(inspectedInvoice.remainingInvoiceTotal || 0) <= 0
    );
  }, [inspectedInvoice]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "F2") return;
      e.preventDefault();
      const el = document.querySelector<HTMLInputElement>(
        "input[data-product-search='1']",
      );
      el?.focus();
      el?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return {
    salesTotal,
    hasIncompletePrice,
    salesTotalPieces,
    selectedDrawer,
    autoDebtOffsetPortion,
    effectiveCashOrCardRefund,
    sourcePaidAmount,
    actuallyUnpaid,
    noCashRequired,
    settlementMethod,
    creditOffsetCap,
    noCashNoAccount,
    isInsufficientCash,
    isOverInvoiceLimit,
    isInvoiceFullyReturned,
  };
}
