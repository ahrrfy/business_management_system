import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/date";
import { METHOD_LABEL } from "@/lib/paymentMethod";
import { notify } from "@/lib/notify";
import {
  preopenShippingLabelWindow,
  printShippingLabel,
  resolveShippingLabelPaymentState,
} from "@/lib/printing/shippingLabel";
import type { OfflinePrintSalePayload } from "@/lib/offline/outbox";
import type { Receipt } from "@/components/pos/posShared";
import {
  cacheCustomizableLineOptions,
  readCachedCustomizableLineOptions,
} from "@/lib/offline/printServicesCache";
import type { CartItem, PosRow, POSTab } from "@/components/pos/posShared";
import { lineIdOf, nextCartLineId } from "@/components/pos/posShared";
import type { CustomizableLineOption } from "@/components/recipe/RecipeVariantSelectorList";
import {
  serializeRecipeSelectionsKey,
  stripRecipeSelectionMeta,
  type RecipeLineSelectionWithMeta,
} from "@shared/recipeVariantSelection";
import type { PrintCartLine } from "@/components/print-pos/PrintCartList";

export function toPrintSaleLines(cart: ReadonlyArray<PrintCartLine>) {
  return cart.map((c) => {
    const stripped = stripRecipeSelectionMeta(c.recipeSelections);
    return {
      variantId: c.svc.variantId,
      productUnitId: c.svc.productUnitId,
      quantity: String(c.qty),
      unitPriceOverride: c.price.toFixed(2),
      ...(stripped?.length ? { recipeSelections: stripped } : {}),
    };
  });
}

export function buildOfflinePrintPayloadAndReceipt(params: {
  branchId: number;
  shiftId: number;
  customerId: number | null;
  customerName?: string;
  cashierName?: string;
  receiptNumber: string;
  clientRequestId: string;
  cart: ReadonlyArray<PrintCartLine>;
  total: number;
  rawTotal: number;
  cashTotal: number;
  paid: number;
  invoiceDiscountAmount: number;
  hasInvoiceDiscount: boolean;
  formattedDiscount: string;
}): { payload: OfflinePrintSalePayload; receipt: Receipt } {
  const now = new Date();
  const payload: OfflinePrintSalePayload = {
    branchId: params.branchId,
    shiftId: params.shiftId,
    ...(params.customerId ? { customerId: params.customerId } : {}),
    priceTier: "RETAIL",
    lines: toPrintSaleLines(params.cart),
    ...(params.hasInvoiceDiscount ? { invoiceDiscount: params.formattedDiscount } : {}),
    payment: { amount: params.total.toFixed(2), method: "CASH" },
    clientRequestId: params.clientRequestId,
    cashRoundIQD: true,
  };
  const receipt: Receipt = {
    invoiceId: 0,
    invoiceNumber: params.receiptNumber,
    num: params.receiptNumber,
    date: fmtDateTime(now),
    printDate: fmtDate(now),
    printTime: fmtTime(now),
    cashierName: params.cashierName,
    customerName: params.customerName,
    shiftId: params.shiftId,
    lines: params.cart.map((c) => ({
      name: c.svc.productName,
      unit: c.svc.unitName,
      qty: c.qty,
      price: c.price,
      total: c.price * c.qty,
    })),
    subtotal: params.rawTotal,
    ...(params.invoiceDiscountAmount > 0 ? { invoiceDiscount: params.invoiceDiscountAmount } : {}),
    cashRounding: params.cashTotal - params.total,
    total: params.cashTotal,
    received: params.paid,
    change: Math.max(0, params.paid - params.cashTotal),
    credit: 0,
    method: METHOD_LABEL.CASH,
    methodCode: "CASH",
    isCredit: false,
  };
  return { payload, receipt };
}

