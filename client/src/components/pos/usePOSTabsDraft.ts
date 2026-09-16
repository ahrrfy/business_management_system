import { useEffect, useState } from "react";
import {
  discardLegacyPosDrafts,
  loadPosTabsDraft,
  posTabsDraftKey,
  savePosTabsDraft,
  type PosDraftScope,
} from "@/lib/cartDraft";
import { newClientRequestId } from "@/lib/countQueue";
import { notify } from "@/lib/notify";
import { markPosTabsStockStale } from "@/lib/posStockRefresh";
import { createTab, type PaymentMethod, type POSTab } from "./posShared";

export interface UsePOSTabsDraftParams {
  shiftId: number | null | undefined;
  userId: number | null | undefined;
  branchId: number;
  tabs: POSTab[];
  setTabs: React.Dispatch<React.SetStateAction<POSTab[]>>;
  activeId: number;
  setActiveId: (id: number) => void;
}

export function usePOSTabsDraft({
  shiftId,
  userId,
  branchId,
  tabs,
  setTabs,
  activeId,
  setActiveId,
}: UsePOSTabsDraftParams) {
  const draftScope: PosDraftScope | null = shiftId && userId
    ? { branchId, userId, shiftId }
    : null;
  const DRAFT_KEY = draftScope ? posTabsDraftKey(draftScope) : null;
  const [restoredDraftKey, setRestoredDraftKey] = useState<string | null>(null);

  useEffect(() => {
    if (!draftScope || !DRAFT_KEY) {
      if (restoredDraftKey !== null) {
        setTabs([createTab(1, "طلب 1")]);
        setActiveId(1);
        setRestoredDraftKey(null);
      }
      return;
    }
    if (restoredDraftKey === DRAFT_KEY) return;

    discardLegacyPosDrafts(localStorage, branchId);
    const saved = loadPosTabsDraft<POSTab>(localStorage, draftScope);
    if (saved) {
      const hadLegacyDigital = saved.tabs.some((t) => t.cart.some((c) => c.digital && (!c.digital.providerReference || !c.digital.providerId)));
      setTabs(markPosTabsStockStale(saved.tabs.map((t) => ({
        ...t,
        cart: t.cart.filter((c) => !c.digital || (!!c.digital.providerReference && !!c.digital.providerId)),
        clientRequestId: t.clientRequestId ?? newClientRequestId(),
        method: "CASH" as PaymentMethod,
        paymentRef: "",
        externalPayment: null,
        dueDate: t.dueDate ?? "",
      }))));
      if (hadLegacyDigital) notify.warn("أُزيلت كروت قديمة غير مكتملة من المسودة", "أعد إضافتها مع رقم العملية قبل البيع.");
      setActiveId(saved.tabs.some((t) => t.id === saved.activeId) ? saved.activeId : saved.tabs[0].id);
    } else {
      setTabs([createTab(1, "طلب 1")]);
      setActiveId(1);
    }
    setRestoredDraftKey(DRAFT_KEY);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DRAFT_KEY]);

  useEffect(() => {
    if (!draftScope || !DRAFT_KEY || restoredDraftKey !== DRAFT_KEY) return;
    savePosTabsDraft(localStorage, draftScope, tabs, activeId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeId, DRAFT_KEY, restoredDraftKey]);

  return { draftScope, DRAFT_KEY, restoredDraftKey };
}
