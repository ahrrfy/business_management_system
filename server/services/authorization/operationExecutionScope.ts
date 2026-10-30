import { AsyncLocalStorage } from "node:async_hooks";
import type { Tx } from "../../db";
import {
  assertOperationAuthorityTx,
  type StoredOperationSnapshot,
} from "./operationAuthority";

/** Server-only dispatch context; authority is checked in the domain's real transaction. */
export interface OperationExecutionAuthority {
  actor: { userId: number; role?: string; branchId?: number | null };
  path: string;
  legacyAllowed: (current: StoredOperationSnapshot) => boolean;
  /** Fixed owner/reserved-source invariants must throw on denial, including canonical grants. */
  assertCurrent?: (current: StoredOperationSnapshot) => void;
}

const executionAuthorities = new AsyncLocalStorage<readonly OperationExecutionAuthority[]>();

/** Carries no locks/transaction itself; nested dispatch retains every parent restriction. */
export function withOperationAuthority<T>(
  authority: OperationExecutionAuthority,
  fn: () => Promise<T>,
): Promise<T> {
  const frozen = Object.freeze({
    ...authority,
    actor: Object.freeze({ ...authority.actor }),
  });
  return executionAuthorities.run(
    Object.freeze([...(executionAuthorities.getStore() ?? []), frozen]),
    fn,
  );
}

/** Called after the company gate and before any domain callback or financial write. */
export async function assertExecutionAuthoritiesTx(tx: Tx): Promise<void> {
  for (const authority of executionAuthorities.getStore() ?? []) {
    await assertOperationAuthorityTx(
      tx,
      authority.actor,
      authority.path,
      authority.legacyAllowed,
      undefined,
      { assertCurrent: authority.assertCurrent },
    );
  }
}
