-- Append-only allocation evidence. No historical receipt allocation backfill.
CREATE TABLE IF NOT EXISTS `installmentReceiptAllocations` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`invoiceId` bigint NOT NULL,
	`lineId` bigint NOT NULL,
	`sourceReceiptId` bigint NOT NULL,
	`effectReceiptId` bigint NOT NULL,
	`effectKey` varchar(191) NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`reversesAllocationId` bigint,
	`previousAllocationId` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `installmentReceiptAllocations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ira_effect_line` UNIQUE(`effectKey`,`lineId`),
	CONSTRAINT `uq_ira_reverse` UNIQUE(`reversesAllocationId`),
	CONSTRAINT `uq_ira_previous` UNIQUE(`previousAllocationId`),
	CONSTRAINT `chk_ira_signed_amount` CHECK(`amount` <> 0 AND (`reversesAllocationId` IS NOT NULL OR `amount` > 0))
);
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='installmentLines' AND COLUMN_NAME='allocationHeadId'), 'SELECT 1', 'ALTER TABLE `installmentLines` ADD COLUMN `allocationHeadId` bigint;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='installmentLines' AND COLUMN_NAME='allocationHistoryReady'), 'SELECT 1', 'ALTER TABLE `installmentLines` ADD COLUMN `allocationHistoryReady` boolean DEFAULT false NOT NULL;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='installmentLines' AND COLUMN_NAME='pendingAllocationClaimId'), 'SELECT 1', 'ALTER TABLE `installmentLines` ADD COLUMN `pendingAllocationClaimId` bigint;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='installmentReceiptAllocations' AND CONSTRAINT_NAME='fk_ira_invoice'), 'SELECT 1', 'ALTER TABLE `installmentReceiptAllocations` ADD CONSTRAINT `fk_ira_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE restrict ON UPDATE no action;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='installmentReceiptAllocations' AND CONSTRAINT_NAME='fk_ira_line'), 'SELECT 1', 'ALTER TABLE `installmentReceiptAllocations` ADD CONSTRAINT `fk_ira_line` FOREIGN KEY (`lineId`) REFERENCES `installmentLines`(`id`) ON DELETE restrict ON UPDATE no action;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='installmentReceiptAllocations' AND CONSTRAINT_NAME='fk_ira_source_receipt'), 'SELECT 1', 'ALTER TABLE `installmentReceiptAllocations` ADD CONSTRAINT `fk_ira_source_receipt` FOREIGN KEY (`sourceReceiptId`) REFERENCES `receipts`(`id`) ON DELETE restrict ON UPDATE no action;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='installmentReceiptAllocations' AND CONSTRAINT_NAME='fk_ira_effect_receipt'), 'SELECT 1', 'ALTER TABLE `installmentReceiptAllocations` ADD CONSTRAINT `fk_ira_effect_receipt` FOREIGN KEY (`effectReceiptId`) REFERENCES `receipts`(`id`) ON DELETE restrict ON UPDATE no action;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='installmentReceiptAllocations' AND CONSTRAINT_NAME='fk_ira_reverse'), 'SELECT 1', 'ALTER TABLE `installmentReceiptAllocations` ADD CONSTRAINT `fk_ira_reverse` FOREIGN KEY (`reversesAllocationId`) REFERENCES `installmentReceiptAllocations`(`id`) ON DELETE restrict ON UPDATE no action;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='installmentReceiptAllocations' AND CONSTRAINT_NAME='fk_ira_previous'), 'SELECT 1', 'ALTER TABLE `installmentReceiptAllocations` ADD CONSTRAINT `fk_ira_previous` FOREIGN KEY (`previousAllocationId`) REFERENCES `installmentReceiptAllocations`(`id`) ON DELETE restrict ON UPDATE no action;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='installmentReceiptAllocations' AND INDEX_NAME='idx_ira_invoice'), 'SELECT 1', 'CREATE INDEX `idx_ira_invoice` ON `installmentReceiptAllocations` (`invoiceId`);');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='installmentReceiptAllocations' AND INDEX_NAME='idx_ira_line'), 'SELECT 1', 'CREATE INDEX `idx_ira_line` ON `installmentReceiptAllocations` (`lineId`);');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='installmentReceiptAllocations' AND INDEX_NAME='idx_ira_source_receipt'), 'SELECT 1', 'CREATE INDEX `idx_ira_source_receipt` ON `installmentReceiptAllocations` (`sourceReceiptId`);');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='installmentReceiptAllocations' AND INDEX_NAME='idx_ira_effect_receipt'), 'SELECT 1', 'CREATE INDEX `idx_ira_effect_receipt` ON `installmentReceiptAllocations` (`effectReceiptId`);');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='installmentLines' AND CONSTRAINT_NAME='fk_instline_allocation_head'), 'SELECT 1', 'ALTER TABLE `installmentLines` ADD CONSTRAINT `fk_instline_allocation_head` FOREIGN KEY (`allocationHeadId`) REFERENCES `installmentReceiptAllocations`(`id`) ON DELETE restrict ON UPDATE no action;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
SET @installment_0412_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='installmentLines' AND CONSTRAINT_NAME='fk_instline_pending_allocation_claim'), 'SELECT 1', 'ALTER TABLE `installmentLines` ADD CONSTRAINT `fk_instline_pending_allocation_claim` FOREIGN KEY (`pendingAllocationClaimId`) REFERENCES `idempotencyKeys`(`id`) ON DELETE restrict ON UPDATE no action;');
PREPARE installment_0412_stmt FROM @installment_0412_ddl;
EXECUTE installment_0412_stmt;
DEALLOCATE PREPARE installment_0412_stmt;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_ira_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_ira_bu` BEFORE UPDATE ON `installmentReceiptAllocations` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Installment allocation evidence is immutable';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_ira_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_ira_bd` BEFORE DELETE ON `installmentReceiptAllocations` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Installment allocation evidence is immutable';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_ira_bi`;
--> statement-breakpoint
CREATE TRIGGER `trg_ira_bi` BEFORE INSERT ON `installmentReceiptAllocations` FOR EACH ROW
BEGIN
  DECLARE priorId bigint DEFAULT NULL;
  DECLARE priorInvoice bigint;
  DECLARE priorLine bigint;
  DECLARE priorSource bigint;
  DECLARE priorEffect bigint;
  DECLARE priorAmount decimal(15,2);
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET priorId = NULL;
  IF NEW.`reversesAllocationId` IS NOT NULL THEN
    SELECT `id`,`invoiceId`,`lineId`,`sourceReceiptId`,`effectReceiptId`,`amount`
      INTO priorId,priorInvoice,priorLine,priorSource,priorEffect,priorAmount
      FROM `installmentReceiptAllocations` WHERE `id` = NEW.`reversesAllocationId` FOR SHARE;
    IF priorId IS NULL OR NEW.`invoiceId` <> priorInvoice OR NEW.`lineId` <> priorLine
       OR NEW.`sourceReceiptId` <> priorSource OR NEW.`effectReceiptId` = priorEffect
       OR NEW.`amount` <> -priorAmount THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid installment allocation inverse';
    END IF;
  END IF;
END;
