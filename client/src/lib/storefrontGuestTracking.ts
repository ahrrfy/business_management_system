const GUEST_TRACKING_STORAGE_KEY = "alroya-store-guest-tracking-v1";

export type GuestTrackingOrder = {
  orderNumber: string;
  trackingToken: string;
  expiresAt: string;
  savedAt: number;
};

export type GuestTrackingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function validGuestTrackingOrder(value: unknown, now: number): value is GuestTrackingOrder {
  if (!value || typeof value !== "object") return false;
  const order = value as Partial<GuestTrackingOrder>;
  const expiry = typeof order.expiresAt === "string" ? Date.parse(order.expiresAt) : Number.NaN;
  return typeof order.orderNumber === "string" && order.orderNumber.trim().length > 0 && order.orderNumber.length <= 50 &&
    typeof order.trackingToken === "string" && order.trackingToken.trim().length >= 60 && order.trackingToken.length <= 160 &&
    Number.isFinite(expiry) && expiry > now && typeof order.savedAt === "number" && Number.isFinite(order.savedAt);
}

/** لا تُحفظ أيّ هوية عميل: فقط ملكية الطلب قصيرة العمر الصادرة من الخادم. */
export function loadGuestTrackingOrders(
  storage: GuestTrackingStorage = localStorage,
  now = Date.now(),
): GuestTrackingOrder[] {
  try {
    const parsed = JSON.parse(storage.getItem(GUEST_TRACKING_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((order): order is GuestTrackingOrder => validGuestTrackingOrder(order, now))
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, 5)
      .map(({ orderNumber, trackingToken, expiresAt, savedAt }) => ({ orderNumber, trackingToken, expiresAt, savedAt }));
  } catch {
    return [];
  }
}

export function rememberGuestTrackingOrder(
  input: Pick<GuestTrackingOrder, "orderNumber" | "trackingToken" | "expiresAt">,
  storage: GuestTrackingStorage = localStorage,
  now = Date.now(),
): GuestTrackingOrder[] {
  const candidate: GuestTrackingOrder = {
    orderNumber: input.orderNumber.trim(),
    trackingToken: input.trackingToken.trim(),
    expiresAt: input.expiresAt,
    savedAt: now,
  };
  if (!validGuestTrackingOrder(candidate, now)) return loadGuestTrackingOrders(storage, now);
  const next = [candidate, ...loadGuestTrackingOrders(storage, now)
    .filter((order) => order.orderNumber !== candidate.orderNumber && order.trackingToken !== candidate.trackingToken)]
    .slice(0, 5);
  try {
    storage.setItem(GUEST_TRACKING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* التتبّع يظل متاحاً بلصق الرمز حتى لو حُظر التخزين المحلي. */
  }
  return next;
}
