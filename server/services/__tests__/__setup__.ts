/**
 * يُشغَّل قبل **كل اختبار** (setupFiles في vitest.config.ts).
 * يُفرّغ كل الجداول قبل كل اختبار لمنع تلوّث الحالة بين الاختبارات داخل الملف
 * وبَين ملفات الاختبار.
 *
 * **القائمة ذاتية الصيانة:** نقرأ كل الجداول من information_schema لقاعدة الاختبار
 * بدل قائمة ثابتة، حتى لا تتقادم مع نمو المخطط (جداول الاختبار الأحدث —
 * stocktake، production، HR، الأصول، السندات — كانت ناقصة ⇒ سبّبت ٢٢ فشل
 * عزل في CI رغم سلامة منطق المنتج — تدقيق ١٤/٦/٢٦). الاستثناءات: جداول
 * الهجرة نفسها (__drizzle_migrations) — لا نمسّ بياناتها.
 *
 * **DELETE بَدل TRUNCATE + beforeEach بَدل beforeAll (٢٠٢٦/٦/١٨):**
 * - MySQL 8 يَرفض TRUNCATE على parent table لها FK من child constraint
 *   (مَوثَّق رَسمياً) حتى مع SET FOREIGN_KEY_CHECKS=0 لأن TRUNCATE من DDL لا DML
 *   ⇒ كانت اختبارات voucher/financialHardening2/production تَفشل عَشوائياً.
 * - DELETE FROM من DML ⇒ يَحترم FK_CHECKS=0 ⇒ يَحذف بلا فَحص FK مُهما كانت الـFKs.
 * - beforeEach بَدل beforeAll: كل اختبار يَبدأ بقاعدة عَذراء ⇒ لا تَراكم بَين اختبارات
 *   الملف الواحد، ولا تَلوّث من ملفات سابقة. تَكلفة الأَداء مَقبولة (~100ms لكل اختبار
 *   على ~50 جَدول فارغ) مُقابِل الـ٠ flakiness.
 * - الـcache: نَكتشف الجَداول مَرّة واحدة (cached) لتَوفير ٤ms على كل beforeEach.
 */
import { sql } from "drizzle-orm";
import { afterEach } from "vitest";
import { getDb } from "../../db";

const SKIP = new Set(["__drizzle_migrations"]);

let cachedTables: string[] | null = null;

async function discoverTables(db: NonNullable<ReturnType<typeof getDb>>): Promise<string[]> {
  if (cachedTables) return cachedTables;
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
  cachedTables = tables;
  return tables;
}

/**
 * afterEach (بَدل beforeEach): نَنظّف بَعد كل اختبار ⇒ التالي يَجد قاعدة فارغة ⇒ TRUNCATE
 * في beforeEach المَحلّية للملفات يَعمل على جَداول فارغة (FK constraint لا يُهمّ على فارغ).
 *
 * لِمَ ليس beforeEach: vitest يُسجِّل hooks بترتيب الاستيراد. setupFiles' beforeEach يُمكن أن
 * يَعمل بَعد test file's beforeEach (بَعد seedBase) فيَمسح الـseed ⇒ كانت backbone تَفشل.
 * afterEach يَتجنّب التَنازع تماماً.
 */
afterEach(async () => {
  const db = getDb();
  if (!db) return;
  const tables = await discoverTables(db);
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of tables) {
    // DELETE FROM (لا TRUNCATE) — DML تَحترم FK_CHECKS=0 على نَقيض TRUNCATE/DROP.
    await db.execute(sql.raw(`DELETE FROM \`${t}\``)).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`__setup__: DELETE FROM ${t} failed: ${msg}`);
    });
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
});
