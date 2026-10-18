import { useEffect, useRef } from "react";

interface TrackedOrder {
  orderNumber: string;
  status: string;
  deliveryProgress?: { complete?: boolean };
}
interface TrackingRefreshOptions<T extends TrackedOrder> {
  enabled: boolean;
  /** Token bound to the successful lookup, not the input currently being edited. */
  trackingToken: string | null;
  result: T | null;
  fetchLatest: (trackingToken: string) => Promise<T>;
  onResult: (result: T) => void;
  onUnavailable?: () => void;
}

/** Only the open customer order is refreshed; completed orders use a slower cadence. */
export function useOrderTrackingRefresh<T extends TrackedOrder>({
  enabled,
  trackingToken,
  result,
  fetchLatest,
  onResult,
  onUnavailable,
}: TrackingRefreshOptions<T>): void {
  const callbacks = useRef({ fetchLatest, onResult, onUnavailable });
  useEffect(() => {
    callbacks.current = { fetchLatest, onResult, onUnavailable };
  }, [fetchLatest, onResult, onUnavailable]);
  const orderNumber = result?.orderNumber;
  const status = result?.status;
  const complete = result?.deliveryProgress?.complete === true;
  useEffect(() => {
    if (!enabled || !trackingToken || !orderNumber || !status) return;
    let disposed = false;
    let pending = false;
    let lastRefresh = Date.now();
    const refresh = async () => {
      if (
        disposed ||
        pending ||
        document.visibilityState === "hidden" ||
        !navigator.onLine ||
        Date.now() - lastRefresh < 1_000
      )
        return;
      pending = true;
      lastRefresh = Date.now();
      try {
        const next = await callbacks.current.fetchLatest(trackingToken);
        if (!disposed && next.orderNumber === orderNumber)
          callbacks.current.onResult(next);
      } catch (error) {
        const failure = error as {
          data?: { code?: string };
          code?: string;
        } | null;
        const code = failure?.data?.code ?? failure?.code;
        if (
          !disposed &&
          code &&
          ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(code)
        ) {
          disposed = true;
          callbacks.current.onUnavailable?.();
        }
        // Temporary connection/server failures retain the last verified response and retry.
      } finally {
        pending = false;
      }
    };
    const resume = () => {
      void refresh();
    };
    const timer = window.setInterval(
      resume,
      complete || status === "CANCELLED" ? 300_000 : 30_000,
    );
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
    };
  }, [enabled, trackingToken, orderNumber, status, complete]);
}
