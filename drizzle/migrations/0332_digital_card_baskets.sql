-- 0332: provider baskets and durable mixed checkout. Expand-compatible, no historical rewrites.
-- Preserve full 255-character catalog names plus card value/type/duration on invoices.
SET @name_length = (SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoiceItems' AND COLUMN_NAME = 'itemNameSnapshot');
SET @sql = IF(@name_length < 512, 'ALTER TABLE `invoiceItems` MODIFY COLUMN `itemNameSnapshot` VARCHAR(512) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntents' AND COLUMN_NAME = 'checkoutSnapshot');
SET @sql = IF(@exists = 0, 'ALTER TABLE `digitalSaleIntents` ADD COLUMN `checkoutSnapshot` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND COLUMN_NAME = 'providerBasketKey');
SET @sql = IF(@exists = 0, 'ALTER TABLE `digitalSaleIntentItems` ADD COLUMN `providerBasketKey` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND COLUMN_NAME = 'referenceOwnerItemId');
SET @sql = IF(@exists = 0, 'ALTER TABLE `digitalSaleIntentItems` ADD COLUMN `referenceOwnerItemId` BIGINT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND INDEX_NAME = 'uq_dsii_basket_owner_target');
SET @sql = IF(@exists = 0, 'CREATE UNIQUE INDEX `uq_dsii_basket_owner_target` ON `digitalSaleIntentItems` (`intentId`, `providerId`, `providerBasketKey`, `id`)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND CONSTRAINT_NAME = 'fk_dsii_basket_owner');
SET @sql = IF(@exists = 0, 'ALTER TABLE `digitalSaleIntentItems` ADD CONSTRAINT `fk_dsii_basket_owner` FOREIGN KEY (`intentId`, `providerId`, `providerBasketKey`, `referenceOwnerItemId`) REFERENCES `digitalSaleIntentItems` (`intentId`, `providerId`, `providerBasketKey`, `id`)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND CONSTRAINT_NAME = 'chk_dsii_basket_member_key');
SET @sql = IF(@exists = 0, 'ALTER TABLE `digitalSaleIntentItems` ADD CONSTRAINT `chk_dsii_basket_member_key` CHECK (`referenceOwnerItemId` IS NULL OR (`providerBasketKey` IS NOT NULL AND CHAR_LENGTH(TRIM(`providerBasketKey`)) > 0))', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- Keep the original unique index: only the basket owner claims the external reference.
-- Existing rows and older application writers remain owners (NULL) and stay protected.
SET @basket_expression = (SELECT LOWER(IFNULL(GENERATION_EXPRESSION, '')) LIKE '%referenceowneritemid%' FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntentItems' AND COLUMN_NAME = 'refKey');
SET @sql = IF(IFNULL(@basket_expression, 0) = 0,
  'ALTER TABLE `digitalSaleIntentItems` MODIFY COLUMN `refKey` VARCHAR(160) GENERATED ALWAYS AS (CASE WHEN `referenceOwnerItemId` IS NULL AND `providerReference` IS NOT NULL AND `providerReference` <> '''' THEN CONCAT(`providerId`, '':'', `providerReference`) END) STORED',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
