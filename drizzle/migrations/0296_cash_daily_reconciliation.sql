-- Daily physical treasury count and staged drawer-to-treasury custody acceptance.
SET NAMES utf8mb4;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cashCustodyCounts` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `treasuryReceiptId` bigint NOT NULL,
  `clientRequestId` varchar(64) NOT NULL,
  `declaredAmount` decimal(15,2) NOT NULL,
  `countedAmount` decimal(15,2) NOT NULL,
  `variance` decimal(15,2) NOT NULL,
  `countedBreakdown` json NULL,
  `cashCustodyCountStatus` enum('MATCHED','VARIANCE_OPEN') NOT NULL,
  `countedByUserId` int NOT NULL,
  `countedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `cashCustodyCounts_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_cash_custody_count_request` UNIQUE(`treasuryReceiptId`,`clientRequestId`),
  CONSTRAINT `fk_cash_custody_receipt` FOREIGN KEY (`treasuryReceiptId`) REFERENCES `receipts`(`id`),
  CONSTRAINT `fk_cash_custody_user` FOREIGN KEY (`countedByUserId`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
SET @has_cash_custody_status_idx := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashCustodyCounts' AND index_name = 'idx_cash_custody_receipt_status');
SET @sql := IF(@has_cash_custody_status_idx = 0, 'CREATE INDEX `idx_cash_custody_receipt_status` ON `cashCustodyCounts` (`treasuryReceiptId`,`cashCustodyCountStatus`)', 'SELECT ''idx_cash_custody_receipt_status exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_cash_custody_receipt_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashCustodyCounts' AND column_name = 'treasuryReceiptId' AND referenced_table_name = 'receipts');
SET @sql := IF(@has_cash_custody_receipt_fk = 0, 'ALTER TABLE `cashCustodyCounts` ADD CONSTRAINT `fk_cash_custody_receipt` FOREIGN KEY (`treasuryReceiptId`) REFERENCES `receipts`(`id`)', 'SELECT ''cash custody receipt FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cash_custody_user_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashCustodyCounts' AND column_name = 'countedByUserId' AND referenced_table_name = 'users');
SET @sql := IF(@has_cash_custody_user_fk = 0, 'ALTER TABLE `cashCustodyCounts` ADD CONSTRAINT `fk_cash_custody_user` FOREIGN KEY (`countedByUserId`) REFERENCES `users`(`id`)', 'SELECT ''cash custody user FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cashDailyReconciliations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `branchId` bigint NOT NULL,
  `businessDate` date NOT NULL,
  `expectedTreasuryCash` decimal(15,2) NOT NULL,
  `countedTreasuryCash` decimal(15,2) NOT NULL,
  `variance` decimal(15,2) NOT NULL,
  `countedBreakdown` json NULL,
  `cashDailyReconciliationStatus` enum('MATCHED','VARIANCE_OPEN','CLOSED','REOPENED') NOT NULL,
  `notes` varchar(500) NULL,
  `lastClientRequestId` varchar(64) NOT NULL,
  `closeClientRequestId` varchar(64) NULL,
  `evidenceHash` varchar(64) NOT NULL,
  `shiftCount` int NOT NULL DEFAULT 0,
  `custodyCount` int NOT NULL DEFAULT 0,
  `version` int NOT NULL DEFAULT 1,
  `countedByUserId` int NOT NULL,
  `countedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `closedByUserId` int NULL,
  `closedAt` timestamp NULL,
  `reopenedByUserId` int NULL,
  `reopenedAt` timestamp NULL,
  `reopenReason` varchar(500) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `cashDailyReconciliations_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_cash_daily_branch_date` UNIQUE(`branchId`,`businessDate`),
  CONSTRAINT `uq_cash_daily_request` UNIQUE(`lastClientRequestId`),
  CONSTRAINT `uq_cash_daily_close_request` UNIQUE(`closeClientRequestId`),
  CONSTRAINT `fk_cash_daily_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `fk_cash_daily_counted_user` FOREIGN KEY (`countedByUserId`) REFERENCES `users`(`id`),
  CONSTRAINT `fk_cash_daily_closed_user` FOREIGN KEY (`closedByUserId`) REFERENCES `users`(`id`),
  CONSTRAINT `fk_cash_daily_reopened_user` FOREIGN KEY (`reopenedByUserId`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
SET @has_cash_daily_status_idx := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashDailyReconciliations' AND index_name = 'idx_cash_daily_status_date');
SET @sql := IF(@has_cash_daily_status_idx = 0, 'CREATE INDEX `idx_cash_daily_status_date` ON `cashDailyReconciliations` (`cashDailyReconciliationStatus`,`businessDate`)', 'SELECT ''idx_cash_daily_status_date exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_cash_daily_branch_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashDailyReconciliations' AND column_name = 'branchId' AND referenced_table_name = 'branches');
SET @sql := IF(@has_cash_daily_branch_fk = 0, 'ALTER TABLE `cashDailyReconciliations` ADD CONSTRAINT `fk_cash_daily_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`)', 'SELECT ''cash daily branch FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cash_daily_counted_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashDailyReconciliations' AND column_name = 'countedByUserId' AND referenced_table_name = 'users');
SET @sql := IF(@has_cash_daily_counted_fk = 0, 'ALTER TABLE `cashDailyReconciliations` ADD CONSTRAINT `fk_cash_daily_counted_user` FOREIGN KEY (`countedByUserId`) REFERENCES `users`(`id`)', 'SELECT ''cash daily counted-user FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cash_daily_closed_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashDailyReconciliations' AND column_name = 'closedByUserId' AND referenced_table_name = 'users');
SET @sql := IF(@has_cash_daily_closed_fk = 0, 'ALTER TABLE `cashDailyReconciliations` ADD CONSTRAINT `fk_cash_daily_closed_user` FOREIGN KEY (`closedByUserId`) REFERENCES `users`(`id`)', 'SELECT ''cash daily closed-user FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cash_daily_reopened_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashDailyReconciliations' AND column_name = 'reopenedByUserId' AND referenced_table_name = 'users');
SET @sql := IF(@has_cash_daily_reopened_fk = 0, 'ALTER TABLE `cashDailyReconciliations` ADD CONSTRAINT `fk_cash_daily_reopened_user` FOREIGN KEY (`reopenedByUserId`) REFERENCES `users`(`id`)', 'SELECT ''cash daily reopened-user FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- إن وُجد جدول من محاولة سابقة نتأكد من العقد الفعلي، لا نكتفي بأن CREATE IF NOT EXISTS صمت.
SET @cash_daily_contract :=
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('cashCustodyCounts','cashDailyReconciliations'))
  + (SELECT COUNT(DISTINCT CONCAT(table_name,'.',index_name)) FROM information_schema.statistics WHERE table_schema = DATABASE() AND ((table_name = 'cashCustodyCounts' AND index_name IN ('uq_cash_custody_count_request','idx_cash_custody_receipt_status')) OR (table_name = 'cashDailyReconciliations' AND index_name IN ('uq_cash_daily_branch_date','uq_cash_daily_request','uq_cash_daily_close_request','idx_cash_daily_status_date'))))
  + (SELECT COUNT(DISTINCT CONCAT(table_name,'.',constraint_name)) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND ((table_name = 'cashCustodyCounts' AND constraint_name IN ('fk_cash_custody_receipt','fk_cash_custody_user')) OR (table_name = 'cashDailyReconciliations' AND constraint_name IN ('fk_cash_daily_branch','fk_cash_daily_counted_user','fk_cash_daily_closed_user','fk_cash_daily_reopened_user'))) AND referenced_table_name IS NOT NULL);
SET @sql := IF(@cash_daily_contract = 14, 'SELECT ''0296 cash reconciliation contract verified'' AS msg', 'SELECT 1 FROM `__incomplete_0296_cash_reconciliation_contract__`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
