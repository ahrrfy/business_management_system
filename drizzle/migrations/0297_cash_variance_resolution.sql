-- Append-only maker/checker resolution for custody and daily treasury cash variances.
SET NAMES utf8mb4;
--> statement-breakpoint
ALTER TABLE `cashDailyReconciliations`
  MODIFY COLUMN `cashDailyReconciliationStatus`
  enum('MATCHED','VARIANCE_OPEN','RESOLVED_WITH_ADJUSTMENT','CLOSED','REOPENED') NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cashVarianceCases` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `branchId` bigint NOT NULL,
  `cashVarianceSourceType` enum('CUSTODY','DAILY_TREASURY') NOT NULL,
  `custodyReceiptId` bigint NULL,
  `custodyCountId` bigint NULL,
  `dailyReconciliationId` bigint NULL,
  `sourceVersion` int NOT NULL DEFAULT 1,
  `sourceReference` varchar(100) NOT NULL,
  `sourceEvidenceHash` char(64) NULL,
  `expectedAmount` decimal(15,2) NOT NULL,
  `actualAmount` decimal(15,2) NOT NULL,
  `variance` decimal(15,2) NOT NULL,
  `cashVarianceReasonCode` enum('COUNT_ERROR','UNRECORDED_CASH_IN','UNRECORDED_CASH_OUT','CUSTODY_LOSS','DOCUMENTATION_ERROR','OTHER') NOT NULL,
  `reason` varchar(500) NOT NULL,
  `evidenceReference` varchar(2000) NOT NULL,
  `responsibleUserId` int NULL,
  `responsibleEmployeeId` bigint NULL,
  `responsibleNameSnapshot` varchar(255) NULL,
  `countedByUserId` int NOT NULL,
  `proposedByUserId` int NOT NULL,
  `proposalClientRequestId` varchar(64) NOT NULL,
  `proposalRequestHash` char(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `cashVarianceCases_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_cash_variance_proposal_request` UNIQUE (`proposalClientRequestId`),
  CONSTRAINT `uq_cash_variance_custody_count` UNIQUE (`custodyCountId`),
  CONSTRAINT `uq_cash_variance_daily_version` UNIQUE (`dailyReconciliationId`,`sourceVersion`),
  INDEX `idx_cash_variance_branch_created` (`branchId`,`createdAt`),
  CONSTRAINT `fk_cash_variance_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_cash_variance_custody_receipt` FOREIGN KEY (`custodyReceiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `fk_cash_variance_custody_count` FOREIGN KEY (`custodyCountId`) REFERENCES `cashCustodyCounts` (`id`),
  CONSTRAINT `fk_cash_variance_daily` FOREIGN KEY (`dailyReconciliationId`) REFERENCES `cashDailyReconciliations` (`id`),
  CONSTRAINT `fk_cash_variance_responsible` FOREIGN KEY (`responsibleUserId`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_cash_variance_employee` FOREIGN KEY (`responsibleEmployeeId`) REFERENCES `employees` (`id`),
  CONSTRAINT `fk_cash_variance_counter` FOREIGN KEY (`countedByUserId`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_cash_variance_proposer` FOREIGN KEY (`proposedByUserId`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_cash_variance_source_shape` CHECK (
    (`cashVarianceSourceType` = 'CUSTODY' AND `custodyReceiptId` IS NOT NULL AND `custodyCountId` IS NOT NULL AND `dailyReconciliationId` IS NULL AND `sourceEvidenceHash` IS NULL AND (
      (`variance` < 0 AND `responsibleUserId` IS NOT NULL AND `responsibleEmployeeId` IS NOT NULL AND `responsibleNameSnapshot` IS NOT NULL)
      OR (`variance` > 0 AND `responsibleUserId` IS NULL AND `responsibleEmployeeId` IS NULL AND `responsibleNameSnapshot` IS NULL)
    ))
    OR
    (`cashVarianceSourceType` = 'DAILY_TREASURY' AND `custodyReceiptId` IS NULL AND `custodyCountId` IS NULL AND `dailyReconciliationId` IS NOT NULL AND `sourceEvidenceHash` IS NOT NULL AND `responsibleUserId` IS NULL AND `responsibleEmployeeId` IS NULL AND `responsibleNameSnapshot` IS NULL)
  ),
  CONSTRAINT `chk_cash_variance_amounts` CHECK (`expectedAmount` >= 0 AND `actualAmount` >= 0 AND `variance` <> 0 AND `variance` = `actualAmount` - `expectedAmount`),
  CONSTRAINT `chk_cash_variance_source_version` CHECK (`sourceVersion` > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cashVarianceCaseEvents` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `caseId` bigint NOT NULL,
  `version` int NOT NULL,
  `cashVarianceEventType` enum('PROPOSED','APPROVED','REJECTED') NOT NULL,
  `clientRequestId` varchar(64) NOT NULL,
  `requestHash` char(64) NOT NULL,
  `actorUserId` int NOT NULL,
  `note` varchar(500) NULL,
  `cashVarianceCounterAccountRole` enum('EMPLOYEE_ADVANCES','LOSSES','OTHER_LIABILITY') NULL,
  `resolvedVariance` decimal(15,2) NULL,
  `adjustmentReceiptId` bigint NULL,
  `accountingEntryId` bigint NULL,
  `advanceId` bigint NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `cashVarianceCaseEvents_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_cash_variance_event_request` UNIQUE (`clientRequestId`),
  CONSTRAINT `uq_cash_variance_adjustment_receipt` UNIQUE (`adjustmentReceiptId`),
  CONSTRAINT `uq_cash_variance_accounting_entry` UNIQUE (`accountingEntryId`),
  CONSTRAINT `uq_cash_variance_advance` UNIQUE (`advanceId`),
  CONSTRAINT `uq_cash_variance_case_version` UNIQUE (`caseId`,`version`),
  INDEX `idx_cash_variance_case_created` (`caseId`,`createdAt`),
  CONSTRAINT `fk_cash_variance_event_case` FOREIGN KEY (`caseId`) REFERENCES `cashVarianceCases` (`id`),
  CONSTRAINT `fk_cash_variance_event_actor` FOREIGN KEY (`actorUserId`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_cash_variance_event_receipt` FOREIGN KEY (`adjustmentReceiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `fk_cash_variance_event_entry` FOREIGN KEY (`accountingEntryId`) REFERENCES `accountingEntries` (`id`),
  CONSTRAINT `fk_cash_variance_advance` FOREIGN KEY (`advanceId`) REFERENCES `employeeAdvances` (`id`),
  CONSTRAINT `chk_cash_variance_event_version` CHECK (`version` > 0),
  CONSTRAINT `chk_cash_variance_resolution_shape` CHECK (
    (`cashVarianceEventType` = 'APPROVED' AND `cashVarianceCounterAccountRole` = 'EMPLOYEE_ADVANCES' AND `resolvedVariance` < 0 AND `adjustmentReceiptId` IS NOT NULL AND `accountingEntryId` IS NOT NULL AND `advanceId` IS NOT NULL)
    OR
    (`cashVarianceEventType` = 'APPROVED' AND `cashVarianceCounterAccountRole` = 'LOSSES' AND `resolvedVariance` < 0 AND `adjustmentReceiptId` IS NOT NULL AND `accountingEntryId` IS NOT NULL AND `advanceId` IS NULL)
    OR
    (`cashVarianceEventType` = 'APPROVED' AND `cashVarianceCounterAccountRole` = 'OTHER_LIABILITY' AND `resolvedVariance` > 0 AND `adjustmentReceiptId` IS NOT NULL AND `accountingEntryId` IS NOT NULL AND `advanceId` IS NULL)
    OR
    (`cashVarianceEventType` <> 'APPROVED' AND `cashVarianceCounterAccountRole` IS NULL AND `resolvedVariance` IS NULL AND `adjustmentReceiptId` IS NULL AND `accountingEntryId` IS NULL AND `advanceId` IS NULL)
  )
);
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_cash_variance_cases_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_variance_cases_bu` BEFORE UPDATE ON `cashVarianceCases`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cash variance cases are append-only';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_variance_cases_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_variance_cases_bd` BEFORE DELETE ON `cashVarianceCases`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cash variance cases are append-only';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_variance_events_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_variance_events_bu` BEFORE UPDATE ON `cashVarianceCaseEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cash variance events are append-only';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_variance_events_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_variance_events_bd` BEFORE DELETE ON `cashVarianceCaseEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cash variance events are append-only';
