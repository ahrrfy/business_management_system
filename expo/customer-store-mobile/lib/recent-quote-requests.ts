export type RecentStorefrontQuoteRequest = {
  requestNumber: string;
  placedAt: string;
  guestTrackingToken?: string | null;
  guestTrackingExpiresAt?: string | null;
};

type StorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

const RECENT_QUOTE_REQUESTS_KEY = "al_arabiya_recent_quote_requests_v1";
const MAX_RECENT_QUOTE_REQUESTS = 5;
let volatileRecentQuoteRequests: RecentStorefrontQuoteRequest[] = [];
const secureRecentQuoteRequestsStorage: StorageLike = {
  getItem: async (key) =>
    (await import("expo-secure-store")).getItemAsync(key),
  setItem: async (key, value) =>
    (await import("expo-secure-store")).setItemAsync(key, value),
};

function isRecentQuoteRequest(value: unknown): value is RecentStorefrontQuoteRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<RecentStorefrontQuoteRequest>;
  return (
    typeof request.requestNumber === "string" &&
    /^SRQ-\d+$/i.test(request.requestNumber) &&
    typeof request.placedAt === "string" &&
    Number.isFinite(Date.parse(request.placedAt)) &&
    (request.guestTrackingToken == null || /^[A-Za-z0-9._-]{40,300}$/.test(request.guestTrackingToken)) &&
    (request.guestTrackingExpiresAt == null || Number.isFinite(Date.parse(request.guestTrackingExpiresAt)))
  );
}

export function sanitizeRecentQuoteRequests(value: unknown): RecentStorefrontQuoteRequest[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, RecentStorefrontQuoteRequest>();
  for (const candidate of value) {
    if (!isRecentQuoteRequest(candidate)) continue;
    const requestNumber = candidate.requestNumber.toUpperCase();
    if (!unique.has(requestNumber)) {
      unique.set(requestNumber, { ...candidate, requestNumber });
    }
    if (unique.size >= MAX_RECENT_QUOTE_REQUESTS) break;
  }
  return [...unique.values()];
}

export function mergeRecentQuoteRequest(
  current: readonly RecentStorefrontQuoteRequest[],
  request: RecentStorefrontQuoteRequest,
): RecentStorefrontQuoteRequest[] {
  return sanitizeRecentQuoteRequests([
    request,
    ...current.filter(
      (candidate) =>
        candidate.requestNumber.toUpperCase() !== request.requestNumber.toUpperCase(),
    ),
  ]);
}

export async function loadRecentQuoteRequests(
  storage: StorageLike = secureRecentQuoteRequestsStorage,
): Promise<RecentStorefrontQuoteRequest[]> {
  try {
    const raw = await storage.getItem(RECENT_QUOTE_REQUESTS_KEY);
    const persisted = raw ? sanitizeRecentQuoteRequests(JSON.parse(raw)) : [];
    return sanitizeRecentQuoteRequests([
      ...volatileRecentQuoteRequests,
      ...persisted,
    ]);
  } catch {
    return [...volatileRecentQuoteRequests];
  }
}

export async function saveRecentQuoteRequest(
  request: RecentStorefrontQuoteRequest,
  storage: StorageLike = secureRecentQuoteRequestsStorage,
): Promise<RecentStorefrontQuoteRequest[]> {
  volatileRecentQuoteRequests = mergeRecentQuoteRequest(
    volatileRecentQuoteRequests,
    request,
  );
  const next = mergeRecentQuoteRequest(await loadRecentQuoteRequests(storage), request);
  volatileRecentQuoteRequests = next;
  await storage.setItem(RECENT_QUOTE_REQUESTS_KEY, JSON.stringify(next));
  return next;
}
