-- 0191: explicit, human-approved end-of-service breakdown and accrual lifecycle.
-- No statutory rate is calculated here. Recognition consumes the employee's
-- existing EOS provision, releases any surplus, expenses only any shortfall,
-- and creates an independently settleable salary obligation.
SET NAMES utf8mb4;
--> statement-breakpoint
ALTER TABLE `employeeTerminations`
  ADD COLUMN `earnedWages` decimal(15,2) NOT NULL DEFAULT 0 AFTER `settlement`,
  ADD COLUMN `leaveCompensation` decimal(15,2) NOT NULL DEFAULT 0 AFTER `earnedWages`,
  ADD COLUMN `noticeCompensation` decimal(15,2) NOT NULL DEFAULT 0 AFTER `leaveCompensation`,
  ADD COLUMN `eosBenefit` decimal(15,2) NOT NULL DEFAULT 0 AFTER `noticeCompensation`,
  ADD COLUMN `otherSettlement` decimal(15,2) NOT NULL DEFAULT 0 AFTER `eosBenefit`,
  ADD COLUMN `otherSettlementLabel` varchar(120) NULL AFTER `otherSettlement`,
  ADD COLUMN `settlementPaymentMethod` varchar(20) NOT NULL DEFAULT 'CASH' AFTER `otherSettlementLabel`,
  ADD COLUMN `settlementPaymentReference` varchar(120) NULL AFTER `settlementPaymentMethod`,
  ADD COLUMN `settlementSnapshotHash` char(64) NULL AFTER `settlementPaymentReference`,
  ADD COLUMN `eosProvisionAvailable` decimal(15,2) NOT NULL DEFAULT 0 AFTER `settlementSnapshotHash`,
  ADD COLUMN `eosProvisionConsumed` decimal(15,2) NOT NULL DEFAULT 0 AFTER `eosProvisionAvailable`,
  ADD COLUMN `eosProvisionReleased` decimal(15,2) NOT NULL DEFAULT 0 AFTER `eosProvisionConsumed`,
  ADD COLUMN `eosExpenseRecognized` decimal(15,2) NOT NULL DEFAULT 0 AFTER `eosProvisionReleased`,
  ADD COLUMN `createdBy` int NULL AFTER `terminationStatus`,
  ADD COLUMN `recognizedAt` timestamp NULL AFTER `createdAt`,
  ADD COLUMN `recognizedBy` int NULL AFTER `recognizedAt`,
  ADD COLUMN `recognitionEventId` bigint NULL AFTER `recognizedBy`,
  ADD COLUMN `paymentReversedAt` timestamp NULL AFTER `recognitionEventId`,
  ADD COLUMN `paymentReversedBy` int NULL AFTER `paymentReversedAt`,
  ADD COLUMN `paymentReversalReason` varchar(255) NULL AFTER `paymentReversedBy`,
  ADD COLUMN `recognitionReversedAt` timestamp NULL AFTER `paymentReversalReason`,
  ADD COLUMN `recognitionReversedBy` int NULL AFTER `recognitionReversedAt`,
  ADD COLUMN `recognitionReversalReason` varchar(255) NULL AFTER `recognitionReversedBy`,
  ADD COLUMN `recognitionReversalEventId` bigint NULL AFTER `recognitionReversalReason`;
--> statement-breakpoint
-- Preserve old totals explicitly instead of silently inventing a legal split.
-- Historical values are classified as a legacy short-term component and remain
-- subject to human review before a still-pending termination can be recognized.
UPDATE `employeeTerminations`
SET `otherSettlement` = `settlement`,
    `otherSettlementLabel` = CASE
      WHEN `settlement` > 0 THEN 'تسوية تاريخية غير مفككة — مراجعة بشرية'
      ELSE NULL
    END
