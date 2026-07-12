-- 0070: أجرة الشحن كإيراد على رأس الفاتورة (invoices.deliveryFee) — تُخزَّن صراحةً ليعكسها المرتجع
-- الكامل بدقّة فيبقى Σ(revenue)=Σ(profit)=0 (مراجعة عدائية ١٢/٧). مُضمَّنة في total، افتراضي 0. idempotent.

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'deliveryFee');
SET @sql := IF(@exists = 0, 'ALTER TABLE `invoices` ADD `deliveryFee` decimal(15,2) NOT NULL DEFAULT ''0''', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
