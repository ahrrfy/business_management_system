import { useEffect, useRef, useState } from "react";
import { evaluateCartPromotions } from "@shared/promotionEngine";
import { todayYmdBaghdad } from "@shared/promotionScheduling";
import { D } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { invoiceReducer } from "./reducer";
import type { InvoiceAction, InvoiceLine, InvoiceState, PriceTier } from "./types";

export type SyncPromotionsAction = {
  type: "SYNC_PROMOTIONS";
  allocationsByIndex: Record<
    number,
    { promotionId: number; promotionName: string; discountAmount: string }
  >;
  eligibleIndices: number[];
};

export function salesInvoiceWithPromotionsReducer(
  state: InvoiceState,
  action: InvoiceAction | SyncPromotionsAction,
): InvoiceState {
  if (action.type === "SYNC_PROMOTIONS") {
    const eligibleSet = new Set(action.eligibleIndices);
    let changed = false;
    const nextItems = state.items.map((item, idx): InvoiceLine => {
      if (!eligibleSet.has(idx)) return item;
      const alloc = action.allocationsByIndex[idx];
      if (alloc) {
        if (
          item.autoPromoManaged === true &&
          item.promotionId === alloc.promotionId &&
          item.promotionName === alloc.promotionName &&
          item.promotionDiscount === alloc.discountAmount &&
          item.discountType === "amount" &&
          item.discount === alloc.discountAmount
        ) {
          return item;
        }
        changed = true;
        return {
          ...item,
          discountType: "amount",
          discount: alloc.discountAmount,
          promotionId: alloc.promotionId,
          promotionName: alloc.promotionName,
          promotionDiscount: alloc.discountAmount,
          autoPromoManaged: true,
        };
      }
      if (item.autoPromoManaged === true || item.promotionId != null) {
        changed = true;
        return {
          ...item,
          discountType: "percent",
          discount: "0",
          promotionId: null,
          promotionName: null,
          promotionDiscount: null,
          autoPromoManaged: undefined,
        };
      }
      return item;
    });
    return changed ? { ...state, items: nextItems } : state;
  }

  if (action.type === "UPDATE_ITEM") {
    const prevItem = state.items[action.idx];
    const next = invoiceReducer(state, action);
    const updatedItem = next.items[action.idx];
    if (!prevItem || !updatedItem) return next;

    if (action.field === "price") {
      const items = [...next.items];
      items[action.idx] = {
        ...updatedItem,
        priceSource: "MANUAL",
        promotionId: null,
        promotionName: null,
        promotionDiscount: null,
        autoPromoManaged: false,
        ...(prevItem.autoPromoManaged === true
          ? { discount: "0", discountType: "percent" }
          : {}),
      };
      return { ...next, items };
    }
    if (action.field === "discount") {
      const items = [...next.items];
      items[action.idx] = {
        ...updatedItem,
        discountType: "percent",
        promotionId: null,
        promotionName: null,
        promotionDiscount: null,
        autoPromoManaged: false,
      };
      return { ...next, items };
    }
    if (action.field === "discountType") {
      const items = [...next.items];
      items[action.idx] = {
        ...updatedItem,
        promotionId: null,
        promotionName: null,
        promotionDiscount: null,
        autoPromoManaged: false,
      };
      return { ...next, items };
    }
    if (action.field === "isGift" && action.value === true) {
      const items = [...next.items];
      items[action.idx] = {
        ...updatedItem,
        ...(prevItem.autoPromoManaged === true
          ? { discount: "0", discountType: "percent" }
          : {}),
        promotionId: null,
        promotionName: null,
        promotionDiscount: null,
        autoPromoManaged: undefined,
      };
      return { ...next, items };
    }
    return next;
  }

  return invoiceReducer(state, action);
}

