/**
 * يُشغَّل بَعد **كل اختبار** (setupFiles في vitest.config.ts) لتفريغ كل الجداول ومنع تلوّث الحالة
 * بَين الاختبارات داخل الملف وبَين ملفات الاختبار.
 *
 * **القائمة ذاتية الصيانة:** نقرأ كل الجداول من information_schema لقاعدة الاختبار بدل قائمة ثابتة
 * (الجداول الأحدث — stocktake/production/HR/الأصول/السندات — كانت تَنقص ⇒ ٢٢ فشل عزل في CI، تدقيق
 * ١٤/٦). الاستثناء: __drizzle_migrations.
 *
 * **اتصال مُكرَّس طازج (لا تجمّع Drizzle) — إصلاح فلاكي ٢٠/٦:** بعض الاختبارات تُغلق تجمّع Drizzle
 * (closeDb عبر truncateTables) أو تُبدّل حالته؛ الاعتماد على getPool() جَعل afterEach يَفشل/يُتخطّى
 * بصمت أحياناً ⇒ branches لا تُحذَف ⇒ DUPLICATE KEY في الملف التالي (تراكم متقطّع). اتصال mysql
 * مُنشأ طازجاً كلَّ afterEach مُستقلٌّ تماماً عن حالة التجمّع ⇒ تنظيف موثوق دائماً.
 *
 * **DELETE لا TRUNCATE:** DML تَحترم FK_CHECKS=0 (TRUNCATE وهو DDL لا يَحترمها على الجداول الأمّ).
 * **conn.query (نصّي) لا conn.execute (مُهيَّأ):** العبارة المُهيَّأة المُخبَّأة تَبيت عبر تغيّر
 * metadata الناتج عن DELETE+FK_CHECKS=0 ⇒ ER_TABLE_DEF_CHANGED. النصّي يُعاد تحليله كلَّ مرّة.
 * **فشل صريح لا مُبتلَع:** أي إخفاق DELETE يَرمي باسم الجدول بدل الابتلاع الصامت الذي يُخفي التراكم.
 */
import mysql from "mysql2/promise";
import { afterEach } from "vitest";
import { closeDb } from "../../db";

const SKIP = new Set(["__drizzle_migrations"]);

// نلتقط رابط قاعدة الاختبار **مرّةً عند التحميل** قبل أيّ اختبار: بعض الاختبارات
// (maintenanceService.currentDbName) تُبدّل process.env.DATABASE_URL مؤقّتاً لفحص التحليل؛
// لو قرأ التنظيف الرابط الحيّ لاتّصل بقاعدة وهمية (Access denied/SSL). الرابط الملتقَط ثابت وصحيح.
const TEST_DB_URL = process.env.DATABASE_URL;

let cachedTables: string[] | null = null;

async function discoverTables(conn: mysql.Connection): Promise<string[]> {
  if (cachedTables) return cachedTables;
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  );
  const tables = rows.map((r) => r.name as string).filter((n) => !SKIP.has(n));
  // فشل-سريع: قاعدة اختبار بصفر جداول ⇒ مخطّط غير مُهيَّأ (نسي pnpm db:push) — لا نمضي صامتاً.
  if (!tables.length) {
    throw new Error("__setup__: zero tables discovered — DATABASE() empty or schema not pushed; aborting to avoid silent isolation failure");
  }
  cachedTables = tables;
  return tables;
}

afterEach(async () => {
  if (!TEST_DB_URL) return;
  // اتصال مُكرَّس طازج بالرابط الملتقَط — مُستقلّ عن تجمّع Drizzle (تُغلقه الاختبارات) وعن أيّ
  // تبديل لـprocess.env.DATABASE_URL داخل اختبار.
  const conn = await mysql.createConnection(TEST_DB_URL);
  try {
    const tables = await discoverTables(conn);
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of tables) {
      // DELETE FROM (لا TRUNCATE) — DML تَحترم FK_CHECKS=0. فشلٌ صريح (لا ابتلاع) لئلّا يَتراكم بصمت.
      try {
        await conn.query(`DELETE FROM \`${t}\``);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`__setup__ cleanup: DELETE FROM ${t} failed: ${msg}`);
      }
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await conn.end();
  }
  // أعد ضبط تجمّع Drizzle: الحذف مع FK_CHECKS=0 يَزيد نسخة metadata للجداول ⇒ العبارات المُهيَّأة
  // المُخبَّأة على اتصالات التجمّع تَبيت ⇒ ER_TABLE_DEF_CHANGED متقطّع في reset/seed الملف التالي.
  // الإغلاق يُجبر getDb() التالي على تجمّع جديد بعبارات نظيفة (نفس نمط truncateTables) ⇒ عزل موثوق.
  await closeDb();
});
