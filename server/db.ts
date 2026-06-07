import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "../drizzle/schema";

/**
 * Build a pooled Drizzle instance. A pool (not a single connection) is required
 * so that `db.transaction(...)` works for the atomic flows.
 *
 * ضبط الـpool للاعتمادية تحت الحِمل وفي بيئة متجر قد تنقطع شبكته:
 * - enableKeepAlive: يبقي الاتصالات حيّة فلا تُغلَق بصمت ⇒ يمنع "PROTOCOL_CONNECTION_LOST".
 * - connectTimeout: يفشل بسرعة بدل التعليق عند تعذّر الوصول للقاعدة.
 * - queueLimit/connectionLimit: يحدّان الضغط على القاعدة في الذروة.
 */
function createDb(url: string) {
  const pool = mysql.createPool({
    uri: url,
    connectionLimit: Number(process.env.DB_POOL_LIMIT ?? 20),
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    connectTimeout: 10_000,
    waitForConnections: true,
    queueLimit: 50,
  });
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
