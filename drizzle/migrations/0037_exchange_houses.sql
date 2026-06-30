-- 0037 (٣٠/٦/٢٦): وحدة «الصيرفة» (exchange-house) — جدولان جديدان + توسعة دفتر القيود.
-- يدوية (لا db:generate: snapshot مجمَّد عند 0034 ⇒ سيُعيد إصدار searchNorm من 0035 — تجويهر).
-- أسماء أعمدة enum = أوّل وسيط mysqlEnum (DB لا JS): exchangeTxnType/Currency/Status, entryType.
-- كل عبارة مفصولة بفاصل عبارات drizzle (mysql2 multipleStatements:false في db:migrate:apply).

CREATE TABLE IF NOT EXISTS `exchangeHouses` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`phone` varchar(20),
	`phone2` varchar(20),
	`balanceIqd` decimal(15,2) NOT NULL DEFAULT '0',
	`balanceUsd` decimal(15,2) NOT NULL DEFAULT '0',
	`usdCostRate` decimal(15,4) NOT NULL DEFAULT '0',
	`legacyCode` varchar(40),
	`notes` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `exchangeHouses_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_exchange_legacy` UNIQUE(`legacyCode`),
	INDEX `idx_exchange_name` (`name`),
	INDEX `idx_exchange_active` (`isActive`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `exchangeTransactions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`txnNumber` varchar(50) NOT NULL,
	`exchangeHouseId` bigint NOT NULL,
	`branchId` bigint,
	`exchangeTxnType` enum('DEPOSIT','WITHDRAW','FX_BUY','SETTLE','OPENING') NOT NULL,
	`exchangeTxnCurrency` enum('IQD','USD') NOT NULL DEFAULT 'IQD',
	`iqdAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`usdAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`exchangeRate` decimal(15,4) NOT NULL DEFAULT '0',
	`commission` decimal(15,2) NOT NULL DEFAULT '0',
	`commissionIqd` decimal(15,2) NOT NULL DEFAULT '0',
	`fxDiff` decimal(15,2) NOT NULL DEFAULT '0',
	`supplierId` bigint,
	`balanceIqdAfter` decimal(15,2) NOT NULL DEFAULT '0',
	`balanceUsdAfter` decimal(15,2) NOT NULL DEFAULT '0',
	`receiptId` bigint,
	`exchangeTxnStatus` enum('ACTIVE','REVERSED') NOT NULL DEFAULT 'ACTIVE',
	`notes` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `exchangeTransactions_id` PRIMARY KEY(`id`),
	CONSTRAINT `exchangeTransactions_txnNumber_unique` UNIQUE(`txnNumber`),
	INDEX `idx_exchange_txn_number` (`txnNumber`),
	INDEX `idx_exchange_txn_house` (`exchangeHouseId`,`createdAt`),
	INDEX `idx_exchange_txn_supplier` (`supplierId`),
	INDEX `idx_exchange_txn_type` (`exchangeTxnType`),
	CONSTRAINT `fk_extxn_house` FOREIGN KEY (`exchangeHouseId`) REFERENCES `exchangeHouses`(`id`),
	CONSTRAINT `fk_extxn_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
	CONSTRAINT `fk_extxn_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`),
	CONSTRAINT `fk_extxn_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`),
	CONSTRAINT `fk_extxn_user` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND COLUMN_NAME = 'exchangeHouseId');
--> statement-breakpoint
SET @s := IF(@col = 0, 'ALTER TABLE `accountingEntries` ADD COLUMN `exchangeHouseId` bigint', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
ALTER TABLE `accountingEntries` MODIFY COLUMN `entryType` enum('SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING','INTERNAL_USE','WASTAGE','CASH_HANDOVER','CASH_TRANSFER_OUT','CASH_TRANSFER_IN','DELIVERY_DISPATCH','DELIVERY_REMIT','DELIVERY_FEE','DELIVERY_WRITEOFF','EXCHANGE_DEPOSIT','EXCHANGE_WITHDRAW','EXCHANGE_FX_BUY','EXCHANGE_SETTLE','EXCHANGE_FEE','EXCHANGE_FX_DIFF') NOT NULL;
--> statement-breakpoint
SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND INDEX_NAME = 'idx_entry_exchange');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_entry_exchange` ON `accountingEntries` (`exchangeHouseId`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @y := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accountingEntries' AND INDEX_NAME = 'idx_entry_exchange_date');
--> statement-breakpoint
SET @s := IF(@y = 0, 'CREATE INDEX `idx_entry_exchange_date` ON `accountingEntries` (`exchangeHouseId`, `entryDate`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
