-- 0128 — البطاقات الرقمية ش٧: منع تكرار مرجع التنفيذ لدى المزوّد نفسه، بقيدٍ في القاعدة.
-- ===============================================================
-- «تكرار نفس المرجع للمزوّد نفسه ممنوع» (§٩.٢). الفحص التطبيقيّ وحده يترك سباق TOCTOU:
-- نقرتان متزامنتان على «نجح التنفيذ» بنفس رقم المرجع تمرّان معاً فيُسجَّل الكرت مرّتين.
--
-- `providerId` يُنزَّل على البند (denormalization مقصود) لأن القيد يحتاج المزوّد في نفس الصفّ،
-- وهو ثابتٌ لا يتغيّر بعد الإنشاء (مشتقٌّ من digitalOfferings.providerId لحظة الإعداد).
-- `refKey` مولَّد STORED يحمل NULL ما لم يوجد مرجع ⇒ فهرس MySQL الفريد يقبل تكرار NULL،
-- فينحصر القيد على البنود التي سُجِّل لها مرجعٌ فعليّ.
--
-- نمط idempotent (نمط 0035/0039/0126): يُطبَّق عبر ci-apply-extra-migrations بعد db:push.

-- ══════════════ providerId ══════════════

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND COLUMN_NAME = 'providerId'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE digitalSaleIntentItems ADD COLUMN providerId BIGINT NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND INDEX_NAME = 'idx_dsii_provider'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX idx_dsii_provider ON digitalSaleIntentItems (providerId)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ══════════════ refKey (مولَّد) ══════════════

SET @gen = (
  SELECT IFNULL(GENERATION_EXPRESSION, '') != ''
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND COLUMN_NAME = 'refKey'
);
SET @gen = IFNULL(@gen, 0);
SET @sql = IF(@gen = 0 AND (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND COLUMN_NAME = 'refKey'
) = 1,
  'ALTER TABLE digitalSaleIntentItems DROP COLUMN refKey',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND COLUMN_NAME = 'refKey'
);
SET @sql = IF(@col_exists = 0,
  CONCAT(
    'ALTER TABLE digitalSaleIntentItems ADD COLUMN refKey VARCHAR(160) ',
    'GENERATED ALWAYS AS (CASE WHEN `providerReference` IS NOT NULL AND `providerReference` <> '''' ',
    'THEN CONCAT(`providerId`, '':'', `providerReference`) END) STORED'
  ),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND INDEX_NAME = 'uq_dsii_provider_ref'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX uq_dsii_provider_ref ON digitalSaleIntentItems (refKey)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
