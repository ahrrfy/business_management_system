-- Delivery phase 2: separate physical parcel state from money state, add
-- company memberships, immutable remittance allocations, operational ledger,
-- mandatory transition history, and a transactional outbox.
-- Every DDL operation is idempotent for tenant-by-tenant reconciliation.

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'sourceType') = 0,
  "ALTER TABLE `deliveryConsignments` ADD COLUMN `sourceType` ENUM('WORK_ORDER','ONLINE_ORDER','INVOICE') NOT NULL DEFAULT 'INVOICE' AFTER `workOrderId`",
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'sourceId') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `sourceId` BIGINT NULL AFTER `sourceType`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'assignedUserId') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `assignedUserId` INT NULL AFTER `sourceId`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'governorate') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `governorate` VARCHAR(40) NULL AFTER `deliveryAddress`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'latitude') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `latitude` DECIMAL(10,7) NULL AFTER `governorate`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'longitude') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `longitude` DECIMAL(10,7) NULL AFTER `latitude`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'parcelStatus') = 0,
  "ALTER TABLE `deliveryConsignments` ADD COLUMN `parcelStatus` ENUM('ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED','FAILED','RETURNED') NOT NULL DEFAULT 'ASSIGNED' AFTER `deliveryAddress`",
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'moneyStatus') = 0,
  "ALTER TABLE `deliveryConsignments` ADD COLUMN `moneyStatus` ENUM('NOT_APPLICABLE','UNSETTLED','PARTIAL','SETTLED','CANCELLED','WRITTEN_OFF') NOT NULL DEFAULT 'UNSETTLED' AFTER `parcelStatus`",
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'moneyStatus' AND COLUMN_TYPE LIKE '%CANCELLED%') = 0,
  "ALTER TABLE `deliveryConsignments` MODIFY COLUMN `moneyStatus` ENUM('NOT_APPLICABLE','UNSETTLED','PARTIAL','SETTLED','CANCELLED','WRITTEN_OFF') NOT NULL DEFAULT 'UNSETTLED'",
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'acceptedAt') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `acceptedAt` TIMESTAMP NULL AFTER `dispatchedAt`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'pickedUpAt') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `pickedUpAt` TIMESTAMP NULL AFTER `acceptedAt`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'outForDeliveryAt') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `outForDeliveryAt` TIMESTAMP NULL AFTER `pickedUpAt`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'failedAt') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `failedAt` TIMESTAMP NULL AFTER `courierDeliveredAt`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'custodyRecognizedAt') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `custodyRecognizedAt` TIMESTAMP NULL AFTER `courierDeliveredAt`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'failureReason') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `failureReason` VARCHAR(500) NULL AFTER `failedAt`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'returnedAt') = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `returnedAt` TIMESTAMP NULL AFTER `failureReason`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

UPDATE `deliveryConsignments`
SET `sourceType` = CASE WHEN `workOrderId` IS NOT NULL THEN 'WORK_ORDER' ELSE 'INVOICE' END,
    `sourceId` = COALESCE(`workOrderId`, `invoiceId`),
    `parcelStatus` = CASE
      WHEN `consignmentStatus` = 'RETURNED' THEN 'RETURNED'
      WHEN `courierDeliveredAt` IS NOT NULL THEN 'DELIVERED'
      ELSE 'OUT_FOR_DELIVERY'
    END,
    `moneyStatus` = CASE
      WHEN CAST(`codAmount` AS DECIMAL(15,2)) = 0 THEN 'NOT_APPLICABLE'
      WHEN `consignmentStatus` = 'WRITTEN_OFF' THEN 'WRITTEN_OFF'
      WHEN CAST(`collectedAmount` AS DECIMAL(15,2)) >= CAST(`codAmount` AS DECIMAL(15,2)) THEN 'SETTLED'
      WHEN CAST(`collectedAmount` AS DECIMAL(15,2)) > 0 THEN 'PARTIAL'
      ELSE 'UNSETTLED'
    END,
    `custodyRecognizedAt` = CASE
      WHEN CAST(`codAmount` AS DECIMAL(15,2)) > CAST(`collectedAmount` AS DECIMAL(15,2))
        THEN COALESCE(`courierDeliveredAt`, `updatedAt`, NOW())
      ELSE `custodyRecognizedAt`
    END
