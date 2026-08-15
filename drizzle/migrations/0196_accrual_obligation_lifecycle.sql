-- 0196: governed current projection and append-only event history for
-- purchase-shipping, asset-maintenance and asset-acquisition obligations.
-- Legacy assets/maintenance remain nullable for idempotency identity, so no
-- historical command or financial-recognition claim is fabricated.
SET NAMES utf8mb4;
--> statement-breakpoint
ALTER TABLE `expenses`
  MODIFY COLUMN `expensePaymentMethod` enum('CASH','CARD','CHECK','TRANSFER','WALLET','ACCRUAL') NOT NULL DEFAULT 'CASH',
  MODIFY COLUMN `expenseSource` enum('CASH','STOCK','ACCRUAL') NOT NULL DEFAULT 'CASH',
  ADD CONSTRAINT `chk_expense_accrual_method` CHECK (
    (`expenseSource` = 'ACCRUAL' AND `expensePaymentMethod` = 'ACCRUAL') OR
    (`expenseSource` <> 'ACCRUAL' AND `expensePaymentMethod` <> 'ACCRUAL')
  );
--> statement-breakpoint
ALTER TABLE `fixedAssets`
  ADD COLUMN `clientRequestId` varchar(64) NULL AFTER `linkedDeviceId`,
  ADD COLUMN `requestPayloadHash` char(64) NULL AFTER `clientRequestId`,
  ADD COLUMN `recognitionStatus` enum('ACTIVE','CORRECTION_PENDING','CORRECTED') NOT NULL DEFAULT 'ACTIVE' AFTER `requestPayloadHash`,
  ADD CONSTRAINT `uq_asset_client_req` UNIQUE (`clientRequestId`);
