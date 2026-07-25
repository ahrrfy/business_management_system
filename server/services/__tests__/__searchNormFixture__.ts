import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../../db";

/**
 * قواعد الاختبار الدائمة قد تكون أُنشئت قديماً بتعبير GENERATED مشوّه الترميز.
 * نصلح fixture فقط؛ القاعدة الصحيحة (CI/الإنتاج) تمر بلا أي DDL.
 */
export async function ensureProductSearchNormFixture() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  const meta: any = await db.execute(sql`
    SELECT CASE
      WHEN LOCATE('أ', COALESCE(GENERATION_EXPRESSION, '')) > 0
       AND LOCATE('ة', COALESCE(GENERATION_EXPRESSION, '')) > 0
      THEN 1 ELSE 0
    END AS validExpression
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      AND COLUMN_NAME = 'searchNorm'
    LIMIT 1
  `);
  const column = Array.isArray(meta) ? meta[0]?.[0] : meta?.rows?.[0];
  if (Number(column?.validExpression) === 1) return;

  await db.execute(sql.raw(`
    ALTER TABLE products MODIFY COLUMN searchNorm VARCHAR(512)
    GENERATED ALWAYS AS (
      LOWER(
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
          COALESCE(name, ''),
          'أ', 'ا'), 'إ', 'ا'), 'آ', 'ا'), 'ٱ', 'ا'), 'ة', 'ه'),
          'ى', 'ي'), 'ؤ', 'و'), 'ئ', 'ي'), 'ـ', '')
      )
    ) STORED
  `));
  await closeDb();
}
