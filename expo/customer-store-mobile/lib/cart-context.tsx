import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";

import { buildCartLine, productOnlineOrderingIssue } from "@/lib/product-selection";
import type { CartLine, Product, ProductSelectionDetails } from "@/shared/storefront";

type CartContextValue = {
  lines: CartLine[];
  itemCount: number;
  isRestoring: boolean;
  quantityFor: (lineId: string) => number;
  addProduct: (product: Product) => void;
  addSelection: (product: Product, details: ProductSelectionDetails) => void;
  increment: (lineId: string) => void;
  decrement: (lineId: string) => void;
  remove: (lineId: string) => void;
  clearCart: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);
const CART_STORAGE_KEY = "alarabiya-customer-cart-v1";
const MAX_CART_LINES = 30;
const MAX_QUANTITY_PER_LINE = 999;
const MAX_TOTAL_QUANTITY = 10_000;

export function sanitizeCartLines(value: unknown): CartLine[] {
  if (!Array.isArray(value)) return [];
  const result: CartLine[] = [];
  let totalQuantity = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const line = candidate as Partial<CartLine> & { product?: Product };
    const rawQuantity = line.quantity;
    if (!line.product || typeof line.product.id !== "string" || !Number.isInteger(rawQuantity) || rawQuantity == null || rawQuantity < 1) continue;
    const normalized = normalizeCartLine(line.product, line);
    if (!normalized) continue;
    if (result.length >= MAX_CART_LINES || totalQuantity >= MAX_TOTAL_QUANTITY) break;
    const quantity = Math.min(rawQuantity, MAX_QUANTITY_PER_LINE, MAX_TOTAL_QUANTITY - totalQuantity);
    if (quantity < 1) break;
    const boundedQuantity = Math.min(quantity, normalized.maxQuantity);
    result.push({ ...normalized, quantity: boundedQuantity });
    totalQuantity += boundedQuantity;
  }
  return result;
}

function legacySelection(product: Product): ProductSelectionDetails | null {
  if (!Number.isInteger(product.productUnitId) || Number(product.productUnitId) <= 0) return null;
  return {
    variantId: Number(product.variantId ?? product.productId ?? product.productUnitId),
    variantLabel: "الخيار الافتراضي",
    variantKind: "VARIANT",
    productUnitId: Number(product.productUnitId),
    unitName: product.subtitle || "وحدة",
    unitPrice: product.price ?? null,
    unitSalePrice: product.salePrice ?? null,
    imageUrl: product.imageUrl ?? null,
    customization: null,
  };
}

function normalizeCartLine(
  product: Product,
  line?: Partial<CartLine>,
): CartLine | null {
  if (productOnlineOrderingIssue(product)) return null;
  const details = line?.selectionDetails ?? legacySelection(product);
  if (!details || !Number.isInteger(details.productUnitId) || details.productUnitId <= 0) return null;
  const built = buildCartLine(product, details);
  return {
    ...built,
    lineId: typeof line?.lineId === "string" && line.lineId ? line.lineId : built.lineId,
    maxQuantity:
      Number.isInteger(line?.maxQuantity) && Number(line?.maxQuantity) > 0
        ? Math.min(Number(line?.maxQuantity), built.maxQuantity)
        : built.maxQuantity,
    quantity: Number(line?.quantity ?? 1),
  };
}

/** منطق مشترك قابل للاختبار: أول ضغط ينشئ السطر، وكل ضغط لاحق يزيد الكمية نفسها. */
export function addProductToCart(lines: CartLine[], input: Product | CartLine): CartLine[] {
  const product = "lineId" in input ? input.product : input;
  if (productOnlineOrderingIssue(product)) return lines;
  const selected = "lineId" in input ? input : normalizeCartLine(input);
  if (!selected) return lines;
  const existing = lines.find((line) => line.lineId === selected.lineId);
  if (existing) {
    return lines.map((line) => line.lineId === selected.lineId
      ? { ...line, quantity: Math.min(line.quantity + 1, line.maxQuantity, MAX_QUANTITY_PER_LINE) }
      : line);
  }
  const total = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (lines.length >= MAX_CART_LINES || total >= MAX_TOTAL_QUANTITY) return lines;
  return [...lines, selected];
}

export function CartProvider({ children }: PropsWithChildren) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [isRestoring, setIsRestoring] = useState(true);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(CART_STORAGE_KEY)
      .then((raw) => {
        if (!active || !raw) return;
        try { setLines(sanitizeCartLines(JSON.parse(raw))); } catch { setLines([]); }
      })
      .catch(() => undefined)
      .finally(() => { if (active) setIsRestoring(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (isRestoring) return;
    void AsyncStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines)).catch(() => undefined);
  }, [isRestoring, lines]);

  const value = useMemo<CartContextValue>(() => {
    const addProduct = (product: Product) => setLines((current) => addProductToCart(current, product));
    const addSelection = (product: Product, details: ProductSelectionDetails) =>
      setLines((current) => addProductToCart(current, buildCartLine(product, details)));
    const increment = (lineId: string) => setLines((current) => {
      const total = current.reduce((sum, line) => sum + line.quantity, 0);
      if (total >= MAX_TOTAL_QUANTITY) return current;
      return current.map((line) => line.lineId === lineId ? { ...line, quantity: Math.min(line.quantity + 1, line.maxQuantity, MAX_QUANTITY_PER_LINE) } : line);
    });
    const decrement = (lineId: string) => setLines((current) => current.flatMap((line) => line.lineId !== lineId ? [line] : line.quantity > 1 ? [{ ...line, quantity: line.quantity - 1 }] : []));
    const remove = (lineId: string) => setLines((current) => current.filter((line) => line.lineId !== lineId));
    const clearCart = () => setLines([]);
    const quantityFor = (lineId: string) => lines.find((line) => line.lineId === lineId)?.quantity ?? 0;
    return { lines, itemCount: lines.reduce((total, line) => total + line.quantity, 0), isRestoring, quantityFor, addProduct, addSelection, increment, decrement, remove, clearCart };
  }, [isRestoring, lines]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used within CartProvider");
  return context;
}
