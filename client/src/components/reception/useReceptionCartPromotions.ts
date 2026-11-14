import { useEffect, useMemo, useRef, useState } from "react";
import { evaluateCartPromotions, type PromotionRule } from "@shared/promotionEngine";
import { todayYmdBaghdad } from "@shared/promotionScheduling";
import { loadOfflineActivePromotions } from "@/lib/offline/catalogSync";
import { D } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import type { OrderDeliveryValue } from "./ReceptionTypes";
import { resolveDraftGoodsPricing, type CartLine, type Tier } from "./cartMath";

export interface UseReceptionCartPromotionsResult {
  cart: CartLine[];
  freeShippingPromoName: string | null;
}

/**
 * يُروّج أجرة التوصيل إلى «على المكتبة» (SHOP) عندما ينطبق عرض أو كوبون توصيل مجاني،
 * مع صون حالة «مقبوضة في الاستقبال» (COUNTER) لأنّها أمانة نقدية مقبوضة فعلياً.
 */
export function applyFreeShippingToOrderDelivery(
  orderDelivery: OrderDeliveryValue | null,
  freeShippingPromoName: string | null | undefined,
): OrderDeliveryValue | null {
  if (!orderDelivery || !freeShippingPromoName) return orderDelivery;
  if (orderDelivery.feeCollection === "COUNTER" || orderDelivery.feeCollection === "SHOP") {
    return orderDelivery;
  }
  return { ...orderDelivery, feeCollection: "SHOP" };
}

export function evaluateReceptionCartPromotionsPure(opts: {
  rawCart: CartLine[];
  rules: PromotionRule[];
  branchId: number;
  effectiveTier: Tier;
  todayYmd?: string;
}): { cart: CartLine[]; autoFreeShippingName: string | null } {
  const { rawCart, rules, branchId, effectiveTier, todayYmd = todayYmdBaghdad() } = opts;
  if (rawCart.length === 0) {
    return { cart: rawCart, autoFreeShippingName: null };
  }
  const eligibleIndices: number[] = [];
  const evalLines = rawCart.flatMap((c, idx) => {
    if (c.digital) return [];
    const hasHistoricalOverride =
      c.draftLineDiscount != null ||
      c.draftPromo != null ||
      (c.origPrice != null && !((c.disc ?? 0) > 0 && D(c.origPrice).eq(D(c.row.price ?? 0))));
    const ineligible = Boolean(
      c.custom || c.row.isPrintService || c.manualService || hasHistoricalOverride,
    );
    const rowAny = c.row as unknown as Record<string, unknown>;
    if (ineligible) {
      return [
        {
          lineKey: `ineligible_${idx}`,
          productId: Number(c.row.productId ?? 0),
          variantId: Number(c.row.variantId ?? 0),
          productUnitId: Number(c.row.productUnitId ?? 0),
          categoryId: null,
          quantity: c.qty,
          unitPrice: String(c.row.price ?? "0"),
          isBaseUnit: true,
          isBundle: false,
          hasContractPrice: true,
          isDigitalCard: false,
          isService: true,
        },
      ];
    }
    eligibleIndices.push(idx);
    return [
      {
        lineKey: String(eligibleIndices.length - 1),
        productId: Number(c.row.productId),
        variantId: Number(c.row.variantId),
        productUnitId: Number(c.row.productUnitId),
        categoryId: typeof rowAny.categoryId === "number" ? rowAny.categoryId : null,
        quantity: c.qty,
        unitPrice: String(c.row.price ?? "0"),
        isBaseUnit: c.row.isBaseUnit !== false,
        isBundle: Boolean(rowAny.isBundle),
        hasContractPrice: Boolean(c.row.isContractPrice),
        isDigitalCard: false,
        isService: Boolean(c.row.isService),
      },
    ];
  });

  if (eligibleIndices.length === 0) {
    return { cart: rawCart, autoFreeShippingName: null };
  }

  const evalRes = evaluateCartPromotions(evalLines, rules, {
    branchId,
    customerTier: effectiveTier,
    channel: "POS",
    todayYmd,
  });

  const allocByCartIndex = new Map<
    number,
    { promotionId: number; promotionName: string; lineDiscount: string }
  >();
  for (const alloc of Array.from(evalRes.lineAllocations.values())) {
    const cartIdx = eligibleIndices[Number(alloc.lineKey)];
    if (cartIdx !== undefined && alloc.promotionId != null && alloc.discountAmount.gt(0)) {
      allocByCartIndex.set(cartIdx, {
        promotionId: alloc.promotionId,
        promotionName: alloc.promotionName ?? "عرض ترويجي",
        lineDiscount: alloc.discountAmount.toFixed(2),
      });
    }
  }

  const eligibleSet = new Set(eligibleIndices);
  const nextCart = rawCart.map((c, idx) => {
    if (!eligibleSet.has(idx)) return c;
    return {
      ...c,
      cartPromo: allocByCartIndex.get(idx) ?? null,
    };
  });

  return {
    cart: nextCart,
    autoFreeShippingName: evalRes.freeShippingPromotion?.promotionName ?? null,
  };
}

/**
 * عند ترقية السلة المحلية إلى طلب محفوظ (saveDraft / openDepositCollect)، يتوقف التقييم الحيّ
 * لعروض السلة التلقائية (`activeDraft != null`)؛ نثبّت السعر الفعّال المحسوب في `origPrice`
 * تماماً كما يفعل `prepareReceptionDraftCart` عند استئناف المسوّدة من الخادم، حتى لا تعود
 * الأسعار إلى السعر الخام أو تطمس مزامنة الـ800ms السعر المخفّض المحفوظ.
 */
