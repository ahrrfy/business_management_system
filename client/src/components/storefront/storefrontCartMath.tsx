import { noteInteraction } from "@/lib/interactionDraft";
import { fmtInt } from "@/lib/money";
import { normalizeArabicSearch } from "@shared/storefrontSearchNormalize";
import {
  type StorefrontCustomization,
  customizationCartKey,
  summarizeStorefrontCustomization,
} from "./storefrontCustomizationModel";
import { storefrontProductCanBeOrdered } from "./StorefrontRecommendations";

export interface CartLine {
  cartKey: string;
  productUnitId: number;
  productId: number;
  name: string;
  price: string; // سعر العرض المؤثّر (للعرض — الخادم يُعيد التسعير)
  imageUrl: string | null;
  unitName: string;
  variantLabel?: string;
  isCustomizable?: boolean;
  customization?: StorefrontCustomization;
  /** حدّ معروف من رد المخزون؛ null يعني أن الكمية الدقيقة غير معلنة للعميل. */
  stockLimit?: number | null;
  qty: number;
}

export interface StorefrontPricingSnapshot {
  productId: number;
  storeUnits?: Array<{
    productUnitId: number;
    price: string | null;
    salePrice: string | null;
  }>;
  variants?: Array<{
    units: Array<{
      productUnitId: number;
      price: string | null;
      salePrice: string | null;
    }>;
  }>;
}

export function reconcileStorefrontCartPricing(
  current: Map<string, CartLine>,
  latestByProduct: Map<number, StorefrontPricingSnapshot | null | undefined>,
): {
  cart: Map<string, CartLine>;
  priceChanged: number;
  unavailable: number;
  unresolved: number;
} {
  const cart = new Map(current);
  let priceChanged = 0;
  let unavailable = 0;
  let unresolved = 0;
  for (const line of Array.from(current.values())) {
    const snapshot = latestByProduct.get(line.productId);
    // undefined = فشل شبكة عابر؛ لا نحذف سطر الزبون بسببه. null = المنتج لم يعد منشوراً.
    if (snapshot === undefined) {
      unresolved += 1;
      continue;
    }
    const units =
      snapshot == null
        ? []
        : [
            ...(snapshot.storeUnits ?? []),
            ...(snapshot.variants ?? []).flatMap((variant) => variant.units),
          ];
    const unit = units.find(
      (candidate) => candidate.productUnitId === line.productUnitId,
    );
    const currentBasePrice = unit?.salePrice ?? unit?.price ?? null;
    if (currentBasePrice == null) {
      cart.delete(line.cartKey);
      unavailable += 1;
      continue;
    }
    const currentPrice = (
      Number(currentBasePrice) + Number(line.customization?.priceDelta ?? 0)
    ).toFixed(2);
    if (Number(currentPrice).toFixed(2) !== Number(line.price).toFixed(2)) {
      cart.set(line.cartKey, {
        ...line,
        price: Number(currentPrice).toFixed(2),
      });
      priceChanged += 1;
    }
  }
  return { cart, priceChanged, unavailable, unresolved };
}

export function reconcileStorefrontCartQuote(
  current: Map<string, CartLine>,
  quotedLines: Array<{
    productUnitId: number;
    quantity: number;
    unitPrice: string;
  }>,
): { cart: Map<string, CartLine>; priceChanged: number; unresolved: number } {
  const cart = new Map(current);
  let priceChanged = 0;
  let unresolved = 0;
  const currentLines = Array.from(current.values());
  for (let index = 0; index < currentLines.length; index += 1) {
    const line = currentLines[index]!;
    const quoted = quotedLines[index];
    if (!quoted || quoted.quantity !== line.qty) {
      unresolved += 1;
      continue;
    }
    const price = Number(quoted.unitPrice).toFixed(2);
    if (price !== Number(line.price).toFixed(2)) {
      cart.set(line.cartKey, { ...line, price });
      priceChanged += 1;
    }
  }
  return { cart, priceChanged, unresolved };
}

export type StorefrontCartProduct = {
  productUnitId: number;
  productId: number;
  productName: string;
  imageUrl: string | null;
  unitName: string;
  variantLabel?: string;
  isCustomizable?: boolean;
  customization?: StorefrontCustomization;
  stockLimit?: number | null;
};

export type StorefrontCartSelection = StorefrontCartProduct & {
  effectivePrice: string;
  quantity: number;
};

export function addStorefrontCartLine(
  current: Map<string, CartLine>,
  product: StorefrontCartProduct,
  effectivePrice: string,
): Map<string, CartLine> {
  if (
    !storefrontProductCanBeOrdered(product) ||
    (product.isCustomizable && !product.customization)
  )
    return new Map(current);
  const next = new Map(current);
  const cartKey = customizationCartKey(
    product.productUnitId,
    product.customization,
  );
  const existing = next.get(cartKey);
  const customizationLabel = summarizeStorefrontCustomization(
    product.customization,
  );
  const stockLimit =
    product.stockLimit == null
      ? (existing?.stockLimit ?? null)
      : Math.max(1, Math.min(Math.floor(product.stockLimit), 999));
  next.set(cartKey, {
    cartKey,
    productUnitId: product.productUnitId,
    productId: product.productId,
    name: product.variantLabel
      ? `${product.productName} — ${product.variantLabel}`
      : product.productName,
    price: effectivePrice,
    imageUrl: product.imageUrl,
    unitName: product.unitName,
    variantLabel: product.variantLabel,
    isCustomizable: product.isCustomizable,
    customization: product.customization,
    stockLimit,
    qty: Math.min((existing?.qty ?? 0) + 1, stockLimit ?? 999),
    ...(customizationLabel ? { customization: product.customization } : {}),
  });
  return next;
}

