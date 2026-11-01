-- Append-only owner evidence for classifying a legacy advance into one exact payroll period.
-- This migration creates no payroll run, receipt, accounting entry, or historical data backfill.
CREATE TABLE IF NOT EXISTS `employeeAdvancePeriodClassifications` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `advanceId` bigint NOT NULL,
  `employeeId` bigint NOT NULL,
  `branchId` bigint NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `remaining` decimal(15,2) NOT NULL,
  `advancePeriodClassificationDirection` enum('APPLY','REVERSE') NOT NULL,
  `reversalOfId` bigint NULL,
  `payrollPeriod` varchar(7) NOT NULL,
  `sourceKey` varchar(191) NOT NULL,
  `sourceHash` char(64) NOT NULL,
  `advancePeriodClassificationEvidenceKind` enum('OWNER_ATTESTATION') NOT NULL,
  `evidenceReference` varchar(500) NOT NULL,
  `evidenceHash` char(64) NOT NULL,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `employeeAdvancePeriodClassifications_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_advperiod_source` UNIQUE (`sourceKey`),
  CONSTRAINT `uq_advperiod_reverse` UNIQUE (`reversalOfId`),
  KEY `idx_advperiod_advance_direction_id` (`advanceId`, `advancePeriodClassificationDirection`, `id`),
  KEY `idx_advperiod_period_direction_id` (`payrollPeriod`, `advancePeriodClassificationDirection`, `id`),
  CONSTRAINT `fk_advperiod_advance`
    FOREIGN KEY (`advanceId`) REFERENCES `employeeAdvances` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_advperiod_employee`
    FOREIGN KEY (`employeeId`) REFERENCES `employees` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_advperiod_branch`
    FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_advperiod_reverse`
    FOREIGN KEY (`reversalOfId`) REFERENCES `employeeAdvancePeriodClassifications` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_advperiod_actor`
    FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `chk_advperiod_positive` CHECK (`amount` > 0),
  CONSTRAINT `chk_advperiod_remaining` CHECK (`remaining` > 0 AND `remaining` <= `amount`),
  CONSTRAINT `chk_advperiod_reversal_shape` CHECK (
    (`advancePeriodClassificationDirection` = 'APPLY' AND `reversalOfId` IS NULL)
    OR (`advancePeriodClassificationDirection` = 'REVERSE' AND `reversalOfId` IS NOT NULL)
  ),
  CONSTRAINT `chk_advperiod_period` CHECK (
    `payrollPeriod` REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'
  )
) ENGINE=InnoDB;
