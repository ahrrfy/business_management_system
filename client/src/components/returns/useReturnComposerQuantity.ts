import { useEffect } from "react";
import { eligibleReturnLine } from "@/lib/returnLineSelection";
import { notify } from "@/lib/notify";
import { ReturnComposerProps } from "./returnComposerTypes";
import type { useReturnComposerState } from "./useReturnComposerState";
export function useReturnComposerQuantity(
  ctx: Pick<
    ReturnType<typeof useReturnComposerState> & ReturnComposerProps,
    | "qty"
    | "setQty"
    | "fastBarcode"
    | "setFastBarcode"
    | "setManualAmount"
    | "setError"
    | "setDone"
    | "inv"
    | "items"
    | "scannedBarcode"
    | "onBarcodeHandled"
  >,
) {
  const {
    qty,
    setQty,
    fastBarcode,
    setFastBarcode,
    setManualAmount,
    setError,
    setDone,
    inv,
    items,
    scannedBarcode,
    onBarcodeHandled,
  } = ctx;

  function setQtyClamped(itemId: number, next: number, remaining: number) {
    const v = Math.max(0, Math.min(remaining, Math.trunc(next)));
    setQty((prev) => ({ ...prev, [itemId]: v }));
    setManualAmount(null); // تغيّرت قيمة المرتجع ⇒ يعود المبلغ للحساب التلقائيّ.
    setError("");
    setDone("");
  }

  function fillAll() {
    const next: Record<number, number> = {};
    for (const it of items)
      if (it.remaining > 0) next[it.invoiceItemId] = it.remaining;
    setQty(next);
    setManualAmount(null);
    setError("");
    setDone("");
  }

  /** مسح الباركود السريع للأصناف لزيادة الكمية المرتجعة فوراً */
  function handleFastItemScan(barcodeToMatch?: string) {
    const code = (barcodeToMatch ?? fastBarcode).trim();
    if (!code || !inv) return;

    const codeLower = code.toLowerCase();
    const matched = eligibleReturnLine(
      items,
      (it) =>
        (it.barcode && String(it.barcode).toLowerCase() === codeLower) ||
        (it.sku && String(it.sku).toLowerCase() === codeLower) ||
        it.productName.toLowerCase().includes(codeLower),
      (it) => it.remaining,
      (it) => qty[it.invoiceItemId] ?? 0,
    );

    if (!matched) {
      notify.err(`الصنف بالرمز "${code}" غير موجود في هذه الفاتورة!`);
      setFastBarcode("");
      return;
    }

    const currentQty = qty[matched.invoiceItemId] ?? 0;
    const step = matched.conversionFactor > 1 ? matched.conversionFactor : 1;
    const remaining = matched.remaining;

    if (currentQty >= remaining) {
      notify.err(
        `تم استيفاء الحد الأقصى لإرجاع "${matched.productName}" (${remaining} قطعة)`,
      );
      setFastBarcode("");
      return;
    }

    const nextQty = Math.min(remaining, currentQty + step);
    setQtyClamped(matched.invoiceItemId, nextQty, remaining);
    notify.ok(`تمت إضافة ${matched.productName} (+${step}) للإرجاع`);
    setFastBarcode("");
  }

  useEffect(() => {
    if (scannedBarcode && items.length > 0) {
      handleFastItemScan(scannedBarcode);
      onBarcodeHandled?.();
    }
  }, [scannedBarcode, items.length]);
  return { setQtyClamped, fillAll, handleFastItemScan };
}
