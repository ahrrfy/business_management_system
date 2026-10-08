import type { Query, QueryClient } from "@tanstack/react-query";
import { FINANCIAL_ALERTS_REFRESH_MS, FINANCIAL_QUERY_ROOTS, type FinancialDataChangedPayload } from "@shared/financialRealtime";
import { REALTIME_EVENT_TYPES, type RealtimeEvent } from "@shared/realtimeEvents";
import { realtimeManager } from "./realtimeManager";

const financialRoots: ReadonlySet<string> = new Set(FINANCIAL_QUERY_ROOTS);
const isHeavyAlerts = (query: Query) => {
  const path = query.queryKey[0];
  return Array.isArray(path) && path[0] === "reports" && path[1] === "managementAlerts";
};
const includesHeavyAlerts = (query: Query) => {
  const path = query.queryKey[0];
  return isHeavyAlerts(query) || (Array.isArray(path) && path[0] === "executive" && path[1] === "commandCenter");
};

export function isFinancialQuery(query: Query, branchIds: ReadonlySet<number> | null): boolean {
  const [path, options] = query.queryKey;
  if (!Array.isArray(path) || !financialRoots.has(path[0])) return false;
  if (branchIds == null) return true;
  const input = (options as { input?: { branchId?: unknown } } | undefined)?.input;
  // Unfiltered/company-wide reads depend on every branch. Server RBAC still gates each read.
  return input?.branchId == null || branchIds.has(input.branchId as number);
}

/** One installation per QueryClient; no polling, extra sockets or per-cell subscriptions. */
export function installFinancialQueryRefresh(queryClient: QueryClient): () => void {
  let pending = false;
  let branches: Set<number> | null = new Set();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;
  let repairEligible = false;
  let lastRefresh = -Infinity;
  let alertsPending = false;
  let alertsTimer: ReturnType<typeof setTimeout> | null = null;
  let alertsDue = 0;
  let alertsRunning = false;
  let alertsRepairEligible = false;

  const visible = () => document.visibilityState !== "hidden" && navigator.onLine;
  const scheduleAlerts = () => {
    if (stopped || alertsTimer || alertsRunning || !alertsPending || !visible()) return;
    alertsTimer = setTimeout(flushAlerts, Math.max(750, alertsDue - Date.now()));
  };
  const queueAlerts = (allowRepair = true) => {
    if (!alertsPending) alertsDue = Date.now() + FINANCIAL_ALERTS_REFRESH_MS + 50;
    alertsPending = true;
    alertsRepairEligible ||= allowRepair;
    scheduleAlerts();
  };
  const flushAlerts = async () => {
    alertsTimer = null;
    if (!visible() || stopped) return;
    const canRepair = alertsRepairEligible;
    alertsRepairEligible = false;
    alertsPending = false;
    alertsRunning = true;
    const alreadyFetching = queryClient.getQueryCache().findAll({ predicate: includesHeavyAlerts, type: "active" })
      .some((query) => query.state.fetchStatus === "fetching");
    try {
      await queryClient.invalidateQueries({ predicate: includesHeavyAlerts, refetchType: "active" }, { cancelRefetch: false });
    } finally {
      alertsRunning = false;
      if (canRepair && alreadyFetching && !stopped) queueAlerts(false);
      scheduleAlerts();
    }
  };
  const schedule = () => {
    if (stopped || timer || running || !pending || !visible()) return;
    // Fixed batch window (not a trailing debounce): continuous sales cannot starve updates.
    timer = setTimeout(flush, Math.max(750, lastRefresh + 2_000 - Date.now()));
  };
  const queue = (branchIds: number[] | null, allowRepair = true) => {
    pending = true;
    repairEligible ||= allowRepair;
    if (allowRepair) {
      // Invalidate immediately without HTTP; a single trailing refresh crosses the
      // server's heavy-alert snapshot window, even if this is the final sales event.
      void queryClient.invalidateQueries({ predicate: isHeavyAlerts, refetchType: "none" });
      queueAlerts();
    }
    if (branchIds == null) branches = null;
    else if (branches) for (const id of branchIds) branches.add(id);
    schedule();
  };
  const flush = async () => {
    timer = null;
    if (!visible() || stopped) return;
    const affected = branches;
    const canRepair = repairEligible;
    repairEligible = false;
    branches = new Set();
    pending = false;
    running = true;
    lastRefresh = Date.now();
    const predicate = (query: Query) => isFinancialQuery(query, affected) && !isHeavyAlerts(query);
    // A read already in flight may have taken its snapshot before the commit.
    const alreadyFetching = queryClient.getQueryCache().findAll({ predicate, type: "active" })
      .some((query) => query.state.fetchStatus === "fetching");
    try {
      // Inactive caches become stale, but only mounted/enabled reads make HTTP requests.
      await queryClient.invalidateQueries({ predicate, refetchType: "active" }, { cancelRefetch: false });
    } finally {
      running = false;
      // One repair per event batch: external fetches must not create a refresh loop.
      if (canRepair && alreadyFetching && !stopped) queue(affected ? Array.from(affected) : null, false);
      schedule();
    }
  };
  const unsubscribe = realtimeManager.subscribe<FinancialDataChangedPayload>(
    REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED,
    (event: RealtimeEvent<FinancialDataChangedPayload>) => queue(event.payload.branchIds),
  );
  // SSE has no durable replay. A new connection (also forwarded to follower tabs) repairs gaps.
  const reconnect = realtimeManager.subscribe(REALTIME_EVENT_TYPES.CONNECTED, () => queue(null));
  const resync = realtimeManager.subscribe(REALTIME_EVENT_TYPES.RESYNC_REQUIRED, () => queue(null));
  const resume = () => { if (visible()) { queue(null); scheduleAlerts(); } };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("online", resume);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (alertsTimer) clearTimeout(alertsTimer);
    unsubscribe();
    reconnect();
    resync();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("online", resume);
  };
}
