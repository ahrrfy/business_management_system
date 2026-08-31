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

-- db:push can create the table before extras run. Complete every contract member
-- independently so the migration is resumable from either a fresh or partial schema.
SET @has_cve_request_uq := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND index_name = 'uq_cash_variance_evidence_request');
SET @sql := IF(@has_cve_request_uq = 0, 'ALTER TABLE `cashVarianceEvidenceDocuments` ADD CONSTRAINT `uq_cash_variance_evidence_request` UNIQUE (`registrationClientRequestId`)', 'SELECT ''cash variance evidence request unique exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_branch_hash_uq := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND index_name = 'uq_cash_variance_evidence_branch_hash');
SET @sql := IF(@has_cve_branch_hash_uq = 0, 'ALTER TABLE `cashVarianceEvidenceDocuments` ADD CONSTRAINT `uq_cash_variance_evidence_branch_hash` UNIQUE (`branchId`,`contentHash`)', 'SELECT ''cash variance evidence branch hash unique exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_branch_created_idx := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND index_name = 'idx_cash_variance_evidence_branch_created');
SET @sql := IF(@has_cve_branch_created_idx = 0, 'ALTER TABLE `cashVarianceEvidenceDocuments` ADD KEY `idx_cash_variance_evidence_branch_created` (`branchId`,`createdAt`)', 'SELECT ''cash variance evidence branch created index exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_branch_fk := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND constraint_name = 'fk_cash_variance_evidence_branch' AND constraint_type = 'FOREIGN KEY');
SET @sql := IF(@has_cve_branch_fk = 0, 'ALTER TABLE `cashVarianceEvidenceDocuments` ADD CONSTRAINT `fk_cash_variance_evidence_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE RESTRICT', 'SELECT ''cash variance evidence branch FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_creator_fk := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND constraint_name = 'fk_cash_variance_evidence_creator' AND constraint_type = 'FOREIGN KEY');
SET @sql := IF(@has_cve_creator_fk = 0, 'ALTER TABLE `cashVarianceEvidenceDocuments` ADD CONSTRAINT `fk_cash_variance_evidence_creator` FOREIGN KEY (`createdByUserId`) REFERENCES `users` (`id`) ON DELETE RESTRICT', 'SELECT ''cash variance evidence creator FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_hash_check := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND constraint_name = 'chk_cash_variance_evidence_hash' AND constraint_type = 'CHECK');
SET @has_cve_strict_hash_check := (SELECT COUNT(*) FROM information_schema.table_constraints tc JOIN information_schema.check_constraints cc ON cc.constraint_schema = tc.constraint_schema AND cc.constraint_name = tc.constraint_name WHERE tc.table_schema = DATABASE() AND tc.table_name = 'cashVarianceEvidenceDocuments' AND tc.constraint_name = 'chk_cash_variance_evidence_hash' AND tc.constraint_type = 'CHECK' AND LOWER(cc.check_clause) LIKE '%regexp%' AND LOWER(cc.check_clause) LIKE '%0-9a-f%' AND cc.check_clause LIKE '%{64}%');
SET @sql := IF(@has_cve_hash_check > 0 AND @has_cve_strict_hash_check = 0, 'ALTER TABLE `cashVarianceEvidenceDocuments` DROP CHECK `chk_cash_variance_evidence_hash`', 'SELECT ''cash variance evidence hash check needs no replacement'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_strict_hash_check := (SELECT COUNT(*) FROM information_schema.table_constraints tc JOIN information_schema.check_constraints cc ON cc.constraint_schema = tc.constraint_schema AND cc.constraint_name = tc.constraint_name WHERE tc.table_schema = DATABASE() AND tc.table_name = 'cashVarianceEvidenceDocuments' AND tc.constraint_name = 'chk_cash_variance_evidence_hash' AND tc.constraint_type = 'CHECK' AND LOWER(cc.check_clause) LIKE '%regexp%' AND LOWER(cc.check_clause) LIKE '%0-9a-f%' AND cc.check_clause LIKE '%{64}%');
SET @sql := IF(@has_cve_strict_hash_check = 0, 'ALTER TABLE `cashVarianceEvidenceDocuments` ADD CONSTRAINT `chk_cash_variance_evidence_hash` CHECK (`contentHash` REGEXP ''^[0-9a-fA-F]{64}$'')', 'SELECT ''cash variance evidence strict hash check exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_size_check := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND constraint_name = 'chk_cash_variance_evidence_size' AND constraint_type = 'CHECK');
SET @sql := IF(@has_cve_size_check = 0, 'ALTER TABLE `cashVarianceEvidenceDocuments` ADD CONSTRAINT `chk_cash_variance_evidence_size` CHECK (OCTET_LENGTH(`content`) BETWEEN 1 AND 5242880)', 'SELECT ''cash variance evidence size check exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_mime_check := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND constraint_name = 'chk_cash_variance_evidence_mime' AND constraint_type = 'CHECK');
SET @sql := IF(@has_cve_mime_check = 0, 'ALTER TABLE `cashVarianceEvidenceDocuments` ADD CONSTRAINT `chk_cash_variance_evidence_mime` CHECK ((`evidenceType` = ''PDF'' AND `contentType` = ''application/pdf'') OR (`evidenceType` = ''IMAGE'' AND `contentType` IN (''image/jpeg'',''image/png'',''image/webp'')))', 'SELECT ''cash variance evidence MIME check exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cve_filename_check := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND constraint_name = 'chk_cash_variance_evidence_filename' AND constraint_type = 'CHECK');
SET @sql := IF(@has_cve_filename_check = 0, 'ALTER TABLE `cashVarianceEvidenceDocuments` ADD CONSTRAINT `chk_cash_variance_evidence_filename` CHECK (CHAR_LENGTH(TRIM(`fileName`)) BETWEEN 1 AND 255)', 'SELECT ''cash variance evidence filename check exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
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
  + (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'cashVarianceEvidenceDocuments' AND constraint_type = 'CHECK' AND constraint_name IN ('chk_cash_variance_evidence_size','chk_cash_variance_evidence_mime','chk_cash_variance_evidence_filename'))
  + (SELECT COUNT(*) FROM information_schema.table_constraints tc JOIN information_schema.check_constraints cc ON cc.constraint_schema = tc.constraint_schema AND cc.constraint_name = tc.constraint_name WHERE tc.table_schema = DATABASE() AND tc.table_name = 'cashVarianceEvidenceDocuments' AND tc.constraint_name = 'chk_cash_variance_evidence_hash' AND tc.constraint_type = 'CHECK' AND LOWER(cc.check_clause) LIKE '%regexp%' AND LOWER(cc.check_clause) LIKE '%0-9a-f%' AND cc.check_clause LIKE '%{64}%')
  + (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'cashVarianceCases' AND column_name IN ('evidenceDocumentId','evidenceContentHash'))
  + (SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashVarianceCases' AND index_name = 'idx_cash_variance_case_evidence')
  + (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashVarianceCases' AND column_name = 'evidenceDocumentId' AND referenced_table_name = 'cashVarianceEvidenceDocuments')
  + (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name IN ('trg_cash_variance_evidence_immutable_bu','trg_cash_variance_evidence_immutable_bd'));
SET @sql := IF(@cve_contract = 16, 'SELECT ''0317 cash variance evidence contract verified'' AS msg', 'SELECT 1 FROM `__incomplete_0317_cash_variance_evidence_contract__`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
