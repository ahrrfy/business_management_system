import { AsyncLocalStorage } from "node:async_hooks";
import { lockFinancialPostingGate } from "../../../server/services/reports/monthCloseGate";
const current = new AsyncLocalStorage<{ tx: any; deferredHooks: number }>();
export async function inStaging<T>(tx: any, run: () => Promise<T>) {
  const context = { tx, deferredHooks: 0 };
  const value = await current.run(context, run);
  return { value, deferredHooks: context.deferredHooks };
}
export async function withTx<T>(
  run: (tx: any) => Promise<T>,
  options: { gate?: string } = {},
) {
  const context = current.getStore();
  if (!context || (options.gate && options.gate !== "FINANCIAL_WRITER"))
    throw Error("UNSUPPORTED_GLOBAL_TRANSACTION");
  await lockFinancialPostingGate(context.tx);
  return run(context.tx);
}
export function enqueuePostCommit(tx: any, _hook: () => unknown) {
  const context = current.getStore();
  if (!context || tx !== context.tx)
    throw Error("STAGING_HOOK_OUTSIDE_TRANSACTION");
  context.deferredHooks++;
}
export function requireDb(): never {
  throw Error("GLOBAL_DATABASE_FORBIDDEN");
}
export function withGovernanceTx(): never {
  throw Error("UNSUPPORTED_GOVERNANCE_TRANSACTION");
}
export type Actor = { userId: number; branchId: number; role?: string };