WHERE `settlement` <> 0;
--> statement-breakpoint
ALTER TABLE `employeeTerminations`
  ADD CONSTRAINT `fk_term_created_by` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT `fk_term_recognized_by` FOREIGN KEY (`recognizedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT `fk_term_payrev_by` FOREIGN KEY (`paymentReversedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT `fk_term_recrev_by` FOREIGN KEY (`recognitionReversedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT `chk_term_breakdown_nonnegative` CHECK (
    `earnedWages` >= 0 AND `leaveCompensation` >= 0 AND
    `noticeCompensation` >= 0 AND `eosBenefit` >= 0 AND `otherSettlement` >= 0
  ),
  ADD CONSTRAINT `chk_term_total_derived` CHECK (
    `settlement` = `earnedWages` + `leaveCompensation` +
      `noticeCompensation` + `eosBenefit` + `otherSettlement`
  ),
  ADD CONSTRAINT `chk_term_other_classified` CHECK (
    `otherSettlement` = 0 OR CHAR_LENGTH(TRIM(COALESCE(`otherSettlementLabel`, ''))) > 0
  ),
  ADD CONSTRAINT `chk_term_payment_method` CHECK (
    `settlementPaymentMethod` IN ('CASH','CARD','TRANSFER','WALLET')
  ),
  ADD CONSTRAINT `chk_term_payment_evidence` CHECK (
    `settlementPaymentMethod` = 'CASH' OR CHAR_LENGTH(TRIM(COALESCE(`settlementPaymentReference`, ''))) > 0
  ),
  ADD CONSTRAINT `chk_term_recognition_maker_checker` CHECK (
    `recognizedBy` IS NULL OR `createdBy` IS NULL OR `recognizedBy` <> `createdBy`
  ),
  ADD CONSTRAINT `chk_term_recognition_lifecycle` CHECK (
    (`recognizedAt` IS NULL AND `recognizedBy` IS NULL AND `settlementSnapshotHash` IS NULL AND `recognitionEventId` IS NULL) OR
    (`recognizedAt` IS NOT NULL AND `recognizedBy` IS NOT NULL AND `settlementSnapshotHash` IS NOT NULL)
  ),
  ADD CONSTRAINT `chk_term_payment_reversal_lifecycle` CHECK (
    (`paymentReversedAt` IS NULL AND `paymentReversedBy` IS NULL AND `paymentReversalReason` IS NULL) OR
    (`paymentReversedAt` IS NOT NULL AND `paymentReversedBy` IS NOT NULL AND CHAR_LENGTH(TRIM(`paymentReversalReason`)) >= 5)
  ),
  ADD CONSTRAINT `chk_term_recognition_reversal_lifecycle` CHECK (
    (`recognitionReversedAt` IS NULL AND `recognitionReversedBy` IS NULL AND `recognitionReversalReason` IS NULL AND `recognitionReversalEventId` IS NULL) OR
    (`recognitionReversedAt` IS NOT NULL AND `recognitionReversedBy` IS NOT NULL AND CHAR_LENGTH(TRIM(`recognitionReversalReason`)) >= 5 AND `recognitionReversalEventId` IS NOT NULL)
  );
--> statement-breakpoint
CREATE INDEX `idx_term_recognition` ON `employeeTerminations` (`terminationStatus`,`recognizedAt`);
--> statement-breakpoint
ALTER TABLE `payrollObligations`
  ADD COLUMN `terminationId` bigint NULL AFTER `employeeId`,
  ADD CONSTRAINT `uq_payroll_obligation_termination_kind`
    UNIQUE (`terminationId`,`payrollObligationKind`);
--> statement-breakpoint
ALTER TABLE `payrollAccountingEvents`
  ADD COLUMN `terminationId` bigint NULL AFTER `remittanceRequestId`;
--> statement-breakpoint
CREATE INDEX `idx_payroll_event_termination` ON `payrollAccountingEvents` (`terminationId`);
--> statement-breakpoint
-- One original event/allocation can be reversed at most once. MySQL permits
-- multiple NULL values in a UNIQUE index, which is exactly the required
-- partial-unique behaviour for non-reversal rows.
ALTER TABLE `payrollAccountingEvents`
  ADD CONSTRAINT `uq_payroll_event_reversal_once` UNIQUE (`reversalOfId`);
--> statement-breakpoint
ALTER TABLE `payrollObligationAllocations`
  ADD CONSTRAINT `uq_payroll_allocation_reversal_once` UNIQUE (`reversalOfId`);
--> statement-breakpoint
-- Deferred source FKs are added after both sides exist to keep the circular
-- append-only audit graph enforceable without relying on application code.
ALTER TABLE `payrollObligations`
  ADD CONSTRAINT `fk_payroll_obligation_termination`
    FOREIGN KEY (`terminationId`) REFERENCES `employeeTerminations`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `payrollAccountingEvents`
  ADD CONSTRAINT `fk_payroll_event_termination`
    FOREIGN KEY (`terminationId`) REFERENCES `employeeTerminations`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `employeeTerminations`
  ADD CONSTRAINT `fk_term_recognition_event`
    FOREIGN KEY (`recognitionEventId`) REFERENCES `payrollAccountingEvents`(`id`) ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT `fk_term_recognition_reversal_event`
    FOREIGN KEY (`recognitionReversalEventId`) REFERENCES `payrollAccountingEvents`(`id`) ON DELETE no action ON UPDATE no action;
