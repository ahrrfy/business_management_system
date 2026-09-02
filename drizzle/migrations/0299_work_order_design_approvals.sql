-- 0299 — نسخ تصميم أوامر الشغل واعتماد العميل الموثق بفصل واجبات.

CREATE TABLE IF NOT EXISTS `workOrderDesignRevisions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `workOrderId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `revision` INT NOT NULL,
  `customizationSnapshot` TEXT NULL,
  `contentHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `createdBy` INT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wo_design_revision` (`workOrderId`, `revision`),
  KEY `idx_wo_design_revision_branch_time` (`branchId`, `createdAt`),
  KEY `idx_wo_design_revision_creator` (`createdBy`),
  CONSTRAINT `fk_wo_design_revision_work` FOREIGN KEY (`workOrderId`) REFERENCES `workOrders` (`id`),
  CONSTRAINT `fk_wo_design_revision_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_wo_design_revision_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `workOrderDesignApprovals` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `workOrderId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `revisionId` BIGINT NOT NULL,
  `taskId` BIGINT NULL,
  `status` ENUM('PENDING','APPROVED','REJECTED','SUPERSEDED') NOT NULL DEFAULT 'PENDING',
  `requestedBy` INT NOT NULL,
  `requestNote` VARCHAR(500) NULL,
  `decisionKey` VARCHAR(120) NULL,
  `decisionHash` CHAR(64) NULL,
  `decisionReason` VARCHAR(500) NULL,
  `evidenceType` ENUM('WHATSAPP_MESSAGE','CUSTOMER_SIGNATURE','EMAIL','ATTACHMENT','OTHER') NULL,
  `evidenceReference` VARCHAR(500) NULL,
  `reviewedBy` INT NULL,
  `reviewedAt` TIMESTAMP NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `workOrderDesignApprovals_requestKey_unique` (`requestKey`),
  UNIQUE KEY `workOrderDesignApprovals_decisionKey_unique` (`decisionKey`),
  UNIQUE KEY `uq_wo_design_approval_revision` (`revisionId`),
  KEY `idx_wo_design_approval_work_status` (`workOrderId`, `status`),
  KEY `idx_wo_design_approval_branch_status` (`branchId`, `status`),
  KEY `idx_wo_design_approval_task` (`taskId`),
  KEY `idx_wo_design_approval_requester` (`requestedBy`),
  KEY `idx_wo_design_approval_reviewer` (`reviewedBy`),
  CONSTRAINT `fk_wo_design_approval_work` FOREIGN KEY (`workOrderId`) REFERENCES `workOrders` (`id`),
  CONSTRAINT `fk_wo_design_approval_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_wo_design_approval_revision` FOREIGN KEY (`revisionId`) REFERENCES `workOrderDesignRevisions` (`id`),
  CONSTRAINT `fk_wo_design_approval_task` FOREIGN KEY (`taskId`) REFERENCES `tasks` (`id`),
  CONSTRAINT `fk_wo_design_approval_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_wo_design_approval_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_wo_design_approval_decision` CHECK (
    (`status` = 'PENDING' AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `decisionKey` IS NULL AND `decisionHash` IS NULL)
    OR (`status` IN ('APPROVED','REJECTED') AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `decisionReason` IS NOT NULL AND `evidenceType` IS NOT NULL AND `evidenceReference` IS NOT NULL)
    OR (`status` = 'SUPERSEDED' AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL)
  ),
  CONSTRAINT `chk_wo_design_approval_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
