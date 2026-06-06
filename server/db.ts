import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "../drizzle/schema";

/**
 * Build a pooled Drizzle instance. A pool (not a single connection) is required
 * so that `db.transaction(...)` works for the atomic flows.
 */
function createDb(url: string) {
  const pool = mysql.createPool(url);
  return drizzle(pool, { schema, mode: "default" });
}

let _db: ReturnType<typeof createDb> | null = null;

/** Lazily create the DB. Returns null when DATABASE_URL is unset. */
export function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    _db = createDb(url);
  }
  return _db;
}

export type DB = ReturnType<typeof createDb>;
/** Transaction handle as passed to `db.transaction(async (tx) => { ... })`. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
