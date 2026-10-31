-- Append-only owner attestation that an advance amount was recovered before a stated period.
-- This migration creates no receipt, payroll settlement, GL entry or historical data backfill.
CREATE TABLE IF NOT EXISTS `employeeAdvanceHistoricalRecoveries` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `advanceId` bigint NOT NULL,
  `employeeId` bigint NOT NULL,
  `branchId` bigint NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `historicalAdvanceRecoveryDirection` enum('APPLY','REVERSE') NOT NULL,
  `reversalOfId` bigint NULL,
  `sourceKey` varchar(191) NOT NULL,
  `sourceHash` char(64) NOT NULL,
  `historicalAdvanceRecoveryEvidenceKind` enum('OWNER_ATTESTATION') NOT NULL,
  `evidenceReference` varchar(500) NOT NULL,
  `evidenceHash` char(64) NOT NULL,
  `priorToPeriod` varchar(7) NOT NULL,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `employeeAdvanceHistoricalRecoveries_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_advhist_source` UNIQUE (`sourceKey`),
  CONSTRAINT `uq_advhist_reverse` UNIQUE (`reversalOfId`),
  KEY `idx_advhist_advance_direction_id` (`advanceId`, `historicalAdvanceRecoveryDirection`, `id`),
  CONSTRAINT `fk_advhist_advance`
    FOREIGN KEY (`advanceId`) REFERENCES `employeeAdvances` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_advhist_employee`
    FOREIGN KEY (`employeeId`) REFERENCES `employees` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_advhist_branch`
    FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_advhist_reverse`
    FOREIGN KEY (`reversalOfId`) REFERENCES `employeeAdvanceHistoricalRecoveries` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_advhist_actor`
    FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `chk_advhist_positive` CHECK (`amount` > 0),
  CONSTRAINT `chk_advhist_reversal_shape` CHECK (
    (`historicalAdvanceRecoveryDirection` = 'APPLY' AND `reversalOfId` IS NULL)
    OR (`historicalAdvanceRecoveryDirection` = 'REVERSE' AND `reversalOfId` IS NOT NULL)
  ),
  CONSTRAINT `chk_advhist_prior_period` CHECK (
    `priorToPeriod` REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'
  )
) ENGINE=InnoDB;
