import { eligibleReturnLine } from "@/lib/returnLineSelection";
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
import { formatQuantity } from "@/lib/money";
import { notify } from "@/lib/notify";
import type { useSalesReturnState } from "./useSalesReturnState";
import type { useSalesReturnSettlement } from "./useSalesReturnSettlement";
import type { useSalesReturnInvoiceLookup } from "./useSalesReturnInvoiceLookup";
export function useSalesReturnScan(
  ctx: Pick<
    ReturnType<typeof useSalesReturnState> &
      ReturnType<typeof useSalesReturnSettlement> &
      ReturnType<typeof useSalesReturnInvoiceLookup>,
    | "utils"
    | "setSalesInvoiceNo"
    | "setLastAddedId"
    | "salesBarcode"
    | "setSalesBarcode"
    | "setSalesCart"
    | "salesBarcodeRef"
    | "salesCart"
    | "inspectedInvoice"
    | "isInvoiceFullyReturned"
    | "handleLookupInvoice"
  >,
) {
  const {
    salesCart,
    utils,
    setSalesInvoiceNo,
    setLastAddedId,
    salesBarcode,
    setSalesBarcode,
    setSalesCart,
    salesBarcodeRef,
    inspectedInvoice,
    isInvoiceFullyReturned,
    handleLookupInvoice,
  } = ctx;

  const [salesScanPending, setSalesScanPending] = useState(false);

  const handleSalesScan = async (barcodeToScan?: string) => {
    const raw = (barcodeToScan ?? salesBarcode).trim();
    if (!raw) return;

    if (/^INV-/i.test(raw)) {
      setSalesBarcode("");
      setSalesInvoiceNo(raw);
      await handleLookupInvoice(raw);
      return;
    }

    if (inspectedInvoice?.isOtherBranch) {
      notify.err(
        `لا يمكن إضافة أصناف: الفاتورة #${inspectedInvoice.invoiceNumber} صادرة من فرع آخر (فرع #${inspectedInvoice.originBranchId}) ولا يمكن إرجاعها من هنا`,
      );
      return;
    }

    if (inspectedInvoice && isInvoiceFullyReturned) {
      notify.warn(
        `لا يمكن إضافة أصناف: الفاتورة #${inspectedInvoice.invoiceNumber} مسترجعة بالكامل مسبقاً`,
      );
      return;
    }

    setSalesScanPending(true);
    try {
      const res = await utils.returns.lookupItemForReturn.fetch({
        barcode: raw,
      });
      if (!res) {
        // فحص ما إذا كان الرمز باركود أو رقم فاتورة
        try {
          const inspected = await utils.returns.inspectInvoiceForReturn.fetch({
            invoiceNumber: raw,
          });
          if (inspected) {
            setSalesBarcode("");
            setSalesInvoiceNo(inspected.invoiceNumber);
            await handleLookupInvoice(inspected.invoiceNumber);
            return;
          }
        } catch {
          // تجاهل
        }

        try {
          const scanRes = await utils.returns.universalScan.fetch({
            barcode: raw,
          });
          if (
            scanRes?.recognized &&
            scanRes.kind === "INVOICE" &&
            scanRes.number
          ) {
            setSalesBarcode("");
            setSalesInvoiceNo(scanRes.number);
            await handleLookupInvoice(scanRes.number);
            return;
          }
        } catch {
          // تجاهل
        }

        notify.warn(`لم يتم العثور على منتج أو فاتورة بالرمز: ${raw}`);
        return;
      }
      const variantId = res.variantId;
      const matchedInvItem = eligibleReturnLine(
        inspectedInvoice?.items ?? [],
        (it) => it.variantId === variantId,
        (it) => it.remainingQuantity,
        (it) =>
          salesCart.find((line) => line.invoiceItemId === it.invoiceItemId)
            ?.quantity ?? 0,
      );

      if (matchedInvItem && matchedInvItem.remainingQuantity <= 0) {
        notify.warn(
          `الصنف «${res.productName}» تم إرجاع كامل كميته في الفاتورة #${inspectedInvoice?.invoiceNumber}`,
        );
        return;
      }

      if (inspectedInvoice && !matchedInvItem) {
        notify.warn(
          `تنبيه: الصنف «${res.productName}» غير مسجل ضمن بنود الفاتورة #${inspectedInvoice.invoiceNumber}`,
        );
      }

      const priceStr = matchedInvItem
        ? matchedInvItem.effectiveUnitPrice || matchedInvItem.unitPrice
        : String(res.retailPrice || res.lowestHistoricalPrice || "0");
      const maxQty = matchedInvItem?.remainingQuantity;

      setSalesCart((prev) => {
        const existingIdx = prev.findIndex((i) =>
          matchedInvItem
            ? i.invoiceItemId === matchedInvItem.invoiceItemId
            : i.variantId === variantId,
        );
        if (existingIdx >= 0) {
          const target = prev[existingIdx];
          const updated = [...prev];
          let newQty = target.quantity + 1;
          if (maxQty != null && newQty > maxQty) {
            notify.warn(
              `الكمية المطلوبة تتجاوز المتبقي في الفاتورة (${formatQuantity(maxQty)})`,
            );
            newQty = maxQty;
          }
          const [moved] = updated.splice(existingIdx, 1);
          const itemToPlace = {
            ...moved,
            ...(matchedInvItem
              ? {
                  productUnitId: matchedInvItem.productUnitId,
                  unit: matchedInvItem.unitName,
                  conversionFactor: 1,
                }
              : {}),
            quantity: newQty,
          };
          setLastAddedId(itemToPlace.id);
          return [itemToPlace, ...updated];
        }
        const newId = `${variantId}-${Date.now()}`;
        setLastAddedId(newId);
        return [
          {
            id: newId,
            variantId,
            productUnitId: matchedInvItem
              ? matchedInvItem.productUnitId
              : res.productUnitId,
            invoiceItemId: matchedInvItem?.invoiceItemId,
            isBundle: matchedInvItem?.isBundle,
            productName: res.productName,
            barcode: res.barcode ?? raw,
            quantity: 1,
            maxAllowedQuantity: maxQty,
            unitPrice: priceStr,
            originalUnitPrice: matchedInvItem
              ? matchedInvItem.effectiveUnitPrice || matchedInvItem.unitPrice
              : undefined,
            ...(matchedInvItem
              ? {
                  unit: matchedInvItem.unitName,
                  conversionFactor: 1,
                }
              : {}),
          },
          ...prev,
        ];
      });

      setSalesBarcode("");
      notify.ok(`أُضيف للسلة: ${res.productName}`);
      salesBarcodeRef.current?.focus();
    } catch {
      notify.err("خطأ أثناء قراءة الصنف");
    } finally {
      setSalesScanPending(false);
    }
  };
  return { salesScanPending, setSalesScanPending, handleSalesScan };
}
