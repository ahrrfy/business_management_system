-- Immutable binary evidence for cash-variance cases. Expansion is resumable and safe on db:push databases.
CREATE TABLE IF NOT EXISTS `cashVarianceEvidenceDocuments` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `branchId` BIGINT NOT NULL,
  `evidenceType` ENUM('IMAGE','PDF') NOT NULL,
  `fileName` VARCHAR(255) NOT NULL,
  `contentType` VARCHAR(100) NOT NULL,
  `contentHash` CHAR(64) NOT NULL,
  `content` MEDIUMBLOB NOT NULL,
  `createdByUserId` INT NOT NULL,
  `registrationClientRequestId` VARCHAR(64) NOT NULL,
  `registrationRequestHash` CHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `uq_cash_variance_evidence_request` UNIQUE (`registrationClientRequestId`),
  CONSTRAINT `uq_cash_variance_evidence_branch_hash` UNIQUE (`branchId`,`contentHash`),
  KEY `idx_cash_variance_evidence_branch_created` (`branchId`,`createdAt`),
  CONSTRAINT `fk_cash_variance_evidence_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_cash_variance_evidence_creator` FOREIGN KEY (`createdByUserId`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_cash_variance_evidence_hash` CHECK (`contentHash` REGEXP '^[0-9a-fA-F]{64}$'),
  CONSTRAINT `chk_cash_variance_evidence_size` CHECK (OCTET_LENGTH(`content`) BETWEEN 1 AND 5242880),
  CONSTRAINT `chk_cash_variance_evidence_mime` CHECK ((`evidenceType` = 'PDF' AND `contentType` = 'application/pdf') OR (`evidenceType` = 'IMAGE' AND `contentType` IN ('image/jpeg','image/png','image/webp'))),
  CONSTRAINT `chk_cash_variance_evidence_filename` CHECK (CHAR_LENGTH(TRIM(`fileName`)) BETWEEN 1 AND 255)
);
--> statement-breakpoint

SET @has_cve_document_id := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'cashVarianceCases' AND column_name = 'evidenceDocumentId');
SET @sql := IF(@has_cve_document_id = 0, 'ALTER TABLE `cashVarianceCases` ADD COLUMN `evidenceDocumentId` BIGINT NULL AFTER `evidenceReference`', 'SELECT ''cashVarianceCases.evidenceDocumentId exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_content_hash := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'cashVarianceCases' AND column_name = 'evidenceContentHash');
SET @sql := IF(@has_cve_content_hash = 0, 'ALTER TABLE `cashVarianceCases` ADD COLUMN `evidenceContentHash` CHAR(64) NULL AFTER `evidenceDocumentId`', 'SELECT ''cashVarianceCases.evidenceContentHash exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_case_idx := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashVarianceCases' AND index_name = 'idx_cash_variance_case_evidence');
SET @sql := IF(@has_cve_case_idx = 0, 'ALTER TABLE `cashVarianceCases` ADD KEY `idx_cash_variance_case_evidence` (`evidenceDocumentId`)', 'SELECT ''idx_cash_variance_case_evidence exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_case_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashVarianceCases' AND column_name = 'evidenceDocumentId' AND referenced_table_name = 'cashVarianceEvidenceDocuments');
SET @sql := IF(@has_cve_case_fk = 0, 'ALTER TABLE `cashVarianceCases` ADD CONSTRAINT `fk_cash_variance_case_evidence` FOREIGN KEY (`evidenceDocumentId`) REFERENCES `cashVarianceEvidenceDocuments` (`id`) ON DELETE RESTRICT', 'SELECT ''cash variance case evidence FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_cash_variance_evidence_immutable_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_variance_evidence_immutable_bu` BEFORE UPDATE ON `cashVarianceEvidenceDocuments`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cash variance evidence is immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_variance_evidence_immutable_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_variance_evidence_immutable_bd` BEFORE DELETE ON `cashVarianceEvidenceDocuments`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cash variance evidence is immutable';
--> statement-breakpoint

SET @cve_contract :=
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments')
  + (SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND index_name IN ('uq_cash_variance_evidence_request','uq_cash_variance_evidence_branch_hash','idx_cash_variance_evidence_branch_created'))
  + (SELECT COUNT(DISTINCT constraint_name) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND constraint_name IN ('fk_cash_variance_evidence_branch','fk_cash_variance_evidence_creator') AND referenced_table_name IS NOT NULL)
  + (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND constraint_type = 'CHECK' AND constraint_name IN ('chk_cash_variance_evidence_hash','chk_cash_variance_evidence_size','chk_cash_variance_evidence_mime','chk_cash_variance_evidence_filename'))
  + (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'cashVarianceCases' AND column_name IN ('evidenceDocumentId','evidenceContentHash'))
  + (SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashVarianceCases' AND index_name = 'idx_cash_variance_case_evidence')
  + (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashVarianceCases' AND column_name = 'evidenceDocumentId' AND referenced_table_name = 'cashVarianceEvidenceDocuments')
  + (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name IN ('trg_cash_variance_evidence_immutable_bu','trg_cash_variance_evidence_immutable_bd'));
SET @sql := IF(@cve_contract = 16, 'SELECT ''0317 cash variance evidence contract verified'' AS msg', 'SELECT 1 FROM `__incomplete_0317_cash_variance_evidence_contract__`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
