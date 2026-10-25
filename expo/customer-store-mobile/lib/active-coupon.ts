export const ACTIVE_COUPON_STORAGE_KEY = "alarabiya-active-coupon";

export type ActiveCouponStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export function normalizeActiveCouponCode(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toUpperCase().replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

export async function loadActiveCouponCode(
  storage: ActiveCouponStorage,
): Promise<string | null> {
  try {
    const stored = await storage.getItem(ACTIVE_COUPON_STORAGE_KEY);
    return normalizeActiveCouponCode(stored);
  } catch {
    return null;
  }
}

export async function saveActiveCouponCode(
  storage: ActiveCouponStorage,
  code: string,
): Promise<string | null> {
  const normalized = normalizeActiveCouponCode(code);
  if (!normalized) return null;
  try {
    await storage.setItem(ACTIVE_COUPON_STORAGE_KEY, normalized);
  } catch {
    // Storage write failures do not block in-memory coupon activation.
  }
  return normalized;
}

export async function clearActiveCouponCode(
  storage: ActiveCouponStorage,
): Promise<void> {
  try {
    await storage.removeItem(ACTIVE_COUPON_STORAGE_KEY);
  } catch {
    // Best-effort cleanup after removal or order completion.
  }
}

export function reconcileStoredCouponWithCheckout(params: {
  savedCoupon: string | null | undefined;
  couponDraft: string;
  appliedCouponCode: string | null;
}): {
  shouldApply: boolean;
  couponDraft: string;
  appliedCouponCode: string | null;
} {
  const normalizedSaved = normalizeActiveCouponCode(params.savedCoupon);
  if (!normalizedSaved) {
    return {
      shouldApply: false,
      couponDraft: params.couponDraft,
      appliedCouponCode: params.appliedCouponCode,
    };
  }

  if (params.appliedCouponCode === normalizedSaved) {
    return {
      shouldApply: false,
      couponDraft: params.couponDraft || normalizedSaved,
      appliedCouponCode: params.appliedCouponCode,
    };
  }

  const normalizedDraft = normalizeActiveCouponCode(params.couponDraft);
  const canReplaceCurrent =
    normalizedDraft === null || normalizedDraft === params.appliedCouponCode;

  if (!canReplaceCurrent) {
    return {
      shouldApply: false,
      couponDraft: params.couponDraft,
      appliedCouponCode: params.appliedCouponCode,
    };
  }

  return {
    shouldApply: true,
    couponDraft: normalizedSaved,
    appliedCouponCode: normalizedSaved,
  };
}

const DEFINITIVE_COUPON_REJECTION_HTTP_STATUSES = new Set([400, 403, 404, 409, 422]);
const DEFINITIVE_COUPON_REJECTION_CODES = new Set([
  "BAD_REQUEST",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "UNPROCESSABLE_CONTENT",
]);

/**
 * Only clear an applied/stored coupon when the server definitively rejected the
 * quote request (HTTP 400/403/404/409/422 or business TRPCError code).
 * Transient offline, timeout, rate-limit (429), 5xx, or expired-session (401)
 * failures preserve the customer's coupon for immediate retry.
 */
export function shouldInvalidateCouponOnQuoteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  if (
    error.name === "TypeError" &&
    /network request failed|failed to fetch/i.test(error.message)
  ) {
    return false;
  }

  const typed = error as Error & { code?: unknown; httpStatus?: unknown };
  if (typeof typed.httpStatus === "number") {
    return DEFINITIVE_COUPON_REJECTION_HTTP_STATUSES.has(typed.httpStatus);
  }
  const statusMatch = /\((\d{3})\)/.exec(error.message);
  if (statusMatch) {
    return DEFINITIVE_COUPON_REJECTION_HTTP_STATUSES.has(Number(statusMatch[1]));
  }
  if (typeof typed.code === "string") {
    return DEFINITIVE_COUPON_REJECTION_CODES.has(typed.code);
  }
  return false;
}

