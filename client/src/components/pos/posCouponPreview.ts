import Decimal from "decimal.js";
import { D, round2 } from "@/lib/money";
import type { CartItem, POSTab, Tier } from "./posShared";
import { resetCouponItems } from "./usePOSTabHelpers";

export interface PosCouponPreviewLineResult {
  lineIndex?: number;
  productUnitId: number | string;
  promotionId: number;
  promotionName: string;
  promotionDiscountForUnit: string;
  promotionEffectivePrice: string | null;
  promotionLineDiscount?: string;
}

export interface PosCouponPreviewResult {
  code: string;
  programName: string;
  freeShipping?: boolean;
  freeShippingPromotionName?: string | null;
  lines: PosCouponPreviewLineResult[];
  lineAllocations?: PosCouponPreviewLineResult[];
}

export interface PosCouponPreviewSnapshot {
  requestSeq: number;
  cartRevision: number;
  tabId: number;
  branchId: number;
  effectiveTier: Tier;
  contextKey: string;
}

export interface PosCouponLiveState {
  latestRequestSeq: number;
  cartRevision: number;
  activeTabId: number;
  branchId: number;
  effectiveTier: Tier;
  cartHasDigital: boolean;
  tab: POSTab | undefined;
}

export function buildPosCouponContextKey(opts: {
  tab: Pick<POSTab, "id" | "customerId" | "couponInput" | "cart">;
  branchId: number;
  effectiveTier: Tier;
}): string {
  const baseItems = resetCouponItems(opts.tab.cart);
  return JSON.stringify([
    opts.tab.id,
    opts.branchId,
    opts.effectiveTier,
    opts.tab.customerId ?? null,
    opts.tab.couponInput.trim(),
    baseItems.map((c) => [
      c.digital?.lineKey ?? null,
      c.row.productId,
      c.row.variantId,
      c.row.productUnitId,
      c.qty,
      String(c.row.price ?? "0"),
      Boolean(c.row.isContractPrice),
      c.origPrice ?? null,
      c.disc ?? null,
    ]),
  ]);
}

export function capturePosCouponPreviewSnapshot(opts: {
  requestSeq: number;
  cartRevision: number;
  tab: Pick<POSTab, "id" | "customerId" | "couponInput" | "cart">;
  branchId: number;
  effectiveTier: Tier;
}): PosCouponPreviewSnapshot {
  return {
    requestSeq: opts.requestSeq,
    cartRevision: opts.cartRevision,
    tabId: opts.tab.id,
    branchId: opts.branchId,
    effectiveTier: opts.effectiveTier,
    contextKey: buildPosCouponContextKey(opts),
  };
}

export function buildPosCouponPreviewInput(opts: {
  tab: Pick<POSTab, "customerId" | "couponInput" | "cart">;
  branchId: number;
  effectiveTier: Tier;
}) {
  const baseItems = resetCouponItems(opts.tab.cart);
  return {
    code: opts.tab.couponInput.trim(),
    branchId: opts.branchId,
    customerId: opts.tab.customerId ?? undefined,
    customerTier: opts.effectiveTier,
    lines: baseItems.map((item) => ({
      productId: item.row.productId,
      variantId: item.row.variantId,
      productUnitId: item.row.productUnitId,
      unitPrice: String(item.row.price ?? "0"),
      quantity: item.qty,
      hasContractPrice: item.row.isContractPrice,
    })),
  };
}

export function isPosCouponPreviewFresh(
  snapshot: PosCouponPreviewSnapshot,
  live: PosCouponLiveState,
): boolean {
  if (live.cartHasDigital) return false;
  if (snapshot.requestSeq !== live.latestRequestSeq) return false;
  if (snapshot.cartRevision !== live.cartRevision) return false;
  if (snapshot.tabId !== live.activeTabId) return false;
  if (snapshot.branchId !== live.branchId) return false;
  if (snapshot.effectiveTier !== live.effectiveTier) return false;
  if (!live.tab || live.tab.cart.some((c) => Boolean(c.digital))) return false;
  return (
    buildPosCouponContextKey({
      tab: live.tab,
      branchId: live.branchId,
      effectiveTier: live.effectiveTier,
    }) === snapshot.contextKey
  );
}

