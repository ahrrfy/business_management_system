-- 0197: governed maker/checker reopening for immutable year-end revisions.
-- No historical row is fabricated: only explicit post-deploy requests populate this table.
SET NAMES utf8mb4;
--> statement-breakpoint
CREATE TABLE `yearEndReopenRequests` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `year` int NOT NULL,
  `snapshotId` bigint NOT NULL,
  `certificateId` bigint NOT NULL,
  `periodId` bigint NOT NULL,
  `yearEndReopenStatus` enum('PENDING_APPROVAL','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING_APPROVAL',
  `pendingSnapshotId` bigint NULL,
  `clientRequestId` varchar(64) NOT NULL,
  `requestPayloadHash` char(64) NOT NULL,
  `requestedBy` int NOT NULL,
  `requestedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reason` varchar(500) NOT NULL,
  `decidedBy` int NULL,
  `decidedAt` timestamp NULL,
  `decisionReason` varchar(500) NULL,
  `reversalEntryId` bigint NULL,
  `reopenEventId` bigint NULL,
  CONSTRAINT `pk_yerr` PRIMARY KEY (`id`),
  CONSTRAINT `uq_yerr_client_request` UNIQUE (`clientRequestId`),
  CONSTRAINT `uq_yerr_pending_snapshot` UNIQUE (`pendingSnapshotId`),
  CONSTRAINT `uq_yerr_reversal_entry` UNIQUE (`reversalEntryId`),
  CONSTRAINT `uq_yerr_reopen_event` UNIQUE (`reopenEventId`),
  CONSTRAINT `fk_yerr_snapshot`
    FOREIGN KEY (`snapshotId`) REFERENCES `yearEndSnapshots`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_yerr_certificate`
    FOREIGN KEY (`certificateId`) REFERENCES `monthCloseCertificates`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_yerr_period`
    FOREIGN KEY (`periodId`) REFERENCES `financialPeriods`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_yerr_pending_snapshot`
    FOREIGN KEY (`pendingSnapshotId`) REFERENCES `yearEndSnapshots`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_yerr_requested_by`
    FOREIGN KEY (`requestedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_yerr_decided_by`
    FOREIGN KEY (`decidedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_yerr_reversal_entry`
    FOREIGN KEY (`reversalEntryId`) REFERENCES `accountingEntries`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_yerr_reopen_event`
    FOREIGN KEY (`reopenEventId`) REFERENCES `monthCloseEvents`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_yerr_identity` CHECK (
    `year` BETWEEN 2020 AND 2100 AND
    CHAR_LENGTH(TRIM(`reason`)) >= 10 AND
    CHAR_LENGTH(`requestPayloadHash`) = 64
  ),
  CONSTRAINT `chk_yerr_maker_checker` CHECK (
    `decidedBy` IS NULL OR `decidedBy` <> `requestedBy`
  ),
  CONSTRAINT `chk_yerr_lifecycle` CHECK (
    (`yearEndReopenStatus` = 'PENDING_APPROVAL' AND `pendingSnapshotId` = `snapshotId`
      AND `decidedBy` IS NULL AND `decidedAt` IS NULL AND `decisionReason` IS NULL
      AND `reversalEntryId` IS NULL AND `reopenEventId` IS NULL) OR
    (`yearEndReopenStatus` = 'APPROVED' AND `pendingSnapshotId` IS NULL
      AND `decidedBy` IS NOT NULL AND `decidedAt` IS NOT NULL
      AND CHAR_LENGTH(TRIM(`decisionReason`)) >= 5
      AND `reversalEntryId` IS NOT NULL AND `reopenEventId` IS NOT NULL) OR
    (`yearEndReopenStatus` = 'REJECTED' AND `pendingSnapshotId` IS NULL
      AND `decidedBy` IS NOT NULL AND `decidedAt` IS NOT NULL
      AND CHAR_LENGTH(TRIM(`decisionReason`)) >= 5
      AND `reversalEntryId` IS NULL AND `reopenEventId` IS NULL)
  ),
  INDEX `idx_yerr_year_status` (`year`,`yearEndReopenStatus`,`requestedAt`)
);
--> statement-breakpoint
CREATE TRIGGER `trg_yerr_guard_update` BEFORE UPDATE ON `yearEndReopenRequests`
FOR EACH ROW
BEGIN
  IF OLD.`yearEndReopenStatus` <> 'PENDING_APPROVAL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decided year end reopen requests are immutable';
  END IF;
  IF NOT (
    OLD.`year` <=> NEW.`year` AND
    OLD.`snapshotId` <=> NEW.`snapshotId` AND
    OLD.`certificateId` <=> NEW.`certificateId` AND
    OLD.`periodId` <=> NEW.`periodId` AND
    OLD.`clientRequestId` <=> NEW.`clientRequestId` AND
    OLD.`requestPayloadHash` <=> NEW.`requestPayloadHash` AND
    OLD.`requestedBy` <=> NEW.`requestedBy` AND
    OLD.`requestedAt` <=> NEW.`requestedAt` AND
    OLD.`reason` <=> NEW.`reason`
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end reopen request identity is immutable';
  END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_yerr_no_delete` BEFORE DELETE ON `yearEndReopenRequests`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end reopen requests are append-only';
