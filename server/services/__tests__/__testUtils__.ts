/**
 * مساعدات الاختبار المشتركة.
 *
 * truncateTables / truncateAllTables: تُنظّف الجداول عبر اتصال mysql2 فردي (لا pool) حتى
 * يُطبَّق SET FOREIGN_KEY_CHECKS = 0 على نفس الاتصال الذي يُنفَّذ فيه DELETE.
 *
 * DELETE لا TRUNCATE: TRUNCATE هو DDL في InnoDB يُغيّر table_id الداخلي ⇒ يُسبّب
 * ER_TABLE_DEF_CHANGED لاتصالات pool التي تخزّن metadata القديمة.
 * DELETE هو DML لا يُغيّر بنية الجدول ⇒ لا يُبطل metadata الـpool.
 *
 * ملاحظة: DELETE لا يُعيد ضبط AUTO_INCREMENT. Seeds التي تعتمد على IDs متولَّدة
 * تلقائياً يجب أن تلتقط insertId وتستخدمه بدلاً من تثبيت القيمة 1.
 */
import mysql from "mysql2/promise";
import { closeDb } from "../../db";

export async function truncateTables(tables: readonly string[] | string[]): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const conn = await mysql.createConnection(url);
  try {
    await conn.execute("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of tables) {
      await conn.execute(`DELETE FROM \`${t}\``).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`truncateTables: DELETE ${t} failed: ${msg}`);
      });
    }
    await conn.execute("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await conn.end();
  }
  // Reset the Drizzle pool so the next getDb() gets fresh connections with no stale
  // prepared-statement handles. FK_CHECKS=0 + DELETE in MySQL 8.0 increments the
  // server-side metadata version for affected tables, which causes ER_TABLE_DEF_CHANGED
  // on subsequent pool connections that still hold the old prepared-statement IDs.
  await closeDb();
}

export async function truncateAllTables(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const conn = await mysql.createConnection(url);
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
    );
    const tables = rows.map((r) => r.name as string).filter((n) => n !== "__drizzle_migrations");
    await conn.execute("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of tables) {
      await conn.execute(`DELETE FROM \`${t}\``).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`truncateAllTables: DELETE ${t} failed: ${msg}`);
      });
    }
    await conn.execute("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await conn.end();
  }
}
