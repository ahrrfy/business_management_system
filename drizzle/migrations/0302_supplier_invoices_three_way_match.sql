-- 0302 — فاتورة المورد المستقلة والمطابقة الثلاثية PO ↔ GRN ↔ Invoice.
-- AP ينشأ عند POSTED فقط؛ HOLD صلب بلا تجاوز، والترحيل أو العكس يتطلب اعتماداً محكوماً.

-- الدور مطلوب إنتاجياً قبل تفعيل قيود GRNI. لا INSERT IGNORE: تعارض الرمز من دون
-- الدور النظامي يوقف النشر للمراجعة ولا يعيد تسمية حساب مستخدم بصمت.
INSERT INTO `accounts` (`code`,`name`,`type`,`parentId`,`systemRole`,`sortOrder`)
SELECT '2150','بضاعة مستلمة غير مفوترة (GRNI)','LIABILITY',
  (SELECT p.`id` FROM `accounts` p WHERE p.`code` = '2000' AND p.`type` = 'LIABILITY' LIMIT 1),
  'GRNI',215
WHERE NOT EXISTS (SELECT 1 FROM `accounts` a WHERE a.`systemRole` = 'GRNI')
  AND EXISTS (
    SELECT 1 FROM `accounts` p
    WHERE p.`code` = '2000' AND p.`type` = 'LIABILITY'
  );
--> statement-breakpoint