WHERE `sourceId` IS NULL;
--> statement-breakpoint

ALTER TABLE `deliveryConsignments` MODIFY COLUMN `sourceId` BIGINT NOT NULL;
--> statement-breakpoint

UPDATE `deliveryConsignments` dc
JOIN `deliveryParties` dp ON dp.id = dc.partyId
SET dc.assignedUserId = dp.userId
WHERE dc.assignedUserId IS NULL
  AND dp.userId IS NOT NULL
  AND dp.deliveryPartyKind = 'INDIVIDUAL'
  AND dc.custodyRecognizedAt IS NOT NULL;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND INDEX_NAME = 'uq_consignment_source') = 0,
  'ALTER TABLE `deliveryConsignments` ADD UNIQUE KEY `uq_consignment_source` (`sourceType`,`sourceId`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND INDEX_NAME = 'idx_consignment_parcel_queue') = 0,
  'ALTER TABLE `deliveryConsignments` ADD KEY `idx_consignment_parcel_queue` (`partyId`,`parcelStatus`,`assignedUserId`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND INDEX_NAME = 'idx_consignment_money_queue') = 0,
  'ALTER TABLE `deliveryConsignments` ADD KEY `idx_consignment_money_queue` (`partyId`,`moneyStatus`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `deliveryPartyMembers` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `partyId` BIGINT NOT NULL,
  `userId` INT NOT NULL,
  `memberRole` ENUM('DRIVER','MANAGER','ACCOUNTANT') NOT NULL DEFAULT 'DRIVER',
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `createdBy` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_delivery_party_member` (`partyId`,`userId`),
  UNIQUE KEY `uq_delivery_party_member_user` (`userId`),
  KEY `idx_delivery_party_member_active` (`partyId`,`isActive`),
  CONSTRAINT `fk_delivery_party_member_party` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_delivery_party_member_user` FOREIGN KEY (`userId`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_delivery_party_member_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;
--> statement-breakpoint

INSERT IGNORE INTO `deliveryPartyMembers` (`partyId`,`userId`,`memberRole`,`isActive`,`createdAt`,`updatedAt`)
SELECT dp.id, dp.userId,
       CASE WHEN dp.deliveryPartyKind = 'COMPANY' THEN 'MANAGER' ELSE 'DRIVER' END,
       TRUE, NOW(), NOW()
FROM `deliveryParties` dp
JOIN `users` u ON u.id = dp.userId AND u.isActive = TRUE
WHERE dp.userId IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `deliveryRemittanceLines` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `remittanceId` BIGINT NOT NULL,
  `consignmentId` BIGINT NOT NULL,
  `grossApplied` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `feeOffset` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `cashReceived` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `writtenOffAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `legacySnapshot` BOOLEAN NOT NULL DEFAULT FALSE,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_delivery_remittance_line` (`remittanceId`,`consignmentId`),
  KEY `idx_delivery_remittance_line_cn` (`consignmentId`,`createdAt`),
  CONSTRAINT `fk_delivery_remit_line_header` FOREIGN KEY (`remittanceId`) REFERENCES `deliveryRemittances` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_delivery_remit_line_cn` FOREIGN KEY (`consignmentId`) REFERENCES `deliveryConsignments` (`id`)
) ENGINE=InnoDB;
--> statement-breakpoint

INSERT IGNORE INTO `deliveryRemittanceLines`
  (`remittanceId`,`consignmentId`,`grossApplied`,`feeOffset`,`cashReceived`,`writtenOffAmount`,`legacySnapshot`,`createdAt`)
SELECT dc.remittanceId, dc.id, dc.collectedAmount, 0, dc.collectedAmount, 0, TRUE,
       COALESCE(dc.settledAt, dc.updatedAt, dc.createdAt)
FROM `deliveryConsignments` dc
WHERE dc.remittanceId IS NOT NULL AND CAST(dc.collectedAmount AS DECIMAL(15,2)) > 0;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `deliveryLedgerEntries` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `eventKey` VARCHAR(160) NOT NULL,
  `partyId` BIGINT NOT NULL,
  `consignmentId` BIGINT NULL,
  `remittanceId` BIGINT NULL,
  `branchId` BIGINT NULL,
  `entryType` ENUM('COD_ASSIGNED','COD_COLLECTED','COD_REMITTED','COD_RELEASED','COD_WRITTEN_OFF','COD_RECOVERED','FEE_EARNED','FEE_PAID','FEE_OFFSET','FEE_REFUNDED') NOT NULL,
  `amount` DECIMAL(15,2) NOT NULL,
  `notes` VARCHAR(500) NULL,
  `createdBy` INT NULL,
  `occurredAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_delivery_ledger_event` (`eventKey`),
  KEY `idx_delivery_ledger_party_time` (`partyId`,`occurredAt`),
  KEY `idx_delivery_ledger_cn` (`consignmentId`),
  KEY `idx_delivery_ledger_remit` (`remittanceId`),
  CONSTRAINT `fk_delivery_ledger_party` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties` (`id`),
  CONSTRAINT `fk_delivery_ledger_cn` FOREIGN KEY (`consignmentId`) REFERENCES `deliveryConsignments` (`id`),
  CONSTRAINT `fk_delivery_ledger_remit` FOREIGN KEY (`remittanceId`) REFERENCES `deliveryRemittances` (`id`),
  CONSTRAINT `fk_delivery_ledger_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_delivery_ledger_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryLedgerEntries' AND COLUMN_NAME = 'branchId') = 'NO',
  'ALTER TABLE `deliveryLedgerEntries` MODIFY COLUMN `branchId` BIGINT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryLedgerEntries' AND COLUMN_NAME = 'entryType' AND COLUMN_TYPE LIKE '%COD_RECOVERED%') = 0,
  "ALTER TABLE `deliveryLedgerEntries` MODIFY COLUMN `entryType` ENUM('COD_ASSIGNED','COD_COLLECTED','COD_REMITTED','COD_RELEASED','COD_WRITTEN_OFF','COD_RECOVERED','FEE_EARNED','FEE_PAID','FEE_OFFSET','FEE_REFUNDED') NOT NULL",
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

INSERT IGNORE INTO `deliveryLedgerEntries`
  (`eventKey`,`partyId`,`consignmentId`,`branchId`,`entryType`,`amount`,`notes`,`occurredAt`)
SELECT CONCAT('BACKFILL:CN:',dc.id,':COD_ASSIGNED'), dc.partyId, dc.id, dc.branchId,
       'COD_ASSIGNED', dc.codAmount, 'Phase 2 legacy snapshot', dc.dispatchedAt
FROM `deliveryConsignments` dc WHERE CAST(dc.codAmount AS DECIMAL(15,2)) > 0;
--> statement-breakpoint

INSERT IGNORE INTO `deliveryLedgerEntries`
  (`eventKey`,`partyId`,`consignmentId`,`remittanceId`,`branchId`,`entryType`,`amount`,`notes`,`occurredAt`)
SELECT CONCAT('BACKFILL:CN:',dc.id,':COD_COLLECTED'), dc.partyId, dc.id, dc.remittanceId, dc.branchId,
       'COD_COLLECTED', dc.collectedAmount, 'Phase 2 legacy snapshot', COALESCE(dc.settledAt, dc.updatedAt)
FROM `deliveryConsignments` dc WHERE CAST(dc.collectedAmount AS DECIMAL(15,2)) > 0;
--> statement-breakpoint

-- Preserve any outstanding legacy/online-order cash custody that existed only
-- in the mutable party balance.  Shared parties remain deliberately
-- unattributed (branchId NULL) instead of being duplicated into every branch.
INSERT IGNORE INTO `deliveryLedgerEntries`
  (`eventKey`,`partyId`,`branchId`,`entryType`,`amount`,`notes`,`occurredAt`)
SELECT CONCAT('BACKFILL:PARTY:',dp.id,':CASH_CUSTODY'), dp.id, dp.branchId,
       'COD_COLLECTED', dp.currentBalance, 'Phase 2 opening custody balance', NOW()
FROM `deliveryParties` dp
WHERE CAST(dp.currentBalance AS DECIMAL(15,2)) > 0;
--> statement-breakpoint

INSERT IGNORE INTO `deliveryLedgerEntries`
  (`eventKey`,`partyId`,`consignmentId`,`remittanceId`,`branchId`,`entryType`,`amount`,`notes`,`occurredAt`)
SELECT CONCAT('BACKFILL:CN:',dc.id,':COD_REMITTED'), dc.partyId, dc.id, dc.remittanceId, dc.branchId,
       'COD_REMITTED', dc.collectedAmount, 'Phase 2 legacy snapshot', COALESCE(dc.settledAt, dc.updatedAt)
FROM `deliveryConsignments` dc WHERE CAST(dc.collectedAmount AS DECIMAL(15,2)) > 0;
--> statement-breakpoint

INSERT IGNORE INTO `deliveryLedgerEntries`
  (`eventKey`,`partyId`,`consignmentId`,`branchId`,`entryType`,`amount`,`notes`,`occurredAt`)
SELECT CONCAT('BACKFILL:CN:',dc.id,':FEE_EARNED'), dc.partyId, dc.id, dc.branchId,
       'FEE_EARNED', dc.deliveryFee, 'Phase 2 legacy snapshot', dc.courierDeliveredAt
FROM `deliveryConsignments` dc
WHERE dc.courierDeliveredAt IS NOT NULL AND CAST(dc.deliveryFee AS DECIMAL(15,2)) > 0;
--> statement-breakpoint

INSERT IGNORE INTO `deliveryLedgerEntries`
  (`eventKey`,`partyId`,`consignmentId`,`branchId`,`entryType`,`amount`,`notes`,`occurredAt`)
SELECT CONCAT('BACKFILL:CN:',dc.id,':FEE_PAID'), dc.partyId, dc.id, dc.branchId,
       'FEE_PAID', dc.deliveryFee, 'Phase 2 legacy snapshot', COALESCE(dc.feeSettledAt,dc.courierDeliveredAt)
FROM `deliveryConsignments` dc
WHERE CAST(dc.deliveryFee AS DECIMAL(15,2)) > 0
  AND (dc.feeSettledAt IS NOT NULL OR (dc.courierDeliveredAt IS NOT NULL AND dc.consignmentFeeCollection = 'COURIER'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `deliveryEvents` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `eventKey` VARCHAR(160) NOT NULL,
  `consignmentId` BIGINT NOT NULL,
  `eventType` VARCHAR(60) NOT NULL,
  `fromParcelStatus` VARCHAR(30) NULL,
  `toParcelStatus` VARCHAR(30) NULL,
  `fromMoneyStatus` VARCHAR(30) NULL,
  `toMoneyStatus` VARCHAR(30) NULL,
  `payload` JSON NULL,
  `actorUserId` INT NULL,
  `occurredAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_delivery_event_key` (`eventKey`),
  KEY `idx_delivery_event_cn_time` (`consignmentId`,`occurredAt`),
  CONSTRAINT `fk_delivery_event_cn` FOREIGN KEY (`consignmentId`) REFERENCES `deliveryConsignments` (`id`),
  CONSTRAINT `fk_delivery_event_actor` FOREIGN KEY (`actorUserId`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;
--> statement-breakpoint

INSERT IGNORE INTO `deliveryEvents`
  (`eventKey`,`consignmentId`,`eventType`,`toParcelStatus`,`toMoneyStatus`,`payload`,`occurredAt`)
SELECT CONCAT('BACKFILL:CN:',dc.id,':MIGRATED'), dc.id, 'MIGRATED', dc.parcelStatus, dc.moneyStatus,
       JSON_OBJECT('legacyStatus',dc.consignmentStatus,'legacyRemittanceId',dc.remittanceId), dc.updatedAt
FROM `deliveryConsignments` dc;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `deliveryOutbox` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `eventId` BIGINT NOT NULL,
  `topic` VARCHAR(100) NOT NULL,
  `payload` JSON NOT NULL,
  `attempts` INT NOT NULL DEFAULT 0,
  `availableAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `processedAt` TIMESTAMP NULL,
  `lastError` VARCHAR(500) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_delivery_outbox_pending` (`processedAt`,`availableAt`),
  CONSTRAINT `fk_delivery_outbox_event` FOREIGN KEY (`eventId`) REFERENCES `deliveryEvents` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND CONSTRAINT_NAME = 'fk_consignment_assigned_user') = 0,
  'ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `fk_consignment_assigned_user` FOREIGN KEY (`assignedUserId`) REFERENCES `users` (`id`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
