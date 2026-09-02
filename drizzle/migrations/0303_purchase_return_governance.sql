-- 0303 — مرتجع شراء محكوم من فاتورة المورد والمطابقة والاستلام، مع عكسٍ مستندي.
-- الطلبات صفر أثر، والاعتماد يتطلب maker-checker وبصمة قرار ثابتة.

CREATE TABLE IF NOT EXISTS `purchaseReturnRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `supplierInvoiceId` BIGINT NOT NULL,
  `matchRunId` BIGINT NOT NULL,
  `purchaseOrderId` BIGINT NOT NULL,
  `supplierId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `baseInvoiceVersion` INT NOT NULL,
  `settlement` ENUM('CREDIT','CASH') NOT NULL DEFAULT 'CREDIT',
  `paymentMethod` ENUM('CASH','CARD','TRANSFER','WALLET') NOT NULL DEFAULT 'CASH',
  `requestedNetAmount` DECIMAL(15,2) NOT NULL,
  `requestedTaxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `requestedTotalAmount` DECIMAL(15,2) NOT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `evidenceType` ENUM('RETURN_NOTE','SUPPLIER_ACKNOWLEDGEMENT','DOCUMENT_IMAGE','PDF','EMAIL','OTHER') NOT NULL,
  `evidenceReference` VARCHAR(500) NOT NULL,
  `evidenceHash` CHAR(64) NOT NULL,
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
  UNIQUE KEY `uq_purchase_return_request_key` (`requestKey`),
  UNIQUE KEY `uq_purchase_return_pending` (`pendingGuard`),
  UNIQUE KEY `uq_purchase_return_decision` (`decisionKey`),
  UNIQUE KEY `uq_purchase_return_request_evidence` (`supplierInvoiceId`,`evidenceHash`),
  KEY `idx_purchase_return_req_invoice_status` (`supplierInvoiceId`,`status`),
  KEY `idx_purchase_return_req_branch_status` (`branchId`,`status`),
  CONSTRAINT `fk_prr_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
  CONSTRAINT `fk_prr_match` FOREIGN KEY (`matchRunId`) REFERENCES `supplierInvoiceMatchRuns` (`id`),
  CONSTRAINT `fk_prr_order` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders` (`id`),
  CONSTRAINT `fk_prr_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_prr_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_prr_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_prr_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_purchase_return_request_amounts` CHECK (`requestedNetAmount` >= 0 AND `requestedTaxAmount` >= 0 AND `requestedTotalAmount` = `requestedNetAmount` + `requestedTaxAmount`),
  CONSTRAINT `chk_purchase_return_request_decision` CHECK (
    (`status` = 'PENDING' AND `pendingGuard` IS NOT NULL AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `decisionKey` IS NULL AND `decisionHash` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_purchase_return_request_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseReturnRequestItems` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestId` BIGINT NOT NULL,
  `lineNo` INT NOT NULL,
  `supplierInvoiceLineId` BIGINT NOT NULL,
  `goodsReceiptItemId` BIGINT NOT NULL,
  `matchAllocationId` BIGINT NOT NULL,
  `purchaseOrderItemId` BIGINT NOT NULL,
  `variantId` BIGINT NOT NULL,
  `requestedBaseQuantity` INT NOT NULL,
  `unitPriceIqd` DECIMAL(15,2) NOT NULL,
  `netAmount` DECIMAL(15,2) NOT NULL,
  `taxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `totalAmount` DECIMAL(15,2) NOT NULL,
  `sourceSnapshot` MEDIUMTEXT NOT NULL,
  `sourceHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_return_request_line` (`requestId`,`lineNo`),
  UNIQUE KEY `uq_purchase_return_request_allocation` (`requestId`,`matchAllocationId`),
  UNIQUE KEY `uq_purchase_return_request_source` (`requestId`,`sourceHash`),
  KEY `idx_purchase_return_req_item_source` (`goodsReceiptItemId`,`supplierInvoiceLineId`),
  CONSTRAINT `fk_prri_request` FOREIGN KEY (`requestId`) REFERENCES `purchaseReturnRequests` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_prri_invoice_line` FOREIGN KEY (`supplierInvoiceLineId`) REFERENCES `supplierInvoiceLines` (`id`),
  CONSTRAINT `fk_prri_grn_item` FOREIGN KEY (`goodsReceiptItemId`) REFERENCES `goodsReceiptItems` (`id`),
  CONSTRAINT `fk_prri_match_alloc` FOREIGN KEY (`matchAllocationId`) REFERENCES `supplierInvoiceMatchAllocations` (`id`),
  CONSTRAINT `fk_prri_po_item` FOREIGN KEY (`purchaseOrderItemId`) REFERENCES `purchaseOrderItems` (`id`),
  CONSTRAINT `fk_prri_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants` (`id`),
  CONSTRAINT `chk_purchase_return_request_item_shape` CHECK (`lineNo` > 0 AND `requestedBaseQuantity` > 0 AND `unitPriceIqd` >= 0 AND `netAmount` >= 0 AND `taxAmount` >= 0 AND `totalAmount` = `netAmount` + `taxAmount`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- MySQL 8 لا يدعم ADD COLUMN IF NOT EXISTS. نضيف المجموعة ذرّياً، ونرفض
-- المخطط الجزئي بدلاً من إخفاء انقطاع هجرة سابقة ثم متابعة ردمٍ غير مأمون.
SET @purchase_return_governance_columns := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'purchaseReturns'
    AND column_name IN (
      'origin','status','version','requestId','supplierInvoiceId','matchRunId',
      'cashRefundReceiptId','payloadCanonical','payloadHash','evidenceType',
      'evidenceReference','postedBy','postedAt'
    )
);
SET @sql := IF(
  @purchase_return_governance_columns = 0,
  'ALTER TABLE `purchaseReturns`
     ADD COLUMN `origin` ENUM(''NATIVE'',''LEGACY'') NOT NULL DEFAULT ''LEGACY'' AFTER `clientRequestId`,
     ADD COLUMN `status` ENUM(''POSTED'',''PARTIALLY_REVERSED'',''REVERSED'') NOT NULL DEFAULT ''POSTED'' AFTER `origin`,
     ADD COLUMN `version` INT NOT NULL DEFAULT 1 AFTER `status`,
     ADD COLUMN `requestId` BIGINT NULL AFTER `version`,
     ADD COLUMN `supplierInvoiceId` BIGINT NULL AFTER `requestId`,
     ADD COLUMN `matchRunId` BIGINT NULL AFTER `supplierInvoiceId`,
     ADD COLUMN `cashRefundReceiptId` BIGINT NULL AFTER `accountingEntryId`,
     ADD COLUMN `payloadCanonical` MEDIUMTEXT NULL AFTER `reason`,
     ADD COLUMN `payloadHash` CHAR(64) NULL AFTER `payloadCanonical`,
     ADD COLUMN `evidenceType` ENUM(''RETURN_NOTE'',''SUPPLIER_ACKNOWLEDGEMENT'',''DOCUMENT_IMAGE'',''PDF'',''EMAIL'',''OTHER'',''LEGACY_LEDGER'') NULL AFTER `payloadHash`,
     ADD COLUMN `evidenceReference` VARCHAR(500) NULL AFTER `evidenceType`,
     ADD COLUMN `postedBy` INT NULL AFTER `evidenceReference`,
     ADD COLUMN `postedAt` TIMESTAMP NULL AFTER `postedBy`',
  IF(
    @purchase_return_governance_columns = 13,
    'SELECT ''purchaseReturns governance columns exist'' AS msg',
    'SELECT 1 FROM `__partial_purchaseReturns_governance_migration__`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

UPDATE `purchaseReturns`
SET `origin` = 'LEGACY',
    `payloadCanonical` = COALESCE(`payloadCanonical`, CAST(JSON_OBJECT('legacy', TRUE, 'purchaseReturnId', `id`, 'accountingEntryId', `accountingEntryId`) AS CHAR CHARACTER SET utf8mb4)),
    `payloadHash` = COALESCE(`payloadHash`, SHA2(CONCAT_WS('|','LEGACY-PURCHASE-RETURN',`id`,`accountingEntryId`,`totalAmount`),256)),
    `evidenceType` = COALESCE(`evidenceType`, 'LEGACY_LEDGER'),
    `evidenceReference` = COALESCE(`evidenceReference`, CONCAT('accountingEntry:', COALESCE(`accountingEntryId`,0))),
    `postedBy` = COALESCE(`postedBy`,`createdBy`),
    `postedAt` = COALESCE(`postedAt`,`createdAt`)
WHERE `requestId` IS NULL;
--> statement-breakpoint

-- مرحلة expansion تبقي الافتراض LEGACY عمداً: عمال الإصدار السابق لا يرسلون origin،
-- بينما الكاتب المحكوم الجديد يكتب NATIVE صراحةً. قلب الافتراض/تشديد القيد لهجرة cutover
-- لاحقة بعد التأكد أن كل العمال القديمة خرجت؛ وإلا أنتج rolling deploy صفوفاً NATIVE ناقصة.

SET @purchase_return_item_governance_columns := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'purchaseReturnItems'
    AND column_name IN (
      'supplierInvoiceLineId','goodsReceiptItemId','matchAllocationId','inventoryMovementId'
    )
);
SET @sql := IF(
  @purchase_return_item_governance_columns = 0,
  'ALTER TABLE `purchaseReturnItems`
     ADD COLUMN `supplierInvoiceLineId` BIGINT NULL AFTER `purchaseOrderItemId`,
     ADD COLUMN `goodsReceiptItemId` BIGINT NULL AFTER `supplierInvoiceLineId`,
     ADD COLUMN `matchAllocationId` BIGINT NULL AFTER `goodsReceiptItemId`,
     ADD COLUMN `inventoryMovementId` BIGINT NULL AFTER `lineTotal`',
  IF(
    @purchase_return_item_governance_columns = 4,
    'SELECT ''purchaseReturnItems governance columns exist'' AS msg',
    'SELECT 1 FROM `__partial_purchaseReturnItems_governance_migration__`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_pr_request_uq := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'purchaseReturns' AND index_name = 'uq_purchase_return_request');
SET @sql := IF(@has_pr_request_uq = 0, 'ALTER TABLE `purchaseReturns` ADD UNIQUE INDEX `uq_purchase_return_request` (`requestId`)', 'SELECT ''uq_purchase_return_request exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_pr_cash_uq := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'purchaseReturns' AND index_name = 'uq_purchase_return_cash_receipt');
SET @sql := IF(@has_pr_cash_uq = 0, 'ALTER TABLE `purchaseReturns` ADD UNIQUE INDEX `uq_purchase_return_cash_receipt` (`cashRefundReceiptId`)', 'SELECT ''uq_purchase_return_cash_receipt exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_pr_move_uq := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'purchaseReturnItems' AND index_name = 'uq_purchase_return_inventory_movement');
SET @sql := IF(@has_pr_move_uq = 0, 'ALTER TABLE `purchaseReturnItems` ADD UNIQUE INDEX `uq_purchase_return_inventory_movement` (`inventoryMovementId`)', 'SELECT ''uq_purchase_return_inventory_movement exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_pr_new_fks := (
  SELECT COUNT(*) FROM information_schema.key_column_usage
  WHERE table_schema = DATABASE() AND table_name = 'purchaseReturns'
    AND column_name IN ('requestId','supplierInvoiceId','matchRunId','cashRefundReceiptId','postedBy')
    AND referenced_table_name IS NOT NULL
);
SET @sql := IF(@has_pr_new_fks = 0,
  'ALTER TABLE `purchaseReturns`
     ADD CONSTRAINT `fk_pr_request` FOREIGN KEY (`requestId`) REFERENCES `purchaseReturnRequests` (`id`),
     ADD CONSTRAINT `fk_pr_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
     ADD CONSTRAINT `fk_pr_match` FOREIGN KEY (`matchRunId`) REFERENCES `supplierInvoiceMatchRuns` (`id`),
     ADD CONSTRAINT `fk_pr_cash_receipt` FOREIGN KEY (`cashRefundReceiptId`) REFERENCES `receipts` (`id`),
     ADD CONSTRAINT `fk_pr_poster` FOREIGN KEY (`postedBy`) REFERENCES `users` (`id`)',
  'SELECT ''purchaseReturns governance foreign keys exist'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_pri_new_fks := (
  SELECT COUNT(*) FROM information_schema.key_column_usage
  WHERE table_schema = DATABASE() AND table_name = 'purchaseReturnItems'
    AND column_name IN ('supplierInvoiceLineId','goodsReceiptItemId','matchAllocationId','inventoryMovementId')
    AND referenced_table_name IS NOT NULL
);
SET @sql := IF(@has_pri_new_fks = 0,
  'ALTER TABLE `purchaseReturnItems`
     ADD CONSTRAINT `fk_pri_invoice_line` FOREIGN KEY (`supplierInvoiceLineId`) REFERENCES `supplierInvoiceLines` (`id`),
     ADD CONSTRAINT `fk_pri_grn_item` FOREIGN KEY (`goodsReceiptItemId`) REFERENCES `goodsReceiptItems` (`id`),
     ADD CONSTRAINT `fk_pri_match_alloc` FOREIGN KEY (`matchAllocationId`) REFERENCES `supplierInvoiceMatchAllocations` (`id`),
     ADD CONSTRAINT `fk_pri_movement` FOREIGN KEY (`inventoryMovementId`) REFERENCES `inventoryMovements` (`id`)',
  'SELECT ''purchaseReturnItems governance foreign keys exist'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_pr_checks := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE() AND table_name = 'purchaseReturns'
    AND constraint_name IN ('chk_purchase_return_native_source','chk_purchase_return_amounts','chk_purchase_return_cash_receipt')
);
SET @sql := IF(@has_pr_checks = 0,
  'ALTER TABLE `purchaseReturns`
     ADD CONSTRAINT `chk_purchase_return_native_source` CHECK (`origin` = ''LEGACY'' OR (`requestId` IS NOT NULL AND `supplierInvoiceId` IS NOT NULL AND `matchRunId` IS NOT NULL AND `payloadCanonical` IS NOT NULL AND `payloadHash` IS NOT NULL AND `evidenceType` IS NOT NULL AND `evidenceReference` IS NOT NULL AND `postedBy` IS NOT NULL AND `postedAt` IS NOT NULL)),
     ADD CONSTRAINT `chk_purchase_return_amounts` CHECK (`netAmount` >= 0 AND `taxAmount` >= 0 AND `totalAmount` = `netAmount` + `taxAmount` AND `cashRefundAmount` >= 0 AND `creditOffsetAmount` >= 0 AND `cashRefundAmount` + `creditOffsetAmount` = `totalAmount`),
     ADD CONSTRAINT `chk_purchase_return_cash_receipt` CHECK (`origin` = ''LEGACY'' OR ((`cashRefundAmount` = 0 AND `cashRefundReceiptId` IS NULL) OR (`cashRefundAmount` > 0 AND `cashRefundReceiptId` IS NOT NULL)))',
  'SELECT ''purchaseReturns governance checks exist'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_pri_checks := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE() AND table_name = 'purchaseReturnItems'
    AND constraint_name IN ('chk_purchase_return_item_source','chk_purchase_return_item_amounts')
);
SET @sql := IF(@has_pri_checks = 0,
  'ALTER TABLE `purchaseReturnItems`
     ADD CONSTRAINT `chk_purchase_return_item_source` CHECK ((`supplierInvoiceLineId` IS NULL AND `goodsReceiptItemId` IS NULL AND `matchAllocationId` IS NULL) OR (`supplierInvoiceLineId` IS NOT NULL AND `goodsReceiptItemId` IS NOT NULL AND `matchAllocationId` IS NOT NULL)),
     ADD CONSTRAINT `chk_purchase_return_item_amounts` CHECK (`quantity` > 0 AND `baseQuantity` > 0 AND `unitPrice` >= 0 AND `lineTotal` >= 0)',
  'SELECT ''purchaseReturnItems governance checks exist'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_pr_invoice_idx := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'purchaseReturns' AND index_name = 'idx_purchase_return_invoice_status');