--> statement-breakpoint
ALTER TABLE `assetMaintenance`
  ADD COLUMN `vendorSupplierId` bigint NULL AFTER `vendor`,
  ADD COLUMN `evidenceReference` varchar(191) NULL AFTER `cost`,
  ADD COLUMN `financialStatus` enum(
    'ACTIVE','CORRECTION_PENDING','CORRECTED'
  ) NOT NULL DEFAULT 'ACTIVE' AFTER `evidenceReference`,
  ADD COLUMN `clientRequestId` varchar(64) NULL AFTER `financialStatus`,
  ADD COLUMN `requestPayloadHash` char(64) NULL AFTER `clientRequestId`,
  ADD CONSTRAINT `uq_maint_client_req` UNIQUE (`clientRequestId`),
  ADD CONSTRAINT `fk_maint_vendor_supplier`
    FOREIGN KEY (`vendorSupplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_maint_supplier` ON `assetMaintenance` (`vendorSupplierId`);
--> statement-breakpoint
CREATE INDEX `idx_maint_fin_status` ON `assetMaintenance` (`financialStatus`);
--> statement-breakpoint
CREATE TABLE `accrualObligations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `kind` enum(
    'PURCHASE_SHIPPING','ASSET_MAINTENANCE',
    'ASSET_ACQUISITION_CASH','ASSET_ACQUISITION_SUPPLIER'
  ) NOT NULL,
  `branchId` bigint NOT NULL,
  `expenseId` bigint NULL,
  `purchaseOrderId` bigint NULL,
  `assetId` bigint NULL,
  `maintenanceId` bigint NULL,
  `sourceKey` varchar(191) NOT NULL,
  `recognizedAmount` decimal(15,2) NOT NULL,
  `status` enum(
    'ACCRUED_UNPAID','PAYMENT_PENDING','PAYABLE_UNSETTLED','PAID',
    'CORRECTION_PENDING','REFUND_PENDING','REFUNDED','RECOGNITION_REVERSED'
  ) NOT NULL,
  `beneficiaryType` enum('SUPPLIER','OTHER') NOT NULL,
  `beneficiarySupplierId` bigint NULL,
  `beneficiaryName` varchar(200) NULL,
  `evidenceReference` varchar(191) NOT NULL,
  `plannedPaymentMethod` enum('CASH','CARD','CHECK','TRANSFER','WALLET') NULL,
  `clientRequestId` varchar(64) NOT NULL,
  `sourceHash` char(64) NOT NULL,
  `recognizedBy` int NOT NULL,
  `recognizedAt` timestamp NOT NULL,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `accrualObligations_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_accrual_obligation_source` UNIQUE (`sourceKey`),
  CONSTRAINT `uq_accrual_obligation_request` UNIQUE (`clientRequestId`),
  CONSTRAINT `fk_acc_ob_branch`
    FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_ob_expense`
    FOREIGN KEY (`expenseId`) REFERENCES `expenses`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_ob_purchase`
    FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_ob_asset`
    FOREIGN KEY (`assetId`) REFERENCES `fixedAssets`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_ob_maint`
    FOREIGN KEY (`maintenanceId`) REFERENCES `assetMaintenance`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_ob_supplier`
    FOREIGN KEY (`beneficiarySupplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_ob_actor`
    FOREIGN KEY (`recognizedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_accrual_obligation_positive` CHECK (`recognizedAmount` > 0),
  CONSTRAINT `chk_accrual_obligation_evidence` CHECK (CHAR_LENGTH(TRIM(`evidenceReference`)) > 0),
  CONSTRAINT `chk_accrual_obligation_beneficiary` CHECK (
    (`beneficiaryType` = 'SUPPLIER' AND `beneficiarySupplierId` IS NOT NULL) OR
    (`beneficiaryType` = 'OTHER' AND `beneficiarySupplierId` IS NULL AND CHAR_LENGTH(TRIM(`beneficiaryName`)) > 0)
  ),
  CONSTRAINT `chk_accrual_obligation_supplier_kind` CHECK (
    `kind` <> 'ASSET_ACQUISITION_SUPPLIER' OR
    `beneficiaryType` = 'SUPPLIER'
  ),
  CONSTRAINT `chk_accrual_obligation_source_shape` CHECK (
    (`kind` = 'PURCHASE_SHIPPING' AND `expenseId` IS NOT NULL AND `purchaseOrderId` IS NOT NULL AND `assetId` IS NULL AND `maintenanceId` IS NULL) OR
    (`kind` = 'ASSET_MAINTENANCE' AND `expenseId` IS NOT NULL AND `purchaseOrderId` IS NULL AND `assetId` IS NOT NULL AND `maintenanceId` IS NOT NULL) OR
    (`kind` IN ('ASSET_ACQUISITION_CASH','ASSET_ACQUISITION_SUPPLIER') AND `expenseId` IS NULL AND `purchaseOrderId` IS NULL AND `assetId` IS NOT NULL AND `maintenanceId` IS NULL)
  ),
  INDEX `idx_accrual_obligation_branch_status` (`branchId`,`status`),
  INDEX `idx_accrual_obligation_kind_status` (`kind`,`status`),
  INDEX `idx_accrual_obligation_expense` (`expenseId`),
  INDEX `idx_accrual_obligation_purchase` (`purchaseOrderId`),
  INDEX `idx_accrual_obligation_asset` (`assetId`),
  INDEX `idx_accrual_obligation_maintenance` (`maintenanceId`)
);
--> statement-breakpoint
CREATE TABLE `accrualObligationEvents` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `obligationId` bigint NOT NULL,
  `eventType` enum(
    'RECOGNIZED','PAYMENT_REQUESTED','PAYMENT_REJECTED','PAYMENT_SETTLED',
    'CORRECTION_REQUESTED','CORRECTION_REJECTED','SETTLEMENT_REVERSED','RECOGNITION_REVERSED'
  ) NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `receiptId` bigint NULL,
  `accountingEntryId` bigint NULL,
  `evidenceReference` varchar(191) NULL,
  `actorId` int NOT NULL,
  `reviewerId` int NULL,
  `dedupeKey` varchar(191) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `accrualObligationEvents_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_accrual_event_dedupe` UNIQUE (`dedupeKey`),
  CONSTRAINT `uq_accrual_event_entry` UNIQUE (`accountingEntryId`),
  CONSTRAINT `fk_acc_evt_obligation`
    FOREIGN KEY (`obligationId`) REFERENCES `accrualObligations`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_evt_receipt`
    FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_evt_entry`
    FOREIGN KEY (`accountingEntryId`) REFERENCES `accountingEntries`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_evt_actor`
    FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_evt_reviewer`
    FOREIGN KEY (`reviewerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_accrual_event_positive_amount` CHECK (`amount` > 0),
  CONSTRAINT `chk_accrual_event_reference_shape` CHECK (
    (`eventType` IN ('RECOGNIZED','RECOGNITION_REVERSED') AND `accountingEntryId` IS NOT NULL AND `receiptId` IS NULL) OR
    (`eventType` IN ('PAYMENT_SETTLED','SETTLEMENT_REVERSED') AND `accountingEntryId` IS NOT NULL AND `receiptId` IS NOT NULL) OR
    (`eventType` IN ('PAYMENT_REQUESTED','PAYMENT_REJECTED') AND `accountingEntryId` IS NULL AND `receiptId` IS NOT NULL) OR
    (`eventType` IN ('CORRECTION_REQUESTED','CORRECTION_REJECTED') AND `accountingEntryId` IS NULL AND `receiptId` IS NULL)
  ),
  INDEX `idx_accrual_event_obligation_time` (`obligationId`,`createdAt`),
  INDEX `idx_accrual_event_receipt` (`receiptId`)
);
--> statement-breakpoint
CREATE TABLE `accrualCorrectionRequests` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `obligationId` bigint NOT NULL,
  `status` enum('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `previousObligationStatus` enum(
    'ACCRUED_UNPAID','PAYMENT_PENDING','PAYABLE_UNSETTLED','PAID',
    'CORRECTION_PENDING','REFUND_PENDING','REFUNDED','RECOGNITION_REVERSED'
  ) NOT NULL,
  `reason` text NOT NULL,
  `externalEvidenceReference` varchar(191) NOT NULL,
  `attachmentUrl` mediumtext NOT NULL,
  `refundPaymentMethod` enum('CASH','CARD','CHECK','TRANSFER','WALLET') NULL,
  `refundCashBucket` enum('DRAWER','TREASURY') NULL,
  `refundReferenceNumber` varchar(100) NULL,
  `refundCardLastFour` char(4) NULL,
  `refundRequestReceiptId` bigint NULL,
  `clientRequestId` varchar(64) NOT NULL,
  `payloadHash` char(64) NOT NULL,
  `requestedBy` int NOT NULL,
  `reviewedBy` int NULL,
  `rejectionReason` varchar(255) NULL,
  `requestedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reviewedAt` timestamp NULL,
  CONSTRAINT `accrualCorrectionRequests_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_accrual_correction_request` UNIQUE (`clientRequestId`),
  CONSTRAINT `fk_acc_corr_obligation`
    FOREIGN KEY (`obligationId`) REFERENCES `accrualObligations`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_corr_refund_receipt`
    FOREIGN KEY (`refundRequestReceiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_corr_requested_by`
    FOREIGN KEY (`requestedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_acc_corr_reviewed_by`
    FOREIGN KEY (`reviewedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_accrual_correction_evidence` CHECK (
    CHAR_LENGTH(TRIM(`externalEvidenceReference`)) > 0 AND
    CHAR_LENGTH(TRIM(`attachmentUrl`)) > 0
  ),
  CONSTRAINT `chk_accrual_correction_status` CHECK (
    (`status` = 'PENDING' AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `rejectionReason` IS NULL) OR
    (`status` = 'APPROVED' AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `rejectionReason` IS NULL) OR
    (`status` = 'REJECTED' AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND CHAR_LENGTH(TRIM(`rejectionReason`)) > 0)
  ),
  CONSTRAINT `chk_accrual_correction_maker_checker` CHECK (
    `reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`
  ),
  CONSTRAINT `chk_accrual_correction_refund_shape` CHECK (
    (`refundPaymentMethod` IS NULL AND `refundCashBucket` IS NULL AND `refundReferenceNumber` IS NULL AND `refundCardLastFour` IS NULL AND `refundRequestReceiptId` IS NULL) OR
    (`refundPaymentMethod` = 'CASH' AND `refundCashBucket` IS NOT NULL AND `refundReferenceNumber` IS NULL AND `refundCardLastFour` IS NULL) OR
    (`refundPaymentMethod` = 'CARD' AND `refundCashBucket` IS NULL AND `refundCardLastFour` REGEXP '^[0-9]{4}$') OR
    (`refundPaymentMethod` IN ('CHECK','TRANSFER','WALLET') AND `refundCashBucket` IS NULL AND CHAR_LENGTH(TRIM(`refundReferenceNumber`)) > 0 AND `refundCardLastFour` IS NULL)
  ),
  INDEX `idx_accrual_correction_obligation_status` (`obligationId`,`status`),
  INDEX `idx_accrual_correction_refund_receipt` (`refundRequestReceiptId`)
);
--> statement-breakpoint
CREATE TRIGGER `trg_accrual_event_no_update` BEFORE UPDATE ON `accrualObligationEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'accrual obligation events are immutable';
--> statement-breakpoint
CREATE TRIGGER `trg_accrual_event_no_delete` BEFORE DELETE ON `accrualObligationEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'accrual obligation events are append-only';
