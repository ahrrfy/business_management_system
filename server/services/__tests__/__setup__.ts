/**
 * يُشغَّل قبل كل ملف اختبار (setupFiles في vitest.config.ts).
 * يُفرّغ كل الجداول لمنع تلوّث الحالة بين ملفات الاختبار.
 *
 * **القائمة ذاتية الصيانة:** نقرأ كل الجداول من information_schema لقاعدة الاختبار
 * بدل قائمة ثابتة، حتى لا تتقادم مع نمو المخطط (جداول الاختبار الأحدث —
 * stocktake، production، HR، الأصول، السندات — كانت ناقصة ⇒ سبّبت ٢٢ فشل
 * عزل في CI رغم سلامة منطق المنتج — تدقيق ١٤/٦/٢٦). الاستثناءات: جداول
 * الهجرة نفسها (__drizzle_migrations) — لا نمسّ بياناتها.
 */
import { sql } from "drizzle-orm";
import { beforeAll } from "vitest";
import { getDb, getPool } from "../../db";

const SKIP = new Set(["__drizzle_migrations"]);

async function discoverTables(db: NonNullable<ReturnType<typeof getDb>>): Promise<string[]> {
  const rows = await db.execute(
    sql`SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
  );
  const data = ((rows as any)[0] ?? rows) as Array<{ name: string }>;
  if (!Array.isArray(data)) {
    throw new Error(`__setup__: information_schema returned non-array (${typeof data}) — schema discovery failed`);
  }
  const tables = data.map((r) => r.name).filter((n) => !SKIP.has(n));
  // فشل-سريع: قاعدة اختبار بصفر جداول ⇒ مخطّط غير مُهيَّأ (نسي pnpm db:push) — لا نمضي صامتاً.
  if (!tables.length) {
    throw new Error("__setup__: zero tables discovered — DATABASE() empty or schema not pushed; aborting to avoid silent isolation failure");
  }
  return tables;
}

beforeAll(async () => {
  const db = getDb();
  if (!db) return;
  const tables = await discoverTables(db);
  // استخدام اتصال مخصّص واحد يضمن أن SET FK_CHECKS=0 وكل TRUNCATE تعمل على نفس جلسة MySQL.
  // الـpool يُعيد اتصالاً مختلفاً لكل execute() ⇒ FK_CHECKS=0 على اتصال A لا يؤثر على اتصال B.
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of tables) {
      await conn.query(`TRUNCATE TABLE \`${t}\``).catch((e: unknown) => {
        const msg = e instanceof Error ? (e as Error).message : String(e);
        console.error(`__setup__: TRUNCATE ${t} failed: ${msg}`);
      });
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    conn.release();
  }
});