export function triggerPrintPosShippingLabel(params: {
  receipt: Receipt;
  contactName?: string;
  contactPhone?: string;
  printAuthorizedDocument: (
    invoiceId: number,
    docType: "SHIPPING_LABEL",
    reprint: boolean,
    fn: () => Promise<{ ok: boolean; via: "browser"; reason?: string }>,
  ) => Promise<{ ok: boolean }>;
  onError: (msg: string) => void;
}) {
  const { receipt, contactName, contactPhone, printAuthorizedDocument, onError } = params;
  const win = preopenShippingLabelWindow();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const orderRef = receipt.invoiceNumber || receipt.num || "";
  const deliveryFee = receipt.delivery?.fee ? String(receipt.delivery.fee) : null;
  void printAuthorizedDocument(receipt.invoiceId ?? 0, "SHIPPING_LABEL", true, async () => {
    const result = await printShippingLabel(
      {
        orderNumber: orderRef,
        customerName: receipt.customerName || contactName || null,
        customerPhone: contactPhone || null,
        governorate:
          receipt.delivery && "governorate" in receipt.delivery
            ? String((receipt.delivery as Record<string, unknown>).governorate)
            : null,
        addressText: receipt.delivery?.address ?? null,
        total: String(receipt.total),
        subtotal: receipt.subtotal != null ? String(receipt.subtotal) : String(receipt.total),
        shippingFee: deliveryFee && Number(deliveryFee) > 0 ? deliveryFee : null,
        paymentState: resolveShippingLabelPaymentState(Math.max(0, receipt.total - receipt.received)),
        isReprint: true,
        qrUrl: orderRef && origin ? `${origin}/verify?ref=${encodeURIComponent(orderRef)}` : null,
        items: receipt.lines.map((line) => ({
          productName: line.name,
          unitName: line.unit,
          quantity: String(line.qty),
        })),
      },
      { into: win },
    );
    return result.ok ? { ok: true, via: "browser" } : { ok: false, via: "browser", reason: "popup-blocked" };
  })
    .then((r) => {
      if (!r.ok) onError("فشل طباعة الليبل");
    })
    .catch((error) => {
      try {
        win?.close();
      } catch {
        /* noop */
      }
      notify.err(error);
    });
}

export function usePrintCustomizableLines<TSvc extends { variantId: number }>({
  branchId,
  offline,
}: {
  branchId: number;
  offline: boolean;
}) {
  const customizableOptionsQ = trpc.production.recipes.customizableLineOptions.useQuery(
    { branchId },
    { enabled: !offline && branchId > 0, staleTime: 60_000 },
  );
  const [cachedCustomOptions, setCachedCustomOptions] = useState<CustomizableLineOption[]>([]);

  useEffect(() => {
    if (customizableOptionsQ.data?.lines) {
      setCachedCustomOptions(customizableOptionsQ.data.lines);
      void cacheCustomizableLineOptions(branchId, customizableOptionsQ.data.lines);
    }
  }, [customizableOptionsQ.data, branchId]);

  useEffect(() => {
    if (!offline || branchId <= 0) return;
    let cancelled = false;
    void readCachedCustomizableLineOptions<CustomizableLineOption>(branchId).then((cached) => {
      if (!cancelled && cached) setCachedCustomOptions(cached);
    });
    return () => {
      cancelled = true;
    };
  }, [offline, branchId]);

  const customizableLinesByVariantId = useMemo(() => {
    const source = offline
      ? cachedCustomOptions
      : (customizableOptionsQ.data?.lines ?? cachedCustomOptions);
    const map = new Map<number, CustomizableLineOption[]>();
    for (const line of source) {
      const ov = Number(line.outputVariantId);
      const list = map.get(ov) ?? [];
      list.push(line);
      map.set(ov, list);
    }
    return map;
  }, [offline, customizableOptionsQ.data, cachedCustomOptions]);

  const customizableVariantIds = useMemo(
    () => new Set<number>(customizableLinesByVariantId.keys()),
    [customizableLinesByVariantId],
  );

  const [variantPicker, setVariantPicker] = useState<{
    svc: TSvc;
    lines: CustomizableLineOption[];
    editingUid?: number;
    initialSelections?: RecipeLineSelectionWithMeta[];
    quantity?: number;
  } | null>(null);

  function openForCartLine(line: {
    uid: number;
    svc: TSvc;
    qty: number;
    recipeSelections?: RecipeLineSelectionWithMeta[];
  }) {
    const lines = customizableLinesByVariantId.get(Number(line.svc.variantId));
    if (!lines?.length) return;
    setVariantPicker({
      svc: line.svc,
      lines,
      editingUid: line.uid,
      initialSelections: line.recipeSelections,
      quantity: line.qty,
    });
  }

  return {
    customizableLinesByVariantId,
    customizableVariantIds,
    variantPicker,
    setVariantPicker,
    openForCartLine,
  };
}

