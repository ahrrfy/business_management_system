// مسوّدة سلّة الكاشير — تصمد عبر تحديث الصفحة/انقطاع الشبكة (§٢ لا فقد سلّة).
// تُحفظ في localStorage لكل فرع، وتُسترجَع عند فتح POS، وتُمسح بعد بيع ناجح.
// السلّة لا تُمسح عند فشل البيع ⇒ يعيد الكاشير المحاولة عند عودة الشبكة بلا فقد.

type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";

export type CartDraft<TItem = unknown> = {
  cart: TItem[];
  customerId: number | null;
  tierOverride: Tier | null;
  savedAt: number;
};

const key = (branchId: number) => `alroya.cartDraft.b${branchId}`;

export function saveCartDraft<TItem>(branchId: number, data: Omit<CartDraft<TItem>, "savedAt">): void {
  try {
    if (!data.cart || data.cart.length === 0) {
      localStorage.removeItem(key(branchId));
      return;
    }
    localStorage.setItem(key(branchId), JSON.stringify({ ...data, savedAt: Date.now() }));
  } catch {
    /* تجاهل (وضع خاص/ممتلئ) */
  }
}

export function loadCartDraft<TItem>(branchId: number): CartDraft<TItem> | null {
  try {
    const raw = localStorage.getItem(key(branchId));
    if (!raw) return null;
    const d = JSON.parse(raw) as CartDraft<TItem>;
    return Array.isArray(d.cart) && d.cart.length ? d : null;
  } catch {
    return null;
  }
}

export function clearCartDraft(branchId: number): void {
  try {
    localStorage.removeItem(key(branchId));
  } catch {
    /* تجاهل */
  }
}
