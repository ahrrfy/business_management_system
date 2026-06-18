/**
 * يُشغَّل قبل كل ملف اختبار (setupFiles في vitest.config.ts).
 * يُفرّغ كل الجداول لمنع تلوّث الحالة بين ملفات الاختبار.
 *
 * **القائمة ذاتية الصيانة:** نقرأ كل الجداول من information_schema لقاعدة الاختبار
 * بدل قائمة ثابتة، حتى لا تتقادم مع نمو المخطط. الاستثناءات: جداول
 * الهجرة نفسها (__drizzle_migrations) — لا نمسّ بياناتها.
 *
 * **اتصال مفرد (لا pool):** SET FOREIGN_KEY_CHECKS متغيّر جلسة — يجب أن تجري
 * عمليات DELETE على نفس الاتصال الذي عُيِّن فيه الإعداد.
 *
 * **DELETE لا TRUNCATE:** TRUNCATE هو DDL في InnoDB يُغيّر table_id الداخلي،
 * فتُبطل metadata اتصالات الـpool ⇒ ER_TABLE_DEF_CHANGED في الاختبار التالي.
 * DELETE هو DML لا يُغيّر بنية الجدول ⇒ لا يُبطل metadata الـpool.
 */
import mysql from "mysql2/promise";
import { beforeAll } from "vitest";
import { closeDb } from "../../db";

const SKIP = new Set(["__drizzle_migrations"]);

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) return;

  const conn = await mysql.createConnection(url);
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
    );
    const tables = rows.map((r) => r.name as string).filter((n) => !SKIP.has(n));

    // فشل-سريع: قاعدة اختبار بصفر جداول ⇒ مخطّط غير مُهيَّأ (نسي pnpm db:push)
    if (!tables.length) {
      throw new Error(
        "__setup__: zero tables discovered — DATABASE() empty or schema not pushed; aborting to avoid silent isolation failure",
      );
    }

    await conn.execute("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of tables) {
      await conn.execute(`DELETE FROM \`${t}\``).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`__setup__: DELETE ${t} failed: ${msg}`);
      });
    }
    await conn.execute("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await conn.end();
  }
  // Reset the Drizzle pool: FK_CHECKS=0+DELETE in MySQL 8.0 increments the server-side
  // metadata version for affected tables, causing ER_TABLE_DEF_CHANGED when pool
  // connections try to re-use stale server-side prepared statement handles.
  // Closing the pool forces a fresh pool on next getDb() with no cached handles.
  await closeDb();
});
