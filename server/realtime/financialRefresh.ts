import type { Tx } from "../db";
import { getCurrentCompanyId } from "../tenancy/context";
import { enqueuePostCommit } from "../services/tx";
import { publishRealtimeEvent } from "./index";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import type { FinancialDataChangedPayload } from "@shared/financialRealtime";
import { logger } from "../logger";

const pending = new Map<number | null, Set<number> | null>();
const queuedTransactions = new WeakMap<Tx, Set<number> | null>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** No SQL, no monetary payload; bursts share a single message per company/worker. */
export function scheduleFinancialRefresh(branchId: number | null = null): void {
  const companyId = getCurrentCompanyId();
  // A tenant-less background job must not broadcast into other tenant sessions.
  if (process.env.CONTROL_DATABASE_URL && companyId == null) return;
  const previous = pending.get(companyId);
  if (branchId == null || previous === null) pending.set(companyId, null);
  else {
    const branches = previous ?? new Set<number>();
    branches.add(branchId);
    pending.set(companyId, branches);
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const batch = Array.from(pending);
    pending.clear();
    for (const [companyId, branches] of batch) {
      const branchIds = branches ? Array.from(branches) : null;
      try {
        publishRealtimeEvent<FinancialDataChangedPayload>(
          REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED,
          { branchIds },
          // Explicit companyId prevents the timer's first ALS context leaking to other batches.
          { companyId, branchId: branchIds?.length === 1 ? branchIds[0] : null },
        );
      } catch (error) {
        // A notification failure cannot crash the process after money has already committed.
        logger.warn({ err: error, companyId }, "realtime_financial.publish_failed");
      }
    }
  }, 400);
  timer.unref?.();
}

/** One hook per transaction; rollback discards the hook through withTx. */
export function enqueueFinancialRefresh(tx: Tx, branchId: number | null): void {
  if (queuedTransactions.has(tx)) {
    const branches = queuedTransactions.get(tx);
    if (branchId == null) queuedTransactions.set(tx, null);
    else branches?.add(branchId);
    return;
  }
  queuedTransactions.set(tx, branchId == null ? null : new Set([branchId]));
  enqueuePostCommit(tx, () => {
    const branches = queuedTransactions.get(tx);
    queuedTransactions.delete(tx);
    if (branches == null) scheduleFinancialRefresh();
    else branches.forEach((id) => scheduleFinancialRefresh(id));
  });
}
