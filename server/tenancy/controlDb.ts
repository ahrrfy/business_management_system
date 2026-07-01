import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as controlSchema from "./controlSchema";

/**
 * اتصال مستقلّ لقاعدة التحكّم (erp_control) — لا علاقة له بـ`server/db.ts`/`getDb()` ولا
 * بسياق الاستئجار (AsyncLocalStorage). هذه القاعدة ثابتة دائماً بلا اعتماد على أي شركة —
 * هي التي تحدّد أصلاً أي قاعدة تخصّ أي شركة (مرجع أعلى من مفهوم "الشركة" نفسه).
 *
 * `CONTROL_DATABASE_URL` منفصل عمداً عن `DATABASE_URL` (الأخير يصبح خاصاً بشركة واحدة
 * بعد إدخال الاستئجار) — راجع `docs/` لخطة تعدّد الشركات.
 */
let _pool: mysql.Pool | null = null;
let _db: ReturnType<typeof createControlDb> | null = null;

function createControlDb(url: string) {
  _pool = mysql.createPool({
    uri: url,
    timezone: "Z",
    connectionLimit: 5,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    connectTimeout: 10_000,
    waitForConnections: true,
    queueLimit: 20,
  });
  return drizzle(_pool, { schema: controlSchema, mode: "default" });
}

/** Lazily create the control-plane DB. Returns null when CONTROL_DATABASE_URL is unset
 *  (single-company deployments that haven't adopted multi-company yet). */
export function getControlDb() {
  if (!_db) {
    const url = process.env.CONTROL_DATABASE_URL;
    if (!url) return null;
    _db = createControlDb(url);
  }
  return _db;
}

export async function closeControlDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}
