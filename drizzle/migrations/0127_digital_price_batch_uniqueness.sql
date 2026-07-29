-- 0127 — البطاقات الرقمية ش٤: تفرّد دُفعات الأسعار بقيدٍ في القاعدة لا بفحصٍ تطبيقيّ.
-- ===============================================================
-- عمودان مولَّدان STORED يحملان NULL خارج الحالة المعنيّة، وفهرس MySQL الفريد يسمح
-- بتكرار NULL ⇒ ينحصر القيد على الصفوف المعنيّة وحدها:
--   • uq_dpbatch_draft     : مسودّة واحدة على الأكثر لكل (فرع × مزوّد × تاريخ عمل).
--   • uq_dpbatch_published : دُفعة منشورة واحدة سارية على الأكثر لكل (فرع × مزوّد).
--
-- الأثر السلوكيّ المقصود من الثاني: النشر **مضطرٌّ** لتسويد الدُفعة السابقة قبل ختم
-- الجديدة، وإلا رفضته القاعدة — فيستحيل وجود سعرين ساريين لنفس البطاقة في نفس الفرع.
-- فحصٌ تطبيقيّ وحده كان يترك سباق TOCTOU (نفس صنف العلّة التي ضربت توفير الشركات).
--
-- نمط idempotent (نمط 0035/0039): drizzle-kit لا يُمثّل GENERATED columns ⇒ يُطبَّق هذا
-- الملف عبر ci-apply-extra-migrations بعد db:push، وقد يُعاد تطبيقه فيجب أن يكون آمناً.
-- لكل عمود: (١) لو موجود كعادي (db:push كتبه varchar) نحذفه، (٢) لو غائب ننشئه مولَّداً،
-- (٣) لو الفهرس الفريد غائب ننشئه.

-- ══════════════ draftKey ══════════════

SET @gen = (
  SELECT IFNULL(GENERATION_EXPRESSION, '') != ''
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalPriceBatches' AND COLUMN_NAME = 'draftKey'
);
SET @gen = IFNULL(@gen, 0);
SET @sql = IF(@gen = 0 AND (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalPriceBatches' AND COLUMN_NAME = 'draftKey'
) = 1,
  'ALTER TABLE digitalPriceBatches DROP COLUMN draftKey',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalPriceBatches' AND COLUMN_NAME = 'draftKey'
);
SET @sql = IF(@col_exists = 0,
  CONCAT(
    'ALTER TABLE digitalPriceBatches ADD COLUMN draftKey VARCHAR(80) ',
    'GENERATED ALWAYS AS (CASE WHEN `status` = ''DRAFT'' THEN ',
    'CONCAT(`branchId`, '':'', `providerId`, '':'', `businessDate`) END) STORED'
  ),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalPriceBatches' AND INDEX_NAME = 'uq_dpbatch_draft'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX uq_dpbatch_draft ON digitalPriceBatches (draftKey)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ══════════════ publishedKey ══════════════

SET @gen = (
  SELECT IFNULL(GENERATION_EXPRESSION, '') != ''
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalPriceBatches' AND COLUMN_NAME = 'publishedKey'
);
SET @gen = IFNULL(@gen, 0);
SET @sql = IF(@gen = 0 AND (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalPriceBatches' AND COLUMN_NAME = 'publishedKey'
) = 1,
  'ALTER TABLE digitalPriceBatches DROP COLUMN publishedKey',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalPriceBatches' AND COLUMN_NAME = 'publishedKey'
);
SET @sql = IF(@col_exists = 0,
  CONCAT(
    'ALTER TABLE digitalPriceBatches ADD COLUMN publishedKey VARCHAR(80) ',
    'GENERATED ALWAYS AS (CASE WHEN `status` = ''PUBLISHED'' THEN ',
    'CONCAT(`branchId`, '':'', `providerId`) END) STORED'
  ),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalPriceBatches' AND INDEX_NAME = 'uq_dpbatch_published'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX uq_dpbatch_published ON digitalPriceBatches (publishedKey)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
