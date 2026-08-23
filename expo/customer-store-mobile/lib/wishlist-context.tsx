import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "@al_arabiya/storefront-wishlist-v1";

type WishlistContextValue = {
  ids: string[];
  hydrated: boolean;
  isSaved: (productId: string | number) => boolean;
  toggle: (productId: string | number) => void;
  remove: (productId: string | number) => void;
};

const WishlistContext = createContext<WishlistContextValue | null>(null);

export function WishlistProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    void AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) setIds([...new Set(parsed)].slice(0, 100));
      })
      .catch(() => undefined)
      .finally(() => setHydrated(true));
  }, []);

  const commit = (next: string[]) => {
    setIds(next);
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
  };
  const value = useMemo<WishlistContextValue>(() => ({
    ids,
    hydrated,
    isSaved: (productId) => ids.includes(String(productId)),
    toggle: (productId) => {
      const id = String(productId);
      commit(ids.includes(id) ? ids.filter((saved) => saved !== id) : [id, ...ids].slice(0, 100));
    },
    remove: (productId) => commit(ids.filter((saved) => saved !== String(productId))),
  }), [hydrated, ids]);

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist() {
  const value = useContext(WishlistContext);
  if (!value) throw new Error("useWishlist must be used within WishlistProvider");
  return value;
}
