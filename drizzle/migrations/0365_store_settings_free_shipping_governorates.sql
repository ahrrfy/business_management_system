-- 0365_store_settings_free_shipping_governorates.sql
-- إضافة عتبة التوصيل المجاني لكافة المحافظات بشكل مستقل وآمن

SET @exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeSettings' AND COLUMN_NAME = 'freeShippingThresholdGovernorates');
SET @sql := IF(@exists = 0, 'ALTER TABLE `storeSettings` ADD `freeShippingThresholdGovernorates` decimal(15,2)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE `storeSettings`
SET `freeShippingThreshold` = '35000.00',
    `freeShippingThresholdGovernorates` = '60000.00'
WHERE `id` = 1 AND `freeShippingThresholdGovernorates` IS NULL;

