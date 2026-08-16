type MysqlErrorShape = {
  code?: unknown;
  errno?: unknown;
  sqlState?: unknown;
  cause?: unknown;
};

export function isMysqlDeadlock(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    if (visited.has(current)) return false;
    visited.add(current);
    if (typeof current !== "object") return false;
    const shaped = current as MysqlErrorShape;
    if (
      shaped.code === "ER_LOCK_DEADLOCK" ||
      shaped.errno === 1213 ||
      shaped.sqlState === "40001"
    ) {
      return true;
    }
    current = shaped.cause;
  }
  return false;
}

/**
 * Retries the complete transaction callback only when MySQL confirms a
 * deadlock victim (1213/40001). Every failed attempt has already been rolled
 * back by Drizzle; validation and idempotency are therefore re-run from the
 * beginning instead of resuming a partially locked domain operation.
 */
export async function withMysqlDeadlockRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      if (!isMysqlDeadlock(error) || attempt >= maxAttempts) throw error;
    }
  }
}