export function useRetailPosCustomizableLines({
  branchId,
  offline,
  resetCouponItems,
  patchActive,
  onAdded,
}: {
  branchId: number;
  offline: boolean;
  resetCouponItems: (items: CartItem[]) => CartItem[];
  patchActive: (patch: Partial<POSTab> | ((tab: POSTab) => Partial<POSTab>)) => void;
  onAdded: () => void;
}) {
  const { customizableLinesByVariantId, customizableVariantIds } = usePrintCustomizableLines<{
    variantId: number;
  }>({ branchId, offline });

  const [picker, setPicker] = useState<{
    row: PosRow;
    lines: CustomizableLineOption[];
    editingLineId?: number;
    initialSelections?: RecipeLineSelectionWithMeta[];
    quantity?: number;
  } | null>(null);

  function commitCartRow(row: PosRow, recipeSelections?: RecipeLineSelectionWithMeta[]) {
    const currentRow = { ...row, branchId: row.branchId ?? branchId };
    const selKey = recipeSelections?.length ? serializeRecipeSelectionsKey(recipeSelections) : "";
    patchActive((tab) => {
      const prev = resetCouponItems(tab.cart);
      const couponReset = tab.couponCode
        ? { couponCode: null, couponLabel: null, couponFreeShippingPromo: null }
        : {};
      const i = prev.findIndex(
        (c) =>
          !c.digital &&
          c.row.productUnitId === currentRow.productUnitId &&
          serializeRecipeSelectionsKey(c.recipeSelections) === selKey,
      );
      if (i >= 0) {
        const next = [...prev];
        const existing = next[i];
        const updated: CartItem = {
          ...existing,
          row: currentRow,
          qty: existing.qty + 1,
          ...(recipeSelections?.length ? { recipeSelections } : {}),
        };
        next.splice(i, 1);
        next.unshift(updated);
        return { ...couponReset, cart: next, selId: lineIdOf(existing) };
      }
      const nextCustomId = recipeSelections?.length ? nextCartLineId(prev) : undefined;
      const inserted: CartItem = {
        row: currentRow,
        qty: 1,
        ...(recipeSelections?.length ? { recipeSelections, customLineId: nextCustomId } : {}),
      };
      return { ...couponReset, cart: [inserted, ...prev], selId: lineIdOf(inserted) };
    });
    onAdded();
  }

  function addOrPromptRow(row: PosRow) {
    const customLines = customizableLinesByVariantId.get(Number(row.variantId));
    if (row.isService && customLines?.length) {
      setPicker({ row: { ...row, branchId: row.branchId ?? branchId }, lines: customLines, quantity: 1 });
      return;
    }
    commitCartRow(row);
  }

  function openForCartItem(item: CartItem) {
    if (item.digital) return;
    const customLines = customizableLinesByVariantId.get(Number(item.row.variantId));
    if (!customLines?.length) return;
    setPicker({
      row: item.row,
      lines: customLines,
      editingLineId: lineIdOf(item),
      initialSelections: item.recipeSelections,
      quantity: item.qty,
    });
  }

  function confirmPicker(selections: RecipeLineSelectionWithMeta[]) {
    if (!picker) return;
    if (picker.editingLineId != null) {
      const editingId = picker.editingLineId;
      patchActive((tab) => ({
        ...(tab.couponCode
          ? { couponCode: null, couponLabel: null, couponFreeShippingPromo: null }
          : {}),
        cart: resetCouponItems(tab.cart).map((c) =>
          lineIdOf(c) === editingId ? { ...c, recipeSelections: selections } : c,
        ),
      }));
    } else {
      commitCartRow(picker.row, selections);
    }
    setPicker(null);
  }

  return {
    customizableVariantIds,
    picker,
    closePicker: () => setPicker(null),
    addOrPromptRow,
    openForCartItem,
    confirmPicker,
  };
}
