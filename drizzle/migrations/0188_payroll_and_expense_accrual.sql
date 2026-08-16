-- 0188: immutable payroll accrual snapshots, independent obligation balances,
-- append-only allocations/events, governed statutory remittances, and the
-- explicit accrued-expense liability used by unpaid operational expenses.
-- Automatic Iraqi/KRI legal rates remain disabled; this migration stores only
-- accountant-approved amounts and evidence. All DDL/DML is intentionally strict.
SET NAMES utf8mb4;
--> statement-breakpoint
ALTER TABLE `payrollRuns`
  MODIFY COLUMN `payrollStatus` enum('draft','approved','paid','cancelled') NOT NULL DEFAULT 'draft',
  ADD COLUMN `revisionNo` int NOT NULL DEFAULT 0 AFTER `payrollStatus`,
  ADD COLUMN `accrualDate` date NULL AFTER `revisionNo`,
  ADD COLUMN `legalPolicySnapshot` json NULL AFTER `accrualDate`,
  ADD COLUMN `legalPolicyHash` char(64) NULL AFTER `legalPolicySnapshot`,
  ADD COLUMN `approvalSnapshotHash` char(64) NULL AFTER `legalPolicyHash`,
  ADD COLUMN `cancelledBy` int NULL AFTER `paidAt`,
  ADD COLUMN `cancelledAt` timestamp NULL AFTER `cancelledBy`,
  ADD COLUMN `cancelReason` varchar(255) NULL AFTER `cancelledAt`;