export function applyPosCouponPreviewToCart(
  items: CartItem[],
  result: PosCouponPreviewResult,
): CartItem[] {
  if (Array.isArray(result.lineAllocations)) {
    const byLineIdx = new Map(
      result.lineAllocations
        .filter((line) => typeof line.lineIndex === "number")
        .map((line) => [Number(line.lineIndex), line]),
    );
    return items.map((item, idx) => {
      const base = item.preCouponRow ?? item.row;
      const applied = byLineIdx.get(idx);
      if (!applied) {
        return { ...item, row: base, preCouponRow: undefined, cartPromo: null };
      }
      const lineDiscount =
        applied.promotionLineDiscount ??
        round2(D(applied.promotionDiscountForUnit).times(item.qty)).toFixed(2);
      return {
        ...item,
        disc: undefined,
        preCouponRow: base,
        cartPromo: {
          promotionId: applied.promotionId,
          promotionName: applied.promotionName,
          lineDiscount,
        },
        row: {
          ...base,
          promotionId: applied.promotionId,
          promotionName: applied.promotionName,
          promotionDiscountForUnit: applied.promotionDiscountForUnit,
          promotionEffectivePrice: applied.promotionEffectivePrice,
        },
      };
    });
  }

  const byUnit = new Map(
    result.lines.map((line) => [Number(line.productUnitId), line]),
  );
  const indicesByUnit = new Map<number, number[]>();
  items.forEach((item, idx) => {
    const base = item.preCouponRow ?? item.row;
    const unitId = Number(base.productUnitId);
    if (!byUnit.has(unitId)) return;
    const list = indicesByUnit.get(unitId);
    if (list) list.push(idx);
    else indicesByUnit.set(unitId, [idx]);
  });

  const splitDiscByIdx = new Map<number, string>();
  indicesByUnit.forEach((groupIndices, unitId) => {
    const applied = byUnit.get(unitId);
    if (!applied || applied.promotionLineDiscount == null) return;
    const totalDisc = Decimal.max(D(0), round2(D(applied.promotionLineDiscount)));
    if (groupIndices.length === 1) {
      splitDiscByIdx.set(groupIndices[0]!, totalDisc.toFixed(2));
      return;
    }
    const weights = groupIndices.map((idx) => {
      const it = items[idx]!;
      const base = it.preCouponRow ?? it.row;
      const gross = round2(round2(D(base.price ?? 0)).times(it.qty));
      return { idx, gross, weight: gross.gt(0) ? gross : D(Math.max(1, it.qty)) };
    });
    const totalWeight = weights.reduce((s, w) => s.plus(w.weight), D(0));
    let remaining = totalDisc;
    weights.forEach((w, pos) => {
      const isLast = pos === weights.length - 1;
      const rawShare = isLast
        ? remaining
        : totalWeight.gt(0)
          ? round2(totalDisc.times(w.weight).div(totalWeight))
          : D(0);
      const share = Decimal.min(
        w.gross.gt(0) ? Decimal.min(w.gross, remaining) : remaining,
        Decimal.max(D(0), rawShare),
      );
      remaining = Decimal.max(D(0), round2(remaining.minus(share)));
      splitDiscByIdx.set(w.idx, share.toFixed(2));
    });
  });

  return items.map((item, idx) => {
    const base = item.preCouponRow ?? item.row;
    const applied = byUnit.get(Number(base.productUnitId));
    if (!applied) {
      return { ...item, row: base, preCouponRow: undefined, cartPromo: null };
    }
    const lineDiscount =
      splitDiscByIdx.get(idx) ??
      round2(D(applied.promotionDiscountForUnit).times(item.qty)).toFixed(2);
    const unitDisc =
      item.qty > 0 ? round2(D(lineDiscount).div(item.qty)) : D(0);
    const effPrice =
      applied.promotionLineDiscount != null &&
      (indicesByUnit.get(Number(base.productUnitId))?.length ?? 0) > 1
        ? Decimal.max(D(0), round2(D(base.price ?? 0)).minus(unitDisc)).toFixed(2)
        : applied.promotionEffectivePrice;
    return {
      ...item,
      disc: undefined,
      preCouponRow: base,
      cartPromo: {
        promotionId: applied.promotionId,
        promotionName: applied.promotionName,
        lineDiscount,
      },
      row: {
        ...base,
        promotionId: applied.promotionId,
        promotionName: applied.promotionName,
        promotionDiscountForUnit:
          (indicesByUnit.get(Number(base.productUnitId))?.length ?? 0) > 1
            ? unitDisc.toFixed(2)
            : applied.promotionDiscountForUnit,
        promotionEffectivePrice: effPrice,
      },
    };
  });
}

export function applyPosCouponPreviewToTabs(
  tabs: POSTab[],
  snapshot: PosCouponPreviewSnapshot,
  liveMeta: Omit<PosCouponLiveState, "tab">,
  result: PosCouponPreviewResult,
): POSTab[] {
  const target = tabs.find((t) => t.id === snapshot.tabId);
  if (!isPosCouponPreviewFresh(snapshot, { ...liveMeta, tab: target })) {
    return tabs;
  }
  return tabs.map((t) =>
    t.id !== snapshot.tabId
      ? t
      : {
          ...t,
          cart: applyPosCouponPreviewToCart(t.cart, result),
          couponInput: result.code,
          couponCode: result.code,
          couponLabel: result.programName,
          couponFreeShippingPromo: result.freeShipping
            ? (result.freeShippingPromotionName ?? result.programName)
            : null,
        },
  );
}
