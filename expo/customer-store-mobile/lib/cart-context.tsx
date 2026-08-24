import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";

import type { CartLine, Product } from "@/shared/storefront";

type CartContextValue = {
  lines: CartLine[];
  itemCount: number;
  isRestoring: boolean;
  quantityFor: (productId: string) => number;
  addProduct: (product: Product) => void;
  increment: (productId: string) => void;
  decrement: (productId: string) => void;
  remove: (productId: string) => void;
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
    const line = candidate as Partial<CartLine>;
    const rawQuantity = line.quantity;
    if (!line.product || typeof line.product.id !== "string" || !Number.isInteger(rawQuantity) || rawQuantity == null || rawQuantity < 1) continue;
    if (result.length >= MAX_CART_LINES || totalQuantity >= MAX_TOTAL_QUANTITY) break;
    const quantity = Math.min(rawQuantity, MAX_QUANTITY_PER_LINE, MAX_TOTAL_QUANTITY - totalQuantity);
    if (quantity < 1) break;
    result.push({ product: line.product, quantity });
    totalQuantity += quantity;
  }
  return result;
}

/** منطق مشترك قابل للاختبار: أول ضغط ينشئ السطر، وكل ضغط لاحق يزيد الكمية نفسها. */
export function addProductToCart(lines: CartLine[], product: Product): CartLine[] {
  const existing = lines.find((line) => line.product.id === product.id);
  if (existing) {
    return lines.map((line) => line.product.id === product.id ? { ...line, quantity: Math.min(line.quantity + 1, MAX_QUANTITY_PER_LINE) } : line);
  }
  const total = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (lines.length >= MAX_CART_LINES || total >= MAX_TOTAL_QUANTITY) return lines;
  return [...lines, { product, quantity: 1 }];
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
    const increment = (productId: string) => setLines((current) => {
      const total = current.reduce((sum, line) => sum + line.quantity, 0);
      if (total >= MAX_TOTAL_QUANTITY) return current;
      return current.map((line) => line.product.id === productId ? { ...line, quantity: Math.min(line.quantity + 1, MAX_QUANTITY_PER_LINE) } : line);
    });
    const decrement = (productId: string) => setLines((current) => current.flatMap((line) => line.product.id !== productId ? [line] : line.quantity > 1 ? [{ ...line, quantity: line.quantity - 1 }] : []));
    const remove = (productId: string) => setLines((current) => current.filter((line) => line.product.id !== productId));
    const clearCart = () => setLines([]);
    const quantityFor = (productId: string) => lines.find((line) => line.product.id === productId)?.quantity ?? 0;
    return { lines, itemCount: lines.reduce((total, line) => total + line.quantity, 0), isRestoring, quantityFor, addProduct, increment, decrement, remove, clearCart };
  }, [isRestoring, lines]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used within CartProvider");
  return context;
}
