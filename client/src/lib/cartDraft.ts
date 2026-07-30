// مسوّدات تبويبات نقطة البيع تصمد عبر التحديث/انقطاع الشبكة، لكن لا يجوز أن تعبر
// حدود المستخدم أو الوردية. الفرع وحده ليس نطاقاً أمنياً لأن عدة كاشيرين يتعاقبون
// على الجهاز نفسه.

export type PosDraftScope = {
  branchId: number;
  userId: number;
  shiftId: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type PosTabsDraft<TTab> = {
  version: 2;
  scope: PosDraftScope;
  tabs: TTab[];
  activeId: number;
  savedAt: number;
};

export function posTabsDraftKey(scope: PosDraftScope): string {
  return `alroya.posTabs.v2.b${scope.branchId}.u${scope.userId}.s${scope.shiftId}`;
}

function sameScope(a: PosDraftScope, b: PosDraftScope): boolean {
  return a.branchId === b.branchId && a.userId === b.userId && a.shiftId === b.shiftId;
}

/**
 * يحذف الصيغ القديمة التي كانت معزولة بالفرع فقط. لا نهاجر محتواها عمداً لأننا لا
 * نستطيع إثبات صاحبها أو ورديتها، واسترجاعها هو أصل تسريب الفاتورة المبلّغ عنه.
 */
export function discardLegacyPosDrafts(storage: StorageLike, branchId: number): void {
  try {
    storage.removeItem(`alroya.posTabs.b${branchId}`);
    storage.removeItem(`alroya.cartDraft.b${branchId}`);
  } catch {
    /* التخزين محجوب/ممتلئ: لا يؤثر في تشغيل نقطة البيع */
  }
}

export function loadPosTabsDraft<TTab>(
  storage: StorageLike,
  scope: PosDraftScope,
): { tabs: TTab[]; activeId: number } | null {
  try {
    const raw = storage.getItem(posTabsDraftKey(scope));
    if (!raw) return null;
    const draft = JSON.parse(raw) as PosTabsDraft<TTab>;
    if (
      draft.version !== 2 ||
      !draft.scope ||
      !sameScope(draft.scope, scope) ||
      !Array.isArray(draft.tabs) ||
      draft.tabs.length === 0 ||
      !Number.isInteger(draft.activeId)
    ) {
      return null;
    }
    return { tabs: draft.tabs, activeId: draft.activeId };
  } catch {
    return null;
  }
}

export function savePosTabsDraft<TTab extends { cart: unknown[] }>(
  storage: StorageLike,
  scope: PosDraftScope,
  tabs: TTab[],
  activeId: number,
): void {
  try {
    const storageKey = posTabsDraftKey(scope);
    if (!tabs.some((tab) => Array.isArray(tab.cart) && tab.cart.length > 0)) {
      storage.removeItem(storageKey);
      return;
    }
    const draft: PosTabsDraft<TTab> = {
      version: 2,
      scope,
      tabs,
      activeId,
      savedAt: Date.now(),
    };
    storage.setItem(storageKey, JSON.stringify(draft));
  } catch {
    /* التخزين محجوب/ممتلئ: لا يؤثر في تشغيل نقطة البيع */
  }
}
