-- 0193: explicit human-approved gross-to-net termination settlement.
-- No statutory or contractual rate is inferred. Every deduction/contribution
-- is entered and attested by a human reviewer, then frozen in the snapshot.
SET NAMES utf8mb4;
--> statement-breakpoint
ALTER TABLE `employeeTerminations`
  DROP CHECK `chk_term_breakdown_nonnegative`,
  DROP CHECK `chk_term_total_derived`,
  RENAME COLUMN `earnedWages` TO `earnedGrossWages`,
  ADD COLUMN `wageReductions` decimal(15,2) NOT NULL DEFAULT 0 AFTER `earnedGrossWages`,
  ADD COLUMN `advanceRecovery` decimal(15,2) NOT NULL DEFAULT 0 AFTER `wageReductions`,
  ADD COLUMN `incomeTax` decimal(15,2) NOT NULL DEFAULT 0 AFTER `advanceRecovery`,
  ADD COLUMN `employeeSocialSecurity` decimal(15,2) NOT NULL DEFAULT 0 AFTER `incomeTax`,
  ADD COLUMN `employerSocialSecurity` decimal(15,2) NOT NULL DEFAULT 0 AFTER `employeeSocialSecurity`,
  ADD COLUMN `settlementEvidenceNote` varchar(500) NULL AFTER `otherSettlementLabel`,
  ADD COLUMN `zeroAmountsAttested` boolean NOT NULL DEFAULT false AFTER `settlementEvidenceNote`;
--> statement-breakpoint
-- Existing 0189 rows retain their exact payout and are marked as migrated
-- evidence. Pending records still require owner review before recognition.
UPDATE `employeeTerminations`
SET `settlementEvidenceNote` = CASE
      WHEN CHAR_LENGTH(TRIM(COALESCE(`reason`, ''))) >= 10
        THEN CONCAT('ترحيل 0191 — ', TRIM(`reason`))
      ELSE 'ترحيل 0191 — تفكيك تاريخي محفوظ دون احتساب قانوني تلقائي'
    END,
    `zeroAmountsAttested` = true;
--> statement-breakpoint
ALTER TABLE `employeeTerminations`
  MODIFY COLUMN `settlementEvidenceNote` varchar(500) NOT NULL,
  ADD CONSTRAINT `chk_term_gross_net_nonnegative` CHECK (
    `earnedGrossWages` >= 0 AND `wageReductions` >= 0 AND
    `advanceRecovery` >= 0 AND `incomeTax` >= 0 AND
    `employeeSocialSecurity` >= 0 AND `employerSocialSecurity` >= 0
  ),
  ADD CONSTRAINT `chk_term_earned_net_nonnegative` CHECK (
    `earnedGrossWages` >= `wageReductions` + `advanceRecovery` +
      `incomeTax` + `employeeSocialSecurity`
  ),
  ADD CONSTRAINT `chk_term_payout_derived` CHECK (
    `settlement` = `earnedGrossWages` - `wageReductions` -
      `advanceRecovery` - `incomeTax` - `employeeSocialSecurity` +
      `leaveCompensation` + `noticeCompensation` + `eosBenefit` +
      `otherSettlement`
  ),
  ADD CONSTRAINT `chk_term_evidence_attested` CHECK (
    `zeroAmountsAttested` = true AND
    CHAR_LENGTH(TRIM(`settlementEvidenceNote`)) >= 10
  );
--> statement-breakpoint
CREATE TABLE `terminationAdvanceAllocations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `terminationId` bigint NOT NULL,
  `advanceId` bigint NOT NULL,
  `accountingEventId` bigint NOT NULL,
  `terminationAdvanceDirection` enum('APPLY','REVERSE') NOT NULL DEFAULT 'APPLY',
  `amount` decimal(15,2) NOT NULL,
  `reversalOfId` bigint NULL,
  `sourceKey` varchar(191) NOT NULL,
  `occurredAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `terminationAdvanceAllocations_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_termadv_source` UNIQUE (`sourceKey`),
  CONSTRAINT `uq_termadv_reversal` UNIQUE (`reversalOfId`),
  CONSTRAINT `fk_termadv_term` FOREIGN KEY (`terminationId`) REFERENCES `employeeTerminations` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_termadv_advance` FOREIGN KEY (`advanceId`) REFERENCES `employeeAdvances` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_termadv_event` FOREIGN KEY (`accountingEventId`) REFERENCES `payrollAccountingEvents` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_termadv_reversal` FOREIGN KEY (`reversalOfId`) REFERENCES `terminationAdvanceAllocations` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_termadv_actor` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_termadv_positive` CHECK (`amount` > 0),
  CONSTRAINT `chk_termadv_reversal_shape` CHECK (
    (`terminationAdvanceDirection` = 'APPLY' AND `reversalOfId` IS NULL) OR
    (`terminationAdvanceDirection` = 'REVERSE' AND `reversalOfId` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX `idx_termadv_term` ON `terminationAdvanceAllocations` (`terminationId`);
--> statement-breakpoint
CREATE INDEX `idx_termadv_adv` ON `terminationAdvanceAllocations` (`advanceId`);
--> statement-breakpoint
CREATE INDEX `idx_termadv_event` ON `terminationAdvanceAllocations` (`accountingEventId`);
--> statement-breakpoint
ALTER TABLE `advanceSettlements`
  ADD CONSTRAINT `uq_advsettle_reversal_once` UNIQUE (`reversalOfId`);
