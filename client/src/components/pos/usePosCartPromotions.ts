import { useEffect, useMemo, useState } from "react";
import { evaluateCartPromotions, type PromotionRule } from "@shared/promotionEngine";
import { todayYmdBaghdad } from "@shared/promotionScheduling";
import { loadOfflineActivePromotions } from "@/lib/offline/catalogSync";
import { D } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import type { DeliveryDraft } from "./deliveryMode";
import type { CartItem, Tier } from "./posShared";

export interface UsePosCartPromotionsResult {
  cart: CartItem[];
  freeShippingPromoName: string | null;
}

/**
 * يطابق حالة تحصيل أجرة التوصيل مع عرض/كوبون التوصيل المجاني مع حفظ علامة الملكية التلقائية
 * والتحصيل الأصلي داخل `DeliveryDraft` نفسه لتصمد عبر حفظ المسوّدة وتحديث الصفحة وتبديل التبويبات.
 */
export function reconcilePosDeliveryAutoFreeShipping(opts: {
  delivery: DeliveryDraft | null;
  freeShippingPromoName: string | null;
  promosReady: boolean;
}): DeliveryDraft | null {
  const { delivery, freeShippingPromoName, promosReady } = opts;
  if (!delivery || !promosReady) return null;

  if (freeShippingPromoName) {
    if (delivery.autoFreeShippingPromoName === freeShippingPromoName) {
      return null;
    }
    if (delivery.feeCollection !== "SHOP") {
      return {
        ...delivery,
        feeCollection: "SHOP",
        autoFreeShippingOwned: true,
        autoFreeShippingPrevCollection: delivery.feeCollection,
        autoFreeShippingPromoName: freeShippingPromoName,
      };
    }
    return {
      ...delivery,
      autoFreeShippingPromoName: freeShippingPromoName,
    };
  }

  if (delivery.autoFreeShippingOwned) {
    const restored =
      delivery.autoFreeShippingPrevCollection &&
      delivery.autoFreeShippingPrevCollection !== "SHOP"
        ? delivery.autoFreeShippingPrevCollection
        : "COURIER";
    return {
      ...delivery,
      feeCollection: restored,
      autoFreeShippingOwned: false,
      autoFreeShippingPrevCollection: undefined,
      autoFreeShippingPromoName: null,
    };
  }

  if (delivery.autoFreeShippingPromoName != null) {
    return {
      ...delivery,
      autoFreeShippingPromoName: null,
    };
  }

  return null;
}

export function usePosCartPromotions(opts: {
  rawCart: CartItem[];
  branchId: number;
  effectiveTier: Tier;
  offline: boolean;
  couponCode: string | null | undefined;
  couponFreeShippingPromo?: string | null;
  tabId?: number;
  delivery?: DeliveryDraft | null;
  onAutoFreeShipping?: (next: DeliveryDraft) => void;
}): UsePosCartPromotionsResult {
  const {
    rawCart,
    branchId,
    effectiveTier,
    offline,
    couponCode,
    couponFreeShippingPromo = null,
    tabId = 0,
    delivery = null,
    onAutoFreeShipping,
  } = opts;

  const activePromosQ = trpc.catalog.activePromotions.useQuery(
    { branchId, tier: effectiveTier },
    { enabled: !offline && branchId > 0, staleTime: 30_000 },
  );

  const [offlinePromoRules, setOfflinePromoRules] = useState<PromotionRule[] | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!offline) return;
    let live = true;
    void loadOfflineActivePromotions().then((rules) => {
      if (live) setOfflinePromoRules(rules);
    });
    return () => {
      live = false;
    };
  }, [offline, branchId]);

  const activePromoRules = offline ? offlinePromoRules : activePromosQ.data;

  const evaluated = useMemo(() => {
    if (couponCode || activePromoRules === undefined || rawCart.length === 0) {
      return { cart: rawCart, autoFreeShippingName: null as string | null };
    }
    const evalItems = rawCart.flatMap((c, idx) => {
      if (c.digital || c.row.price == null) return [];
      const hasManualOverride =
        c.origPrice != null && !D(c.origPrice).eq(D(c.row.price ?? 0));
      const ineligibleForPromo = Boolean(c.row.isPrintService) || hasManualOverride;
      return [
        {
          lineKey: String(idx),
          productId: c.row.productId,
          variantId: c.row.variantId,
          productUnitId: c.row.productUnitId,
          categoryId: (c.row as { categoryId?: number | null }).categoryId ?? null,
          unitPrice: D(c.row.price).toDecimalPlaces(0, 4).toFixed(2),
          quantity: c.qty,
          isBaseUnit: c.row.isBaseUnit !== false,
          hasContractPrice: !!c.row.isContractPrice || ineligibleForPromo,
          isBundle: !!c.row.isBundle,
          isGift: false,
          isService: !!c.row.isService || !!c.row.isPrintService,
        },
      ];
    });
    if (!evalItems.length) {
      return { cart: rawCart, autoFreeShippingName: null as string | null };
    }
    const res = evaluateCartPromotions(evalItems, activePromoRules, {
      branchId,
      customerTier: effectiveTier,
      channel: "POS",
      todayYmd: todayYmdBaghdad(),
    });
    const nextCart = rawCart.map((c, idx) => {
      if (c.digital || c.row.isPrintService || c.row.price == null) return c;
      const hasManualOverride =
        c.origPrice != null && !D(c.origPrice).eq(D(c.row.price ?? 0));
      if (hasManualOverride) return c;
      const alloc = res.lineAllocations.get(String(idx));
      return {
        ...c,
        cartPromo:
          alloc && alloc.discountAmount.gt(0)
            ? {
                promotionId: alloc.promotionId,
                promotionName: alloc.promotionName,
                lineDiscount: alloc.discountAmount.toFixed(2),
              }
            : null,
      };
    });
    return {
      cart: nextCart,
      autoFreeShippingName: res.freeShippingPromotion?.promotionName ?? null,
    };
  }, [rawCart, couponCode, activePromoRules, branchId, effectiveTier]);

  const freeShippingPromoName = couponCode
    ? (couponFreeShippingPromo ?? null)
    : evaluated.autoFreeShippingName;
  const promosReady =
    Boolean(couponCode) || activePromoRules !== undefined || rawCart.length === 0;

  useEffect(() => {
    if (!delivery || !onAutoFreeShipping) return;
    const nextDelivery = reconcilePosDeliveryAutoFreeShipping({
      delivery,
      freeShippingPromoName,
      promosReady,
    });
    if (nextDelivery) {
      onAutoFreeShipping(nextDelivery);
    }
  }, [tabId, delivery, freeShippingPromoName, promosReady, onAutoFreeShipping]);

  return {
    cart: evaluated.cart,
    freeShippingPromoName,
  };
}
