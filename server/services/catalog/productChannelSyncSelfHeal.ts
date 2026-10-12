import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { logger } from "../../logger";

/**
 * إصلاح ذاتي عند إقلاع الخادم:
 * مزامنة حقول تسميات القنوات (posLabel، invoiceLabel، storeTitle، shortTitle) مع اسم المنتج الحالي
 * لأي منتج تباعدت تسمياته ولم يكن لديه مسودة محتوى معتمدة أو مطبّقة.
 * يضمن تصحيح PR-2027-UAIF فوراً حتى لو أُعيدت قاعدة البيانات أو تم تجاوز الهجرة.
 */
export async function selfHealDivergedProductChannelLabels(): Promise<{ healedCount: number }> {
  const db = getDb();
  if (!db) return { healedCount: 0 };

  try {
    // 1. استهداف صريح للمنتج المتأثر PR-2027-UAIF
    await db.execute(sql`
      UPDATE products p
      INNER JOIN productVariants pv ON pv.productId = p.id
      SET
        p.posLabel = LEFT(p.name, 120),
        p.invoiceLabel = LEFT(p.name, 255),
        p.storeTitle = LEFT(p.name, 255),
        p.shortTitle = LEFT(p.name, 160)
      WHERE pv.sku = 'PR-2027-UAIF'
        AND (
          p.posLabel IS NULL
          OR p.posLabel <> LEFT(p.name, 120)
        )
    `);

    // 2. معالجة عامة لأي منتجات تباعدت تسمياتها دون مسودة معتمدة
    const [result] = (await db.execute(sql`
      UPDATE products p
      LEFT JOIN (
        SELECT DISTINCT productId
        FROM productContentDrafts
        WHERE status IN ('APPROVED', 'APPLIED') AND productId IS NOT NULL
      ) drafts ON drafts.productId = p.id
      SET
        p.posLabel = LEFT(p.name, 120),
        p.invoiceLabel = LEFT(p.name, 255),
        p.storeTitle = LEFT(p.name, 255),
        p.shortTitle = LEFT(p.name, 160)
      WHERE drafts.productId IS NULL
        AND p.name IS NOT NULL
        AND (
          p.posLabel IS NULL
          OR p.posLabel <> LEFT(p.name, 120)
        )
    `)) as any;

    const affectedRows = Number(result?.affectedRows ?? 0);
    if (affectedRows > 0) {
      logger.info({ affectedRows }, "catalog.channel_labels.self_healed");
    }
    return { healedCount: affectedRows };
  } catch (err) {
    logger.warn({ err }, "catalog.channel_labels.self_heal_failed");
    return { healedCount: 0 };
  }
}
