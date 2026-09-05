-- 0309 — طلبات شطب عجز عهدة COD.
-- إنشاء الطلب صفر أثر؛ الاعتماد المستقل وحده ينفّذ الشطب داخل نفس المعاملة.

-- MySQL 8 لا يدعم ADD COLUMN IF NOT EXISTS؛ نفّذ DDL مشروطاً عبر metadata.
SET @needs_delivery_party_version := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'deliveryParties' AND column_name = 'version'
);
SET @sql := IF(
  @needs_delivery_party_version,
  'ALTER TABLE `deliveryParties` ADD COLUMN `version` INT NOT NULL DEFAULT 1 AFTER `currentBalance`',
  'SELECT ''deliveryParties.version exists'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `deliveryCodWriteOffRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `partyId` BIGINT NOT NULL,
  `consignmentId` BIGINT NULL,
  `branchId` BIGINT NOT NULL,
  `status` ENUM('PENDING','APPROVED','REJECTED','STALE') NOT NULL DEFAULT 'PENDING',
  `basePartyVersion` INT NOT NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `payload` JSON NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `evidenceNote` VARCHAR(500) NULL,
  `attachmentUrl` VARCHAR(2048) NULL,
  `requestedBy` INT NOT NULL,
  `reviewedBy` INT NULL,
  `reviewedAt` TIMESTAMP NULL,
  `reviewNote` VARCHAR(500) NULL,
  `decisionKey` VARCHAR(120) NULL,
  `decisionHash` CHAR(64) NULL,
  `appliedAt` TIMESTAMP NULL,
  `pendingGuard` VARCHAR(160) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_delivery_cod_writeoff_request_key` (`requestKey`),
  UNIQUE KEY `uq_delivery_cod_writeoff_pending` (`pendingGuard`),
  UNIQUE KEY `uq_delivery_cod_writeoff_decision` (`decisionKey`),
  KEY `idx_delivery_cod_writeoff_party_status` (`partyId`,`status`),
  KEY `idx_delivery_cod_writeoff_branch_status` (`branchId`,`status`),
  KEY `idx_delivery_cod_writeoff_requester` (`requestedBy`),
  KEY `idx_delivery_cod_writeoff_reviewer` (`reviewedBy`),
  CONSTRAINT `fk_delivery_cod_writeoff_party` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties` (`id`),
  CONSTRAINT `fk_delivery_cod_writeoff_consignment` FOREIGN KEY (`consignmentId`) REFERENCES `deliveryConsignments` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_delivery_cod_writeoff_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_delivery_cod_writeoff_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_delivery_cod_writeoff_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_delivery_cod_writeoff_amount` CHECK (`amount` > 0),
  CONSTRAINT `chk_delivery_cod_writeoff_evidence` CHECK (`evidenceNote` IS NOT NULL OR `attachmentUrl` IS NOT NULL),
  CONSTRAINT `chk_delivery_cod_writeoff_decision` CHECK (
    (`status` = 'PENDING' AND `pendingGuard` IS NOT NULL AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `decisionKey` IS NULL AND `decisionHash` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_delivery_cod_writeoff_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_delivery_parties_version_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_delivery_parties_version_bu`
BEFORE UPDATE ON `deliveryParties`
FOR EACH ROW
BEGIN
  SET NEW.`version` = OLD.`version` + 1;
END;
