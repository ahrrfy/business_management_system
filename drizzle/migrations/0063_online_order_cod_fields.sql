-- 0063: حقول متجر الجوال B2C (الدفع عند الاستلام) على جدول onlineOrders القائم (منذ 0000، غير مُستعمَل).
--
-- يُضيف: governorate (المحافظة — تُحدّد أجرة التوصيل shippingCost والتوجيه)،
--        latitude/longitude (إحداثيات لخريطة المندوب — شريحة ٥)،
--        clientRequestId + قيد UNIQUE (منع الطلب المكرّر عند النقر المزدوج — idempotency).
--
-- **idempotent** (يفحص INFORMATION_SCHEMA قبل كل تغيير) — آمن للتطبيق المتكرّر عبر
-- migrator الإنتاج و ci-apply-extra-migrations.mjs معاً (نمط 0062).

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onlineOrders' AND COLUMN_NAME = 'governorate');
SET @sql := IF(@exists = 0, 'ALTER TABLE `onlineOrders` ADD `governorate` varchar(40)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onlineOrders' AND COLUMN_NAME = 'latitude');
SET @sql := IF(@exists = 0, 'ALTER TABLE `onlineOrders` ADD `latitude` decimal(10,7)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onlineOrders' AND COLUMN_NAME = 'longitude');
SET @sql := IF(@exists = 0, 'ALTER TABLE `onlineOrders` ADD `longitude` decimal(10,7)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onlineOrders' AND COLUMN_NAME = 'clientRequestId');
SET @sql := IF(@exists = 0, 'ALTER TABLE `onlineOrders` ADD `clientRequestId` varchar(80)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- قيد التفرّد على clientRequestId (NULL متعدّد مسموح في MySQL ⇒ الطلبات بلا مفتاح لا تتصادم).
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onlineOrders' AND INDEX_NAME = 'uq_online_order_client_req');
SET @sql := IF(@exists = 0,
  'CREATE UNIQUE INDEX `uq_online_order_client_req` ON `onlineOrders` (`clientRequestId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