export function addStorefrontCartLines(
  current: Map<string, CartLine>,
  selections: StorefrontCartSelection[],
): Map<string, CartLine> {
  let next = new Map(current);
  for (const selection of selections) {
    if (
      !storefrontProductCanBeOrdered(selection) ||
      (selection.isCustomizable && !selection.customization) ||
      !Number.isInteger(selection.quantity) ||
      selection.quantity <= 0
    )
      continue;
    const line = addStorefrontCartLine(
      next,
      selection,
      selection.effectivePrice,
    );
    const cartKey = customizationCartKey(
      selection.productUnitId,
      selection.customization,
    );
    const added = line.get(cartKey)!;
    line.set(cartKey, {
      ...added,
      qty: Math.min(
        (next.get(cartKey)?.qty ?? 0) + selection.quantity,
        added.stockLimit ?? 999,
      ),
    });
    next = line;
  }
  return next;
}

export function setStorefrontCartQuantity(
  current: Map<string, CartLine>,
  cartKey: string,
  quantity: number,
): Map<string, CartLine> {
  const line = current.get(cartKey);
  if (!line) return current;
  const next = new Map(current);
  if (quantity <= 0) next.delete(cartKey);
  else
    next.set(cartKey, {
      ...line,
      qty: Math.min(Math.floor(quantity), line.stockLimit ?? 999),
    });
  return next;
}

export function recordStorefrontCartChange(
  markChanged: () => void = noteInteraction,
): void {
  markChanged();
}

export interface StorefrontProductCartSummary {
  totalQty: number;
  lineCount: number;
  singleLine: { cartKey: string; qty: number } | null;
}

export type StorefrontProductQuantityDeltaAction =
  | { kind: "noop" }
  | { kind: "set-line-qty"; cartKey: string; nextQty: number }
  | { kind: "open-product"; productId: number }
  | { kind: "open-cart"; productId: number };

export function summarizeStorefrontProductCartQuantities(
  cart: ReadonlyMap<string, CartLine>,
): Map<number, StorefrontProductCartSummary> {
  const map = new Map<number, StorefrontProductCartSummary>();
  cart.forEach((line, key) => {
    if (line.isCustomizable || line.customization) return;
    const prev = map.get(line.productId);
    if (!prev) {
      map.set(line.productId, {
        totalQty: line.qty,
        lineCount: 1,
        singleLine: { cartKey: key, qty: line.qty },
      });
    } else {
      map.set(line.productId, {
        totalQty: prev.totalQty + line.qty,
        lineCount: prev.lineCount + 1,
        singleLine: null,
      });
    }
  });
  return map;
}

export function resolveStorefrontProductQuantityDelta(
  summaries: ReadonlyMap<number, StorefrontProductCartSummary>,
  productId: number,
  delta: number,
): StorefrontProductQuantityDeltaAction {
  if (!Number.isFinite(delta) || delta === 0) return { kind: "noop" };
  const info = summaries.get(productId);
  if (!info || info.lineCount === 0) return { kind: "noop" };
  if (info.singleLine) {
    return {
      kind: "set-line-qty",
      cartKey: info.singleLine.cartKey,
      nextQty: info.singleLine.qty + delta,
    };
  }
  return delta > 0
    ? { kind: "open-product", productId }
    : { kind: "open-cart", productId };
}

export function summarizeSingleStorefrontProductCartQuantity(
  cart: ReadonlyMap<string, CartLine>,
  productId: number,
): StorefrontProductCartSummary | undefined {
  let summary: StorefrontProductCartSummary | undefined;
  cart.forEach((line, key) => {
    if (line.productId !== productId) return;
    if (line.isCustomizable || line.customization) return;
    if (!summary) {
      summary = {
        totalQty: line.qty,
        lineCount: 1,
        singleLine: { cartKey: key, qty: line.qty },
      };
    } else {
      summary = {
        totalQty: summary.totalQty + line.qty,
        lineCount: summary.lineCount + 1,
        singleLine: null,
      };
    }
  });
  return summary;
}

export function applyStorefrontProductQuantityDelta(
  cart: ReadonlyMap<string, CartLine>,
  _summaries: ReadonlyMap<number, StorefrontProductCartSummary> | null | undefined,
  productId: number,
  delta: number,
  handlers: {
    setQty: (cartKey: string, qty: number) => void;
    openProduct: (productId: number) => void;
    openCart: (productId: number) => void;
  },
): StorefrontProductQuantityDeltaAction {
  const liveSummary = summarizeSingleStorefrontProductCartQuantity(cart, productId);
  const liveMap = liveSummary
    ? new Map<number, StorefrontProductCartSummary>([[productId, liveSummary]])
    : new Map<number, StorefrontProductCartSummary>();
  const action = resolveStorefrontProductQuantityDelta(
    liveMap,
    productId,
    delta,
  );
  if (action.kind === "set-line-qty") {
    if (cart.has(action.cartKey)) {
      handlers.setQty(action.cartKey, action.nextQty);
    }
  } else if (action.kind === "open-product") {
    handlers.openProduct(action.productId);
  } else if (action.kind === "open-cart") {
    handlers.openCart(action.productId);
  }
  return action;
}

export function money(v: string | number | null): string {
  if (v == null || v === "") return "0";
  return fmtInt(v);
}

export const normalizeStorefrontArabic = normalizeArabicSearch;

export function priceLabel(price: string | null): string {
  if (price == null || price === "") return "اسأل الموظّف";
  return `${money(price)} د.ع`;
}