export function freezeReceptionDraftCart(evaluatedCart: CartLine[]): CartLine[] {
  return evaluatedCart.map((c) => {
    if (c.custom || c.digital || c.row.isPrintService) {
      return c;
    }
    const pricing = resolveDraftGoodsPricing(c);
    const {
      cartPromo: _cp,
      disc: _disc,
      draftLineDiscount: _prevDraftDisc,
      draftPromo: _prevDraftPromo,
      ...rest
    } = c;
    if (
      pricing.promotionId != null &&
      pricing.promotionDiscount != null &&
      pricing.promotionDiscount.gt(0) &&
      pricing.discountAmount != null &&
      pricing.discountAmount.gt(0)
    ) {
      return {
        ...rest,
        origPrice: pricing.unitPrice.toNumber(),
        draftLineDiscount: pricing.discountAmount.toFixed(2),
        draftPromo: {
          promotionId: pricing.promotionId,
          ...(pricing.promotionName ? { promotionName: pricing.promotionName } : {}),
          promotionDiscount: pricing.promotionDiscount.toFixed(2),
        },
      };
    }
    if (c.cartPromo === undefined) {
      return c;
    }
    if (c.cartPromo == null) {
      const { cartPromo: _clearNullPromo, ...noPromoRest } = c;
      if (noPromoRest.origPrice == null && noPromoRest.row.promotionEffectivePrice != null) {
        return { ...noPromoRest, origPrice: Number(noPromoRest.row.price ?? 0) };
      }
      return noPromoRest;
    }
    if (pricing.discountAmount && pricing.discountAmount.gt(0)) {
      return {
        ...rest,
        origPrice: pricing.unitPrice.toNumber(),
        draftLineDiscount: pricing.discountAmount.toFixed(2),
      };
    }
    const defaultCatalogPrice = Number(c.row.promotionEffectivePrice ?? c.row.price ?? 0);
    const eff = pricing.unitPrice.toNumber();
    return eff !== defaultCatalogPrice
      ? { ...rest, origPrice: eff }
      : { ...rest, origPrice: undefined };
  });
}

export function useReceptionCartPromotions(opts: {
  rawCart: CartLine[];
  branchId: number;
  effectiveTier: Tier;
  offline: boolean;
  canReadPromos: boolean;
  activeDraft: { id: number; version: number } | null;
  couponCode: string | null;
  couponFreeShippingPromo?: string | null;
  orderDelivery?: OrderDeliveryValue | null;
  onAutoFreeShipping?: (next: OrderDeliveryValue) => void;
}): UseReceptionCartPromotionsResult {
  const {
    rawCart,
    branchId,
    effectiveTier,
    offline,
    canReadPromos,
    activeDraft,
    couponCode,
    couponFreeShippingPromo = null,
    orderDelivery = null,
    onAutoFreeShipping,
  } = opts;

  const activePromosQ = trpc.catalog.activePromotions.useQuery(
    { branchId, tier: effectiveTier },
    { enabled: branchId > 0 && canReadPromos && !offline, staleTime: 30_000 },
  );

  const [offlineRules, setOfflineRules] = useState<PromotionRule[]>([]);
  useEffect(() => {
    if (!offline || !canReadPromos) {
      setOfflineRules([]);
      return;
    }
    let cancelled = false;
    void loadOfflineActivePromotions().then((rules) => {
      if (!cancelled) setOfflineRules(rules);
    });
    return () => {
      cancelled = true;
    };
  }, [offline, canReadPromos, branchId]);

  const evaluated = useMemo(() => {
    if (activeDraft != null || couponCode != null || rawCart.length === 0) {
      return { cart: rawCart, autoFreeShippingName: null as string | null };
    }
    if (!offline && activePromosQ.data === undefined) {
      return { cart: rawCart, autoFreeShippingName: null as string | null };
    }
    const rules = offline ? offlineRules : (activePromosQ.data ?? []);
    return evaluateReceptionCartPromotionsPure({
      rawCart,
      rules,
      branchId,
      effectiveTier,
    });
  }, [rawCart, activeDraft, couponCode, offline, offlineRules, activePromosQ.data, branchId, effectiveTier]);

  const freeShippingPromoName =
    activeDraft != null
      ? null
      : couponCode != null
        ? (couponFreeShippingPromo ?? null)
        : evaluated.autoFreeShippingName;

  const autoManagedRef = useRef(false);
  const lastAppliedPromoRef = useRef<string | null>(null);

  useEffect(() => {
    if (!orderDelivery || !onAutoFreeShipping) {
      lastAppliedPromoRef.current = null;
      autoManagedRef.current = false;
      return;
    }
    if (freeShippingPromoName) {
      if (lastAppliedPromoRef.current !== freeShippingPromoName) {
        lastAppliedPromoRef.current = freeShippingPromoName;
        if (
          orderDelivery.feeCollection !== "SHOP" &&
          orderDelivery.feeCollection !== "COUNTER"
        ) {
          autoManagedRef.current = true;
          onAutoFreeShipping({ ...orderDelivery, feeCollection: "SHOP" });
        }
      }
      return;
    }
    lastAppliedPromoRef.current = null;
    if (autoManagedRef.current) {
      autoManagedRef.current = false;
      if (orderDelivery.feeCollection === "SHOP") {
        onAutoFreeShipping({ ...orderDelivery, feeCollection: "COURIER" });
      }
    }
  }, [orderDelivery, freeShippingPromoName, onAutoFreeShipping]);

  return {
    cart: evaluated.cart,
    freeShippingPromoName,
  };
}
