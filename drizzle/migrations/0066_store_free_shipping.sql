-- 0066: عتبة التوصيل المجاني (AOV) على إعدادات المتجر. idempotent (INFORMATION_SCHEMA guard).

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeSettings' AND COLUMN_NAME = 'freeShippingThreshold');
SET @sql := IF(@exists = 0, 'ALTER TABLE `storeSettings` ADD `freeShippingThreshold` decimal(15,2)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