-- وجود الدور وحده لا يكفي: أي دور GRNI قديم غير نشط أو خارج الخصوم يوقف الهجرة.
DROP TEMPORARY TABLE IF EXISTS `_grni_account_guard_0302`;
--> statement-breakpoint
CREATE TEMPORARY TABLE `_grni_account_guard_0302` (
  `valid` TINYINT NOT NULL,
  CONSTRAINT `chk_grni_account_guard_0302` CHECK (`valid` = 1)
);
--> statement-breakpoint
INSERT INTO `_grni_account_guard_0302` (`valid`)
SELECT IF(
  (SELECT COUNT(*) FROM `accounts`) = 0
  OR (
    COUNT(*) = 1
    AND SUM(IF(grni.`type` = 'LIABILITY' AND grni.`isActive` = 1 AND parent.`type` = 'LIABILITY', 1, 0)) = 1
  ),
  1,
  0
)
FROM `accounts` grni
LEFT JOIN `accounts` parent ON parent.`id` = grni.`parentId`
WHERE grni.`systemRole` = 'GRNI';
--> statement-breakpoint
DROP TEMPORARY TABLE `_grni_account_guard_0302`;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierInvoices` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `invoiceNumber` VARCHAR(60) NOT NULL,
  `clientRequestId` VARCHAR(120) NOT NULL,
  `origin` ENUM('NATIVE','LEGACY') NOT NULL DEFAULT 'NATIVE',
  `liabilityClass` ENUM('NATIVE_AP','LEGACY_AP','LEGACY_CASH_CLEARING','LEGACY_UNKNOWN') NOT NULL DEFAULT 'NATIVE_AP',
  `paymentGate` ENUM('OPEN','SETTLED','BLOCKED_CASH_CLEARING','BLOCKED_REVIEW') NOT NULL DEFAULT 'OPEN',
  `legacyPurchaseOrderId` BIGINT NULL,
  `supplierId` BIGINT NOT NULL,
  `externalInvoiceNumber` VARCHAR(160) NULL,
  `externalNumberNorm` VARCHAR(160) NULL,
  `branchId` BIGINT NOT NULL,
  `status` ENUM('DRAFT','ON_HOLD','MATCHED','POSTED','REVERSED') NOT NULL DEFAULT 'DRAFT',
  `version` INT NOT NULL DEFAULT 1,
  `invoiceDate` DATE NOT NULL,
  `dueDate` DATE NULL,
  `currency` ENUM('IQD','USD') NOT NULL,
  `agreedRate` DECIMAL(15,4) NULL,
  `subtotal` DECIMAL(15,2) NOT NULL,
  `taxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `discountAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `totalAmount` DECIMAL(15,2) NOT NULL,
  `legacySettledAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `legacySettlementEvidenceHash` CHAR(64) NULL,
  `paymentGateReason` VARCHAR(500) NULL,
  `usdTotal` DECIMAL(15,2) NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `evidenceType` ENUM('DOCUMENT_IMAGE','PDF','EMAIL','EDI','LEGACY_LEDGER','OTHER') NOT NULL,
  `evidenceReference` VARCHAR(500) NULL,
  `holdReason` VARCHAR(500) NULL,
  `postingEntryId` BIGINT NULL,
  `reversalEntryId` BIGINT NULL,
  `createdBy` INT NULL,
  `postedBy` INT NULL,
  `postedAt` TIMESTAMP NULL,
  `reversedBy` INT NULL,
  `reversedAt` TIMESTAMP NULL,
  `reversalReason` VARCHAR(500) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_invoice_number` (`invoiceNumber`),
  UNIQUE KEY `uq_supplier_invoice_request` (`clientRequestId`),
  UNIQUE KEY `uq_supplier_invoice_posting_entry` (`postingEntryId`),
  UNIQUE KEY `uq_supplier_invoice_reversal_entry` (`reversalEntryId`),
  UNIQUE KEY `uq_supplier_invoice_external` (`supplierId`,`externalNumberNorm`),
  UNIQUE KEY `uq_supplier_invoice_request_hash` (`clientRequestId`,`payloadHash`),
  KEY `idx_supplier_invoice_branch_status` (`branchId`,`status`),
  KEY `idx_supplier_invoice_supplier_date` (`supplierId`,`invoiceDate`),
  KEY `idx_supplier_invoice_payment_gate` (`branchId`,`paymentGate`,`status`),
  CONSTRAINT `fk_supplier_invoice_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_supplier_invoice_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_supplier_invoice_legacy_po` FOREIGN KEY (`legacyPurchaseOrderId`) REFERENCES `purchaseOrders` (`id`),
  CONSTRAINT `fk_supplier_invoice_posting` FOREIGN KEY (`postingEntryId`) REFERENCES `accountingEntries` (`id`),
  CONSTRAINT `fk_supplier_invoice_reversal` FOREIGN KEY (`reversalEntryId`) REFERENCES `accountingEntries` (`id`),
  CONSTRAINT `fk_supplier_invoice_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_supplier_invoice_poster` FOREIGN KEY (`postedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_supplier_invoice_reverser` FOREIGN KEY (`reversedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_supplier_invoice_amounts` CHECK (`subtotal` >= 0 AND `taxAmount` >= 0 AND `discountAmount` >= 0 AND `discountAmount` <= `subtotal` + `taxAmount` AND `totalAmount` = `subtotal` + `taxAmount` - `discountAmount`),
  CONSTRAINT `chk_supplier_invoice_native_document` CHECK (`origin` = 'LEGACY' OR (`externalInvoiceNumber` IS NOT NULL AND CHAR_LENGTH(TRIM(`externalInvoiceNumber`)) > 0 AND `externalNumberNorm` IS NOT NULL AND CHAR_LENGTH(TRIM(`externalNumberNorm`)) > 0 AND `createdBy` IS NOT NULL AND `evidenceReference` IS NOT NULL AND CHAR_LENGTH(TRIM(`evidenceReference`)) > 0)),
  CONSTRAINT `chk_supplier_invoice_lifecycle` CHECK (
    (`status` IN ('DRAFT','ON_HOLD','MATCHED') AND `postingEntryId` IS NULL AND `postedAt` IS NULL AND `reversalEntryId` IS NULL AND `reversedAt` IS NULL)
    OR (`status` = 'POSTED' AND (`origin` = 'LEGACY' OR (`postingEntryId` IS NOT NULL AND `postedBy` IS NOT NULL AND `postedAt` IS NOT NULL)) AND `reversalEntryId` IS NULL AND `reversedAt` IS NULL)
    OR (`status` = 'REVERSED' AND `postingEntryId` IS NOT NULL AND `postedAt` IS NOT NULL AND `reversalEntryId` IS NOT NULL AND `reversedBy` IS NOT NULL AND `reversedAt` IS NOT NULL AND `reversalReason` IS NOT NULL)
  ),
  CONSTRAINT `chk_supplier_invoice_legacy_liability` CHECK (
    ((`origin` = 'NATIVE' AND `liabilityClass` = 'NATIVE_AP' AND `paymentGate` IN ('OPEN','SETTLED') AND `legacyPurchaseOrderId` IS NULL AND `legacySettledAmount` = 0 AND `legacySettlementEvidenceHash` IS NULL)
    OR (`origin` = 'LEGACY' AND `liabilityClass` <> 'NATIVE_AP' AND `legacyPurchaseOrderId` IS NOT NULL AND `legacySettlementEvidenceHash` IS NOT NULL
      AND ((`liabilityClass` = 'LEGACY_CASH_CLEARING' AND `paymentGate` = 'BLOCKED_CASH_CLEARING' AND `legacySettledAmount` = 0)
        OR (`liabilityClass` = 'LEGACY_UNKNOWN' AND `paymentGate` = 'BLOCKED_REVIEW' AND `legacySettledAmount` = 0)
        OR (`liabilityClass` = 'LEGACY_AP' AND `paymentGate` IN ('OPEN','SETTLED','BLOCKED_REVIEW')))))
    AND `legacySettledAmount` >= 0 AND `legacySettledAmount` <= `totalAmount`
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierInvoiceLines` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `supplierInvoiceId` BIGINT NOT NULL,
  `lineNo` INT NOT NULL,
  `purchaseOrderRevisionItemId` BIGINT NULL,
  `variantId` BIGINT NULL,
  `description` VARCHAR(500) NOT NULL,
  `invoicedBaseQuantity` INT NOT NULL,
  `unitPriceIqd` DECIMAL(15,2) NOT NULL,
  `netAmount` DECIMAL(15,2) NOT NULL,
  `taxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `totalAmount` DECIMAL(15,2) NOT NULL,
  `usdUnitPrice` DECIMAL(15,4) NULL,
  `usdTotal` DECIMAL(15,2) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_invoice_line` (`supplierInvoiceId`,`lineNo`),
  KEY `idx_supplier_invoice_line_revision` (`purchaseOrderRevisionItemId`),
  CONSTRAINT `fk_supplier_invoice_line_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_supplier_invoice_line_revision` FOREIGN KEY (`purchaseOrderRevisionItemId`) REFERENCES `purchaseOrderRevisionItems` (`id`),
  CONSTRAINT `fk_supplier_invoice_line_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants` (`id`),
  CONSTRAINT `chk_supplier_invoice_line_shape` CHECK (`lineNo` > 0 AND `invoicedBaseQuantity` > 0 AND `unitPriceIqd` >= 0 AND `netAmount` >= 0 AND `taxAmount` >= 0 AND `totalAmount` = `netAmount` + `taxAmount`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierInvoiceMatchRuns` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `matchKey` VARCHAR(160) NOT NULL,
  `supplierInvoiceId` BIGINT NOT NULL,
  `supplierId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `runNo` INT NOT NULL,
  `outcome` ENUM('EXACT','WITHIN_TOLERANCE','HOLD') NOT NULL,
  `policyVersion` INT NOT NULL,
  `policySnapshot` MEDIUMTEXT NOT NULL,
  `policyHash` CHAR(64) NOT NULL,
  `poRevisionSetHash` CHAR(64) NOT NULL,
  `goodsReceiptSetHash` CHAR(64) NOT NULL,
  `invoiceHash` CHAR(64) NOT NULL,
  `priceTolerancePercent` DECIMAL(7,4) NOT NULL,
  `quantityToleranceBase` INT NOT NULL DEFAULT 0,
  `totalToleranceAmount` DECIMAL(15,2) NOT NULL,
  `orderedBaseQuantity` INT NOT NULL,
  `receivedBaseQuantity` INT NOT NULL,
  `invoicedBaseQuantity` INT NOT NULL,
  `poTotal` DECIMAL(15,2) NOT NULL,
  `grnTotal` DECIMAL(15,2) NOT NULL,
  `invoiceTotal` DECIMAL(15,2) NOT NULL,
  `quantityVarianceBase` INT NOT NULL,
  `priceVarianceAmount` DECIMAL(15,2) NOT NULL,
  `totalVarianceAmount` DECIMAL(15,2) NOT NULL,
  `outcomeReason` VARCHAR(500) NULL,
  `holdCodes` JSON NOT NULL,
  `evidenceSnapshot` MEDIUMTEXT NOT NULL,
  `evidenceHash` CHAR(64) NOT NULL,
  `performedBy` INT NOT NULL,
  `performedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_invoice_match_key` (`matchKey`),
  UNIQUE KEY `uq_supplier_invoice_match_run` (`supplierInvoiceId`,`runNo`),
  UNIQUE KEY `uq_supplier_invoice_match_evidence` (`supplierInvoiceId`,`evidenceHash`),
  KEY `idx_supplier_invoice_match_date` (`supplierInvoiceId`,`performedAt`),
  KEY `idx_supplier_invoice_match_branch_outcome` (`branchId`,`outcome`),
  CONSTRAINT `fk_supplier_match_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
  CONSTRAINT `fk_supplier_match_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_supplier_match_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_supplier_match_actor` FOREIGN KEY (`performedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_supplier_invoice_match_tolerances` CHECK (`runNo` > 0 AND `policyVersion` > 0 AND `priceTolerancePercent` >= 0 AND `quantityToleranceBase` >= 0 AND `totalToleranceAmount` >= 0 AND `orderedBaseQuantity` >= 0 AND `receivedBaseQuantity` >= 0 AND `invoicedBaseQuantity` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierInvoiceMatchAllocations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `matchRunId` BIGINT NOT NULL,
  `supplierInvoiceLineId` BIGINT NOT NULL,
  `purchaseOrderRevisionItemId` BIGINT NOT NULL,
  `goodsReceiptItemId` BIGINT NOT NULL,
  `matchedBaseQuantity` INT NOT NULL,
  `poUnitPriceIqd` DECIMAL(15,2) NOT NULL,
  `grnUnitCostIqd` DECIMAL(15,2) NOT NULL,
  `invoiceUnitPriceIqd` DECIMAL(15,2) NOT NULL,
  `quantityVarianceBase` INT NOT NULL,
  `priceVarianceAmount` DECIMAL(15,2) NOT NULL,
  `matchedAmount` DECIMAL(15,2) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_invoice_match_allocation` (`matchRunId`,`supplierInvoiceLineId`,`goodsReceiptItemId`),
  KEY `idx_supplier_invoice_match_grn_item` (`goodsReceiptItemId`),
  CONSTRAINT `fk_supplier_match_alloc_run` FOREIGN KEY (`matchRunId`) REFERENCES `supplierInvoiceMatchRuns` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_supplier_match_alloc_invoice_line` FOREIGN KEY (`supplierInvoiceLineId`) REFERENCES `supplierInvoiceLines` (`id`),
  CONSTRAINT `fk_supplier_match_alloc_revision_item` FOREIGN KEY (`purchaseOrderRevisionItemId`) REFERENCES `purchaseOrderRevisionItems` (`id`),
  CONSTRAINT `fk_supplier_match_alloc_grn_item` FOREIGN KEY (`goodsReceiptItemId`) REFERENCES `goodsReceiptItems` (`id`),
  CONSTRAINT `chk_supplier_invoice_match_allocation_shape` CHECK (`matchedBaseQuantity` > 0 AND `poUnitPriceIqd` >= 0 AND `grnUnitCostIqd` >= 0 AND `invoiceUnitPriceIqd` >= 0 AND `matchedAmount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierInvoiceApprovalRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `supplierInvoiceId` BIGINT NOT NULL,
  `matchRunId` BIGINT NULL,
  `branchId` BIGINT NOT NULL,
  `kind` ENUM('POST_INVOICE','REVERSE_INVOICE') NOT NULL,
  `baseInvoiceVersion` INT NOT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `evidenceType` ENUM('DOCUMENT_IMAGE','PDF','EMAIL','SIGNED_APPROVAL','OTHER') NULL,
  `evidenceReference` VARCHAR(500) NULL,
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
  UNIQUE KEY `uq_supplier_invoice_approval_request` (`requestKey`),
  UNIQUE KEY `uq_supplier_invoice_approval_pending` (`pendingGuard`),
  UNIQUE KEY `uq_supplier_invoice_approval_decision` (`decisionKey`),
  KEY `idx_supplier_invoice_approval_branch_status` (`branchId`,`status`),
  KEY `idx_supplier_invoice_approval_invoice_status` (`supplierInvoiceId`,`status`),
  CONSTRAINT `fk_supplier_invoice_approval_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
  CONSTRAINT `fk_supplier_invoice_approval_match` FOREIGN KEY (`matchRunId`) REFERENCES `supplierInvoiceMatchRuns` (`id`),
  CONSTRAINT `fk_supplier_invoice_approval_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_supplier_invoice_approval_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_supplier_invoice_approval_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_supplier_invoice_approval_decision` CHECK (
    (`status` = 'PENDING' AND `pendingGuard` IS NOT NULL AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `decisionKey` IS NULL AND `decisionHash` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_supplier_invoice_approval_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- كل قيد PURCHASE تاريخي يصير فاتورة LEGACY مستقلة مرتبطة بالقيد نفسه.
-- externalInvoiceNumber يبقى NULL لأن الرقم الأصلي لم يُحفظ؛ لا نختلق مستند مورد.
INSERT INTO `supplierInvoices` (
  `invoiceNumber`,`clientRequestId`,`origin`,`liabilityClass`,`paymentGate`,`legacyPurchaseOrderId`,
  `supplierId`,`externalInvoiceNumber`,`externalNumberNorm`,`branchId`,
  `status`,`invoiceDate`,`dueDate`,`currency`,`agreedRate`,
  `subtotal`,`taxAmount`,`discountAmount`,`totalAmount`,`legacySettledAmount`,`legacySettlementEvidenceHash`,`paymentGateReason`,
  `usdTotal`,`payloadCanonical`,`payloadHash`,
  `evidenceType`,`evidenceReference`,`postingEntryId`,`createdBy`,`postedBy`,`postedAt`,`createdAt`,`updatedAt`
)
SELECT CONCAT('LEGACY-AP-', a.`id`), CONCAT('legacy-ap-entry-', a.`id`), 'LEGACY',
  CASE
    WHEN a.`purchaseLiabilityAccount` = 'AP' THEN 'LEGACY_AP'
    WHEN a.`purchaseLiabilityAccount` = 'CASH_CLEARING' THEN 'LEGACY_CASH_CLEARING'
    ELSE 'LEGACY_UNKNOWN'
  END,
  CASE
    WHEN a.`purchaseLiabilityAccount` = 'CASH_CLEARING' THEN 'BLOCKED_CASH_CLEARING'
    ELSE 'BLOCKED_REVIEW'
  END,
  po.`id`,
  COALESCE(a.`supplierId`, po.`supplierId`), NULL, NULL, COALESCE(a.`branchId`, po.`branchId`),
  'POSTED', a.`entryDate`, NULL, po.`poCurrency`, po.`agreedRate`,
  ABS(a.`amount`) - LEAST(ABS(a.`taxAmount`), ABS(a.`amount`)), LEAST(ABS(a.`taxAmount`), ABS(a.`amount`)), 0, ABS(a.`amount`),
  0,
  SHA2(CONCAT_WS('|','LEGACY-LIABILITY-CLASS',a.`id`,po.`id`,COALESCE(a.`purchaseLiabilityAccount`,'UNKNOWN')),256),
  CASE
    WHEN a.`purchaseLiabilityAccount` = 'AP' THEN 'بانتظار تقييم حتمي لتسويات دفتر AP في 0304'
    WHEN a.`purchaseLiabilityAccount` = 'CASH_CLEARING' THEN 'قيد الشراء مصنف CASH_CLEARING وليس ذمة مورد قابلة لسداد AP'
    ELSE 'قيد الشراء التاريخي بلا تصنيف التزام موثوق؛ يلزم حسم قضية نزاهة'
  END,
  CASE
    WHEN po.`poCurrency` = 'USD' AND po.`total` > 0
      THEN ROUND(COALESCE(po.`usdTotal`,0) * ABS(a.`amount`) / po.`total`, 2)
    ELSE NULL
  END,
  CAST(JSON_OBJECT('legacy', TRUE, 'accountingEntryId', a.`id`, 'purchaseOrderId', po.`id`, 'purchaseLiabilityAccount', COALESCE(a.`purchaseLiabilityAccount`,'UNKNOWN')) AS CHAR CHARACTER SET utf8mb4),
  SHA2(CONCAT_WS('|','LEGACY-SUPPLIER-INVOICE',a.`id`,po.`id`,ABS(a.`amount`),ABS(a.`taxAmount`),COALESCE(a.`purchaseLiabilityAccount`,'UNKNOWN')),256),
  'LEGACY_LEDGER', NULL, a.`id`, a.`createdBy`, a.`createdBy`, a.`createdAt`, a.`createdAt`, a.`createdAt`
FROM `accountingEntries` a
JOIN `purchaseOrders` po ON po.`id` = a.`purchaseOrderId`
WHERE a.`entryType` = 'PURCHASE'
  AND NOT EXISTS (
    SELECT 1 FROM `supplierInvoices` existing
    WHERE existing.`postingEntryId` = a.`id`
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_supplier_invoices_version_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_supplier_invoices_version_bu`
BEFORE UPDATE ON `supplierInvoices`
FOR EACH ROW
BEGIN
  SET NEW.`version` = OLD.`version` + 1;
END;
