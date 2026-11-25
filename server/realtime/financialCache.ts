import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import { onBridgeEvent } from "./bridge";
import { FINANCIAL_ALERTS_REFRESH_MS } from "@shared/financialRealtime";

// Cache revisions follow the same bridge event as browser invalidation, across workers.
// TTL and single-flight still share fresh reads without serving a pre-commit snapshot.
let revision = 0;

onBridgeEvent((event) => {
  if (
    event.type === REALTIME_EVENT_TYPES.RESYNC_REQUIRED ||
    event.type === REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED
  ) {
    revision += 1;
  }
});

export function financialCacheKey(key: string): string {
  return `single:${revision}:${key}`;
}

/** Heavy alerts get one shared snapshot per window, even during continuous sales. */
export function financialAlertsCacheKey(key: string): string {
  return `single:${Math.floor(Date.now() / FINANCIAL_ALERTS_REFRESH_MS)}:${key}`;
}
