-- Journaled repair for databases created through schema push/baseline paths where the
-- reception disclosure columns or its critical lookup indexes were recorded
-- as present in code but never materialised in MySQL. Every statement is
-- idempotent and therefore safe in the post-migration reconciliation pass.

SET @has_delivery_free := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'invoices'
    AND COLUMN_NAME = 'deliveryFree'
);
SET @ddl := IF(
  @has_delivery_free = 0,
  'ALTER TABLE `invoices` ADD COLUMN `deliveryFree` BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_delivery_waived := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'invoices'
    AND COLUMN_NAME = 'deliveryWaivedAmount'
);
SET @ddl := IF(
  @has_delivery_waived = 0,
  'ALTER TABLE `invoices` ADD COLUMN `deliveryWaivedAmount` DECIMAL(15,2) NOT NULL DEFAULT ''0.00''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_invoice_item_gift := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoiceItems' AND COLUMN_NAME = 'isGift'
);
SET @ddl := IF(
  @has_invoice_item_gift = 0,
  'ALTER TABLE `invoiceItems` ADD COLUMN `isGift` BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_wo_delivery_phone := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'deliveryPhone'
);
SET @ddl := IF(
  @has_wo_delivery_phone = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `deliveryPhone` VARCHAR(20) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_consignment_courier_delivered := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'courierDeliveredAt'
);
SET @ddl := IF(
  @has_consignment_courier_delivered = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `courierDeliveredAt` TIMESTAMP NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_consignment_workorder_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND INDEX_NAME = 'idx_consignment_workorder'
);
SET @ddl := IF(
  @has_consignment_workorder_idx = 0,
  'CREATE INDEX `idx_consignment_workorder` ON `deliveryConsignments` (`workOrderId`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_correction_of := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'correctionOfInvoiceId'
);
SET @ddl := IF(
  @has_correction_of = 0,
  'ALTER TABLE `invoices` ADD COLUMN `correctionOfInvoiceId` BIGINT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_corrected_by := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'correctedByInvoiceId'
);
SET @ddl := IF(
  @has_corrected_by = 0,
  'ALTER TABLE `invoices` ADD COLUMN `correctedByInvoiceId` BIGINT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_correction_of_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND INDEX_NAME = 'idx_invoice_correction_of'
);
SET @ddl := IF(
  @has_correction_of_idx = 0,
  'CREATE INDEX `idx_invoice_correction_of` ON `invoices` (`correctionOfInvoiceId`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_corrected_by_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND INDEX_NAME = 'idx_invoice_corrected_by'
);
SET @ddl := IF(
  @has_corrected_by_idx = 0,
  'CREATE INDEX `idx_invoice_corrected_by` ON `invoices` (`correctedByInvoiceId`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_invoice_contact_name := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'contactName'
);
SET @ddl := IF(
  @has_invoice_contact_name = 0,
  'ALTER TABLE `invoices` ADD COLUMN `contactName` VARCHAR(255) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_invoice_contact_phone := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'contactPhone'
);
SET @ddl := IF(
  @has_invoice_contact_phone = 0,
  'ALTER TABLE `invoices` ADD COLUMN `contactPhone` VARCHAR(32) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_wo_fee_collection := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'deliveryFeeCollection'
);
SET @ddl := IF(
  @has_wo_fee_collection = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `deliveryFeeCollection` ENUM(''COURIER'',''COUNTER'',''SHOP'') NOT NULL DEFAULT ''COURIER''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_wo_contact_name := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'contactName'
);
SET @ddl := IF(
  @has_wo_contact_name = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `contactName` VARCHAR(255) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_wo_contact_phone := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'contactPhone'
);
SET @ddl := IF(
  @has_wo_contact_phone = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `contactPhone` VARCHAR(32) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_wo_deposit_receipt := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'depositReceiptId'
);
SET @ddl := IF(
  @has_wo_deposit_receipt = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `depositReceiptId` BIGINT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_wo_deposit_index := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND INDEX_NAME = 'idx_wo_deposit_receipt'
);
SET @ddl := IF(
  @has_wo_deposit_index = 0,
  'CREATE INDEX `idx_wo_deposit_receipt` ON `workOrders` (`depositReceiptId`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_consignment_fee_collection := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'consignmentFeeCollection'
);
SET @ddl := IF(
  @has_consignment_fee_collection = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `consignmentFeeCollection` ENUM(''COURIER'',''COUNTER'',''SHOP'') NOT NULL DEFAULT ''COURIER''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_consignment_fee_settled := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'feeSettledAt'
);
SET @ddl := IF(
  @has_consignment_fee_settled = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `feeSettledAt` TIMESTAMP NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_invoice_shift_index := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'invoices'
    AND INDEX_NAME = 'idx_invoice_shift'
);
SET @ddl := IF(
  @has_invoice_shift_index = 0,
  'CREATE INDEX `idx_invoice_shift` ON `invoices` (`shiftId`, `id`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `receptionDrafts` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `draftNumber` varchar(40) NOT NULL,
  `branchId` bigint NOT NULL,
  `createdByShiftId` bigint,
  `draftStatus` enum('OPEN','COMMITTED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'OPEN',
  `version` int NOT NULL DEFAULT 0,
  `commitRequestId` char(36) NOT NULL,
  `moneyLocked` boolean NOT NULL DEFAULT false,
  `customerId` bigint,
  `contactName` varchar(255),
  `contactPhone` varchar(32),
  `draftPriceTier` enum('RETAIL','WHOLESALE','GOVERNMENT') NOT NULL DEFAULT 'RETAIL',
  `channel` varchar(20),
  `notes` text,
  `dueDate` date,
  `subtotal` decimal(15,2) NOT NULL DEFAULT '0',
  `discountTotal` decimal(15,2) NOT NULL DEFAULT '0',
  `total` decimal(15,2) NOT NULL DEFAULT '0',
  `committedInvoiceId` bigint,
  `committedPrintInvoiceId` bigint,
  `expiresAt` timestamp NULL,
  `committedAt` timestamp NULL,
  `cancelledAt` timestamp NULL,
  `cancelReason` varchar(500),
  `createdBy` int NOT NULL,
  `updatedBy` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `receptionDrafts_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_draft_number` UNIQUE(`draftNumber`),
  CONSTRAINT `uq_draft_commit_request` UNIQUE(`commitRequestId`),
  CONSTRAINT `uq_draft_committed_invoice` UNIQUE(`committedInvoiceId`),
  CONSTRAINT `fk_draft_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `fk_draft_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`),
  CONSTRAINT `fk_draft_committed_inv` FOREIGN KEY (`committedInvoiceId`) REFERENCES `invoices`(`id`),
  CONSTRAINT `fk_draft_committed_print` FOREIGN KEY (`committedPrintInvoiceId`) REFERENCES `invoices`(`id`),
  CONSTRAINT `fk_draft_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`),
  INDEX `idx_draft_branch_status_id` (`branchId`,`draftStatus`,`id`),
  INDEX `idx_draft_creator` (`createdBy`,`draftStatus`),
  INDEX `idx_draft_phone` (`contactPhone`),
  INDEX `idx_draft_customer` (`customerId`)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `receptionDraftLines` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `draftId` bigint NOT NULL,
  `draftLineKind` enum('GOODS','PRINT','CUSTOM') NOT NULL,
  `sortOrder` int NOT NULL DEFAULT 0,
  `variantId` bigint,
  `productUnitId` bigint,
  `quantity` decimal(15,3) NOT NULL DEFAULT '1',
  `unitPrice` decimal(15,2) NOT NULL DEFAULT '0',
  `discountAmount` decimal(15,2) NOT NULL DEFAULT '0',
  `lineTotal` decimal(15,2) NOT NULL DEFAULT '0',
  `title` varchar(255),
  `customizationText` text,
  `designImages` mediumtext,
  `printSpec` text,
  `dueDate` date,
  `assignedTo` int,
  `priceOverride` boolean NOT NULL DEFAULT false,
  `priceApprovedBy` bigint,
  `lineRequestId` varchar(64),
  CONSTRAINT `receptionDraftLines_id` PRIMARY KEY(`id`),
  CONSTRAINT `fk_dline_draft` FOREIGN KEY (`draftId`) REFERENCES `receptionDrafts`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dline_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`),
  CONSTRAINT `fk_dline_unit` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`),
  INDEX `idx_dline_draft` (`draftId`,`sortOrder`)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `orderPayments` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `draftId` bigint NOT NULL,
  `branchId` bigint NOT NULL,
  `customerId` bigint,
  `orderPayKind` enum('COLLECTION','APPLICATION','REFUND') NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `orderPayMethod` enum('CASH','CARD','TRANSFER','WALLET','TELECOM'),
  `receiptId` bigint,
  `shiftId` bigint,
  `parentPaymentId` bigint,
  `orderPayAppliedKind` enum('INVOICE','WORKORDER'),
  `appliedId` bigint,
  `orderPayStatus` enum('HELD','APPLIED','REFUNDED'),
  `referenceNumber` varchar(64),
  `clientRequestId` varchar(80),
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `orderPayments_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_orderpay_receipt` UNIQUE(`receiptId`),
  CONSTRAINT `uq_orderpay_request` UNIQUE(`clientRequestId`),
  CONSTRAINT `fk_orderpay_draft` FOREIGN KEY (`draftId`) REFERENCES `receptionDrafts`(`id`),
  CONSTRAINT `fk_orderpay_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `fk_orderpay_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`),
  CONSTRAINT `fk_orderpay_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`),
  CONSTRAINT `fk_orderpay_shift` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`),
  CONSTRAINT `fk_orderpay_parent` FOREIGN KEY (`parentPaymentId`) REFERENCES `orderPayments`(`id`),
  CONSTRAINT `fk_orderpay_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`),
  INDEX `idx_orderpay_draft` (`draftId`,`orderPayKind`,`orderPayStatus`),
  INDEX `idx_orderpay_applied` (`orderPayAppliedKind`,`appliedId`),
  INDEX `idx_orderpay_parent` (`parentPaymentId`)
);
--> statement-breakpoint

-- CREATE TABLE IF NOT EXISTS does not repair indexes on a partially-created table.
-- Reconcile every reception index that the strict schema verifier relies on.
SET @has_draft_commit_index := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receptionDrafts'
    AND INDEX_NAME = 'uq_draft_commit_request'
);
SET @ddl := IF(
  @has_draft_commit_index = 0,
  'CREATE UNIQUE INDEX `uq_draft_commit_request` ON `receptionDrafts` (`commitRequestId`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_draft_queue_index := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receptionDrafts'
    AND INDEX_NAME = 'idx_draft_branch_status_id'
);
SET @ddl := IF(
  @has_draft_queue_index = 0,
  'CREATE INDEX `idx_draft_branch_status_id` ON `receptionDrafts` (`branchId`, `draftStatus`, `id`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_draft_lines_index := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receptionDraftLines'
    AND INDEX_NAME = 'idx_dline_draft'
);
SET @ddl := IF(
  @has_draft_lines_index = 0,
  'CREATE INDEX `idx_dline_draft` ON `receptionDraftLines` (`draftId`, `sortOrder`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_orderpay_request_index := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orderPayments'
    AND INDEX_NAME = 'uq_orderpay_request'
);
SET @ddl := IF(
  @has_orderpay_request_index = 0,
  'CREATE UNIQUE INDEX `uq_orderpay_request` ON `orderPayments` (`clientRequestId`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_orderpay_receipt_index := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'orderPayments'
    AND INDEX_NAME = 'uq_orderpay_receipt'
);
SET @ddl := IF(
  @has_orderpay_receipt_index = 0,
  'CREATE UNIQUE INDEX `uq_orderpay_receipt` ON `orderPayments` (`receiptId`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
