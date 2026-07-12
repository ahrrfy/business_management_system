-- 0069: سبب إلغاء طلب المتجر (cancelReason) — يملؤه المندوب عند «تعذّر التسليم» ليراه الموظّف. idempotent.

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onlineOrders' AND COLUMN_NAME = 'cancelReason');
SET @sql := IF(@exists = 0, 'ALTER TABLE `onlineOrders` ADD `cancelReason` varchar(500)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
