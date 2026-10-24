-- Barcode workflow: controlled settlement, original component rights and immediate guest SERVICE.
-- Reentrant additive schema. Historical issue cost remains NULL; no sale, collection or stock backfill.
CREATE TABLE IF NOT EXISTS `aftercareSettlements` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`caseId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`status` enum('REQUESTED','APPROVED','POSTED','WITHDRAWN') NOT NULL DEFAULT 'REQUESTED',
	`activeCaseId` bigint GENERATED ALWAYS AS ((CASE WHEN status <> 'WITHDRAWN' THEN caseId ELSE NULL END)) STORED,
	`caseVersion` int NOT NULL,
	`previewHash` char(64) NOT NULL,
	`reason` text NOT NULL,
	`evidence` text NOT NULL,
	`decisions` json NOT NULL,
	`sourceRights` json NOT NULL,
	`restoredValue` decimal(15,2) NOT NULL DEFAULT '0',
	`createdBy` int NOT NULL,
	`approvedBy` int,
	`approvedAt` timestamp,
	`postedBy` int,
	`postedAt` timestamp,
	`clientRequestId` varchar(80) NOT NULL,
	`sourceHash` char(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aftercareSettlements_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_acs_case` UNIQUE(`activeCaseId`),
	CONSTRAINT `uq_acs_key` UNIQUE(`branchId`,`clientRequestId`),
	CONSTRAINT `chk_acs_value` CHECK(`aftercareSettlements`.`restoredValue` >= 0 AND `aftercareSettlements`.`version` > 0 AND `aftercareSettlements`.`caseVersion` > 0),
	CONSTRAINT `chk_acs_sod` CHECK(`aftercareSettlements`.`approvedBy` IS NULL OR `aftercareSettlements`.`approvedBy` <> `aftercareSettlements`.`createdBy`),
	CONSTRAINT `chk_acs_state` CHECK((`aftercareSettlements`.`status` = 'WITHDRAWN' AND `aftercareSettlements`.`postedBy` IS NULL) OR (`aftercareSettlements`.`status` = 'REQUESTED' AND `aftercareSettlements`.`approvedBy` IS NULL AND `aftercareSettlements`.`postedBy` IS NULL) OR (`aftercareSettlements`.`status` = 'APPROVED' AND `aftercareSettlements`.`approvedBy` IS NOT NULL AND `aftercareSettlements`.`approvedAt` IS NOT NULL AND `aftercareSettlements`.`postedBy` IS NULL) OR (`aftercareSettlements`.`status` = 'POSTED' AND `aftercareSettlements`.`approvedBy` IS NOT NULL AND `aftercareSettlements`.`postedBy` IS NOT NULL AND `aftercareSettlements`.`postedAt` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aftercareSettlementLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`settlementId` bigint NOT NULL,
	`executionLineId` bigint NOT NULL,
	`originalIssueLineId` bigint,
	`originalMovementId` bigint,
	`returnMovementId` bigint,
	`usableBaseQuantity` int NOT NULL,
	`consumedBaseQuantity` int NOT NULL,
	`damagedBaseQuantity` int NOT NULL,
	`restoredValue` decimal(15,2) NOT NULL DEFAULT '0',
	`evidence` text NOT NULL,
	CONSTRAINT `aftercareSettlementLines_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_acsl_line` UNIQUE(`executionLineId`),
	CONSTRAINT `uq_acsl_movement` UNIQUE(`returnMovementId`),
	CONSTRAINT `chk_acsl_qty` CHECK(`aftercareSettlementLines`.`usableBaseQuantity` >= 0 AND `aftercareSettlementLines`.`consumedBaseQuantity` >= 0 AND `aftercareSettlementLines`.`damagedBaseQuantity` >= 0 AND `aftercareSettlementLines`.`usableBaseQuantity` + `aftercareSettlementLines`.`consumedBaseQuantity` + `aftercareSettlementLines`.`damagedBaseQuantity` > 0 AND `aftercareSettlementLines`.`restoredValue` >= 0),
	CONSTRAINT `chk_acsl_return` CHECK(`aftercareSettlementLines`.`returnMovementId` IS NULL OR (`aftercareSettlementLines`.`usableBaseQuantity` > 0 AND `aftercareSettlementLines`.`originalMovementId` IS NOT NULL AND `aftercareSettlementLines`.`originalIssueLineId` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `componentRightsAdjustments` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`settlementId` bigint NOT NULL,
	`rightIndex` int NOT NULL,
	`invoiceId` bigint NOT NULL,
	`invoiceItemId` bigint NOT NULL,
	`originalBundleComponentId` bigint,
	`originalMovementId` bigint NOT NULL,
	`baseQuantity` int NOT NULL,
	`normalReturnedBaseQuantity` int NOT NULL,
	`usableBaseQuantity` int NOT NULL,
	`commercialAmount` decimal(15,2) NOT NULL,
	`revenueAmount` decimal(15,2) NOT NULL,
	`taxAmount` decimal(15,2) NOT NULL,
	`originalIssueValue` decimal(15,2) NOT NULL,
	`restoredValue` decimal(15,2) NOT NULL,
	`priorRestoredValue` decimal(15,2) NOT NULL DEFAULT '0',
	`subsequentRestoredValue` decimal(15,2) NOT NULL DEFAULT '0',
	`costEvidence` text NOT NULL,
	`costEvidenceReference` varchar(500) NOT NULL,
	`refundReceiptId` bigint,
	`refundRequiredAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`clientRequestId` varchar(80) NOT NULL,
	`sourceHash` varchar(64) NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `componentRightsAdjustments_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_component_rights_adjustment_settlement_right` UNIQUE(`settlementId`,`rightIndex`),
	CONSTRAINT `uq_component_rights_adjustment_request` UNIQUE(`clientRequestId`),
	CONSTRAINT `chk_component_rights_adjustment_values` CHECK(`componentRightsAdjustments`.`rightIndex` >= 0 AND `componentRightsAdjustments`.`normalReturnedBaseQuantity` >= 0 AND `componentRightsAdjustments`.`baseQuantity` > 0 AND `componentRightsAdjustments`.`usableBaseQuantity` >= 0 AND `componentRightsAdjustments`.`usableBaseQuantity` <= `componentRightsAdjustments`.`baseQuantity` AND `componentRightsAdjustments`.`commercialAmount` > 0 AND `componentRightsAdjustments`.`revenueAmount` >= 0 AND `componentRightsAdjustments`.`taxAmount` >= 0 AND `componentRightsAdjustments`.`revenueAmount` + `componentRightsAdjustments`.`taxAmount` = `componentRightsAdjustments`.`commercialAmount` AND `componentRightsAdjustments`.`originalIssueValue` >= 0 AND `componentRightsAdjustments`.`restoredValue` >= 0 AND `componentRightsAdjustments`.`restoredValue` <= `componentRightsAdjustments`.`originalIssueValue`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `componentRightsRefunds` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`adjustmentId` bigint NOT NULL,
	`receiptId` bigint NOT NULL,
	`providerReference` varchar(191),
	CONSTRAINT `componentRightsRefunds_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_component_rights_refund_receipt` UNIQUE(`receiptId`),
	CONSTRAINT `uq_component_rights_refund_provider` UNIQUE(`providerReference`)
);
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND COLUMN_NAME='settledBaseQuantity'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD COLUMN `settledBaseQuantity` int NOT NULL DEFAULT 0');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND COLUMN_NAME='settledBaseQuantity'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD COLUMN `settledBaseQuantity` int NOT NULL DEFAULT 0');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='invoiceItemBundleComponents' AND COLUMN_NAME='issueUnitCost'), 'SELECT 1', 'ALTER TABLE `invoiceItemBundleComponents` ADD COLUMN `issueUnitCost` decimal(15,2) NULL');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='invoiceItemBundleComponents' AND COLUMN_NAME='issueLineCost'), 'SELECT 1', 'ALTER TABLE `invoiceItemBundleComponents` ADD COLUMN `issueLineCost` decimal(15,2) NULL');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='receptionDrafts' AND COLUMN_NAME='checkoutCharges'), 'SELECT 1', 'ALTER TABLE `receptionDrafts` ADD COLUMN `checkoutCharges` json NULL');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = CONCAT('ALTER TABLE `aftercareLines` ', IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='chk_acl_qty'), 'DROP CHECK `chk_acl_qty`, ', ''), 'ADD CONSTRAINT `chk_acl_qty` CHECK(`aftercareLines`.`baseQuantity` > 0 AND `aftercareLines`.`executedBaseQuantity` >= 0 AND `aftercareLines`.`executedBaseQuantity` <= `aftercareLines`.`baseQuantity` AND `aftercareLines`.`deliveredBaseQuantity` >= 0 AND `aftercareLines`.`deliveredBaseQuantity` <= `aftercareLines`.`executedBaseQuantity` AND `aftercareLines`.`settledBaseQuantity` >= 0 AND `aftercareLines`.`deliveredBaseQuantity` + `aftercareLines`.`settledBaseQuantity` <= `aftercareLines`.`baseQuantity`)');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = CONCAT('ALTER TABLE `aftercareExecutionLines` ', IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='chk_ael_qty'), 'DROP CHECK `chk_ael_qty`, ', ''), 'ADD CONSTRAINT `chk_ael_qty` CHECK(`aftercareExecutionLines`.`baseQuantity` > 0 AND `aftercareExecutionLines`.`fulfilledBaseQuantity` >= 0 AND `aftercareExecutionLines`.`custodyBaseQuantity` >= 0 AND `aftercareExecutionLines`.`deliveredBaseQuantity` >= 0 AND `aftercareExecutionLines`.`returnedBaseQuantity` >= 0 AND `aftercareExecutionLines`.`settledBaseQuantity` >= 0 AND `aftercareExecutionLines`.`settledBaseQuantity` + `aftercareExecutionLines`.`deliveredBaseQuantity` <= `aftercareExecutionLines`.`baseQuantity` AND `aftercareExecutionLines`.`custodyBaseQuantity` + `aftercareExecutionLines`.`deliveredBaseQuantity` + `aftercareExecutionLines`.`returnedBaseQuantity` <= `aftercareExecutionLines`.`fulfilledBaseQuantity`)');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = CONCAT('ALTER TABLE `fulfillmentCharges` ', IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='chk_fc_customer'), 'DROP CHECK `chk_fc_customer`, ', ''), 'ADD CONSTRAINT `chk_fc_customer` CHECK(`fulfillmentCharges`.`amount` = 0 OR `fulfillmentCharges`.`customerId` IS NOT NULL OR (`fulfillmentCharges`.`category` = ''SERVICE'' AND `fulfillmentCharges`.`status` = ''APPROVED'' AND `fulfillmentCharges`.`externalCost` = 0 AND `fulfillmentCharges`.`paidAmount` = `fulfillmentCharges`.`amount` AND `fulfillmentCharges`.`payeeSupplierId` IS NULL AND `fulfillmentCharges`.`payeePartyId` IS NULL AND `fulfillmentCharges`.`payeeUserId` IS NULL AND `fulfillmentCharges`.`payeeName` IS NULL))');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlementLines' AND CONSTRAINT_NAME='fk_acsl_settlement'), 'SELECT 1', 'ALTER TABLE `aftercareSettlementLines` ADD CONSTRAINT `fk_acsl_settlement` FOREIGN KEY (`settlementId`) REFERENCES `aftercareSettlements`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlementLines' AND CONSTRAINT_NAME='fk_acsl_line'), 'SELECT 1', 'ALTER TABLE `aftercareSettlementLines` ADD CONSTRAINT `fk_acsl_line` FOREIGN KEY (`executionLineId`) REFERENCES `aftercareExecutionLines`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlementLines' AND CONSTRAINT_NAME='fk_acsl_issue'), 'SELECT 1', 'ALTER TABLE `aftercareSettlementLines` ADD CONSTRAINT `fk_acsl_issue` FOREIGN KEY (`originalIssueLineId`) REFERENCES `aftercareExecutionLines`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlementLines' AND CONSTRAINT_NAME='fk_acsl_original'), 'SELECT 1', 'ALTER TABLE `aftercareSettlementLines` ADD CONSTRAINT `fk_acsl_original` FOREIGN KEY (`originalMovementId`) REFERENCES `inventoryMovements`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlementLines' AND CONSTRAINT_NAME='fk_acsl_return'), 'SELECT 1', 'ALTER TABLE `aftercareSettlementLines` ADD CONSTRAINT `fk_acsl_return` FOREIGN KEY (`returnMovementId`) REFERENCES `inventoryMovements`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlements' AND CONSTRAINT_NAME='fk_acs_case'), 'SELECT 1', 'ALTER TABLE `aftercareSettlements` ADD CONSTRAINT `fk_acs_case` FOREIGN KEY (`caseId`) REFERENCES `aftercareCases`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlements' AND CONSTRAINT_NAME='fk_acs_branch'), 'SELECT 1', 'ALTER TABLE `aftercareSettlements` ADD CONSTRAINT `fk_acs_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlements' AND CONSTRAINT_NAME='fk_acs_maker'), 'SELECT 1', 'ALTER TABLE `aftercareSettlements` ADD CONSTRAINT `fk_acs_maker` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlements' AND CONSTRAINT_NAME='fk_acs_checker'), 'SELECT 1', 'ALTER TABLE `aftercareSettlements` ADD CONSTRAINT `fk_acs_checker` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlements' AND CONSTRAINT_NAME='fk_acs_poster'), 'SELECT 1', 'ALTER TABLE `aftercareSettlements` ADD CONSTRAINT `fk_acs_poster` FOREIGN KEY (`postedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsAdjustments' AND CONSTRAINT_NAME='fk_component_rights_adjustment_settlement'), 'SELECT 1', 'ALTER TABLE `componentRightsAdjustments` ADD CONSTRAINT `fk_component_rights_adjustment_settlement` FOREIGN KEY (`settlementId`) REFERENCES `aftercareSettlements`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsAdjustments' AND CONSTRAINT_NAME='fk_component_rights_adjustment_invoice'), 'SELECT 1', 'ALTER TABLE `componentRightsAdjustments` ADD CONSTRAINT `fk_component_rights_adjustment_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsAdjustments' AND CONSTRAINT_NAME='fk_component_rights_adjustment_item'), 'SELECT 1', 'ALTER TABLE `componentRightsAdjustments` ADD CONSTRAINT `fk_component_rights_adjustment_item` FOREIGN KEY (`invoiceItemId`) REFERENCES `invoiceItems`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsAdjustments' AND CONSTRAINT_NAME='fk_component_rights_adjustment_component'), 'SELECT 1', 'ALTER TABLE `componentRightsAdjustments` ADD CONSTRAINT `fk_component_rights_adjustment_component` FOREIGN KEY (`originalBundleComponentId`) REFERENCES `invoiceItemBundleComponents`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsAdjustments' AND CONSTRAINT_NAME='fk_component_rights_adjustment_movement'), 'SELECT 1', 'ALTER TABLE `componentRightsAdjustments` ADD CONSTRAINT `fk_component_rights_adjustment_movement` FOREIGN KEY (`originalMovementId`) REFERENCES `inventoryMovements`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsAdjustments' AND CONSTRAINT_NAME='fk_component_rights_adjustment_receipt'), 'SELECT 1', 'ALTER TABLE `componentRightsAdjustments` ADD CONSTRAINT `fk_component_rights_adjustment_receipt` FOREIGN KEY (`refundReceiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsAdjustments' AND CONSTRAINT_NAME='fk_component_rights_adjustment_actor'), 'SELECT 1', 'ALTER TABLE `componentRightsAdjustments` ADD CONSTRAINT `fk_component_rights_adjustment_actor` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsRefunds' AND CONSTRAINT_NAME='fk_component_rights_refund_adjustment'), 'SELECT 1', 'ALTER TABLE `componentRightsRefunds` ADD CONSTRAINT `fk_component_rights_refund_adjustment` FOREIGN KEY (`adjustmentId`) REFERENCES `componentRightsAdjustments`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsRefunds' AND CONSTRAINT_NAME='fk_component_rights_refund_receipt'), 'SELECT 1', 'ALTER TABLE `componentRightsRefunds` ADD CONSTRAINT `fk_component_rights_refund_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlements' AND INDEX_NAME='idx_acs_case'), 'SELECT 1', 'CREATE INDEX `idx_acs_case` ON `aftercareSettlements` (`caseId`)');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareSettlements' AND INDEX_NAME='idx_acs_scope'), 'SELECT 1', 'CREATE INDEX `idx_acs_scope` ON `aftercareSettlements` (`branchId`,`status`)');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsAdjustments' AND INDEX_NAME='idx_component_rights_adjustment_item'), 'SELECT 1', 'CREATE INDEX `idx_component_rights_adjustment_item` ON `componentRightsAdjustments` (`invoiceItemId`)');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
--> statement-breakpoint
SET @workflow_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='componentRightsRefunds' AND INDEX_NAME='idx_component_rights_refund_adjustment'), 'SELECT 1', 'CREATE INDEX `idx_component_rights_refund_adjustment` ON `componentRightsRefunds` (`adjustmentId`)');
--> statement-breakpoint
PREPARE workflow_stmt FROM @workflow_ddl;
--> statement-breakpoint
EXECUTE workflow_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE workflow_stmt;
