import { newClientRequestId } from "@/lib/countQueue";
import { D, round2 } from "@/lib/money";
import { applyPosQuantityKey } from "@/lib/posQuantityEntry";
import { toNormalizedNumber } from "@shared/numberNormalize";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import {
  type CartItem,
  type NumMode,
  type PaymentMethod,
  type PosPaymentLegDraft,
  type POSTab,
  type Tier,
  createTab,
  lineIdOf,
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

  const setMethod = (v: PaymentMethod) => patchActive({ method: v, externalPayment: null, paymentLegs: [] });

  const enableSplitPayment = (totalAmount: number) => {
    const normEntered = toNormalizedNumber(activeTab.payInput).trim();
    const currentEntered = Number(normEntered);
    const hasPartialEntered =
      normEntered !== "" && Number.isFinite(currentEntered) && currentEntered > 0 && currentEntered < totalAmount;
    const firstAmt = hasPartialEntered
      ? String(currentEntered)
      : totalAmount > 0
        ? String(Math.floor(totalAmount / 2))
        : "";
    const secondAmtNum = Math.max(0, round2(D(totalAmount).minus(D(firstAmt || 0))).toNumber());
    const firstMethod: PaymentMethod = activeTab.method;
    const secondMethod: PaymentMethod = firstMethod === "CASH" ? "CARD" : "CASH";
    const legs: PosPaymentLegDraft[] = [
      {
        id: newClientRequestId(),
        method: firstMethod,
        amount: firstAmt,
        paymentRef: activeTab.paymentRef ?? "",
        externalPayment: hasPartialEntered ? (activeTab.externalPayment ?? null) : null,
      },
      {
        id: newClientRequestId(),
        method: secondMethod,
        amount: secondAmtNum > 0 ? String(secondAmtNum) : "",
        paymentRef: "",
        externalPayment: null,
      },
    ];
    patchActive({ paymentLegs: legs });
  };

  const disableSplitPayment = () => {
    const first = activeTab.paymentLegs?.[0];
    patchActive({
      paymentLegs: [],
      ...(first
        ? {
            method: first.method,
            payInput: first.amount,
            paymentRef: first.paymentRef,
            externalPayment: first.externalPayment,
          }
        : {}),
    });
  };

  const addPaymentLeg = (remainingAmount: number) => {
    const existing = activeTab.paymentLegs ?? [];
    if (existing.length >= 4) return;
    const usedMethods = new Set(existing.map((l) => l.method));
    const nextMethod: PaymentMethod = !usedMethods.has("CASH")
      ? "CASH"
      : !usedMethods.has("CARD")
        ? "CARD"
        : !usedMethods.has("TRANSFER")
          ? "TRANSFER"
          : "WALLET";
    patchActive({
      paymentLegs: [
        ...existing,
        {
          id: newClientRequestId(),
          method: nextMethod,
          amount: remainingAmount > 0 ? String(round2(D(remainingAmount)).toNumber()) : "",
          paymentRef: "",
          externalPayment: null,
        },
      ],
    });
  };

  const updatePaymentLeg = (legId: string, patch: Partial<PosPaymentLegDraft>, totalAmount?: number) => {
    const existing = activeTab.paymentLegs ?? [];
    const idx = existing.findIndex((l) => l.id === legId);
    if (idx < 0) return;
    const next = existing.map((leg) => {
      if (leg.id !== legId) return leg;
      const invalidateExt =
        patch.externalPayment === undefined &&
        ((patch.method !== undefined && patch.method !== leg.method) ||
          (patch.amount !== undefined && patch.amount !== leg.amount) ||
          (patch.paymentRef !== undefined && patch.paymentRef !== leg.paymentRef));
      return {
        ...leg,
        ...patch,
        ...(invalidateExt ? { externalPayment: null } : {}),
      };
    });
    // في وضع الدفعتين: عند تعديل مبلغ الدفعة الأولى، نملأ المتبقي تلقائياً في الدفعة الثانية ما لم تكن مؤكدة خارجياً
    if (
      next.length === 2 &&
      idx === 0 &&
      patch.amount !== undefined &&
      totalAmount != null &&
      totalAmount > 0 &&
      next[1].externalPayment?.state !== "CONFIRMED"
    ) {
      const normAmt0 = toNormalizedNumber(patch.amount).trim();
      const amt0 = normAmt0 === "" ? NaN : Number(normAmt0);
      if (Number.isFinite(amt0) && amt0 >= 0 && amt0 <= totalAmount) {
        const rem = round2(D(totalAmount).minus(D(amt0))).toNumber();
        next[1] = {
          ...next[1],
          amount: rem > 0 ? String(rem) : "",
          externalPayment: null,
        };
      }
    }
    patchActive({ paymentLegs: next });
  };

  const removePaymentLeg = (legId: string) => {
    const remaining = (activeTab.paymentLegs ?? []).filter((l) => l.id !== legId);
    if (remaining.length <= 1) {
      const sole = remaining[0];
      patchActive({
        paymentLegs: [],
        ...(sole
          ? {
              method: sole.method,
              payInput: sole.amount,
              paymentRef: sole.paymentRef,
              externalPayment: sole.externalPayment,
            }
          : {}),
      });
      return;
    }
    patchActive({ paymentLegs: remaining });
  };

  const patchLegExternalPayment = (
    tabId: number,
    legId: string,
    externalPayment: PosPaymentLegDraft["externalPayment"],
  ) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.id === tabId
          ? {
              ...t,
              paymentLegs: (t.paymentLegs ?? []).map((l) =>
                l.id === legId ? { ...l, externalPayment } : l,
              ),
            }
          : t,
      ),
    );
  };

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

  function numPress(k: string) {
    const { numMode, selId } = activeTab;
    if (numMode === "QTY") {
      if (!selId) return;
      setCart((prev) =>
        prev.map((c) => {
          if (lineIdOf(c) !== selId || c.digital) return c;
          const entry = qtyEntryRef.current;
          const replaceNextDigit = entry.tabId !== activeIdRef.current || entry.lineId !== selId
            ? true
            : entry.replaceNextDigit;
          const result = applyPosQuantityKey(c.qty, k, replaceNextDigit);
          qtyEntryRef.current = {
            tabId: activeIdRef.current,
            lineId: selId,
            replaceNextDigit: result.replaceNextDigit,
          };
          return { ...c, qty: result.quantity };
        }),
      );
    } else if (numMode === "DISC") {
      if (!selId) return;
      setCart((prev) =>
        prev.map((c) => {
          if (lineIdOf(c) !== selId || c.digital) return c;
          const base = c.origPrice ?? Number(c.row.price ?? 0);
          let s = c.disc != null ? String(c.disc) : "";
          if (k === "⌫") s = s.slice(0, -1);
          else if (k === "C") s = "";
          else if (k === "." && s.includes(".")) return c;
          else s = s + k;
          const disc = Math.min(100, Math.max(0, parseFloat(s) || 0));
          return { ...c, origPrice: base, disc };
        }),
      );
    } else {
      setPayInput((prev) => {
        if (k === "⌫") return prev.slice(0, -1);
        if (k === "C") return "";
        if (k === "." && prev.includes(".")) return prev;
        if (k === "+/-") return prev ? (prev.startsWith("-") ? prev.slice(1) : "-" + prev) : prev;
        if (prev === "" && k === "00") return "0";
        return prev + k;
      });
    }
  }

  return {
    patchTab,
    patchActive,
    setCart,
    setPayInput,
    setSelId,
    setNumMode,
    setMethod,
    enableSplitPayment,
    disableSplitPayment,
    addPaymentLeg,
    updatePaymentLeg,
    removePaymentLeg,
    patchLegExternalPayment,
    resetCouponItems,
    clearAppliedCoupon,
    setCustId,
    setTierOvr,
    addTab,
    closeTab,
    numPress,
  };
}
