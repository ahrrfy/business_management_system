-- product-content-governance: freeze the invoice display name at sale time.
-- Existing rows remain NULL and continue to use the legacy product name in old readers.
SET @c1 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoiceItems' AND COLUMN_NAME = 'itemNameSnapshot');
SET @q1 := IF(@c1 = 0,
  'ALTER TABLE `invoiceItems` ADD `itemNameSnapshot` varchar(255) NULL AFTER `isGift`',
  'SELECT 1');
PREPARE s1 FROM @q1; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @i1 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoiceItems' AND INDEX_NAME = 'idx_item_name_snapshot');
SET @q2 := IF(@i1 = 0,
  'ALTER TABLE `invoiceItems` ADD INDEX `idx_item_name_snapshot` (`itemNameSnapshot`)',
  'SELECT 1');
PREPARE s2 FROM @q2; EXECUTE s2; DEALLOCATE PREPARE s2;
