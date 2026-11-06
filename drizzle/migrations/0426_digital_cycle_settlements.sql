-- Immutable capture allocations and independently persisted refund evidence. No historical backfill.
CREATE TABLE IF NOT EXISTS `digitalIntentSettlements` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`intentId` bigint NOT NULL,
	`resolutionId` bigint NOT NULL,
	`customerId` bigint,
	`capturedAmount` decimal(15,2) NOT NULL,
	`saleAmount` decimal(15,2) NOT NULL,
	`refundAmount` decimal(15,2) NOT NULL,
	`refundMethod` enum('CASH','CARD') NOT NULL,
	`regularDisposition` enum('SELL','RELEASE') NOT NULL,
	`issuedItemIds` json NOT NULL,
	`collectionReceiptId` bigint,
	`refundPaymentId` bigint,
	`invoiceId` bigint,
	`settlementStatus` enum('REQUESTED','COMPLETED') NOT NULL,
	`createdBy` int NOT NULL,
	`approvedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `digitalIntentSettlements_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dsettlement_intent` UNIQUE(`intentId`),
	CONSTRAINT `uq_dsettlement_collection` UNIQUE(`collectionReceiptId`),
	CONSTRAINT `chk_dsettlement_sum` CHECK(`digitalIntentSettlements`.`capturedAmount` >= 0 AND `digitalIntentSettlements`.`saleAmount` >= 0 AND `digitalIntentSettlements`.`refundAmount` >= 0 AND `digitalIntentSettlements`.`capturedAmount` = `digitalIntentSettlements`.`saleAmount` + `digitalIntentSettlements`.`refundAmount`),
	CONSTRAINT `chk_dsettlement_complete` CHECK(`digitalIntentSettlements`.`settlementStatus` <> 'COMPLETED' OR (`digitalIntentSettlements`.`collectionReceiptId` IS NOT NULL AND `digitalIntentSettlements`.`approvedBy` IS NOT NULL AND `digitalIntentSettlements`.`completedAt` IS NOT NULL))
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `digitalRefundItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`refundId` bigint,
	`detailId` bigint NOT NULL,
	`refundOutcome` enum('REVERSAL','LOSS_REFUND') NOT NULL,
	`revenue` decimal(15,2) NOT NULL,
	`cost` decimal(15,2) NOT NULL,
	`occurredAt` timestamp,
	CONSTRAINT `digitalRefundItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_drefunditem_detail` UNIQUE(`detailId`)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `digitalRefundPayments` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`invoiceId` bigint,
	`intentId` bigint,
	`originalAttemptId` bigint,
	`operationKey` varchar(160) NOT NULL,
	`originalMethod` enum('CASH','CARD','CREDIT') NOT NULL,
	`refundMethod` enum('CASH','CARD') NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`normalizedReference` varchar(100),
	`refundStatus` enum('RESERVED','EVIDENCED','COMPLETED') NOT NULL,
	`detailIds` json NOT NULL,
	`reason` varchar(500) NOT NULL,
	`requestedBy` int NOT NULL,
	`reservationToken` varchar(64),
	`reservationExpiresAt` timestamp,
	`confirmedBy` int,
	`confirmedAt` timestamp,
	`receiptId` bigint,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `digitalRefundPayments_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_drefund_operation` UNIQUE(`operationKey`),
	CONSTRAINT `uq_drefund_reference` UNIQUE(`normalizedReference`),
	CONSTRAINT `uq_drefund_receipt` UNIQUE(`receiptId`),
	CONSTRAINT `chk_drefund_positive` CHECK(`digitalRefundPayments`.`amount` > 0),
	CONSTRAINT `chk_drefund_method` CHECK((`digitalRefundPayments`.`refundMethod` = 'CASH' AND `digitalRefundPayments`.`normalizedReference` IS NULL) OR (`digitalRefundPayments`.`originalMethod` = 'CARD' AND (`digitalRefundPayments`.`refundStatus` = 'RESERVED' OR (`digitalRefundPayments`.`normalizedReference` IS NOT NULL AND CHAR_LENGTH(`digitalRefundPayments`.`normalizedReference`) > 0)))),
	CONSTRAINT `chk_drefund_complete` CHECK((`digitalRefundPayments`.`refundStatus` = 'RESERVED' AND `digitalRefundPayments`.`refundMethod` = 'CARD' AND `digitalRefundPayments`.`reservationToken` IS NOT NULL AND `digitalRefundPayments`.`reservationExpiresAt` IS NOT NULL AND `digitalRefundPayments`.`normalizedReference` IS NULL AND `digitalRefundPayments`.`confirmedBy` IS NULL AND `digitalRefundPayments`.`confirmedAt` IS NULL AND `digitalRefundPayments`.`receiptId` IS NULL AND `digitalRefundPayments`.`completedAt` IS NULL) OR (`digitalRefundPayments`.`refundStatus` = 'EVIDENCED' AND `digitalRefundPayments`.`confirmedBy` IS NOT NULL AND `digitalRefundPayments`.`confirmedAt` IS NOT NULL AND `digitalRefundPayments`.`receiptId` IS NULL AND `digitalRefundPayments`.`completedAt` IS NULL) OR (`digitalRefundPayments`.`refundStatus` = 'COMPLETED' AND `digitalRefundPayments`.`confirmedBy` IS NOT NULL AND `digitalRefundPayments`.`confirmedAt` IS NOT NULL AND `digitalRefundPayments`.`receiptId` IS NOT NULL AND `digitalRefundPayments`.`completedAt` IS NOT NULL))
);

