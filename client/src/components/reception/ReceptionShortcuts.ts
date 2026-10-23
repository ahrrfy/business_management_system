import { useEffect } from "react";
export interface ReceptionShortcutsInput {
  draftTransitionPending: boolean;
  blockingDialogOpen: boolean;
  showCustomization: boolean;
  showReceiptOverlay: boolean;
  cashDropping: boolean;
  approvalOpen: boolean;
  showInbox: boolean;
  depositMenuOpen: boolean;
  discountOpen: boolean;
  showDrop: boolean;
  cardsOpen: boolean;
  offline: boolean;
  depositOpen: boolean;
  canOpenCards: boolean;
  onReprint: () => void;
  onFocusSearch: () => void;
  onSubmit: () => void;
  onClear: () => void;
  onCloseApproval: () => void;
  onCloseDiscount: () => void;
  setShowReceiptOverlay: (open: boolean) => void;
  setCashDropping: (open: boolean) => void;
  setCardsOpen: (open: boolean) => void;
  setDepositOpen: (open: boolean) => void;
  setShowInbox: (open: boolean) => void;
  setDepositMenuOpen: (open: boolean) => void;
  setShowDrop: (open: boolean) => void;
}
export function useReceptionShortcuts(input: ReceptionShortcutsInput) {
  const {
    draftTransitionPending,
    blockingDialogOpen,
    showCustomization,
    showReceiptOverlay,
    cashDropping,
    approvalOpen,
    showInbox,
    depositMenuOpen,
    discountOpen,
    showDrop,
    cardsOpen,
    offline,
    depositOpen,
    canOpenCards,
    onReprint,
    onFocusSearch,
    onSubmit,
    onClear,
    onCloseApproval,
    onCloseDiscount,
    setShowReceiptOverlay,
    setCashDropping,
    setCardsOpen,
    setDepositOpen,
    setShowInbox,
    setDepositMenuOpen,
    setShowDrop,
  } = input;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (draftTransitionPending) {
        e.preventDefault();
        return;
      }
      if (blockingDialogOpen && e.key !== "Escape") return;
      if (showCustomization) return;
      if (showReceiptOverlay) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowReceiptOverlay(false);
        }
        if (e.key === "F9") {
          e.preventDefault();
          onReprint();
        }
        return;
      }
      if (cashDropping || approvalOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setCashDropping(false);
          onCloseApproval();
        }
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        onFocusSearch();
      } else if (e.key === "F3") {
        e.preventDefault();
        if (!offline && canOpenCards) setCardsOpen(true);
      } else if (e.key === "F4") {
        e.preventDefault();
        onSubmit();
      } else if (e.key === "F9") {
        e.preventDefault();
        onReprint();
      } else if (e.key === "F12") {
        e.preventDefault();
        onClear();
      } else if (e.key === "Escape") {
        if (depositOpen) setDepositOpen(false);
        else if (showInbox) setShowInbox(false);
        else if (depositMenuOpen) setDepositMenuOpen(false);
        else if (discountOpen) onCloseDiscount();
        else if (showDrop) setShowDrop(false);
        else if (cardsOpen) setCardsOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input]);
}
