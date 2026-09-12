-- لقطة سعر الكتالوج وقت إصدار عرض السعر. تبقى NULL للعروض التاريخية كي تستمر
-- قاعدة إعادة التحقق القديمة المحافظة إلى أن يعاد إصدارها.
SET @needs_catalog_unit_price := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'quotationItems' AND column_name = 'catalogUnitPrice'
);
SET @sql := IF(@needs_catalog_unit_price,
  "ALTER TABLE `quotationItems` ADD COLUMN `catalogUnitPrice` DECIMAL(15,2) NULL AFTER `unitPrice`",
  "SELECT 'quotationItems.catalogUnitPrice exists' AS msg");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
