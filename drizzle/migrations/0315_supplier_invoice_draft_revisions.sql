-- 0315 — تصحيح مسودة فاتورة المورد بلا محو تاريخها، وإلغاء موثق للمسودة.
-- التعديل محصور قبل المطابقة/الترحيل؛ كل انتقال يملك expectedVersion وبصمة وسبباً وسجل قبل/بعد append-only.

SET @has_si_draft_state := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'supplierInvoices' AND column_name = 'draftState');
SET @sql := IF(@has_si_draft_state = 0, 'ALTER TABLE `supplierInvoices` ADD COLUMN `draftState` ENUM(''ACTIVE'',''VOIDED'') NOT NULL DEFAULT ''ACTIVE'' AFTER `version`', 'SELECT ''supplierInvoices.draftState exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_si_voided_by := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'supplierInvoices' AND column_name = 'voidedBy');
SET @sql := IF(@has_si_voided_by = 0, 'ALTER TABLE `supplierInvoices` ADD COLUMN `voidedBy` INT NULL AFTER `reversalReason`', 'SELECT ''supplierInvoices.voidedBy exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_si_voided_at := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'supplierInvoices' AND column_name = 'voidedAt');
SET @sql := IF(@has_si_voided_at = 0, 'ALTER TABLE `supplierInvoices` ADD COLUMN `voidedAt` TIMESTAMP NULL AFTER `voidedBy`', 'SELECT ''supplierInvoices.voidedAt exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_si_void_reason := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'supplierInvoices' AND column_name = 'voidReason');
SET @sql := IF(@has_si_void_reason = 0, 'ALTER TABLE `supplierInvoices` ADD COLUMN `voidReason` VARCHAR(500) NULL AFTER `voidedAt`', 'SELECT ''supplierInvoices.voidReason exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_si_voider_fk := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'supplierInvoices' AND constraint_name = 'fk_supplier_invoice_voider');
SET @sql := IF(@has_si_voider_fk = 0, 'ALTER TABLE `supplierInvoices` ADD CONSTRAINT `fk_supplier_invoice_voider` FOREIGN KEY (`voidedBy`) REFERENCES `users` (`id`)', 'SELECT ''fk_supplier_invoice_voider exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_si_draft_check := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'supplierInvoices' AND constraint_name = 'chk_supplier_invoice_draft_state');
SET @sql := IF(@has_si_draft_check = 0, 'ALTER TABLE `supplierInvoices` ADD CONSTRAINT `chk_supplier_invoice_draft_state` CHECK ((`draftState` = ''ACTIVE'' AND `voidedBy` IS NULL AND `voidedAt` IS NULL AND `voidReason` IS NULL) OR (`draftState` = ''VOIDED'' AND `status` = ''DRAFT'' AND `voidedBy` IS NOT NULL AND `voidedAt` IS NOT NULL AND `voidReason` IS NOT NULL AND CHAR_LENGTH(TRIM(`voidReason`)) >= 3))', 'SELECT ''chk_supplier_invoice_draft_state exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `supplierInvoiceDraftRevisions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `supplierInvoiceId` BIGINT NOT NULL,
  `revisionNo` INT NOT NULL,
  `action` ENUM('UPDATE_DRAFT','VOID_DRAFT') NOT NULL,
  `requestKey` VARCHAR(120) NOT NULL,
  `requestPayloadHash` CHAR(64) NOT NULL,
  `baseVersion` INT NOT NULL,
  `resultVersion` INT NOT NULL,
  `beforeCanonical` MEDIUMTEXT NOT NULL,
  `beforeHash` CHAR(64) NOT NULL,
  `afterCanonical` MEDIUMTEXT NOT NULL,
  `afterHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `actedBy` INT NOT NULL,
  `actedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_invoice_draft_revision_no` (`supplierInvoiceId`,`revisionNo`),
  UNIQUE KEY `uq_supplier_invoice_draft_revision_version` (`supplierInvoiceId`,`resultVersion`),
  UNIQUE KEY `uq_supplier_invoice_draft_request_key` (`requestKey`),
  KEY `idx_supplier_invoice_draft_revision_actor` (`actedBy`,`actedAt`),
  CONSTRAINT `fk_supplier_invoice_draft_revision_invoice` FOREIGN KEY (`supplierInvoiceId`) REFERENCES `supplierInvoices` (`id`),
  CONSTRAINT `fk_supplier_invoice_draft_revision_actor` FOREIGN KEY (`actedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_supplier_invoice_draft_revision_shape` CHECK (
    `revisionNo` > 0
    AND `baseVersion` > 0
    AND `resultVersion` = `baseVersion` + 1
    AND CHAR_LENGTH(TRIM(`reason`)) >= 3
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_supplier_invoice_draft_revisions_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_supplier_invoice_draft_revisions_bu`
BEFORE UPDATE ON `supplierInvoiceDraftRevisions`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'supplier invoice draft revisions are append-only';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_supplier_invoice_draft_revisions_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_supplier_invoice_draft_revisions_bd`
BEFORE DELETE ON `supplierInvoiceDraftRevisions`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'supplier invoice draft revisions are append-only';
END;
--> statement-breakpoint

SET @si_draft_revision_contract := (
  SELECT
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'supplierInvoices' AND column_name IN ('draftState','voidedBy','voidedAt','voidReason'))
    + (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'supplierInvoiceDraftRevisions')
    + (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name IN ('trg_supplier_invoice_draft_revisions_bu','trg_supplier_invoice_draft_revisions_bd'))
);
SET @sql := IF(@si_draft_revision_contract = 7, 'SELECT ''supplier invoice draft revision contract verified'' AS msg', 'SELECT 1 FROM `__incomplete_supplier_invoice_draft_revision_contract__`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
