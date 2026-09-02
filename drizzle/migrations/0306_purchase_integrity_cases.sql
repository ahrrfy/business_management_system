-- 0306 — قضايا نزاهة الشراء وسجل أحداثٍ append-only مع فصل واجبات الحل.

CREATE TABLE IF NOT EXISTS `purchaseIntegrityCases` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `caseNumber` VARCHAR(60) NOT NULL,
  `caseKey` VARCHAR(180) NOT NULL,
  `openGuard` VARCHAR(180) NULL,
  `branchId` BIGINT NOT NULL,
  `supplierId` BIGINT NULL,
  `purchaseOrderId` BIGINT NULL,
  `goodsReceiptId` BIGINT NULL,
  `supplierInvoiceId` BIGINT NULL,
  `purchaseReturnId` BIGINT NULL,
  `supplierPaymentId` BIGINT NULL,
  `purchaseChargeId` BIGINT NULL,
  `code` ENUM('GRN_WITHOUT_POSTED_INVOICE','INVOICE_WITHOUT_GRN','UNMATCHED_POSTED_INVOICE','PAYMENT_EXCEEDS_INVOICE','RETURN_EXCEEDS_MATCH','RETURN_WITHOUT_SOURCE','CHARGE_WITHOUT_EVIDENCE','AP_LEDGER_MISMATCH','GRNI_AGING','DUPLICATE_SUPPLIER_DOCUMENT','LEGACY_AP_CLASSIFICATION','LEGACY_PAYMENT_ALLOCATION_AMBIGUOUS','LEGACY_PAYMENT_EVIDENCE_INVALID','LEGACY_PAYMENT_EXCEEDS_INVOICE','PERIOD_CLOSE_BLOCKER','OTHER') NOT NULL,
  `origin` ENUM('USER','SYSTEM') NOT NULL DEFAULT 'USER',
  `severity` ENUM('LOW','MEDIUM','HIGH','CRITICAL') NOT NULL DEFAULT 'MEDIUM',
  `status` ENUM('OPEN','IN_REVIEW','PENDING_RESOLUTION','RESOLVED','DISMISSED') NOT NULL DEFAULT 'OPEN',
  `title` VARCHAR(255) NOT NULL,
  `description` VARCHAR(1000) NOT NULL,
  `detectedAmount` DECIMAL(15,2) NULL,
  `detectedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `evidenceSnapshot` MEDIUMTEXT NOT NULL,
  `evidenceHash` CHAR(64) NOT NULL,
  `openedBy` INT NULL,
  `assignedTo` INT NULL,
  `resolutionRequestKey` VARCHAR(120) NULL,
  `resolutionRequestHash` CHAR(64) NULL,
  `resolutionRequestedBy` INT NULL,
  `resolutionRequestedAt` TIMESTAMP NULL,
  `resolutionReason` VARCHAR(1000) NULL,
  `resolutionEvidenceReference` VARCHAR(500) NULL,
  `pendingResolutionGuard` VARCHAR(180) NULL,
  `decisionKey` VARCHAR(120) NULL,
  `decisionHash` CHAR(64) NULL,
  `resolutionDecision` ENUM('APPROVE_RESOLVED','APPROVE_DISMISSED','REJECT') NULL,
  `resolvedBy` INT NULL,
  `resolvedAt` TIMESTAMP NULL,
  `decisionReason` VARCHAR(1000) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_integrity_case_number` (`caseNumber`),
  UNIQUE KEY `uq_purchase_integrity_case_key` (`caseKey`),
  UNIQUE KEY `uq_purchase_integrity_open_guard` (`openGuard`),
  UNIQUE KEY `uq_purchase_integrity_resolution_request` (`resolutionRequestKey`),
  UNIQUE KEY `uq_purchase_integrity_resolution_pending` (`pendingResolutionGuard`),
  UNIQUE KEY `uq_purchase_integrity_resolution_decision` (`decisionKey`),
  UNIQUE KEY `uq_purchase_integrity_case_evidence` (`caseKey`,`evidenceHash`),
  KEY `idx_purchase_integrity_branch_status` (`branchId`,`status`,`severity`),
  KEY `idx_purchase_integrity_supplier_code` (`supplierId`,`code`),
  KEY `idx_purchase_integrity_invoice` (`supplierInvoiceId`),
  CONSTRAINT `fk_picase_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_picase_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_picase_po` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders` (`id`),
  CONSTRAINT `fk_picase_grn` FOREIGN KEY (`goodsReceiptId`) REFERENCES `goodsReceipts` (`id`),
  CONSTRAINT `fk_picase_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
  CONSTRAINT `fk_picase_return` FOREIGN KEY (`purchaseReturnId`) REFERENCES `purchaseReturns` (`id`),
  CONSTRAINT `fk_picase_payment` FOREIGN KEY (`supplierPaymentId`) REFERENCES `supplierPayments` (`id`),
  CONSTRAINT `fk_picase_charge` FOREIGN KEY (`purchaseChargeId`) REFERENCES `purchaseCharges` (`id`),
  CONSTRAINT `fk_picase_opener` FOREIGN KEY (`openedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_picase_assignee` FOREIGN KEY (`assignedTo`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_picase_resolution_requester` FOREIGN KEY (`resolutionRequestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_picase_resolver` FOREIGN KEY (`resolvedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_purchase_integrity_detected_amount` CHECK (`detectedAmount` IS NULL OR `detectedAmount` >= 0),
  CONSTRAINT `chk_purchase_integrity_opener` CHECK ((`origin` = 'USER' AND `openedBy` IS NOT NULL) OR (`origin` = 'SYSTEM' AND `openedBy` IS NULL)),
  CONSTRAINT `chk_purchase_integrity_resolution` CHECK (
    (`status` IN ('OPEN','IN_REVIEW') AND `pendingResolutionGuard` IS NULL AND `resolutionRequestKey` IS NULL AND `resolutionRequestedBy` IS NULL AND `resolutionRequestedAt` IS NULL AND `decisionKey` IS NULL AND `resolvedBy` IS NULL AND `resolvedAt` IS NULL)
    OR (`status` = 'PENDING_RESOLUTION' AND `pendingResolutionGuard` IS NOT NULL AND `resolutionRequestKey` IS NOT NULL AND `resolutionRequestHash` IS NOT NULL AND `resolutionRequestedBy` IS NOT NULL AND `resolutionRequestedAt` IS NOT NULL AND `resolutionReason` IS NOT NULL AND `decisionKey` IS NULL AND `resolvedBy` IS NULL AND `resolvedAt` IS NULL)
    OR (`status` IN ('RESOLVED','DISMISSED') AND `pendingResolutionGuard` IS NULL AND `resolutionRequestKey` IS NOT NULL AND `resolutionRequestHash` IS NOT NULL AND `resolutionRequestedBy` IS NOT NULL AND `resolutionRequestedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `resolutionDecision` IN ('APPROVE_RESOLVED','APPROVE_DISMISSED') AND `resolvedBy` IS NOT NULL AND `resolvedAt` IS NOT NULL AND `decisionReason` IS NOT NULL)
  ),
  CONSTRAINT `chk_purchase_integrity_resolution_sod` CHECK (`resolvedBy` IS NULL OR `resolvedBy` <> `resolutionRequestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseIntegrityCaseEvents` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `eventKey` VARCHAR(160) NOT NULL,
  `caseId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `eventType` ENUM('OPENED','EVIDENCE_ADDED','REVIEW_STARTED','ASSIGNED','RESOLUTION_REQUESTED','RESOLUTION_APPROVED','RESOLUTION_REJECTED','DISMISSED','REOPENED') NOT NULL,
  `actorType` ENUM('USER','SYSTEM') NOT NULL DEFAULT 'USER',
  `previousStatus` ENUM('OPEN','IN_REVIEW','PENDING_RESOLUTION','RESOLVED','DISMISSED') NULL,
  `newStatus` ENUM('OPEN','IN_REVIEW','PENDING_RESOLUTION','RESOLVED','DISMISSED') NOT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `evidenceReference` VARCHAR(500) NULL,
  `reason` VARCHAR(1000) NOT NULL,
  `actorId` INT NULL,
  `counterpartyActorId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_integrity_event_key` (`eventKey`),
  UNIQUE KEY `uq_purchase_integrity_event_hash` (`caseId`,`payloadHash`),
  KEY `idx_purchase_integrity_event_case_date` (`caseId`,`createdAt`),
  KEY `idx_purchase_integrity_event_branch_type` (`branchId`,`eventType`),
  CONSTRAINT `fk_pievent_case` FOREIGN KEY (`caseId`) REFERENCES `purchaseIntegrityCases` (`id`),
  CONSTRAINT `fk_pievent_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_pievent_actor` FOREIGN KEY (`actorId`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_pievent_counterparty` FOREIGN KEY (`counterpartyActorId`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_purchase_integrity_event_sod` CHECK (`eventType` NOT IN ('RESOLUTION_APPROVED','DISMISSED') OR (`counterpartyActorId` IS NOT NULL AND `counterpartyActorId` <> `actorId`)),
  CONSTRAINT `chk_purchase_integrity_event_actor` CHECK ((`actorType` = 'USER' AND `actorId` IS NOT NULL) OR (`actorType` = 'SYSTEM' AND `actorId` IS NULL AND `eventType` IN ('OPENED','EVIDENCE_ADDED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- الفواتير المحجوبة بسبب إرث غير حتمي تصبح قضايا نظامية، بلا اختلاق مستخدم فاتح
-- أو معتمد. CASH_CLEARING محجوب بنيوياً لكنه ليس خللاً محاسبياً بحد ذاته فلا نفتح قضية له.
INSERT INTO `purchaseIntegrityCases` (
  `caseNumber`,`caseKey`,`openGuard`,`branchId`,`supplierId`,`purchaseOrderId`,`supplierInvoiceId`,
  `code`,`origin`,`severity`,`status`,`title`,`description`,`detectedAmount`,`detectedAt`,
  `evidenceSnapshot`,`evidenceHash`,`openedBy`
)
SELECT
  CONCAT('LEGACY-AP-REVIEW-',si.`id`),
  CONCAT('LEGACY-AP-REVIEW:',si.`id`),
  CONCAT('LEGACY-AP-REVIEW:',si.`id`),
  si.`branchId`,si.`supplierId`,si.`legacyPurchaseOrderId`,si.`id`,
  CASE
    WHEN si.`liabilityClass` = 'LEGACY_UNKNOWN' THEN 'LEGACY_AP_CLASSIFICATION'
    WHEN si.`paymentGateReason` LIKE '%عدة رؤوس%' THEN 'LEGACY_PAYMENT_ALLOCATION_AMBIGUOUS'
    WHEN si.`paymentGateReason` LIKE '%يتجاوز%' THEN 'LEGACY_PAYMENT_EXCEEDS_INVOICE'
    ELSE 'LEGACY_PAYMENT_EVIDENCE_INVALID'
  END,
  'SYSTEM',
  CASE WHEN si.`liabilityClass` = 'LEGACY_UNKNOWN' OR si.`paymentGateReason` LIKE '%يتجاوز%' THEN 'CRITICAL' ELSE 'HIGH' END,
  'OPEN',
  'فاتورة مورد إرثية محجوبة عن السداد',
  COALESCE(si.`paymentGateReason`,'تعذر إثبات تصنيف الالتزام أو تسويته تاريخياً'),
  CASE WHEN si.`paymentGateReason` LIKE '%يتجاوز%' THEN
    COALESCE((SELECT ABS(ROUND(SUM(CASE pe.`entryType` WHEN 'PAYMENT_OUT' THEN ABS(pe.`amount`) ELSE -ABS(pe.`amount`) END),2))
      FROM `accountingEntries` pe
      WHERE pe.`purchaseOrderId` = si.`legacyPurchaseOrderId` AND pe.`supplierId` = si.`supplierId`
        AND pe.`entryType` IN ('PAYMENT_OUT','PAYMENT_IN') AND pe.`purchaseLiabilityAccount` = 'AP'),0)
    ELSE si.`totalAmount` END,
  CURRENT_TIMESTAMP,
  CAST(JSON_OBJECT('supplierInvoiceId',si.`id`,'legacyPurchaseOrderId',si.`legacyPurchaseOrderId`,
    'liabilityClass',si.`liabilityClass`,'paymentGate',si.`paymentGate`,'paymentGateReason',si.`paymentGateReason`,
    'totalAmount',si.`totalAmount`,'legacySettledAmount',si.`legacySettledAmount`,
    'legacySettlementEvidenceHash',si.`legacySettlementEvidenceHash`) AS CHAR CHARACTER SET utf8mb4),
  SHA2(CONCAT_WS('|','LEGACY-AP-INTEGRITY',si.`id`,si.`legacyPurchaseOrderId`,si.`liabilityClass`,si.`paymentGate`,
    COALESCE(si.`paymentGateReason`,''),si.`totalAmount`,si.`legacySettledAmount`,COALESCE(si.`legacySettlementEvidenceHash`,'')),256),
  NULL
FROM `supplierInvoices` si
WHERE si.`origin` = 'LEGACY'
  AND si.`paymentGate` = 'BLOCKED_REVIEW'
  AND NOT EXISTS (
    SELECT 1 FROM `purchaseIntegrityCases` existing
    WHERE existing.`caseKey` = CONCAT('LEGACY-AP-REVIEW:',si.`id`)
  );
--> statement-breakpoint

INSERT INTO `purchaseIntegrityCaseEvents` (
  `eventKey`,`caseId`,`branchId`,`eventType`,`actorType`,`previousStatus`,`newStatus`,
  `payloadCanonical`,`payloadHash`,`evidenceReference`,`reason`,`actorId`,`counterpartyActorId`
)
SELECT
  CONCAT(c.`caseKey`,':OPENED'),c.`id`,c.`branchId`,'OPENED','SYSTEM',NULL,'OPEN',
  c.`evidenceSnapshot`,
  SHA2(CONCAT_WS('|','PURCHASE-INTEGRITY-OPENED',c.`caseKey`,c.`evidenceHash`),256),
  CONCAT('supplierInvoice:',c.`supplierInvoiceId`),c.`description`,NULL,NULL
FROM `purchaseIntegrityCases` c
WHERE c.`origin` = 'SYSTEM' AND c.`caseKey` LIKE 'LEGACY-AP-REVIEW:%'
  AND NOT EXISTS (
    SELECT 1 FROM `purchaseIntegrityCaseEvents` existing
    WHERE existing.`eventKey` = CONCAT(c.`caseKey`,':OPENED')
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_purchase_integrity_events_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_purchase_integrity_events_bu`
BEFORE UPDATE ON `purchaseIntegrityCaseEvents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase integrity events are append-only';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_purchase_integrity_events_bd`;
--> statement-breakpoint

CREATE TRIGGER `trg_purchase_integrity_events_bd`
BEFORE DELETE ON `purchaseIntegrityCaseEvents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase integrity events are append-only';
END;