--> statement-breakpoint
ALTER TABLE `payrollRuns`
  ADD CONSTRAINT `fk_payroll_run_cancelled_by`
    FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_payroll_revision` ON `payrollRuns` (`revisionNo`);
--> statement-breakpoint
ALTER TABLE `payrollItems`
  ADD COLUMN `branchIdSnapshot` bigint NULL AFTER `employeeId`,
  ADD COLUMN `revisionNo` int NOT NULL DEFAULT 0 AFTER `branchIdSnapshot`,
  ADD COLUMN `wageReduction` decimal(15,2) NOT NULL DEFAULT 0 AFTER `deductions`,
  ADD COLUMN `snapshotHash` char(64) NULL AFTER `net`;
--> statement-breakpoint
-- The legacy total already includes the three separately stored deductions.
-- A negative residual is invalid legacy data and deliberately aborts the CHECK below.
UPDATE `payrollItems`
SET `wageReduction` = `deductions` - `advanceDeduction` - `socialSecurityEmployee` - `incomeTax`;
--> statement-breakpoint
ALTER TABLE `payrollItems`
  ADD CONSTRAINT `fk_payroll_item_branch_snapshot`
    FOREIGN KEY (`branchIdSnapshot`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT `chk_payitem_wage_reduction_nonnegative` CHECK (`wageReduction` >= 0);
--> statement-breakpoint
CREATE INDEX `idx_payitem_branch_revision` ON `payrollItems` (`branchIdSnapshot`,`revisionNo`);
--> statement-breakpoint
CREATE TABLE `payrollObligations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `runId` bigint NULL,
  `itemId` bigint NULL,
  `employeeId` bigint NULL,
  `branchIdSnapshot` bigint NULL,
  `revisionNo` int NOT NULL DEFAULT 0,
  `payrollObligationKind` enum('SALARY_NET','INCOME_TAX','SOCIAL_SECURITY','EOS_PROVISION') NOT NULL,
  `originalAmount` decimal(15,2) NOT NULL,
  `remainingAmount` decimal(15,2) NOT NULL,
  `dueDate` date NULL,
  `payrollObligationStatus` enum('OPEN','PARTIAL','SETTLED','REVERSED') NOT NULL DEFAULT 'OPEN',
  `payrollObligationSourceType` enum('PAYROLL_APPROVAL','OPENING_CERTIFICATE','TERMINATION') NOT NULL,
  `sourceKey` varchar(191) NOT NULL,
  `authorityName` varchar(200) NULL,
  `authorityReference` varchar(191) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `payrollObligations_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_payroll_obligation_source` UNIQUE (`sourceKey`),
  CONSTRAINT `uq_payroll_obligation_revision` UNIQUE (`runId`,`itemId`,`revisionNo`,`payrollObligationKind`),
  CONSTRAINT `fk_payroll_obligation_run` FOREIGN KEY (`runId`) REFERENCES `payrollRuns`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_obligation_item` FOREIGN KEY (`itemId`) REFERENCES `payrollItems`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_obligation_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_obligation_branch` FOREIGN KEY (`branchIdSnapshot`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_payroll_obligation_positive_original` CHECK (`originalAmount` > 0),
  CONSTRAINT `chk_payroll_obligation_remaining_range` CHECK (`remainingAmount` >= 0 AND `remainingAmount` <= `originalAmount`),
  CONSTRAINT `chk_payroll_obligation_status_balance` CHECK (
    (`payrollObligationStatus` = 'OPEN' AND `remainingAmount` = `originalAmount`) OR
    (`payrollObligationStatus` = 'PARTIAL' AND `remainingAmount` > 0 AND `remainingAmount` < `originalAmount`) OR
    (`payrollObligationStatus` IN ('SETTLED','REVERSED') AND `remainingAmount` = 0)
  ),
  CONSTRAINT `chk_payroll_obligation_approval_source` CHECK (
    `payrollObligationSourceType` <> 'PAYROLL_APPROVAL' OR (`runId` IS NOT NULL AND `itemId` IS NOT NULL)
  ),
  INDEX `idx_payroll_obligation_run_status` (`runId`,`revisionNo`,`payrollObligationStatus`),
  INDEX `idx_payroll_obligation_employee_kind` (`employeeId`,`payrollObligationKind`),
  INDEX `idx_payroll_obligation_branch_kind` (`branchIdSnapshot`,`payrollObligationKind`)
);
--> statement-breakpoint
CREATE TABLE `payrollRemittanceRequests` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `payrollRemittanceKind` enum('INCOME_TAX','SOCIAL_SECURITY') NOT NULL,
  `payingBranchId` bigint NOT NULL,
  `requestedAmount` decimal(15,2) NOT NULL,
  `authorityName` varchar(200) NOT NULL,
  `referenceNumber` varchar(100) NOT NULL,
  `supportingDocumentUrl` mediumtext NOT NULL,
  `payrollRemittanceStatus` enum('PENDING','APPROVED','PAID','REJECTED','REVERSED') NOT NULL DEFAULT 'PENDING',
  `sourceKey` varchar(191) NOT NULL,
  `receiptId` bigint NULL,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `approvedBy` int NULL,
  `approvedAt` timestamp NULL,
  `paidBy` int NULL,
  `paidAt` timestamp NULL,
  `rejectedBy` int NULL,
  `rejectedAt` timestamp NULL,
  `rejectionReason` varchar(255) NULL,
  `reversedBy` int NULL,
  `reversedAt` timestamp NULL,
  `reversalReason` varchar(255) NULL,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `payrollRemittanceRequests_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_payroll_remittance_source` UNIQUE (`sourceKey`),
  CONSTRAINT `uq_payroll_remittance_receipt` UNIQUE (`receiptId`),
  CONSTRAINT `fk_payroll_remittance_branch` FOREIGN KEY (`payingBranchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_remittance_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_remittance_created_by` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_remittance_approved_by` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_remittance_paid_by` FOREIGN KEY (`paidBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_remittance_rejected_by` FOREIGN KEY (`rejectedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_remittance_reversed_by` FOREIGN KEY (`reversedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_payroll_remittance_positive_amount` CHECK (`requestedAmount` > 0),
  CONSTRAINT `chk_payroll_remittance_maker_checker` CHECK (`approvedBy` IS NULL OR `approvedBy` <> `createdBy`),
  INDEX `idx_payroll_remittance_status_kind` (`payrollRemittanceStatus`,`payrollRemittanceKind`),
  INDEX `idx_payroll_remittance_branch` (`payingBranchId`)
);
--> statement-breakpoint
CREATE TABLE `payrollAccountingEvents` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `runId` bigint NULL,
  `obligationId` bigint NULL,
  `remittanceRequestId` bigint NULL,
  `branchIdSnapshot` bigint NULL,
  `revisionNo` int NOT NULL DEFAULT 0,
  `payrollAccountingEventKind` enum(
    'ACCRUAL','ACCRUAL_REVERSAL','SALARY_PAYMENT','SALARY_PAYMENT_RETURN',
    'TAX_REMITTANCE','SOCIAL_SECURITY_REMITTANCE','REMITTANCE_RETURN',
    'EOS_SETTLEMENT','EOS_SETTLEMENT_REVERSAL'
  ) NOT NULL,
  `accountingEntryId` bigint NOT NULL,
  `receiptId` bigint NULL,
  `reversalOfId` bigint NULL,
  `sourceKey` varchar(191) NOT NULL,
  `sourceHash` char(64) NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `payrollAccountingEvents_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_payroll_accounting_event_source` UNIQUE (`sourceKey`),
  CONSTRAINT `uq_payroll_accounting_event_entry` UNIQUE (`accountingEntryId`),
  CONSTRAINT `fk_payroll_event_run` FOREIGN KEY (`runId`) REFERENCES `payrollRuns`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_event_obligation` FOREIGN KEY (`obligationId`) REFERENCES `payrollObligations`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_event_remittance` FOREIGN KEY (`remittanceRequestId`) REFERENCES `payrollRemittanceRequests`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_event_branch` FOREIGN KEY (`branchIdSnapshot`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_event_entry` FOREIGN KEY (`accountingEntryId`) REFERENCES `accountingEntries`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_event_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_event_reversal` FOREIGN KEY (`reversalOfId`) REFERENCES `payrollAccountingEvents`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_event_created_by` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_payroll_event_reversal_shape` CHECK (
    (`payrollAccountingEventKind` IN ('ACCRUAL_REVERSAL','SALARY_PAYMENT_RETURN','REMITTANCE_RETURN','EOS_SETTLEMENT_REVERSAL') AND `reversalOfId` IS NOT NULL) OR
    (`payrollAccountingEventKind` NOT IN ('ACCRUAL_REVERSAL','SALARY_PAYMENT_RETURN','REMITTANCE_RETURN','EOS_SETTLEMENT_REVERSAL') AND `reversalOfId` IS NULL)
  ),
  INDEX `idx_payroll_event_run_revision` (`runId`,`revisionNo`,`payrollAccountingEventKind`),
  INDEX `idx_payroll_event_obligation` (`obligationId`),
  INDEX `idx_payroll_event_remittance` (`remittanceRequestId`),
  INDEX `idx_payroll_event_receipt` (`receiptId`)
);
--> statement-breakpoint
CREATE TABLE `payrollObligationAllocations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `obligationId` bigint NOT NULL,
  `accountingEventId` bigint NOT NULL,
  `remittanceRequestId` bigint NULL,
  `payrollAllocationDirection` enum('APPLY','REVERSE') NOT NULL DEFAULT 'APPLY',
  `amount` decimal(15,2) NOT NULL,
  `reversalOfId` bigint NULL,
  `sourceKey` varchar(191) NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `payrollObligationAllocations_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_payroll_allocation_source` UNIQUE (`sourceKey`),
  CONSTRAINT `uq_payroll_allocation_event` UNIQUE (`obligationId`,`accountingEventId`,`payrollAllocationDirection`),
  CONSTRAINT `fk_payroll_allocation_obligation` FOREIGN KEY (`obligationId`) REFERENCES `payrollObligations`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_allocation_event` FOREIGN KEY (`accountingEventId`) REFERENCES `payrollAccountingEvents`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_allocation_remittance` FOREIGN KEY (`remittanceRequestId`) REFERENCES `payrollRemittanceRequests`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_allocation_reversal` FOREIGN KEY (`reversalOfId`) REFERENCES `payrollObligationAllocations`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_payroll_allocation_created_by` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_payroll_allocation_positive_amount` CHECK (`amount` > 0),
  CONSTRAINT `chk_payroll_allocation_reversal_shape` CHECK (
    (`payrollAllocationDirection` = 'REVERSE' AND `reversalOfId` IS NOT NULL) OR
    (`payrollAllocationDirection` = 'APPLY' AND `reversalOfId` IS NULL)
  ),
  INDEX `idx_payroll_allocation_obligation_time` (`obligationId`,`occurredAt`),
  INDEX `idx_payroll_allocation_remittance` (`remittanceRequestId`)
);
--> statement-breakpoint
ALTER TABLE `advanceSettlements`
  DROP FOREIGN KEY `advanceSettlements_runId_payrollRuns_id_fk`,
  ADD COLUMN `revisionNo` int NOT NULL DEFAULT 0 AFTER `amount`,
  ADD COLUMN `advanceSettlementDirection` enum('APPLY','REVERSE') NOT NULL DEFAULT 'APPLY' AFTER `revisionNo`,
  ADD COLUMN `reversalOfId` bigint NULL AFTER `advanceSettlementDirection`,
  ADD COLUMN `sourceKey` varchar(191) NULL AFTER `reversalOfId`,
  ADD COLUMN `createdBy` int NULL AFTER `sourceKey`,
  ADD COLUMN `occurredAt` timestamp NULL AFTER `createdBy`;
