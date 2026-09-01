-- 0304 — طلبات سداد المورد، تخصيصات AP المادية، واستردادات السداد المحكومة.

-- هذه ليست دفعات منشأة رجعياً: كل صف يثبت قيداً وإيصالاً موجودين فعلاً، ولا يحمل
-- requestedBy/approvedBy. لا يُملأ إلا إذا كانت فاتورة LEGACY_AP وحيدة لأمر الشراء.
CREATE TABLE IF NOT EXISTS `legacySupplierInvoiceSettlements` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `supplierInvoiceId` BIGINT NOT NULL,
  `sourceAccountingEntryId` BIGINT NOT NULL,
  `sourceReceiptId` BIGINT NOT NULL,
  `direction` ENUM('PAYMENT_OUT','PAYMENT_IN') NOT NULL,
  `amount` DECIMAL(15,2) NOT NULL,
  `evidenceSnapshot` MEDIUMTEXT NOT NULL,
  `evidenceHash` CHAR(64) NOT NULL,
  `materializedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_legacy_supplier_settlement_entry` (`sourceAccountingEntryId`),
  UNIQUE KEY `uq_legacy_supplier_settlement_evidence` (`evidenceHash`),
  KEY `idx_legacy_supplier_settlement_invoice` (`supplierInvoiceId`,`materializedAt`),
  KEY `idx_legacy_supplier_settlement_receipt` (`sourceReceiptId`),
  CONSTRAINT `fk_lsis_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
  CONSTRAINT `fk_lsis_entry` FOREIGN KEY (`sourceAccountingEntryId`) REFERENCES `accountingEntries` (`id`),
  CONSTRAINT `fk_lsis_receipt` FOREIGN KEY (`sourceReceiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `chk_legacy_supplier_settlement_amount` CHECK (`amount` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierPaymentRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `supplierId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `currency` ENUM('IQD','USD') NOT NULL,
  `exchangeRate` DECIMAL(15,4) NULL,
  `requestedAmount` DECIMAL(15,2) NOT NULL,
  `requestedCurrencyAmount` DECIMAL(15,2) NOT NULL,
  `paymentMethod` ENUM('CASH','CARD','TRANSFER','WALLET') NOT NULL,
  `externalReference` VARCHAR(160) NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `evidenceType` ENUM('PAYMENT_ORDER','BANK_ADVICE','TRANSFER_RECEIPT','CASH_ACKNOWLEDGEMENT','DOCUMENT_IMAGE','PDF','OTHER') NOT NULL,
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
  UNIQUE KEY `uq_supplier_payment_request_key` (`requestKey`),
  UNIQUE KEY `uq_supplier_payment_pending` (`pendingGuard`),
  UNIQUE KEY `uq_supplier_payment_decision` (`decisionKey`),
  UNIQUE KEY `uq_supplier_payment_request_evidence` (`supplierId`,`evidenceHash`),
  KEY `idx_supplier_payment_req_branch_status` (`branchId`,`status`),
  KEY `idx_supplier_payment_req_supplier_status` (`supplierId`,`status`),
  CONSTRAINT `fk_spreq_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_spreq_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_spreq_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_spreq_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_supplier_payment_request_amounts` CHECK (`requestedAmount` > 0 AND `requestedCurrencyAmount` > 0 AND ((`currency` = 'IQD' AND `exchangeRate` IS NULL AND `requestedAmount` = `requestedCurrencyAmount`) OR (`currency` = 'USD' AND `exchangeRate` IS NOT NULL AND `exchangeRate` > 0))),
  CONSTRAINT `chk_supplier_payment_request_evidence` CHECK (CHAR_LENGTH(TRIM(`evidenceReference`)) > 0 AND (`paymentMethod` = 'CASH' OR (`externalReference` IS NOT NULL AND CHAR_LENGTH(TRIM(`externalReference`)) > 0))),
  CONSTRAINT `chk_supplier_payment_request_decision` CHECK (
    (`status` = 'PENDING' AND `pendingGuard` IS NOT NULL AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `decisionKey` IS NULL AND `decisionHash` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_supplier_payment_request_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierPaymentRequestAllocations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestId` BIGINT NOT NULL,
  `supplierInvoiceId` BIGINT NOT NULL,
  `activeInvoiceGuard` BIGINT NULL,
  `invoiceVersion` INT NOT NULL,
  `requestedAmount` DECIMAL(15,2) NOT NULL,
  `requestedCurrencyAmount` DECIMAL(15,2) NOT NULL,
  `invoiceSnapshot` MEDIUMTEXT NOT NULL,
  `invoiceHash` CHAR(64) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_payment_req_invoice` (`requestId`,`supplierInvoiceId`),
  UNIQUE KEY `uq_supplier_payment_active_invoice` (`activeInvoiceGuard`),
  KEY `idx_supplier_payment_req_alloc_invoice` (`supplierInvoiceId`),
  CONSTRAINT `fk_spreq_alloc_req` FOREIGN KEY (`requestId`) REFERENCES `supplierPaymentRequests` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_spreq_alloc_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
  CONSTRAINT `chk_supplier_payment_req_alloc_amount` CHECK (`requestedAmount` > 0 AND `requestedCurrencyAmount` > 0 AND `invoiceVersion` > 0),
  CONSTRAINT `chk_supplier_payment_active_invoice` CHECK (`activeInvoiceGuard` IS NULL OR `activeInvoiceGuard` = `supplierInvoiceId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierPayments` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `paymentNumber` VARCHAR(60) NOT NULL,
  `requestId` BIGINT NOT NULL,
  `supplierId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `status` ENUM('POSTED','PARTIALLY_REFUNDED','REFUNDED') NOT NULL DEFAULT 'POSTED',
  `version` INT NOT NULL DEFAULT 1,
  `currency` ENUM('IQD','USD') NOT NULL,
  `exchangeRate` DECIMAL(15,4) NULL,
  `amount` DECIMAL(15,2) NOT NULL,
  `currencyAmount` DECIMAL(15,2) NOT NULL,
  `paymentMethod` ENUM('CASH','CARD','TRANSFER','WALLET') NOT NULL,
  `externalReference` VARCHAR(160) NULL,
  `receiptId` BIGINT NOT NULL,
  `accountingEntryId` BIGINT NOT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `postedBy` INT NOT NULL,
  `postedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_payment_number` (`paymentNumber`),
  UNIQUE KEY `uq_supplier_payment_request` (`requestId`),
  UNIQUE KEY `uq_supplier_payment_receipt` (`receiptId`),
  UNIQUE KEY `uq_supplier_payment_entry` (`accountingEntryId`),
  UNIQUE KEY `uq_supplier_payment_hash` (`payloadHash`),
  KEY `idx_supplier_payment_supplier_date` (`supplierId`,`postedAt`),
  KEY `idx_supplier_payment_branch_status` (`branchId`,`status`),
  CONSTRAINT `fk_sp_request` FOREIGN KEY (`requestId`) REFERENCES `supplierPaymentRequests` (`id`),
  CONSTRAINT `fk_sp_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_sp_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_sp_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `fk_sp_entry` FOREIGN KEY (`accountingEntryId`) REFERENCES `accountingEntries` (`id`),
  CONSTRAINT `fk_sp_poster` FOREIGN KEY (`postedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_supplier_payment_amounts` CHECK (`amount` > 0 AND `currencyAmount` > 0 AND ((`currency` = 'IQD' AND `exchangeRate` IS NULL AND `amount` = `currencyAmount`) OR (`currency` = 'USD' AND `exchangeRate` IS NOT NULL AND `exchangeRate` > 0))),
  CONSTRAINT `chk_supplier_payment_external_reference` CHECK (`paymentMethod` = 'CASH' OR (`externalReference` IS NOT NULL AND CHAR_LENGTH(TRIM(`externalReference`)) > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierPaymentAllocations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `supplierPaymentId` BIGINT NOT NULL,
  `requestAllocationId` BIGINT NOT NULL,
  `supplierInvoiceId` BIGINT NOT NULL,
  `allocatedAmount` DECIMAL(15,2) NOT NULL,
  `allocatedCurrencyAmount` DECIMAL(15,2) NOT NULL,
  `refundedAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `refundedCurrencyAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `invoiceHash` CHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_payment_request_allocation` (`requestAllocationId`),
  UNIQUE KEY `uq_supplier_payment_allocation_invoice` (`supplierPaymentId`,`supplierInvoiceId`),
  KEY `idx_supplier_payment_alloc_invoice` (`supplierInvoiceId`),
  CONSTRAINT `fk_spalloc_payment` FOREIGN KEY (`supplierPaymentId`) REFERENCES `supplierPayments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_spalloc_request_alloc` FOREIGN KEY (`requestAllocationId`) REFERENCES `supplierPaymentRequestAllocations` (`id`),
  CONSTRAINT `fk_spalloc_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
  CONSTRAINT `chk_supplier_payment_allocation_amounts` CHECK (`allocatedAmount` > 0 AND `allocatedCurrencyAmount` > 0 AND `refundedAmount` >= 0 AND `refundedCurrencyAmount` >= 0 AND `refundedAmount` <= `allocatedAmount` AND `refundedCurrencyAmount` <= `allocatedCurrencyAmount`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierPaymentRefundRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `supplierPaymentId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `basePaymentVersion` INT NOT NULL,
  `requestedAmount` DECIMAL(15,2) NOT NULL,
  `requestedCurrencyAmount` DECIMAL(15,2) NOT NULL,
  `refundMethod` ENUM('CASH','CARD','TRANSFER','WALLET') NOT NULL,
  `externalReference` VARCHAR(160) NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `evidenceType` ENUM('SUPPLIER_ACKNOWLEDGEMENT','BANK_ADVICE','TRANSFER_RECEIPT','CASH_RECEIPT','DOCUMENT_IMAGE','PDF','OTHER') NOT NULL,
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
  UNIQUE KEY `uq_supplier_payment_refund_request_key` (`requestKey`),
  UNIQUE KEY `uq_supplier_payment_refund_pending` (`pendingGuard`),
  UNIQUE KEY `uq_supplier_payment_refund_decision` (`decisionKey`),
  KEY `idx_supplier_payment_refund_status` (`supplierPaymentId`,`status`),
  KEY `idx_sprefund_branch_status_requested` (`branchId`,`status`,`requestedAt`,`id`),
  KEY `idx_sprefund_status_requested` (`status`,`requestedAt`,`id`),
  CONSTRAINT `fk_sprefund_req_payment` FOREIGN KEY (`supplierPaymentId`) REFERENCES `supplierPayments` (`id`),
  CONSTRAINT `fk_sprefund_req_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_sprefund_req_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_sprefund_req_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_supplier_payment_refund_request_amounts` CHECK (`requestedAmount` > 0 AND `requestedCurrencyAmount` > 0 AND `basePaymentVersion` > 0),
  CONSTRAINT `chk_supplier_payment_refund_decision` CHECK (
    (`status` = 'PENDING' AND `pendingGuard` IS NOT NULL AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `decisionKey` IS NULL AND `decisionHash` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_supplier_payment_refund_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierPaymentRefundRequestItems` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestId` BIGINT NOT NULL,
  `supplierPaymentAllocationId` BIGINT NOT NULL,
  `amount` DECIMAL(15,2) NOT NULL,
  `currencyAmount` DECIMAL(15,2) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_payment_refund_req_alloc` (`requestId`,`supplierPaymentAllocationId`),
  CONSTRAINT `fk_sprefund_req_item_req` FOREIGN KEY (`requestId`) REFERENCES `supplierPaymentRefundRequests` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sprefund_req_item_alloc` FOREIGN KEY (`supplierPaymentAllocationId`) REFERENCES `supplierPaymentAllocations` (`id`),
  CONSTRAINT `chk_supplier_payment_refund_req_item_amount` CHECK (`amount` > 0 AND `currencyAmount` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierPaymentRefunds` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `refundNumber` VARCHAR(60) NOT NULL,
  `requestId` BIGINT NOT NULL,
  `supplierPaymentId` BIGINT NOT NULL,
  `supplierId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `amount` DECIMAL(15,2) NOT NULL,
  `currencyAmount` DECIMAL(15,2) NOT NULL,
  `receiptId` BIGINT NOT NULL,
  `accountingEntryId` BIGINT NOT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `postedBy` INT NOT NULL,
  `postedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_payment_refund_number` (`refundNumber`),
  UNIQUE KEY `uq_supplier_payment_refund_request` (`requestId`),
  UNIQUE KEY `uq_supplier_payment_refund_receipt` (`receiptId`),
  UNIQUE KEY `uq_supplier_payment_refund_entry` (`accountingEntryId`),
  UNIQUE KEY `uq_supplier_payment_refund_hash` (`payloadHash`),
  KEY `idx_supplier_payment_refund_date` (`supplierPaymentId`,`postedAt`),
  CONSTRAINT `fk_sprefund_request` FOREIGN KEY (`requestId`) REFERENCES `supplierPaymentRefundRequests` (`id`),
  CONSTRAINT `fk_sprefund_payment` FOREIGN KEY (`supplierPaymentId`) REFERENCES `supplierPayments` (`id`),
  CONSTRAINT `fk_sprefund_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_sprefund_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_sprefund_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `fk_sprefund_entry` FOREIGN KEY (`accountingEntryId`) REFERENCES `accountingEntries` (`id`),
  CONSTRAINT `fk_sprefund_poster` FOREIGN KEY (`postedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_supplier_payment_refund_amounts` CHECK (`amount` > 0 AND `currencyAmount` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierPaymentRefundItems` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `refundId` BIGINT NOT NULL,
  `supplierPaymentAllocationId` BIGINT NOT NULL,
  `amount` DECIMAL(15,2) NOT NULL,
  `currencyAmount` DECIMAL(15,2) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_payment_refund_allocation` (`refundId`,`supplierPaymentAllocationId`),
  CONSTRAINT `fk_sprefund_item_doc` FOREIGN KEY (`refundId`) REFERENCES `supplierPaymentRefunds` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sprefund_item_alloc` FOREIGN KEY (`supplierPaymentAllocationId`) REFERENCES `supplierPaymentAllocations` (`id`),
  CONSTRAINT `chk_supplier_payment_refund_item_amount` CHECK (`amount` > 0 AND `currencyAmount` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

DROP TEMPORARY TABLE IF EXISTS `_legacy_ap_assessment_0304`;
--> statement-breakpoint

CREATE TEMPORARY TABLE `_legacy_ap_assessment_0304` AS
SELECT
  si.`id` AS `supplierInvoiceId`,
  si.`legacyPurchaseOrderId` AS `purchaseOrderId`,
  si.`supplierId`,
  si.`branchId`,
  si.`totalAmount`,
  (SELECT COUNT(*)
     FROM `supplierInvoices` peer
    WHERE peer.`origin` = 'LEGACY'
      AND peer.`liabilityClass` IN ('LEGACY_AP','LEGACY_UNKNOWN')
      AND peer.`legacyPurchaseOrderId` = si.`legacyPurchaseOrderId`) AS `candidateInvoiceCount`,
  EXISTS (
    SELECT 1
    FROM `accountingEntries` sourceEntry
    JOIN `purchaseOrders` sourceOrder ON sourceOrder.`id` = sourceEntry.`purchaseOrderId`
    WHERE sourceEntry.`id` = si.`postingEntryId`
      AND sourceEntry.`entryType` = 'PURCHASE'
      AND sourceEntry.`purchaseLiabilityAccount` = 'AP'
      AND (sourceEntry.`supplierId` IS NULL OR sourceEntry.`supplierId` = sourceOrder.`supplierId`)
      AND sourceEntry.`branchId` = sourceOrder.`branchId`
      AND si.`supplierId` = sourceOrder.`supplierId`
      AND si.`branchId` = sourceOrder.`branchId`
  ) AS `sourceAttributionValid`,
  (SELECT COUNT(*)
     FROM `accountingEntries` pe
     LEFT JOIN `receipts` pr ON pr.`id` = pe.`receiptId`
    WHERE pe.`purchaseOrderId` = si.`legacyPurchaseOrderId`
      AND pe.`entryType` IN ('PAYMENT_OUT','PAYMENT_IN')
      AND NOT (
        pe.`purchaseLiabilityAccount` = 'AP'
        AND pe.`supplierId` = si.`supplierId`
        AND pe.`branchId` = si.`branchId`
        AND pe.`receiptId` IS NOT NULL
        AND pr.`receiptStatus` = 'COMPLETED'
        AND pr.`receiptApprovalStatus` = 'APPROVED'
        AND pr.`branchId` = si.`branchId`
        AND ABS(pe.`amount`) > 0
      )) AS `ambiguousEvidenceCount`,
  COALESCE((SELECT ROUND(SUM(CASE pe.`entryType` WHEN 'PAYMENT_OUT' THEN ABS(pe.`amount`) ELSE -ABS(pe.`amount`) END),2)
     FROM `accountingEntries` pe
     JOIN `receipts` pr ON pr.`id` = pe.`receiptId`
    WHERE pe.`purchaseOrderId` = si.`legacyPurchaseOrderId`
      AND pe.`supplierId` = si.`supplierId`
      AND pe.`branchId` = si.`branchId`
      AND pe.`entryType` IN ('PAYMENT_OUT','PAYMENT_IN')
      AND pe.`purchaseLiabilityAccount` = 'AP'
      AND pr.`receiptStatus` = 'COMPLETED'
      AND pr.`receiptApprovalStatus` = 'APPROVED'
      AND pr.`branchId` = si.`branchId`
      AND ABS(pe.`amount`) > 0),0) AS `netSettledAmount`,
  SHA2(CONCAT_WS('|','LEGACY-AP-ASSESSMENT',si.`id`,si.`legacyPurchaseOrderId`,
    (SELECT COUNT(*) FROM `supplierInvoices` peer WHERE peer.`origin` = 'LEGACY' AND peer.`liabilityClass` IN ('LEGACY_AP','LEGACY_UNKNOWN') AND peer.`legacyPurchaseOrderId` = si.`legacyPurchaseOrderId`),
    EXISTS (SELECT 1 FROM `accountingEntries` sourceEntry JOIN `purchaseOrders` sourceOrder ON sourceOrder.`id` = sourceEntry.`purchaseOrderId`
      WHERE sourceEntry.`id` = si.`postingEntryId` AND sourceEntry.`entryType` = 'PURCHASE'
        AND sourceEntry.`purchaseLiabilityAccount` = 'AP'
        AND (sourceEntry.`supplierId` IS NULL OR sourceEntry.`supplierId` = sourceOrder.`supplierId`)
        AND sourceEntry.`branchId` = sourceOrder.`branchId`
        AND si.`supplierId` = sourceOrder.`supplierId` AND si.`branchId` = sourceOrder.`branchId`),
    (SELECT COUNT(*) FROM `accountingEntries` pe LEFT JOIN `receipts` pr ON pr.`id` = pe.`receiptId`
      WHERE pe.`purchaseOrderId` = si.`legacyPurchaseOrderId`
        AND pe.`entryType` IN ('PAYMENT_OUT','PAYMENT_IN')
        AND NOT (pe.`purchaseLiabilityAccount` = 'AP' AND pe.`supplierId` = si.`supplierId`
          AND pe.`branchId` = si.`branchId` AND pe.`receiptId` IS NOT NULL
          AND pr.`receiptStatus` = 'COMPLETED' AND pr.`receiptApprovalStatus` = 'APPROVED' AND pr.`branchId` = si.`branchId` AND ABS(pe.`amount`) > 0)),
    COALESCE((SELECT GROUP_CONCAT(CONCAT_WS(':',pe.`id`,pe.`receiptId`,pe.`entryType`,ABS(pe.`amount`)) ORDER BY pe.`id` SEPARATOR ',')
      FROM `accountingEntries` pe JOIN `receipts` pr ON pr.`id` = pe.`receiptId`
      WHERE pe.`purchaseOrderId` = si.`legacyPurchaseOrderId` AND pe.`supplierId` = si.`supplierId` AND pe.`branchId` = si.`branchId`
        AND pe.`entryType` IN ('PAYMENT_OUT','PAYMENT_IN') AND pe.`purchaseLiabilityAccount` = 'AP'
        AND pr.`receiptStatus` = 'COMPLETED' AND pr.`receiptApprovalStatus` = 'APPROVED' AND pr.`branchId` = si.`branchId` AND ABS(pe.`amount`) > 0),'NO_VALID_PAYMENT_EVIDENCE')),256) AS `assessmentHash`
FROM `supplierInvoices` si
WHERE si.`origin` = 'LEGACY' AND si.`liabilityClass` = 'LEGACY_AP';
--> statement-breakpoint

-- لا materialization إلا حين يوجد رأس AP إرثي واحد للأمر، وكل دليل الدفع مصنف AP
-- وله إيصال مكتمل/معتمد في الفرع نفسه، وصافي الدليل ضمن [0,total].
INSERT INTO `legacySupplierInvoiceSettlements` (
  `supplierInvoiceId`,`sourceAccountingEntryId`,`sourceReceiptId`,`direction`,`amount`,`evidenceSnapshot`,`evidenceHash`
)
SELECT ass.`supplierInvoiceId`, pe.`id`, pr.`id`, pe.`entryType`, ABS(pe.`amount`),
  CAST(JSON_OBJECT('sourceAccountingEntryId',pe.`id`,'sourceReceiptId',pr.`id`,'purchaseOrderId',pe.`purchaseOrderId`,
    'supplierId',pe.`supplierId`,'branchId',pe.`branchId`,'direction',pe.`entryType`,'amount',ABS(pe.`amount`),
    'liabilityAccount',pe.`purchaseLiabilityAccount`,'receiptStatus',pr.`receiptStatus`,'approvalStatus',pr.`receiptApprovalStatus`) AS CHAR CHARACTER SET utf8mb4),
  SHA2(CONCAT_WS('|','LEGACY-AP-EVIDENCE',pe.`id`,pr.`id`,pe.`entryType`,ABS(pe.`amount`),pe.`purchaseOrderId`,pe.`supplierId`,pe.`branchId`),256)
FROM `_legacy_ap_assessment_0304` ass
JOIN `accountingEntries` pe
  ON pe.`purchaseOrderId` = ass.`purchaseOrderId`
 AND pe.`supplierId` = ass.`supplierId`
 AND pe.`branchId` = ass.`branchId`
 AND pe.`entryType` IN ('PAYMENT_OUT','PAYMENT_IN')
 AND pe.`purchaseLiabilityAccount` = 'AP'
JOIN `receipts` pr
  ON pr.`id` = pe.`receiptId`
 AND pr.`receiptStatus` = 'COMPLETED'
 AND pr.`receiptApprovalStatus` = 'APPROVED'
 AND pr.`branchId` = ass.`branchId`
WHERE ass.`candidateInvoiceCount` = 1
  AND ass.`sourceAttributionValid` = 1
  AND ass.`ambiguousEvidenceCount` = 0
  AND ass.`netSettledAmount` BETWEEN 0 AND ass.`totalAmount`
  AND ABS(pe.`amount`) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM `legacySupplierInvoiceSettlements` existing
    WHERE existing.`sourceAccountingEntryId` = pe.`id`
  );
--> statement-breakpoint

UPDATE `supplierInvoices` si
JOIN `_legacy_ap_assessment_0304` ass ON ass.`supplierInvoiceId` = si.`id`
SET si.`legacySettledAmount` = CASE
      WHEN ass.`candidateInvoiceCount` = 1 AND ass.`sourceAttributionValid` = 1 AND ass.`ambiguousEvidenceCount` = 0
       AND ass.`netSettledAmount` BETWEEN 0 AND ass.`totalAmount` THEN ass.`netSettledAmount`
      ELSE 0 END,
    si.`legacySettlementEvidenceHash` = ass.`assessmentHash`,
    si.`paymentGate` = CASE
      WHEN ass.`candidateInvoiceCount` <> 1 OR ass.`sourceAttributionValid` <> 1 OR ass.`ambiguousEvidenceCount` <> 0
        OR ass.`netSettledAmount` < 0 OR ass.`netSettledAmount` > ass.`totalAmount` THEN 'BLOCKED_REVIEW'
      WHEN ass.`netSettledAmount` = ass.`totalAmount` THEN 'SETTLED'
      ELSE 'OPEN' END,
    si.`paymentGateReason` = CASE
      WHEN ass.`candidateInvoiceCount` <> 1 THEN 'تعذر إسناد مدفوعات أمر الشراء إلى فاتورة إرثية بعينها لوجود عدة رؤوس AP أو رؤوس مجهولة التصنيف'
      WHEN ass.`sourceAttributionValid` <> 1 THEN 'طرف أو فرع قيد PURCHASE لا يطابق أمر الشراء؛ أوقفت التسوية حتى مراجعة النزاهة'
      WHEN ass.`ambiguousEvidenceCount` <> 0 THEN 'توجد قيود دفع بلا تصنيف AP صريح أو بلا إيصال مكتمل ومعتمد مطابق للفرع'
      WHEN ass.`netSettledAmount` < 0 THEN 'صافي دليل التسوية الإرثي سالب ويستلزم مراجعة نزاهة'
      WHEN ass.`netSettledAmount` > ass.`totalAmount` THEN 'دليل التسوية الإرثي يتجاوز إجمالي فاتورة المورد'
      WHEN ass.`netSettledAmount` = ass.`totalAmount` THEN 'الفاتورة مسددة بالكامل بدليل محاسبي إرثي حتمي'
      WHEN ass.`netSettledAmount` > 0 THEN 'تسوية إرثية جزئية مثبتة؛ المتبقي وحده مؤهل للسداد'
      ELSE 'لا يوجد دليل دفع إرثي؛ كامل المبلغ مؤهل للسداد' END;
--> statement-breakpoint

DROP TEMPORARY TABLE IF EXISTS `_legacy_ap_assessment_0304`;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_supplier_payment_req_alloc_bi`;
--> statement-breakpoint

CREATE TRIGGER `trg_supplier_payment_req_alloc_bi`
BEFORE INSERT ON `supplierPaymentRequestAllocations`
FOR EACH ROW
BEGIN
  DECLARE v_status VARCHAR(32);
  DECLARE v_gate VARCHAR(32);
  DECLARE v_supplier BIGINT;
  DECLARE v_branch BIGINT;
  DECLARE v_version INT;
  DECLARE v_total DECIMAL(15,2);
  DECLARE v_legacy_settled DECIMAL(15,2);
  DECLARE v_allocated DECIMAL(15,2);
  DECLARE v_remaining DECIMAL(15,2);
  DECLARE v_req_supplier BIGINT;
  DECLARE v_req_branch BIGINT;
  SELECT `status`,`paymentGate`,`supplierId`,`branchId`,`version`,`totalAmount`,`legacySettledAmount`
    INTO v_status,v_gate,v_supplier,v_branch,v_version,v_total,v_legacy_settled
    FROM `supplierInvoices` WHERE `id` = NEW.`supplierInvoiceId`;
  SELECT `supplierId`,`branchId` INTO v_req_supplier,v_req_branch FROM `supplierPaymentRequests` WHERE `id` = NEW.`requestId`;
  SELECT COALESCE(SUM(`allocatedAmount` - `refundedAmount`),0) INTO v_allocated
    FROM `supplierPaymentAllocations` WHERE `supplierInvoiceId` = NEW.`supplierInvoiceId`;
  SET v_remaining = v_total - v_legacy_settled - v_allocated;
  IF v_status <> 'POSTED' OR v_gate <> 'OPEN' OR v_supplier <> v_req_supplier OR v_branch <> v_req_branch
     OR v_version <> NEW.`invoiceVersion` OR v_remaining <= 0 OR NEW.`requestedAmount` > v_remaining THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'supplier payment request requires eligible POSTED invoice and cannot exceed deterministic outstanding';
  END IF;
  SET NEW.`activeInvoiceGuard` = NEW.`supplierInvoiceId`;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_supplier_payment_req_alloc_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_supplier_payment_req_alloc_bu`
BEFORE UPDATE ON `supplierPaymentRequestAllocations`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`requestId` <=> OLD.`requestId`)
     OR NOT (NEW.`supplierInvoiceId` <=> OLD.`supplierInvoiceId`)
     OR NOT (NEW.`invoiceVersion` <=> OLD.`invoiceVersion`)
     OR NOT (NEW.`requestedAmount` <=> OLD.`requestedAmount`)
     OR NOT (NEW.`requestedCurrencyAmount` <=> OLD.`requestedCurrencyAmount`)
     OR NOT (NEW.`invoiceSnapshot` <=> OLD.`invoiceSnapshot`)
     OR NOT (NEW.`invoiceHash` <=> OLD.`invoiceHash`)
     OR (OLD.`activeInvoiceGuard` IS NULL AND NEW.`activeInvoiceGuard` IS NOT NULL)
     OR (NEW.`activeInvoiceGuard` IS NOT NULL AND NEW.`activeInvoiceGuard` <> NEW.`supplierInvoiceId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'supplier payment request allocation is immutable except releasing active guard';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_supplier_payment_req_alloc_bd`;
--> statement-breakpoint

CREATE TRIGGER `trg_supplier_payment_req_alloc_bd`
BEFORE DELETE ON `supplierPaymentRequestAllocations`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'supplier payment request allocations are append-only';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_supplier_payment_alloc_bi`;
--> statement-breakpoint

CREATE TRIGGER `trg_supplier_payment_alloc_bi`
BEFORE INSERT ON `supplierPaymentAllocations`
FOR EACH ROW
BEGIN
  DECLARE v_status VARCHAR(32);
  DECLARE v_gate VARCHAR(32);
  DECLARE v_supplier BIGINT;
  DECLARE v_branch BIGINT;
  DECLARE v_total DECIMAL(15,2);
  DECLARE v_legacy_settled DECIMAL(15,2);
  DECLARE v_allocated DECIMAL(15,2);
  DECLARE v_remaining DECIMAL(15,2);
  DECLARE v_pay_supplier BIGINT;
  DECLARE v_pay_branch BIGINT;
  SELECT `status`,`paymentGate`,`supplierId`,`branchId`,`totalAmount`,`legacySettledAmount`
    INTO v_status,v_gate,v_supplier,v_branch,v_total,v_legacy_settled
    FROM `supplierInvoices` WHERE `id` = NEW.`supplierInvoiceId`;
  SELECT `supplierId`,`branchId` INTO v_pay_supplier,v_pay_branch FROM `supplierPayments` WHERE `id` = NEW.`supplierPaymentId`;
  SELECT COALESCE(SUM(`allocatedAmount` - `refundedAmount`),0) INTO v_allocated
    FROM `supplierPaymentAllocations` WHERE `supplierInvoiceId` = NEW.`supplierInvoiceId`;
  SET v_remaining = v_total - v_legacy_settled - v_allocated;
  IF v_status <> 'POSTED' OR v_gate <> 'OPEN' OR v_supplier <> v_pay_supplier OR v_branch <> v_pay_branch
     OR v_remaining <= 0 OR NEW.`allocatedAmount` > v_remaining THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'materialized supplier payment requires eligible POSTED invoice and cannot exceed deterministic outstanding';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_supplier_payments_version_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_supplier_payments_version_bu`
BEFORE UPDATE ON `supplierPayments`
FOR EACH ROW
BEGIN
  SET NEW.`version` = OLD.`version` + 1;
END;
