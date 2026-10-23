import { eligibleReturnLine } from "@/lib/returnLineSelection";
import { formatQuantity } from "@/lib/money";
import { notify } from "@/lib/notify";
import type { InvoiceLine } from "@/components/invoice/types";
import type { useSalesReturnState } from "./useSalesReturnState";
import type { useSalesReturnSettlement } from "./useSalesReturnSettlement";
export function useSalesReturnCartActions(
  ctx: Pick<
    ReturnType<typeof useSalesReturnState> &
      ReturnType<typeof useSalesReturnSettlement>,
    | "setLastAddedId"
    | "setSalesCart"
    | "salesCart"
    | "inspectedInvoice"
    | "isInvoiceFullyReturned"
  >,
) {
  const {
    salesCart,
    setLastAddedId,
    setSalesCart,
    inspectedInvoice,
    isInvoiceFullyReturned,
  } = ctx;

  const handleAddProductFromSearch = (line: InvoiceLine) => {
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

    const variantId = line.variantId;
    const factor = Math.max(1, Number(line.conversionFactor) || 1);

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
        `الصنف «${line.name}» تم إرجاع كامل كميته في الفاتورة #${inspectedInvoice?.invoiceNumber}`,
      );
      return;
    }

    if (inspectedInvoice && !matchedInvItem) {
      notify.warn(
        `تنبيه: الصنف «${line.name}» غير مسجل ضمن بنود الفاتورة #${inspectedInvoice.invoiceNumber}`,
      );
    }

    const priceStr = matchedInvItem
      ? matchedInvItem.effectiveUnitPrice || matchedInvItem.unitPrice
      : String(line.price || "0");
    const maxQty = matchedInvItem
      ? matchedInvItem.remainingQuantity
      : undefined;
    const addStep = matchedInvItem ? (line.qty || 1) * factor : line.qty || 1;

    setSalesCart((prev) => {
      const existingIdx = prev.findIndex((i) =>
        matchedInvItem
          ? i.invoiceItemId === matchedInvItem.invoiceItemId
          : i.variantId === variantId,
      );
      if (existingIdx >= 0) {
        const target = prev[existingIdx];
        const updated = [...prev];
        let newQty = target.quantity + addStep;
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
      const initialQty = Math.min(addStep, maxQty ?? addStep);
      return [
        {
          id: newId,
          variantId,
          productUnitId: matchedInvItem
            ? matchedInvItem.productUnitId
            : line.productUnitId,
          invoiceItemId: matchedInvItem?.invoiceItemId,
          isBundle: matchedInvItem?.isBundle,
          productName: line.name,
          barcode: line.barcode ?? null,
          quantity: initialQty,
          maxAllowedQuantity: maxQty,
          unitPrice: priceStr,
          originalUnitPrice: matchedInvItem
            ? matchedInvItem.effectiveUnitPrice || matchedInvItem.unitPrice
            : undefined,
          unit: matchedInvItem ? matchedInvItem.unitName : line.unit || "قطعة",
          conversionFactor: matchedInvItem ? 1 : factor,
        },
        ...prev,
      ];
    });

    notify.ok(`أُضيف للسلة: ${line.name}`);
  };

  const handleAddInspectedItemToCart = (
    item: NonNullable<typeof inspectedInvoice>["items"][number],
  ) => {
    if (inspectedInvoice?.isOtherBranch) {
      notify.err(
        `لا يمكن إضافة أصناف: الفاتورة #${inspectedInvoice.invoiceNumber} صادرة من فرع آخر (فرع #${inspectedInvoice.originBranchId}) ولا يمكن إرجاعها من هنا`,
      );
      return;
    }
    if (isInvoiceFullyReturned) {
      notify.warn(
        "هذه الفاتورة مسترجعة بالكامل مسبقاً ولا تقبل مرتجعات إضافية",
      );
      return;
    }
    if (item.remainingQuantity <= 0) {
      notify.warn(`الصنف «${item.productName}» تم إرجاع كامل كميته مسبقاً`);
      return;
    }

    setSalesCart((prev) => {
      const existingIdx = prev.findIndex(
        (i) =>
          i.invoiceItemId === item.invoiceItemId ||
          (!i.invoiceItemId && i.variantId === item.variantId),
      );
      if (existingIdx >= 0) {
        const target = prev[existingIdx];
        if (target.quantity >= item.remainingQuantity) {
          notify.warn(
            `الكمية في السلة وصلت للحد الأقصى المتاح (${formatQuantity(item.remainingQuantity)})`,
          );
          return prev;
        }
        const updated = [...prev];
        const newQty = Math.min(item.remainingQuantity, target.quantity + 1);
        const [moved] = updated.splice(existingIdx, 1);
        const itemToPlace = { ...moved, quantity: newQty };
        setLastAddedId(itemToPlace.id);
        return [itemToPlace, ...updated];
      }

      const newId = `${item.variantId}-${Date.now()}`;
      setLastAddedId(newId);
      return [
        {
          id: newId,
          variantId: item.variantId,
          productUnitId: item.productUnitId,
          invoiceItemId: item.invoiceItemId,
          isBundle: item.isBundle,
          productName: item.productName,
          barcode: item.barcode,
          quantity: 1,
          maxAllowedQuantity: item.remainingQuantity,
          unitPrice: item.effectiveUnitPrice || item.unitPrice,
          originalUnitPrice: item.effectiveUnitPrice || item.unitPrice,
          unit: item.unitName,
          conversionFactor: item.conversionFactor,
        },
        ...prev,
      ];
    });

    notify.ok(`أُضيف للسلة: ${item.productName}`);
  };

  const handleAddAllRemainingItems = () => {
    if (!inspectedInvoice || inspectedInvoice.items.length === 0) return;
    if (inspectedInvoice.isOtherBranch) {
      notify.err(
        `لا يمكن إضافة أصناف: الفاتورة #${inspectedInvoice.invoiceNumber} صادرة من فرع آخر (فرع #${inspectedInvoice.originBranchId}) ولا يمكن إرجاعها من هنا`,
      );
      return;
    }
    if (isInvoiceFullyReturned) {
      notify.warn(
        "هذه الفاتورة مسترجعة بالكامل مسبقاً ولا تقبل مرتجعات إضافية",
      );
      return;
    }
    const availableItems = inspectedInvoice.items.filter(
      (i) => i.remainingQuantity > 0,
    );
    if (availableItems.length === 0) {
      notify.warn("لا توجد بنود متبقية قابلة للإرجاع في هذه الفاتورة");
      return;
    }

    setSalesCart((prev) => {
      let nextCart = [...prev];
      for (const item of availableItems) {
        const existingIdx = nextCart.findIndex(
          (i) =>
            i.invoiceItemId === item.invoiceItemId ||
            (!i.invoiceItemId && i.variantId === item.variantId),
        );
        if (existingIdx >= 0) {
          nextCart[existingIdx] = {
            ...nextCart[existingIdx],
            productUnitId: item.productUnitId,
            invoiceItemId: item.invoiceItemId,
            unit: item.unitName,
            conversionFactor: item.conversionFactor,
            quantity: item.remainingQuantity,
            maxAllowedQuantity: item.remainingQuantity,
            unitPrice: item.effectiveUnitPrice || item.unitPrice,
            originalUnitPrice: item.effectiveUnitPrice || item.unitPrice,
          };
        } else {
          const newId = `${item.variantId}-${Date.now()}-${Math.random()}`;
          nextCart.push({
            id: newId,
            variantId: item.variantId,
            productUnitId: item.productUnitId,
            invoiceItemId: item.invoiceItemId,
            isBundle: item.isBundle,
            productName: item.productName,
            barcode: item.barcode,
            quantity: item.remainingQuantity,
            maxAllowedQuantity: item.remainingQuantity,
            unitPrice: item.effectiveUnitPrice || item.unitPrice,
            originalUnitPrice: item.effectiveUnitPrice || item.unitPrice,
            unit: item.unitName,
            conversionFactor: item.conversionFactor,
          });
        }
      }
      return nextCart;
    });

    notify.ok(
      `تمت إضافة ${availableItems.length} بند بكامل الكميات المتبقية للسلة`,
    );
  };
  return {
    handleAddProductFromSearch,
    handleAddInspectedItemToCart,
    handleAddAllRemainingItems,
  };
}
