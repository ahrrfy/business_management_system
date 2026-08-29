import { TRPCError } from "@trpc/server";
import { getDb, type DB, type Tx } from "../db";
import {
  ensureFinancialPostingGate,
  isMonthCloseGateMissing,
  lockCompanyMonthCloseGate,
  lockFinancialPostingGate,
} from "./reports/monthCloseGate";

/** Resolve the DB or throw a uniform tRPC error when DATABASE_URL is unset. */
export function requireDb(): DB {
  const db = getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "قاعدة البيانات غير متاحة",
    });
  }
  return db;
}

export type TransactionGate = "FINANCIAL_WRITER" | "GOVERNANCE" | "NONE";

/**
 * Hooks queued during a Tx that must fire **after** the transaction commits.
 * Used by services that need to trigger side-effects (notifications, cache
 * invalidation, event publication) tied to a successful commit — never firing
 * on rollback, and never blocking the transaction.
 *
 * Contract:
 *   - Callable from any code inside `withTx(async (tx) => { ... })` via
 *     `enqueuePostCommit(tx, () => ...)`.
 *   - Hooks fire **after** commit succeeds, in registration order.
 *   - Each hook is wrapped in try/catch — a hook throw does NOT propagate or
 *     roll back (the tx already committed). Fail-open is the contract for the
 *     side-effects we register (notification dispatch is not part of the
 *     financial transaction integrity).
 *   - On rollback (fn throws) the hook list is discarded silently.
 *   - Codex ٢٩/٨: centralized so no future caller can bypass a post-commit
 *     side-effect by forgetting to wire it at the router layer.
 */
const postCommitHooksByTx = new WeakMap<Tx, Array<() => void | Promise<void>>>();

export function enqueuePostCommit(
  tx: Tx,
  hook: () => void | Promise<void>,
): void {
  const list = postCommitHooksByTx.get(tx);
  if (list) list.push(hook);
  else postCommitHooksByTx.set(tx, [hook]);
}

async function drainPostCommitHooks(tx: Tx): Promise<void> {
  const hooks = postCommitHooksByTx.get(tx);
  if (!hooks || hooks.length === 0) return;
  postCommitHooksByTx.delete(tx);
  for (const hook of hooks) {
    try {
      await hook();
    } catch {
      // fail-open: transaction already committed; side-effects don't affect integrity.
    }
  }
}

/**
 * Wrap a unit of work in an atomic transaction. Any throw ⇒ full ROLLBACK.
 *
 * The default gate is deliberately acquired before the callback can lock any
 * domain row. This gives every application transaction one global lock order:
 * company gate -> domain rows. Month/year-close governance asks for the
 * exclusive form at transaction entry, so it can never hold the gate while a
 * writer waits on a domain lock that governance later needs.
 *
 * Post-commit hooks registered via `enqueuePostCommit(tx, ...)` fire after
 * commit succeeds — never on rollback.
 */
export async function withTx<T>(
  fn: (tx: Tx) => Promise<T>,
  options: { gate?: TransactionGate } = {},
): Promise<T> {
  const database = requireDb();
  let capturedTx: Tx | null = null;
  const run = () => database.transaction(async (tx) => {
    capturedTx = tx;
    const gate = options.gate ?? "FINANCIAL_WRITER";
    if (gate === "GOVERNANCE") await lockCompanyMonthCloseGate(tx);
    else if (gate === "FINANCIAL_WRITER") await lockFinancialPostingGate(tx);
    return fn(tx);
  });

  try {
    const result = await run();
    // Transaction committed successfully — fire post-commit hooks.
    if (capturedTx) await drainPostCommitHooks(capturedTx);
    return result;
  } catch (error) {
    // Rollback happened — discard any queued hooks silently.
    if (capturedTx) postCommitHooksByTx.delete(capturedTx);
    if (!isMonthCloseGateMissing(error)) throw error;
    // الفشل وقع قبل callback، لذلك الإعادة آمنة ولا تكرر أي أثر أعمال.
    await ensureFinancialPostingGate(database);
    capturedTx = null;
    const result = await run();
    if (capturedTx) await drainPostCommitHooks(capturedTx);
    return result;
  }
}

/** Governance transaction with the exclusive close gate acquired at entry. */
export function withGovernanceTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(fn, { gate: "GOVERNANCE" });
}

/**
 * Actor يُمثّل المستخدم المُنفِّذ للعملية. يُمرَّر إلى كل خدمة كتابة:
 * - userId: معرّف المستخدم (users.id) — للتدقيق + ملكية الوردية.
 * - branchId: معرّف الفرع الذي يَنتمي إليه المستخدم (users.branchId) — لعزل الفروع.
 * - role: دور المستخدم (admin/manager/cashier/warehouse) — للـRBAC على cross-branch وكشف التكلفة.
 * تأكَّد من تَمرير role من ctx.user.role في كل الراوترات.
 *
 * ملاحظة: role اختياري حفاظاً على التوافق الخلفي، لكن الخدمات التي تَفحص الصلاحية
 * على مستوى الخدمة (مثل productionService.assertProductionBranch، عزل الفروع لغير
 * admin، حجب التكلفة عن الكاشير) تَعتمد عليه — تَمريره من ctx.user.role إلزامي عملياً.
 */
export type Actor = {
  userId: number;
  branchId: number;
  role?: string;
  isOwner?: boolean;
};
