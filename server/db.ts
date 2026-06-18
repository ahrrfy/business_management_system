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
let _pool: mysql.Pool | null = null;

function createDb(url: string) {
  const pool = mysql.createPool({
    uri: url,
    // المنطقة الزمنية صراحةً = UTC ('Z') بدل افتراض mysql2 الضمني 'local' (منطقة عملية Node).
    // يجعل تحويل JS Date ↔ سلسلة SQL حتمياً ومستقلاً عن منطقة المضيف، ويُصلح انزياح فلترة التواريخ
    // الذي كان يحدث حين تختلف منطقة Node عن جلسة القاعدة قرب حدّ اليوم (علّة inventoryMovements «(د4)»
    // المتقطّعة). يكتمل الضبط بتشغيل Node بـTZ=UTC (سكربتات dev/start/test + pm2) لتتطابق منطقة العملية
    // مع جلسة القاعدة (حاوية MySQL تعمل UTC افتراضاً: NOW()=UTC_TIMESTAMP()) ⇒ اتّساق تامّ. تجنّبنا تثبيت
    // الجلسة عبر معالِج 'connection' لأنه يتسابق مع مُلتقِط الاتصال تحت الحِمل فيُفسد بروتوكول الاتصال.
    timezone: "Z",
    connectionLimit: Number(process.env.DB_POOL_LIMIT ?? 20),
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    connectTimeout: 10_000,
    waitForConnections: true,
    queueLimit: 50,
  });
  _pool = pool;
  return drizzle(pool, { schema, mode: "default" });
}

let _db: ReturnType<typeof createDb> | null = null;

/** إغلاق رشيق لتجمّع الاتصالات (يُستدعى عند SIGTERM/SIGINT) ⇒ لا اتصالات معلّقة عند الإطفاء. */
export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

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

/** Raw pool for test helpers that need a dedicated connection (e.g. TRUNCATE with FK_CHECKS). */
export function getPool(): mysql.Pool {
  if (!_pool) throw new Error("DB pool not initialized — call getDb() first");
  return _pool;
}
