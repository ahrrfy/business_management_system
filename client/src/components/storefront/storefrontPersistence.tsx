import { serializeStorefrontCustomizationIdentity } from "@/pages/store/storefrontCustomization";
import { type CartLine } from "./storefrontCartMath";
import { customizationCartKey } from "./storefrontCustomizationModel";

export type CheckoutForm = {
  name: string;
  phone: string;
  governorate: string;
  address: string;
  notes: string;
  latitude?: number | null;
  longitude?: number | null;
};

export type CheckoutFieldErrors = Partial<
  Record<"name" | "phone" | "governorate" | "address", string>
>;

export function validateStorefrontCheckout(
  form: CheckoutForm,
): CheckoutFieldErrors {
  const errors: CheckoutFieldErrors = {};
  if (!form.name.trim()) errors.name = "اكتب الاسم الكامل لاستلام الطلب.";
  if (form.phone.replace(/\D/g, "").length < 8)
    errors.phone = "اكتب رقم هاتف صالحاً للتواصل معك.";
  if (!form.governorate.trim()) errors.governorate = "اختر المحافظة.";
  if (form.address.trim().length < 3)
    errors.address = "اكتب عنواناً واضحاً من 3 أحرف على الأقل.";
  return errors;
}

export const DEFAULT_FORM: CheckoutForm = {
  name: "",
  phone: "+964 ",
  governorate: "baghdad",
  address: "",
  notes: "",
  latitude: null,
  longitude: null,
};

export const CART_STORAGE_KEY = "alroya-store-cart-v1";

export const CHECKOUT_STORAGE_KEY = "alroya-store-checkout-v1";

export const CHECKOUT_ATTEMPT_STORAGE_KEY = "alroya-store-checkout-attempt-v1";

export const STOREFRONT_PERSIST_REQUEST_EVENT =
  "alroya:storefront-persist-request";

export const STOREFRONT_WISHLIST_KEY = "alroya-store-wishlist-v1";

export function loadStorefrontWishlist(): Set<number> {
  try {
    const raw = localStorage.getItem(STOREFRONT_WISHLIST_KEY);
    const values = JSON.parse(raw ?? "[]") as unknown;
    return new Set(
      Array.isArray(values)
        ? values
            .filter((id): id is number => Number.isInteger(id) && id > 0)
            .slice(0, 200)
        : [],
    );
  } catch {
    return new Set();
  }
}

export function saveStorefrontWishlist(ids: Set<number>): void {
  try {
    localStorage.setItem(
      STOREFRONT_WISHLIST_KEY,
      JSON.stringify(Array.from(ids).slice(0, 200)),
    );
  } catch {
    /* التخزين المحلي اختياري؛ التصفح والشراء لا يتوقفان عند حجبه. */
  }
}

export function storefrontShareUrl(params: Record<string, string>): string {
  if (typeof window === "undefined") return "https://alarabiya.online/store";
  if (params.product)
    return `${window.location.origin}/store/product/${params.product}`;
  const url = new URL("/store", window.location.origin);
  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value),
  );
  return url.toString();
}

export type StorefrontCheckoutAttempt = {
  clientRequestId: string;
  fingerprint: string;
  expectedGrandTotal: string;
  createdAt: number;
};

export function loadCart(
  storage: Pick<Storage, "getItem"> = localStorage,
): Map<string, CartLine> {
  const m = new Map<string, CartLine>();
  try {
    const raw = storage.getItem(CART_STORAGE_KEY);
    if (!raw) return m;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return m;
    for (const rawLine of arr as Partial<CartLine>[]) {
      if (
        rawLine &&
        typeof rawLine.productUnitId === "number" &&
        typeof rawLine.qty === "number" &&
        rawLine.qty > 0
      ) {
        const stockLimit =
          typeof rawLine.stockLimit === "number" &&
          Number.isFinite(rawLine.stockLimit)
            ? Math.max(1, Math.min(Math.floor(rawLine.stockLimit), 999))
            : null;
        const rawCustomization = rawLine.customization;
        const sanitizedCustomization =
          rawCustomization && typeof rawCustomization === "object"
            ? {
                ...rawCustomization,
                logoAssetKey:
                  typeof rawCustomization.logoAssetKey === "string" &&
                  rawCustomization.logoAssetKey.trim()
                    ? rawCustomization.logoAssetKey.trim()
                    : undefined,
                previewAssetKey:
                  typeof rawCustomization.previewAssetKey === "string" &&
                  rawCustomization.previewAssetKey.trim()
                    ? rawCustomization.previewAssetKey.trim()
                    : undefined,
              }
            : undefined;
        const cartKey = customizationCartKey(
          rawLine.productUnitId,
          sanitizedCustomization,
        );
        const previous = m.get(cartKey);
        const effectiveLimit =
          previous?.stockLimit == null
            ? stockLimit
            : stockLimit == null
              ? previous.stockLimit
              : Math.min(previous.stockLimit, stockLimit);
        const line = {
          ...rawLine,
          customization: sanitizedCustomization,
          stockLimit: effectiveLimit,
          qty: Math.min(
            (previous?.qty ?? 0) + Math.max(1, Math.floor(rawLine.qty)),
            effectiveLimit ?? 999,
          ),
          cartKey,
        } as CartLine;
        m.set(line.cartKey, line);
      }
    }
  } catch {
    /* تالف/محظور (وضع خاص) — سلّة فارغة */
  }
  return m;
}

