-- المرحلة ٦ (١٩/٦/٢٦): ٣ جداول جديدة لمعالجة جدول المخاطر النهائي.
-- ١. financialPeriods: قفل فترات تاريخية ضدّ التعديل الصامت.
-- ٢. creditApprovals: ربط creditApproved بـ(customer, maxAmount, expiresAt).
-- ٣. yearEndSnapshots: رولوفر Retained Earnings + أرشفة إقفال سنوي.

-- نمط idempotent: كل عملية تتحقّق من INFORMATION_SCHEMA قبل التطبيق، ٥ chunks بـSET/SET/PREPARE/EXECUTE/DEALLOCATE.

-- ============== ١. financialPeriods ==============
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'financialPeriods');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE TABLE `financialPeriods` (
  `id` bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `cutoffDate` date NOT NULL,
  `periodStatus` enum(''LOCKED'',''ARCHIVED'') NOT NULL DEFAULT ''LOCKED'',
  `notes` varchar(255),
  `lockedBy` int NOT NULL,
  `lockedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_period_lockedBy` FOREIGN KEY (`lockedBy`) REFERENCES `users`(`id`)
)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'financialPeriods' AND INDEX_NAME = 'idx_period_cutoff');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_period_cutoff` ON `financialPeriods` (`cutoffDate`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'financialPeriods' AND INDEX_NAME = 'idx_period_status');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_period_status` ON `financialPeriods` (`periodStatus`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ============== ٢. creditApprovals ==============
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'creditApprovals');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE TABLE `creditApprovals` (
  `id` bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `customerId` bigint NOT NULL,
  `maxAmount` decimal(15,2) NOT NULL,
  `approvedBy` int NOT NULL,
  `approvedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expiresAt` timestamp NOT NULL,
  `consumedAt` timestamp NULL,
  `consumedByInvoiceId` bigint NULL,
  `notes` varchar(255),
  CONSTRAINT `fk_capp_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`),
  CONSTRAINT `fk_capp_approvedBy` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`),
  CONSTRAINT `fk_capp_invoice` FOREIGN KEY (`consumedByInvoiceId`) REFERENCES `invoices`(`id`)
)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'creditApprovals' AND INDEX_NAME = 'idx_capp_customer');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_capp_customer` ON `creditApprovals` (`customerId`, `expiresAt`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ============== ٣. yearEndSnapshots ==============
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'yearEndSnapshots');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE TABLE `yearEndSnapshots` (
  `id` bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `year` int NOT NULL,
  `branchId` bigint NULL,
  `closedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `closedBy` int NOT NULL,
  `totalRevenue` decimal(15,2) NOT NULL,
  `totalCogs` decimal(15,2) NOT NULL,
  `totalExpenses` decimal(15,2) NOT NULL,
  `netProfit` decimal(15,2) NOT NULL,
  `retainedEarningsEntryId` bigint NULL,
  `snapshotData` text,
  CONSTRAINT `fk_yes_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `fk_yes_closedBy` FOREIGN KEY (`closedBy`) REFERENCES `users`(`id`),
  CONSTRAINT `fk_yes_entry` FOREIGN KEY (`retainedEarningsEntryId`) REFERENCES `accountingEntries`(`id`),
  CONSTRAINT `uq_year_branch` UNIQUE (`year`, `branchId`)
)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
