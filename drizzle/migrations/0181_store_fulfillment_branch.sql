-- فرع تنفيذ المتجر الصريح: يمنع اختلاف العام/لوحة الإدارة/الطلب بسبب fallback صامت إلى MAIN أو 1.
-- الهجرة لا تنقل مخزوناً ولا تعدّل طلباً قديماً؛ تضيف مرجع الإعداد فقط وتملؤه بفرع نشط.

SET @has_fulfillment_branch := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'storeSettings'
    AND COLUMN_NAME = 'fulfillmentBranchId'
);
SET @ddl := IF(
  @has_fulfillment_branch = 0,
  'ALTER TABLE `storeSettings` ADD COLUMN `fulfillmentBranchId` BIGINT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_fulfillment_index := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'storeSettings'
    AND INDEX_NAME = 'idx_store_settings_fulfillment_branch'
);
SET @ddl := IF(
  @has_fulfillment_index = 0,
  'ALTER TABLE `storeSettings` ADD INDEX `idx_store_settings_fulfillment_branch` (`fulfillmentBranchId`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_fulfillment_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'storeSettings'
    AND CONSTRAINT_NAME = 'fk_store_fulfillment_branch'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @has_fulfillment_fk = 0,
  'ALTER TABLE `storeSettings` ADD CONSTRAINT `fk_store_fulfillment_branch` FOREIGN KEY (`fulfillmentBranchId`) REFERENCES `branches` (`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @store_branch_id := (
  SELECT `id` FROM `branches`
  WHERE `code` = 'MAIN' AND `isActive` = 1
  ORDER BY `id`
  LIMIT 1
);
SET @store_branch_id := COALESCE(
  @store_branch_id,
  (SELECT `id` FROM `branches` WHERE `isActive` = 1 ORDER BY `id` LIMIT 1)
);

INSERT INTO `storeSettings` (`id`, `isOpen`, `fulfillmentBranchId`, `updatedAt`)
SELECT 1, IF(@store_branch_id IS NULL, 0, 1), @store_branch_id, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM `storeSettings` WHERE `id` = 1);

UPDATE `storeSettings`
SET
  `fulfillmentBranchId` = COALESCE(`fulfillmentBranchId`, @store_branch_id),
  `isOpen` = IF(@store_branch_id IS NULL AND `fulfillmentBranchId` IS NULL, 0, `isOpen`)
WHERE `id` = 1;