SET @sql := IF(@has_pr_invoice_idx = 0, 'ALTER TABLE `purchaseReturns` ADD INDEX `idx_purchase_return_invoice_status` (`supplierInvoiceId`,`status`)', 'SELECT ''idx_purchase_return_invoice_status exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_pri_source_idx := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'purchaseReturnItems' AND index_name = 'idx_purchase_return_item_source');
SET @sql := IF(@has_pri_source_idx = 0, 'ALTER TABLE `purchaseReturnItems` ADD INDEX `idx_purchase_return_item_source` (`supplierInvoiceLineId`,`goodsReceiptItemId`)', 'SELECT ''idx_purchase_return_item_source exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseReturnReversalRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `purchaseReturnId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `baseReturnVersion` INT NOT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `evidenceType` ENUM('SUPPLIER_ACKNOWLEDGEMENT','DOCUMENT_IMAGE','PDF','EMAIL','SIGNED_APPROVAL','OTHER') NOT NULL,
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
  UNIQUE KEY `uq_purchase_return_reversal_request_key` (`requestKey`),
  UNIQUE KEY `uq_purchase_return_reversal_pending` (`pendingGuard`),
  UNIQUE KEY `uq_purchase_return_reversal_decision` (`decisionKey`),
  KEY `idx_purchase_return_rev_req_status` (`purchaseReturnId`,`status`),
  KEY `idx_purchase_return_rev_branch_status` (`branchId`,`status`),
  CONSTRAINT `fk_prrev_req_return` FOREIGN KEY (`purchaseReturnId`) REFERENCES `purchaseReturns` (`id`),
  CONSTRAINT `fk_prrev_req_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_prrev_req_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_prrev_req_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_purchase_return_reversal_decision` CHECK (
    (`status` = 'PENDING' AND `pendingGuard` IS NOT NULL AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `decisionKey` IS NULL AND `decisionHash` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_purchase_return_reversal_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseReturnReversalRequestItems` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestId` BIGINT NOT NULL,
  `purchaseReturnItemId` BIGINT NOT NULL,
  `baseQuantity` INT NOT NULL,
  `reason` VARCHAR(500) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_return_reversal_req_item` (`requestId`,`purchaseReturnItemId`),
  CONSTRAINT `fk_prrev_req_item_req` FOREIGN KEY (`requestId`) REFERENCES `purchaseReturnReversalRequests` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_prrev_req_item_return` FOREIGN KEY (`purchaseReturnItemId`) REFERENCES `purchaseReturnItems` (`id`),
  CONSTRAINT `chk_purchase_return_reversal_req_qty` CHECK (`baseQuantity` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseReturnReversals` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `reversalNumber` VARCHAR(50) NOT NULL,
  `requestId` BIGINT NOT NULL,
  `purchaseReturnId` BIGINT NOT NULL,
  `supplierInvoiceId` BIGINT NOT NULL,
  `supplierId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `netAmount` DECIMAL(15,2) NOT NULL,
  `taxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `totalAmount` DECIMAL(15,2) NOT NULL,
  `accountingEntryId` BIGINT NOT NULL,
  `cashRepaymentReceiptId` BIGINT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `postedBy` INT NOT NULL,
  `postedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_return_reversal_number` (`reversalNumber`),
  UNIQUE KEY `uq_purchase_return_reversal_request` (`requestId`),
  UNIQUE KEY `uq_purchase_return_reversal_entry` (`accountingEntryId`),
  UNIQUE KEY `uq_purchase_return_reversal_receipt` (`cashRepaymentReceiptId`),
  UNIQUE KEY `uq_purchase_return_reversal_hash` (`payloadHash`),
  KEY `idx_purchase_return_reversal_date` (`purchaseReturnId`,`postedAt`),
  CONSTRAINT `fk_prrev_request` FOREIGN KEY (`requestId`) REFERENCES `purchaseReturnReversalRequests` (`id`),
  CONSTRAINT `fk_prrev_return` FOREIGN KEY (`purchaseReturnId`) REFERENCES `purchaseReturns` (`id`),
  CONSTRAINT `fk_prrev_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
  CONSTRAINT `fk_prrev_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_prrev_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_prrev_entry` FOREIGN KEY (`accountingEntryId`) REFERENCES `accountingEntries` (`id`),
  CONSTRAINT `fk_prrev_receipt` FOREIGN KEY (`cashRepaymentReceiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `fk_prrev_poster` FOREIGN KEY (`postedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_purchase_return_reversal_amounts` CHECK (`netAmount` >= 0 AND `taxAmount` >= 0 AND `totalAmount` = `netAmount` + `taxAmount`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseReturnReversalItems` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `reversalId` BIGINT NOT NULL,
  `purchaseReturnItemId` BIGINT NOT NULL,
  `baseQuantity` INT NOT NULL,
  `netAmount` DECIMAL(15,2) NOT NULL,
  `taxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `totalAmount` DECIMAL(15,2) NOT NULL,
  `inventoryMovementId` BIGINT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_return_reversal_movement` (`inventoryMovementId`),
  UNIQUE KEY `uq_purchase_return_reversal_item` (`reversalId`,`purchaseReturnItemId`),
  CONSTRAINT `fk_prrev_item_doc` FOREIGN KEY (`reversalId`) REFERENCES `purchaseReturnReversals` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_prrev_item_return_item` FOREIGN KEY (`purchaseReturnItemId`) REFERENCES `purchaseReturnItems` (`id`),
  CONSTRAINT `fk_prrev_item_movement` FOREIGN KEY (`inventoryMovementId`) REFERENCES `inventoryMovements` (`id`),
  CONSTRAINT `chk_purchase_return_reversal_item_shape` CHECK (`baseQuantity` > 0 AND `netAmount` >= 0 AND `taxAmount` >= 0 AND `totalAmount` = `netAmount` + `taxAmount`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_purchase_returns_version_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_purchase_returns_version_bu`
BEFORE UPDATE ON `purchaseReturns`
FOR EACH ROW
BEGIN
  SET NEW.`version` = OLD.`version` + 1;
END;
