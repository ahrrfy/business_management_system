-- Additive only. Existing variants remain NULL until guarded activation verifies
-- saved transfer evidence and complete projection parity. No business backfill here.
CREATE TABLE IF NOT EXISTS `inventoryProjectionState` (
  `id` tinyint NOT NULL,
  `readyVersion` int NOT NULL DEFAULT 0,
  `activatedCommit` varchar(40),
  `activatedAt` timestamp NULL,
  CONSTRAINT `inventoryProjectionState_id` PRIMARY KEY (`id`),
  CONSTRAINT `chk_inventory_projection_singleton` CHECK (`id` = 1)
);
--> statement-breakpoint
SET @projection_0410_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productVariants' AND COLUMN_NAME = 'transitBaseBySourceBranch'),
  'SELECT 1',
  'ALTER TABLE `productVariants` ADD COLUMN `transitBaseBySourceBranch` json NULL'
);
--> statement-breakpoint
PREPARE projection_0410_stmt FROM @projection_0410_ddl;
--> statement-breakpoint
EXECUTE projection_0410_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE projection_0410_stmt;
--> statement-breakpoint
ALTER TABLE `productVariants` ALTER COLUMN `transitBaseBySourceBranch` SET DEFAULT (JSON_OBJECT());
--> statement-breakpoint
INSERT INTO `inventoryProjectionState` (`id`, `readyVersion`) VALUES (1, 0)
ON DUPLICATE KEY UPDATE `id` = `inventoryProjectionState`.`id`;
