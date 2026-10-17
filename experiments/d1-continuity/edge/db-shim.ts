import { AsyncLocalStorage } from "node:async_hooks";
import type { ActualDb } from "./actual";

const requestDb = new AsyncLocalStorage<ActualDb>();

/** Exact server/db substitution for this isolated experiment only. */
export function getDb(): ActualDb {
  const db = requestDb.getStore();
  if (!db) throw new Error("Unsupported actual-service operation: no request database context");
  return db;
}

export function withActualDb<T>(db: ActualDb, callback: () => T): T {
  return requestDb.run(db, callback);
}
