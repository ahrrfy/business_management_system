import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Tx } from "../db";
import { logger } from "../logger";
import { enqueuePostCommit, enqueuePostRollback } from "../services/tx";

/**
 * MySQL 8 `GET_LOCK(str, timeout)` enforces a strict 64-character ceiling on `str`
 * (`ER_USER_LOCK_OVERLONG_NAME`). Keep short canonical keys verbatim (preserving
 * observability and `IS_FREE_LOCK` assertions) and hash keys exceeding 64 chars.
 */
export function normalizeMysqlLockName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    throw new Error("MySQL named lock key must not be empty");
  }
  if (trimmed.length <= 64 && Buffer.byteLength(trimmed, "utf8") <= 64) {
    return trimmed;
  }
  const digest = createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 48);
  return `alroya:lock:${digest}`;
}

function extractScalarNumber(result: unknown, field: string): number | null {
  const row = Array.isArray(result)
    ? ((Array.isArray(result[0]) ? result[0][0] : result[0]) as Record<string, unknown> | undefined)
    : (result as { rows?: Array<Record<string, unknown>> } | null)?.rows?.[0];
  if (!row || row[field] == null) return null;
  const num = Number(row[field]);
  return Number.isFinite(num) ? num : null;
}

export function destroyTxUnderlyingConnection(tx: unknown): boolean {
  const client = (
    tx as { session?: { client?: { destroy?: () => void } } } | null | undefined
  )?.session?.client;
  if (!client || typeof client.destroy !== "function") return false;
  try {
    client.destroy();
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquires a MySQL session-level advisory lock (`GET_LOCK`) on `tx` without checking
 * out a second pool connection (preventing pool-exhaustion deadlocks under burst load),
 * and guarantees in `finally` that `RELEASE_LOCK` succeeded (`released === 1`).
 *
 * If `RELEASE_LOCK` throws or returns `!== 1`, the underlying `PoolConnection` is
 * scheduled for immediate destruction so a leaked session lock can never return to the pool.
 */
export async function withTxNamedLock<T>(
  tx: Tx,
  rawLockName: string,
  timeoutSeconds: number,
  onBusy: () => never,
  fn: () => Promise<T>,
): Promise<T> {
  const lockName = normalizeMysqlLockName(rawLockName);
  const safeTimeout = Math.max(0, Math.trunc(timeoutSeconds));
  const lockRes = (await tx.execute(
    sql`SELECT GET_LOCK(${lockName}, ${safeTimeout}) AS locked`,
  )) as unknown;
  if (extractScalarNumber(lockRes, "locked") !== 1) {
    onBusy();
  }

  let hasBodyError = false;
  try {
    return await fn();
  } catch (err) {
    hasBodyError = true;
    throw err;
  } finally {
    let releasedOk = false;
    let releaseErr: unknown;
    try {
      const relRes = (await tx.execute(
        sql`SELECT RELEASE_LOCK(${lockName}) AS released`,
      )) as unknown;
      releasedOk = extractScalarNumber(relRes, "released") === 1;
    } catch (err) {
      releaseErr = err;
    }

    if (!releasedOk) {
      logger.error(
        { err: releaseErr, lockName },
        "mysql.named_lock.release_failed_destroying_connection",
      );
      enqueuePostCommit(tx, () => {
        destroyTxUnderlyingConnection(tx);
      });
      enqueuePostRollback(tx, () => {
        destroyTxUnderlyingConnection(tx);
      });
      if (!hasBodyError) {
        throw (
          releaseErr ??
          new Error(`Failed to release MySQL named lock (${lockName}); aborting transaction`)
        );
      }
    }
  }
}
