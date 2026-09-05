-- 0310 — طلبات اعتماد تشغيلات العمولات بنطاق الشركة أو الفرع.
-- الطلب/الرفض صفر أثر؛ اعتماد المراجع المستقل وحده يغيّر حالة التشغيلة.

-- MySQL 8 لا يدعم ADD COLUMN IF NOT EXISTS؛ نفّذ DDL مشروطاً عبر metadata.
SET @needs_commission_run_version := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'commissionRuns' AND column_name = 'version'
);
SET @sql := IF(
  @needs_commission_run_version,
  'ALTER TABLE `commissionRuns` ADD COLUMN `version` INT NOT NULL DEFAULT 1 AFTER `commissionRunStatus`',
  'SELECT ''commissionRuns.version exists'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `commissionRunApprovalRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `runId` BIGINT NOT NULL,
  `scopeBranchId` BIGINT NULL,
  `status` ENUM('PENDING','APPROVED','REJECTED','STALE') NOT NULL DEFAULT 'PENDING',
  `baseRunVersion` INT NOT NULL,
  `payload` JSON NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `requestedBy` INT NOT NULL,
  `reviewedBy` INT NULL,
  `reviewedAt` TIMESTAMP NULL,
  `reviewNote` VARCHAR(500) NULL,
  `decisionKey` VARCHAR(120) NULL,
  `decisionHash` CHAR(64) NULL,
  `appliedAt` TIMESTAMP NULL,
  `pendingGuard` VARCHAR(160) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_commission_run_approval_request_key` (`requestKey`),
  UNIQUE KEY `uq_commission_run_approval_pending` (`pendingGuard`),
  UNIQUE KEY `uq_commission_run_approval_decision` (`decisionKey`),
  KEY `idx_commission_run_approval_run_status` (`runId`,`status`),
  KEY `idx_commission_run_approval_scope_status` (`scopeBranchId`,`status`),
  KEY `idx_commission_run_approval_requester` (`requestedBy`),
  KEY `idx_commission_run_approval_reviewer` (`reviewedBy`),
  CONSTRAINT `fk_commission_run_approval_run` FOREIGN KEY (`runId`) REFERENCES `commissionRuns` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_commission_run_approval_scope_branch` FOREIGN KEY (`scopeBranchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_commission_run_approval_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_commission_run_approval_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_commission_run_approval_decision` CHECK (
    (`status` = 'PENDING' AND `pendingGuard` IS NOT NULL AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `decisionKey` IS NULL AND `decisionHash` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_commission_run_approval_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_commission_runs_version_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_commission_runs_version_bu`
BEFORE UPDATE ON `commissionRuns`
FOR EACH ROW
BEGIN
  SET NEW.`version` = OLD.`version` + 1;
END;
