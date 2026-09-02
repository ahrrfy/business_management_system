-- 0305 — مصروفات شراء مثبتة بالدليل، تُقيّد EXPENSE ولا تُرسمل على المخزون.

CREATE TABLE IF NOT EXISTS `purchaseCharges` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `chargeNumber` VARCHAR(60) NOT NULL,
  `clientRequestId` VARCHAR(120) NOT NULL,
  `branchId` BIGINT NOT NULL,
  `payeeSupplierId` BIGINT NULL,
  `expenseAccountId` BIGINT NOT NULL,
  `chargeType` ENUM('SHIPPING','CUSTOMS','FREIGHT','INSURANCE','INSPECTION','OTHER') NOT NULL,
  `settlement` ENUM('PAID','PAYABLE') NOT NULL,
  `paymentMethod` ENUM('CASH','CARD','TRANSFER','WALLET') NULL,
  `status` ENUM('DRAFT','POSTED','REVERSED') NOT NULL DEFAULT 'DRAFT',
  `version` INT NOT NULL DEFAULT 1,
  `amount` DECIMAL(15,2) NOT NULL,
  `expenseDate` DATE NOT NULL,
  `externalReference` VARCHAR(160) NULL,
  `evidenceType` ENUM('SUPPLIER_INVOICE','CARRIER_INVOICE','CUSTOMS_RECEIPT','BANK_ADVICE','DOCUMENT_IMAGE','PDF','OTHER') NOT NULL,
  `evidenceReference` VARCHAR(500) NOT NULL,
  `evidenceHash` CHAR(64) NOT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `postingEntryId` BIGINT NULL,
  `paymentReceiptId` BIGINT NULL,
  `reversalEntryId` BIGINT NULL,
  `reversalReceiptId` BIGINT NULL,
  `createdBy` INT NOT NULL,
  `postedBy` INT NULL,
  `postedAt` TIMESTAMP NULL,
  `reversedBy` INT NULL,
  `reversedAt` TIMESTAMP NULL,
  `reversalReason` VARCHAR(500) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_charge_number` (`chargeNumber`),
  UNIQUE KEY `uq_purchase_charge_request` (`clientRequestId`),
  UNIQUE KEY `uq_purchase_charge_posting_entry` (`postingEntryId`),
  UNIQUE KEY `uq_purchase_charge_payment_receipt` (`paymentReceiptId`),
  UNIQUE KEY `uq_purchase_charge_reversal_entry` (`reversalEntryId`),
  UNIQUE KEY `uq_purchase_charge_reversal_receipt` (`reversalReceiptId`),
  UNIQUE KEY `uq_purchase_charge_evidence` (`payeeSupplierId`,`evidenceHash`),
  KEY `idx_purchase_charge_branch_status` (`branchId`,`status`),
  KEY `idx_purchase_charge_account_date` (`expenseAccountId`,`expenseDate`),
  CONSTRAINT `fk_pcharge_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_pcharge_supplier` FOREIGN KEY (`payeeSupplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_pcharge_account` FOREIGN KEY (`expenseAccountId`) REFERENCES `accounts` (`id`),
  CONSTRAINT `fk_pcharge_post_entry` FOREIGN KEY (`postingEntryId`) REFERENCES `accountingEntries` (`id`),
  CONSTRAINT `fk_pcharge_pay_receipt` FOREIGN KEY (`paymentReceiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `fk_pcharge_rev_entry` FOREIGN KEY (`reversalEntryId`) REFERENCES `accountingEntries` (`id`),
  CONSTRAINT `fk_pcharge_rev_receipt` FOREIGN KEY (`reversalReceiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `fk_pcharge_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_pcharge_poster` FOREIGN KEY (`postedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_pcharge_reverser` FOREIGN KEY (`reversedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_purchase_charge_amount` CHECK (`amount` > 0),
  CONSTRAINT `chk_purchase_charge_settlement` CHECK ((`settlement` = 'PAYABLE' AND `payeeSupplierId` IS NOT NULL AND `paymentMethod` IS NULL AND `paymentReceiptId` IS NULL) OR (`settlement` = 'PAID' AND `paymentMethod` IS NOT NULL)),
  CONSTRAINT `chk_purchase_charge_lifecycle` CHECK (
    (`status` = 'DRAFT' AND `postingEntryId` IS NULL AND `postedBy` IS NULL AND `postedAt` IS NULL AND `reversalEntryId` IS NULL AND `reversedBy` IS NULL AND `reversedAt` IS NULL)
    OR (`status` = 'POSTED' AND `postingEntryId` IS NOT NULL AND `postedBy` IS NOT NULL AND `postedAt` IS NOT NULL AND (`settlement` = 'PAYABLE' OR `paymentReceiptId` IS NOT NULL) AND `reversalEntryId` IS NULL AND `reversedBy` IS NULL AND `reversedAt` IS NULL)
    OR (`status` = 'REVERSED' AND `postingEntryId` IS NOT NULL AND `postedAt` IS NOT NULL AND `reversalEntryId` IS NOT NULL AND `reversedBy` IS NOT NULL AND `reversedAt` IS NOT NULL AND `reversalReason` IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseChargeAllocations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `purchaseChargeId` BIGINT NOT NULL,
  `lineNo` INT NOT NULL,
  `purchaseOrderId` BIGINT NULL,
  `goodsReceiptId` BIGINT NULL,
  `supplierInvoiceId` BIGINT NULL,
  `allocatedAmount` DECIMAL(15,2) NOT NULL,
  `sourceSnapshot` MEDIUMTEXT NOT NULL,
  `sourceHash` CHAR(64) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_charge_allocation_line` (`purchaseChargeId`,`lineNo`),
  UNIQUE KEY `uq_purchase_charge_allocation_source` (`purchaseChargeId`,`sourceHash`),
  KEY `idx_purchase_charge_allocation_source` (`purchaseOrderId`,`goodsReceiptId`,`supplierInvoiceId`),
  CONSTRAINT `fk_pcharge_alloc_charge` FOREIGN KEY (`purchaseChargeId`) REFERENCES `purchaseCharges` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pcharge_alloc_po` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders` (`id`),
  CONSTRAINT `fk_pcharge_alloc_grn` FOREIGN KEY (`goodsReceiptId`) REFERENCES `goodsReceipts` (`id`),
  CONSTRAINT `fk_pcharge_alloc_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
  CONSTRAINT `chk_purchase_charge_allocation_source` CHECK (`lineNo` > 0 AND `allocatedAmount` > 0 AND (`purchaseOrderId` IS NOT NULL OR `goodsReceiptId` IS NOT NULL OR `supplierInvoiceId` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseChargeControlRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `purchaseChargeId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `kind` ENUM('POST','REVERSE') NOT NULL,
  `baseChargeVersion` INT NOT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `evidenceReference` VARCHAR(500) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `status` ENUM('PENDING','APPROVED','REJECTED','STALE') NOT NULL DEFAULT 'PENDING',
  `pendingGuard` VARCHAR(180) NULL,
  `requestedBy` INT NOT NULL,
  `requestedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reviewedBy` INT NULL,
  `reviewedAt` TIMESTAMP NULL,
  `reviewReason` VARCHAR(500) NULL,
  `decisionKey` VARCHAR(120) NULL,
  `decisionHash` CHAR(64) NULL,
  `appliedAt` TIMESTAMP NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_charge_control_request` (`requestKey`),
  UNIQUE KEY `uq_purchase_charge_control_pending` (`pendingGuard`),
  UNIQUE KEY `uq_purchase_charge_control_decision` (`decisionKey`),
  KEY `idx_purchase_charge_control_status` (`purchaseChargeId`,`status`),
  KEY `idx_purchase_charge_control_branch` (`branchId`,`status`),
  CONSTRAINT `fk_pcharge_ctl_charge` FOREIGN KEY (`purchaseChargeId`) REFERENCES `purchaseCharges` (`id`),
  CONSTRAINT `fk_pcharge_ctl_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_pcharge_ctl_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_pcharge_ctl_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_purchase_charge_control_decision` CHECK (
    (`status` = 'PENDING' AND `pendingGuard` IS NOT NULL AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `decisionKey` IS NULL AND `decisionHash` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_purchase_charge_control_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_purchase_charges_expense_bi`;
--> statement-breakpoint

CREATE TRIGGER `trg_purchase_charges_expense_bi`
BEFORE INSERT ON `purchaseCharges`
FOR EACH ROW
BEGIN
  DECLARE v_type VARCHAR(20);
  DECLARE v_active TINYINT;
  SELECT `type`,`isActive` INTO v_type,v_active FROM `accounts` WHERE `id` = NEW.`expenseAccountId`;
  IF v_type <> 'EXPENSE' OR v_active <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase charge requires active EXPENSE account';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_purchase_charges_expense_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_purchase_charges_expense_bu`
BEFORE UPDATE ON `purchaseCharges`
FOR EACH ROW
BEGIN
  DECLARE v_type VARCHAR(20);
  DECLARE v_active TINYINT;
  SELECT `type`,`isActive` INTO v_type,v_active FROM `accounts` WHERE `id` = NEW.`expenseAccountId`;
  IF v_type <> 'EXPENSE' OR v_active <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase charge requires active EXPENSE account';
  END IF;
  SET NEW.`version` = OLD.`version` + 1;
END;