export function useInvoiceCartPromotions(opts: {
  items: InvoiceLine[];
  branchId: number;
  tier: PriceTier;
  shipping?: string;
  shippingFree?: boolean;
  enabled: boolean;
  dispatch: React.Dispatch<InvoiceAction | SyncPromotionsAction>;
}): { promotionId: number; promotionName: string } | null {
  const { items, branchId, tier, shipping = "", shippingFree = false, enabled, dispatch } = opts;
  const [freeShippingPromo, setFreeShippingPromo] = useState<{
    promotionId: number;
    promotionName: string;
  } | null>(null);
  const autoShippingManagedRef = useRef(false);

  const activePromosQ = trpc.catalog.activePromotions.useQuery(
    { branchId, tier },
    { enabled: enabled && branchId > 0, staleTime: 30_000 },
  );

  useEffect(() => {
    if (!enabled || branchId <= 0 || items.length === 0) {
      setFreeShippingPromo(null);
      if (shippingFree && autoShippingManagedRef.current) {
        autoShippingManagedRef.current = false;
        dispatch({ type: "SET_FIELD", field: "shippingFree", value: false });
      }
      return;
    }
    if (activePromosQ.data === undefined) return;

    const eligibleIndices: number[] = [];
    const evalLines = items.flatMap((line, idx) => {
      if (line.digital) return [];
      const hasManualDiscount =
        line.autoPromoManaged === false ||
        (line.autoPromoManaged !== true && D(line.discount || "0").gt(0));
      const ineligible = Boolean(
        line.isGift || line.isService || line.priceSource === "MANUAL" || hasManualDiscount,
      );
      if (ineligible) {
        return [
          {
            lineKey: `ineligible_${idx}`,
            productId: Number(line.productId || 0),
            variantId: Number(line.variantId || 0),
            productUnitId: Number(line.productUnitId || 0),
            categoryId: line.categoryId ?? null,
            quantity: line.qty,
            unitPrice: line.price || "0",
            isBaseUnit: line.isBaseUnit !== false,
            isBundle: Boolean(line.isBundle),
            hasContractPrice: true,
            isDigitalCard: false,
            isGift: Boolean(line.isGift),
            isService: Boolean(line.isService),
          },
        ];
      }

      eligibleIndices.push(idx);
      return [
        {
          lineKey: String(eligibleIndices.length - 1),
          productId: Number(line.productId),
          variantId: Number(line.variantId),
          productUnitId: Number(line.productUnitId),
          categoryId: line.categoryId ?? null,
          quantity: line.qty,
          unitPrice: line.price || "0",
          isBaseUnit: line.isBaseUnit !== false,
          isBundle: Boolean(line.isBundle),
          hasContractPrice: line.priceSource === "CONTRACT",
          isDigitalCard: false,
          isGift: false,
          isService: false,
        },
      ];
    });

    if (eligibleIndices.length === 0) {
      setFreeShippingPromo(null);
      if (shippingFree && autoShippingManagedRef.current) {
        autoShippingManagedRef.current = false;
        dispatch({ type: "SET_FIELD", field: "shippingFree", value: false });
      }
      return;
    }

    const evalRes = evaluateCartPromotions(evalLines, activePromosQ.data, {
      branchId,
      customerTier: tier,
      channel: "POS",
      todayYmd: todayYmdBaghdad(),
    });

    const nextFreeShip = evalRes.freeShippingPromotion ?? null;
    setFreeShippingPromo((prev) =>
      prev?.promotionId === nextFreeShip?.promotionId &&
      prev?.promotionName === nextFreeShip?.promotionName
        ? prev
        : nextFreeShip,
    );

    const hasPositiveShipping = D(shipping || "0").gt(0);
    if (nextFreeShip) {
      if (hasPositiveShipping && !shippingFree) {
        autoShippingManagedRef.current = true;
        dispatch({ type: "SET_FIELD", field: "shippingFree", value: true });
      } else if (!hasPositiveShipping && shippingFree && autoShippingManagedRef.current) {
        autoShippingManagedRef.current = false;
        dispatch({ type: "SET_FIELD", field: "shippingFree", value: false });
      }
    } else if (shippingFree && autoShippingManagedRef.current) {
      autoShippingManagedRef.current = false;
      dispatch({ type: "SET_FIELD", field: "shippingFree", value: false });
    }

    const allocationsByIndex: Record<
      number,
      { promotionId: number; promotionName: string; discountAmount: string }
    > = {};
    for (const alloc of Array.from(evalRes.lineAllocations.values())) {
      const cartIdx = eligibleIndices[Number(alloc.lineKey)];
      if (
        cartIdx !== undefined &&
        alloc.promotionId != null &&
        alloc.discountAmount.gt(0)
      ) {
        allocationsByIndex[cartIdx] = {
          promotionId: alloc.promotionId,
          promotionName: alloc.promotionName ?? "عرض ترويجي",
          discountAmount: alloc.discountAmount.toFixed(2),
        };
      }
    }

    dispatch({
      type: "SYNC_PROMOTIONS",
      allocationsByIndex,
      eligibleIndices,
    });
  }, [items, branchId, tier, shipping, shippingFree, enabled, activePromosQ.data, dispatch]);

  return freeShippingPromo;
}
