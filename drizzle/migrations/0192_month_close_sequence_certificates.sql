-- 0192: serialized month-close frontier and immutable approval certificates.
-- Historical locks are deliberately NOT certified. The owner must explicitly
-- bootstrap the sequence through the application and acknowledge the legacy baseline.
SET NAMES utf8mb4;
--> statement-breakpoint
ALTER TABLE `financialPeriods`
  ADD COLUMN `closeMonth` varchar(7) NULL AFTER `lockedAt`,
  ADD COLUMN `closeRevision` int NULL AFTER `closeMonth`,
  ADD COLUMN `predecessorPeriodId` bigint NULL AFTER `closeRevision`,
  ADD CONSTRAINT `uq_period_close_revision` UNIQUE (`closeMonth`,`closeRevision`),
  ADD CONSTRAINT `chk_period_close_identity` CHECK (
    (`closeMonth` IS NULL AND `closeRevision` IS NULL) OR
    (`closeMonth` REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$' AND `closeRevision` > 0
      AND DATE_FORMAT(LAST_DAY(`cutoffDate`),'%Y-%m') = `closeMonth`)
  ),
  ADD CONSTRAINT `fk_period_predecessor`
    FOREIGN KEY (`predecessorPeriodId`) REFERENCES `financialPeriods`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER `trg_period_predecessor_bi` BEFORE INSERT ON `financialPeriods`
FOR EACH ROW
BEGIN
  IF NEW.`predecessorPeriodId` IS NOT NULL AND NEW.`id` IS NOT NULL
    AND NEW.`id` <> 0 AND NEW.`predecessorPeriodId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'financial period cannot precede itself';
  END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_period_predecessor_bu` BEFORE UPDATE ON `financialPeriods`
FOR EACH ROW
BEGIN
  IF NEW.`predecessorPeriodId` IS NOT NULL AND NEW.`predecessorPeriodId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'financial period cannot precede itself';
  END IF;
END;
--> statement-breakpoint
ALTER TABLE `monthCloseRequests`
  ADD COLUMN `closeRevision` int NULL AFTER `lockedPeriodId`,
  ADD COLUMN `requestedSequenceVersion` bigint NULL AFTER `closeRevision`,
  ADD CONSTRAINT `chk_mcr_sequence_identity` CHECK (
    (`closeRevision` IS NULL AND `requestedSequenceVersion` IS NULL) OR
    (`closeRevision` > 0 AND `requestedSequenceVersion` >= 0)
  );
--> statement-breakpoint
ALTER TABLE `yearEndSnapshots`
  ADD COLUMN `scopeKey` varchar(32) NULL AFTER `year`,
  ADD COLUMN `revision` int NULL AFTER `scopeKey`,
  ADD COLUMN `supersedesSnapshotId` bigint NULL AFTER `branchId`;
--> statement-breakpoint
UPDATE `yearEndSnapshots` y
JOIN (
  SELECT
    `id`,
    CASE WHEN `branchId` IS NULL THEN 'COMPANY' ELSE CONCAT('BRANCH:', `branchId`) END AS `scopeKey`,
    ROW_NUMBER() OVER (
      PARTITION BY `year`, COALESCE(`branchId`, -1)
      ORDER BY `id`
    ) AS `revision`
  FROM `yearEndSnapshots`
) ranked ON ranked.`id` = y.`id`
SET y.`scopeKey` = ranked.`scopeKey`, y.`revision` = ranked.`revision`;
--> statement-breakpoint
ALTER TABLE `yearEndSnapshots`
  DROP INDEX `uq_year_branch`,
  MODIFY COLUMN `scopeKey` varchar(32) NOT NULL DEFAULT 'COMPANY',
  MODIFY COLUMN `revision` int NOT NULL DEFAULT 1,
  ADD CONSTRAINT `uq_year_scope_revision` UNIQUE (`year`,`scopeKey`,`revision`),
  ADD CONSTRAINT `chk_year_snapshot_revision` CHECK (`revision` > 0),
  ADD CONSTRAINT `fk_year_end_supersedes`
    FOREIGN KEY (`supersedesSnapshotId`) REFERENCES `yearEndSnapshots`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER `trg_year_supersedes_bi` BEFORE INSERT ON `yearEndSnapshots`
FOR EACH ROW
BEGIN
  IF NEW.`supersedesSnapshotId` IS NOT NULL AND NEW.`id` IS NOT NULL
    AND NEW.`id` <> 0 AND NEW.`supersedesSnapshotId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end snapshot cannot supersede itself';
  END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_year_supersedes_bu` BEFORE UPDATE ON `yearEndSnapshots`
FOR EACH ROW
BEGIN
  IF NEW.`supersedesSnapshotId` IS NOT NULL AND NEW.`supersedesSnapshotId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end snapshot cannot supersede itself';
  END IF;
