import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import {
  type CartItem,
  type NumMode,
  type PaymentMethod,
  type POSTab,
  type Tier,
  createTab,
} from "./posShared";

export interface UsePOSTabHelpersParams {
  tabs: POSTab[];
  setTabs: Dispatch<SetStateAction<POSTab[]>>;
  activeId: number;
  setActiveId: (id: number) => void;
  activeIdRef: MutableRefObject<number>;
  qtyEntryRef: MutableRefObject<{ tabId: number; lineId: number | null; replaceNextDigit: boolean }>;
  digitalCheckoutRef: MutableRefObject<{ tabId: number } | null>;
  activeTab: POSTab;
  setSearch: (s: string) => void;
  setShowDrop: (b: boolean) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

export function resetCouponItems(items: CartItem[]) {
  return items.map((item) =>
    item.preCouponRow
      ? { ...item, row: item.preCouponRow, preCouponRow: undefined, disc: undefined }
      : item,
  );
}

export function usePOSTabHelpers({
  tabs,
  setTabs,
  activeId,
  setActiveId,
  activeIdRef,
  qtyEntryRef,
  digitalCheckoutRef,
  activeTab,
  setSearch,
  setShowDrop,
  searchRef,
}: UsePOSTabHelpersParams) {
  function patchTab(id: number, patch: Partial<POSTab>) {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function patchActive(patch: Partial<POSTab>) {
    patchTab(activeIdRef.current, patch);
  }

  function setCart(updater: CartItem[] | ((c: CartItem[]) => CartItem[])) {
    const id = activeIdRef.current;
    if (digitalCheckoutRef.current?.tabId === id) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id !== id
          ? t
          : { ...t, cart: typeof updater === "function" ? updater(t.cart) : updater },
      ),
    );
  }

  function setPayInput(updater: string | ((s: string) => string)) {
    const id = activeIdRef.current;
    setTabs((prev) =>
      prev.map((t) =>
        t.id !== id
          ? t
          : { ...t, payInput: typeof updater === "function" ? updater(t.payInput) : updater },
      ),
    );
  }

  const setSelId = (v: number | null) => {
    qtyEntryRef.current = { tabId: activeIdRef.current, lineId: v, replaceNextDigit: true };
    patchActive({ selId: v });
  };

  const setNumMode = (v: NumMode) => {
    if (v === "QTY") {
      qtyEntryRef.current = {
        tabId: activeIdRef.current,
        lineId: activeTab.selId,
        replaceNextDigit: true,
      };
    }
    patchActive({ numMode: v });
  };

  const setMethod = (v: PaymentMethod) => patchActive({ method: v, externalPayment: null });

  const clearAppliedCoupon = () => {
    setCart((items) => resetCouponItems(items));
    patchActive({ couponCode: null, couponLabel: null });
  };

  const setCustId = (v: number | null) => {
    clearAppliedCoupon();
    patchActive({ customerId: v, tierOverride: null });
  };

  const setTierOvr = (v: Tier | null) => patchActive({ tierOverride: v });

  function addTab() {
    const id = (tabs.length ? Math.max(...tabs.map((t) => t.id)) : 0) + 1;
    setTabs((prev) => [...prev, createTab(id)]);
    setActiveId(id);
    setSearch("");
    setShowDrop(false);
    setTimeout(() => searchRef.current?.focus(), 80);
  }

  function closeTab(id: number) {
    if (tabs.length <= 1) return;
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1].id);
      return next;
    });
  }

  return {
    patchTab,
    patchActive,
    setCart,
    setPayInput,
    setSelId,
    setNumMode,
    setMethod,
    resetCouponItems,
    clearAppliedCoupon,
    setCustId,
    setTierOvr,
    addTab,
    closeTab,
  };
}
