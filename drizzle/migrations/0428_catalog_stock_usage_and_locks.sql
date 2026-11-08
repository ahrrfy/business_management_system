-- CATALOG-SURGICAL-20261107: additive stockUsage classification on owned stocked products + singleton catalog barcode write lock row.
-- Legacy products keep stockUsage = NULL and follow their existing behavior without backfill.
CREATE TABLE IF NOT EXISTS `catalogBarcodeWriteLock` (
	`id` tinyint NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `catalogBarcodeWriteLock_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_catalog_barcode_write_lock_singleton` CHECK(`catalogBarcodeWriteLock`.`id` = 1)
);
--> statement-breakpoint
INSERT IGNORE INTO `catalogBarcodeWriteLock` (`id`) VALUES (1);
--> statement-breakpoint
SET @catalog_0428_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'stockUsage'),
  'SELECT 1',
  'ALTER TABLE `products` ADD COLUMN `stockUsage` enum(''SALE_ONLY'',''MATERIAL_ONLY'',''SALE_AND_MATERIAL'',''OPERATING_SUPPLY'') NULL'
);
PREPARE catalog_0428_stmt FROM @catalog_0428_ddl;
EXECUTE catalog_0428_stmt;
DEALLOCATE PREPARE catalog_0428_stmt;
--> statement-breakpoint
SET @catalog_0428_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND INDEX_NAME = 'idx_product_stock_usage'),
  'SELECT 1',
  'CREATE INDEX `idx_product_stock_usage` ON `products` (`stockUsage`)'
);
PREPARE catalog_0428_stmt FROM @catalog_0428_ddl;
EXECUTE catalog_0428_stmt;
DEALLOCATE PREPARE catalog_0428_stmt;
--> statement-breakpoint
SET @catalog_0428_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND CONSTRAINT_NAME = 'chk_product_stock_usage_owned_stocked_only'),
  'SELECT 1',
  'ALTER TABLE `products` ADD CONSTRAINT `chk_product_stock_usage_owned_stocked_only` CHECK (`products`.`stockUsage` IS NULL OR (`products`.`isService` = 0 AND `products`.`isBundle` = 0 AND `products`.`isConsignment` = 0))'
);
PREPARE catalog_0428_stmt FROM @catalog_0428_ddl;
EXECUTE catalog_0428_stmt;
DEALLOCATE PREPARE catalog_0428_stmt;
