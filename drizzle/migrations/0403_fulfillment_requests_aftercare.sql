-- Additive fulfillment / classified charges / aftercare schema.
-- Reentrant on schema-pushed CI databases; no historical financial backfill.
CREATE TABLE IF NOT EXISTS `aftercareCases` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`customerId` bigint,
	`invoiceId` bigint,
	`workOrderId` bigint,
	`originalConsignmentId` bigint,
	`caseNumber` varchar(60) NOT NULL,
	`status` enum('DRAFT','APPROVED','IN_PROGRESS','RESOLVED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`reason` text NOT NULL,
	`evidence` text NOT NULL,
	`resolution` text,
	`createdBy` int NOT NULL,
	`approvedBy` int,
	`approvedAt` timestamp,
	`resolvedBy` int,
	`resolvedAt` timestamp,
	`cancelledBy` int,
	`cancelledAt` timestamp,
	`cancellationReason` text,
	`clientRequestId` varchar(80) NOT NULL,
	`sourceHash` char(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aftercareCases_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ac_number` UNIQUE(`caseNumber`),
	CONSTRAINT `uq_ac_key` UNIQUE(`branchId`,`clientRequestId`),
	CONSTRAINT `chk_ac_source` CHECK((`aftercareCases`.`invoiceId` IS NOT NULL) + (`aftercareCases`.`workOrderId` IS NOT NULL) = 1),
	CONSTRAINT `chk_ac_version` CHECK(`aftercareCases`.`version` > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aftercareExecutionLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`executionId` bigint NOT NULL,
	`aftercareLineId` bigint NOT NULL,
	`variantId` bigint,
	`kind` enum('OUTPUT','MATERIAL') NOT NULL DEFAULT 'OUTPUT',
	`outputLineId` bigint GENERATED ALWAYS AS ((CASE WHEN kind = 'OUTPUT' THEN aftercareLineId ELSE NULL END)) STORED,
	`baseQuantity` int NOT NULL,
	`fulfilledBaseQuantity` int NOT NULL,
	`custodyBaseQuantity` int NOT NULL DEFAULT 0,
	`deliveredBaseQuantity` int NOT NULL DEFAULT 0,
	`returnedBaseQuantity` int NOT NULL DEFAULT 0,
	`movementId` bigint,
	`reusedFromLineId` bigint,
	`unitCost` decimal(15,2) NOT NULL DEFAULT '0',
	`lineCost` decimal(15,2) NOT NULL DEFAULT '0',
	`notes` text,
	CONSTRAINT `aftercareExecutionLines_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ael_movement` UNIQUE(`movementId`),
	CONSTRAINT `uq_ael_reused_from` UNIQUE(`reusedFromLineId`),
	CONSTRAINT `uq_ael_output` UNIQUE(`executionId`,`outputLineId`),
	CONSTRAINT `chk_ael_qty` CHECK(`aftercareExecutionLines`.`baseQuantity` > 0 AND `aftercareExecutionLines`.`fulfilledBaseQuantity` >= 0 AND `aftercareExecutionLines`.`custodyBaseQuantity` >= 0 AND `aftercareExecutionLines`.`deliveredBaseQuantity` >= 0 AND `aftercareExecutionLines`.`returnedBaseQuantity` >= 0 AND `aftercareExecutionLines`.`custodyBaseQuantity` + `aftercareExecutionLines`.`deliveredBaseQuantity` + `aftercareExecutionLines`.`returnedBaseQuantity` <= `aftercareExecutionLines`.`fulfilledBaseQuantity`),
	CONSTRAINT `chk_ael_kind` CHECK((`aftercareExecutionLines`.`kind` = 'OUTPUT' AND `aftercareExecutionLines`.`fulfilledBaseQuantity` = `aftercareExecutionLines`.`baseQuantity`) OR (`aftercareExecutionLines`.`kind` = 'MATERIAL' AND `aftercareExecutionLines`.`fulfilledBaseQuantity` = 0 AND `aftercareExecutionLines`.`custodyBaseQuantity` = 0 AND `aftercareExecutionLines`.`deliveredBaseQuantity` = 0 AND `aftercareExecutionLines`.`returnedBaseQuantity` = 0 AND `aftercareExecutionLines`.`movementId` IS NOT NULL)),
	CONSTRAINT `chk_ael_variant` CHECK(`aftercareExecutionLines`.`variantId` IS NOT NULL OR (`aftercareExecutionLines`.`kind` = 'OUTPUT'
        AND `aftercareExecutionLines`.`movementId` IS NULL AND `aftercareExecutionLines`.`unitCost` = 0 AND `aftercareExecutionLines`.`lineCost` = 0)),
	CONSTRAINT `chk_ael_cost` CHECK(`aftercareExecutionLines`.`unitCost` >= 0 AND `aftercareExecutionLines`.`lineCost` >= 0),
	CONSTRAINT `chk_ael_reuse` CHECK(`aftercareExecutionLines`.`reusedFromLineId` IS NULL OR (`aftercareExecutionLines`.`kind` = 'OUTPUT' AND `aftercareExecutionLines`.`movementId` IS NULL AND `aftercareExecutionLines`.`unitCost` = 0 AND `aftercareExecutionLines`.`lineCost` = 0))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aftercareExecutions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`caseId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`status` enum('PREPARED','DISPATCHED','DELIVERED','RETURNED','CANCELLED') NOT NULL DEFAULT 'PREPARED',
	`partyId` bigint,
	`consignmentId` bigint,
	`deliveryFee` decimal(15,2) NOT NULL DEFAULT '0',
	`feeCollection` enum('SHOP') NOT NULL DEFAULT 'SHOP',
	`codAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`feePaidAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`feeReceiptId` bigint,
	`recipientName` varchar(255) NOT NULL,
	`recipientPhone` varchar(24) NOT NULL,
	`deliveryAddress` text NOT NULL,
	`totalCost` decimal(15,2) NOT NULL DEFAULT '0',
	`preparedBy` int NOT NULL,
	`checkedBy` int,
	`checkedAt` timestamp,
	`dispatchedBy` int,
	`dispatchedAt` timestamp,
	`deliveredBy` int,
	`deliveredAt` timestamp,
	`returnedAt` timestamp,
	`deliveryProof` text,
	`returnEvidence` text,
	`notes` text,
	`clientRequestId` varchar(80) NOT NULL,
	`sourceHash` char(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aftercareExecutions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ae_key` UNIQUE(`branchId`,`clientRequestId`),
	CONSTRAINT `uq_ae_consignment` UNIQUE(`consignmentId`),
	CONSTRAINT `chk_ae_money` CHECK(`aftercareExecutions`.`codAmount` = 0 AND `aftercareExecutions`.`deliveryFee` >= 0 AND `aftercareExecutions`.`feePaidAmount` >= 0 AND `aftercareExecutions`.`feePaidAmount` <= `aftercareExecutions`.`deliveryFee` AND `aftercareExecutions`.`totalCost` >= 0),
	CONSTRAINT `chk_ae_version` CHECK(`aftercareExecutions`.`version` > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aftercareLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`caseId` bigint NOT NULL,
	`originalInvoiceItemId` bigint,
	`sourceWorkOrderId` bigint,
	`originalBundleComponentId` bigint,
	`componentVariantId` bigint,
	`disposition` enum('MISSING_HELD','REPLACEMENT','REPRINT') NOT NULL,
	`baseQuantity` int NOT NULL,
	`executedBaseQuantity` int NOT NULL DEFAULT 0,
	`deliveredBaseQuantity` int NOT NULL DEFAULT 0,
	`originalMovementId` bigint,
	`heldConfirmedBy` int,
	`heldConfirmedAt` timestamp,
	`evidence` text NOT NULL,
	`notes` text,
	CONSTRAINT `aftercareLines_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_acl_qty` CHECK(`aftercareLines`.`baseQuantity` > 0 AND `aftercareLines`.`executedBaseQuantity` >= 0 AND `aftercareLines`.`executedBaseQuantity` <= `aftercareLines`.`baseQuantity` AND `aftercareLines`.`deliveredBaseQuantity` >= 0 AND `aftercareLines`.`deliveredBaseQuantity` <= `aftercareLines`.`executedBaseQuantity`),
	CONSTRAINT `chk_acl_source` CHECK((`aftercareLines`.`originalInvoiceItemId` IS NOT NULL) + (`aftercareLines`.`sourceWorkOrderId` IS NOT NULL) = 1),
	CONSTRAINT `chk_acl_service` CHECK((`aftercareLines`.`sourceWorkOrderId` IS NULL AND `aftercareLines`.`componentVariantId` IS NOT NULL)
        OR (`aftercareLines`.`sourceWorkOrderId` IS NOT NULL AND `aftercareLines`.`disposition` = 'REPRINT'
          AND `aftercareLines`.`componentVariantId` IS NULL AND `aftercareLines`.`originalBundleComponentId` IS NULL
          AND `aftercareLines`.`originalMovementId` IS NULL AND `aftercareLines`.`heldConfirmedBy` IS NULL AND `aftercareLines`.`heldConfirmedAt` IS NULL)),
	CONSTRAINT `chk_acl_held` CHECK(`aftercareLines`.`disposition` <> 'MISSING_HELD' OR (`aftercareLines`.`originalMovementId` IS NOT NULL AND `aftercareLines`.`heldConfirmedBy` IS NOT NULL AND `aftercareLines`.`heldConfirmedAt` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fulfillmentChargePayments` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`chargeId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`receiptId` bigint,
	`kind` enum('COLLECTION','REFUND','PAYEE_PAYMENT','COURIER_COLLECTION','COURIER_REMITTANCE') NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`originalPaymentId` bigint,
	`consignmentId` bigint,
	`partyId` bigint,
	`createdBy` int NOT NULL,
	`clientRequestId` varchar(80) NOT NULL,
	`sourceHash` char(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fulfillmentChargePayments_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_fcp_key` UNIQUE(`chargeId`,`kind`,`clientRequestId`),
	CONSTRAINT `uq_fcp_allocation` UNIQUE(`chargeId`,`kind`,`receiptId`),
	CONSTRAINT `chk_fcp_amount` CHECK(`fulfillmentChargePayments`.`amount` > 0),
	CONSTRAINT `chk_fcp_receipt` CHECK((`fulfillmentChargePayments`.`kind` = 'COURIER_COLLECTION' AND `fulfillmentChargePayments`.`receiptId` IS NULL AND `fulfillmentChargePayments`.`consignmentId` IS NOT NULL AND `fulfillmentChargePayments`.`partyId` IS NOT NULL) OR (`fulfillmentChargePayments`.`kind` <> 'COURIER_COLLECTION' AND `fulfillmentChargePayments`.`receiptId` IS NOT NULL)),
	CONSTRAINT `chk_fcp_refund` CHECK(`fulfillmentChargePayments`.`kind` <> 'REFUND' OR `fulfillmentChargePayments`.`originalPaymentId` IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fulfillmentCharges` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`requestId` bigint,
	`customerId` bigint,
	`category` enum('SERVICE','OUTSOURCED','PASS_THROUGH','SHOP_EXPENSE') NOT NULL,
	`status` enum('DRAFT','APPROVED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`description` text NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`externalCost` decimal(15,2) NOT NULL DEFAULT '0',
	`paidAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`refundedAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`payeePaidAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`payeeSupplierId` bigint,
	`payeePartyId` bigint,
	`payeeUserId` int,
	`payeeName` varchar(255),
	`payeePhone` varchar(24),
	`createdBy` int NOT NULL,
	`approvedBy` int,
	`approvedAt` timestamp,
	`cancelledBy` int,
	`cancelledAt` timestamp,
	`reason` text,
	`clientRequestId` varchar(80) NOT NULL,
	`sourceHash` char(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `fulfillmentCharges_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_fc_key` UNIQUE(`branchId`,`clientRequestId`),
	CONSTRAINT `chk_fc_money` CHECK(`fulfillmentCharges`.`amount` >= 0 AND `fulfillmentCharges`.`externalCost` >= 0 AND `fulfillmentCharges`.`paidAmount` >= 0 AND `fulfillmentCharges`.`paidAmount` <= `fulfillmentCharges`.`amount` AND `fulfillmentCharges`.`refundedAmount` >= 0 AND `fulfillmentCharges`.`refundedAmount` <= `fulfillmentCharges`.`paidAmount` AND `fulfillmentCharges`.`payeePaidAmount` >= 0 AND `fulfillmentCharges`.`payeePaidAmount` <= `fulfillmentCharges`.`externalCost`),
	CONSTRAINT `chk_fc_category` CHECK((`fulfillmentCharges`.`category` = 'SHOP_EXPENSE' AND `fulfillmentCharges`.`amount` = 0 AND `fulfillmentCharges`.`externalCost` > 0) OR (`fulfillmentCharges`.`category` = 'PASS_THROUGH' AND `fulfillmentCharges`.`amount` > 0 AND `fulfillmentCharges`.`externalCost` = `fulfillmentCharges`.`amount`) OR (`fulfillmentCharges`.`category` IN ('SERVICE','OUTSOURCED') AND `fulfillmentCharges`.`amount` > 0)),
	CONSTRAINT `chk_fc_customer` CHECK(`fulfillmentCharges`.`amount` = 0 OR `fulfillmentCharges`.`customerId` IS NOT NULL),
	CONSTRAINT `chk_fc_payee` CHECK(`fulfillmentCharges`.`externalCost` = 0 OR ((`fulfillmentCharges`.`payeeSupplierId` IS NOT NULL) + (`fulfillmentCharges`.`payeePartyId` IS NOT NULL) + (`fulfillmentCharges`.`payeeUserId` IS NOT NULL) + (`fulfillmentCharges`.`payeeName` IS NOT NULL AND CHAR_LENGTH(TRIM(`fulfillmentCharges`.`payeeName`)) > 0) = 1)),
	CONSTRAINT `chk_fc_version` CHECK(`fulfillmentCharges`.`version` > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fulfillmentRequestItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`requestId` bigint NOT NULL,
	`invoiceId` bigint,
	`workOrderId` bigint,
	`materializedInvoiceId` bigint,
	`isActive` boolean NOT NULL DEFAULT true,
	`status` enum('WAITING','READY','RELEASED','CANCELLED') NOT NULL DEFAULT 'WAITING',
	`activeInvoiceId` bigint GENERATED ALWAYS AS ((CASE WHEN isActive = 1 THEN COALESCE(invoiceId, materializedInvoiceId) ELSE NULL END)) STORED,
	`activeWorkOrderId` bigint GENERATED ALWAYS AS ((CASE WHEN isActive = 1 THEN workOrderId ELSE NULL END)) STORED,
	`consignmentId` bigint,
	`checkedBy` int,
	`checkedAt` timestamp,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fulfillmentRequestItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_fri_active_invoice` UNIQUE(`activeInvoiceId`),
	CONSTRAINT `uq_fri_active_order` UNIQUE(`activeWorkOrderId`),
	CONSTRAINT `uq_fri_request_invoice` UNIQUE(`requestId`,`invoiceId`),
	CONSTRAINT `uq_fri_request_order` UNIQUE(`requestId`,`workOrderId`),
	CONSTRAINT `chk_fri_source` CHECK((`fulfillmentRequestItems`.`invoiceId` IS NOT NULL) + (`fulfillmentRequestItems`.`workOrderId` IS NOT NULL) = 1),
	CONSTRAINT `chk_fri_active` CHECK((`fulfillmentRequestItems`.`isActive` = 1 AND `fulfillmentRequestItems`.`status` IN ('WAITING','READY','RELEASED')) OR (`fulfillmentRequestItems`.`isActive` = 0 AND `fulfillmentRequestItems`.`status` IN ('RELEASED','CANCELLED')))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fulfillmentRequests` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`customerId` bigint,
	`requestNumber` varchar(60) NOT NULL,
	`status` enum('DRAFT','PREPARING','READY','PARTIALLY_RELEASED','RELEASED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`recipientName` varchar(255) NOT NULL,
	`recipientPhone` varchar(24) NOT NULL,
	`deliveryAddress` text NOT NULL,
	`partyId` bigint,
	`deliveryFee` decimal(15,2) NOT NULL DEFAULT '0',
	`feeCollection` enum('COURIER','COUNTER','SHOP') NOT NULL DEFAULT 'COURIER',
	`partialReleaseAllowed` boolean NOT NULL DEFAULT false,
	`futureFeeDecision` text,
	`notes` text,
	`createdBy` int NOT NULL,
	`releasedBy` int,
	`releasedAt` timestamp,
	`cancelledBy` int,
	`cancelledAt` timestamp,
	`cancellationReason` text,
	`clientRequestId` varchar(80) NOT NULL,
	`sourceHash` char(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `fulfillmentRequests_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_fr_number` UNIQUE(`requestNumber`),
	CONSTRAINT `uq_fr_key` UNIQUE(`branchId`,`clientRequestId`),
	CONSTRAINT `chk_fr_money` CHECK(`fulfillmentRequests`.`deliveryFee` >= 0),
	CONSTRAINT `chk_fr_version` CHECK(`fulfillmentRequests`.`version` > 0)
);
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND COLUMN_NAME='fulfillmentRequestId'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD COLUMN `fulfillmentRequestId` bigint NULL');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND COLUMN_NAME='aftercareExecutionId'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD COLUMN `aftercareExecutionId` bigint NULL');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND COLUMN_NAME='codClaimVersion'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD COLUMN `codClaimVersion` int NOT NULL DEFAULT 1');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND COLUMN_NAME='courierAckClaimVersion'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD COLUMN `courierAckClaimVersion` int NOT NULL DEFAULT 0');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND COLUMN_NAME='courierAckAt'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD COLUMN `courierAckAt` timestamp NULL');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
ALTER TABLE deliveryConsignments MODIFY COLUMN sourceType enum('WORK_ORDER','ONLINE_ORDER','INVOICE','FULFILLMENT_REQUEST','AFTERCARE_EXECUTION') NOT NULL DEFAULT 'INVOICE';
--> statement-breakpoint
ALTER TABLE deliveryConsignments MODIFY COLUMN invoiceId bigint NULL;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='fk_ac_branch'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `fk_ac_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='fk_ac_customer'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `fk_ac_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='fk_ac_invoice'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `fk_ac_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='fk_ac_order'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `fk_ac_order` FOREIGN KEY (`workOrderId`) REFERENCES `workOrders`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='fk_ac_consignment'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `fk_ac_consignment` FOREIGN KEY (`originalConsignmentId`) REFERENCES `deliveryConsignments`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='fk_ac_creator'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `fk_ac_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='fk_ac_approver'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `fk_ac_approver` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='fk_ac_resolver'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `fk_ac_resolver` FOREIGN KEY (`resolvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='fk_ac_cancel'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `fk_ac_cancel` FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='fk_ael_reused_from'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `fk_ael_reused_from` FOREIGN KEY (`reusedFromLineId`) REFERENCES `aftercareExecutionLines`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='fk_ael_execution'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `fk_ael_execution` FOREIGN KEY (`executionId`) REFERENCES `aftercareExecutions`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='fk_ael_line'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `fk_ael_line` FOREIGN KEY (`aftercareLineId`) REFERENCES `aftercareLines`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='fk_ael_variant'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `fk_ael_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='fk_ael_movement'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `fk_ael_movement` FOREIGN KEY (`movementId`) REFERENCES `inventoryMovements`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='fk_ae_case'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `fk_ae_case` FOREIGN KEY (`caseId`) REFERENCES `aftercareCases`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='fk_ae_branch'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `fk_ae_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='fk_ae_party'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `fk_ae_party` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='fk_ae_consignment'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `fk_ae_consignment` FOREIGN KEY (`consignmentId`) REFERENCES `deliveryConsignments`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='fk_ae_receipt'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `fk_ae_receipt` FOREIGN KEY (`feeReceiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='fk_ae_preparer'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `fk_ae_preparer` FOREIGN KEY (`preparedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='fk_ae_checker'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `fk_ae_checker` FOREIGN KEY (`checkedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='fk_ae_dispatch'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `fk_ae_dispatch` FOREIGN KEY (`dispatchedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='fk_ae_deliver'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `fk_ae_deliver` FOREIGN KEY (`deliveredBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='fk_acl_case'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `fk_acl_case` FOREIGN KEY (`caseId`) REFERENCES `aftercareCases`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='fk_acl_item'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `fk_acl_item` FOREIGN KEY (`originalInvoiceItemId`) REFERENCES `invoiceItems`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='fk_acl_source_wo'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `fk_acl_source_wo` FOREIGN KEY (`sourceWorkOrderId`) REFERENCES `workOrders`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='fk_acl_snapshot'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `fk_acl_snapshot` FOREIGN KEY (`originalBundleComponentId`) REFERENCES `invoiceItemBundleComponents`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='fk_acl_variant'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `fk_acl_variant` FOREIGN KEY (`componentVariantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='fk_acl_movement'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `fk_acl_movement` FOREIGN KEY (`originalMovementId`) REFERENCES `inventoryMovements`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='fk_acl_checker'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `fk_acl_checker` FOREIGN KEY (`heldConfirmedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND CONSTRAINT_NAME='fk_fcp_charge'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `fk_fcp_charge` FOREIGN KEY (`chargeId`) REFERENCES `fulfillmentCharges`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND CONSTRAINT_NAME='fk_fcp_branch'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `fk_fcp_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND CONSTRAINT_NAME='fk_fcp_receipt'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `fk_fcp_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND CONSTRAINT_NAME='fk_fcp_original'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `fk_fcp_original` FOREIGN KEY (`originalPaymentId`) REFERENCES `fulfillmentChargePayments`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND CONSTRAINT_NAME='fk_fcp_consignment'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `fk_fcp_consignment` FOREIGN KEY (`consignmentId`) REFERENCES `deliveryConsignments`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND CONSTRAINT_NAME='fk_fcp_party'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `fk_fcp_party` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND CONSTRAINT_NAME='fk_fcp_actor'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `fk_fcp_actor` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='fk_fc_branch'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `fk_fc_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='fk_fc_request'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `fk_fc_request` FOREIGN KEY (`requestId`) REFERENCES `fulfillmentRequests`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='fk_fc_customer'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `fk_fc_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='fk_fc_supplier'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `fk_fc_supplier` FOREIGN KEY (`payeeSupplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='fk_fc_party'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `fk_fc_party` FOREIGN KEY (`payeePartyId`) REFERENCES `deliveryParties`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='fk_fc_payee_user'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `fk_fc_payee_user` FOREIGN KEY (`payeeUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='fk_fc_creator'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `fk_fc_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='fk_fc_approver'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `fk_fc_approver` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='fk_fc_cancel'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `fk_fc_cancel` FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND CONSTRAINT_NAME='fk_fri_request'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `fk_fri_request` FOREIGN KEY (`requestId`) REFERENCES `fulfillmentRequests`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND CONSTRAINT_NAME='fk_fri_invoice'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `fk_fri_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND CONSTRAINT_NAME='fk_fri_order'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `fk_fri_order` FOREIGN KEY (`workOrderId`) REFERENCES `workOrders`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND CONSTRAINT_NAME='fk_fri_materialized'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `fk_fri_materialized` FOREIGN KEY (`materializedInvoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND CONSTRAINT_NAME='fk_fri_consignment'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `fk_fri_consignment` FOREIGN KEY (`consignmentId`) REFERENCES `deliveryConsignments`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND CONSTRAINT_NAME='fk_fri_checker'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `fk_fri_checker` FOREIGN KEY (`checkedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND CONSTRAINT_NAME='fk_fr_branch'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequests` ADD CONSTRAINT `fk_fr_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND CONSTRAINT_NAME='fk_fr_customer'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequests` ADD CONSTRAINT `fk_fr_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND CONSTRAINT_NAME='fk_fr_party'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequests` ADD CONSTRAINT `fk_fr_party` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND CONSTRAINT_NAME='fk_fr_creator'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequests` ADD CONSTRAINT `fk_fr_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND CONSTRAINT_NAME='fk_fr_release'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequests` ADD CONSTRAINT `fk_fr_release` FOREIGN KEY (`releasedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND CONSTRAINT_NAME='fk_fr_cancel'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequests` ADD CONSTRAINT `fk_fr_cancel` FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND INDEX_NAME='idx_ac_scope'), 'SELECT 1', 'CREATE INDEX `idx_ac_scope` ON `aftercareCases` (`branchId`,`status`,`createdAt`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND INDEX_NAME='idx_ac_invoice'), 'SELECT 1', 'CREATE INDEX `idx_ac_invoice` ON `aftercareCases` (`invoiceId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND INDEX_NAME='idx_ac_order'), 'SELECT 1', 'CREATE INDEX `idx_ac_order` ON `aftercareCases` (`workOrderId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND INDEX_NAME='idx_ac_customer'), 'SELECT 1', 'CREATE INDEX `idx_ac_customer` ON `aftercareCases` (`customerId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND INDEX_NAME='idx_ael_execution'), 'SELECT 1', 'CREATE INDEX `idx_ael_execution` ON `aftercareExecutionLines` (`executionId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND INDEX_NAME='idx_ael_source'), 'SELECT 1', 'CREATE INDEX `idx_ael_source` ON `aftercareExecutionLines` (`aftercareLineId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND INDEX_NAME='idx_ae_case'), 'SELECT 1', 'CREATE INDEX `idx_ae_case` ON `aftercareExecutions` (`caseId`,`status`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND INDEX_NAME='idx_ae_scope'), 'SELECT 1', 'CREATE INDEX `idx_ae_scope` ON `aftercareExecutions` (`branchId`,`status`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND INDEX_NAME='idx_acl_case'), 'SELECT 1', 'CREATE INDEX `idx_acl_case` ON `aftercareLines` (`caseId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND INDEX_NAME='idx_acl_source'), 'SELECT 1', 'CREATE INDEX `idx_acl_source` ON `aftercareLines` (`originalInvoiceItemId`,`componentVariantId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND INDEX_NAME='idx_acl_source_wo'), 'SELECT 1', 'CREATE INDEX `idx_acl_source_wo` ON `aftercareLines` (`sourceWorkOrderId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND INDEX_NAME='idx_fcp_charge'), 'SELECT 1', 'CREATE INDEX `idx_fcp_charge` ON `fulfillmentChargePayments` (`chargeId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND INDEX_NAME='idx_fc_scope'), 'SELECT 1', 'CREATE INDEX `idx_fc_scope` ON `fulfillmentCharges` (`branchId`,`status`,`createdAt`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND INDEX_NAME='idx_fc_request'), 'SELECT 1', 'CREATE INDEX `idx_fc_request` ON `fulfillmentCharges` (`requestId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND INDEX_NAME='idx_fc_customer'), 'SELECT 1', 'CREATE INDEX `idx_fc_customer` ON `fulfillmentCharges` (`customerId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND INDEX_NAME='idx_fri_request'), 'SELECT 1', 'CREATE INDEX `idx_fri_request` ON `fulfillmentRequestItems` (`requestId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND INDEX_NAME='idx_fr_scope'), 'SELECT 1', 'CREATE INDEX `idx_fr_scope` ON `fulfillmentRequests` (`branchId`,`status`,`createdAt`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND INDEX_NAME='idx_fr_customer'), 'SELECT 1', 'CREATE INDEX `idx_fr_customer` ON `fulfillmentRequests` (`customerId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND INDEX_NAME='idx_fr_phone'), 'SELECT 1', 'CREATE INDEX `idx_fr_phone` ON `fulfillmentRequests` (`recipientPhone`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND INDEX_NAME='uq_ac_number'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `uq_ac_number` UNIQUE(`caseNumber`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND INDEX_NAME='uq_ac_key'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `uq_ac_key` UNIQUE(`branchId`,`clientRequestId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='chk_ac_source'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `chk_ac_source` CHECK((`aftercareCases`.`invoiceId` IS NOT NULL) + (`aftercareCases`.`workOrderId` IS NOT NULL) = 1)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareCases' AND CONSTRAINT_NAME='chk_ac_version'), 'SELECT 1', 'ALTER TABLE `aftercareCases` ADD CONSTRAINT `chk_ac_version` CHECK(`aftercareCases`.`version` > 0)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND COLUMN_NAME='outputLineId' AND EXTRA LIKE '%STORED GENERATED%'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` MODIFY COLUMN `outputLineId` bigint GENERATED ALWAYS AS ((CASE WHEN kind = ''OUTPUT'' THEN aftercareLineId ELSE NULL END)) STORED');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND INDEX_NAME='uq_ael_movement'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `uq_ael_movement` UNIQUE(`movementId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND INDEX_NAME='uq_ael_reused_from'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `uq_ael_reused_from` UNIQUE(`reusedFromLineId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND INDEX_NAME='uq_ael_output'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `uq_ael_output` UNIQUE(`executionId`,`outputLineId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='chk_ael_qty'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `chk_ael_qty` CHECK(`aftercareExecutionLines`.`baseQuantity` > 0 AND `aftercareExecutionLines`.`fulfilledBaseQuantity` >= 0 AND `aftercareExecutionLines`.`custodyBaseQuantity` >= 0 AND `aftercareExecutionLines`.`deliveredBaseQuantity` >= 0 AND `aftercareExecutionLines`.`returnedBaseQuantity` >= 0 AND `aftercareExecutionLines`.`custodyBaseQuantity` + `aftercareExecutionLines`.`deliveredBaseQuantity` + `aftercareExecutionLines`.`returnedBaseQuantity` <= `aftercareExecutionLines`.`fulfilledBaseQuantity`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='chk_ael_kind'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `chk_ael_kind` CHECK((`aftercareExecutionLines`.`kind` = ''OUTPUT'' AND `aftercareExecutionLines`.`fulfilledBaseQuantity` = `aftercareExecutionLines`.`baseQuantity`) OR (`aftercareExecutionLines`.`kind` = ''MATERIAL'' AND `aftercareExecutionLines`.`fulfilledBaseQuantity` = 0 AND `aftercareExecutionLines`.`custodyBaseQuantity` = 0 AND `aftercareExecutionLines`.`deliveredBaseQuantity` = 0 AND `aftercareExecutionLines`.`returnedBaseQuantity` = 0 AND `aftercareExecutionLines`.`movementId` IS NOT NULL))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='chk_ael_variant'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `chk_ael_variant` CHECK(`aftercareExecutionLines`.`variantId` IS NOT NULL OR (`aftercareExecutionLines`.`kind` = ''OUTPUT''
        AND `aftercareExecutionLines`.`movementId` IS NULL AND `aftercareExecutionLines`.`unitCost` = 0 AND `aftercareExecutionLines`.`lineCost` = 0))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='chk_ael_cost'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `chk_ael_cost` CHECK(`aftercareExecutionLines`.`unitCost` >= 0 AND `aftercareExecutionLines`.`lineCost` >= 0)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutionLines' AND CONSTRAINT_NAME='chk_ael_reuse'), 'SELECT 1', 'ALTER TABLE `aftercareExecutionLines` ADD CONSTRAINT `chk_ael_reuse` CHECK(`aftercareExecutionLines`.`reusedFromLineId` IS NULL OR (`aftercareExecutionLines`.`kind` = ''OUTPUT'' AND `aftercareExecutionLines`.`movementId` IS NULL AND `aftercareExecutionLines`.`unitCost` = 0 AND `aftercareExecutionLines`.`lineCost` = 0))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND INDEX_NAME='uq_ae_key'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `uq_ae_key` UNIQUE(`branchId`,`clientRequestId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND INDEX_NAME='uq_ae_consignment'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `uq_ae_consignment` UNIQUE(`consignmentId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='chk_ae_money'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `chk_ae_money` CHECK(`aftercareExecutions`.`codAmount` = 0 AND `aftercareExecutions`.`deliveryFee` >= 0 AND `aftercareExecutions`.`feePaidAmount` >= 0 AND `aftercareExecutions`.`feePaidAmount` <= `aftercareExecutions`.`deliveryFee` AND `aftercareExecutions`.`totalCost` >= 0)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareExecutions' AND CONSTRAINT_NAME='chk_ae_version'), 'SELECT 1', 'ALTER TABLE `aftercareExecutions` ADD CONSTRAINT `chk_ae_version` CHECK(`aftercareExecutions`.`version` > 0)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='chk_acl_qty'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `chk_acl_qty` CHECK(`aftercareLines`.`baseQuantity` > 0 AND `aftercareLines`.`executedBaseQuantity` >= 0 AND `aftercareLines`.`executedBaseQuantity` <= `aftercareLines`.`baseQuantity` AND `aftercareLines`.`deliveredBaseQuantity` >= 0 AND `aftercareLines`.`deliveredBaseQuantity` <= `aftercareLines`.`executedBaseQuantity`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='chk_acl_source'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `chk_acl_source` CHECK((`aftercareLines`.`originalInvoiceItemId` IS NOT NULL) + (`aftercareLines`.`sourceWorkOrderId` IS NOT NULL) = 1)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='chk_acl_service'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `chk_acl_service` CHECK((`aftercareLines`.`sourceWorkOrderId` IS NULL AND `aftercareLines`.`componentVariantId` IS NOT NULL)
        OR (`aftercareLines`.`sourceWorkOrderId` IS NOT NULL AND `aftercareLines`.`disposition` = ''REPRINT''
          AND `aftercareLines`.`componentVariantId` IS NULL AND `aftercareLines`.`originalBundleComponentId` IS NULL
          AND `aftercareLines`.`originalMovementId` IS NULL AND `aftercareLines`.`heldConfirmedBy` IS NULL AND `aftercareLines`.`heldConfirmedAt` IS NULL))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='aftercareLines' AND CONSTRAINT_NAME='chk_acl_held'), 'SELECT 1', 'ALTER TABLE `aftercareLines` ADD CONSTRAINT `chk_acl_held` CHECK(`aftercareLines`.`disposition` <> ''MISSING_HELD'' OR (`aftercareLines`.`originalMovementId` IS NOT NULL AND `aftercareLines`.`heldConfirmedBy` IS NOT NULL AND `aftercareLines`.`heldConfirmedAt` IS NOT NULL))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND INDEX_NAME='uq_fcp_key'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `uq_fcp_key` UNIQUE(`chargeId`,`kind`,`clientRequestId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND INDEX_NAME='uq_fcp_allocation'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `uq_fcp_allocation` UNIQUE(`chargeId`,`kind`,`receiptId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND CONSTRAINT_NAME='chk_fcp_amount'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `chk_fcp_amount` CHECK(`fulfillmentChargePayments`.`amount` > 0)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND CONSTRAINT_NAME='chk_fcp_receipt'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `chk_fcp_receipt` CHECK((`fulfillmentChargePayments`.`kind` = ''COURIER_COLLECTION'' AND `fulfillmentChargePayments`.`receiptId` IS NULL AND `fulfillmentChargePayments`.`consignmentId` IS NOT NULL AND `fulfillmentChargePayments`.`partyId` IS NOT NULL) OR (`fulfillmentChargePayments`.`kind` <> ''COURIER_COLLECTION'' AND `fulfillmentChargePayments`.`receiptId` IS NOT NULL))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentChargePayments' AND CONSTRAINT_NAME='chk_fcp_refund'), 'SELECT 1', 'ALTER TABLE `fulfillmentChargePayments` ADD CONSTRAINT `chk_fcp_refund` CHECK(`fulfillmentChargePayments`.`kind` <> ''REFUND'' OR `fulfillmentChargePayments`.`originalPaymentId` IS NOT NULL)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND INDEX_NAME='uq_fc_key'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `uq_fc_key` UNIQUE(`branchId`,`clientRequestId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='chk_fc_money'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `chk_fc_money` CHECK(`fulfillmentCharges`.`amount` >= 0 AND `fulfillmentCharges`.`externalCost` >= 0 AND `fulfillmentCharges`.`paidAmount` >= 0 AND `fulfillmentCharges`.`paidAmount` <= `fulfillmentCharges`.`amount` AND `fulfillmentCharges`.`refundedAmount` >= 0 AND `fulfillmentCharges`.`refundedAmount` <= `fulfillmentCharges`.`paidAmount` AND `fulfillmentCharges`.`payeePaidAmount` >= 0 AND `fulfillmentCharges`.`payeePaidAmount` <= `fulfillmentCharges`.`externalCost`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='chk_fc_category'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `chk_fc_category` CHECK((`fulfillmentCharges`.`category` = ''SHOP_EXPENSE'' AND `fulfillmentCharges`.`amount` = 0 AND `fulfillmentCharges`.`externalCost` > 0) OR (`fulfillmentCharges`.`category` = ''PASS_THROUGH'' AND `fulfillmentCharges`.`amount` > 0 AND `fulfillmentCharges`.`externalCost` = `fulfillmentCharges`.`amount`) OR (`fulfillmentCharges`.`category` IN (''SERVICE'',''OUTSOURCED'') AND `fulfillmentCharges`.`amount` > 0))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='chk_fc_customer'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `chk_fc_customer` CHECK(`fulfillmentCharges`.`amount` = 0 OR `fulfillmentCharges`.`customerId` IS NOT NULL)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='chk_fc_payee'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `chk_fc_payee` CHECK(`fulfillmentCharges`.`externalCost` = 0 OR ((`fulfillmentCharges`.`payeeSupplierId` IS NOT NULL) + (`fulfillmentCharges`.`payeePartyId` IS NOT NULL) + (`fulfillmentCharges`.`payeeUserId` IS NOT NULL) + (`fulfillmentCharges`.`payeeName` IS NOT NULL AND CHAR_LENGTH(TRIM(`fulfillmentCharges`.`payeeName`)) > 0) = 1))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='chk_fc_version'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `chk_fc_version` CHECK(`fulfillmentCharges`.`version` > 0)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND COLUMN_NAME='activeInvoiceId' AND EXTRA LIKE '%STORED GENERATED%'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` MODIFY COLUMN `activeInvoiceId` bigint GENERATED ALWAYS AS ((CASE WHEN isActive = 1 THEN COALESCE(invoiceId, materializedInvoiceId) ELSE NULL END)) STORED');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND COLUMN_NAME='activeWorkOrderId' AND EXTRA LIKE '%STORED GENERATED%'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` MODIFY COLUMN `activeWorkOrderId` bigint GENERATED ALWAYS AS ((CASE WHEN isActive = 1 THEN workOrderId ELSE NULL END)) STORED');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND INDEX_NAME='uq_fri_active_invoice'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `uq_fri_active_invoice` UNIQUE(`activeInvoiceId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND INDEX_NAME='uq_fri_active_order'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `uq_fri_active_order` UNIQUE(`activeWorkOrderId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND INDEX_NAME='uq_fri_request_invoice'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `uq_fri_request_invoice` UNIQUE(`requestId`,`invoiceId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND INDEX_NAME='uq_fri_request_order'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `uq_fri_request_order` UNIQUE(`requestId`,`workOrderId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND CONSTRAINT_NAME='chk_fri_source'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `chk_fri_source` CHECK((`fulfillmentRequestItems`.`invoiceId` IS NOT NULL) + (`fulfillmentRequestItems`.`workOrderId` IS NOT NULL) = 1)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequestItems' AND CONSTRAINT_NAME='chk_fri_active'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequestItems` ADD CONSTRAINT `chk_fri_active` CHECK((`fulfillmentRequestItems`.`isActive` = 1 AND `fulfillmentRequestItems`.`status` IN (''WAITING'',''READY'',''RELEASED'')) OR (`fulfillmentRequestItems`.`isActive` = 0 AND `fulfillmentRequestItems`.`status` IN (''RELEASED'',''CANCELLED'')))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND INDEX_NAME='uq_fr_number'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequests` ADD CONSTRAINT `uq_fr_number` UNIQUE(`requestNumber`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND INDEX_NAME='uq_fr_key'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequests` ADD CONSTRAINT `uq_fr_key` UNIQUE(`branchId`,`clientRequestId`)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND CONSTRAINT_NAME='chk_fr_money'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequests` ADD CONSTRAINT `chk_fr_money` CHECK(`fulfillmentRequests`.`deliveryFee` >= 0)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentRequests' AND CONSTRAINT_NAME='chk_fr_version'), 'SELECT 1', 'ALTER TABLE `fulfillmentRequests` ADD CONSTRAINT `chk_fr_version` CHECK(`fulfillmentRequests`.`version` > 0)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND INDEX_NAME='idx_cn_fulfillment_request'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD INDEX idx_cn_fulfillment_request (fulfillmentRequestId)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND INDEX_NAME='uq_cn_aftercare_execution'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD UNIQUE uq_cn_aftercare_execution (aftercareExecutionId)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND CONSTRAINT_NAME='fk_cn_fulfillment_request'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD CONSTRAINT fk_cn_fulfillment_request FOREIGN KEY (fulfillmentRequestId) REFERENCES fulfillmentRequests(id)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND CONSTRAINT_NAME='fk_cn_aftercare_execution'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD CONSTRAINT fk_cn_aftercare_execution FOREIGN KEY (aftercareExecutionId) REFERENCES aftercareExecutions(id)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND CONSTRAINT_NAME='chk_cn_source_shape'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD CONSTRAINT chk_cn_source_shape CHECK ((sourceType IN (''INVOICE'',''WORK_ORDER'',''ONLINE_ORDER'') AND invoiceId IS NOT NULL AND aftercareExecutionId IS NULL) OR (sourceType=''FULFILLMENT_REQUEST'' AND fulfillmentRequestId IS NOT NULL AND sourceId=fulfillmentRequestId AND invoiceId IS NULL AND workOrderId IS NULL AND aftercareExecutionId IS NULL) OR (sourceType=''AFTERCARE_EXECUTION'' AND aftercareExecutionId IS NOT NULL AND sourceId=aftercareExecutionId AND invoiceId IS NULL AND workOrderId IS NULL AND fulfillmentRequestId IS NULL AND codAmount=0 AND consignmentFeeCollection=''SHOP''))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='deliveryConsignments' AND CONSTRAINT_NAME='chk_cn_claim_version'), 'SELECT 1', 'ALTER TABLE deliveryConsignments ADD CONSTRAINT chk_cn_claim_version CHECK (codClaimVersion>0 AND courierAckClaimVersion>=0 AND courierAckClaimVersion<=codClaimVersion)');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
--> statement-breakpoint
SET @fulfillment_ddl = CONCAT('ALTER TABLE externalPaymentAttempts ', IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='externalPaymentAttempts' AND CONSTRAINT_NAME='chk_extpay_consumption_complete'), 'DROP CHECK chk_extpay_consumption_complete, ', ''), 'ADD CONSTRAINT chk_extpay_consumption_complete CHECK ((invoiceId IS NULL AND receiptId IS NULL AND consumedAt IS NULL) OR (receiptId IS NOT NULL AND consumedAt IS NOT NULL AND externalPaymentState IN (''CONFIRMED'',''REVERSED'')))');
--> statement-breakpoint
PREPARE fulfillment_stmt FROM @fulfillment_ddl;
--> statement-breakpoint
EXECUTE fulfillment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE fulfillment_stmt;
