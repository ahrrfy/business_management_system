import { useEffect } from "react";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { openCashDrawer, printReceipt } from "@/lib/printing/print";
import { buildBrandedReceipt, type CartItem, type Receipt } from "./posShared";

export interface UsePOSKeyboardShortcutsParams {
  isDigitalCheckoutPending?: () => boolean;
  digitalCheckoutPending?: boolean;
  creditPrompt: string | null;
  setCreditPrompt: (val: string | null) => void;
  receipt: Receipt | null;
  setReceipt: (val: Receipt | null) => void;
  shifting: boolean;
  setShifting: (val: boolean) => void;
  cashDropping: boolean;
  setCashDropping: (val: boolean) => void;
  cardsOpen: boolean;
  setCardsOpen: (val: boolean) => void;
  cart: CartItem[];
  isSalePending: boolean;
  offline: boolean;
  externalPaymentConfirmed: boolean;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onSubmitSale: () => void;
  onClearCart: () => void;
  setShowDrop: (val: boolean) => void;
}

export function usePOSKeyboardShortcuts({
  isDigitalCheckoutPending,
  digitalCheckoutPending,
  creditPrompt,
  setCreditPrompt,
  receipt,
  setReceipt,
  shifting,
  setShifting,
  cashDropping,
  setCashDropping,
  cardsOpen,
  setCardsOpen,
  cart,
  isSalePending,
  offline,
  externalPaymentConfirmed,
  searchRef,
  onSubmitSale,
  onClearCart,
  setShowDrop,
}: UsePOSKeyboardShortcutsParams) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isDigitalCheckoutPending ? isDigitalCheckoutPending() : digitalCheckoutPending) return;
      if (creditPrompt) { if (e.key === "Escape") setCreditPrompt(null); return; }
      if (receipt)      { if (e.key === "Escape" || e.key === "Enter") { setReceipt(null); setTimeout(() => searchRef.current?.focus(), 0); } return; }
      if (shifting)     { if (e.key === "Escape") setShifting(false); return; }
      if (cashDropping) { if (e.key === "Escape") setCashDropping(false); return; }
      if (cardsOpen)    { if (e.key === "Escape") setCardsOpen(false); return; }

      switch (e.key) {
        case "F2":
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case "F3":
          e.preventDefault();
          if (!offline) setCardsOpen(true);
          break;
        case "F4":
          e.preventDefault();
          if (cart.length && !isSalePending) onSubmitSale();
          break;
        case "F9":
          e.preventDefault();
          if (receipt) {
            void printReceipt(buildBrandedReceipt(receipt)).then((printed) => {
              if (!printed.ok) notify.err("تعذّرت الطباعة", "حجب المتصفح نافذة الطباعة البديلة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة");
            }).catch((error) => notify.err(error));
          }
          break;
        case "F10":
          e.preventDefault();
          void openCashDrawer().then((res) => {
            if (res.ok) notify.ok("تم فتح درج النقود");
            else notify.err("تعذّر فتح الدرج", "تأكد من توصيل الطابعة الحرارية وربطها");
          });
          break;
        case "F12":
          e.preventDefault();
          if (cart.length) {
            void (async () => {
              if (!(await confirm({
                variant: "warning",
                title: "تفريغ السلّة",
                description: "ستُفقد كل المنتجات المُضافة في هذه السلّة. هل تتابع؟",
                confirmText: "تفريغ",
              }))) return;
              onClearCart();
            })();
          }
          break;
        case "Escape":
          setShowDrop(false);
          break;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, isSalePending, receipt, creditPrompt, shifting, cashDropping, cardsOpen, offline, externalPaymentConfirmed]);
}
