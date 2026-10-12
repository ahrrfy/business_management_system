import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import { getCurrentCompanyId } from "../tenancy/context";
import { onBridgeEvent } from "./bridge";
import { FINANCIAL_ALERTS_REFRESH_MS } from "@shared/financialRealtime";

// Cache revisions follow the same bridge event as browser invalidation, across workers.
// TTL and single-flight still share fresh reads without serving a pre-commit snapshot.
const revisions = new Map<number | null, number>();
let generation = 0;
const MAX_COMPANIES = 1_000;

function remember(companyId: number | null, revision: number): void {
  revisions.delete(companyId);
  revisions.set(companyId, revision);
  if (revisions.size > MAX_COMPANIES) revisions.delete(revisions.keys().next().value!);
}

onBridgeEvent((event) => {
  if (event.type === REALTIME_EVENT_TYPES.RESYNC_REQUIRED) {
    generation++;
    revisions.clear();
  } else if (event.type === REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED) {
    remember(event.scope?.companyId ?? null, ++generation);
  }
});

export function financialCacheKey(key: string): string {
  const companyId = getCurrentCompanyId();
  // An evicted company gets the current generation, never a reused stale version.
  const revision = revisions.get(companyId) ?? generation;
  remember(companyId, revision);
  return `${companyId ?? "single"}:${revision}:${key}`;
}

/** Heavy alerts get one shared snapshot per window, even during continuous sales. */
export function financialAlertsCacheKey(key: string): string {
  return `${getCurrentCompanyId() ?? "single"}:${Math.floor(Date.now() / FINANCIAL_ALERTS_REFRESH_MS)}:${key}`;
}
