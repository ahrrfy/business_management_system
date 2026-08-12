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

// يُشغَّل كـsetupFile قبل شيفرة كل ملف اختبار (وقبل التقاط ORIGINAL_KEY فيه): يضمن وجود مفتاح
// تشفير صالح دائماً على بيئات لا تضبطه عالمياً (CI). بلا هذا، ملفٌ يعيد المفتاح إلى undefined
// في afterAll يفسده (يصير السلسلة "undefined" — إسناد process.env.X = undefined في Node يُحوَّل
// نصّاً لا يُحذف) لكل ملف لاحق يحتاجه ولا يضبطه بنفسه (broadcastDispatch/waTemplates ⇒ فشل CI).
// `??=` يحترم قيمة CI/‎.env الصريحة إن وُجدت. قيمة اختبار حرفية منخفضة العشوائية عمداً (نمط
// BARCODE_SECRET أعلاه في vitest.config.ts) كي لا يعلّمها GitGuardian كسرٍّ حقيقيّ.
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// M9 (تدقيق ٣/٨): إلزام 2FA الخادميّ للمدير/المشرف يُحجب أي إجراءٍ عبر البوّابات لدورٍ مُلزَمٍ لم
// يُفعّل 2FA. بذور الاختبار تُنشئ admin/manager بلا 2FA (والتشفير مضبوط أعلاه ⇒ isCryptoReady=true)
// فتُحجب مئات الاختبارات عبر createCaller. نُعطّل الإنفاذ افتراضياً هنا (مفتاح الإيقاف نفسه)؛
// الاختبار المخصّص twoFactorEnforcement.test.ts يُفعّله لكلّ حالةٍ للتحقّق. `??=` يحترم قيمة CI الصريحة.
process.env.TWO_FACTOR_ENFORCEMENT ??= "off";

const SKIP = new Set(["__drizzle_migrations"]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Fail closed before the cleanup hook can open a connection. The hook deletes
 * every row from every application table, so a test-looking environment name
 * alone is not enough: the target must also be local and must not use MySQL's
 * production-default port unless the caller opted in explicitly.
 */
function assertSafeCleanupTarget(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("__setup__: refusing cleanup because DATABASE_URL is not a valid URL");
  }

  const host = parsed.hostname.toLowerCase();
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const port = parsed.port ? Number(parsed.port) : 3306;

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`__setup__: refusing cleanup on non-loopback database host ${host || "<empty>"}`);
  }
  if (!databaseName || !/test/i.test(databaseName)) {
    throw new Error(
      `__setup__: refusing cleanup because database name ${databaseName || "<empty>"} does not contain "test"`,
    );
  }
  if (port === 3306 && process.env.ALLOW_TEST_DB_PORT_3306 !== "1") {
    throw new Error(
      "__setup__: refusing cleanup on MySQL port 3306; set ALLOW_TEST_DB_PORT_3306=1 only for an explicitly isolated local test database",
    );
  }

  return rawUrl;
}

// نلتقط رابط قاعدة الاختبار **مرّةً عند التحميل** قبل أيّ اختبار: بعض الاختبارات
// (maintenanceService.currentDbName) تُبدّل process.env.DATABASE_URL مؤقّتاً لفحص التحليل؛
// لو قرأ التنظيف الرابط الحيّ لاتّصل بقاعدة وهمية (Access denied/SSL). الرابط الملتقَط ثابت وصحيح.
const TEST_DB_URL = assertSafeCleanupTarget(process.env.DATABASE_URL);

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
