-- MySQL commits ALTER TABLE immediately. Keep these additions idempotent so a
-- deployment can safely resume when a later data-backfill statement fails.
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'taxRatePercent') = 0,
  'ALTER TABLE `invoices` ADD COLUMN `taxRatePercent` decimal(5,2) NOT NULL DEFAULT ''0.00'' AFTER `taxAmount`',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotations' AND COLUMN_NAME = 'taxRatePercent') = 0,
  'ALTER TABLE `quotations` ADD COLUMN `taxRatePercent` decimal(5,2) NOT NULL DEFAULT ''0.00'' AFTER `taxAmount`',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchaseOrders' AND COLUMN_NAME = 'taxRatePercent') = 0,
  'ALTER TABLE `purchaseOrders` ADD COLUMN `taxRatePercent` decimal(5,2) NOT NULL DEFAULT ''0.00'' AFTER `taxAmount`',
  'SELECT 1'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

UPDATE `invoices`
SET `taxRatePercent` = CASE
  WHEN `taxAmount` > 0 AND (`subtotal` - `discountAmount`) > 0
    THEN LEAST(100.00, ROUND((`taxAmount` / (`subtotal` - `discountAmount`)) * 100, 2))
  ELSE 0.00
END;

UPDATE `quotations`
SET `taxRatePercent` = CASE
  WHEN `taxAmount` > 0 AND (`subtotal` - `discountAmount`) > 0
    THEN LEAST(100.00, ROUND((`taxAmount` / (`subtotal` - `discountAmount`)) * 100, 2))
  ELSE 0.00
END;

UPDATE `purchaseOrders`
SET `taxRatePercent` = CASE
  WHEN `taxAmount` > 0 AND `subtotal` > 0
    THEN LEAST(100.00, ROUND((`taxAmount` / `subtotal`) * 100, 2))
  ELSE 0.00
END;

-- usdTotal التاريخي كان يحفظ صافي البضاعة فقط؛ بعد تثبيت النسبة يصبح إجمالي فاتورة
-- المورد بالدولار شاملاً الضريبة، مثل total الديناري (الشحن/الكمرك يبقيان ديناريين منفصلين).
UPDATE `purchaseOrders`
SET `usdTotal` = ROUND(`usdTotal` * (1 + (`taxRatePercent` / 100)), 2)
WHERE `poCurrency` = 'USD'
  AND `usdTotal` IS NOT NULL
  AND `taxRatePercent` > 0;
