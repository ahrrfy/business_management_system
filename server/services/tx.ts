import { TRPCError } from "@trpc/server";
import { getDb, type DB, type Tx } from "../db";

/** Resolve the DB or throw a uniform tRPC error when DATABASE_URL is unset. */
export function requireDb(): DB {
  const db = getDb();
  if (!db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  }
  return db;
}

/** Wrap a unit of work in an atomic transaction. Any throw ⇒ full ROLLBACK. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return requireDb().transaction(fn);
}

/** The acting user + branch context for a business operation. */
export type Actor = { userId: number; branchId: number };