--> statement-breakpoint
UPDATE `advanceSettlements`
SET `sourceKey` = CONCAT('LEGACY:ADVSETTLE:', `id`),
    `occurredAt` = `createdAt`
WHERE `sourceKey` IS NULL OR `occurredAt` IS NULL;
--> statement-breakpoint
ALTER TABLE `advanceSettlements`
  MODIFY COLUMN `occurredAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT `advanceSettlements_runId_payrollRuns_id_fk`
    FOREIGN KEY (`runId`) REFERENCES `payrollRuns`(`id`) ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT `fk_advsettle_reversal`
    FOREIGN KEY (`reversalOfId`) REFERENCES `advanceSettlements`(`id`) ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT `fk_advsettle_created_by`
    FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT `uq_advsettle_source` UNIQUE (`sourceKey`),
  ADD CONSTRAINT `chk_advsettle_positive_amount` CHECK (`amount` > 0),
  ADD CONSTRAINT `chk_advsettle_reversal_shape` CHECK (
    (`advanceSettlementDirection` = 'REVERSE' AND `reversalOfId` IS NOT NULL) OR
    (`advanceSettlementDirection` = 'APPLY' AND `reversalOfId` IS NULL)
  );
--> statement-breakpoint
CREATE INDEX `idx_advsettle_run_revision` ON `advanceSettlements` (`runId`,`revisionNo`);
--> statement-breakpoint
CREATE INDEX `idx_advsettle_advance` ON `advanceSettlements` (`advanceId`);
--> statement-breakpoint
-- Stable account roles: five payroll accrual roles plus one general accrued-
-- expense liability. Conflicting codes/roles abort; duplicates are never hidden.
INSERT INTO `accounts` (`code`,`name`,`type`,`parentId`,`systemRole`,`sortOrder`) VALUES
('2310','ضريبة دخل الرواتب المستحقة','LIABILITY',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='2000'),'PAYROLL_TAX_PAYABLE',231),
('2320','الضمان الاجتماعي المستحق','LIABILITY',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='2000'),'SOCIAL_SECURITY_PAYABLE',232),
('2330','مخصص نهاية الخدمة','LIABILITY',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='2000'),'EOS_PROVISION',233),
('2340','مصروفات مستحقة غير مدفوعة','LIABILITY',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='2000'),'ACCRUED_EXPENSES',234),
('5210','مصروف الضمان الاجتماعي لصاحب العمل','EXPENSE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='5000'),'SOCIAL_SECURITY_EXPENSE',521),
('5220','مصروف مخصص نهاية الخدمة','EXPENSE',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='5000'),'EOS_EXPENSE',522),
('1900','تسويات بين الفروع','ASSET',(SELECT `id` FROM `accounts` AS p WHERE p.`code`='1000'),'INTERBRANCH_CLEARING',190);
