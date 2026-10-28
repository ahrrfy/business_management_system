-- Preserve legacy facts; nullable request/recovery metadata applies to future commands.
SET @audit_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='consignmentNotes' AND COLUMN_NAME='requestPayloadHash'), 'SELECT 1', 'ALTER TABLE `consignmentNotes` ADD COLUMN `requestPayloadHash` varchar(64) NULL');
PREPARE audit_stmt FROM @audit_ddl;
EXECUTE audit_stmt;
DEALLOCATE PREPARE audit_stmt;
--> statement-breakpoint
ALTER TABLE `employees` MODIFY COLUMN `annualLeaveBalance` decimal(12,2) NULL DEFAULT 0.00, MODIFY COLUMN `sickLeaveBalance` decimal(12,2) NULL DEFAULT 0.00;
--> statement-breakpoint
SET @audit_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employeeContracts' AND COLUMN_NAME='renewedFromId'), 'SELECT 1', 'ALTER TABLE `employeeContracts` ADD COLUMN `renewedFromId` bigint NULL');
PREPARE audit_stmt FROM @audit_ddl;
EXECUTE audit_stmt;
DEALLOCATE PREPARE audit_stmt;
--> statement-breakpoint
SET @audit_ddl = IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employeeContracts' AND INDEX_NAME='idx_emp_contract_renewed_from'), 'SELECT 1', 'ALTER TABLE `employeeContracts` ADD INDEX `idx_emp_contract_renewed_from` (`renewedFromId`)');
PREPARE audit_stmt FROM @audit_ddl;
EXECUTE audit_stmt;
DEALLOCATE PREPARE audit_stmt;
--> statement-breakpoint
SET @audit_ddl = IF(EXISTS(SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='employeeContracts' AND CONSTRAINT_NAME='fk_employee_contract_renewed_from'), 'SELECT 1', 'ALTER TABLE `employeeContracts` ADD CONSTRAINT `fk_employee_contract_renewed_from` FOREIGN KEY (`renewedFromId`) REFERENCES `employeeContracts` (`id`)');
PREPARE audit_stmt FROM @audit_ddl;
EXECUTE audit_stmt;
DEALLOCATE PREPARE audit_stmt;
--> statement-breakpoint
ALTER TABLE `waOutbox` MODIFY COLUMN `status` enum('QUEUED','SENDING','SENT','FAILED','CANCELLED','UNKNOWN') NOT NULL DEFAULT 'QUEUED';
--> statement-breakpoint
SET @audit_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waOutbox' AND COLUMN_NAME='claimToken'), 'SELECT 1', 'ALTER TABLE `waOutbox` ADD COLUMN `claimToken` varchar(64) NULL');
PREPARE audit_stmt FROM @audit_ddl;
EXECUTE audit_stmt;
DEALLOCATE PREPARE audit_stmt;
--> statement-breakpoint
SET @audit_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waOutbox' AND COLUMN_NAME='claimExpiresAt'), 'SELECT 1', 'ALTER TABLE `waOutbox` ADD COLUMN `claimExpiresAt` timestamp NULL');
PREPARE audit_stmt FROM @audit_ddl;
EXECUTE audit_stmt;
DEALLOCATE PREPARE audit_stmt;
--> statement-breakpoint
SET @audit_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waOutbox' AND COLUMN_NAME='providerAttemptId'), 'SELECT 1', 'ALTER TABLE `waOutbox` ADD COLUMN `providerAttemptId` varchar(100) NULL');
PREPARE audit_stmt FROM @audit_ddl;
EXECUTE audit_stmt;
DEALLOCATE PREPARE audit_stmt;
--> statement-breakpoint
SET @audit_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waOutbox' AND COLUMN_NAME='providerStartedAt'), 'SELECT 1', 'ALTER TABLE `waOutbox` ADD COLUMN `providerStartedAt` timestamp NULL');
PREPARE audit_stmt FROM @audit_ddl;
EXECUTE audit_stmt;
DEALLOCATE PREPARE audit_stmt;
--> statement-breakpoint
SET @audit_ddl = IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waOutbox' AND INDEX_NAME='uq_wa_outbox_provider_attempt'), 'SELECT 1', 'ALTER TABLE `waOutbox` ADD UNIQUE INDEX `uq_wa_outbox_provider_attempt` (`providerAttemptId`)');
PREPARE audit_stmt FROM @audit_ddl;
EXECUTE audit_stmt;
DEALLOCATE PREPARE audit_stmt;
--> statement-breakpoint
SET @audit_ddl = IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waOutbox' AND INDEX_NAME='idx_wa_outbox_claim_expiry'), 'SELECT 1', 'ALTER TABLE `waOutbox` ADD INDEX `idx_wa_outbox_claim_expiry` (`status`, `claimExpiresAt`)');
PREPARE audit_stmt FROM @audit_ddl;
EXECUTE audit_stmt;
DEALLOCATE PREPARE audit_stmt;
--> statement-breakpoint
ALTER TABLE `waBroadcastRecipients` MODIFY COLUMN `recipientStatus` enum('PENDING','QUEUED','SENT','DELIVERED','READ','FAILED','SKIPPED_OPTOUT','UNKNOWN','CANCELLED') NOT NULL DEFAULT 'PENDING';