END;
--> statement-breakpoint
CREATE TABLE `monthCloseCertificates` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `certificateNumber` varchar(32) NOT NULL,
  `month` varchar(7) NOT NULL,
  `revision` int NOT NULL,
  `monthCloseCertificateKind` enum('MONTH_CLOSE','YEAR_END') NOT NULL,
  `requestId` bigint NOT NULL,
  `periodId` bigint NOT NULL,
  `supersedesCertificateId` bigint NULL,
  `previousCertificateId` bigint NULL,
  `previousCertificateHash` char(64) NULL,
  `yearEndSnapshotId` bigint NULL,
  `retainedEarningsEntryId` bigint NULL,
  `requestedBy` int NOT NULL,
  `requestedAt` timestamp NOT NULL,
  `approvedBy` int NOT NULL,
  `approvedAt` timestamp NOT NULL,
  `certificateDoubleEntryMode` enum('OFF','SHADOW','ACTIVE') NOT NULL,
  `cycleId` varchar(36) NULL,
  `openingHash` char(64) NULL,
  `postingPolicyHash` char(64) NULL,
  `canonicalVersion` varchar(32) NOT NULL,
  `requestSnapshotHash` char(64) NOT NULL,
  `approvalReadinessHash` char(64) NOT NULL,
  `evidenceRootHash` char(64) NOT NULL,
  `snapshotCanonical` mediumtext NOT NULL,
  `snapshotHash` char(64) NOT NULL,
  `certificateHash` char(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `monthCloseCertificates_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_month_close_certificate_number` UNIQUE (`certificateNumber`),
  CONSTRAINT `uq_month_close_certificate_request` UNIQUE (`requestId`),
  CONSTRAINT `uq_month_close_certificate_period` UNIQUE (`periodId`),
  CONSTRAINT `uq_month_close_certificate_hash` UNIQUE (`certificateHash`),
  CONSTRAINT `uq_month_close_certificate_revision` UNIQUE (`month`,`revision`),
  CONSTRAINT `chk_mcc_identity` CHECK (
    `month` REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$' AND `revision` > 0
    AND `requestedBy` <> `approvedBy`
  ),
  CONSTRAINT `chk_mcc_previous_pair` CHECK (
    (`previousCertificateId` IS NULL AND `previousCertificateHash` IS NULL) OR
    (`previousCertificateId` IS NOT NULL AND `previousCertificateHash` IS NOT NULL)
  ),
  CONSTRAINT `chk_mcc_kind_refs` CHECK (
    (`monthCloseCertificateKind` = 'MONTH_CLOSE' AND `yearEndSnapshotId` IS NULL AND `retainedEarningsEntryId` IS NULL) OR
    (`monthCloseCertificateKind` = 'YEAR_END' AND `yearEndSnapshotId` IS NOT NULL)
  ),
  CONSTRAINT `chk_mcc_runtime_tuple` CHECK (
    (`certificateDoubleEntryMode` = 'OFF' AND `cycleId` IS NULL AND `openingHash` IS NULL) OR
    (`certificateDoubleEntryMode` IN ('SHADOW','ACTIVE') AND `cycleId` IS NOT NULL AND `openingHash` IS NOT NULL AND `postingPolicyHash` IS NOT NULL)
  ),
  CONSTRAINT `fk_mcc_request` FOREIGN KEY (`requestId`) REFERENCES `monthCloseRequests`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcc_period` FOREIGN KEY (`periodId`) REFERENCES `financialPeriods`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcc_supersedes` FOREIGN KEY (`supersedesCertificateId`) REFERENCES `monthCloseCertificates`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcc_previous` FOREIGN KEY (`previousCertificateId`) REFERENCES `monthCloseCertificates`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcc_year_end` FOREIGN KEY (`yearEndSnapshotId`) REFERENCES `yearEndSnapshots`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcc_retained_entry` FOREIGN KEY (`retainedEarningsEntryId`) REFERENCES `accountingEntries`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcc_requested_by` FOREIGN KEY (`requestedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcc_approved_by` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TRIGGER `trg_mcc_supersedes_bi` BEFORE INSERT ON `monthCloseCertificates`
FOR EACH ROW
BEGIN
  IF NEW.`supersedesCertificateId` IS NOT NULL AND NEW.`id` IS NOT NULL
    AND NEW.`id` <> 0 AND NEW.`supersedesCertificateId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificate cannot supersede itself';
  END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_mcc_supersedes_bu` BEFORE UPDATE ON `monthCloseCertificates`
FOR EACH ROW
BEGIN
  IF NEW.`supersedesCertificateId` IS NOT NULL AND NEW.`supersedesCertificateId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificate cannot supersede itself';
  END IF;
END;
--> statement-breakpoint
CREATE INDEX `idx_month_close_certificate_month` ON `monthCloseCertificates` (`month`,`id`);
--> statement-breakpoint
CREATE TABLE `monthCloseCertificateEvidence` (
  `certificateId` bigint NOT NULL,
  `datasetCode` varchar(48) NOT NULL,
  `chunkNo` int NOT NULL DEFAULT 1,
  `rowCount` int NOT NULL,
  `minId` bigint NULL,
  `maxId` bigint NULL,
  `canonicalRowsHash` char(64) NOT NULL,
  `referenceCanonical` mediumtext NOT NULL,
  CONSTRAINT `monthCloseCertificateEvidence_pk` PRIMARY KEY (`certificateId`,`datasetCode`,`chunkNo`),
  CONSTRAINT `chk_mcce_chunk_shape` CHECK (
    `chunkNo` > 0 AND `rowCount` >= 0 AND
    ((`minId` IS NULL AND `maxId` IS NULL) OR
      (`minId` IS NOT NULL AND `maxId` IS NOT NULL AND `minId` <= `maxId`))
  ),
  CONSTRAINT `fk_mcce_certificate` FOREIGN KEY (`certificateId`) REFERENCES `monthCloseCertificates`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE `monthCloseEvents` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `eventKey` varchar(96) NOT NULL,
  `monthCloseEventType` enum('BOOTSTRAP','CLOSE','UNLOCK') NOT NULL,
  `month` varchar(7) NULL,
  `requestId` bigint NULL,
  `periodId` bigint NULL,
  `certificateId` bigint NULL,
  `actorId` int NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `reason` varchar(500) NULL,
  `payloadCanonical` mediumtext NOT NULL,
  `previousEventHash` char(64) NULL,
  `eventHash` char(64) NOT NULL,
  CONSTRAINT `monthCloseEvents_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_month_close_event_key` UNIQUE (`eventKey`),
  CONSTRAINT `uq_month_close_event_hash` UNIQUE (`eventHash`),
  CONSTRAINT `chk_mce_reference_shape` CHECK (
    (`monthCloseEventType` = 'BOOTSTRAP' AND `requestId` IS NULL AND `certificateId` IS NULL AND
      ((`month` IS NULL AND `periodId` IS NULL) OR (`month` IS NOT NULL AND `periodId` IS NOT NULL))) OR
    (`monthCloseEventType` = 'CLOSE' AND `month` IS NOT NULL AND `requestId` IS NOT NULL AND `periodId` IS NOT NULL AND `certificateId` IS NOT NULL) OR
    (`monthCloseEventType` = 'UNLOCK' AND `month` IS NOT NULL AND `requestId` IS NULL AND `periodId` IS NOT NULL)
  ),
  CONSTRAINT `fk_mce_request` FOREIGN KEY (`requestId`) REFERENCES `monthCloseRequests`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mce_period` FOREIGN KEY (`periodId`) REFERENCES `financialPeriods`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mce_certificate` FOREIGN KEY (`certificateId`) REFERENCES `monthCloseCertificates`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mce_actor` FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_month_close_event_month` ON `monthCloseEvents` (`month`,`id`);
--> statement-breakpoint
CREATE TABLE `monthCloseSequence` (
  `id` int NOT NULL DEFAULT 1,
  `monthCloseSequenceStatus` enum('NEEDS_BOOTSTRAP','READY') NOT NULL DEFAULT 'NEEDS_BOOTSTRAP',
  `sequenceStartMonth` varchar(7) NULL,
  `activeThroughMonth` varchar(7) NULL,
  `nextRequiredMonth` varchar(7) NULL,
  `activePeriodId` bigint NULL,
  `activeCertificateId` bigint NULL,
  `lastEventId` bigint NULL,
  `lastEventHash` char(64) NULL,
  `version` bigint NOT NULL DEFAULT 0,
  `bootstrappedAt` timestamp NULL,
  `bootstrappedBy` int NULL,
  `bootstrapReason` varchar(500) NULL,
  `bootstrapReference` varchar(255) NULL,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `monthCloseSequence_id` PRIMARY KEY (`id`),
  CONSTRAINT `chk_month_close_sequence_singleton` CHECK (`id` = 1),
  CONSTRAINT `chk_mcs_status_tuple` CHECK (
    (`monthCloseSequenceStatus` = 'NEEDS_BOOTSTRAP' AND `sequenceStartMonth` IS NULL AND `nextRequiredMonth` IS NULL) OR
    (`monthCloseSequenceStatus` = 'READY' AND `sequenceStartMonth` IS NOT NULL AND `nextRequiredMonth` IS NOT NULL
      AND `version` > 0 AND `bootstrappedAt` IS NOT NULL AND `bootstrappedBy` IS NOT NULL
      AND `bootstrapReason` IS NOT NULL AND `bootstrapReference` IS NOT NULL)
  ),
  CONSTRAINT `fk_mcs_period` FOREIGN KEY (`activePeriodId`) REFERENCES `financialPeriods`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcs_certificate` FOREIGN KEY (`activeCertificateId`) REFERENCES `monthCloseCertificates`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcs_event` FOREIGN KEY (`lastEventId`) REFERENCES `monthCloseEvents`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_mcs_bootstrap_by` FOREIGN KEY (`bootstrappedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
INSERT INTO `monthCloseSequence` (`id`,`monthCloseSequenceStatus`,`version`)
VALUES (1,'NEEDS_BOOTSTRAP',0)
ON DUPLICATE KEY UPDATE `id` = VALUES(`id`);
--> statement-breakpoint
CREATE TRIGGER `trg_mcc_no_update` BEFORE UPDATE ON `monthCloseCertificates`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificates are immutable';
--> statement-breakpoint
CREATE TRIGGER `trg_mcc_no_delete` BEFORE DELETE ON `monthCloseCertificates`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificates are immutable';
--> statement-breakpoint
CREATE TRIGGER `trg_mcce_no_update` BEFORE UPDATE ON `monthCloseCertificateEvidence`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificate evidence is immutable';
--> statement-breakpoint
CREATE TRIGGER `trg_mcce_no_delete` BEFORE DELETE ON `monthCloseCertificateEvidence`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificate evidence is immutable';
--> statement-breakpoint
CREATE TRIGGER `trg_mce_no_update` BEFORE UPDATE ON `monthCloseEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close events are immutable';
--> statement-breakpoint
CREATE TRIGGER `trg_mce_no_delete` BEFORE DELETE ON `monthCloseEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close events are immutable';
--> statement-breakpoint
CREATE TRIGGER `trg_year_snapshot_no_update` BEFORE UPDATE ON `yearEndSnapshots`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end snapshots are immutable';
--> statement-breakpoint
CREATE TRIGGER `trg_year_snapshot_no_delete` BEFORE DELETE ON `yearEndSnapshots`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end snapshots are immutable';
