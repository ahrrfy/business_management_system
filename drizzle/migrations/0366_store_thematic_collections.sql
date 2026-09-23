-- 0366_store_thematic_collections.sql
-- إضافة إعدادات التشكيلات التحريرية الذكية (thematicCollectionsConfig) إلى جدول إعدادات المتجر

SET @exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeSettings' AND COLUMN_NAME = 'thematicCollectionsConfig');
SET @sql := IF(@exists = 0, 'ALTER TABLE `storeSettings` ADD `thematicCollectionsConfig` text NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
