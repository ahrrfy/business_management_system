-- Daily physical treasury count and staged drawer-to-treasury custody acceptance.
SET NAMES utf8mb4;
--> statement-breakpoint
CREATE TABLE `cashCustodyCounts` (
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
CREATE INDEX `idx_cash_custody_receipt_status`
  ON `cashCustodyCounts` (`treasuryReceiptId`,`cashCustodyCountStatus`);
--> statement-breakpoint
CREATE TABLE `cashDailyReconciliations` (
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
CREATE INDEX `idx_cash_daily_status_date`
  ON `cashDailyReconciliations` (`cashDailyReconciliationStatus`,`businessDate`);
