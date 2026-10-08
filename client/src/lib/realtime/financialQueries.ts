import type { Query, QueryClient } from "@tanstack/react-query";
import { FINANCIAL_QUERY_ROOTS, type FinancialDataChangedPayload } from "@shared/financialRealtime";
import { REALTIME_EVENT_TYPES, type RealtimeEvent } from "@shared/realtimeEvents";
import { realtimeManager } from "./realtimeManager";

const financialRoots: ReadonlySet<string> = new Set(FINANCIAL_QUERY_ROOTS);

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

  const visible = () => document.visibilityState !== "hidden" && navigator.onLine;
  const schedule = () => {
    if (stopped || timer || running || !pending || !visible()) return;
    // Fixed batch window (not a trailing debounce): continuous sales cannot starve updates.
    timer = setTimeout(flush, Math.max(750, lastRefresh + 2_000 - Date.now()));
  };
  const queue = (branchIds: number[] | null, allowRepair = true) => {
    pending = true;
    repairEligible ||= allowRepair;
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
    const predicate = (query: Query) => isFinancialQuery(query, affected);
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
  const resume = () => { if (visible()) queue(null); };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("online", resume);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    reconnect();
    resync();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("online", resume);
  };
}