export type StorefrontStorage = Pick<Storage, "setItem" | "removeItem">;

export type StorefrontReadStorage = Pick<Storage, "getItem" | "removeItem">;

export function saveCart(
  cart: Map<string, CartLine>,
  storage: StorefrontStorage = localStorage,
): boolean {
  try {
    const arr = Array.from(cart.values());
    if (arr.length === 0) storage.removeItem(CART_STORAGE_KEY);
    else storage.setItem(CART_STORAGE_KEY, JSON.stringify(arr));
    return true;
  } catch {
    return false;
  }
}

export function loadForm(): CheckoutForm {
  try {
    const raw = localStorage.getItem(CHECKOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FORM };
    const f = JSON.parse(raw) as Partial<CheckoutForm>;
    return {
      name: typeof f.name === "string" ? f.name : DEFAULT_FORM.name,
      phone:
        typeof f.phone === "string" && f.phone ? f.phone : DEFAULT_FORM.phone,
      governorate:
        typeof f.governorate === "string"
          ? f.governorate
          : DEFAULT_FORM.governorate,
      address: typeof f.address === "string" ? f.address : DEFAULT_FORM.address,
      notes: typeof f.notes === "string" ? f.notes : DEFAULT_FORM.notes,
      latitude:
        typeof f.latitude === "number" && !isNaN(f.latitude)
          ? f.latitude
          : null,
      longitude:
        typeof f.longitude === "number" && !isNaN(f.longitude)
          ? f.longitude
          : null,
    };
  } catch {
    return { ...DEFAULT_FORM };
  }
}

export function saveForm(
  form: CheckoutForm,
  storage: StorefrontStorage = localStorage,
): boolean {
  try {
    storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(form));
    return true;
  } catch {
    return false;
  }
}

export function loadCheckoutAttempt(
  storage: StorefrontReadStorage = localStorage,
): StorefrontCheckoutAttempt | null {
  try {
    const raw = storage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StorefrontCheckoutAttempt>;
    if (
      typeof value.clientRequestId !== "string" ||
      !value.clientRequestId ||
      typeof value.fingerprint !== "string" ||
      !value.fingerprint ||
      typeof value.expectedGrandTotal !== "string" ||
      typeof value.createdAt !== "number"
    ) {
      storage.removeItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
      return null;
    }
    return value as StorefrontCheckoutAttempt;
  } catch {
    return null;
  }
}

export function saveCheckoutAttempt(
  attempt: StorefrontCheckoutAttempt | null,
  storage: StorefrontStorage = localStorage,
): boolean {
  try {
    if (attempt)
      storage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
    else storage.removeItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function storefrontCheckoutFingerprint(
  cart: Map<string, CartLine>,
  form: CheckoutForm,
  couponCode: string | null = null,
): string {
  const lines = Array.from(cart.values())
    .sort((a, b) => a.cartKey.localeCompare(b.cartKey))
    .map((line) => [
      line.cartKey,
      line.productUnitId,
      line.qty,
      Number(line.price).toFixed(2),
      serializeStorefrontCustomizationIdentity(line.customization),
    ]);
  return JSON.stringify({
    lines,
    name: form.name.trim(),
    phone: form.phone.replace(/\s+/g, " ").trim(),
    governorate: form.governorate,
    address: form.address.trim(),
    notes: form.notes.trim(),
    couponCode: couponCode?.trim().toUpperCase() || null,
  });
}

export function saveStorefrontSnapshot(
  cart: Map<string, CartLine>,
  form: CheckoutForm,
  storage: StorefrontStorage = localStorage,
  attempt: StorefrontCheckoutAttempt | null = null,
): boolean {
  // لا تستخدم short-circuit: يجب محاولة حفظ الجزأين كي يحصل الزبون على أفضل فرصة للاسترداد.
  const cartSaved = saveCart(cart, storage);
  const formSaved = saveForm(form, storage);
  const attemptSaved = saveCheckoutAttempt(attempt, storage);
  return cartSaved && formSaved && attemptSaved;
}
