-- 0375_service_quotation_and_advanced_sale_routing: designation columns for quotation and advanced sale visibility
--
-- توجيه الخدمة لعروض الأسعار والفواتير المبيعات المتقدّمة:
-- 1- showInQuotations: إمكانية توجيه الخدمة لعروض الأسعار
-- 2- showInAdvancedSales: إمكانية توجيه الخدمة لفواتير المبيعات المتقدّمة

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'products'
    AND COLUMN_NAME = 'showInQuotations'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE `products` ADD COLUMN `showInQuotations` BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col2_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'products'
    AND COLUMN_NAME = 'showInAdvancedSales'
);

SET @ddl2 := IF(
  @col2_exists = 0,
  'ALTER TABLE `products` ADD COLUMN `showInAdvancedSales` BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1'
);

PREPARE stmt FROM @ddl2;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- التعبئة الخلفيّة: خدمات الطباعة الحالية تُفعَّل فيها showInAdvancedSales لصون التوافق مع سلوك الفاتورة المتقدّمة السابق
UPDATE `products`
SET `showInAdvancedSales` = TRUE
WHERE `showInAdvancedSales` = FALSE
  AND `productType` = 'PRINT_SERVICE';