--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalIntentSettlements' AND CONSTRAINT_NAME='fk_dsettlement_intent'), 'SELECT 1', 'ALTER TABLE `digitalIntentSettlements` ADD CONSTRAINT `fk_dsettlement_intent` FOREIGN KEY (`intentId`) REFERENCES `digitalSaleIntents`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalIntentSettlements' AND CONSTRAINT_NAME='fk_dsettlement_resolution'), 'SELECT 1', 'ALTER TABLE `digitalIntentSettlements` ADD CONSTRAINT `fk_dsettlement_resolution` FOREIGN KEY (`resolutionId`) REFERENCES `digitalSaleReviewResolutions`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalIntentSettlements' AND CONSTRAINT_NAME='fk_dsettlement_customer'), 'SELECT 1', 'ALTER TABLE `digitalIntentSettlements` ADD CONSTRAINT `fk_dsettlement_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalIntentSettlements' AND CONSTRAINT_NAME='fk_dsettlement_collection'), 'SELECT 1', 'ALTER TABLE `digitalIntentSettlements` ADD CONSTRAINT `fk_dsettlement_collection` FOREIGN KEY (`collectionReceiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalIntentSettlements' AND CONSTRAINT_NAME='fk_dsettlement_refund'), 'SELECT 1', 'ALTER TABLE `digitalIntentSettlements` ADD CONSTRAINT `fk_dsettlement_refund` FOREIGN KEY (`refundPaymentId`) REFERENCES `digitalRefundPayments`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalIntentSettlements' AND CONSTRAINT_NAME='fk_dsettlement_invoice'), 'SELECT 1', 'ALTER TABLE `digitalIntentSettlements` ADD CONSTRAINT `fk_dsettlement_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalIntentSettlements' AND CONSTRAINT_NAME='fk_dsettlement_creator'), 'SELECT 1', 'ALTER TABLE `digitalIntentSettlements` ADD CONSTRAINT `fk_dsettlement_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalIntentSettlements' AND CONSTRAINT_NAME='fk_dsettlement_approver'), 'SELECT 1', 'ALTER TABLE `digitalIntentSettlements` ADD CONSTRAINT `fk_dsettlement_approver` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundItems' AND CONSTRAINT_NAME='fk_drefunditem_refund'), 'SELECT 1', 'ALTER TABLE `digitalRefundItems` ADD CONSTRAINT `fk_drefunditem_refund` FOREIGN KEY (`refundId`) REFERENCES `digitalRefundPayments`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundItems' AND CONSTRAINT_NAME='fk_drefunditem_detail'), 'SELECT 1', 'ALTER TABLE `digitalRefundItems` ADD CONSTRAINT `fk_drefunditem_detail` FOREIGN KEY (`detailId`) REFERENCES `digitalSaleDetails`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundPayments' AND CONSTRAINT_NAME='fk_drefund_branch'), 'SELECT 1', 'ALTER TABLE `digitalRefundPayments` ADD CONSTRAINT `fk_drefund_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundPayments' AND CONSTRAINT_NAME='fk_drefund_invoice'), 'SELECT 1', 'ALTER TABLE `digitalRefundPayments` ADD CONSTRAINT `fk_drefund_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundPayments' AND CONSTRAINT_NAME='fk_drefund_intent'), 'SELECT 1', 'ALTER TABLE `digitalRefundPayments` ADD CONSTRAINT `fk_drefund_intent` FOREIGN KEY (`intentId`) REFERENCES `digitalSaleIntents`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundPayments' AND CONSTRAINT_NAME='fk_drefund_attempt'), 'SELECT 1', 'ALTER TABLE `digitalRefundPayments` ADD CONSTRAINT `fk_drefund_attempt` FOREIGN KEY (`originalAttemptId`) REFERENCES `externalPaymentAttempts`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundPayments' AND CONSTRAINT_NAME='fk_drefund_receipt'), 'SELECT 1', 'ALTER TABLE `digitalRefundPayments` ADD CONSTRAINT `fk_drefund_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundPayments' AND CONSTRAINT_NAME='fk_drefund_confirmer'), 'SELECT 1', 'ALTER TABLE `digitalRefundPayments` ADD CONSTRAINT `fk_drefund_confirmer` FOREIGN KEY (`confirmedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundPayments' AND CONSTRAINT_NAME='fk_drefund_requester'), 'SELECT 1', 'ALTER TABLE `digitalRefundPayments` ADD CONSTRAINT `fk_drefund_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundItems' AND INDEX_NAME='idx_drefunditem_date'), 'SELECT 1', 'CREATE INDEX `idx_drefunditem_date` ON `digitalRefundItems` (`occurredAt`);');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundPayments' AND INDEX_NAME='idx_drefund_invoice'), 'SELECT 1', 'CREATE INDEX `idx_drefund_invoice` ON `digitalRefundPayments` (`invoiceId`,`refundStatus`);');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
SET @digital_0426_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='digitalRefundPayments' AND INDEX_NAME='idx_drefund_intent'), 'SELECT 1', 'CREATE INDEX `idx_drefund_intent` ON `digitalRefundPayments` (`intentId`,`refundStatus`);');
PREPARE digital_0426_stmt FROM @digital_0426_ddl;
EXECUTE digital_0426_stmt;
DEALLOCATE PREPARE digital_0426_stmt;
--> statement-breakpoint
ALTER TABLE `digitalSaleReviewResolutions` MODIFY COLUMN `decision` enum('CANCEL_NO_ISSUE','FINALIZE_SALE','WRITEOFF_LOSS','SETTLE_PARTIAL') NOT NULL;
