import { useEffect, useRef } from "react";

interface TrackedOrder {
  orderNumber: string;
  status: string;
}
interface TrackingRefreshOptions<T extends TrackedOrder> {
  enabled: boolean;
  /** Token bound to the successful lookup, not the input currently being edited. */
  trackingToken: string | null;
  result: T | null;
  fetchLatest: (trackingToken: string) => Promise<T>;
  onResult: (result: T) => void;
}

/** Only the open, unfinished customer order is refreshed; staff screens use the event bus. */
export function useOrderTrackingRefresh<T extends TrackedOrder>({
  enabled,
  trackingToken,
  result,
  fetchLatest,
  onResult,
}: TrackingRefreshOptions<T>): void {
  const callbacks = useRef({ fetchLatest, onResult });
  useEffect(() => {
    callbacks.current = { fetchLatest, onResult };
  }, [fetchLatest, onResult]);
  const orderNumber = result?.orderNumber;
  const status = result?.status;
  useEffect(() => {
    if (
      !enabled ||
      !trackingToken ||
      !orderNumber ||
      !status ||
      ["DELIVERED", "CANCELLED"].includes(status)
    )
      return;
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
      } catch {
        // Keep the last verified response during connection failures; the next tick/resume retries.
      } finally {
        pending = false;
      }
    };
    const resume = () => {
      void refresh();
    };
    const timer = window.setInterval(resume, 30_000);
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
  }, [enabled, trackingToken, orderNumber, status]);
}
