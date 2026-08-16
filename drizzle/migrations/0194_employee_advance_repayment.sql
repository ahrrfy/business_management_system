-- 0194: independent employee-advance repayment/return subledger.
-- Requests are zero-effect until an active independent owner approves them.
SET NAMES utf8mb4;
--> statement-breakpoint
CREATE TABLE `employeeAdvanceRepaymentRequests` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `advanceRepaymentRequestKind` enum('REPAYMENT','RETURN') NOT NULL,
  `advanceRepaymentRequestStatus` enum('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `employeeId` bigint NOT NULL,
  `branchId` bigint NOT NULL,
  `originalRequestId` bigint NULL,
  `amount` decimal(15,2) NOT NULL,
  `advanceRepaymentPaymentMethod` enum('CASH','CARD','TRANSFER','WALLET') NOT NULL,
  `advanceRepaymentCashBucket` enum('DRAWER','TREASURY') NULL,
  `shiftId` bigint NULL,
  `referenceNumber` varchar(100) NULL,
  `cardLastFour` varchar(4) NULL,
  `transactionDate` date NOT NULL,
  `evidenceNote` varchar(500) NOT NULL,
  `clientRequestId` varchar(80) NOT NULL,
  `sourceKey` varchar(191) NOT NULL,
  `sourceHash` char(64) NOT NULL,
  `evidenceHash` char(64) NOT NULL,
  `receiptId` bigint NULL,
  `accountingEntryId` bigint NULL,
  `createdBy` int NOT NULL,
  `reviewedBy` int NULL,
  `reviewedAt` timestamp NULL,
  `rejectionReason` varchar(255) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `employeeAdvanceRepaymentRequests_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_advrep_req_source` UNIQUE (`sourceKey`),
  CONSTRAINT `uq_advrep_req_external_ref` UNIQUE (`branchId`,`advanceRepaymentRequestKind`,`advanceRepaymentPaymentMethod`,`referenceNumber`),
  CONSTRAINT `uq_advrep_req_receipt` UNIQUE (`receiptId`),
  CONSTRAINT `uq_advrep_req_entry` UNIQUE (`accountingEntryId`),
  CONSTRAINT `fk_advrep_req_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_req_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_req_original` FOREIGN KEY (`originalRequestId`) REFERENCES `employeeAdvanceRepaymentRequests` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_req_shift` FOREIGN KEY (`shiftId`) REFERENCES `shifts` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_req_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_req_entry` FOREIGN KEY (`accountingEntryId`) REFERENCES `accountingEntries` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_req_maker` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_req_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_advrep_req_positive` CHECK (`amount` > 0),
  CONSTRAINT `chk_advrep_req_original_shape` CHECK (
    (`advanceRepaymentRequestKind` = 'REPAYMENT' AND `originalRequestId` IS NULL) OR
    (`advanceRepaymentRequestKind` = 'RETURN' AND `originalRequestId` IS NOT NULL)
  ),
  CONSTRAINT `chk_advrep_req_evidence` CHECK (
    (`advanceRepaymentPaymentMethod` = 'CASH' AND `advanceRepaymentCashBucket` = 'DRAWER' AND `shiftId` IS NOT NULL AND `referenceNumber` IS NULL AND `cardLastFour` IS NULL) OR
    (`advanceRepaymentPaymentMethod` = 'CARD' AND `advanceRepaymentCashBucket` IS NULL AND `shiftId` IS NULL AND CHAR_LENGTH(TRIM(`referenceNumber`)) > 0 AND `cardLastFour` REGEXP '^[0-9]{4}$') OR
    (`advanceRepaymentPaymentMethod` IN ('TRANSFER','WALLET') AND `advanceRepaymentCashBucket` IS NULL AND `shiftId` IS NULL AND CHAR_LENGTH(TRIM(`referenceNumber`)) > 0 AND `cardLastFour` IS NULL)
  ),
  CONSTRAINT `chk_advrep_req_lifecycle` CHECK (
    (`advanceRepaymentRequestStatus` = 'PENDING' AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `receiptId` IS NULL AND `accountingEntryId` IS NULL AND `rejectionReason` IS NULL) OR
    (`advanceRepaymentRequestStatus` = 'APPROVED' AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `receiptId` IS NOT NULL AND `accountingEntryId` IS NOT NULL AND `rejectionReason` IS NULL) OR
    (`advanceRepaymentRequestStatus` = 'REJECTED' AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `receiptId` IS NULL AND `accountingEntryId` IS NULL AND CHAR_LENGTH(TRIM(`rejectionReason`)) >= 5)
  )
);
--> statement-breakpoint
CREATE INDEX `idx_advrep_req_employee_status` ON `employeeAdvanceRepaymentRequests` (`employeeId`,`advanceRepaymentRequestStatus`);
--> statement-breakpoint
CREATE INDEX `idx_advrep_req_branch_status` ON `employeeAdvanceRepaymentRequests` (`branchId`,`advanceRepaymentRequestStatus`);
--> statement-breakpoint
CREATE INDEX `idx_advrep_req_original` ON `employeeAdvanceRepaymentRequests` (`originalRequestId`);
--> statement-breakpoint
CREATE TABLE `employeeAdvanceRepaymentAllocations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `requestId` bigint NOT NULL,
  `advanceId` bigint NOT NULL,
  `advanceRepaymentAllocationDirection` enum('APPLY','REVERSE') NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `reversalOfId` bigint NULL,
  `receiptId` bigint NOT NULL,
  `accountingEntryId` bigint NOT NULL,
  `sourceKey` varchar(191) NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `employeeAdvanceRepaymentAllocations_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_advrep_alloc_source` UNIQUE (`sourceKey`),
  CONSTRAINT `uq_advrep_alloc_reversal` UNIQUE (`reversalOfId`),
  CONSTRAINT `fk_advrep_alloc_request` FOREIGN KEY (`requestId`) REFERENCES `employeeAdvanceRepaymentRequests` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_alloc_advance` FOREIGN KEY (`advanceId`) REFERENCES `employeeAdvances` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_alloc_reversal` FOREIGN KEY (`reversalOfId`) REFERENCES `employeeAdvanceRepaymentAllocations` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_alloc_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_alloc_entry` FOREIGN KEY (`accountingEntryId`) REFERENCES `accountingEntries` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `fk_advrep_alloc_actor` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `chk_advrep_alloc_positive` CHECK (`amount` > 0),
  CONSTRAINT `chk_advrep_alloc_reversal_shape` CHECK (
    (`advanceRepaymentAllocationDirection` = 'APPLY' AND `reversalOfId` IS NULL) OR
    (`advanceRepaymentAllocationDirection` = 'REVERSE' AND `reversalOfId` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX `idx_advrep_alloc_request` ON `employeeAdvanceRepaymentAllocations` (`requestId`);
--> statement-breakpoint
CREATE INDEX `idx_advrep_alloc_advance` ON `employeeAdvanceRepaymentAllocations` (`advanceId`);
--> statement-breakpoint
CREATE TRIGGER `trg_advrep_alloc_no_update` BEFORE UPDATE ON `employeeAdvanceRepaymentAllocations`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'employee advance repayment allocations are immutable';
--> statement-breakpoint
CREATE TRIGGER `trg_advrep_alloc_no_delete` BEFORE DELETE ON `employeeAdvanceRepaymentAllocations`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'employee advance repayment allocations are append-only';
