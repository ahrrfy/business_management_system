-- 0067: جهة التوصيل المُسنَدة لطلب المتجر (deliveryPartyId) — للإرسال وشاشة المندوب. idempotent.

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onlineOrders' AND COLUMN_NAME = 'deliveryPartyId');
SET @sql := IF(@exists = 0, 'ALTER TABLE `onlineOrders` ADD `deliveryPartyId` bigint', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onlineOrders' AND INDEX_NAME = 'idx_order_delivery_party');
SET @sql := IF(@exists = 0, 'CREATE INDEX `idx_order_delivery_party` ON `onlineOrders` (`deliveryPartyId`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onlineOrders' AND CONSTRAINT_NAME = 'fk_online_order_delivery_party');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `onlineOrders` ADD CONSTRAINT `fk_online_order_delivery_party` FOREIGN KEY (`deliveryPartyId`) REFERENCES `deliveryParties`(`id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
