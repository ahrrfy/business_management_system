import { useEffect, useMemo, useState } from "react";
import { evaluateCartPromotions, type PromotionRule } from "@shared/promotionEngine";
import { todayYmdBaghdad } from "@shared/promotionScheduling";
import { loadOfflineActivePromotions } from "@/lib/offline/catalogSync";
import { D } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import type { CartLine, Tier } from "./cartMath";

export function useReceptionCartPromotions(opts: {
  rawCart: CartLine[];
  branchId: number;
  effectiveTier: Tier;
  offline: boolean;
  canReadPromos: boolean;
  activeDraft: { id: number; version: number } | null;
  couponCode: string | null;
}): CartLine[] {
  const { rawCart, branchId, effectiveTier, offline, canReadPromos, activeDraft, couponCode } = opts;

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

  return useMemo<CartLine[]>(() => {
    if (activeDraft != null || couponCode != null || rawCart.length === 0) {
      return rawCart;
    }
    if (!offline && activePromosQ.data === undefined) {
      return rawCart;
    }
    const rules = offline ? offlineRules : (activePromosQ.data ?? []);
    const eligibleIndices: number[] = [];
    const evalLines = rawCart.flatMap((c, idx) => {
      if (c.digital) return [];
      const hasHistoricalOverride =
        c.origPrice != null && !((c.disc ?? 0) > 0 && D(c.origPrice).eq(D(c.row.price ?? 0)));
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

    if (eligibleIndices.length === 0) return rawCart;

    const evalRes = evaluateCartPromotions(evalLines, rules, {
      branchId,
      customerTier: effectiveTier,
      channel: "POS",
      todayYmd: todayYmdBaghdad(),
    });

    const allocByCartIndex = new Map<number, { promotionId: number; promotionName: string; lineDiscount: string }>();
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
    return rawCart.map((c, idx) => {
      if (!eligibleSet.has(idx)) return c;
      return {
        ...c,
        cartPromo: allocByCartIndex.get(idx) ?? null,
      };
    });
  }, [rawCart, activeDraft, couponCode, offline, offlineRules, activePromosQ.data, branchId, effectiveTier]);
}
