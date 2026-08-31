export type RecentStorefrontOrder = {
  orderNumber: string;
  phone: string;
  total: string;
  placedAt: string;
  reservationExpiresAt: string;
  guestTrackingToken?: string | null;
  guestTrackingExpiresAt?: string | null;
};

type StorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

const RECENT_ORDERS_KEY = "al_arabiya_recent_orders_v1";
const MAX_RECENT_ORDERS = 5;
let volatileRecentOrders: RecentStorefrontOrder[] = [];
const secureRecentOrdersStorage: StorageLike = {
  getItem: async (key) =>
    (await import("expo-secure-store")).getItemAsync(key),
  setItem: async (key, value) =>
    (await import("expo-secure-store")).setItemAsync(key, value),
};

function isRecentOrder(value: unknown): value is RecentStorefrontOrder {
  if (!value || typeof value !== "object") return false;
  const order = value as Partial<RecentStorefrontOrder>;
  return (
    typeof order.orderNumber === "string" &&
    /^ORD-[A-Z0-9-]{3,40}$/i.test(order.orderNumber) &&
    typeof order.phone === "string" &&
    /^\+964\d{9,10}$/.test(order.phone) &&
    typeof order.total === "string" &&
    /^\d+(?:\.\d{1,2})?$/.test(order.total) &&
    typeof order.placedAt === "string" &&
    Number.isFinite(Date.parse(order.placedAt)) &&
    typeof order.reservationExpiresAt === "string" &&
    Number.isFinite(Date.parse(order.reservationExpiresAt)) &&
    (order.guestTrackingToken == null || /^[A-Za-z0-9._-]{40,300}$/.test(order.guestTrackingToken)) &&
    (order.guestTrackingExpiresAt == null || Number.isFinite(Date.parse(order.guestTrackingExpiresAt)))
  );
}

export function sanitizeRecentOrders(value: unknown): RecentStorefrontOrder[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, RecentStorefrontOrder>();
  for (const candidate of value) {
    if (!isRecentOrder(candidate)) continue;
    const key = candidate.orderNumber.toUpperCase();
    if (!unique.has(key)) unique.set(key, { ...candidate, orderNumber: key });
    if (unique.size >= MAX_RECENT_ORDERS) break;
  }
  return [...unique.values()];
}

export function mergeRecentOrder(
  current: readonly RecentStorefrontOrder[],
  order: RecentStorefrontOrder,
): RecentStorefrontOrder[] {
  return sanitizeRecentOrders([
    order,
    ...current.filter(
      (candidate) =>
        candidate.orderNumber.toUpperCase() !== order.orderNumber.toUpperCase(),
    ),
  ]);
}

/** لا تعتبر معاملات الرابط إيصالاً؛ تختار فقط مرجعاً سبق حفظه محلياً بثقة. */
export function findTrustedRecentOrder(
  orders: readonly RecentStorefrontOrder[],
  requestedOrderNumber?: string,
): RecentStorefrontOrder | null {
  const trusted = sanitizeRecentOrders(orders);
  const requested = requestedOrderNumber?.trim().toUpperCase();
  if (!requested) return trusted[0] ?? null;
  return trusted.find((order) => order.orderNumber === requested) ?? null;
}

export async function loadRecentOrders(
  storage: StorageLike = secureRecentOrdersStorage,
): Promise<RecentStorefrontOrder[]> {
  try {
    const raw = await storage.getItem(RECENT_ORDERS_KEY);
    const persisted = raw ? sanitizeRecentOrders(JSON.parse(raw)) : [];
    return sanitizeRecentOrders([...volatileRecentOrders, ...persisted]);
  } catch {
    return [...volatileRecentOrders];
  }
}

export async function saveRecentOrder(
  order: RecentStorefrontOrder,
  storage: StorageLike = secureRecentOrdersStorage,
): Promise<RecentStorefrontOrder[]> {
  // الذاكرة المؤقتة تحفظ نتيجة الخادم لهذه الجلسة حتى لو تعذّر SecureStore؛
  // وبذلك لا نحتاج إلى تمرير الهاتف أو المبلغ في رابط التنقل.
  volatileRecentOrders = mergeRecentOrder(volatileRecentOrders, order);
  const next = mergeRecentOrder(await loadRecentOrders(storage), order);
  volatileRecentOrders = next;
  await storage.setItem(RECENT_ORDERS_KEY, JSON.stringify(next));
  return next;
}
